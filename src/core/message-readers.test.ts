import { describe, expect, it } from "vitest";
import { lastAgentText, lastTurn, messagesSince, opensTurn } from "./message-readers.js";
import { humanNote, runtimeNote } from "./messages.js";

const human = (content: string) => ({ role: "user", content });
const ai = (content: string) => ({ role: "assistant", content });
const tool = (content: string) => ({ role: "tool", content });

describe("messagesSince", () => {
  it("slices what was appended after the cursor", () => {
    const messages = [human("a"), ai("b"), human("c"), ai("d")];
    expect(messagesSince(messages, 2)).toEqual([human("c"), ai("d")]);
    expect(messagesSince(messages, 0)).toEqual(messages);
  });

  it("yields nothing for a cursor at or past the end, and clamps a negative one", () => {
    const messages = [human("a"), ai("b")];
    expect(messagesSince(messages, 2)).toEqual([]);
    expect(messagesSince(messages, 9)).toEqual([]);
    expect(messagesSince(messages, -3)).toEqual(messages);
  });
});

describe("lastTurn", () => {
  it("starts at the last thing the session was told", () => {
    const messages = [human("a"), ai("b"), tool("t"), human("c"), ai("d"), tool("t2"), ai("e")];
    expect(lastTurn(messages)).toEqual([human("c"), ai("d"), tool("t2"), ai("e")]);
  });

  it("includes an adjacent run of turn-opening messages: a delivered event plus the person's message", () => {
    const note = runtimeNote("event", "[event] arrived");
    const messages = [human("a"), ai("b"), ...note, human("It's ORD-1."), ai("shipped")];
    expect(lastTurn(messages)).toEqual([...note, human("It's ORD-1."), ai("shipped")]);
    expect(note.every(opensTurn)).toBe(true);
  });

  it("treats a runtime note as an opener, exactly as a person's message", () => {
    const note = runtimeNote("decision", "[decision] approve");
    const messages = [human("a"), ai("b"), ...note, ai("continuing")];
    expect(lastTurn(messages)).toEqual([...note, ai("continuing")]);
    expect(lastTurn([humanNote("opening", "Begin."), ai("ok")])).toHaveLength(2);
  });

  it("is empty when nothing opened a turn", () => {
    expect(lastTurn([])).toEqual([]);
    expect(lastTurn([ai("unprompted")])).toEqual([]);
  });
});

describe("lastAgentText", () => {
  it("skips a runtime note even when it carries assistant-role text", () => {
    const [call] = runtimeNote("after", "[after] revise");
    const marked = { ...(call as object), content: "narration" };
    expect(lastAgentText([human("a"), ai("real"), marked])).toBe("real");
    expect(lastAgentText([human("a"), marked])).toBe("");
  });
});
