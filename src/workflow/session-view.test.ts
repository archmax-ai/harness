import { describe, expect, it } from "vitest";
import { runtimeNote } from "../core/messages.js";
import { messagesToSessionView } from "./session-view.js";

function ai(content: string, toolCalls?: Array<{ name: string; args?: unknown; id?: string }>) {
  return { type: "ai", content, tool_calls: toolCalls };
}

function tool(
  name: string,
  content: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: "tool", name, content, ...extra };
}

describe("messagesToSessionView", () => {
  it("uses the last ai message text as the reply", () => {
    const view = messagesToSessionView([
      { type: "human", content: "hi" },
      ai("first draft"),
      ai("final answer"),
    ]);
    expect(view.reply).toBe("final answer");
    expect(view.failed).toBe(false);
    expect(view.parked).toBe(false);
    expect(view.sessionId).toBe("default");
  });

  it("defaults to an empty audit trail when the caller supplies none", () => {
    const view = messagesToSessionView([ai("answer")]);
    expect(view.auditTrail).toEqual([]);
  });

  it("carries the explicitly supplied audit trail", () => {
    const steps = [
      { to: "first", kind: "trigger" as const, ts: 1 },
      { to: "done", kind: "agent" as const, reason: "complete", ts: 2 },
    ];
    const view = messagesToSessionView([ai("answer")], "s1", steps);
    expect(view.auditTrail).toEqual(steps);
  });

  it("pushes a pending fact and a tool.called event per tool_calls entry", () => {
    const view = messagesToSessionView([
      ai("", [
        { name: "read_file", args: { path: "/data/orders.json" } },
        { name: "archmax_run", args: { file: "check.js" } },
      ]),
    ]);
    expect(view.toolCalls).toEqual([
      { name: "read_file", input: { path: "/data/orders.json" }, status: "pending" },
      { name: "archmax_run", input: { file: "check.js" }, status: "pending" },
    ]);
    const called = view.events.filter((e) => e.type === "tool.called");
    expect(called).toEqual([
      { type: "tool.called", data: { name: "read_file", input: { path: "/data/orders.json" } } },
      { type: "tool.called", data: { name: "archmax_run", input: { file: "check.js" } } },
    ]);
  });

  it("marks a governance-blocked tool result as rejected without failing the run", () => {
    const view = messagesToSessionView([
      ai("", [{ name: "write_file", args: { path: "/output/x" } }]),
      tool("write_file", "blocked by policy", {
        status: "error",
        additional_kwargs: { governance_blocked: true },
      }),
    ]);
    expect(view.toolCalls[0]?.status).toBe("rejected");
    expect(view.failed).toBe(false);
  });

  it("marks a non-blocked error result as failed and flips the run failed flag", () => {
    const view = messagesToSessionView([
      ai("", [{ name: "read_file", args: {} }]),
      tool("read_file", "ENOENT", { status: "error" }),
    ]);
    expect(view.toolCalls[0]?.status).toBe("failed");
    expect(view.failed).toBe(true);
  });

  it("matches a tool result to the first pending fact of the same name", () => {
    const view = messagesToSessionView([
      ai("", [{ name: "read_file", args: { n: 1 } }, { name: "read_file", args: { n: 2 } }]),
      tool("read_file", "first result"),
      tool("read_file", "second result"),
    ]);
    expect(view.toolCalls).toEqual([
      { name: "read_file", input: { n: 1 }, output: "first result", status: "completed" },
      { name: "read_file", input: { n: 2 }, output: "second result", status: "completed" },
    ]);
  });

  it("matches tool results by tool_call_id when present, even out of order", () => {
    const view = messagesToSessionView([
      ai("", [
        { name: "read_file", args: { n: 1 }, id: "call_1" },
        { name: "read_file", args: { n: 2 }, id: "call_2" },
      ]),
      tool("read_file", "second result", { tool_call_id: "call_2" }),
      tool("read_file", "first result", { tool_call_id: "call_1" }),
    ]);
    expect(view.toolCalls).toEqual([
      {
        name: "read_file",
        id: "call_1",
        input: { n: 1 },
        output: "first result",
        status: "completed",
      },
      {
        name: "read_file",
        id: "call_2",
        input: { n: 2 },
        output: "second result",
        status: "completed",
      },
    ]);
  });

  it("parses JSON string tool content into an object", () => {
    const view = messagesToSessionView([
      ai("", [{ name: "lookup", args: {} }]),
      tool("lookup", '{"ok":true,"count":2}'),
    ]);
    expect(view.toolCalls[0]?.output).toEqual({ ok: true, count: 2 });
  });

  it("returns non-JSON string tool content as-is", () => {
    const view = messagesToSessionView([
      ai("", [{ name: "lookup", args: {} }]),
      tool("lookup", "plain text output"),
    ]);
    expect(view.toolCalls[0]?.output).toBe("plain text output");
  });

  it("surfaces a runtime note as a runtime.note event and never as a tool call", () => {
    const view = messagesToSessionView([
      { type: "human", content: "go" },
      ...runtimeNote("decision", "[decision] A human selected approve → 'approved'."),
      ai("Approved and closed."),
    ]);
    expect(view.toolCalls).toEqual([]);
    expect(view.events).toEqual([
      {
        type: "runtime.note",
        data: { kind: "decision", text: "[decision] A human selected approve → 'approved'." },
      },
      { type: "message.completed", data: { message: "Approved and closed." } },
    ]);
    expect(view.reply).toBe("Approved and closed.");
  });

  it("skips non-message entries", () => {
    const view = messagesToSessionView([null, 42, "string", { noContentKey: true }, ai("hello")]);
    expect(view.reply).toBe("hello");
    expect(view.events).toEqual([{ type: "message.completed", data: { message: "hello" } }]);
  });

  it("yields an empty view for empty or non-array input", () => {
    const empty = messagesToSessionView([]);
    expect(empty).toEqual({
      sessionId: "default",
      reply: "",
      failed: false,
      parked: false,
      events: [],
      toolCalls: [],
      auditTrail: [],
      variables: {},
    });
    expect(messagesToSessionView(undefined as unknown as unknown[], "s1")).toEqual({
      sessionId: "s1",
      reply: "",
      failed: false,
      parked: false,
      events: [],
      toolCalls: [],
      auditTrail: [],
      variables: {},
    });
  });
});
