/**
 * Visits: the span of a session from its entry into a state until it next
 * enters one. What a hook sees of the conversation is the current visit, and
 * every tool call is attributed to the visit of the message that made it.
 */
import { anchorIndex, turnAnchorOf } from "../core/messages.js";
import { readWorkflowState, type VisitStart } from "./state.js";

/** One visit as found in a transcript: its number (from 1), its state and its first message's index. */
export interface VisitSpan {
  number: number;
  state: string;
  start: number;
}

/**
 * The session's visits over `messages`, in order. A session from before the
 * visit log has no entry for what precedes its first logged visit: that span
 * is one visit, at the session's entry state.
 */
export function visitSpans(messages: readonly unknown[], state: unknown): VisitSpan[] {
  const fields = readWorkflowState(state);
  const spans = (fields.visits ?? []).map((visit) => ({ state: visit.state, start: anchorIndex(messages, visit.from) }));
  if (spans.length === 0 || spans[0]!.start > 0) {
    spans.unshift({ state: fields.entryState ?? fields.workflowState ?? "", start: 0 });
  }
  return spans.map((span, i) => ({ number: i + 1, ...span }));
}

/** The visit holding the message at `index`. */
export function visitAt(spans: readonly VisitSpan[], index: number): VisitSpan {
  let found = spans[0]!;
  for (const span of spans) {
    if (span.start > index) break;
    found = span;
  }
  return found;
}

/** The messages of the visit the session is in. */
export function currentVisitMessages(messages: readonly unknown[], state: unknown): unknown[] {
  const spans = visitSpans(messages, state);
  return messages.slice(spans[spans.length - 1]!.start);
}

/** The log entry for entering `target` with the transcript standing at `messages`. */
export function visitStart(target: string, messages: unknown): VisitStart[] {
  return [{ state: target, from: turnAnchorOf(messages) }];
}

/** A checkpointed state's transcript. */
export function messagesIn(state: unknown): unknown[] {
  const messages = (state as { messages?: unknown } | undefined)?.messages;
  return Array.isArray(messages) ? messages : [];
}
