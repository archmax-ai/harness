import { describe, expect, it } from "vitest";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { runtimeNote } from "../core/messages.js";
import { queryToolCalls, sessionToolCalls, toolCallQuery } from "./tool-calls.js";

const ask = (id: string, name: string, args: Record<string, unknown> = {}) =>
  new AIMessage({ content: "", tool_calls: [{ id, name, args }] });
const answer = (id: string, name: string, content: string, extra: Record<string, unknown> = {}) =>
  new ToolMessage({ tool_call_id: id, name, content, ...extra });

// Visit 1 (a): lookup 1 and a variable read. Visit 2 (b): lookup 2, refused, and a pending search.
const messages = [
  ask("c1", "lookup", { id: "1" }),
  answer("c1", "lookup", '{"status":"pending"}'),
  ask("c2", "archmax_get_variables"),
  answer("c2", "archmax_get_variables", "{}"),
  ...runtimeNote("event", "[event] something arrived"),
  ask("c3", "lookup", { id: "2" }),
  answer("c3", "lookup", "refused", { status: "error", additional_kwargs: { governance_blocked: true } }),
  ask("c4", "search", { q: "x" }),
];
const visits = [
  { number: 1, state: "a", start: 0 },
  { number: 2, state: "b", start: 4 },
];

describe("queryToolCalls", () => {
  it("returns every domain call with its result, state and visit, and no control call or note", () => {
    expect(queryToolCalls(messages, visits)).toEqual([
      { id: "c1", name: "lookup", args: { id: "1" }, result: { status: "pending" }, status: "completed", state: "a", visit: 1 },
      { id: "c3", name: "lookup", args: { id: "2" }, result: "refused", status: "rejected", state: "b", visit: 2 },
      { id: "c4", name: "search", args: { q: "x" }, status: "pending", state: "b", visit: 2 },
    ]);
  });

  it("narrows by every filter key", () => {
    const ids = (filter: Parameters<typeof queryToolCalls>[2]) => queryToolCalls(messages, visits, filter).map((r) => r.id);
    expect(ids({ name: "lookup" })).toEqual(["c1", "c3"]);
    expect(ids({ state: "a" })).toEqual(["c1"]);
    expect(ids({ visit: 1 })).toEqual(["c1"]);
    expect(ids({ visit: 2 })).toEqual(["c3", "c4"]);
    expect(ids({ status: "rejected" })).toEqual(["c3"]);
    expect(ids({ last: 1 })).toEqual(["c4"]);
    expect(ids({ name: "lookup", last: 1 })).toEqual(["c3"]);
  });

  it("attributes a call to the visit of the message that made it, not where its result landed", () => {
    // An advance in the same message as the lookup: the next visit starts after that message.
    const batch = [
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "l", name: "lookup", args: {} },
          { id: "adv", name: "archmax_advance", args: { to: "b" } },
        ],
      }),
      answer("adv", "archmax_advance", "Advanced to state 'b'."),
      answer("l", "lookup", "{}"),
    ];
    const spans = [
      { number: 1, state: "a", start: 0 },
      { number: 2, state: "b", start: 1 },
    ];
    expect(queryToolCalls(batch, spans)).toMatchObject([{ id: "l", state: "a", visit: 1 }]);
  });

  it("reads a session's visits from its checkpointed state", () => {
    const state = { messages, entryState: "a", visits: [{ state: "b", from: { count: 4 } }] };
    expect(sessionToolCalls(state, { state: "b" }).map((r) => r.id)).toEqual(["c3", "c4"]);
  });
});

describe("toolCallQuery", () => {
  it("answers a filter as JSON and refuses an unknown key", async () => {
    const query = toolCallQuery({ messages, entryState: "a" });
    expect(JSON.parse(String(await query.invoke({ status: "pending" })))).toMatchObject([{ id: "c4" }]);
    await expect(query.invoke({ visits: 1 })).rejects.toThrow();
  });
});
