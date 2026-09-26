/**
 * Sub-workflow dispatch: running another governed machine to completion from
 * inside a session, as its own child session (see `sessions/scope.ts`).
 *
 * Two invariants carry the feature's safety. **Every failure is closed**: a
 * rejected child, an exhausted budget, a refused depth or cycle, an unloadable
 * target, an unresolvable param, and a child that parks with nothing to resume
 * it all raise {@link SubWorkflowError}; nothing returns a half-finished sub-run.
 * **Nothing crosses implicitly**: down, only the arguments the call passed; up,
 * only the closing message, the declared returns, and what the child wrote to
 * the run zone.
 */

import { Command, GraphInterrupt, isGraphInterrupt } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { humanNote, lastAgentText } from "../core/messages.js";
import {
  createWorkflowEventEmitter,
  withEventContext,
  type WorkflowEventHandler,
} from "../core/events.js";
import { DEFAULT_RECURSION_LIMIT } from "../core/deepagents.js";
import {
  parseReferences,
  resolvePath,
  resolveText,
  type VariableReference,
  type VariableStore,
} from "../machine/variables.js";
import { signatureValueIssues, type SignatureEntry, type SignatureValueIssue } from "../machine/signature.js";
import { MANUAL_TRIGGER } from "../machine/triggers.js";
import { workflowToolName } from "../machine/tool-names.js";
import { DEFAULT_SUB_WORKFLOW_CONCURRENCY, DEFAULT_SUB_WORKFLOW_DEPTH } from "../machine/delegation.js";
import { findMock, readMocks } from "../core/tool-mocks.js";
import type { GovernanceRule } from "../kernel/kernel.js";
import type { WorkflowMachine } from "../machine/machine.js";
import { readReturns, readVariables, readWorkflowState, WORKFLOW_STATUSES } from "./state.js";
import { returnsRejection } from "./signature-checks.js";
import {
  childRunConfig,
  releaseScopes,
  sessionScopeFrom,
  SEED_VARIABLES_KEY,
  subRunIdentity,
} from "../sessions/scope.js";

// --- Dispatch -------------------------------------------------------------------

// The default bounds are pure vocabulary (`machine/delegation.ts`); re-exported
// so the dispatcher and what it enforces by default are reached from one module.
export { DEFAULT_SUB_WORKFLOW_CONCURRENCY, DEFAULT_SUB_WORKFLOW_DEPTH };

/** Why a sub-run did not produce a result. Each is a fail-closed outcome. */
export type SubWorkflowFailureKind =
  | "unresolved-param"
  | "missing-param"
  | "invalid-param"
  | "missing-return"
  | "invalid-return"
  | "depth-exceeded"
  | "cycle"
  | "unknown-workflow"
  | "not-delegatable"
  | "disabled"
  | "parked"
  | "rejected"
  | "budget"
  | "error";

/**
 * The kinds where nothing ran: a refusal is a governed "no" the caller may
 * correct and retry within the turn (a blocked call); a failure means a child
 * ran and did not finish (a tool error).
 */
export const SUB_WORKFLOW_REFUSAL_KINDS: ReadonlySet<SubWorkflowFailureKind> = new Set([
  "depth-exceeded",
  "cycle",
  "missing-param",
  "invalid-param",
  "unknown-workflow",
  "not-delegatable",
  "disabled",
  "unresolved-param",
] as const);

export function isSubWorkflowRefusal(err: unknown): err is SubWorkflowError {
  return err instanceof SubWorkflowError && SUB_WORKFLOW_REFUSAL_KINDS.has(err.kind);
}

/** A sub-run that did not complete, with its kind and the slug of the machine that failed. */
export class SubWorkflowError extends Error {
  constructor(
    readonly kind: SubWorkflowFailureKind,
    readonly workflow: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SubWorkflowError";
  }
}

/**
 * What a parked sub-run leaves on its `GraphInterrupt` so the caller can park
 * with it and hand the decision back on resume. Attached rather than replacing
 * the interrupt, which still has to reach whatever suspends on it.
 */
export const SUB_WORKFLOW_PARK = Symbol.for("archmax.subWorkflowPark");

export interface SubWorkflowPark {
  workflow: string;
  /** The sub-run's identity — what its session id derives from. */
  identity: string;
  dispatchId: string;
  /** The child's own pending decision. */
  decision: unknown;
}

function markPark(err: GraphInterrupt, of: Omit<SubWorkflowPark, "decision">): void {
  Object.defineProperty(err, SUB_WORKFLOW_PARK, {
    value: { ...of, decision: err.interrupts[0]?.value } satisfies SubWorkflowPark,
    enumerable: false,
    configurable: true,
  });
}

/** The park a sub-run left on its suspension, if this error carries one. */
export function subWorkflowParkOf(err: unknown): SubWorkflowPark | undefined {
  const park = (err as Record<symbol, unknown> | null)?.[SUB_WORKFLOW_PARK];
  return park as SubWorkflowPark | undefined;
}

/** A composed child runtime: the invocable graph of its governed agent and the machine governing it. */
export interface SubWorkflowRuntime {
  graph: { invoke(input: unknown, config: RunnableConfig): Promise<Record<string, unknown>> };
  machine: WorkflowMachine;
}

/**
 * Who is dispatching: what a child's composition depends on beyond its own
 * slug. Denials accumulate down the chain, so the same target composed under
 * two different callers is two compositions.
 */
export interface DelegationCaller {
  /** Workflow slugs from the outermost session's first delegation down to the caller (empty at the root). */
  chain: readonly string[];
  /**
   * The denials the child inherits: every ancestor's `policy` — the root's and
   * each intermediate caller's — compiled ahead of the child's own rules.
   */
  inheritedPolicyRules: GovernanceRule[];
}

/**
 * A target's call signature, as delegation reads it: its `manual` trigger's
 * typed lists, plus the prose a tool description is built from. `title` and
 * `description` are prose; the lists are enforced.
 */
export interface DelegationSignature {
  requires?: SignatureEntry[];
  returns?: SignatureEntry[];
  title?: string;
  /** The `manual` trigger's `description`: what calling the target does, for its caller. */
  description?: string;
  /** Whether the target declares itself out of service; the dispatch refuses on it. */
  disabled?: boolean;
}

/** Lazily composes and memoizes a child runtime per workflow slug and delegation chain. */
export interface SubWorkflowRegistry {
  resolve(workflow: string, caller?: DelegationCaller): Promise<SubWorkflowRuntime>;
  /** The target's declared signature, for the price of a spec read. */
  signature(workflow: string): Promise<DelegationSignature>;
}

export interface DispatchSubWorkflowInput {
  workflow: string;
  /** Inputs for this dispatch, seeded into the sub-run as locked variables. Strings resolve `${{…}}` against `variables`. */
  params?: Record<string, unknown>;
  /** The dispatching run's variables. */
  variables: VariableStore;
  /** The parent's run config — the session, scope, and dispatch chain come from it. */
  config: RunnableConfig;
  /** The calling state's slug. */
  state: string;
  /** The tool call this dispatch answers. */
  toolCallId?: string;
  signal?: AbortSignal;
}

export interface SubWorkflowResult {
  /** The child's closing message. */
  result: string;
  workflow: string;
  /** The state the child finished in. */
  state: string;
  /** The variables the child's `manual` trigger declared in `returns`; absent when it declares none. */
  returns?: Record<string, unknown>;
}

/**
 * The line a sub-run opens with. A chat request needs a message, and this is the
 * child's whole transcript at that moment, so it stays human-role, marked as an
 * `opening` runtime note.
 */
export const SUB_RUN_OPENING =
  "Begin. Your instructions and your inputs are already in context; read any input you " +
  "need with archmax_get_variables.";

export const NO_RESULT_MESSAGE = "(the sub-workflow completed without a closing message)";

export interface SubWorkflowDispatcherOptions {
  registry: SubWorkflowRegistry;
  machine: WorkflowMachine;
  /**
   * The denials a child of this composition inherits: what this composition
   * itself inherited plus its own `policy`, so a grandchild is bound by the root
   * and by every caller between. Absent, the registry falls back to the root's.
   */
  childPolicyRules?: GovernanceRule[];
  /** `maxDepth` bounds nesting, `maxConcurrent` bounds one session's in-flight sub-runs. */
  bounds?: { maxDepth?: number; maxConcurrent?: number };
  onEvent?: WorkflowEventHandler;
}

export interface SubWorkflowDispatcher {
  dispatch(input: DispatchSubWorkflowInput): Promise<SubWorkflowResult>;
  /** Why this dispatch would be refused (reported as a refused dispatch pair), or `undefined`. */
  refusal(input: DispatchSubWorkflowInput): Promise<SubWorkflowError | undefined>;
  /** Continue a sub-run that stopped for a person, addressed by identity. */
  resume(input: ResumeSubWorkflowInput): Promise<SubWorkflowResult>;
  signature(workflow: string): Promise<DelegationSignature>;
  /**
   * Take the sub-runs completed in this session since the last drain. A ledger,
   * because a script's dispatch reaches the PTC gateway, which cannot write graph state.
   */
  drainDispatches(sessionId: string): SubWorkflowDispatchRecord[];
  /** Release a session's ledger, and every sub-run scope beneath it. */
  release(sessionId: string): void;
}

export interface SubWorkflowDispatchRecord {
  workflow: string;
  status: "ok" | "error";
  reason?: string;
}

export interface ResumeSubWorkflowInput {
  workflow: string;
  identity: string;
  dispatchId: string;
  config: RunnableConfig;
  /** What the person decided, handed to the child's suspended `interrupt()`. */
  resume: unknown;
  /** The calling state, for events. */
  state: string;
}

/** A counting semaphore: excess dispatches queue rather than fail. */
function createSemaphore(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

let dispatchSeq = 0;

export function createSubWorkflowDispatcher(
  opts: SubWorkflowDispatcherOptions,
): SubWorkflowDispatcher {
  const emit = createWorkflowEventEmitter(opts.onEvent);
  const maxDepth = opts.bounds?.maxDepth ?? DEFAULT_SUB_WORKFLOW_DEPTH;
  const maxConcurrent = opts.bounds?.maxConcurrent ?? DEFAULT_SUB_WORKFLOW_CONCURRENCY;
  const withSlot = createSemaphore(maxConcurrent);
  let ordinal = 0;

  /** Sub-runs completed per session, awaiting a drain into the trail. */
  const dispatched = new Map<string, SubWorkflowDispatchRecord[]>();
  const record = (config: RunnableConfig, entry: SubWorkflowDispatchRecord) => {
    const key = sessionScopeFrom(config).sessionId;
    const ledger = dispatched.get(key);
    if (ledger) ledger.push(entry);
    else dispatched.set(key, [entry]);
  };

  const failed = (workflow: string, finishedIn: string, rejected: string) =>
    new SubWorkflowError(
      "rejected",
      workflow,
      `Sub-workflow '${workflow}' was rejected in state '${finishedIn}': ${rejected}`,
    );

  /** Everything that can refuse a dispatch, before anything is composed. Shared by `dispatch` and `refusal`. */
  async function check(input: DispatchSubWorkflowInput): Promise<{
    params: Record<string, unknown>;
    signature: DelegationSignature;
    mock?: { result?: unknown };
  }> {
    const { workflow } = input;
    const scope = sessionScopeFrom(input.config);
    const depth = scope.depth + 1;
    const chain = [...scope.chain, workflow].join(" → ");

    if (depth > maxDepth) {
      throw new SubWorkflowError(
        "depth-exceeded",
        workflow,
        `Refusing to run sub-workflow '${workflow}': it would be ${depth} delegations deep, ` +
          `past the dispatcher's limit of ${maxDepth}. Chain so far: ${chain}.`,
      );
    }
    if (scope.chain.includes(workflow)) {
      throw new SubWorkflowError(
        "cycle",
        workflow,
        `Refusing to run sub-workflow '${workflow}': it is already running in this chain ` +
          `(${chain}), so the run would not terminate.`,
      );
    }

    const params = resolveParams(input.params, input.variables, workflow);

    // A declared mock stands in for the whole sub-run and is served here, so a
    // mocked dispatch is indistinguishable from a real one except that no child runs.
    const mock = findMock(readMocks(input.config.configurable), workflowToolName(workflow), params);
    const signature = await opts.registry.signature(workflow).catch((err: unknown) => {
      if (mock) return {} as DelegationSignature;
      throw err;
    });

    if (signature.disabled) {
      throw new SubWorkflowError(
        "disabled",
        workflow,
        `Refusing to run sub-workflow '${workflow}': it is disabled ` +
          `('disabled: true' in its workflow.yaml), so it starts no run. Remove that ` +
          `flag to re-enable it.`,
      );
    }

    const requires = signature.requires ?? [];
    const missing = requires.map((entry) => entry.name).filter((name) => !Object.hasOwn(params, name));
    if (missing.length > 0) {
      throw new SubWorkflowError(
        "missing-param",
        workflow,
        `Refusing to run sub-workflow '${workflow}': it requires ` +
          `${missing.map((n) => `'${n}'`).join(", ")}, which this call does not supply. ` +
          `Call it again with ${missing.length === 1 ? "that argument" : "those arguments"}.`,
      );
    }
    const invalid = invalidOf(signatureValueIssues(requires, params));
    if (invalid.length > 0) {
      throw new SubWorkflowError(
        "invalid-param",
        workflow,
        `Refusing to run sub-workflow '${workflow}': ${invalid.map((issue) => issue.message).join("; ")}. ` +
          `Call it again with ${invalid.length === 1 ? "a value" : "values"} of the declared type.`,
      );
    }
    return { params, signature, ...(mock ? { mock } : {}) };
  }

  async function refusal(input: DispatchSubWorkflowInput): Promise<SubWorkflowError | undefined> {
    try {
      await check(input);
      return undefined;
    } catch (err) {
      if (!isSubWorkflowRefusal(err)) return undefined;
      reportRefusal(input, err);
      return err;
    }
  }

  /** Bracket a dispatch that never ran, so an attempted delegation that was stopped is visible. */
  function reportRefusal(input: DispatchSubWorkflowInput, err: SubWorkflowError): void {
    const scope = sessionScopeFrom(input.config);
    const dispatchId = `subwf-${++dispatchSeq}`;
    const common = {
      state: input.state,
      workflow: input.workflow,
      dispatchId,
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    };
    emit({
      type: "sub-workflow-start",
      ...common,
      depth: scope.depth + 1,
      ...(scope.chain.length ? { chain: [...scope.chain] } : {}),
    });
    emit({ type: "sub-workflow-result", ...common, status: "error", durationMs: 0, reason: err.message });
  }

  async function dispatch(input: DispatchSubWorkflowInput): Promise<SubWorkflowResult> {
    const { workflow, state } = input;
    const scope = sessionScopeFrom(input.config);
    const dispatchId = `subwf-${++dispatchSeq}`;
    const identity = subRunIdentity(state, workflow, ordinal++);

    emit({
      type: "sub-workflow-start",
      state,
      workflow,
      dispatchId,
      depth: scope.depth + 1,
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(scope.chain.length ? { chain: [...scope.chain] } : {}),
    });
    const startedAt = Date.now();
    // Return names only: this stream is a diagnostic channel, not a data one.
    const settle = (
      status: "ok" | "error" | "parked",
      reason?: string,
      returns?: Record<string, unknown>,
    ) =>
      emit({
        type: "sub-workflow-result",
        state,
        workflow,
        dispatchId,
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        status,
        durationMs: Date.now() - startedAt,
        ...(reason ? { reason } : {}),
        ...(returns ? { returns: Object.keys(returns) } : {}),
      });

    try {
      const { params, signature, mock } = await check(input);
      if (mock) {
        const mocked = applyMock(mock, workflow, signature.returns);
        settle("ok", undefined, mocked.returns);
        record(input.config, { workflow, status: "ok" });
        return mocked;
      }
      const result = await withSlot(() =>
        run({ ...input, dispatchId, identity, params, returns: signature.returns ?? [] }),
      );
      settle("ok", undefined, result.returns);
      record(input.config, { workflow, status: "ok" });
      return result;
    } catch (err) {
      // A child parking surfaces as a `GraphInterrupt`: not a failure, marked so
      // the caller can park with the child, and rethrown untouched.
      if (isGraphInterrupt(err)) {
        settle("parked");
        markPark(err, { workflow, identity, dispatchId });
        throw err;
      }
      const failure =
        err instanceof SubWorkflowError
          ? err
          : new SubWorkflowError(
              (err as Error)?.name === "AbortError" ? "budget" : "error",
              workflow,
              `Sub-workflow '${workflow}' failed: ${(err as Error)?.message ?? String(err)}`,
              { cause: err },
            );
      settle("error", failure.message);
      record(input.config, { workflow, status: "error", reason: failure.message });
      throw failure;
    }
  }

  /** The config a child is invoked with: its own session, the dispatch chain, and a whole-turn bound. */
  /** This composition as the caller of a dispatch made under `config`. */
  function caller(config: RunnableConfig): DelegationCaller | undefined {
    if (!opts.childPolicyRules) return undefined;
    return { chain: sessionScopeFrom(config).chain, inheritedPolicyRules: opts.childPolicyRules };
  }

  function childConfig(
    parent: RunnableConfig,
    child: { identity: string; workflow: string; dispatchId: string },
  ): RunnableConfig {
    return { recursionLimit: DEFAULT_RECURSION_LIMIT, ...childRunConfig(parent, child) };
  }

  async function run(
    input: DispatchSubWorkflowInput & {
      dispatchId: string;
      identity: string;
      params: Record<string, unknown>;
      returns: SignatureEntry[];
    },
  ): Promise<SubWorkflowResult> {
    const { workflow } = input;
    const child = await opts.registry.resolve(workflow, caller(input.config));
    const config = childConfig(input.config, {
      identity: input.identity,
      workflow,
      dispatchId: input.dispatchId,
    });
    // Exactly what the caller declared: the child seeds them as its host would, locked.
    const configurable = { ...(config.configurable ?? {}), [SEED_VARIABLES_KEY]: { ...input.params } };

    // Everything the child emits is tagged with this dispatch.
    const state = await withEventContext({ subWorkflowDispatchId: input.dispatchId }, () =>
      child.graph.invoke(
        { messages: [humanNote("opening", SUB_RUN_OPENING)] },
        { ...config, configurable, ...(input.signal ? { signal: input.signal } : {}) },
      ),
    );

    const fields = readWorkflowState(state);
    const finishedIn = fields.workflowState ?? child.machine.entry;
    // A park normally leaves through the `GraphInterrupt` above; settling in an
    // awaiting status means nothing would ever resume the child, so it fails closed.
    if (
      fields.status === WORKFLOW_STATUSES.awaitingInput ||
      fields.status === WORKFLOW_STATUSES.awaitingDecision
    ) {
      throw new SubWorkflowError(
        "parked",
        workflow,
        `Sub-workflow '${workflow}' settled in state '${finishedIn}' with status ` +
          `'${fields.status}' but no pending suspension, so nothing could resume it.`,
      );
    }
    const returns = settledReturns(workflow, child.machine, state, finishedIn, input.returns);
    return { result: closingMessage(state), workflow, state: finishedIn, ...(returns ? { returns } : {}) };
  }

  /**
   * The declared returns of a child that settled, held to the target's typed
   * signature: `missing-return` for an unset name, `invalid-return` for a value
   * that does not conform. A child its own completion check rejected is
   * reported by the same kinds, since that is the reason it was rejected; any
   * other rejection stays `rejected`.
   */
  function settledReturns(
    workflow: string,
    machine: WorkflowMachine,
    state: Record<string, unknown>,
    finishedIn: string,
    declared: SignatureEntry[],
  ): Record<string, unknown> | undefined {
    const fields = readWorkflowState(state);
    const store = readVariables(state);
    const trigger = fields.trigger?.id ?? MANUAL_TRIGGER;
    if (fields.rejected && fields.rejected !== returnsRejection(machine, trigger, finishedIn, store)) {
      throw failed(workflow, finishedIn, fields.rejected);
    }
    const returns = readReturns(state, declared.map((entry) => entry.name));
    const issues = signatureValueIssues(declared, returns ?? {});
    if (issues.length > 0) throw returnsFailure(workflow, `in state '${finishedIn}'`, issues);
    // A rejection whose returns check passes against the target's own
    // signature still failed closed; it is only named for what it was.
    if (fields.rejected) throw failed(workflow, finishedIn, fields.rejected);
    return returns;
  }

  /** Continue a child that stopped for a person: the same invoke, entered with a `Command({ resume })`. */
  async function resume(input: ResumeSubWorkflowInput): Promise<SubWorkflowResult> {
    const { workflow, state: callingState } = input;
    const startedAt = Date.now();
    const child = await opts.registry.resolve(workflow, caller(input.config));
    const config = childConfig(input.config, {
      identity: input.identity,
      workflow,
      dispatchId: input.dispatchId,
    });
    const settle = (outcome: { status: "ok"; returns?: Record<string, unknown> } | { status: "error"; reason: string }) =>
      emit({
        type: "sub-workflow-result",
        state: callingState,
        workflow,
        dispatchId: input.dispatchId,
        status: outcome.status,
        durationMs: Date.now() - startedAt,
        ...(outcome.status === "error" ? { reason: outcome.reason } : {}),
        ...(outcome.status === "ok" && outcome.returns ? { returns: Object.keys(outcome.returns) } : {}),
      });

    try {
      const state = await withEventContext({ subWorkflowDispatchId: input.dispatchId }, () =>
        child.graph.invoke(new Command({ resume: input.resume }), config),
      );
      const fields = readWorkflowState(state);
      const finishedIn = fields.workflowState ?? child.machine.entry;
      const declared = (await opts.registry.signature(workflow)).returns ?? [];
      const returns = settledReturns(workflow, child.machine, state, finishedIn, declared);
      settle({ status: "ok", returns });
      return { result: closingMessage(state), workflow, state: finishedIn, ...(returns ? { returns } : {}) };
    } catch (err) {
      if (isGraphInterrupt(err)) {
        markPark(err, { workflow, identity: input.identity, dispatchId: input.dispatchId });
        throw err;
      }
      const failure =
        err instanceof SubWorkflowError
          ? err
          : new SubWorkflowError(
              "error",
              workflow,
              `Sub-workflow '${workflow}' failed after resuming: ` +
                `${(err as Error)?.message ?? String(err)}`,
              { cause: err },
            );
      settle({ status: "error", reason: failure.message });
      throw failure;
    }
  }

  return {
    dispatch,
    refusal,
    resume,
    signature: (w) => opts.registry.signature(w),
    drainDispatches(sessionId) {
      const ledger = dispatched.get(sessionId) ?? [];
      dispatched.delete(sessionId);
      return ledger;
    },
    release(sessionId) {
      releaseScopes(dispatched, sessionId);
      dispatched.delete(sessionId);
    },
  };
}

/** Turn a matched mock into the dispatch's result, held to the target's declared contract like a real sub-run. */
function applyMock(
  mock: { result?: unknown },
  workflow: string,
  returns?: SignatureEntry[],
): SubWorkflowResult {
  const declared = mock.result;
  if (declared != null && typeof declared === "object" && "error" in declared) {
    throw new SubWorkflowError(
      "rejected",
      workflow,
      `Sub-workflow '${workflow}' failed (mocked): ${String((declared as { error: unknown }).error)}`,
    );
  }
  const asObject =
    declared != null && typeof declared === "object" ? (declared as Record<string, unknown>) : undefined;
  const result =
    typeof asObject?.message === "string"
      ? asObject.message
      : typeof declared === "string"
        ? declared
        : JSON.stringify(declared ?? null);
  const state = typeof asObject?.state === "string" ? asObject.state : "(mocked)";

  const wanted = returns ?? [];
  if (wanted.length === 0) return { result, workflow, state };

  const supplied = (asObject?.returns ?? {}) as Record<string, unknown>;
  const issues = signatureValueIssues(wanted, supplied);
  const unset = issues.filter((issue) => issue.kind === "missing").map((issue) => issue.name);
  if (unset.length > 0) {
    throw new SubWorkflowError(
      "missing-return",
      workflow,
      `Mocked sub-workflow '${workflow}' supplies no ${unset.map((n) => `'${n}'`).join(", ")}, ` +
        `which it declares in its '${MANUAL_TRIGGER}' trigger's 'returns'. Add ` +
        `${unset.length === 1 ? "it" : "them"} under the mock's 'returns' — a mock stands in ` +
        `for the sub-run, not for its contract.`,
    );
  }
  if (issues.length > 0) throw returnsFailure(workflow, "(mocked)", issues);
  return {
    result,
    workflow,
    state,
    returns: Object.fromEntries(wanted.map((entry) => [entry.name, supplied[entry.name]])),
  };
}

/** The invalid-value issues of a signature check, in declaration order. */
function invalidOf(issues: SignatureValueIssue[]): Extract<SignatureValueIssue, { kind: "invalid" }>[] {
  return issues.filter((issue): issue is Extract<SignatureValueIssue, { kind: "invalid" }> => issue.kind === "invalid");
}

/**
 * A child whose declared returns are not what its signature promises: unset
 * names fail `missing-return`, and otherwise mistyped values `invalid-return`.
 * Either way no partial result reaches the caller.
 */
function returnsFailure(workflow: string, where: string, issues: SignatureValueIssue[]): SubWorkflowError {
  const unset = issues.filter((issue) => issue.kind === "missing").map((issue) => `'${issue.name}'`);
  if (unset.length > 0) {
    return new SubWorkflowError(
      "missing-return",
      workflow,
      `Sub-workflow '${workflow}' settled ${where} without setting ${unset.join(", ")}, which its ` +
        `'${MANUAL_TRIGGER}' trigger declares in its 'returns'.`,
    );
  }
  return new SubWorkflowError(
    "invalid-return",
    workflow,
    `Sub-workflow '${workflow}' settled ${where} with returns its '${MANUAL_TRIGGER}' trigger ` +
      `types otherwise: ${invalidOf(issues).map((issue) => issue.message).join("; ")}.`,
  );
}

/**
 * Resolve a dispatch's params against the dispatching run's variables: strings
 * are substituted, everything else passes through. A string that is exactly one
 * reference takes the referenced value itself, so a number stays a number; a
 * string mixing text and references is substituted as text. Fails closed on an
 * unresolved reference: a literal `${{…}}` must never become a sub-run's fact.
 */
export function resolveParams(
  params: Record<string, unknown> | undefined,
  variables: VariableStore,
  workflow: string,
): Record<string, unknown> {
  if (!params) return {};
  const resolved: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(params)) {
    if (typeof value !== "string") {
      resolved[name] = value;
      continue;
    }
    const substituted = resolveText(value, variables);
    const whole = wholeReference(value);
    if (substituted.ok && whole) {
      // Resolution already proved the reference set and scalar; seed the value, not its rendering.
      resolved[name] = resolvePath(variables[whole.name]!.value, whole.path);
      continue;
    }
    if (!substituted.ok) {
      throw new SubWorkflowError(
        "unresolved-param",
        workflow,
        `Cannot run sub-workflow '${workflow}': its param '${name}' references ` +
          `${substituted.detail}.`,
      );
    }
    resolved[name] = substituted.pattern;
  }
  return resolved;
}

/** The one reference an argument consists of, when it is exactly one reference and nothing else. */
function wholeReference(value: string): VariableReference | undefined {
  const refs = parseReferences(value);
  return refs.length === 1 && refs[0]!.index === 0 && refs[0]!.raw === value ? refs[0] : undefined;
}

/** The child's closing message: its last assistant text, or an explicit note when it said nothing. */
export function closingMessage(state: unknown): string {
  return lastAgentText((state as { messages?: unknown[] })?.messages ?? []) || NO_RESULT_MESSAGE;
}
