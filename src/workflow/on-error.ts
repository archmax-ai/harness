/**
 * `on_error`: where a failed state sends the run. Every failure a state cannot
 * recover from in place arrives here as a `reason`; the run routes to the
 * declared `on_error` target with an `[error]` runtime note, or ends rejected.
 * Fail-closed either way: nothing continues in the state that failed.
 */
import type { WorkflowEventEmitter } from "../core/events.js";
import { runtimeNote } from "../core/messages.js";
import type { WorkflowMachine } from "../machine/machine.js";
import { decisionRecordFor } from "./parks.js";
import {
  readWorkflowState,
  WORKFLOW_STATUSES,
  type TrailStep,
  type WorkflowUpdate,
} from "./state.js";

/** Which hook is routing: decides how the loop continues after the update. */
export type HookSite = "before-model" | "after-model";

export interface FailureRoutingContext {
  machine: WorkflowMachine;
  emit: WorkflowEventEmitter;
  /** The session the failing hook is executing for, for the park it may open. */
  sessionIdOf(runtime: unknown): string;
}

/**
 * The update that settles a failed state. With an `on_error` target: the note,
 * the new position, an `on_error` trail step, every park record cleared, and —
 * from `afterModel`, where the loop would otherwise exit — a jump back to the
 * model. Without one: `rejected`; `beforeModel` ends the turn outright. A human
 * `on_error` target is presented at once, with the closing message owed.
 */
export function routeFailure(
  ctx: FailureRoutingContext,
  state: unknown,
  runtime: unknown,
  from: string,
  reason: string,
  site: HookSite,
): WorkflowUpdate {
  const errorTarget = ctx.machine.onError(from);
  if (!errorTarget) {
    return {
      rejected: reason,
      status: WORKFLOW_STATUSES.rejected,
      ...(site === "before-model" ? { jumpTo: "end" } : {}),
    };
  }
  ctx.emit({ type: "state-error-routed", state: from, to: errorTarget, reason });
  ctx.emit({ type: "state-leave", state: from, next: errorTarget });
  ctx.emit({ type: "state-enter", state: errorTarget });
  const routed: WorkflowUpdate = {
    messages: runtimeNote(
      "error",
      `[error] The '${from}' state failed: ${reason}. Routing to the '${errorTarget}' error handler.`,
    ),
    workflowState: errorTarget,
    rejected: null,
    status: WORKFLOW_STATUSES.running,
    pendingInput: null,
    pendingDecision: null,
    pendingDelegations: null,
    parkPhase: null,
    replyOnly: null,
    stateTurns: null,
    auditTrail: [
      { to: errorTarget, kind: "on_error", reason, ts: Date.now() } satisfies TrailStep,
    ],
    ...(site === "after-model" ? { jumpTo: "model" } : {}),
  };
  if (!ctx.machine.isHumanState(errorTarget)) return routed;
  const seq = (readWorkflowState(state).decisionCount ?? 0) + 1;
  ctx.emit({
    type: "parked",
    state: errorTarget,
    sessionId: ctx.sessionIdOf(runtime),
    awaiting: "decision",
  });
  return {
    ...routed,
    pendingDecision: decisionRecordFor(ctx.machine, errorTarget, seq),
    decisionCount: seq,
    status: WORKFLOW_STATUSES.awaitingDecision,
    parkPhase: "suspend",
    replyOnly: true,
  };
}
