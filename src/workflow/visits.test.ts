import { describe, expect, it } from "vitest";
import { foldVisits } from "./state.js";
import { currentVisitMessages, visitAt, visitSpans, visitStart } from "./visits.js";

const msg = (id: string) => ({ id, type: "human", content: id });

describe("visitSpans", () => {
  it("places each visit after the message its anchor names", () => {
    const messages = [msg("a"), msg("b"), msg("c"), msg("d")];
    const state = { visits: [visitStart("one", [])[0], visitStart("two", messages.slice(0, 2))[0]] };
    expect(visitSpans(messages, state)).toEqual([
      { number: 1, state: "one", start: 0 },
      { number: 2, state: "two", start: 2 },
    ]);
    expect(currentVisitMessages(messages, state)).toEqual([msg("c"), msg("d")]);
  });

  it("falls back to the count when the anchored message is gone", () => {
    const messages = [msg("a"), msg("c"), msg("d")];
    const state = { visits: [{ state: "one", from: { count: 0 } }, { state: "two", from: { id: "b", count: 2 } }] };
    expect(visitSpans(messages, state)[1]).toEqual({ number: 2, state: "two", start: 2 });
  });

  it("reads a session with no log as one visit at its entry state", () => {
    const messages = [msg("a"), msg("b")];
    expect(visitSpans(messages, { entryState: "start", workflowState: "later" })).toEqual([
      { number: 1, state: "start", start: 0 },
    ]);
    expect(currentVisitMessages(messages, {})).toEqual(messages);
  });

  it("numbers what precedes the first logged visit as visit 1", () => {
    const messages = [msg("a"), msg("b"), msg("c")];
    const state = { entryState: "start", visits: visitStart("next", messages.slice(0, 2)) };
    expect(visitSpans(messages, state)).toEqual([
      { number: 1, state: "start", start: 0 },
      { number: 2, state: "next", start: 2 },
    ]);
  });
});

describe("visitAt", () => {
  it("finds the visit holding a message", () => {
    const spans = [
      { number: 1, state: "a", start: 0 },
      { number: 2, state: "b", start: 3 },
    ];
    expect(visitAt(spans, 2).number).toBe(1);
    expect(visitAt(spans, 3).number).toBe(2);
  });
});

describe("foldVisits", () => {
  it("appends a writer's visit and ignores the whole-state echo", () => {
    const one = visitStart("a", [])[0]!;
    const two = visitStart("b", [msg("x")])[0]!;
    const held = foldVisits([one], [two]);
    expect(held).toEqual([one, two]);
    expect(foldVisits(held, [...held])).toBe(held);
  });
});
