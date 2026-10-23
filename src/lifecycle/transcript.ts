import { contentToString, messageTypeOf, runtimeNoteKind } from "../core/messages.js";

/**
 * One transcript message as a hook reads it: plain data, no LangChain classes.
 * `role` is `user`, `assistant`, `tool`, `system`, or `runtime` — the last for
 * a note the runtime wrote (an arrival, a decision, an error route), which a
 * model cannot read as a person speaking and a hook should not either.
 */
export interface HookMessage {
  role: string;
  /** The message's text; empty on a tool result, whose result `toolCalls` returns. */
  text: string;
  /** Assistant messages only: the tool calls the message made. */
  toolCalls?: { id?: string; name: string; args: unknown }[];
  /** Tool results only: the tool that answered. */
  tool?: string;
  /** Tool results only: the id of the call it answers. */
  id?: string;
  /** Runtime notes only: which kind of note this is. */
  note?: string;
}

const ROLE_BY_TYPE: Record<string, string> = {
  human: "user",
  ai: "assistant",
  system: "system",
  tool: "tool",
  function: "tool",
};

/**
 * A visit's transcript as a hook receives it in `messages`, newest last. A
 * runtime note is carried in the transcript as a tool-call pair; only the half
 * holding the text is kept, as one `runtime` entry. A tool result names its
 * tool and call but carries no text: results are read through `toolCalls`, so
 * the hook input stays small however large they are.
 */
export function hookTranscript(messages: unknown[]): HookMessage[] {
  const out: HookMessage[] = [];
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
    const entry: HookMessage = { role, text: role === "tool" ? "" : text };
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
