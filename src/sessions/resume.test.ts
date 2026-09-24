import { describe, expect, it } from "vitest";
import { WORKFLOW_STATUSES } from "../workflow/state.js";
import { InvalidDecisionTargetError, SessionNotParkedError } from "./resume.js";
import {
  decide,
  EmptyMessageError,
  reply,
  type IntrospectableStateGraph,
} from "./resume.js";

/** A stub graph whose `getState`/`invoke` return scripted values. */
function stubGraph(opts: {
  state?: Record<string, unknown>;
  interrupts?: boolean;
  onInvoke?: (input: unknown) => Record<string, unknown>;
}): IntrospectableStateGraph & { invoked: unknown[] } {
  const invoked: unknown[] = [];
  return {
    invoked,
    async getState() {
      return {
        values: opts.state ?? {},
        tasks: opts.interrupts === false ? [] : [{ interrupts: [{}] }],
      };
    },
    async invoke(input: unknown) {
      invoked.push(input);
      return opts.onInvoke?.(input) ?? {};
    },
  };
}

const PARKED_STATE = {
  status: WORKFLOW_STATUSES.awaitingDecision,
  pendingDecision: { state: "review", transitions: [{ to: "approve", description: "Test edge to approve." }, { to: "reject", description: "Test edge to reject." }] },
};

describe("decide", () => {
  it("throws when the session is not awaiting a decision", async () => {
    const graph = stubGraph({ state: { status: WORKFLOW_STATUSES.running } });
    await expect(decide(graph, "t1", { target: "approve" })).rejects.toBeInstanceOf(
      SessionNotParkedError,
    );
  });

  it("throws when parked status is set but no interrupt is pending", async () => {
    const graph = stubGraph({ state: PARKED_STATE, interrupts: false });
    await expect(decide(graph, "t1", { target: "approve" })).rejects.toBeInstanceOf(
      SessionNotParkedError,
    );
  });

  it("rejects a target that is not a declared transition", async () => {
    const graph = stubGraph({ state: PARKED_STATE });
    await expect(decide(graph, "t1", { target: "nowhere" })).rejects.toBeInstanceOf(
      InvalidDecisionTargetError,
    );
  });

  it("resumes and reports a completed decision", async () => {
    const graph = stubGraph({
      state: PARKED_STATE,
      onInvoke: () => ({
        status: WORKFLOW_STATUSES.completed,
        workflowState: "approve",
        messages: [{ role: "assistant", content: "done" }],
      }),
    });
    const outcome = await decide(graph, "t1", { target: "approve", comment: "ok" });
    expect(graph.invoked).toHaveLength(1);
    expect(outcome.reparked).toBe(false);
    expect(outcome.status).toBe(WORKFLOW_STATUSES.completed);
    expect(outcome.workflowState).toBe("approve");
    expect(outcome.messages).toHaveLength(1);
  });

  it("reports a re-park when the resume lands at another human node", async () => {
    const graph = stubGraph({
      state: PARKED_STATE,
      onInvoke: () => ({
        status: WORKFLOW_STATUSES.awaitingDecision,
        pendingDecision: { state: "second-review", transitions: [] },
        messages: [],
      }),
    });
    const outcome = await decide(graph, "t1", { target: "approve" });
    expect(outcome.reparked).toBe(true);
    expect(outcome.state).toBe("second-review");
  });
});

describe("reply", () => {
  it("throws when the session is not awaiting a decision", async () => {
    const graph = stubGraph({ state: { status: WORKFLOW_STATUSES.running } });
    await expect(reply(graph, "t1", "any news?")).rejects.toBeInstanceOf(SessionNotParkedError);
  });

  it("rejects an empty message before the graph is touched", async () => {
    const graph = stubGraph({ state: PARKED_STATE });
    await expect(reply(graph, "t1", "   ")).rejects.toBeInstanceOf(EmptyMessageError);
    expect(graph.invoked).toHaveLength(0);
  });

  it("returns the run's reply and the unchanged park", async () => {
    const graph = stubGraph({
      state: PARKED_STATE,
      onInvoke: () => ({
        status: WORKFLOW_STATUSES.awaitingDecision,
        pendingDecision: { state: "review", transitions: [{ to: "approve", description: "Test edge to approve." }] },
        messages: [
          { role: "human", content: "any news?" },
          { role: "assistant", content: "It is with a reviewer." },
        ],
      }),
    });

    const outcome = await reply(graph, "t1", "any news?");

    expect(outcome.reply).toBe("It is with a reviewer.");
    expect(outcome.state).toBe("review");
    expect(outcome.reparked).toBe(true);
    expect(outcome.status).toBe(WORKFLOW_STATUSES.awaitingDecision);
  });

  it("resumes with the trimmed message and nothing else", async () => {
    const graph = stubGraph({ state: PARKED_STATE, onInvoke: () => ({ messages: [] }) });
    await reply(graph, "t1", "  any news?  ");
    // A message resume carries no target: nothing here can select an edge.
    expect(JSON.stringify(graph.invoked[0])).toContain("any news?");
    expect(JSON.stringify(graph.invoked[0])).not.toContain("target");
  });

  it("reports the node it was parked at when the resume returns no record", async () => {
    const graph = stubGraph({ state: PARKED_STATE, onInvoke: () => ({ messages: [] }) });
    expect((await reply(graph, "t1", "hello")).state).toBe("review");
  });
});

describe("decide — the node itself is never a target", () => {
  // A human node routes the run *out*; the graph ends a run it cannot route,
  // so a self-targeted edge offered as a button silently completed the run.
  const SELF_LOOP = {
    status: WORKFLOW_STATUSES.awaitingDecision,
    pendingDecision: {
      state: "review",
      transitions: [{ to: "done", description: "Test edge to done." }, { to: "review", description: "Test edge to review." }],
    },
  };

  it("refuses a decision naming the parked node", async () => {
    const graph = stubGraph({ state: SELF_LOOP });
    await expect(decide(graph, "t1", { target: "review" })).rejects.toBeInstanceOf(
      InvalidDecisionTargetError,
    );
    // Refused before the graph is touched: the park is exactly as it was.
    expect(graph.invoked).toHaveLength(0);
  });

  it("offers only the targets that lead somewhere", async () => {
    const graph = stubGraph({ state: SELF_LOOP });
    await expect(decide(graph, "t1", { target: "review" })).rejects.toMatchObject({
      validTargets: ["done"],
    });
  });

  it("still routes a declared target that leaves the node", async () => {
    const graph = stubGraph({ state: SELF_LOOP, onInvoke: () => ({ status: "completed" }) });
    await expect(decide(graph, "t1", { target: "done" })).resolves.toMatchObject({
      status: "completed",
    });
  });
});

describe("decide — which channel the run re-parked on", () => {
  // A decision routes into whatever the author declared, and that can be a
  // state that then waits for an event. Reported only for the decision channel,
  // such a park rendered as a finished run — and the caller was never told which
  // resume verb applied.
  it("reports a re-park at another human node as the decision channel", async () => {
    const graph = stubGraph({
      state: PARKED_STATE,
      onInvoke: () => ({
        status: WORKFLOW_STATUSES.awaitingDecision,
        pendingDecision: { state: "second-review", transitions: [] },
      }),
    });
    await expect(decide(graph, "t1", { target: "approve" })).resolves.toMatchObject({
      reparked: true,
      parkedChannel: "decision",
      state: "second-review",
    });
  });

  it("reports a run that waited for an event as the input channel", async () => {
    const graph = stubGraph({
      state: PARKED_STATE,
      onInvoke: () => ({
        status: WORKFLOW_STATUSES.awaitingInput,
        pendingInput: { state: "notify-customer", reason: "their reply" },
      }),
    });
    await expect(decide(graph, "t1", { target: "approve" })).resolves.toMatchObject({
      reparked: true,
      parkedChannel: "input",
      state: "notify-customer",
    });
  });

  it("reports a run that finished as not re-parked", async () => {
    const graph = stubGraph({
      state: PARKED_STATE,
      onInvoke: () => ({ status: WORKFLOW_STATUSES.completed, workflowState: "done" }),
    });
    const outcome = await decide(graph, "t1", { target: "approve" });
    expect(outcome.reparked).toBe(false);
    // Absent rather than set to a channel: nothing is parked to have one.
    expect(outcome).not.toHaveProperty("parkedChannel");
    expect(outcome).not.toHaveProperty("state");
  });

  it("names the decision channel on a message, which never routes", async () => {
    const graph = stubGraph({
      state: PARKED_STATE,
      onInvoke: () => ({
        status: WORKFLOW_STATUSES.awaitingDecision,
        pendingDecision: { state: "review", transitions: [] },
      }),
    });
    await expect(reply(graph, "t1", "any update?")).resolves.toMatchObject({
      reparked: true,
      parkedChannel: "decision",
      state: "review",
    });
  });
});
