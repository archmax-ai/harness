import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredTool } from "@langchain/core/tools";
import { runContextFromMessages } from "../core/messages.js";
import { createSubagentBridgeDispatch } from "../sandbox/bridge.js";
import {
  PROCESS_SESSION,
  type ScriptExecutor,
  type ScriptOutcome,
} from "../sandbox/executor.js";
import { resolvePtcTools } from "../sandbox/tools.js";
import { afterHookLabel, hookKind, hookMaxIterations, iterationKey } from "./hook-shape.js";
import { hookTranscript } from "./transcript.js";
import type { WorkflowMachine } from "../machine/machine.js";
import type { Hook } from "../machine/types.js";
import {
  buildRubricTaskDescription,
  isRubricVerdict,
  resolveRubricResponseFormat,
  rubricId,
  type Rubric,
} from "../rubrics/rubrics.js";
import type { VariableStore } from "../machine/variables.js";
import {
  createWorkflowEventEmitter,
  type WorkflowEventEmitter,
  type WorkflowEventHandler,
} from "../core/events.js";
import { decide, reduceHookFact } from "../kernel/kernel.js";

export type LifecycleVerdict = "ok" | "correct" | "veto";

/** What a hook said, once its return value has been read. */
export interface LifecycleDecision {
  verdict: LifecycleVerdict;
  reason: string;
  rubric?: string;
}

/**
 * Interpret a lifecycle hook's return value into a decision, an error, or
 * `null` (no opinion — proceed).
 *
 * **One contract for every hook kind**, the one `HookResult` declares: a verdict
 * object decides, a bare `false` vetoes, returning nothing is `ok`, and any
 * *other* object fails closed with its keys named. A hook's return value is its
 * verdict and nothing else, so an object that is not one is a verdict its author
 * got wrong; reading it as `ok` would silently permit what the hook meant to
 * block, with nothing said.
 *
 * A **script** hook's value arrives already reduced — the sandbox wrapper
 * applies the same rules and throws on the last one — so what reaches here from
 * a script is a verdict or an error outcome. The rules are restated because a
 * custom `hookExecutors` kind hands its value through raw, and a consumer's
 * executor is held to the same contract as a script: one governance vocabulary,
 * whoever implements the kind.
 */
export function parseLifecycleDecision(
  outcome: ScriptOutcome,
): LifecycleDecision | { error: string } | null {
  if (!outcome.ok) return { error: outcome.error?.message ?? "script error" };

  const value = outcome.value;
  if (isRubricVerdict(value)) {
    return {
      verdict: value.verdict,
      reason: value.reason,
      ...(value.rubric !== undefined ? { rubric: value.rubric } : {}),
    };
  }
  if (value === false) return { verdict: "veto", reason: "precondition not met" };
  if (value !== null && typeof value === "object") {
    return {
      error:
        `hook returned ${describeNonVerdict(value)}, which is not a verdict — return ` +
        `{ verdict: "ok" | "correct" | "veto", reason }, false, or nothing at all`,
    };
  }

  return null;
}

/**
 * Name a non-verdict object by its keys, never its values, so a diagnostic
 * cannot leak what the hook was inspecting. Mirrors `__hookShape` in the
 * sandbox prelude, which does the same for a script hook.
 */
function describeNonVerdict(value: object): string {
  if (Array.isArray(value)) return "an array";
  const keys = Object.keys(value);
  if (keys.length === 0) return "an object with no keys";
  const shown = keys
    .slice(0, 6)
    .map((key) => `'${key}'`)
    .join(", ");
  return `an object with ${keys.length > 6 ? "keys including " : "keys "}${shown}`;
}

export interface LifecycleContext {
  sessionId: string;
  tools: StructuredTool[];
  messages: unknown[];
  taskTool?: StructuredTool;
  config: RunnableConfig;
  /**
   * Grade-and-retry iterations already spent, keyed per hook by
   * {@link iterationKey} — not per state. Two `after` hooks on one state have
   * independent budgets, and a hook that passes cannot clear the count of the
   * one still asking for corrections (issue #62).
   */
  iterations: Record<string, number>;
  /**
   * The trigger that started the run (`id` + optional `args`), read from
   * checkpointed state. Merged into every hook's script arguments so a
   * `before`/`after` script can read how the run began.
   */
  trigger?: { id: string };
  /**
   * The run's variables at the time the hook runs, as a plain `name → value`
   * map. Read-only by construction: the sandbox gets a serialized copy. A hook
   * that could *write* variables would be editing the governance inputs of the
   * state it judges, which is why the variable tools are excluded from PTC.
   */
  variables?: Record<string, unknown>;
  /**
   * The same variables as the checkpointed **store** — value plus lock state —
   * for the kernel's `requires` gate. Must be the run's real store: omitted, the
   * kernel sees an empty store and refuses to leave any state that declares
   * `requires`.
   */
  variableStore?: VariableStore;
}

/**
 * A phase rejection: why the hook phase blocked, and whether the failure is
 * **terminal** — a hook execution error or an exhausted correction budget,
 * which retrying in place cannot fix (the turn ends rejected, subject to
 * `on_error` routing) — as opposed to a recoverable rejection (a deliberate
 * veto or a correction with attempts remaining), where the agent stays in the
 * state to try again.
 */
export interface PhaseRejection {
  reason: string;
  terminal: boolean;
}

/**
 * The result of {@link LifecycleRunner.attemptTransition}: whether the
 * transition passed its hooks, and the resulting judge-correction counts for
 * the caller to commit to the checkpoint. Correction counts advance even on a
 * rejection (a consumed judge correction), so they are returned in both cases.
 * `terminal` marks a rejection retrying cannot fix (see {@link PhaseRejection}).
 */
export type TransitionOutcome =
  | { ok: true; from: string; to: string; corrections: Record<string, number> }
  | { ok: false; reason: string; terminal: boolean; corrections: Record<string, number> };

/**
 * Executes one lifecycle hook of a given kind, returning the raw
 * {@link ScriptOutcome} the runner reduces (parse → kernel verdict → events), so
 * every hook kind flows through the same fail-closed path. `script` and
 * `rubric` are built in; consumers register additional kinds via
 * `createAgent`'s `hookExecutors` option. An executor that throws or returns an
 * error outcome vetoes the transition.
 */
export type HookExecutor = (
  hook: Hook,
  ctx: LifecycleContext,
  args: Record<string, unknown>,
) => Promise<ScriptOutcome>;

/**
 * Resolves a hook's declared `script:` value to the authoring-plane path its
 * source lives at, or refuses it with a reason (see `resolveHookScript`).
 */
export type HookScriptResolver = (
  declared: string,
) => { ok: true; path: string } | { ok: false; reason: string };

/** The built-in hook kinds, which consumer executors may not shadow. */
export const BUILTIN_HOOK_KINDS = ["script", "rubric"] as const;

/** Short raw-output excerpt surfaced when a judge response cannot be parsed. */
function snippet(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined || text === "undefined") text = "(no output)";
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * Runs deterministic `before`/`after` hooks (scripts or grading rubrics) at the
 * machine's fixed points, in the same backend-backed interpreter as the model's
 * own sandbox tool calls.
 */
export class LifecycleRunner {
  private readonly emit: WorkflowEventEmitter;
  /** Hook kind → executor. Built-ins (`script`, `rubric`) plus registered custom kinds. */
  private readonly hookExecutors: Map<string, HookExecutor>;

  /**
   * Maps a hook's declared `script:` value to the path its source is read from.
   * Injected so the runner stays ignorant of workspace layout: the harness binds
   * it to the running workflow (workflow-relative, confined to `hooks/`). The
   * identity default keeps a bare runner working.
   */
  private readonly resolveScript: HookScriptResolver;
  /** Deprecations already reported — each is said once per assembly. */

  constructor(
    private readonly machine: WorkflowMachine,
    private readonly executor: ScriptExecutor,
    private readonly rubrics: Map<string, Rubric>,
    private readonly ptcNames: string[],
    hookExecutors?: Record<string, HookExecutor>,
    onEvent?: WorkflowEventHandler,
    opts: { resolveScript?: HookScriptResolver } = {},
  ) {
    this.emit = createWorkflowEventEmitter(onEvent);
    this.resolveScript = opts.resolveScript ?? ((declared) => ({ ok: true, path: declared }));
    // Built-ins first; consumer executors add kinds alongside them (built-ins
    // are non-shadowable, enforced at assembly).
    this.hookExecutors = new Map<string, HookExecutor>([
      ["script", (hook, ctx, args) => this.runScript(String((hook as Record<string, string>).script), ctx, args)],
    ]);
    for (const [kind, exec] of Object.entries(hookExecutors ?? {})) {
      this.hookExecutors.set(kind, exec);
    }
  }

  resolvePtcTools(allTools: unknown[]): StructuredTool[] {
    return resolvePtcTools(allTools, this.ptcNames);
  }

  /**
   * The runtime's own dispatch for an inline grader, through the framework
   * `task` tool. Reached only by {@link runRubric} — never wired into a script's
   * sandbox, which has no name to dispatch by.
   */
  private rubricDispatch(ctx: LifecycleContext, lifecycleArgs: Record<string, unknown>) {
    if (!ctx.taskTool) return undefined;
    const base = createSubagentBridgeDispatch(ctx.taskTool, ctx.config, {
      emit: this.emit,
      ...(typeof lifecycleArgs.state === "string" ? { state: lifecycleArgs.state } : {}),
    });
    return async (input: { description?: string; subagentType: string; responseSchema?: unknown }) => {
      const rubric = this.rubrics.get(input.subagentType);
      const description =
        input.description?.trim() ||
        buildRubricTaskDescription({ ...lifecycleArgs, ...runContextFromMessages(ctx.messages) });
      const responseSchema =
        input.responseSchema ?? (rubric ? resolveRubricResponseFormat(rubric) : undefined);
      return base({
        description,
        subagentType: input.subagentType,
        ...(responseSchema !== undefined
          ? { responseSchema: responseSchema as Record<string, unknown> }
          : {}),
      });
    };
  }

  private async runScript(
    script: string,
    ctx: LifecycleContext,
    args: Record<string, unknown>,
  ): Promise<ScriptOutcome> {
    // A hook that cannot be placed is a hook that cannot be trusted: refusing
    // here produces an error outcome, and an errored hook vetoes fail-closed —
    // the same posture as a hook that throws.
    const resolved = this.resolveScript(script);
    if (!resolved.ok) {
      return {
        ok: false,
        value: undefined,
        logs: [],
        error: { message: resolved.reason },
        formatted: `error: ${resolved.reason}`,
      };
    }
    return this.executor.runFile(resolved.path, {
      sessionId: ctx.sessionId,
      sessionNamespace: PROCESS_SESSION,
      args,
      tools: ctx.tools,
      // No `task()` for a script hook: an inline rubric has no name a script
      // could pass, so there is nothing to dispatch by. A script that wants a
      // model verdict gets a `rubric` hook declared beside it in the same list.
      lifecycle: true,
    });
  }

  private async runRubric(
    name: string,
    ctx: LifecycleContext,
    args: Record<string, unknown>,
  ): Promise<ScriptOutcome> {
    const dispatch = this.rubricDispatch(ctx, args);
    if (!dispatch) {
      const message = `rubric '${name}' could not be dispatched (no task tool)`;
      return { ok: false, value: undefined, logs: [], error: { message }, formatted: `error: ${message}` };
    }
    const rubric = this.rubrics.get(name);
    const responseSchema = rubric ? resolveRubricResponseFormat(rubric) : undefined;
    try {
      const value = await dispatch({
        subagentType: name,
        // The grader's payload keeps the compact `userRequest`/`history` view a
        // rubric's `instructions` are written against.
        description: buildRubricTaskDescription({ ...args, ...runContextFromMessages(ctx.messages) }),
        ...(responseSchema !== undefined ? { responseSchema } : {}),
      });
      // Fail closed on unreadable grader output, exactly like a thrown error: a
      // grader whose verdict cannot be read has approved nothing.
      const verdict =
        value && typeof value === "object" && isRubricVerdict(value)
          ? { ...value, rubric: name }
          : {
              verdict: "veto" as const,
              reason: `rubric '${name}' returned no parseable verdict: ${snippet(value)}`,
              rubric: name,
            };
      return { ok: true, value: verdict, logs: [], formatted: JSON.stringify(verdict) };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      return { ok: false, value: undefined, logs: [], error: { message }, formatted: `error: ${message}` };
    }
  }

  /**
   * Dispatch a single tagged hook through its kind's registered executor.
   * An unknown kind (no registered executor) produces an error outcome that
   * reduces to a fail-closed veto — the same path as any hook execution error.
   */
  private async runHook(
    hook: Hook,
    ctx: LifecycleContext,
    args: Record<string, unknown>,
    at: { state: string; phase: "before" | "after"; index: number },
  ): Promise<ScriptOutcome> {
    const kind = hookKind(hook);
    // `rubric` is serviced here rather than through the executor map, because
    // dispatching an inline grader needs the hook's *position* — that is the id
    // the runtime registered it under, and a `HookExecutor` sees only the hook.
    // The kind is still non-shadowable: assembly checks `BUILTIN_HOOK_KINDS`.
    if (kind === "rubric") {
      return this.runRubric(rubricId(at.state, at.phase, at.index), ctx, args);
    }
    const executor = kind ? this.hookExecutors.get(kind) : undefined;
    if (!executor) {
      const message = kind
        ? `no executor registered for hook kind '${kind}'`
        : `malformed hook (expected a single-key tagged object)`;
      return { ok: false, value: undefined, logs: [], error: { message }, formatted: `error: ${message}` };
    }
    return executor(hook, ctx, args);
  }

  private applyDecision(
    state: string,
    label: string,
    decision: LifecycleDecision,
    ctx: LifecycleContext,
    opts: { phase: "before" | "after"; veto: boolean; to?: string; index: number; maxIterations?: number },
  ): PhaseRejection | null {
    this.emit({
      type: "hook-verdict",
      state,
      phase: opts.phase,
      label,
      verdict: decision.verdict,
      reason: decision.reason,
    });
    const budget = iterationKey(state, opts.phase, opts.index);
    const used = ctx.iterations[budget] ?? 0;
    // Iteration budget, uniform across hook kinds: the hook-level
    // `max_iterations` sidecar wins (it describes *this* state's retry loop); a
    // rubric hook falls back to the rubric's own `max_iterations`; otherwise 0
    // (a `correct` hard-vetoes).
    const rubric = decision.rubric ? this.rubrics.get(decision.rubric) : undefined;
    const maxIterations = opts.maxIterations ?? rubric?.max_iterations ?? 0;
    // The reduction rule lives in the decision kernel; the runner only executes
    // hooks and applies the verdict (correction bookkeeping + events).
    const verdict = reduceHookFact(
      { ...decision, maxIterations, iterationsUsed: used },
      { phase: opts.phase, veto: opts.veto, to: opts.to },
    );
    if (verdict.decision === "block") {
      if (verdict.correctionConsumed) ctx.iterations[budget] = used + 1;
      const reason = verdict.reason ?? decision.reason;
      this.emit({ type: "hook-rejected", state, phase: opts.phase, reason });
      // Exhausted iteration budget (after-phase correction flow only) cannot be
      // fixed by retrying in place; a deliberate veto, an in-budget correction,
      // or a before-phase rejection can. The kernel decides which this is, from
      // the same reduction that wrote the reason.
      return { reason, terminal: verdict.budgetExhausted === true };
    }
    // Only this hook's own budget is released: a passing hook ahead of a
    // correcting one must not hand the latter a fresh budget every attempt.
    delete ctx.iterations[budget];
    return null;
  }

  async runPhase(
    state: string,
    phase: "before" | "after",
    ctx: LifecycleContext,
    extraArgs?: Record<string, unknown>,
    veto = false,
  ): Promise<PhaseRejection | null> {
    const hooks = this.machine.lifecycleHooks()[state];
    const list = phase === "before" ? hooks?.before : hooks?.after;
    if (!list || list.length === 0) return null;

    // The hook input (`HookArgs` in the sandbox): the trigger reaches a hook as
    // its bare id — a run's *input* lives in `variables` — and the transcript as
    // plain messages.
    const scriptArgs = {
      state,
      phase,
      ...(ctx.trigger ? { trigger: ctx.trigger.id } : {}),
      variables: ctx.variables ?? {},
      messages: hookTranscript(ctx.messages),
      ...extraArgs,
    };
    const to = typeof extraArgs?.to === "string" ? extraArgs.to : undefined;

    // Run hooks in declaration order, short-circuiting on the first that fails.
    // The index travels: an inline rubric has no name, so its position in this
    // list is its identity — for dispatch and for its own retry budget.
    for (const [index, hook] of list.entries()) {
      const reject = await this.runSingleHook(state, phase, hook, ctx, scriptArgs, { veto, to, index });
      if (reject) return reject;
    }
    return null;
  }

  private async runSingleHook(
    state: string,
    phase: "before" | "after",
    hook: Hook,
    ctx: LifecycleContext,
    scriptArgs: Record<string, unknown>,
    opts: { veto: boolean; to?: string; index: number },
  ): Promise<PhaseRejection | null> {
    const label = afterHookLabel(hook, opts.index);
    this.emit({ type: "hook-start", state, phase, label });

    const outcome = await this.runHook(hook, ctx, scriptArgs, {
      state,
      phase,
      index: opts.index,
    });

    for (const line of outcome.logs) {
      if (line.trim()) {
        this.emit({ type: "hook-output", state, line: line.trimEnd() });
      }
    }

    const parsed = parseLifecycleDecision(outcome);
    if (parsed && "error" in parsed) {
      this.emit({ type: "hook-rejected", state, phase, reason: parsed.error });
      // A hook that could not execute is a terminal failure: retrying the
      // same turn re-runs the same broken hook.
      return { reason: parsed.error, terminal: true };
    }
    if (!parsed) {
      if (phase === "before") {
        this.emit({ type: "hook-passed", state, phase });
      }
      return null;
    }
    const maxIterations = hookMaxIterations(hook);
    return this.applyDecision(state, label, parsed, ctx, {
      phase,
      veto: opts.veto,
      to: opts.to,
      index: opts.index,
      ...(maxIterations !== undefined ? { maxIterations } : {}),
    });
  }

  async attemptTransition(
    from: string,
    to: string,
    ctx: LifecycleContext,
    reason?: string,
    /**
     * The tool call driving this attempt, when one is. Carried onto the `advance`
     * event so a consumer can attribute the transition to the call that made it;
     * a transition the runtime itself performs passes nothing.
     */
    options?: { callId?: string },
  ): Promise<TransitionOutcome> {
    // Work on a copy of the correction counts so the attempt never mutates the
    // caller's context; the resulting counts are returned for the caller to
    // commit to the checkpoint.
    const corrections = { ...ctx.iterations };
    const localCtx: LifecycleContext = { ...ctx, iterations: corrections };

    // Edge validity is a pure, statically-decidable rule — route it through the
    // decision kernel so runtime and `agent validate` agree. Hook reduction runs
    // per-hook inside `runPhase` (also kernel-backed via `applyDecision`).
    const edgeVerdict = decide(
      this.machine,
      { kind: "transition", from, to, hookFacts: [] },
      [],
      undefined,
      ctx.variableStore ?? {},
    );
    if (edgeVerdict.decision === "block") {
      return {
        ok: false,
        reason: edgeVerdict.reason ?? `cannot advance from '${from}' to '${to}'.`,
        // An invalid edge is always recoverable: the agent picks a valid target.
        terminal: false,
        corrections,
      };
    }
    const trimmedReason = reason?.trim();
    const afterReject = await this.runPhase(
      from,
      "after",
      localCtx,
      { from, to, ...(trimmedReason ? { reason: trimmedReason } : {}) },
      true,
    );
    if (afterReject) {
      return { ok: false, reason: afterReject.reason, terminal: afterReject.terminal, corrections };
    }

    const beforeReject = await this.runPhase(to, "before", localCtx);
    if (beforeReject) {
      return { ok: false, reason: beforeReject.reason, terminal: beforeReject.terminal, corrections };
    }

    this.emit({
      type: "advance",
      from,
      to,
      ...(trimmedReason ? { reason: trimmedReason } : {}),
      ...(options?.callId ? { callId: options.callId } : {}),
    });
    return { ok: true, from, to, corrections };
  }

  dispose(sessionId: string): void {
    this.executor.dispose(sessionId, PROCESS_SESSION);
  }
}
