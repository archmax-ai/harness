import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { runtimeNote } from "../core/messages.js";
import { historyMessages, sessionHistory } from "./history.js";

describe("historyMessages", () => {
  it("renders every message as plain data, oldest first, with nothing windowed", () => {
    const messages = [
      new SystemMessage("system text"),
      new HumanMessage("where is ORD-1?"),
      new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "read_file", args: { file_path: "a.json" } }] }),
      new ToolMessage({ content: "{}", tool_call_id: "c1", name: "read_file" }),
      ...Array.from({ length: 40 }, (_, i) => new AIMessage(`reply ${i}`)),
    ];
    const history = historyMessages(messages);

    expect(history).toHaveLength(44);
    expect(history[0]).toEqual({ role: "system", text: "system text" });
    expect(history[1]).toEqual({ role: "user", text: "where is ORD-1?" });
    expect(history[2]).toEqual({
      role: "assistant",
      text: "",
      toolCalls: [{ id: "c1", name: "read_file", args: { file_path: "a.json" } }],
    });
    expect(history[3]).toEqual({ role: "tool", text: "", tool: "read_file", id: "c1" });
    expect(history.at(-1)).toEqual({ role: "assistant", text: "reply 39" });
  });

  it("keeps a runtime note as one runtime entry naming its kind, never as a person speaking", () => {
    const history = historyMessages([
      new HumanMessage("refund please"),
      ...runtimeNote("decision", "[decision] A human selected 'approve'."),
    ]);
    expect(history).toEqual([
      { role: "user", text: "refund please" },
      { role: "runtime", text: "[decision] A human selected 'approve'.", note: "decision" },
    ]);
  });
});

describe("sessionHistory", () => {
  it("pairs the transcript with the committed trail and the tool calls with their results", () => {
    const trail = [
      { to: "answer", kind: "trigger" as const, reason: "manual", ts: 1 },
      { to: "review", kind: "agent" as const, reason: "replied", ts: 2 },
    ];
    const history = sessionHistory({
      messages: [
        new HumanMessage("hi"),
        new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "lookup", args: { id: "1" } }] }),
        new ToolMessage({ content: '{"ok":true}', tool_call_id: "c1", name: "lookup" }),
      ],
      entryState: "answer",
      auditTrail: trail,
    });
    expect(history.messages[0]).toEqual({ role: "user", text: "hi" });
    expect(history.trail).toEqual(trail);
    expect(history.toolCalls).toEqual([
      { id: "c1", name: "lookup", args: { id: "1" }, result: { ok: true }, status: "completed", state: "answer", visit: 1 },
    ]);
  });

  it("is empty for a session with nothing in it", () => {
    expect(sessionHistory({})).toEqual({ messages: [], trail: [], toolCalls: [] });
  });
});
