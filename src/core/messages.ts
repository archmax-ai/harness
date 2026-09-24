import { randomUUID } from "node:crypto";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { NOTE_TOOL } from "../machine/tool-names.js";
import { contentToString, messageTypeOf, NOTE_KEY, ROLE_BY_TYPE, type RuntimeNoteKind } from "./message-readers.js";

// The readers are pure and live in `message-readers.ts` (the `@archmax-ai/harness/messages`
// subpath); re-exported so every runtime importer keeps one module for both halves.
export {
  contentToString,
  isAiMessage,
  isHumanMessage,
  isRuntimeNote,
  lastAgentText,
  lastMessageIsHuman,
  lastTurn,
  messagesSince,
  messageTypeOf,
  opensTurn,
  runtimeNoteKind,
  spokeSinceLastHumanMessage,
  type RuntimeNoteKind,
} from "./message-readers.js";

/** The marker every message of a runtime note carries. */
function marker(kind: RuntimeNoteKind): Record<string, unknown> {
  return { [NOTE_KEY]: { note: kind } };
}

/**
 * A message the runtime wrote into a session's transcript on its own behalf, shaped
 * as a **tool call and its result**: an assistant message carrying one
 * {@link NOTE_TOOL} call, and the note itself as that call's result.
 *
 * Role is the only authorship signal a model reads; a human-role note gets
 * treated as a request, and a mid-thread system message is rejected by Anthropic
 * after assistant text, so notes are tool-call pairs. The pair is a transcript
 * shape, not an invocation: the model never made the call, it is answered the
 * instant it appears, nothing runs, and {@link NOTE_TOOL} is registered nowhere.
 *
 * Both messages carry the marker in `additional_kwargs` (round-trips through
 * checkpointed serialization), so a host can hide the synthetic call and label
 * the note without parsing content. The `[bracket]` prefix stays in the text for
 * people to read; it is not the signal.
 */
export function runtimeNote(kind: RuntimeNoteKind, text: string): BaseMessage[] {
  const callId = `note_${randomUUID()}`;
  return [
    new AIMessage({
      content: "",
      tool_calls: [{ id: callId, name: NOTE_TOOL, args: { note: kind } }],
      additional_kwargs: marker(kind),
    }),
    new ToolMessage({
      content: text,
      tool_call_id: callId,
      name: NOTE_TOOL,
      additional_kwargs: marker(kind),
    }),
  ];
}

/**
 * The one runtime-authored message that stays human-role: a child session's
 * opening line, which is that session's *entire* transcript at that moment. A
 * session has to open with a request, so it is marked rather than reshaped.
 */
export function humanNote(kind: RuntimeNoteKind, text: string): HumanMessage {
  return new HumanMessage({ content: text, additional_kwargs: marker(kind) });
}

export interface HistoryEntry {
  role: string;
  content: string;
  toolCalls?: { name: string; args: unknown }[];
}

export interface RunContext {
  history: HistoryEntry[];
  userRequest: string;
}

/** How many trailing messages a hook's compact `history` carries. */
const HISTORY_WINDOW = 24;

/** One message as a hook reads it: its role, its text, and any tool calls it made. */
function historyEntry(m: unknown): HistoryEntry {
  const msg = m as Record<string, unknown>;
  const type = messageTypeOf(m) || "?";
  const role = ROLE_BY_TYPE[type] ?? type;
  const entry: HistoryEntry = { role, content: contentToString(msg.content) };
  const toolCalls = msg.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    entry.toolCalls = toolCalls.map((c) => {
      const call = c as Record<string, unknown>;
      return { name: String(call.name ?? ""), args: call.args ?? {} };
    });
  }
  return entry;
}

/**
 * Build the compact view a lifecycle hook and a rubric grader read: the last
 * {@link HISTORY_WINDOW} messages plus the request that opened the session.
 *
 * `userRequest` is derived from the **whole** list, not the window: a grader
 * asked whether the reply satisfies the request must see the request, and a
 * session of more than a couple of tool-calling turns pushes the opening message
 * out of any fixed window (issue #61).
 */
export function runContextFromMessages(messages: unknown[]): RunContext {
  const all = Array.isArray(messages) ? messages : [];
  const history = all.slice(-HISTORY_WINDOW).map(historyEntry);
  const opening = all.find((m) => (ROLE_BY_TYPE[messageTypeOf(m) || "?"] ?? "") === "user");
  const userRequest = opening !== undefined ? contentToString((opening as Record<string, unknown>).content) : "";
  return { history, userRequest };
}
