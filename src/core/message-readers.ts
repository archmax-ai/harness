/**
 * Reading a transcript: what kind a message is, who wrote it, what the agent
 * last said, and where a turn begins. Every reader is duck-typed over the shapes
 * a message takes at runtime — a LangChain class instance, a serialized object,
 * a raw `{ role, content }` — and never `instanceof`, so this module imports
 * nothing and a host can read a checkpointed transcript without the runtime.
 * The writers (`runtimeNote`, `humanNote`) live in `messages.ts`.
 */

export const ROLE_BY_TYPE: Record<string, string> = {
  human: "user",
  ai: "assistant",
  system: "system",
  tool: "tool",
  function: "tool",
};

/**
 * The LangChain message kind (`ai`, `human`, `tool`, `system`, …), read
 * robustly across the shapes a message can take at runtime: a class instance
 * (`_getType()`/`getType()`), a serialized object (`type`), or a raw role
 * (`role`). One definition, shared by the workflow graph, session-artifact
 * serialization, and history building, so message classification cannot drift.
 */
export function messageTypeOf(message: unknown): string {
  const msg = message as Record<string, unknown>;
  const t =
    (msg._getType as (() => string) | undefined)?.() ??
    (msg.getType as (() => string) | undefined)?.() ??
    msg.type ??
    msg.role ??
    "";
  return String(t);
}

/** Whether a message is an assistant/AI message (`ai` or `assistant`). */
export function isAiMessage(message: unknown): boolean {
  const t = messageTypeOf(message);
  return t === "ai" || t === "assistant";
}

/** Whether a message is a human/user message (`human` or `user`). */
export function isHumanMessage(message: unknown): boolean {
  const t = messageTypeOf(message);
  return t === "human" || t === "user";
}

/**
 * What the agent last *said*: the final assistant message carrying text. Tool
 * results — the `archmax_advance` confirmation is routinely the literal last
 * message — and the runtime's own notes are skipped, so this is the session's
 * answer as a person would read it.
 */
export function lastAgentText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isAiMessage(message) || isRuntimeNote(message)) continue;
    const text = contentToString((message as { content?: unknown }).content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * What the runtime wrote into a transcript, and why.
 *
 *  - `decision` — a person picked an edge at a human state and the session was routed
 *  - `event` — a trigger firing was delivered to a parked session
 *  - `error` — a failed state was routed to its `on_error` target
 *  - `after` — a terminal state's completion check asked for a revision
 *  - `sub-workflow` — a resumed child's result, handed back to its caller
 *  - `opening` — the fixed line a child session's own transcript opens with
 */
export type RuntimeNoteKind =
  | "decision"
  | "event"
  | "error"
  | "after"
  | "sub-workflow"
  | "opening";

/** Where the marker lives on a message: `additional_kwargs.archmax.note`. */
export const NOTE_KEY = "archmax";

/**
 * The kind of runtime note a message is, or `null` if a person wrote it. Read
 * from `additional_kwargs` across the shapes a message takes at runtime, the way
 * {@link messageTypeOf} reads a message's kind.
 */
export function runtimeNoteKind(message: unknown): RuntimeNoteKind | null {
  const msg = message as
    | { additional_kwargs?: unknown; kwargs?: { additional_kwargs?: unknown } }
    | undefined;
  // A class instance and a plain message-like object both carry
  // `additional_kwargs` at the top; LangChain's own serialized-constructor form
  // (what a checkpoint holds on disk) nests it under `kwargs`.
  const kwargs = (msg?.additional_kwargs ?? msg?.kwargs?.additional_kwargs) as
    | Record<string, unknown>
    | undefined;
  const marker = kwargs?.[NOTE_KEY] as { note?: unknown } | undefined;
  const note = marker?.note;
  return typeof note === "string" ? (note as RuntimeNoteKind) : null;
}

/** Whether the runtime wrote this message rather than a person. */
export function isRuntimeNote(message: unknown): boolean {
  return runtimeNoteKind(message) !== null;
}

/**
 * Whether a message opens a turn: something the session was **told**, by a person
 * or by the runtime. A runtime note opens one too — an arrival, a decision, a
 * correction is news the session has to answer for. Evaluated per message, so a
 * transcript mixing human-role notes (checkpointed before notes became tool-call
 * pairs) with marked notes decides identically for each.
 */
export function opensTurn(message: unknown): boolean {
  return isHumanMessage(message) || isRuntimeNote(message);
}

/** Whether the last thing in the transcript is something the session was told. */
export function lastMessageIsHuman(messages: unknown[]): boolean {
  const last = messages[messages.length - 1];
  return last !== undefined && opensTurn(last);
}

/**
 * Whether the agent has said anything since the last thing it was told — any
 * assistant message carrying non-empty text, including one that also made a tool
 * call. The window is closed by a turn-opening message: a person's, or the
 * runtime's own narration, which closes it exactly as a real message does.
 */
export function spokeSinceLastHumanMessage(messages: unknown[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined) continue;
    if (opensTurn(message)) return false;
    if (!isAiMessage(message)) continue;
    if (contentToString((message as { content?: unknown }).content).trim() !== "") return true;
  }
  return false;
}

/**
 * The messages appended since `cursor` — a message count read before a turn
 * (`agent.sessions.messageCount(sessionId)`), so a host slices exactly what one
 * `invoke` added without knowing how many seeds or notes opened it. A cursor past
 * the end yields nothing.
 */
export function messagesSince<T>(messages: readonly T[], cursor: number): T[] {
  const from = Math.max(0, Math.floor(cursor));
  return from >= messages.length ? [] : messages.slice(from);
}

/**
 * The trailing turn of a transcript: from the last thing the session was told to
 * the end. What the session was told may be several adjacent messages — a
 * delivered firing is a note pair followed by the person's message — so the
 * turn starts at the first of the last unbroken run of turn-opening messages.
 * For everything one `invoke` appended, use a cursor and {@link messagesSince}:
 * a child's result note lands mid-turn and opens a reply window of its own.
 */
export function lastTurn<T>(messages: readonly T[]): T[] {
  let end = messages.length - 1;
  while (end >= 0 && !opensTurn(messages[end])) end--;
  if (end < 0) return [];
  let start = end;
  while (start > 0 && opensTurn(messages[start - 1])) start--;
  return messages.slice(start);
}

/** Flatten LangChain message content (string or multimodal parts) to plain text. */
export function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof (part as { text?: string })?.text === "string"
            ? (part as { text: string }).text
            : "",
      )
      .join("");
  }
  return "";
}
