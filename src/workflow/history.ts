/**
 * A session's **history**: its whole transcript as plain messages and its whole
 * trail — what an automated state reads with `archmax_get_history`, a grader
 * and a code state's script alike, so both counting the same rounds read the
 * same thing. Built from the checkpointed session, never from the request a
 * summary shortened for the model.
 *
 * Nothing is windowed: a grader asked to give up after N send-backs has to see
 * all N. What bounds it is the sandbox's result and memory quotas, and the
 * grader model's context.
 */
import { contentToString, messageTypeOf, runtimeNoteKind } from "../core/messages.js";
import type { HistoryMessage, SessionHistory } from "../public/sandbox.js";
import { readAuditTrail } from "./state.js";

export type { HistoryMessage, SessionHistory };

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
 * as one `runtime` entry. A tool result carries its text, the tool that
 * produced it, and the id of the call it answers.
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
    const entry: HistoryMessage = { role, text };
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
  const messages = (state as { messages?: unknown } | undefined)?.messages;
  return { messages: historyMessages(Array.isArray(messages) ? messages : []), trail: readAuditTrail(state) };
}
