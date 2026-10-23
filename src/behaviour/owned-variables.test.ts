/**
 * A state may own variables (`locks:`): only it may write them, so a value
 * changes by going back there, where its rules apply again, and every later
 * guard reads the new value on the way forward. A reset releases the locks the
 * agent set, and never the host's.
 */
import { tool } from "langchain";
import type { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { advanceTo, assemble, cleanupWorkspaces, toolResults, workspaceWith, type ScriptedTurn } from "./support.js";

afterEach(cleanupWorkspaces);

const RUNTIME = { engine: "archmax-harness", version: "2" };
const set = (variables: Record<string, unknown>, lock?: boolean): ScriptedTurn => ({
  tool: "archmax_set_variables",
  args: { variables, ...(lock ? { lock } : {}) },
});

describe("a variable a state owns", () => {
  it("changes only by going back to its owner, and the guard then admits the new value", async () => {
    const cancelled: string[] = [];
    const cancel = tool(
      async ({ order_id }: { order_id: string }) => {
        cancelled.push(order_id);
        return `cancelled ${order_id}`;
      },
      { name: "cancel_order", description: "Cancel an order.", schema: z.object({ order_id: z.string() }) },
    ) as unknown as StructuredTool;
    const spec = {
      runtime: RUNTIME,
      states: {
        lookup: { triggers: { manual: null }, locks: ["order_id"], transitions: [{ to: "act", description: "Found." }] },
        act: {
          tools: { allow: [{ tool: "cancel_order", args: { order_id: ["${{order_id}}"] } }] },
          transitions: [{ to: "lookup", description: "The person means a different order." }],
        },
      },
    };
    const { agent } = await assemble(workspaceWith(spec), {
      turns: [
        set({ order_id: "1" }),
        advanceTo("act"),
        { reply: "Cancel order 1?" },
        // The person corrects the order: a write here is refused, so the agent goes back.
        set({ order_id: "2" }),
        advanceTo("lookup"),
        set({ order_id: "2" }),
        advanceTo("act"),
        { tool: "cancel_order", args: { order_id: "2" } },
        { reply: "Order 2 is cancelled." },
      ],
      params: { tools: [cancel] },
    });
    await agent.workflow.send("s1", { message: "cancel my order" });
    const outcome = await agent.workflow.send("s1", { message: "actually, order 2" });

    const writes = toolResults(outcome.messages).filter((r) => r.name === "archmax_set_variables");
    expect(writes.map((r) => r.content)).toEqual([
      "Set order_id.",
      expect.stringContaining("'order_id' belongs to state 'lookup'"),
      "Set order_id.",
    ]);
    expect(cancelled).toEqual(["2"]);
    expect(outcome).toMatchObject({ kind: "completed", variables: { order_id: { value: "2", locked: false } } });
  });
});

describe("a reset", () => {
  it("releases a lock the agent set, so the restarted run can write it again", async () => {
    const spec = { runtime: RUNTIME, states: { start: { triggers: { manual: null } } } };
    const { agent } = await assemble(workspaceWith(spec), {
      turns: [
        set({ case_id: "K-1" }, true),
        set({ case_id: "K-2" }),
        { tool: "archmax_reset", args: { reason: "start over" } },
        set({ case_id: "K-2" }),
        { reply: "done" },
      ],
      params: { variables: { region: "eu" } },
    });
    const outcome = await agent.workflow.send("s1", { message: "go" });
    const writes = toolResults(outcome.messages).filter((r) => r.name === "archmax_set_variables");
    expect(writes.map((r) => String(r.content))).toEqual([
      "Set case_id (locked).",
      expect.stringContaining("'case_id' is locked"),
      "Set case_id.",
    ]);
    expect(outcome.variables).toMatchObject({ case_id: { value: "K-2", locked: false }, region: { value: "eu", locked: true } });
  });
});
