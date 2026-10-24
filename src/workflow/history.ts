/**
 * A session's **history**: its whole transcript as plain messages, its whole
 * trail, and its tool calls with their results — what a grader reads with
 * `archmax_get_history`, and what a code state's script receives as `messages`,
 * `trail` and `toolCalls(filter)`. One view for both, so a grader and a script
 * counting the same rounds read the same thing.
 *
 * Nothing is windowed: a grader asked to give up after N send-backs has to see
 * all N. A tool result carries no text in `messages` — its result is read once,
 * from the tool-call records — so the history stays as small as the transcript
 * allows. What bounds it is the sandbox's result and memory quotas, and the
 * grader model's context.
 */
import { contentToString, messageTypeOf, runtimeNoteKind } from "../core/messages.js";
import type { HistoryMessage, ToolCallRecord } from "../public/sandbox.js";
import { readAuditTrail, type TrailStep } from "./state.js";
import { sessionToolCalls } from "./tool-calls.js";
import { messagesIn } from "./visits.js";

export type { HistoryMessage };

/** The session's history: every message so far, every committed trail step, and every domain tool call. */
export interface SessionHistory {
  messages: HistoryMessage[];
  trail: TrailStep[];
  toolCalls: ToolCallRecord[];
}

const ROLE_BY_TYPE: Record<string, string> = {
  human: "user",
  ai: "assistant",
  system: "system",
  tool: "tool",
  function: "tool",
};

/**
 * The transcript as plain messages, oldest first. A runtime note is carried in
 * the transcript as a tool-call pair; only the half holding the text is kept,
 * as one `runtime` entry. A tool result names its tool and the call it answers
 * but carries no text: its result is in the tool-call records.
 */
export function historyMessages(messages: unknown[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const raw of Array.isArray(messages) ? messages : []) {
    const msg = raw as Record<string, unknown>;
    const type = messageTypeOf(raw);
    const text = contentToString(msg.content);
    const note = runtimeNoteKind(raw);
    if (note !== null) {
      if (text.trim() === "") continue;
      out.push({ role: "runtime", text, note });
      continue;
    }
    const role = ROLE_BY_TYPE[type] ?? (type || "unknown");
    const entry: HistoryMessage = { role, text: role === "tool" ? "" : text };
    const calls = msg.tool_calls;
    if ((type === "ai" || type === "assistant") && Array.isArray(calls) && calls.length > 0) {
      entry.toolCalls = calls.map((c) => {
        const call = c as Record<string, unknown>;
        return { ...(call.id == null ? {} : { id: String(call.id) }), name: String(call.name ?? ""), args: call.args ?? {} };
      });
    }
    if (role === "tool") {
      if (typeof msg.name === "string") entry.tool = msg.name;
      if (msg.tool_call_id != null) entry.id = String(msg.tool_call_id);
    }
    out.push(entry);
  }
  return out;
}

/** The history of the session whose checkpointed state this is. */
export function sessionHistory(state: unknown): SessionHistory {
  return {
    messages: historyMessages(messagesIn(state)),
    trail: readAuditTrail(state),
    toolCalls: sessionToolCalls(state),
  };
}
