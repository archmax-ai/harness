import { randomUUID } from "node:crypto";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { NOTE_TOOL } from "../machine/tool-names.js";
import { NOTE_KEY, type RuntimeNoteKind } from "./message-readers.js";

// The readers are pure and live in `message-readers.ts` (the `@archmax-ai/harness/messages`
// subpath); re-exported so every runtime importer keeps one module for both halves.
export {
  anchorIndex,
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
  turnAnchorOf,
  turnReply,
  type RuntimeNoteKind,
  type TurnAnchor,
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
