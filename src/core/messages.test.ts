import { describe, expect, it } from "vitest";
import {
  contentToString,
  humanNote,
  isRuntimeNote,
  lastAgentText,
  lastMessageIsHuman,
  messageTypeOf,
  runContextFromMessages,
  runtimeNote,
  runtimeNoteKind,
  spokeSinceLastHumanMessage,
  turnAnchorOf,
  turnReply,
} from "./messages.js";

describe("contentToString", () => {
  it("flattens strings and multimodal parts", () => {
    expect(contentToString("plain")).toBe("plain");
    expect(contentToString([{ text: "a" }, "b", { type: "image" }])).toBe("ab");
    expect(contentToString(42)).toBe("");
  });
});

describe("runContextFromMessages", () => {
  it("maps roles, captures tool calls, and finds the user request", () => {
    const ctx = runContextFromMessages([
      { role: "system", content: "sys" },
      { role: "human", content: "do it", tool_calls: [{ name: "ls", args: { a: 1 } }] },
      { _getType: () => "ai", content: [{ text: "ok" }] },
    ]);

    expect(ctx.userRequest).toBe("do it");
    expect(ctx.history.map((h) => h.role)).toEqual(["system", "user", "assistant"]);
    expect(ctx.history[1].toolCalls).toEqual([{ name: "ls", args: { a: 1 } }]);
    expect(ctx.history[2].content).toBe("ok");
  });

  it("keeps every message of the visit, however many", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ role: "ai", content: `${i}` }));
    expect(runContextFromMessages(many).history).toHaveLength(30);
    expect(runContextFromMessages(many, 26).history.map((h) => h.content)).toEqual(["26", "27", "28", "29"]);
  });

  it("keeps the opening request when the visit starts after it", () => {
    // A grader asked whether the reply satisfies the request must still see the
    // request, which an earlier state usually received (issue #61).
    const msgs: unknown[] = [{ role: "human", content: "ORIGINAL REQUEST" }];
    for (let i = 0; i < 30; i++) msgs.push({ role: "ai", content: `step ${i}` });
    const ctx = runContextFromMessages(msgs, 10);

    expect(ctx.userRequest).toBe("ORIGINAL REQUEST");
    expect(ctx.history).toHaveLength(21);
    expect(ctx.history.some((h) => h.role === "user")).toBe(false);
  });

  it("reads the first user message, not the latest one", () => {
    const ctx = runContextFromMessages([
      { role: "human", content: "first" },
      { role: "ai", content: "working" },
      { role: "human", content: "second" },
    ]);
    expect(ctx.userRequest).toBe("first");
  });
});

describe("spokeSinceLastHumanMessage", () => {
  const human = (content: string) => ({ role: "human", content });
  const ai = (content: unknown, extra: Record<string, unknown> = {}) => ({
    role: "assistant",
    content,
    ...extra,
  });
  const toolResult = () => ({ role: "tool", content: "ok" });

  it("is false when the agent has only called tools since the last message", () => {
    expect(
      spokeSinceLastHumanMessage([
        human("refund my order"),
        ai("", { tool_calls: [{ name: "write_file", args: {} }] }),
        toolResult(),
        ai("", { tool_calls: [{ name: "archmax_advance", args: {} }] }),
        toolResult(),
      ]),
    ).toBe(false);
  });

  it("is true when a tool-calling message also carried text", () => {
    expect(
      spokeSinceLastHumanMessage([
        human("refund my order"),
        ai("Recorded — sending it for review.", { tool_calls: [{ name: "archmax_advance", args: {} }] }),
        toolResult(),
      ]),
    ).toBe(true);
  });

  it("is true when the agent asked a question before parking", () => {
    expect(
      spokeSinceLastHumanMessage([human("I need help"), ai("Which order is it?"), toolResult()]),
    ).toBe(true);
  });

  it("counts only what was said since the *last* message", () => {
    expect(
      spokeSinceLastHumanMessage([
        human("hello"),
        ai("Hi — what can I do?"),
        human("refund order 1042"),
        toolResult(),
      ]),
    ).toBe(false);
  });

  it("ignores whitespace-only and multimodal-empty assistant text", () => {
    expect(spokeSinceLastHumanMessage([human("hi"), ai("   ")])).toBe(false);
    expect(spokeSinceLastHumanMessage([human("hi"), ai([{ type: "image" }])])).toBe(false);
  });

  it("is false on an empty transcript", () => {
    expect(spokeSinceLastHumanMessage([])).toBe(false);
  });
});

describe("lastMessageIsHuman", () => {
  it("is true only when the person spoke last", () => {
    expect(lastMessageIsHuman([{ role: "human", content: "any news?" }])).toBe(true);
    expect(
      lastMessageIsHuman([{ role: "human", content: "hi" }, { role: "assistant", content: "hello" }]),
    ).toBe(false);
    expect(lastMessageIsHuman([])).toBe(false);
  });
});

describe("lastAgentText", () => {
  it("skips tool results and empty assistant messages", () => {
    expect(
      lastAgentText([
        { role: "assistant", content: "the answer" },
        { role: "assistant", content: "", tool_calls: [{ name: "archmax_advance", args: {} }] },
        { role: "tool", content: "advanced" },
      ]),
    ).toBe("the answer");
  });

  it("is empty when the agent never spoke", () => {
    expect(lastAgentText([{ role: "human", content: "hi" }])).toBe("");
  });
});

describe("turnReply", () => {
  const before = [
    { id: "m1", role: "human", content: "earlier" },
    { id: "m2", role: "assistant", content: "the earlier answer" },
  ];
  const anchor = turnAnchorOf(before);

  it("is every text the turn added, text written next to an advance included", () => {
    const turn = [
      { role: "human", content: "book it" },
      { role: "assistant", content: "Here is the plan: X.", tool_calls: [{ name: "archmax_advance", args: {} }] },
      { role: "tool", content: "advanced" },
      { role: "assistant", content: "  I'll wait for your confirmation.  " },
    ];
    expect(turnReply([...before, ...turn], anchor)).toBe("Here is the plan: X.\n\nI'll wait for your confirmation.");
  });

  it("is empty for a turn that said nothing, whatever an earlier turn said", () => {
    expect(turnReply([...before, { role: "human", content: "again" }], anchor)).toBe("");
  });

  it("drops a draft a completion check asked to revise, and keeps text across other notes", () => {
    const turn = [
      { role: "human", content: "go" },
      { role: "assistant", content: "first look" },
      ...runtimeNote("sub-workflow", "[sub-workflow] the child finished"),
      { role: "assistant", content: "draft" },
      ...runtimeNote("after", "[after] did not pass: revise"),
      { role: "assistant", content: "final" },
    ];
    expect(turnReply([...before, ...turn], anchor)).toBe("final");
    const kept = [
      { role: "human", content: "go" },
      { role: "assistant", content: "first look" },
      ...runtimeNote("error", "[error] routed"),
      { role: "assistant", content: "handled" },
    ];
    expect(turnReply([...before, ...kept], anchor)).toBe("first look\n\nhandled");
  });

  it("finds the turn by the anchor's id when the list was rewritten ahead of it", () => {
    // Tool-call patching dropped an orphaned tool message before the anchor: the count would skip the turn's first text.
    const rewritten = [
      { id: "m2", role: "assistant", content: "the earlier answer" },
      { role: "human", content: "go" },
      { role: "assistant", content: "now" },
    ];
    expect(turnReply(rewritten, { id: "m2", count: 3 })).toBe("now");
  });

  it("falls back to the count when no message carries the anchor's id", () => {
    const list = [...before, { role: "human", content: "go" }, { role: "assistant", content: "now" }];
    expect(turnReply(list, { id: "gone", count: 2 })).toBe("now");
    expect(turnReply(list, turnAnchorOf([]))).toBe("the earlier answer\n\nnow");
    expect(turnReply(list, { count: 99 })).toBe("");
  });
});

describe("runtime notes", () => {
  it("is a synthetic call and its result, both marked", () => {
    const [call, note] = runtimeNote("decision", "[decision] A human selected approve → 'refund'.");
    expect(messageTypeOf(call)).toBe("ai");
    expect(messageTypeOf(note)).toBe("tool");
    // The pair is a transcript shape, not an invocation: the call is answered
    // the instant it appears, so it never dangles.
    expect((call as { tool_calls?: { id?: string; name?: string }[] }).tool_calls).toMatchObject([
      { name: "archmax_note" },
    ]);
    expect((note as { tool_call_id?: string }).tool_call_id).toBe(
      (call as unknown as { tool_calls: { id: string }[] }).tool_calls[0]!.id,
    );
    expect(String((note as { content?: unknown }).content)).toContain("[decision]");
    expect(runtimeNoteKind(call)).toBe("decision");
    expect(runtimeNoteKind(note)).toBe("decision");
  });

  it("gives every note its own call id", () => {
    const idOf = (kind: "event" | "decision") =>
      (runtimeNote(kind, "…")[0] as unknown as { tool_calls: { id: string }[] }).tool_calls[0]!.id;
    expect(idOf("event")).not.toBe(idOf("decision"));
  });

  it("marks the one note that has to stay human-role", () => {
    const opening = humanNote("opening", "Begin.");
    expect(messageTypeOf(opening)).toBe("human");
    expect(runtimeNoteKind(opening)).toBe("opening");
  });

  it("survives serialization, the shape a checkpoint restores", () => {
    const restored = JSON.parse(JSON.stringify(runtimeNote("event", "[event] 'email_reply' arrived")));
    expect(restored.map(runtimeNoteKind)).toEqual(["event", "event"]);
  });

  it("does not mistake a person's words for narration", () => {
    // A workflow author can write `[event]` in an instruction; the prefix is
    // readable, not a signal.
    expect(isRuntimeNote({ role: "human", content: "[event] did anything arrive?" })).toBe(false);
    expect(runtimeNoteKind({ role: "human", content: "hi" })).toBeNull();
    expect(runtimeNoteKind(undefined)).toBeNull();
    expect(isRuntimeNote({ role: "human", content: "hi", additional_kwargs: { archmax: {} } })).toBe(
      false,
    );
  });

  it("does not read as the agent having spoken", () => {
    // The synthetic call carries no text, so `lastAgentText` — what
    // `DecideOutcome.reply` and a park message read — still finds the agent's
    // own words.
    expect(
      lastAgentText([
        { role: "assistant", content: "It is with a reviewer." },
        ...runtimeNote("decision", "[decision] A human selected approve."),
      ]),
    ).toBe("It is with a reviewer.");
  });
});

describe("turn boundaries across the narration change", () => {
  const ai = (content: string) => ({ role: "assistant", content });
  const person = (content: string) => ({ role: "human", content });
  // Narration as it was checkpointed before this change: human-role, bracketed.
  const legacyNote = (content: string) => ({ role: "human", content });

  it("a runtime note opens a turn, exactly as a person's message did", () => {
    expect(
      spokeSinceLastHumanMessage([person("hi"), ai("hello"), ...runtimeNote("event", "[event] …")]),
    ).toBe(false);
    expect(lastMessageIsHuman([ai("done"), ...runtimeNote("decision", "[decision] …")])).toBe(true);
  });

  it("decides the same way over an old, a new, and a mixed transcript", () => {
    const spokeAfter = (note: unknown[]) =>
      spokeSinceLastHumanMessage([person("refund order 1042"), ai("Sent for review."), ...note]);
    // Old shape and new shape agree: the window is closed either way.
    expect(spokeAfter([legacyNote("[decision] A human selected approve → 'refund'.")])).toBe(false);
    expect(spokeAfter(runtimeNote("decision", "[decision] A human selected approve → 'refund'."))).toBe(
      false,
    );

    // A session resumed across the change carries both in one array.
    const mixed = [
      person("refund order 1042"),
      legacyNote("[event] 'email_reply' arrived"),
      ai("Looking at it now."),
      ...runtimeNote("decision", "[decision] A human selected approve → 'refund'."),
    ];
    expect(spokeSinceLastHumanMessage(mixed)).toBe(false);
    expect(lastMessageIsHuman(mixed)).toBe(true);
    expect(spokeSinceLastHumanMessage([...mixed, ai("Processing the refund.")])).toBe(true);
  });

  it("a person's message to a parked run is still the person's", () => {
    const reply = { role: "human", content: "any news?" };
    expect(isRuntimeNote(reply)).toBe(false);
    expect(lastMessageIsHuman([ai("Waiting on the reviewer."), reply])).toBe(true);
  });
});

describe("runContextFromMessages with narration", () => {
  it("shows a hook the note as a tool result, not as the person asking", () => {
    const ctx = runContextFromMessages([
      { role: "human", content: "refund order 1042" },
      ...runtimeNote("decision", "[decision] A human selected approve → 'refund'."),
    ]);
    expect(ctx.history.map((h) => h.role)).toEqual(["user", "assistant", "tool"]);
    expect(ctx.history[1]!.toolCalls).toMatchObject([{ name: "archmax_note" }]);
    expect(ctx.history[2]!.content).toContain("[decision]");
    expect(ctx.userRequest).toBe("refund order 1042");
  });
});
