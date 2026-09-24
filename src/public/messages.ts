/**
 * `@archmax-ai/harness/messages` — reading a transcript without the runtime.
 *
 * Every reader is duck-typed over the shapes a message takes — a LangChain class
 * instance, a checkpoint's serialized form, a raw `{ role, content }` — and this
 * module imports nothing, so an API request path that renders or slices a
 * transcript loads no LangGraph. A unit test walks the import graph to keep it
 * that way. The root exports the readers a governed host needs most
 * (`contentToString`, `isAiMessage`, `isRuntimeNote`, `runtimeNoteKind`); they
 * are the same bindings here.
 */

export {
  /** A message's text, whatever content-block shape it arrived in. */
  contentToString,
  /** The LangChain message kind (`ai`, `human`, `tool`, `system`, …). */
  messageTypeOf,
  /** Whether a message is the assistant's. */
  isAiMessage,
  /** Whether a message is a person's (or a human-role runtime note — see `isRuntimeNote`). */
  isHumanMessage,
  /** Whether the runtime wrote this message rather than a person. */
  isRuntimeNote,
  /** Which kind of runtime note a message is, or `null` if a person wrote it. */
  runtimeNoteKind,
  /** The last thing the agent said to the person; tool results and runtime notes are skipped. */
  lastAgentText,
  /** Whether a message opens a turn: something the session was told. */
  opensTurn,
  /** The messages appended since a count read earlier — what one `invoke` added. */
  messagesSince,
  /** The trailing turn: from the last thing the session was told to the end. */
  lastTurn,
} from "../core/message-readers.js";
export type { RuntimeNoteKind } from "../core/message-readers.js";
