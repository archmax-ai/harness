/**
 * The two ways a run suspends — a human node (`type: human`) and `archmax_wait` —
 * and how it is resumed: `decide`, `reply`, `deliver`, and `resolveSession`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isRuntimeNote, runtimeNoteKind, type PendingDecision, type PendingInput } from "../index.js";
import {
  advanceTo,
  assemble,
  cleanupWorkspaces,
  eventsOf,
  lastAgentText,
  messageType,
  statesEntered,
  turn,
  workspaceWith,
  type Assembled,
} from "./support.js";
import { createToolMockMiddleware } from "../testing/mock-middleware.js";

afterEach(cleanupWorkspaces);

/** work → review [human] → approved | back to work (refine). */
const REVIEW = {
  runtime: { engine: "archmax-harness", version: "2" },
  states: {
    work: {
      triggers: { manual: null },
      transitions: [{ to: "review", description: "Hand the draft to a reviewer." }],
    },
    review: {
      type: "human",
      title: "Review the draft",
      instructions: "Check the draft in scratchpad/draft.md before approving.",
      evidence: ["scratchpad/draft.md"],
      transitions: [
        { to: "approved", type: "approve", description: "The draft is fine." },
        { to: "work", type: "refine", description: "Send it back with a comment." },
      ],
    },
    approved: {},
  },
};

async function parkAtReview(): Promise<Assembled> {
  const assembled = await assemble(workspaceWith(REVIEW), {
    turns: [
      { tool: "write_file", args: { file_path: "scratchpad/draft.md", content: "# Draft" } },
      advanceTo("review", "ready for a reviewer"),
    ],
  });
  await turn(assembled.agent, "s1", "please review");
  return assembled;
}

/** The checkpointed pending records, read through the public checkpoint surface. */
async function pending(assembled: Assembled, sessionId = "s1") {
  const snapshot = (await assembled.agent.getState({ configurable: { thread_id: sessionId } })) as {
    values?: { pendingDecision?: PendingDecision | null; pendingInput?: PendingInput | null };
  };
  return snapshot.values ?? {};
}

describe("a human node", () => {
  it("parks the session awaiting a decision when the agent advances into it", async () => {
    const { agent, events } = await parkAtReview();

    expect(statesEntered(events)).toEqual(["work", "review"]);
    const parked = eventsOf(events, "parked");
    expect(parked).toMatchObject([{ state: "review", sessionId: "s1", awaiting: "decision" }]);
    expect(parked[0]?.callId).toBeUndefined();

    const summary = await agent.sessions.get("s1");
    expect(summary).toMatchObject({
      status: "awaiting_decision",
      classification: "open",
      state: "review",
      workflowState: "review",
    });
  });

  it("checkpoints a pending decision carrying the node's title, instructions-derived transitions and evidence", async () => {
    const assembled = await parkAtReview();
    const { pendingDecision } = await pending(assembled);
    expect(pendingDecision).toMatchObject({
      state: "review",
      title: "Review the draft",
      seq: 1,
      transitions: [
        { to: "approved", type: "approve", description: "The draft is fine." },
        { to: "work", type: "refine", description: "Send it back with a comment." },
      ],
      evidence: ["scratchpad/draft.md"],
    });
    expect(typeof pendingDecision?.createdAt).toBe("string");
  });

  it("presents evidence the agent attached on the advance after the declared evidence", async () => {
    const assembled = await assemble(workspaceWith(REVIEW), {
      turns: [
        { tool: "write_file", args: { file_path: "scratchpad/notes.md", content: "notes" } },
        {
          tool: "archmax_advance",
          args: { to: "review", reason: "ready", evidence: ["scratchpad/notes.md"] },
        },
      ],
    });
    await turn(assembled.agent, "s1", "go");
    const { pendingDecision } = await pending(assembled);
    expect(pendingDecision?.evidence).toEqual(["scratchpad/draft.md", "scratchpad/notes.md"]);
  });

  it("routes the approve decision to the approve target and completes the run", async () => {
    const { agent, events, model } = await parkAtReview();
    model.enqueue({ reply: "approved and closed" });

    const outcome = await agent.workflow.decide("s1", { target: "approved", comment: "looks good" });

    expect(outcome).toMatchObject({ status: "completed", workflowState: "approved", reparked: false });
    expect(outcome.reply).toBe("approved and closed");
    expect(eventsOf(events, "decided")).toMatchObject([{ state: "review", to: "approved", sessionId: "s1" }]);
    expect((await agent.sessions.get("s1"))?.status).toBe("completed");
  });

  it("records the decision in the transcript as a runtime note, not as a person's message", async () => {
    const { agent, model } = await parkAtReview();
    model.enqueue({ reply: "closing" });
    const outcome = await agent.workflow.decide("s1", { target: "approved", comment: "fine by me" });
    const notes = outcome.messages.filter(isRuntimeNote);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.map(runtimeNoteKind)).toContain("decision");
    const noteText = notes.map((m) => String((m as { content: unknown }).content)).join("\n");
    expect(noteText).toContain("fine by me");
  });

  it("routes a refine decision back to the working state, which can re-park", async () => {
    const { agent, events, model } = await parkAtReview();
    model.enqueue(
      { tool: "edit_file", args: { file_path: "scratchpad/draft.md", old_string: "Draft", new_string: "Draft v2" } },
      advanceTo("review", "revised"),
    );

    const outcome = await agent.workflow.decide("s1", { target: "work", comment: "needs a title" });

    expect(outcome.reparked).toBe(true);
    expect(outcome.state).toBe("review");
    expect(outcome.parkedChannel).toBe("decision");
    expect(eventsOf(events, "decided")).toMatchObject([{ state: "review", to: "work" }]);
    expect(statesEntered(events)).toEqual(["work", "review", "work", "review"]);
    const summary = await agent.sessions.get("s1");
    expect(summary?.status).toBe("awaiting_decision");
  });

  it("gives the second decision a higher sequence number", async () => {
    const assembled = await parkAtReview();
    assembled.model.enqueue(advanceTo("review", "revised"));
    await assembled.agent.workflow.decide("s1", { target: "work" });
    const { pendingDecision } = await pending(assembled);
    expect(pendingDecision?.seq).toBe(2);
  });

  it("refuses a decision target the parked node declares no edge to", async () => {
    const { agent } = await parkAtReview();
    await expect(agent.workflow.decide("s1", { target: "elsewhere" })).rejects.toThrow(
      /not a valid decision target/,
    );
    await expect(agent.workflow.decide("s1", { target: "elsewhere" })).rejects.toThrow(/approved, work/);
    expect((await agent.sessions.get("s1"))?.status).toBe("awaiting_decision");
  });

  it("refuses a decision for a session that is not parked", async () => {
    const { agent } = await assemble(workspaceWith(REVIEW), { turns: [{ reply: "nothing yet" }] });
    await turn(agent, "s1", "hi");
    await expect(agent.workflow.decide("s1", { target: "approved" })).rejects.toThrow(/not parked/);
  });

  it("withholds every tool from the model on a reply while parked, and answers without moving", async () => {
    const { agent, events, model } = await parkAtReview();
    model.enqueue({ reply: "It is with a reviewer right now." });

    const outcome = await agent.workflow.reply("s1", "any news?");

    expect(outcome.reply).toBe("It is with a reviewer right now.");
    expect(outcome.state).toBe("review");
    expect(outcome.parkedChannel).toBe("decision");
    expect(outcome.reparked).toBe(true);
    // The model was called once for the answer and given no tools at all.
    expect(model.calls.at(-1)?.tools).toEqual([]);
    expect(eventsOf(events, "park-message")).toMatchObject([
      { direction: "inbound", state: "review", text: "any news?" },
      { direction: "outbound", state: "review", text: "It is with a reviewer right now." },
    ]);
    expect((await agent.sessions.get("s1"))?.status).toBe("awaiting_decision");
    // Answering entered no state and moved nothing.
    expect(statesEntered(events)).toEqual(["work", "review"]);
  });

  it("keeps the pending decision intact across a reply and still routes the later decision", async () => {
    const assembled = await parkAtReview();
    assembled.model.enqueue({ reply: "still waiting" });
    await assembled.agent.workflow.reply("s1", "hello?");
    const { pendingDecision } = await pending(assembled);
    expect(pendingDecision?.seq).toBe(1);

    assembled.model.enqueue({ reply: "closed" });
    const outcome = await assembled.agent.workflow.decide("s1", { target: "approved" });
    expect(outcome.workflowState).toBe("approved");
  });

  it("refuses an empty reply message", async () => {
    const { agent } = await parkAtReview();
    await expect(agent.workflow.reply("s1", "   ")).rejects.toThrow(/message is required/);
  });

  it("refuses a delivery to a session parked on a human decision", async () => {
    const { agent } = await parkAtReview();
    await expect(
      agent.workflow.deliver("s1", { trigger: { id: "anything" } }),
    ).rejects.toThrow(/not parked awaiting an event/);
  });
});

/** clarify parks itself with archmax_wait; a delivery resumes it in place. */
const CLARIFY = {
  runtime: { engine: "archmax-harness", version: "2" },
  states: {
    clarify: {
      triggers: {
        manual: { session: "conversation_id" },
        email_reply: { session: "conversation_id" },
      },
      transitions: [{ to: "answer", description: "Test edge to answer." }],
    },
    answer: {},
  },
};

async function parkWithWait(reason = "waiting for the customer to name an order", until?: string) {
  const assembled = await assemble(workspaceWith(CLARIFY), {
    turns: [{ tool: "archmax_wait", args: { reason, ...(until ? { until } : {}) } }],
  });
  await turn(assembled.agent, "conv-1", "help with my order");
  return assembled;
}

describe("archmax_wait", () => {
  it("parks the session in the calling state awaiting input, with the agent's reason", async () => {
    const { agent, events } = await parkWithWait();

    const parked = eventsOf(events, "parked");
    expect(parked).toMatchObject([
      { state: "clarify", awaiting: "input", reason: "waiting for the customer to name an order", sessionId: "conv-1" },
    ]);
    expect(parked[0]?.callId).toBeDefined();
    const summary = await agent.sessions.get("conv-1");
    expect(summary).toMatchObject({
      status: "awaiting_input",
      classification: "open",
      state: "clarify",
      workflowState: "clarify",
      waitReason: "waiting for the customer to name an order",
    });
  });

  it("records a pending-input record with the parked node and reason", async () => {
    const assembled = await parkWithWait();
    const { pendingInput } = await pending(assembled, "conv-1");
    expect(pendingInput).toMatchObject({ state: "clarify", reason: "waiting for the customer to name an order" });
    expect(typeof pendingInput?.parkedAt).toBe("string");
  });

  it("carries an absolute resumeAt when the wait names an `until`", async () => {
    const { agent, events } = await parkWithWait("waiting", "30m");
    const parked = eventsOf(events, "parked")[0];
    expect(typeof parked?.resumeAt).toBe("string");
    expect(Number.isNaN(Date.parse(parked!.resumeAt!))).toBe(false);
    expect((await agent.sessions.get("conv-1"))?.resumeAt).toBe(parked?.resumeAt);
  });

  it("resumes the same state on delivery, with the delivered variables locked and an event note", async () => {
    const { agent, events, model } = await parkWithWait();
    model.enqueue(advanceTo("answer", "the reply named the order"), { reply: "ORD-1 is shipped" });

    const outcome = await agent.workflow.deliver("conv-1", {
      trigger: { id: "email_reply" },
      variables: { reply_body: "It's ORD-1." },
    });

    expect(eventsOf(events, "delivered")).toMatchObject([
      { state: "clarify", trigger: "email_reply", to: "clarify", sessionId: "conv-1" },
    ]);
    expect(outcome.reply).toBe("ORD-1 is shipped");
    expect(outcome.workflowState).toBe("answer");
    expect(outcome.status).toBe("completed");
    expect(outcome.reparked).toBe(false);
    expect(outcome.variables.reply_body).toEqual({ value: "It's ORD-1.", locked: true });
    expect(outcome.variables.trigger).toEqual({ value: "email_reply", locked: true });
    // A delivery's seeding is announced, locked, without a call id.
    const seeded = eventsOf(events, "variables-set").find((e) => e.names.includes("reply_body"));
    expect(seeded?.locked).toBe(true);
    expect(seeded?.callId).toBeUndefined();
    const notes = outcome.messages.filter(isRuntimeNote).map(runtimeNoteKind);
    expect(notes).toContain("event");
    // The resumed segment ran in `clarify` and then advanced.
    expect(statesEntered(events)).toEqual(["clarify", "clarify", "answer"]);
  });

  it("lets the resumed state park again on another wait", async () => {
    const { agent, model } = await parkWithWait();
    model.enqueue({ tool: "archmax_wait", args: { reason: "still unclear" } });
    const outcome = await agent.workflow.deliver("conv-1", { trigger: { id: "email_reply" } });
    expect(outcome.reparked).toBe(true);
    expect(outcome.parkedChannel).toBe("input");
    expect(outcome.state).toBe("clarify");
    expect((await agent.sessions.get("conv-1"))?.waitReason).toBe("still unclear");
  });

  it("refuses a delivery without a trigger id", async () => {
    const { agent } = await parkWithWait();
    await expect(
      agent.workflow.deliver("conv-1", { trigger: { id: "" } }),
    ).rejects.toThrow(/trigger id is required/);
  });

  it("refuses a delivery to a session that is not parked", async () => {
    const { agent } = await assemble(workspaceWith(CLARIFY), { turns: [advanceTo("answer"), { reply: "done" }] });
    await turn(agent, "conv-2", "go");
    await expect(
      agent.workflow.deliver("conv-2", { trigger: { id: "email_reply" } }),
    ).rejects.toThrow(/not parked awaiting an event/);
  });

  it("parks a terminal state too, so a finished answer can still await a follow-up", async () => {
    const { agent, events } = await assemble(workspaceWith(CLARIFY), {
      turns: [advanceTo("answer"), { tool: "archmax_wait", args: { reason: "awaiting a follow-up" } }],
    });
    await turn(agent, "conv-3", "go");
    expect(eventsOf(events, "parked")).toMatchObject([{ state: "answer", awaiting: "input" }]);
    expect((await agent.sessions.get("conv-3"))?.status).toBe("awaiting_input");
  });
});

describe("resolveSession", () => {
  it("opens a new turn for a firing whose session has never run", async () => {
    const { agent } = await assemble(workspaceWith(CLARIFY), { turns: [] });
    const resolved = await agent.workflow.resolveSession({
      trigger: { id: "manual" },
      variables: { conversation_id: "conv-9" },
    });
    expect(resolved).toMatchObject({
      sessionId: "conv-9",
      disposition: "turn",
      startState: "clarify",
      native: false,
    });
  });

  it("mints a session id when the trigger's session path does not resolve", async () => {
    const { agent, events } = await assemble(workspaceWith(CLARIFY), { turns: [] });
    const resolved = await agent.workflow.resolveSession({ trigger: { id: "manual" } });
    expect(resolved.native).toBe(true);
    expect(resolved.disposition).toBe("turn");
    expect(resolved.sessionId).toMatch(/^session-/);
    expect(eventsOf(events, "warning").some((w) => /do not resolve/.test(w.message))).toBe(true);
  });

  it("resolves a firing for a session parked on archmax_wait to a resume", async () => {
    const { agent } = await parkWithWait();
    const resolved = await agent.workflow.resolveSession({
      trigger: { id: "email_reply" },
      variables: { conversation_id: "conv-1" },
    });
    expect(resolved).toMatchObject({ sessionId: "conv-1", disposition: "resume", state: "clarify" });
  });

  it("resolves a firing for a session parked at a human node to a reply", async () => {
    const { agent } = await parkAtReview();
    const resolved = await agent.workflow.resolveSession({ sessionId: "s1" });
    expect(resolved).toMatchObject({ sessionId: "s1", disposition: "reply", state: "review" });
  });

  it("resolves a firing for a finished session to a new turn at its retained position", async () => {
    const { agent } = await assemble(workspaceWith(CLARIFY), { turns: [advanceTo("answer"), { reply: "done" }] });
    await turn(agent, "conv-4", "go");
    const resolved = await agent.workflow.resolveSession({ sessionId: "conv-4" });
    expect(resolved).toMatchObject({ sessionId: "conv-4", disposition: "turn", startState: "answer" });
  });

  it("refuses a trigger no state declares when no session is parked on it", async () => {
    const { agent } = await assemble(workspaceWith(CLARIFY), { turns: [] });
    await expect(
      agent.workflow.resolveSession({ trigger: { id: "ticket_closed" }, variables: { conversation_id: "fresh" } }),
    ).rejects.toThrow(/No state declares trigger 'ticket_closed'/);
  });

  it("does not invoke the graph: nothing is entered by resolving", async () => {
    const { agent, events } = await assemble(workspaceWith(CLARIFY), { turns: [] });
    await agent.workflow.resolveSession({ sessionId: "s-never" });
    expect(statesEntered(events)).toEqual([]);
    expect(await agent.sessions.get("s-never")).toBeNull();
    expect(lastAgentText([])).toBe("");
  });
});

describe("a decision that routes straight into another human state", () => {
  /** work → first [human] → second [human] → done. */
  const TWO_GATES = {
    runtime: { engine: "archmax-harness", version: "2" },
    states: {
      work: { triggers: { manual: null }, transitions: [{ to: "first", description: "Test edge to first." }] },
      first: {
        type: "human",
        evidence: ["scratchpad/a.md"],
        transitions: [{ to: "second", type: "approve", description: "Test edge to second." }, { to: "work", type: "refine", description: "Test edge to work." }],
      },
      second: { type: "human", transitions: [{ to: "done", type: "approve", description: "Test edge to done." }] },
      done: {},
    },
  };

  it("presents the second decision without running the first state's work again", async () => {
    const { agent, events, model } = await assemble(workspaceWith(TWO_GATES), {
      turns: [
        { tool: "archmax_advance", args: { to: "first", reason: "ready", evidence: ["scratchpad/x.md"] } },
      ],
    });
    await turn(agent, "s1", "go");
    expect((await agent.sessions.get("s1"))).toMatchObject({ status: "awaiting_decision", state: "first" });
    events.length = 0;
    model.enqueue({ reply: "now with the second reviewer" });

    const outcome = await agent.workflow.decide("s1", { target: "second" });

    expect(outcome).toMatchObject({ reparked: true, parkedChannel: "decision", state: "second" });
    expect(statesEntered(events)).toEqual(["second"]);
    expect(eventsOf(events, "parked")).toMatchObject([{ state: "second", awaiting: "decision" }]);
    // The closing message names the handoff; the model was given no tools for it.
    expect(outcome.reply).toBe("now with the second reviewer");
    expect(model.calls.at(-1)?.tools).toEqual([]);
    const snapshot = (await agent.getState({ configurable: { thread_id: "s1" } })) as {
      values?: { pendingDecision?: PendingDecision | null };
    };
    // A fresh record: the first decision's attachment does not leak into the second.
    expect(snapshot.values?.pendingDecision).toMatchObject({ state: "second", seq: 2 });
    expect(snapshot.values?.pendingDecision?.evidence).toBeUndefined();

    model.enqueue({ reply: "all approved" });
    const final = await agent.workflow.decide("s1", { target: "done" });
    expect(final).toMatchObject({ status: "completed", workflowState: "done", reparked: false });
  });
});

describe("a new turn on a session parked at a human node", () => {
  it("presents the decision again on a fresh record and keeps it decidable", async () => {
    const assembled = await parkAtReview();
    const { agent, events, model } = assembled;
    events.length = 0;
    model.enqueue({ reply: "still with the reviewer" });

    const { reply } = await turn(agent, "s1", "any progress?");

    expect(reply).toBe("still with the reviewer");
    // Answered on a reply-only turn: no state's work ran.
    expect(model.calls.at(-1)?.tools).toEqual([]);
    expect(eventsOf(events, "parked")).toMatchObject([{ state: "review", awaiting: "decision" }]);
    const { pendingDecision } = await pending(assembled);
    expect(pendingDecision).toMatchObject({ state: "review", seq: 2 });
    expect((await agent.sessions.get("s1"))?.status).toBe("awaiting_decision");

    model.enqueue({ reply: "closed" });
    const outcome = await agent.workflow.decide("s1", { target: "approved" });
    expect(outcome).toMatchObject({ status: "completed", workflowState: "approved" });
  });
});

describe("a delivery's variables", () => {
  it("seeds a delivered title unlocked and trimmed, announcing it", async () => {
    const { agent, events, model } = await parkWithWait();
    model.enqueue({ reply: "noted" });
    const outcome = await agent.workflow.deliver("conv-1", {
      trigger: { id: "email_reply" },
      variables: { title: "  Order 42 refund  ", note: "x" },
    });
    expect(outcome.variables.title).toEqual({ value: "Order 42 refund", locked: false });
    expect(outcome.variables.note).toEqual({ value: "x", locked: true });
    expect(eventsOf(events, "title-set")).toMatchObject([{ title: "Order 42 refund", state: "clarify" }]);
  });

  it("warns and skips a malformed title, delivering the rest", async () => {
    const { agent, events, model } = await parkWithWait();
    model.enqueue({ reply: "noted" });
    const outcome = await agent.workflow.deliver("conv-1", {
      trigger: { id: "email_reply" },
      variables: { title: "two\nlines", note: "x" },
    });
    expect(outcome.variables.title).toBeUndefined();
    expect(outcome.variables.note).toEqual({ value: "x", locked: true });
    expect(eventsOf(events, "warning").some((w) => /Delivered title ignored/.test(w.message))).toBe(true);
  });

  it("refuses a delivered variable name the run could not address", async () => {
    const { agent } = await parkWithWait();
    await expect(
      agent.workflow.deliver("conv-1", { trigger: { id: "email_reply" }, variables: { "Bad-Name": 1 } }),
    ).rejects.toThrow(/Bad-Name/);
    expect((await agent.sessions.get("conv-1"))?.status).toBe("awaiting_input");
  });

  it("does not re-run the parked state's entry gate on resume", async () => {
    const root = workspaceWith(
      {
        ...CLARIFY,
        states: {
          clarify: { triggers: { manual: null }, before: { script: "hooks/gate.js" }, transitions: [{ to: "answer", description: "Test edge to answer." }] },
          answer: {},
        },
      },
      { "workflows/w/hooks/gate.js": "/** Passes. */\nexport default () => ok();\n" },
    );
    const { agent, events, model } = await assemble(root, {
      turns: [{ tool: "archmax_wait", args: { reason: "waiting" } }],
    });
    await turn(agent, "conv-9", "help");
    const gatesBefore = eventsOf(events, "hook-start").length;
    expect(gatesBefore).toBeGreaterThan(0);
    model.enqueue(advanceTo("answer"), { reply: "done" });
    await agent.workflow.deliver("conv-9", { trigger: { id: "email_reply" } });
    expect(eventsOf(events, "hook-start").length).toBe(gatesBefore);
  });
});

describe("the park budget", () => {
  const budgeted = (onError?: string) => ({
    runtime: { engine: "archmax-harness", version: "2" },
    states: {
      clarify: {
        triggers: {
          manual: { session: "conversation_id" },
          email_reply: { session: "conversation_id" },
        },
        budget: { maxParks: 1 },
        ...(onError ? { on_error: onError } : {}),
        transitions: [{ to: "answer", description: "Test edge to answer." }],
      },
      answer: {},
      ...(onError ? { [onError]: {} } : {}),
    },
  });

  it("routes the park that would exceed maxParks to on_error once the model finishes", async () => {
    const { agent, events, model } = await assemble(workspaceWith(budgeted("escalate")), {
      turns: [{ tool: "archmax_wait", args: { reason: "first wait" } }],
    });
    await turn(agent, "conv-1", "help");
    model.enqueue({ tool: "archmax_wait", args: { reason: "second wait" } }, { reply: "cannot wait again" }, { reply: "escalated" });
    const outcome = await agent.workflow.deliver("conv-1", { trigger: { id: "email_reply" } });
    expect(eventsOf(events, "state-error-routed")).toMatchObject([{ state: "clarify", to: "escalate" }]);
    expect(eventsOf(events, "state-error-routed")[0]?.reason).toMatch(/maxParks: 1/);
    expect(outcome).toMatchObject({ workflowState: "escalate", status: "completed", reparked: false });
    expect(outcome.reply).toBe("escalated");
  });

  it("ends the turn rejected when the budgeted state declares no on_error", async () => {
    const { agent, model } = await assemble(workspaceWith(budgeted()), {
      turns: [{ tool: "archmax_wait", args: { reason: "first wait" } }],
    });
    await turn(agent, "conv-1", "help");
    model.enqueue({ tool: "archmax_wait", args: { reason: "second wait" } }, { reply: "stuck" });
    const outcome = await agent.workflow.deliver("conv-1", { trigger: { id: "email_reply" } });
    expect(outcome).toMatchObject({ status: "rejected", workflowState: "clarify", reparked: false });
  });

  it("counts parks within a turn, so a later turn may park again", async () => {
    const { agent, model } = await assemble(workspaceWith(budgeted()), {
      turns: [{ tool: "archmax_wait", args: { reason: "first wait" } }],
    });
    await turn(agent, "conv-1", "help");
    model.enqueue({ tool: "archmax_wait", args: { reason: "later turn" } });
    await turn(agent, "conv-1", "another message");
    expect((await agent.sessions.get("conv-1"))).toMatchObject({ status: "awaiting_input", waitReason: "later turn" });
  });
});

describe("an on_error target that is a human node", () => {
  it("parks the run there awaiting a decision", async () => {
    const spec = {
      runtime: { engine: "archmax-harness", version: "2" },
      states: {
        start: { triggers: { manual: null }, budget: { maxTurns: 1 }, on_error: "review", transitions: [{ to: "done", description: "Test edge to done." }] },
        review: { type: "human", transitions: [{ to: "done", type: "approve", description: "Test edge to done." }] },
        done: {},
      },
    };
    const probe = { tool: "archmax_get_variables", args: {} };
    const { agent, events, model } = await assemble(workspaceWith(spec), {
      turns: [probe, probe, { reply: "a person has to look at this" }],
    });
    await turn(agent, "s1", "go");
    expect(eventsOf(events, "state-error-routed")).toMatchObject([{ state: "start", to: "review" }]);
    expect(eventsOf(events, "parked")).toMatchObject([{ state: "review", awaiting: "decision" }]);
    expect((await agent.sessions.get("s1"))).toMatchObject({ status: "awaiting_decision", state: "review" });
    model.enqueue({ reply: "closed" });
    const outcome = await agent.workflow.decide("s1", { target: "done" });
    expect(outcome).toMatchObject({ status: "completed", workflowState: "done" });
  });
});

describe("a disabled workflow still finishes what it started", () => {
  async function disableAfterPark() {
    const root = workspaceWith(CLARIFY);
    const first = await assemble(root, { turns: [{ tool: "archmax_wait", args: { reason: "waiting" } }] });
    await turn(first.agent, "conv-1", "help");
    // The definition changes under the parked session: written back disabled.
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { stringify } = await import("yaml");
    writeFileSync(join(root, "workflows/w/workflow.yaml"), stringify({ ...CLARIFY, disabled: true }));
    return assemble(root, { turns: [], store: first.store });
  }

  it("delivers to a run parked before the workflow was disabled", async () => {
    const { agent, model } = await disableAfterPark();
    model.enqueue(advanceTo("answer"), { reply: "finished anyway" });
    const outcome = await agent.workflow.deliver("conv-1", { trigger: { id: "email_reply" } });
    expect(outcome).toMatchObject({ status: "completed", workflowState: "answer" });
    expect(outcome.reply).toBe("finished anyway");
  });

  it("refuses a firing that would start a new turn instead", async () => {
    const { agent, events, model } = await disableAfterPark();
    await turn(agent, "conv-2", "a new conversation");
    expect(model.calls).toHaveLength(0);
    expect(statesEntered(events)).toEqual([]);
    expect(eventsOf(events, "warning").some((w) => /disabled/.test(w.message))).toBe(true);
    expect((await agent.sessions.get("conv-2"))?.status).toBe("rejected");
  });
});

describe("a delivery that carries the person's message", () => {
  it("appends the message with the arrival, as the person's own, and answers it", async () => {
    const { agent, events, model } = await parkWithWait();
    model.enqueue({ reply: "Thanks — ORD-1 it is." });

    const outcome = await agent.workflow.deliver("conv-1", {
      trigger: { id: "email_reply" },
      variables: { reply_body: "It's ORD-1." },
      message: "It's ORD-1.",
    });

    // The arrival note comes first, the person's message right after it — one write.
    const kinds = outcome.messages.map((m) => (isRuntimeNote(m) ? `note:${runtimeNoteKind(m)}` : messageType(m)));
    const note = kinds.lastIndexOf("note:event");
    expect(kinds[note + 1]).toBe("human");
    const said = outcome.messages[note + 1] as { content?: unknown };
    expect(said.content).toBe("It's ORD-1.");
    expect(isRuntimeNote(said)).toBe(false);
    expect(eventsOf(events, "park-message")).toMatchObject([
      { direction: "inbound", text: "It's ORD-1.", state: "clarify", sessionId: "conv-1" },
    ]);
    expect(outcome.reply).toBe("Thanks — ORD-1 it is.");
  });

  it("is what `send` does with a turn's message on a waiting session, instead of dropping it", async () => {
    const { agent, model } = await parkWithWait();
    model.enqueue({ reply: "noted" });

    const outcome = await agent.workflow.send("conv-1", {
      message: "Any update?",
      trigger: { id: "email_reply" },
    });

    expect(outcome.disposition).toBe("deliver");
    const humans = outcome.messages.filter((m) => messageType(m) === "human" && !isRuntimeNote(m));
    expect((humans.at(-1) as { content?: unknown }).content).toBe("Any update?");
  });

  it("still refuses when the park is gone, so a message cannot land on a running session", async () => {
    const { agent } = await parkWithWait();
    await expect(
      agent.workflow.deliver("conv-2", { trigger: { id: "email_reply" }, message: "hello?" }),
    ).rejects.toThrow(/not parked awaiting an event/);
  });
});

describe("a resumed turn honours the caller's config", () => {
  // `send` merges the caller's config on a fresh turn. A resume must do the same:
  // the config is how a caller supplies tool mocks and the turn's abort signal, so
  // dropping it makes a case's `mocks:` block silently inert on a resumed step
  // (issue #158). Exercised through `deliver`, because a delivery resumes the
  // parked state and keeps working — the turn actually calls tools.
  const MOCKED = "MOCKED - the caller's config arrived";
  const MOCK_CONFIG = { configurable: { __toolMocks: [{ name: "write_file", result: MOCKED }] } };

  const WAIT = {
    runtime: { engine: "archmax-harness", version: "2" },
    states: {
      clarify: {
        triggers: { manual: null, email_reply: null },
        tools: { allow: [{ tool: "write_file" }] },
        transitions: [{ to: "answer", description: "Test edge to answer." }],
      },
      answer: {},
    },
  };

  const writeThenReply = [
    { tool: "write_file", args: { file_path: "scratchpad/a.txt", content: "real" } },
    { reply: "done" },
  ];

  // The control: same mock, same middleware, on the path that already merges
  // config. If this fails the harness is wrong, not the resume path.
  it("applies a declared tool mock on a fresh turn", async () => {
    const assembled = await assemble(workspaceWith(WAIT), {
      turns: writeThenReply,
      params: { middleware: [createToolMockMiddleware()] },
    });
    const outcome = await assembled.agent.workflow.send("s1", { message: "go" }, MOCK_CONFIG);
    expect(JSON.stringify(outcome)).toContain(MOCKED);
  });

  it("applies a declared tool mock on a turn resumed by deliver", async () => {
    const assembled = await assemble(workspaceWith(WAIT), {
      // A delivery's first model call is the reply-only handoff, which is handed
      // no tools; the agent resumes working on the call after it.
      turns: [
        { tool: "archmax_wait", args: { reason: "waiting" } },
        { reply: "handoff acknowledged" },
        ...writeThenReply,
      ],
      params: { middleware: [createToolMockMiddleware()] },
    });
    await turn(assembled.agent, "s1", "go");
    const outcome = await assembled.agent.workflow.send(
      "s1",
      { delivery: { trigger: { id: "email_reply" } } },
      MOCK_CONFIG,
    );
    expect(JSON.stringify(outcome)).toContain(MOCKED);
  });
});
