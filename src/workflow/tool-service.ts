/**
 * The tools the runtime services itself inside `wrapToolCall`: the control
 * tools (with checkpointed state in hand) and delegations (through the
 * dispatcher, with the calling state known). Every serviced call is bracketed
 * with the same `tool-called`/`tool-result` pair an ordinary call gets.
 */
import { ToolMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import type { LifecycleContext, LifecycleRunner } from "../lifecycle/runner.js";
import type { WorkflowMachine } from "../machine/machine.js";
import type { WorkflowEventEmitter } from "../core/events.js";
import type { MountPrefixes } from "../core/mounts.js";
import { toolCallDetail, toolOutputPreview } from "../core/tool-telemetry.js";
import { TITLE_VARIABLE } from "../machine/variables.js";
import { workflowSlugFromToolName } from "../machine/tool-names.js";
import type { WorkflowToolCallRequest } from "../core/deepagents.js";
import {
  ADVANCE_TOOL,
  GET_VARIABLES_TOOL,
  handleAdvance,
  handleGetVariables,
  handleReset,
  handleSetVariables,
  handleWait,
  refusal,
  RESET_TOOL,
  SET_VARIABLES_TOOL,
  setVariablesCommand,
  WAIT_TOOL,
} from "./control-tools.js";
import { readVariables, type PendingDecision, type TrailStep } from "./state.js";
import { subWorkflowParkOf, type SubWorkflowDispatcher } from "./sub-workflow.js";
import { delegationCallResult } from "./workflow-tools.js";
import { buildRunnableConfig } from "./runtime-config.js";

export interface ToolServiceContext {
  machine: WorkflowMachine;
  emit: WorkflowEventEmitter;
  lifecycle: LifecycleRunner;
  mountPrefixes: MountPrefixes;
  subWorkflows?: SubWorkflowDispatcher;
  lifecycleCtx(sessionId: string, state: unknown, messages: unknown[]): LifecycleContext;
}

/** The identities of one call being serviced. */
export interface ServicedCall {
  sessionId: string;
  workflowState: string;
  toolName: string;
  /** The id the call is reported under: the provider's, else a generated fallback. */
  callId: string;
  /** The provider's tool-call id, echoed on the tool message. */
  toolCallId: string;
}

/**
 * Which model step a serviced call belongs to: the id of the assistant message
 * that made it. Every tool call in one assistant message shares it, and the
 * next model call mints a new one — so it is exactly the scope within which a
 * second transition is a duplicate rather than a further step.
 *
 * Without an id (a fake model in a test, a provider that omits one) the message
 * count stands in: sibling calls still read one step-start snapshot, so they
 * still agree, and a later step has appended at least the previous results.
 */
function stepIdOf(state: unknown): string {
  const messages = (state as { messages?: unknown[] } | undefined)?.messages;
  if (!Array.isArray(messages)) return "0";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown> | undefined;
    const calls = msg?.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) continue;
    return typeof msg?.id === "string" && msg.id ? msg.id : `#${messages.length}`;
  }
  return `#${messages.length}`;
}

/**
 * The refusal a second transition in one assistant message gets. Phrased as the
 * mistake it is, so the model drops the extra call rather than retrying it: the
 * first transition already landed and this step is over.
 */
function duplicateMoveRefusal(toolName: string, toolCallId: string, landedAt: string): ToolMessage {
  return refusal(
    toolName,
    toolCallId,
    `${toolName} rejected: this message already moved the workflow, which is now in ` +
      `state '${landedAt}'. One transition per message — decide where to go from ` +
      `there on your next turn.`,
  );
}

/** A governance refusal: an error-status tool message the model self-corrects on, marked for the session view. */
export function blockedMessage(toolName: string, toolCallId: string, content: string): ToolMessage {
  return new ToolMessage({
    content,
    tool_call_id: toolCallId,
    name: toolName,
    status: "error",
    additional_kwargs: { governance_blocked: true },
  });
}

/** The tool message a serviced handler settled with: bare, or carried in a `Command`'s update. */
function settledMessage(result: unknown): ToolMessage | undefined {
  if (result instanceof ToolMessage) return result;
  const update = (result as { update?: { messages?: unknown[] } } | undefined)?.update;
  return update?.messages?.find((m) => m instanceof ToolMessage) as ToolMessage | undefined;
}

export function createToolService(ctx: ToolServiceContext) {
  const { machine, emit, lifecycle, mountPrefixes, subWorkflows } = ctx;

  function emitToolCalled(state: string, toolName: string, callId: string, args: Record<string, unknown>): void {
    const detail = toolCallDetail(args);
    emit({ type: "tool-called", state, tool: toolName, callId, args, ...(detail ? { detail } : {}) });
  }

  /** Bracket a serviced call with its `tool-called`/`tool-result` pair: every announced call has to settle. */
  async function withPairedEvents<T extends { message: Command | ToolMessage }>(
    call: ServicedCall,
    args: Record<string, unknown>,
    handle: () => T | Promise<T>,
    statusOf?: (result: T) => "ok" | "error",
  ): Promise<T> {
    const { workflowState, toolName, callId } = call;
    emitToolCalled(workflowState, toolName, callId, args);
    const startedAt = Date.now();
    const settle = (status: "ok" | "error", preview: { output: string; truncated: boolean }) =>
      emit({ type: "tool-result", state: workflowState, tool: toolName, callId, status, durationMs: Date.now() - startedAt, ...preview });
    try {
      const result = await handle();
      const message = settledMessage(result.message);
      settle(
        statusOf ? statusOf(result) : message?.status === "error" ? "error" : "ok",
        toolOutputPreview(message ?? result.message),
      );
      return result;
    } catch (err) {
      settle("error", toolOutputPreview((err as Error)?.message ?? String(err)));
      throw err;
    }
  }

  /**
   * The model step each session last moved in, keyed by session id. One step may
   * commit one transition: sibling `archmax_advance` calls in a single assistant
   * message each read the same step-start position, so each would pass edge
   * validation, run the leaving state's `after` hook, and write a position to a
   * last-value channel — double-running a governance hook and landing wherever
   * the last writer said (issue #66).
   */
  const movedAtStep = new Map<string, { step: string; to: string }>();

  /**
   * The sub-runs a call caused, drained from the dispatcher's ledger as trail
   * steps. Drained after every call: a script's dispatches arrive during the
   * `archmax_run` call that ran it.
   */
  function dispatchSteps(sessionId: string, workflowState: string): TrailStep[] {
    return (subWorkflows?.drainDispatches(sessionId) ?? []).map((d) => ({
      to: workflowState,
      kind: "sub-workflow" as const,
      workflow: d.workflow,
      status: d.status,
      ...(d.reason ? { reason: d.reason } : {}),
      ts: Date.now(),
    }));
  }

  function withDispatchSteps(result: Command | ToolMessage, steps: TrailStep[]): Command | ToolMessage {
    if (steps.length === 0) return result;
    if (result instanceof ToolMessage) {
      return new Command({ update: { messages: [result], auditTrail: steps } });
    }
    const update = (result as { update?: Record<string, unknown> }).update ?? {};
    return new Command({
      update: { ...update, auditTrail: [...((update.auditTrail as TrailStep[] | undefined) ?? []), ...steps] },
    });
  }

  /** Report a move: the state left, the state entered, and the park it opened. */
  function reportMove(sessionId: string, moved: { from: string; to: string; park?: PendingDecision }): void {
    emit({ type: "state-leave", state: moved.from, next: moved.to });
    emit({ type: "state-enter", state: moved.to });
    if (moved.park) {
      emit({ type: "parked", state: moved.to, sessionId, awaiting: "decision" });
    }
  }

  /** Service a delegation through the dispatcher; refused as a blocked call when nothing may run. */
  async function serviceDelegation(
    request: WorkflowToolCallRequest,
    dispatcher: SubWorkflowDispatcher,
    call: ServicedCall,
    args: Record<string, unknown>,
  ): Promise<Command | ToolMessage> {
    const { sessionId, workflowState, toolName, callId, toolCallId } = call;
    const workflow = workflowSlugFromToolName(toolName)!;
    const dispatchInput = {
      workflow,
      params: args,
      variables: readVariables(request.state),
      config: buildRunnableConfig(request.runtime ?? {}),
      state: workflowState,
      toolCallId: callId,
    };
    const refused = await dispatcher.refusal(dispatchInput);
    if (refused) {
      emit({ type: "tool-blocked", state: workflowState, tool: toolName, reason: refused.message, callId, args });
      return blockedMessage(toolName, toolCallId, refused.message);
    }
    const outcome = await withPairedEvents(call, args, async () => {
      try {
        const output = delegationCallResult(await dispatcher.dispatch(dispatchInput));
        return {
          message: new ToolMessage({
            content: typeof output === "string" ? output : JSON.stringify(output),
            tool_call_id: toolCallId,
            name: toolName,
          }),
        };
      } catch (err) {
        // The child stopped for a person. Recorded here, where checkpointed state
        // is reachable, rather than propagated: the suspension would otherwise
        // unwind the whole turn and replay every sibling call.
        const parked = subWorkflowParkOf(err);
        if (parked) {
          const decision = parked.decision as PendingDecision;
          return {
            message: new Command({
              update: {
                pendingDelegations: [
                  {
                    state: workflowState,
                    workflow,
                    toolCallId,
                    identity: parked.identity,
                    dispatchId: parked.dispatchId,
                    decision,
                  },
                ],
                messages: [
                  new ToolMessage({
                    content:
                      `The '${workflow}' sub-workflow stopped for a person at its ` +
                      `'${decision?.state}' step. This run is now waiting on ` +
                      `that decision and will continue here once it is made.`,
                    tool_call_id: toolCallId,
                    name: toolName,
                  }),
                ],
              },
            }),
          };
        }
        // A child that ran and did not finish is this state's failure: committed as
        // `rejected`, so the run routes through `on_error` once the model has finished.
        const message = (err as Error)?.message ?? String(err);
        return {
          message: new Command({
            update: { rejected: message, messages: [refusal(toolName, toolCallId, message)] },
          }),
        };
      }
    });
    return withDispatchSteps(outcome.message, dispatchSteps(sessionId, workflowState));
  }

  /** Service a control tool, or `undefined` when `toolName` is not one. */
  async function serviceControlTool(
    request: WorkflowToolCallRequest,
    call: ServicedCall,
    args: Record<string, unknown>,
  ): Promise<Command | ToolMessage | undefined> {
    const { sessionId, workflowState, toolName, callId, toolCallId } = call;
    const state = request.state;
    const step = stepIdOf(state);
    // One transition per model step. Only a move that landed claims the step, so
    // a refused attempt (invalid edge, hook veto) leaves a sibling free to try.
    const claimed = movedAtStep.get(sessionId);
    const alreadyMovedTo = claimed?.step === step ? claimed.to : undefined;
    const claimStep = (moved?: { from: string; to: string; park?: PendingDecision }) => {
      if (!moved) return;
      movedAtStep.set(sessionId, { step, to: moved.to });
      reportMove(sessionId, moved);
    };
    switch (toolName) {
      case ADVANCE_TOOL: {
        if (alreadyMovedTo) return duplicateMoveRefusal(toolName, toolCallId, alreadyMovedTo);
        const outcome = await withPairedEvents(
          call,
          args,
          () =>
            handleAdvance(
              { machine, lifecycle, mountPrefixes },
              { toolCallId, callId, args, state, ctx: ctx.lifecycleCtx(sessionId, state, state?.messages ?? []) },
            ),
          // A refused transition replies without erroring the message, so the outcome is read off the move.
          (result) => (result.moved ? "ok" : "error"),
        );
        claimStep(outcome.moved);
        return outcome.message;
      }
      case RESET_TOOL: {
        if (alreadyMovedTo) return duplicateMoveRefusal(toolName, toolCallId, alreadyMovedTo);
        const outcome = await withPairedEvents(call, args, () => handleReset(machine, { toolCallId, args, state }));
        claimStep(outcome.moved);
        return outcome.message;
      }
      case WAIT_TOOL: {
        const outcome = await withPairedEvents(call, args, () => handleWait(machine, { toolCallId, args, state }));
        if (outcome.park) {
          emit({
            type: "parked",
            state: workflowState,
            sessionId,
            awaiting: "input",
            reason: outcome.park.reason,
            ...(outcome.park.resumeAt ? { resumeAt: outcome.park.resumeAt } : {}),
            callId,
          });
        }
        return outcome.message;
      }
      case GET_VARIABLES_TOOL: {
        const outcome = await withPairedEvents(call, args, () => ({
          message: handleGetVariables({ toolCallId, args, state }),
        }));
        return outcome.message;
      }
      case SET_VARIABLES_TOOL: {
        const outcome = await withPairedEvents(call, args, () => {
          const written = handleSetVariables({ toolCallId, args, state });
          // Only a write that landed is announced; a refusal is visible as the tool's error result.
          if (written.written) {
            emit({ type: "variables-set", state: workflowState, names: written.written, locked: written.locked === true, callId });
            const title = written.delta?.[TITLE_VARIABLE]?.value;
            if (typeof title === "string") emit({ type: "title-set", title, state: workflowState, callId });
          }
          return { message: setVariablesCommand(written) };
        });
        return outcome.message;
      }
      default:
        return undefined;
    }
  }

  return {
    emitToolCalled,
    dispatchSteps,
    withDispatchSteps,
    reportMove,
    serviceDelegation,
    serviceControlTool,
    releaseSession(sessionId: string): void {
      movedAtStep.delete(sessionId);
    },
  };
}
