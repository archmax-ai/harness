import { describe, expect, it } from "vitest";
import { AIMessage, ChatMessageChunk, HumanMessage } from "@langchain/core/messages";
import { asDecisionGraph, asModelCallResult, asStructuredTools } from "./deepagents.js";

describe("framework adapter", () => {
  it("asDecisionGraph exposes getState/invoke for the resume path", async () => {
    const calls: string[] = [];
    const graph = {
      getState: async () => {
        calls.push("getState");
        return { values: { status: "awaiting_decision" }, tasks: [] };
      },
      invoke: async () => {
        calls.push("invoke");
        return { status: "completed" };
      },
    };
    const decision = asDecisionGraph(graph);
    const snapshot = await decision.getState({ configurable: {} });
    const result = await decision.invoke({}, { configurable: {} });
    expect(snapshot.values?.status).toBe("awaiting_decision");
    expect(result.status).toBe("completed");
    expect(calls).toEqual(["getState", "invoke"]);
  });

  it("asStructuredTools returns an array (empty for undefined)", () => {
    expect(asStructuredTools(undefined)).toEqual([]);
    const tools = [{ name: "read_file" }] as never;
    expect(asStructuredTools(tools)).toHaveLength(1);
  });
});

describe("asModelCallResult", () => {
  it("passes an AIMessage through untouched", () => {
    const message = new AIMessage({ content: "done" });
    expect(asModelCallResult(message, "state 'x'")).toBe(message);
  });

  it("rebuilds an assistant message that arrived as a plain object", () => {
    // An `AIMessage` from a second copy of `@langchain/core`, or a provider's
    // `{ role: "assistant" }` dict: a message in all but class identity.
    const toolCalls = [{ name: "read_file", args: { file_path: "/a" }, id: "call-1" }];
    const typed = asModelCallResult(
      { type: "ai", content: "here", tool_calls: toolCalls, id: "msg-1" },
      "state 'x'",
    ) as AIMessage;
    expect(AIMessage.isInstance(typed)).toBe(true);
    expect(typed.tool_calls).toEqual(toolCalls);
    expect(typed.id).toBe("msg-1");

    const dict = asModelCallResult({ role: "assistant", content: "hi" }, "state 'x'") as AIMessage;
    expect(AIMessage.isInstance(dict)).toBe(true);
    expect(dict.content).toBe("hi");
  });

  it("refuses a generic message: role-less responses are repaired at the provider seam", () => {
    // `createChatModel` (env.ts) reads a response naming no role as the
    // assistant's before it reaches the agent loop; one that still arrives here
    // generic is a model this runtime did not build, and is reported as such.
    expect(() =>
      asModelCallResult(
        new ChatMessageChunk({ content: "hello", role: undefined as unknown as string }),
        "state 'x'",
      ),
    ).toThrow(/type 'generic', ChatMessageChunk/);
  });

  it("refuses a message that is some other turn, naming its type and class", () => {
    expect(() => asModelCallResult(new HumanMessage({ content: "hi" }), "state 'x'")).toThrow(
      /type 'human', HumanMessage/,
    );
  });

  it("refuses a value that is not message-shaped at all, naming the model", () => {
    expect(() => asModelCallResult({ choices: [], usage: {} }, "state 'x'")).toThrow(
      /model call in 'state 'x'' returned a plain object with keys \[choices, usage\]/,
    );
  });
});
