/**
 * The workflow middlewares: the hooks that wire governance (`governance.ts`),
 * the turn boundary (`turn-boundary.ts`), parks (`parks.ts`) and failure routing
 * (`on-error.ts`) into the Deep Agent. Checkpointed graph state is the single
 * source of truth for the workflow fields.
 */
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredTool } from "@langchain/core/tools";
import { RemoveMessage } from "@langchain/core/messages";
import { v4 as uuidv4 } from "@langchain/core/utils/uuid";
import { createMiddleware } from "langchain";
import type { AgentMiddleware } from "langchain";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { CODE_SESSION, type ScriptExecutor } from "../sandbox/executor.js";
import type { PtcToolGateway } from "../sandbox/ptc-gateway.js";
import type { WorkflowMachine } from "../machine/machine.js";
import type { Workspace } from "../core/workspace.js";
import { createWorkflowEventEmitter, type WorkflowEventHandler } from "../core/events.js";
import { createControlTools, transitionUpdate } from "./control-tools.js";
import type { VariableStore } from "../machine/variables.js";
import { automatedNoteText, automatedOutcomeOf, type AutomatedOutcome } from "./automated.js";
import type { CodeScriptResolver } from "./code-state.js";
import { checkReturns } from "./returns-check.js";
import { fileGovernance, fileValueCheck, type FileGovernance } from "./file-values.js";
import { returnsFileIssues } from "./signature-checks.js";
import { skillPrefixes } from "../core/skills.js";
import {
  currentWorkflowState,
  isReplyOnly,
  mergeVariables,
  NO_PENDING_FAILURE,
  pendingFailure,
  pendingParkOf,
  readRunUsage,
  readRaised,
  readVariables,
  readWorkflowState,
  WORKFLOW_STATUSES,
  workflowStateSchema,
  type WorkflowStateFields,
  type WorkflowUpdate,
} from "./state.js";
import type { SubWorkflowDispatcher } from "./sub-workflow.js";
import { sessionScopeFrom } from "../sessions/scope.js";
import { contentToString, isAiMessage, isRuntimeNote, lastMessageIsHuman, runtimeNote } from "../core/messages.js";
import type { GovernanceRule } from "../kernel/kernel.js";
import { NO_MOUNTS, type MountPrefixes } from "../core/mounts.js";
import type { SkillRegistry } from "../core/skills.js";
import type { FrameworkRuntime, WorkflowRequestState } from "../core/deepagents.js";
import { addSummaries, extractUsage, summarizeUsage, type PricingTable } from "../core/usage.js";
import { routeFailure } from "./on-error.js";
import { closingTurn, servePark, suspendIfParked, type ParkContext } from "./parks.js";
import { openTurn } from "./turn-boundary.js";
import {
  budgetExhaustedReason,
  buildRunnableConfig,
  createGovernance,
  type PromptShaping,
  type StateModels,
} from "./governance.js";

export type { PromptShaping, StateModels } from "./governance.js";
export { resolveToolName } from "./governance.js";

export interface WorkflowInstrumentation {
  /**
   * The suspension site: the one middleware that calls `interrupt()`. It must be
   * the FIRST middleware in the agent's array that declares an `afterModel` hook:
   * hook nodes run in array order before the model and in reverse after it, so
   * that position puts every hook that emits before the one that suspends, and
   * makes the final router honour this hook's `jumpTo` when a resume continues
   * to the model.
   */
  parkMiddleware: AgentMiddleware;
  /** The governance middleware proper; assembled after {@link parkMiddleware}. */
  middleware: AgentMiddleware;
  tools: StructuredTool[];
  /** Release every per-session resource (idempotent; safe for sessions that never ran). */
  dispose(sessionId: string): void;
}

export interface WorkflowMiddlewareOptions {
  machine: WorkflowMachine;
  /** Runs a code state's script, reading it from the authoring backend. */
  codeExecutor: ScriptExecutor;
  /** Resolves a code state's declared `script:` to its authoring-backend path. */
  resolveCodeScript: CodeScriptResolver;
  /** The model a grader state runs on, and its id when the instance exposes one. */
  graderModel(state: string): { model: BaseChatModel; id?: string };
  /** Consumer rules, evaluated after the safety and `policy` rules, before per-state defaults. */
  policyRules?: GovernanceRule[];
  /** The workspace's resolved mount keys, so the kernel's read-only rule can classify authored paths. */
  mountPrefixes?: MountPrefixes;
  /** The workspace's skills: one table for what the kernel refuses, the prompt names, a listing returns. */
  skills?: SkillRegistry;
  /** Governs every call made outside the tool node — scripts', automated states' — and carries the live per-session context. */
  ptcGateway?: PtcToolGateway;
  /** Runs delegated machines. Omitted, a delegation call falls through to the tool's own body. */
  subWorkflows?: SubWorkflowDispatcher;
  /** Lifecycle event subscriber (default: console rendering). */
  onEvent?: WorkflowEventHandler;
  /** How the model-facing payload is shaped for this assembly. */
  promptShaping?: PromptShaping;
  /** Which model each state's calls run on; omitted, every call uses the graph's own. */
  stateModels?: StateModels;
  /** Workspace backend for writing the spec snapshot into the session zone. */
  workspace?: Workspace;
  /** The `workflows/<slug>/` name, used only to name the machine in a refusal. */
  workflowName?: string;
  /** The assembly-time default trigger, used when an invocation supplies none. */
  trigger?: { id: string };
  /** Host-seeded run variables, applied at each turn boundary (already locked). */
  seededVariables?: VariableStore;
  /** Token prices used to attach `costUsd` to usage events. */
  pricing?: PricingTable;
  /** The sessions are a sub-workflow's children: the control tools ask for no title. */
  child?: boolean;
  /**
   * What a path names in the bound session's workspace — the probe the `file`
   * signature type's checks list through. Omitted, a `file` value is held to its
   * shape alone.
   */
  entryKind?: (path: string) => Promise<"file" | "directory" | "missing">;
  /** How many bytes the file at a path in the bound session's workspace holds: what a `maxSize` is held to. */
  entrySize?: (path: string) => Promise<number | undefined>;
}

/**
 * The id a message will be committed under, assigning one when it arrived
 * without: LangGraph's reducer does the same at commit, so the id on the event
 * and in the transcript are one value.
 */
function committedMessageId(msg: Record<string, unknown>): string {
  const id = msg.id;
  if (typeof id === "string" && id) return id;
  const assigned = uuidv4();
  msg.id = assigned;
  // The reducer keeps `lc_kwargs.id` in step with `id`.
  const kwargs = msg.lc_kwargs;
  if (kwargs && typeof kwargs === "object") (kwargs as Record<string, unknown>).id = assigned;
  return assigned;
}

/** Whether an AI message still carries tool calls the tools node has to answer. */
function callsTools(message: unknown): boolean {
  const calls = (message as { tool_calls?: unknown[] } | undefined)?.tool_calls;
  return Array.isArray(calls) && calls.length > 0;
}

/** The middleware's declared hook result type — the update, however typed. */
const asHookResult = (update: WorkflowUpdate | undefined) => update as never;

/**
 * In-graph governance for the Deep Agent: the turn boundary, per-state tool
 * disclosure and the kernel's verdict on every call, the automated states, the
 * control tools, budgets, `on_error` routing, and every park's commit, closing
 * turn and suspension.
 */
export function createWorkflowInstrumentation(opts: WorkflowMiddlewareOptions): WorkflowInstrumentation {
  const { machine, ptcGateway, subWorkflows, onEvent, pricing, stateModels } = opts;
  const emit = createWorkflowEventEmitter(onEvent);

  const sessionIdOf = (runtime: unknown): string =>
    sessionScopeFrom(runtime as { configurable?: Record<string, unknown> } | undefined).sessionId;
  const configOf = (runtime: unknown): RunnableConfig =>
    buildRunnableConfig((runtime ?? {}) as { configurable?: Record<string, unknown> });

  // The `file` type's runtime checks: a listing of the bound session's workspace
  // and the kernel's read verdict on runtime authority, per state.
  const fileGov: FileGovernance | undefined = opts.entryKind
    ? fileGovernance({
        machine,
        policyRules: opts.policyRules ?? [],
        mountPrefixes: opts.mountPrefixes ?? NO_MOUNTS,
        skills: skillPrefixes(opts.skills ?? new Map()),
        kind: opts.entryKind,
        ...(opts.entrySize ? { size: opts.entrySize } : {}),
      })
    : undefined;
  const files = fileGov
    ? (state: string, variables: VariableStore) => fileValueCheck(fileGov, state, variables)
    : undefined;

  const governance = createGovernance({
    machine,
    emit,
    policyRules: opts.policyRules ?? [],
    mountPrefixes: opts.mountPrefixes ?? NO_MOUNTS,
    skills: opts.skills ?? new Map(),
    shaping: opts.promptShaping ?? {},
    ...(opts.stateModels ? { stateModels: opts.stateModels } : {}),
    ...(ptcGateway ? { ptcGateway } : {}),
    ...(subWorkflows ? { subWorkflows } : {}),
    child: opts.child === true,
    ...(files ? { files } : {}),
    automated: {
      codeExecutor: opts.codeExecutor,
      resolveScript: opts.resolveCodeScript,
      graderModel: opts.graderModel,
      ...(pricing ? { pricing } : {}),
    },
    sessionIdOf,
  });
  const parkCtx: ParkContext = {
    machine,
    emit,
    ...(subWorkflows ? { dispatcher: subWorkflows } : {}),
    sessionIdOf,
    configOf,
  };
  const failureCtx = { machine, emit, sessionIdOf };
  /** The state's `budget.maxTurns`, and the model calls this visit has made against it. */
  const turnBudget = (fields: WorkflowStateFields, workflowState: string) => ({
    maxTurns: machine.spec.states[workflowState]?.budget?.maxTurns,
    spent: fields.stateTurns?.state === workflowState ? fields.stateTurns.count : 0,
  });
  const turnCtx = {
    machine,
    emit,
    onEvent,
    ...(opts.workspace ? { workspace: opts.workspace } : {}),
    ...(opts.workflowName ? { workflowName: opts.workflowName } : {}),
    ...(opts.trigger ? { defaultTrigger: opts.trigger } : {}),
    ...(opts.seededVariables ? { seededVariables: opts.seededVariables } : {}),
    ...(files ? { files } : {}),
  };

  /**
   * The suspension site. Its `beforeModel` runs first of all before-model hooks
   * and its `afterModel` last of all after-model hooks, so by the time it looks
   * at a park every record is committed and every event emitted, and the only
   * thing it does before `interrupt()` is read state — which is what makes its
   * re-execution on resume repeat nothing.
   */
  const parkMiddleware = createMiddleware({
    name: "WorkflowParkMiddleware",
    stateSchema: workflowStateSchema,
    beforeModel: {
      canJumpTo: ["end"],
      hook: async (state: WorkflowRequestState, runtime: FrameworkRuntime) =>
        asHookResult(await suspendIfParked(parkCtx, state, runtime, "before-model")),
    },
    afterModel: {
      canJumpTo: ["model"],
      hook: async (state: WorkflowRequestState, runtime: FrameworkRuntime) =>
        asHookResult(await suspendIfParked(parkCtx, state, runtime, "after-model")),
    },
  });

  const middleware = createMiddleware({
    name: "WorkflowMiddleware",
    stateSchema: workflowStateSchema,

    // The turn boundary: once per invoke, never on a resume.
    beforeAgent: {
      canJumpTo: ["end"],
      hook: async (state: WorkflowRequestState, runtime: FrameworkRuntime) =>
        asHookResult(await openTurn(turnCtx, state, runtime as { configurable?: Record<string, unknown> })),
    },

    beforeModel: {
      canJumpTo: ["end"],
      hook: (state: WorkflowRequestState, runtime: FrameworkRuntime) => {
        const fields = readWorkflowState(state);
        const workflowState = currentWorkflowState(state, machine.entry);

        // The session raised in the step just serviced: it is over. Ended here,
        // before any model call, so nothing after the model runs either — no
        // `on_error` route, no `returns` check.
        if (fields.status === WORKFLOW_STATUSES.failed && readRaised(state)) {
          return asHookResult({ jumpTo: "end" });
        }

        // A park in progress: the closing turn it owes, or a delegated child's decision to present.
        const served = servePark(parkCtx, state, runtime, "before-model");
        if (served) return asHookResult(served);

        // A reply-only turn is owed exactly one model call; anything after the
        // person's message means it has been spent.
        if (isReplyOnly(state)) {
          return asHookResult(lastMessageIsHuman(state.messages ?? []) ? undefined : { jumpTo: "end" });
        }

        // An automated state makes no call of the agent's model, so no agent turn
        // budget applies there; a grader's own calls are bounded inside its run.
        if (machine.isAutomatedState(workflowState)) return asHookResult(undefined);

        // The exact per-state turn budget: this call would be one too many.
        const { maxTurns, spent } = turnBudget(fields, workflowState);
        if (maxTurns != null && spent + 1 > maxTurns) {
          const routed = routeFailure(
            failureCtx,
            state,
            runtime,
            workflowState,
            `state '${workflowState}' exhausted its turn budget (maxTurns: ${maxTurns})`,
            "before-model",
          );
          // The error handler's first call is the one about to be made.
          if (routed.workflowState) routed.stateTurns = { state: routed.workflowState, count: 1 };
          return asHookResult(routed);
        }
        return asHookResult({ stateTurns: { state: workflowState, count: spent + 1 } });
      },
    },

    wrapModelCall: governance.wrapModelCall,
    wrapToolCall: governance.wrapToolCall,

    afterModel: {
      canJumpTo: ["model"],
      hook: async (state: WorkflowRequestState, runtime: FrameworkRuntime) => {
        const fields = readWorkflowState(state);
        const workflowState = currentWorkflowState(state, machine.entry);
        const messages: unknown[] = state.messages ?? [];
        const last = messages[messages.length - 1] as Record<string, unknown> | undefined;
        const update: WorkflowUpdate = {};
        // An automated state's calls dispatch outside the tool node, during the
        // serviced model call, so what they took is committed here.
        const taken = governance.dispatchCount(sessionIdOf(runtime), state);
        if (taken > (fields.dispatchCount ?? 0)) update.dispatchCount = taken;

        // 1. Report the message the model just produced and what it cost. Usage is
        //    committed as the new total: the channel is last-value and this hook is its one writer.
        if (last && isAiMessage(last) && !isRuntimeNote(last)) {
          const text = contentToString(last.content).trim();
          if (text) emit({ type: "agent-text", state: workflowState, text, messageId: committedMessageId(last) });
          const extracted = extractUsage(last);
          if (extracted) {
            // What the response said, else what we asked the endpoint to run,
            // else nothing. The reported id leads deliberately — a proxy may
            // serve an alias, a fallback or a load-balanced deployment, and what
            // it served is the honest thing to price — but a response naming no
            // model must not cost the call its price when assembly knows which
            // model it built. The id used is reported, so a host can attribute
            // the call to a model rather than to nothing.
            const modelId = extracted.model ?? stateModels?.idFor(workflowState);
            const summary = summarizeUsage(extracted.usage, pricing, modelId);
            emit({
              type: "model-usage",
              state: workflowState,
              ...summary,
              ...(modelId ? { model: modelId } : {}),
            });
            update.usage = addSummaries(readRunUsage(state), summary);
          }
        }

        // 2. A model call that ran out of its time budget: the marker leaves the transcript, the failure routes.
        const exhausted = budgetExhaustedReason(last);
        if (exhausted !== undefined && typeof last?.id === "string") {
          const routed = routeFailure(failureCtx, state, runtime, workflowState, exhausted, "after-model");
          return asHookResult({
            ...update,
            ...routed,
            messages: [new RemoveMessage({ id: last.id }), ...(routed.messages ?? [])],
          });
        }

        // 3. An automated state ran in place of the model call: the marker leaves
        //    the transcript and its outcome is committed. A move jumps back to the
        //    model, where the next state runs; a raise ends the session; a failure
        //    routes; a terminal state's completion falls through to the checks
        //    every completing session gets.
        const step = automatedOutcomeOf(last);
        let completedVariables: VariableStore | undefined;
        if (step && typeof last?.id === "string") {
          const committed = commitAutomated(step, last.id, state);
          if (step.result.kind === "failed") {
            const routed = routeFailure(failureCtx, state, runtime, workflowState, step.result.reason, "after-model");
            return asHookResult({
              ...update,
              ...committed,
              ...routed,
              messages: [...(committed.messages ?? []), ...(routed.messages ?? [])],
            });
          }
          if (step.result.kind !== "completed") return asHookResult({ ...update, ...committed });
          Object.assign(update, committed);
          completedVariables = committed.variables;
        }

        // 4. A park's closing or answering turn was just spent.
        const served = servePark(parkCtx, state, runtime, "after-model");
        if (served) return asHookResult({ ...update, ...served });
        if (pendingParkOf(state) || (fields.pendingDelegations ?? []).length > 0) {
          return asHookResult(update);
        }

        // 5. The run ends here only when the model finished — no tool calls pending — in a state that is not parked.
        if (!last || !isAiMessage(last) || callsTools(last) || isReplyOnly(state)) {
          return asHookResult(update);
        }

        // A rejection a tool committed (a terminal kernel block, an exhausted park
        // budget), or a failed sub-run no later call of that workflow recovered,
        // routes once the model has finished in the failing state.
        const failure = pendingFailure(state);
        if (failure) {
          const routed = routeFailure(failureCtx, state, runtime, workflowState, failure, "after-model");
          return asHookResult({
            ...update,
            ...routed,
            // A completed automated step's marker still leaves the transcript.
            messages: [...(update.messages ?? []), ...(routed.messages ?? [])],
          });
        }

        // The exit half of the trigger's signature, checked where a run completes —
        // never at a park, and never handed back: a child settles on what it set
        // (its caller gets a note naming the rest); anything else short of it is rejected.
        // A terminal automated state's writes count: they land with this update.
        const store = completedVariables ? mergeVariables(readVariables(state), completedVariables) : readVariables(state);
        const returns = checkReturns(machine, {
          trigger: fields.trigger?.id,
          state: workflowState,
          store,
          child: opts.child === true,
          fileIssues: files
            ? await returnsFileIssues(machine, fields.trigger?.id, store, files(workflowState, store))
            : [],
        });
        if (returns.verdict === "reject") {
          return asHookResult({ ...update, rejected: returns.reason, status: WORKFLOW_STATUSES.rejected });
        }

        emit({ type: "state-leave", state: workflowState, next: workflowState });
        return asHookResult({ ...update, status: WORKFLOW_STATUSES.completed });
      },
    },

    // The turn is over: drop the session's per-turn context.
    afterAgent: (_state, runtime) => {
      governance.endTurn(sessionIdOf(runtime));
      return undefined;
    },
  });

  /**
   * The update an automated step's outcome commits, beside the marker's removal:
   * its variable writes, its sub-run trail steps, its usage, and — for a move or
   * a raise — the move itself or the failure record, with the runtime note the
   * next state reads. A move jumps back to the model, which skips the
   * `beforeModel` site, so what that site would do for the next call is done
   * here: into a human state the park opens straight in its closing turn, and
   * into an agent state the call is counted as the state's first.
   */
  function commitAutomated(step: AutomatedOutcome, markerId: string, state: WorkflowRequestState): WorkflowUpdate {
    const note = automatedNoteText(step);
    const notes = note ? runtimeNote(step.type, note) : [];
    const committed: WorkflowUpdate = {
      messages: [new RemoveMessage({ id: markerId }), ...notes],
      ...(step.variables ? { variables: step.variables } : {}),
      ...(step.usage ? { usage: addSummaries(readRunUsage(state), step.usage) } : {}),
      ...(step.trail?.length ? { auditTrail: step.trail } : {}),
    };
    const { result } = step;
    if (result.kind === "raised") {
      return {
        ...committed,
        raised: { code: result.code, reason: result.reason, state: step.state },
        status: WORKFLOW_STATUSES.failed,
        ...NO_PENDING_FAILURE,
      };
    }
    if (result.kind !== "advanced") return committed;
    const { update: moved, park } = transitionUpdate(machine, state, {
      to: result.to,
      kind: step.type,
      reason: result.reason,
      ...(result.evidence ? { evidence: result.evidence } : {}),
    });
    const landed: WorkflowUpdate = {
      ...committed,
      ...moved,
      auditTrail: [...(committed.auditTrail ?? []), ...(moved.auditTrail ?? [])],
    };
    if (park) return { ...landed, ...closingTurn(), jumpTo: "model" };
    if (machine.isAutomatedState(result.to)) return { ...landed, jumpTo: "model" };
    // The agent's call about to be made is its state's first.
    return { ...landed, stateTurns: { state: result.to, count: 1 }, jumpTo: "model" };
  }

  return {
    parkMiddleware,
    middleware,
    tools: createControlTools({ child: opts.child === true }),
    dispose: (sessionId) => {
      // Requested per session, so it sweeps the session and every sub-run session nested beneath it.
      for (const scope of new Set([...governance.release(sessionId), sessionId])) {
        ptcGateway?.release(scope);
        opts.codeExecutor.dispose(scope, CODE_SESSION);
      }
    },
  };
}
