import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import {
  agentSaid,
  contentToString,
  humanNote,
  isRuntimeNote,
  lastAgentText,
  lastMessageIsHuman,
  messageTypeOf,
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

/**
 * What the person reads as you move on travels in the control call's `message`,
 * so handing work on is one tool call; a refused call said nothing.
 */
describe("what a control call's message says", () => {
  const advancing = (id: string, message?: string, text = "") =>
    new AIMessage({
      content: text,
      tool_calls: [{ id, name: "archmax_advance", args: { to: "review", reason: "done", ...(message ? { message } : {}) } }],
    });
  const result = (id: string, status: "success" | "error") =>
    new ToolMessage({ content: status === "error" ? "refused" : "Advanced.", tool_call_id: id, name: "archmax_advance", status });

  it("is said beside the message's own text, and only for a speaking control", () => {
    expect(agentSaid(advancing("c1", "Your refund is with a reviewer."))).toBe("Your refund is with a reviewer.");
    expect(agentSaid(advancing("c1", "With a reviewer.", "Recorded."))).toBe("Recorded.\n\nWith a reviewer.");
    const other = new AIMessage({ content: "", tool_calls: [{ id: "c2", name: "send_email", args: { message: "hi" } }] });
    expect(agentSaid(other)).toBe("");
  });

  it("reaches the turn's reply and the last thing said, unless the call was refused", () => {
    const anchor = { count: 0 };
    const accepted = [new HumanMessage("refund please"), advancing("c1", "It is with a reviewer."), result("c1", "success")];
    expect(turnReply(accepted, anchor)).toBe("It is with a reviewer.");
    expect(lastAgentText(accepted)).toBe("It is with a reviewer.");
    expect(spokeSinceLastHumanMessage(accepted)).toBe(true);

    const refusedThenAccepted = [
      new HumanMessage("refund please"),
      advancing("c1", "It is with a reviewer."),
      result("c1", "error"),
      advancing("c2", "It is with a reviewer now."),
      result("c2", "success"),
    ];
    expect(turnReply(refusedThenAccepted, anchor)).toBe("It is with a reviewer now.");
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

  it("keeps every text across runtime notes, an automated state's move included", () => {
    const turn = [
      { role: "human", content: "go" },
      { role: "assistant", content: "first look" },
      ...runtimeNote("sub-workflow", "[sub-workflow] the child finished"),
      { role: "assistant", content: "draft" },
      ...runtimeNote("grader", "[grader] Moved to 'answer': cite the order"),
      { role: "assistant", content: "final" },
    ];
    expect(turnReply([...before, ...turn], anchor)).toBe("first look\n\ndraft\n\nfinal");
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
