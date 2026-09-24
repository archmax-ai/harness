/**
 * Sub-workflow delegation: a sibling workflow named as `archmax_workflow_<slug>`
 * in `tools.allow` is a tool call; its params seed the child's locked
 * variables, its declared `returns` come back, depth and cycles are refused, and
 * a child that parks parks the parent with it.
 *
 * The parent and the child share one scripted model, so the script interleaves:
 * the child's turns run synchronously inside the parent's tool call.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isRuntimeNote, runtimeNoteKind, workflowToolName } from "../index.js";
import {
  advanceTo,
  assemble,
  blockedTools,
  cleanupWorkspaces,
  eventsOf,
  makeWorkspace,
  AGENTS_MD,
  messageType,
  skillMarkdown,
  statesEntered,
  toolResults,
  turn,
} from "./support.js";

afterEach(cleanupWorkspaces);

const RUNTIME = { engine: "archmax-harness", version: "2" };
const CHILD_TOOL = workflowToolName("enrich");

/** The parent: `start` may delegate to `enrich`, then finishes in `done`. */
const PARENT = {
  runtime: RUNTIME,
  states: {
    start: { triggers: { manual: null }, tools: { allow: [CHILD_TOOL] }, transitions: [{ to: "done", description: "Test edge to done." }] },
    done: {},
  },
};

/** The child: one state, requires `order_id`, returns `enrichment_file`. */
const CHILD = {
  runtime: RUNTIME,
  states: { work: { triggers: { manual: { requires: ["order_id"], returns: ["enrichment_file"] } } } },
};

const setReturn = { tool: "archmax_set_variables", args: { variables: { enrichment_file: "scratchpad/e.json" } } };

function delegatingWorkspace(child: Record<string, unknown> = CHILD, parent: Record<string, unknown> = PARENT) {
  return makeWorkspace({
    "AGENTS.md": AGENTS_MD,
    "workflows/w/workflow.yaml": parent,
    "workflows/enrich/workflow.yaml": child,
  });
}

describe("a delegation call", () => {
  it("runs the child as its own session, seeds the params locked, and returns the declared outputs", async () => {
    const { agent, events } = await assemble(delegatingWorkspace(), {
      turns: [
        { tool: CHILD_TOOL, args: { order_id: "ORD-7" } },
        // — child —
        setReturn,
        { reply: "ORD-7 enriched" },
        // — parent —
        advanceTo("done"),
        { reply: "parent finished" },
      ],
    });
    const { messages, reply } = await turn(agent, "s1", "enrich ORD-7");

    expect(reply).toBe("parent finished");
    const start = eventsOf(events, "sub-workflow-start")[0];
    expect(start).toMatchObject({ state: "start", workflow: "enrich", depth: 1 });
    expect(start?.toolCallId).toBeDefined();
    expect(eventsOf(events, "sub-workflow-result")).toMatchObject([
      { workflow: "enrich", status: "ok", returns: ["enrichment_file"] },
    ]);

    const result = toolResults(messages).find((r) => r.name === CHILD_TOOL);
    const parsed = JSON.parse(result!.content) as { message?: string; returns?: Record<string, unknown> };
    expect(parsed.returns).toEqual({ enrichment_file: "scratchpad/e.json" });
    expect(parsed.message).toContain("ORD-7 enriched");

    // The child is an ordinary session with a recorded parent.
    const sessions = await agent.sessions.list();
    const child = sessions.find((s) => s.parentSessionId === "s1");
    expect(child).toBeDefined();
    expect(child?.sessionId.startsWith("s1~")).toBe(true);
    expect(child?.status).toBe("completed");
    expect(child?.variables?.order_id).toEqual({ value: "ORD-7", locked: true });
    expect(child?.variables?.trigger).toEqual({ value: "manual", locked: true });
  });

  it("attributes the child's events to the dispatch, and the parent's to none", async () => {
    const { agent, events } = await assemble(delegatingWorkspace(), {
      turns: [{ tool: CHILD_TOOL, args: { order_id: "ORD-7" } }, setReturn, { reply: "child" }, { reply: "parent" }],
    });
    await turn(agent, "s1", "go");
    const dispatchId = eventsOf(events, "sub-workflow-start")[0]?.dispatchId;
    const childEnters = eventsOf(events, "state-enter").filter((e) => e.subWorkflowDispatchId === dispatchId);
    expect(childEnters.map((e) => e.state)).toEqual(["work"]);
    const parentEnters = eventsOf(events, "state-enter").filter((e) => e.subWorkflowDispatchId === undefined);
    expect(parentEnters.map((e) => e.state)).toEqual(["start"]);
  });

  it("does not leak the caller's variables into the child", async () => {
    const { agent } = await assemble(delegatingWorkspace(), {
      turns: [{ tool: CHILD_TOOL, args: { order_id: "ORD-7" } }, setReturn, { reply: "child" }, { reply: "parent" }],
      params: { variables: { from_email: "a@b.c" } },
    });
    await turn(agent, "s1", "go");
    const child = (await agent.sessions.list()).find((s) => s.parentSessionId === "s1");
    expect(child?.variables?.from_email).toBeUndefined();
    expect((await agent.sessions.get("s1"))?.variables?.from_email).toEqual({ value: "a@b.c", locked: true });
  });

  it("routes a child that completes without its declared return to the caller's on_error", async () => {
    const parent = {
      runtime: RUNTIME,
      states: {
        start: { triggers: { manual: null }, tools: { allow: [CHILD_TOOL] }, on_error: "failed", transitions: [{ to: "done", description: "Test edge to done." }] },
        done: {},
        failed: {},
      },
    };
    const { agent, events } = await assemble(delegatingWorkspace(CHILD, parent), {
      turns: [{ tool: CHILD_TOOL, args: { order_id: "ORD-7" } }, { reply: "forgot the file" }, { reply: "sorry" }],
    });
    const { messages } = await turn(agent, "s1", "go");
    expect(eventsOf(events, "sub-workflow-result")[0]?.status).toBe("error");
    expect(eventsOf(events, "sub-workflow-result")[0]?.reason).toMatch(/enrichment_file/);
    expect(eventsOf(events, "state-error-routed")).toMatchObject([{ state: "start", to: "failed" }]);
    expect(messages.filter(isRuntimeNote).map(runtimeNoteKind)).toContain("error");
    expect((await agent.sessions.get("s1"))?.workflowState).toBe("failed");
  });

  it("refuses a call missing a required param before any child runs", async () => {
    const { agent, events } = await assemble(delegatingWorkspace(), {
      turns: [{ tool: CHILD_TOOL, args: {} }, { reply: "parent" }],
    });
    const { messages } = await turn(agent, "s1", "go");
    expect(toolResults(messages).find((r) => r.name === CHILD_TOOL)?.status).toBe("error");
    expect(eventsOf(events, "state-enter").filter((e) => e.subWorkflowDispatchId)).toEqual([]);
    expect((await agent.sessions.list()).some((s) => s.parentSessionId === "s1")).toBe(false);
  });

  it("is governed like any tool: a state that does not allow the delegation cannot make it", async () => {
    const parent = {
      runtime: RUNTIME,
      states: {
        start: { triggers: { manual: null }, transitions: [{ to: "may", description: "Test edge to may." }] },
        may: { tools: { allow: [CHILD_TOOL] } },
      },
    };
    const { agent, events } = await assemble(delegatingWorkspace(CHILD, parent), {
      turns: [{ tool: CHILD_TOOL, args: { order_id: "ORD-7" } }, { reply: "blocked" }],
    });
    await turn(agent, "s1", "go");
    expect(blockedTools(events)).toEqual([CHILD_TOOL]);
    expect(eventsOf(events, "sub-workflow-start")).toEqual([]);
  });

  it("refuses a delegation to a disabled target without failing assembly", async () => {
    const { agent, events } = await assemble(delegatingWorkspace({ ...CHILD, disabled: true }), {
      turns: [{ tool: CHILD_TOOL, args: { order_id: "ORD-7" } }, { reply: "parent" }],
    });
    await turn(agent, "s1", "go");
    expect(eventsOf(events, "sub-workflow-result")).toMatchObject([{ status: "error" }]);
    expect(eventsOf(events, "sub-workflow-result")[0]?.reason).toMatch(/disabled/);
  });
});

describe("delegation bounds", () => {
  it("refuses a cycle: a workflow already running in the chain", async () => {
    // `w` may delegate to itself. The first dispatch is legal (depth 1); the
    // child's own attempt would re-enter `w`, which the chain already holds.
    const selfCalling = {
      runtime: RUNTIME,
      states: {
        start: { triggers: { manual: null }, tools: { allow: [workflowToolName("w")] }, transitions: [{ to: "done", description: "Test edge to done." }] },
        done: {},
      },
    };
    const root = makeWorkspace({ "AGENTS.md": AGENTS_MD, "workflows/w/workflow.yaml": selfCalling });
    const { agent, events } = await assemble(root, {
      turns: [
        { tool: workflowToolName("w"), args: {} },
        // — child (w, depth 1) —
        { tool: workflowToolName("w"), args: {} },
        { reply: "child gave up" },
        // — parent —
        { reply: "parent done" },
      ],
    });
    await turn(agent, "s1", "go");

    const results = eventsOf(events, "sub-workflow-result");
    const refused = results.find((r) => r.status === "error");
    expect(refused?.reason).toMatch(/already running in this chain/);
    expect(refused?.reason).toMatch(/w → w/);
    // The outer dispatch itself completed.
    expect(results.some((r) => r.status === "ok" && r.subWorkflowDispatchId === undefined)).toBe(true);
  });

  it("refuses a chain deeper than the dispatcher's depth bound", async () => {
    // w → b → c → d → e: with the default bound of 3, `d` is the deepest child
    // allowed and the dispatch into `e` is refused before anything is composed.
    const link = (next?: string) => ({
      runtime: RUNTIME,
      states: {
        start: {
          triggers: { manual: null },
          ...(next ? { tools: { allow: [workflowToolName(next)] } } : {}),
        },
      },
    });
    const root = makeWorkspace({
      "AGENTS.md": AGENTS_MD,
      "workflows/w/workflow.yaml": link("b"),
      "workflows/b/workflow.yaml": link("c"),
      "workflows/c/workflow.yaml": link("d"),
      "workflows/d/workflow.yaml": link("e"),
      "workflows/e/workflow.yaml": link(),
    });
    const { agent, events } = await assemble(root, {
      turns: [
        { tool: workflowToolName("b"), args: {} },
        { tool: workflowToolName("c"), args: {} },
        { tool: workflowToolName("d"), args: {} },
        { tool: workflowToolName("e"), args: {} },
        { reply: "d done" },
        { reply: "c done" },
        { reply: "b done" },
        { reply: "w done" },
      ],
    });
    await turn(agent, "s1", "go");

    const starts = eventsOf(events, "sub-workflow-start");
    expect(starts.map((s) => s.workflow)).toEqual(["b", "c", "d", "e"]);
    expect(starts.map((s) => s.depth)).toEqual([1, 2, 3, 4]);
    const refused = eventsOf(events, "sub-workflow-result").find((r) => r.workflow === "e");
    expect(refused?.status).toBe("error");
    expect(refused?.reason).toMatch(/delegations deep/);
    // w, b, c and d each entered their state; e never ran.
    expect(statesEntered(events).length).toBe(4);
  });
});

describe("a child that parks", () => {
  const REVIEWING_CHILD = {
    runtime: RUNTIME,
    states: {
      draft: { triggers: { manual: { requires: ["order_id"] } }, transitions: [{ to: "review", description: "Test edge to review." }] },
      review: {
        type: "human",
        transitions: [{ to: "approved", type: "approve", description: "Test edge to approved." }, { to: "draft", type: "refine", description: "Test edge to draft." }],
      },
      approved: {},
    },
  };

  it("parks the parent session awaiting the child's decision", async () => {
    const { agent, events } = await assemble(delegatingWorkspace(REVIEWING_CHILD), {
      turns: [{ tool: CHILD_TOOL, args: { order_id: "ORD-7" } }, advanceTo("review", "needs a reviewer")],
    });
    await turn(agent, "s1", "go");

    expect(eventsOf(events, "sub-workflow-result")).toMatchObject([{ workflow: "enrich", status: "parked" }]);
    const parent = await agent.sessions.get("s1");
    expect(parent?.status).toBe("awaiting_decision");
    expect(parent?.state).toBe("review");
    // The decision presented belongs to the child, not to the parent's own state.
    const child = (await agent.sessions.list()).find((s) => s.parentSessionId === "s1");
    expect(child?.status).toBe("awaiting_decision");
  });

  it("hands the decision to the child, which completes and reports its result to the parent", async () => {
    const { agent, events, model } = await assemble(delegatingWorkspace(REVIEWING_CHILD), {
      turns: [{ tool: CHILD_TOOL, args: { order_id: "ORD-7" } }, advanceTo("review", "needs a reviewer")],
    });
    await turn(agent, "s1", "go");
    events.length = 0;
    model.enqueue({ reply: "child approved" }, advanceTo("done"), { reply: "parent finished" });

    const outcome = await agent.workflow.decide("s1", { target: "approved" });

    // The decision is recorded on the parent and handed to the child.
    expect(eventsOf(events, "decided")).toMatchObject([
      { state: "start", to: "approved", sessionId: "s1" },
      { state: "review", to: "approved" },
    ]);
    const child = (await agent.sessions.list()).find((s) => s.parentSessionId === "s1");
    expect(child?.status).toBe("completed");
    expect(child?.workflowState).toBe("approved");
    // The child's result reaches the parent's transcript as a runtime note.
    expect(eventsOf(events, "sub-workflow-result")).toMatchObject([{ workflow: "enrich", status: "ok" }]);
    expect(outcome.messages.filter(isRuntimeNote).map(runtimeNoteKind)).toContain("sub-workflow");
  });

  it("resumes the parent in the calling state once the only child has been decided", async () => {
    const { agent, model } = await assemble(delegatingWorkspace(REVIEWING_CHILD), {
      turns: [{ tool: CHILD_TOOL, args: { order_id: "ORD-7" } }, advanceTo("review", "needs a reviewer")],
    });
    await turn(agent, "s1", "go");
    model.enqueue({ reply: "child approved" }, advanceTo("done"), { reply: "parent finished" });

    const outcome = await agent.workflow.decide("s1", { target: "approved" });

    expect(outcome.reparked).toBe(false);
    expect(outcome.workflowState).toBe("done");
    expect(outcome.status).toBe("completed");
    expect(outcome.reply).toBe("parent finished");
  });

  it("names the child on the outcome, so a host need not reconstruct whose decision it is", async () => {
    const { agent } = await assemble(delegatingWorkspace(REVIEWING_CHILD), {
      turns: [{ tool: CHILD_TOOL, args: { order_id: "ORD-7" } }, advanceTo("review", "needs a reviewer")],
    });

    const outcome = await agent.workflow.send("s1", { message: "go" });

    expect(outcome.kind).toBe("parked");
    expect(outcome.parkedChannel).toBe("decision");
    expect(outcome.state).toBe("review");
    expect(outcome.delegation).toMatchObject({
      workflow: "enrich",
      state: "start",
      sessionId: expect.stringMatching(/^s1~start:enrich:\d+$/),
      identity: expect.stringMatching(/^start:enrich:\d+$/),
      dispatchId: expect.stringMatching(/^subwf-\d+$/),
    });
    expect(typeof outcome.delegation?.toolCallId).toBe("string");
    // The child's session is the one the outcome names.
    const child = (await agent.sessions.list()).find((s) => s.parentSessionId === "s1");
    expect(child?.sessionId).toBe(outcome.delegation?.sessionId);
  });

  it("carries no delegation once the child has been decided and the parent finished", async () => {
    const { agent, model } = await assemble(delegatingWorkspace(REVIEWING_CHILD), {
      turns: [{ tool: CHILD_TOOL, args: { order_id: "ORD-7" } }, advanceTo("review", "needs a reviewer")],
    });
    await turn(agent, "s1", "go");
    model.enqueue({ reply: "child approved" }, advanceTo("done"), { reply: "parent finished" });

    const outcome = await agent.workflow.decide("s1", { target: "approved" });
    expect(outcome.reparked).toBe(false);
    expect(outcome.delegation).toBeUndefined();
  });

  it("answers a message while parked without handing it to the child as a decision", async () => {
    const { agent, model } = await assemble(delegatingWorkspace(REVIEWING_CHILD), {
      turns: [{ tool: CHILD_TOOL, args: { order_id: "ORD-7" } }, advanceTo("review", "needs a reviewer")],
    });
    await turn(agent, "s1", "go");
    model.enqueue({ reply: "the enrichment is with a reviewer" });

    const outcome = await agent.workflow.reply("s1", "status?");
    expect(outcome.reply).toBe("the enrichment is with a reviewer");
    expect(outcome.reparked).toBe(true);
    expect((await agent.sessions.get("s1"))?.status).toBe("awaiting_decision");
    const child = (await agent.sessions.list()).find((s) => s.parentSessionId === "s1");
    expect(child?.status).toBe("awaiting_decision");
  });
});

describe("two children that park in one tool batch", () => {
  const REVIEWING_CHILD = {
    runtime: RUNTIME,
    states: {
      draft: { triggers: { manual: { requires: ["order_id"] } }, transitions: [{ to: "review", description: "Test edge to review." }] },
      review: { type: "human", transitions: [{ to: "approved", type: "approve", description: "Test edge to approved." }] },
      approved: {},
    },
  };

  it("presents their decisions one at a time and continues once both are made", async () => {
    const { agent, events, model } = await assemble(delegatingWorkspace(REVIEWING_CHILD), {
      turns: [
        { batch: [{ tool: CHILD_TOOL, args: { order_id: "A" } }, { tool: CHILD_TOOL, args: { order_id: "B" } }] },
        // — both children, in whichever order they run —
        advanceTo("review", "needs a reviewer"),
        advanceTo("review", "needs a reviewer"),
      ],
    });
    await turn(agent, "s1", "enrich both");

    expect(eventsOf(events, "sub-workflow-result").map((e) => e.status)).toEqual(["parked", "parked"]);
    expect((await agent.sessions.get("s1"))?.status).toBe("awaiting_decision");
    const children = (await agent.sessions.list()).filter((s) => s.parentSessionId === "s1");
    expect(children.map((c) => c.status)).toEqual(["awaiting_decision", "awaiting_decision"]);

    // The first decision resolves one child; the run parks again on the other.
    model.enqueue({ reply: "first child approved" });
    const first = await agent.workflow.decide("s1", { target: "approved" });
    expect(first).toMatchObject({ reparked: true, parkedChannel: "decision" });
    expect((await agent.sessions.list()).filter((s) => s.parentSessionId === "s1").map((c) => c.status).sort()).toEqual([
      "awaiting_decision",
      "completed",
    ]);

    // The second resolves the other, and the calling state continues.
    model.enqueue({ reply: "second child approved" }, advanceTo("done"), { reply: "both enriched" });
    const second = await agent.workflow.decide("s1", { target: "approved" });
    expect(second).toMatchObject({ reparked: false, workflowState: "done", status: "completed" });
    expect(second.reply).toBe("both enriched");
    expect((await agent.sessions.list()).filter((s) => s.parentSessionId === "s1").map((c) => c.status)).toEqual([
      "completed",
      "completed",
    ]);
    // Each child's answer reached the parent's transcript as its own note (a
    // note is a call-and-result pair; count the results).
    const answers = second.messages.filter(
      (m) => runtimeNoteKind(m) === "sub-workflow" && messageType(m) === "tool",
    );
    expect(answers).toHaveLength(2);
  });
});

/**
 * Denials accumulate down a delegation chain: a grandchild is bound by the
 * root's `policy` AND by every intermediate caller's, not by the root's alone.
 */
describe("workflow denials down a delegation chain", () => {
  const MID_TOOL = workflowToolName("mid");
  const LEAF_TOOL = workflowToolName("leaf");

  it("binds a leaf by an intermediate caller's forbid_always, naming that workflow", async () => {
    const root = makeWorkspace({
      "AGENTS.md": AGENTS_MD,
      "workflows/w/workflow.yaml": {
        runtime: RUNTIME,
        states: { start: { triggers: { manual: null }, tools: { allow: [MID_TOOL] } } },
      },
      "workflows/mid/workflow.yaml": {
        runtime: RUNTIME,
        tools: { forbid_always: [{ tool: "write_file" }] },
        states: { work: { triggers: { manual: null }, tools: { allow: [LEAF_TOOL] } } },
      },
      "workflows/leaf/workflow.yaml": {
        runtime: RUNTIME,
        states: { work: { triggers: { manual: null } } },
      },
    });
    const { agent, events } = await assemble(root, {
      turns: [
        { tool: MID_TOOL, args: {} },
        // — mid —
        { tool: LEAF_TOOL, args: {} },
        // — leaf —
        { tool: "write_file", args: { file_path: "scratchpad/note.txt", content: "x" } },
        { reply: "leaf done" },
        // — mid —
        { reply: "mid done" },
        // — root —
        { reply: "root done" },
      ],
    });
    const { reply } = await turn(agent, "chain-1", "go");

    expect(reply).toBe("root done");
    expect(eventsOf(events, "sub-workflow-result").map((e) => [e.workflow, e.status])).toEqual([
      ["leaf", "ok"],
      ["mid", "ok"],
    ]);
    expect(blockedTools(events)).toEqual(["write_file"]);
    const blocked = eventsOf(events, "tool-blocked")[0];
    expect(blocked?.reason).toMatch(/inherited from workflow 'mid'/);
    const leaf = (await agent.sessions.list()).find((s) => s.sessionId.includes("leaf"));
    expect(blocked?.sessionId).toBe(leaf?.sessionId);
  });

  it("does not carry a caller's per-state forbid into the child", async () => {
    // A state's denial governs that state's turns, not a child session — the
    // same way a state's `allow` list is not inherited in either direction.
    const root = makeWorkspace({
      "AGENTS.md": AGENTS_MD,
      "workflows/w/workflow.yaml": {
        runtime: RUNTIME,
        states: {
          start: {
            triggers: { manual: null },
            tools: { allow: [LEAF_TOOL], forbid: [{ tool: "write_file" }] },
          },
        },
      },
      "workflows/leaf/workflow.yaml": {
        runtime: RUNTIME,
        states: { work: { triggers: { manual: null } } },
      },
    });
    const { agent, events } = await assemble(root, {
      turns: [
        { tool: LEAF_TOOL, args: {} },
        // — leaf — the caller forbids this tool in its own state, not here.
        { tool: "write_file", args: { file_path: "scratchpad/note.txt", content: "x" } },
        { reply: "leaf done" },
        // — root —
        { reply: "root done" },
      ],
    });
    const { reply } = await turn(agent, "chain-2", "go");

    expect(reply).toBe("root done");
    expect(blockedTools(events)).toEqual([]);
  });

  it("puts a bundle an ancestor forbids out of a child's reach", async () => {
    const root = makeWorkspace({
      "AGENTS.md": AGENTS_MD,
      "skills/orders/SKILL.md": skillMarkdown("orders", "Order records."),
      "skills/orders/assets/orders.json": '[{"id":"ORD-1"}]',
      "workflows/w/workflow.yaml": {
        runtime: RUNTIME,
        skills: { forbid_always: ["orders"] },
        states: { start: { triggers: { manual: null }, tools: { allow: [LEAF_TOOL] } } },
      },
      // The child grants itself the bundle; the caller's denial still binds.
      "workflows/leaf/workflow.yaml": {
        runtime: RUNTIME,
        skills: { allow_always: ["orders"] },
        states: { work: { triggers: { manual: null } } },
      },
    });
    const { agent, events } = await assemble(root, {
      turns: [
        { tool: LEAF_TOOL, args: {} },
        // — leaf —
        { tool: "read_file", args: { file_path: "skills/orders/assets/orders.json" } },
        { reply: "leaf done" },
        // — root —
        { reply: "root done" },
      ],
    });
    await turn(agent, "chain-3", "go");

    expect(blockedTools(events)).toEqual(["read_file"]);
    const blocked = eventsOf(events, "tool-blocked")[0];
    expect(blocked?.reason).toMatch(/workflow 'w' denies/);
  });
});

describe("a child that parks awaiting input parks the parent on the same channel", () => {
  // A child may park with `archmax_wait` as readily as at a human state. The
  // parent parks with it either way, but the channel has to match what the child
  // actually asked for: presenting an input park as a decision leaves nothing
  // that can resume it (issue #160).
  const WAITING_CHILD = {
    runtime: RUNTIME,
    states: {
      work: {
        triggers: { manual: { requires: ["order_id"] }, email_reply: null },
        transitions: [{ to: "done", description: "Test edge to done." }],
      },
      done: {},
    },
  };

  it("parks the parent awaiting input rather than presenting an undecidable decision", async () => {
    const { agent } = await assemble(delegatingWorkspace(WAITING_CHILD), {
      turns: [
        { tool: CHILD_TOOL, args: { order_id: "ORD-7" } },
        { tool: "archmax_wait", args: { reason: "waiting on the customer" } },
        { reply: "parent handoff" },
      ],
    });

    await turn(agent, "s1", "go");

    expect((await agent.sessions.get("s1"))?.status).toBe("awaiting_input");
  });

  it("delivers into the parent and reaches the child that asked", async () => {
    const { agent } = await assemble(delegatingWorkspace(WAITING_CHILD), {
      turns: [
        { tool: CHILD_TOOL, args: { order_id: "ORD-7" } },
        { tool: "archmax_wait", args: { reason: "waiting on the customer" } },
        { reply: "parent handoff" },
        advanceTo("done", "the customer answered"), // the child, resumed
        { reply: "all done" }, // the parent, continuing
      ],
    });

    await turn(agent, "s1", "go");
    const outcome = await agent.workflow.deliver("s1", { trigger: { id: "email_reply" } });

    expect(outcome.status).toBe("completed");
  });
});
