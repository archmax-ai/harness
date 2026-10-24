/**
 * What the agent tells the person as it moves on, waits or fails travels in the
 * control call's `message`: handing work on is one tool call, never text beside
 * one. The person reads it as the turn's reply; a park it already announced owes
 * no closing message.
 */
import { afterEach, describe, expect, it } from "vitest";
import { assemble, cleanupWorkspaces, eventsOf, freshSessionId, workspaceWith } from "./support.js";

afterEach(cleanupWorkspaces);

const RUNTIME = { engine: "archmax-harness", version: "3" };

const spec = {
  runtime: RUNTIME,
  states: {
    draft: {
      triggers: { manual: null },
      transitions: [
        { to: "review", description: "The refund decision is recorded." },
        { to: "work", description: "More work is needed first." },
      ],
    },
    work: { transitions: [{ to: "done", description: "The work is done." }] },
    review: { type: "human", transitions: [{ to: "done", type: "approve", description: "Approve the refund." }] },
    done: {},
  },
};

describe("a control call's message", () => {
  it("is the reply of a turn that parks at a human state, with no closing message to write", async () => {
    const { agent, model, events } = await assemble(workspaceWith(spec), {
      turns: [
        {
          tool: "archmax_advance",
          args: { to: "review", reason: "decided", message: "Your refund for ORD-1001 is with a reviewer." },
        },
      ],
    });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "refund ORD-1001" });

    expect(outcome).toMatchObject({ kind: "parked", state: "review", reply: "Your refund for ORD-1001 is with a reviewer." });
    // The agent already told the person: no reply-only call follows the move.
    expect(model.calls).toHaveLength(1);
    expect(eventsOf(events, "agent-text").map((event) => event.text)).toEqual([
      "Your refund for ORD-1001 is with a reviewer.",
    ]);
  });

  it("joins the turn's reply when the session moves on and keeps working", async () => {
    const { agent } = await assemble(workspaceWith(spec), {
      turns: [
        { tool: "archmax_advance", args: { to: "work", reason: "more to do", message: "Looking into it." } },
        { tool: "archmax_advance", args: { to: "done", reason: "done" } },
        { reply: "All done." },
      ],
    });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "go" });

    expect(outcome).toMatchObject({ kind: "completed", reply: "Looking into it.\n\nAll done." });
  });

  it("is what the person reads when the session ends failed", async () => {
    const { agent } = await assemble(workspaceWith(spec), {
      turns: [
        {
          tool: "archmax_raise",
          args: { code: "orders-unavailable", reason: "the store is down", message: "I can't reach the order records." },
        },
      ],
    });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "refund ORD-1001" });

    expect(outcome).toMatchObject({ kind: "failed", reply: "I can't reach the order records." });
  });

  it("is not said when the call is refused", async () => {
    const { agent } = await assemble(workspaceWith(spec), {
      turns: [
        { tool: "archmax_advance", args: { to: "nowhere", reason: "wrong", message: "Moving on." } },
        { tool: "archmax_advance", args: { to: "work", reason: "right", message: "Moving on, for real." } },
        { tool: "archmax_advance", args: { to: "done", reason: "done" } },
        { reply: "Finished." },
      ],
    });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "go" });

    expect(outcome.reply).toBe("Moving on, for real.\n\nFinished.");
  });
});
