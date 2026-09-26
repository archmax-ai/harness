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
import type { ScriptExecutor } from "../sandbox/executor.js";
import type { PtcToolGateway } from "../sandbox/ptc-gateway.js";
import { LifecycleRunner, type HookExecutor, type HookScriptResolver } from "../lifecycle/runner.js";
import type { WorkflowMachine } from "../machine/machine.js";
import type { Rubric } from "../rubrics/rubrics.js";
import type { Workspace } from "../core/workspace.js";
import { createWorkflowEventEmitter, type WorkflowEventHandler } from "../core/events.js";
import { createControlTools } from "./control-tools.js";
import type { VariableStore } from "../machine/variables.js";
import { returnsRejection } from "./signature-checks.js";
import {
  currentWorkflowState,
  isReplyOnly,
  pendingParkOf,
  readRunUsage,
  readVariables,
  readWorkflowState,
  WORKFLOW_STATUSES,
  workflowStateSchema,
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
import { servePark, suspendIfParked, type ParkContext } from "./parks.js";
import { openTurn } from "./turn-boundary.js";
import {
  beforeVetoReason,
  budgetExhaustedReason,
  buildRunnableConfig,
  createGovernance,
  type PromptShaping,
  type StateModels,
} from "./governance.js";

export type { PromptShaping, StateModels } from "./governance.js";
export { resolveToolName } from "./governance.js";
export { pruneUndisclosedToolSections, upstreamSectionsFor, type PruneResult } from "./prompt-pruning.js";

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
  lifecycle: LifecycleRunner;
  /** Release every per-session resource (idempotent; safe for sessions that never ran). */
  dispose(sessionId: string): void;
}

export interface WorkflowMiddlewareOptions {
  machine: WorkflowMachine;
  /** Serves the agent's own `archmax_eval`/`archmax_run` over the agent workspace. */
  executor: ScriptExecutor;
  /** The workflow's grading rubrics, dispatched by a `{ rubric: … }` hook. */
  rubrics?: Map<string, Rubric>;
  ptcNames: string[];
  /** Consumer rules, evaluated after the safety and `policy` rules, before per-state defaults. */
  policyRules?: GovernanceRule[];
  /** The workspace's resolved mount keys, so the kernel's read-only rule can classify authored paths. */
  mountPrefixes?: MountPrefixes;
  /** The workspace's skills: one table for what the kernel refuses, the prompt names, a listing returns. */
  skills?: SkillRegistry;
  /** Custom hook-kind executors registered alongside the built-in `script`/`rubric`. */
  hookExecutors?: Record<string, HookExecutor>;
  /** Script executor for lifecycle hooks, reading from the authoring backend. Defaults to {@link executor}. */
  hookExecutor?: ScriptExecutor;
  /** Resolves a hook's declared `script:` to its authoring-backend path. */
  resolveHookScript?: HookScriptResolver;
  /** Governs the `tools.*` calls hook scripts make and carries the live per-session context. */
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
 * disclosure and the kernel's verdict on every call, lifecycle hooks, the
 * control tools, budgets, `on_error` routing, and every park's commit, closing
 * turn and suspension.
 */
export function createWorkflowInstrumentation(opts: WorkflowMiddlewareOptions): WorkflowInstrumentation {
  const { machine, executor, rubrics = new Map(), ptcNames, ptcGateway, subWorkflows, onEvent, pricing, stateModels } = opts;
  const emit = createWorkflowEventEmitter(onEvent);
  const lifecycleHooks = machine.lifecycleHooks();
  const lifecycle = new LifecycleRunner(
    machine,
    opts.hookExecutor ?? executor,
    rubrics,
    ptcNames,
    opts.hookExecutors,
    onEvent,
    ...(opts.resolveHookScript ? [{ resolveScript: opts.resolveHookScript }] : []),
  );

  if (Object.keys(lifecycleHooks).length > 0) {
    emit({
      type: "hooks-summary",
      summary: Object.entries(lifecycleHooks)
        .map(([s, l]) => `${s}(${[l.before && "before", l.after && "after"].filter(Boolean).join("+")})`)
        .join(", "),
    });
  }

  const sessionIdOf = (runtime: unknown): string =>
    sessionScopeFrom(runtime as { configurable?: Record<string, unknown> } | undefined).sessionId;
  const configOf = (runtime: unknown): RunnableConfig =>
    buildRunnableConfig((runtime ?? {}) as { configurable?: Record<string, unknown> });

  const governance = createGovernance({
    machine,
    emit,
    lifecycle,
    policyRules: opts.policyRules ?? [],
    mountPrefixes: opts.mountPrefixes ?? NO_MOUNTS,
    skills: opts.skills ?? new Map(),
    shaping: opts.promptShaping ?? {},
    ...(opts.stateModels ? { stateModels: opts.stateModels } : {}),
    ...(ptcGateway ? { ptcGateway } : {}),
    ...(subWorkflows ? { subWorkflows } : {}),
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
  const turnCtx = {
    machine,
    emit,
    onEvent,
    ...(opts.workspace ? { workspace: opts.workspace } : {}),
    ...(opts.workflowName ? { workflowName: opts.workflowName } : {}),
    ...(opts.trigger ? { defaultTrigger: opts.trigger } : {}),
    ...(opts.seededVariables ? { seededVariables: opts.seededVariables } : {}),
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

        // A park in progress: the closing turn it owes, or a delegated child's decision to present.
        const served = servePark(parkCtx, state, runtime, "before-model");
        if (served) return asHookResult(served);

        // A reply-only turn is owed exactly one model call; anything after the
        // person's message means it has been spent.
        if (isReplyOnly(state)) {
          return asHookResult(lastMessageIsHuman(state.messages ?? []) ? undefined : { jumpTo: "end" });
        }

        // The exact per-state turn budget: this call would be one too many.
        const maxTurns = machine.spec.states[workflowState]?.budget?.maxTurns;
        const spent = fields.stateTurns?.state === workflowState ? fields.stateTurns.count : 0;
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

        // 3. A `before` hook refused this state: the model never ran, so nothing
        //    below applies. Routed like any terminal rejection — the refusal text
        //    stays in the transcript as the reply the person is owed, unlike the
        //    budget marker above, which stood in for an answer that never came.
        const refusedEntry = beforeVetoReason(last);
        if (refusedEntry !== undefined) {
          return asHookResult({
            ...update,
            ...routeFailure(failureCtx, state, runtime, workflowState, refusedEntry, "after-model"),
          });
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
        // budget, a failed sub-run) routes once the model has finished in the failing state.
        if (fields.rejected) {
          return asHookResult({
            ...update,
            ...routeFailure(failureCtx, state, runtime, workflowState, fields.rejected, "after-model"),
          });
        }

        // A terminal state has no `archmax_advance` out of it, so its `after` hook
        // runs at completion: `correct` hands the state back with a note, a
        // terminal failure routes through `on_error`.
        if (machine.isTerminal(workflowState) && lifecycleHooks[workflowState]?.after?.length) {
          const ctx = governance.lifecycleCtx(sessionIdOf(runtime), state, messages);
          const reject = await lifecycle.runPhase(workflowState, "after", ctx, undefined, true);
          if (reject) {
            if (reject.terminal) {
              return asHookResult({
                ...update,
                iterations: ctx.iterations,
                ...routeFailure(failureCtx, state, runtime, workflowState, reject.reason, "after-model"),
              });
            }
            return asHookResult({
              ...update,
              messages: runtimeNote(
                "after",
                `[after] The '${workflowState}' completion check did not pass: ${reject.reason}. ` +
                  `Revise your work and produce a corrected final response.`,
              ),
              iterations: ctx.iterations,
              jumpTo: "model",
            });
          }
          update.iterations = ctx.iterations;
        }

        // The exit half of the trigger's signature, checked where a run completes — never at a park.
        const unmet = returnsRejection(machine, fields.trigger?.id, workflowState, readVariables(state));
        if (unmet) return asHookResult({ ...update, rejected: unmet, status: WORKFLOW_STATUSES.rejected });

        emit({ type: "state-leave", state: workflowState, next: workflowState });
        return asHookResult({ ...update, status: WORKFLOW_STATUSES.completed });
      },
    },

    // Flush this turn's staged `beforeDone` entries as one state update.
    afterAgent: (state, runtime) => {
      const staged = governance.endTurn(sessionIdOf(runtime));
      if (!staged) return undefined;
      return { beforeDone: { ...(readWorkflowState(state).beforeDone ?? {}), ...staged } };
    },
  });

  return {
    parkMiddleware,
    middleware,
    tools: createControlTools(),
    lifecycle,
    dispose: (sessionId) => {
      // Requested per session, so it sweeps the session and every sub-run session nested beneath it.
      for (const scope of new Set([...governance.release(sessionId), sessionId])) {
        ptcGateway?.release(scope);
        lifecycle.dispose(scope);
      }
    },
  };
}
