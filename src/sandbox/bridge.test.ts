import { describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import type { StructuredTool } from "@langchain/core/tools";
import { Command } from "@langchain/langgraph";
import {
  createWorkflowEventEmitter,
  type WorkflowLifecycleEvent,
} from "../core/events.js";
import { createSubagentBridgeDispatch, unwrapToolEnvelope } from "./bridge.js";

describe("unwrapToolEnvelope", () => {
  it("returns plain strings unchanged", () => {
    expect(unwrapToolEnvelope("hello")).toBe("hello");
  });

  it("extracts content from a BaseMessage", () => {
    expect(unwrapToolEnvelope(new AIMessage({ content: "answer" }))).toBe("answer");
  });

  it("extracts the last message content from a Command update", () => {
    const cmd = new Command({ update: { messages: [new AIMessage({ content: "final" })] } });
    expect(unwrapToolEnvelope(cmd)).toBe("final");
  });

  it("walks arrays to the last message", () => {
    expect(unwrapToolEnvelope([new AIMessage({ content: "a" }), new AIMessage({ content: "b" })])).toBe("b");
  });
});

describe("createSubagentBridgeDispatch telemetry", () => {
  function fakeTaskTool(impl: () => Promise<unknown>): StructuredTool {
    return { name: "task", invoke: impl } as unknown as StructuredTool;
  }

  function collect() {
    const events: WorkflowLifecycleEvent[] = [];
    return { events, emit: createWorkflowEventEmitter((e) => events.push(e)) };
  }

  it("brackets a dispatch with rubric-start/result", async () => {
    const { events, emit } = collect();
    const dispatch = createSubagentBridgeDispatch(
      fakeTaskTool(async () => "verdict"),
      {},
      { emit, state: "review" },
    );

    const result = await dispatch({ description: "judge", subagentType: "quality-judge" });

    expect(result).toBe("verdict");
    const start = events.find((e) => e.type === "rubric-start");
    const settled = events.find((e) => e.type === "rubric-result");
    expect(start).toMatchObject({ state: "review", name: "quality-judge" });
    expect(settled).toMatchObject({ state: "review", name: "quality-judge", status: "ok" });
    expect(
      start?.type === "rubric-start" &&
        settled?.type === "rubric-result" &&
        start.dispatchId === settled.dispatchId,
    ).toBe(true);
    expect(events.indexOf(start!)).toBeLessThan(events.indexOf(settled!));
  });

  it("reports an error result and rethrows when the dispatch fails", async () => {
    const { events, emit } = collect();
    const dispatch = createSubagentBridgeDispatch(
      fakeTaskTool(async () => {
        throw new Error("judge unavailable");
      }),
      {},
      { emit, state: "review" },
    );

    await expect(dispatch({ description: "judge", subagentType: "quality-judge" })).rejects.toThrow(
      "judge unavailable",
    );
    expect(events.find((e) => e.type === "rubric-result")).toMatchObject({ status: "error" });
  });

  it("dispatches silently without telemetry", async () => {
    const dispatch = createSubagentBridgeDispatch(
      fakeTaskTool(async () => "ok"),
      {},
    );
    await expect(dispatch({ description: "d", subagentType: "s" })).resolves.toBe("ok");
  });
});
