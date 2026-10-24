/**
 * How a move of the session is narrated on the event stream — one shape for
 * every mover: the session's agent, a grader state, a code state, a reset.
 */
import type { WorkflowEventEmitter } from "../core/events.js";

/** A move along a declared edge: `advance`, then the state left and the state entered, then the park it opened. */
export function reportAdvance(
  emit: WorkflowEventEmitter,
  sessionId: string,
  moved: {
    from: string;
    to: string;
    reason?: string;
    /** The `archmax_advance` call that made the move, when one did. */
    callId?: string;
    /** The target is a human state, so the move parked the session for a decision. */
    parks?: boolean;
  },
): void {
  const reason = moved.reason?.trim();
  emit({
    type: "advance",
    from: moved.from,
    to: moved.to,
    ...(reason ? { reason } : {}),
    ...(moved.callId ? { callId: moved.callId } : {}),
  });
  reportMove(emit, sessionId, moved);
}

/** The state left, the state entered, and — into a human state — the park it opened. */
export function reportMove(
  emit: WorkflowEventEmitter,
  sessionId: string,
  moved: { from: string; to: string; parks?: boolean },
): void {
  emit({ type: "state-leave", state: moved.from, next: moved.to });
  emit({ type: "state-enter", state: moved.to });
  if (moved.parks) emit({ type: "parked", state: moved.to, sessionId, awaiting: "decision" });
}
