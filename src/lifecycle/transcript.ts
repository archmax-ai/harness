import { contentToString, messageTypeOf, runtimeNoteKind } from "../core/messages.js";

/**
 * One transcript message as a hook reads it: plain data, no LangChain classes.
 * `role` is `user`, `assistant`, `tool`, `system`, or `runtime` — the last for
 * a note the runtime wrote (an arrival, a decision, an error route), which a
 * model cannot read as a person speaking and a hook should not either.
 */
export interface HookMessage {
  role: string;
  text: string;
  /** Assistant messages only: the tool calls the message made. */
  toolCalls?: { name: string; args: unknown }[];
  /** Tool results only: the tool that produced the text. */
  tool?: string;
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

/** How much of the transcript a hook is handed: the most recent messages. */
export const HOOK_TRANSCRIPT_LIMIT = 24;

/**
 * The recent transcript as a hook receives it in `messages`, newest last. A
 * runtime note is carried in the transcript as a tool-call pair; only the half
 * holding the text is kept, as one `runtime` entry.
 */
export function hookTranscript(messages: unknown[], limit = HOOK_TRANSCRIPT_LIMIT): HookMessage[] {
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
    const entry: HookMessage = { role: ROLE_BY_TYPE[type] ?? (type || "unknown"), text };
    const calls = msg.tool_calls;
    if ((type === "ai" || type === "assistant") && Array.isArray(calls) && calls.length > 0) {
      entry.toolCalls = calls.map((c) => {
        const call = c as Record<string, unknown>;
        return { name: String(call.name ?? ""), args: call.args ?? {} };
      });
    }
    if (entry.role === "tool" && typeof msg.name === "string") entry.tool = msg.name;
    out.push(entry);
  }
  return out.slice(-limit);
}
