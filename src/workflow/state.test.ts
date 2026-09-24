import { describe, expect, it } from "vitest";
import { END, START, StateGraph } from "@langchain/langgraph";
import {
  readRunUsage,
  WORKFLOW_STATUSES,
  classifyStatus,
  isFinished,
  mergeVariables,
  foldTrail,
  foldPendingDelegations,
  parkedStateOf,
  pendingParkOf,
  type PendingDelegation,
  type TrailStep,
  type WorkflowStateFields,
  workflowStateSchema,
  readReturns,
} from "./state.js";

describe("workflow state field definition", () => {
  it("declares every channel the schema carries, once", () => {
    const schemaFields = Object.keys(workflowStateSchema.shape).sort();
    expect(new Set(schemaFields).size).toBe(schemaFields.length);
    expect(schemaFields).toContain("parkPhase");
    expect(schemaFields).toContain("stateTurns");
  });

  it("parses a checkpoint written before the park phase and turn budget existed", () => {
    const parsed = workflowStateSchema.parse({ workflowState: "review", status: "running" });
    expect(parsed.parkPhase).toBeUndefined();
    expect(parsed.stateTurns).toBeUndefined();
  });

  it("reads the parked state a record names, or nothing without a record", () => {
    expect(parkedStateOf({ state: "review" })).toBe("review");
    expect(parkedStateOf(null)).toBe("");
  });

  it("finds the park a session holds on either channel", () => {
    const decision = { state: "review", seq: 1, transitions: [], createdAt: "t" };
    expect(pendingParkOf({ pendingDecision: decision })).toEqual({ channel: "decision", record: decision });
    const input = { state: "clarify", reason: "why", parkedAt: "t" };
    expect(pendingParkOf({ pendingInput: input })).toEqual({ channel: "input", record: input });
    expect(pendingParkOf({})).toBeNull();
  });
});

/**
 * Driven through a compiled graph rather than asserted on the schema object,
 * because what matters is the channel LangGraph builds from it.
 */
describe("state channels", () => {
  /** Two sequential nodes, each committing its own update. */
  async function foldTwoUpdates(
    first: Record<string, unknown>,
    second: Record<string, unknown>,
  ): Promise<WorkflowStateFields> {
    const graph = new StateGraph(workflowStateSchema)
      .addNode("first", () => first as never)
      .addNode("second", () => second as never)
      .addEdge(START, "first")
      .addEdge("first", "second")
      .addEdge("second", END)
      .compile();
    return (await graph.invoke({})) as WorkflowStateFields;
  }

  /** Two nodes in **one** super-step — what a tool batch with two writers produces. */
  async function foldConcurrentUpdates(
    left: Record<string, unknown>,
    right: Record<string, unknown>,
  ): Promise<WorkflowStateFields> {
    const graph = new StateGraph(workflowStateSchema)
      .addNode("left", () => left as never)
      .addNode("right", () => right as never)
      .addEdge(START, "left")
      .addEdge(START, "right")
      .addEdge("left", END)
      .addEdge("right", END)
      .compile();
    return (await graph.invoke({})) as WorkflowStateFields;
  }

  it("merges a variables delta instead of replacing the store", async () => {
    const settled = await foldTwoUpdates(
      { variables: { is_confirmed: { value: true, locked: true } } },
      {
        variables: {
          product: { value: "strawberries", locked: true },
          email: { value: "a@b.c", locked: true },
        },
      },
    );
    expect(Object.keys(settled.variables ?? {}).sort()).toEqual(["email", "is_confirmed", "product"]);
    expect(settled.variables?.is_confirmed?.value).toBe(true);
  });

  it("keeps a locked value when a later update rewrites it", async () => {
    const settled = await foldTwoUpdates(
      { variables: { case_id: { value: "K-9", locked: true } } },
      { variables: { case_id: { value: "K-10", locked: false } } },
    );
    expect(settled.variables?.case_id).toEqual({ value: "K-9", locked: true });
  });

  it("appends a trail delta", async () => {
    const seed: TrailStep = { to: "answer", kind: "trigger", reason: "chat", ts: 1 };
    const own: TrailStep = { to: "done", kind: "agent", reason: "answered", ts: 2 };
    const settled = await foldTwoUpdates({ auditTrail: [seed] }, { auditTrail: [own] });
    expect(settled.auditTrail).toEqual([seed, own]);
  });

  /**
   * A middleware hook echoes the whole state it read, so a hook that never
   * touched the trail still writes it back. That write must change nothing —
   * the alternative is a trail that doubles on every hook execution.
   */
  it("leaves the trail alone when a hook echoes the list it read", async () => {
    const first: TrailStep = { to: "start", kind: "trigger", reason: "manual", ts: 1 };
    const second: TrailStep = { to: "work", kind: "agent", reason: "go", ts: 2 };
    const settled = await foldTwoUpdates({ auditTrail: [first, second] }, { auditTrail: [first, second] });
    expect(settled.auditTrail).toEqual([first, second]);
  });

  it("takes an update that extends the list it holds", async () => {
    const first: TrailStep = { to: "enrich", kind: "sub-workflow", ts: 1, workflow: "a" };
    const second: TrailStep = { to: "enrich", kind: "sub-workflow", ts: 2, workflow: "b" };
    const settled = await foldTwoUpdates({ auditTrail: [first] }, { auditTrail: [first, second] });
    expect(settled.auditTrail).toEqual([first, second]);
  });

  it("keeps both steps when two writers commit deltas in one super-step", async () => {
    const left: TrailStep = { to: "process", kind: "sub-workflow", ts: 2, workflow: "returns", status: "ok" };
    const right: TrailStep = { ...left, ts: 3 };
    const settled = await foldConcurrentUpdates({ auditTrail: [left] }, { auditTrail: [right] });
    expect(settled.auditTrail).toHaveLength(2);
    expect(settled.auditTrail).toEqual(expect.arrayContaining([left, right]));
  });

  it("keeps two steps identical in every field when they are two records", () => {
    const arrival: TrailStep = { to: "enrich", kind: "trigger", reason: "manual", ts: 1 };
    const step = (): TrailStep => ({ to: "enrich", kind: "sub-workflow", ts: 7, workflow: "orders", status: "ok" });
    const a = step();
    const b = step();
    const folded = foldTrail(foldTrail([arrival], [a]), [b]);
    expect(folded).toHaveLength(3);
    // …while the same record written twice lands once.
    expect(foldTrail(folded, [a])).toHaveLength(3);
  });

  const park = (workflow: string, ordinal = 0): PendingDelegation => ({
    state: "enrich",
    workflow,
    toolCallId: `call-${workflow}`,
    identity: `enrich:${workflow}:${ordinal}`,
    dispatchId: `d-${workflow}`,
    decision: { state: "review", seq: 1, transitions: [{ to: "done", description: "Test edge to done." }], createdAt: "2026-08-17T00:00:00.000Z" },
  });

  it("appends parked delegations, so a batch never loses all but one", async () => {
    const settled = await foldConcurrentUpdates(
      { pendingDelegations: [park("a")] },
      { pendingDelegations: [park("b")] },
    );
    expect(settled.pendingDelegations?.map((d) => d.workflow).sort()).toEqual(["a", "b"]);
  });

  it("holds a delegation once however many hooks echo it", () => {
    const held = foldPendingDelegations([], [park("a")]);
    expect(foldPendingDelegations(held, held)).toEqual(held);
    expect(foldPendingDelegations(held, [park("a")])).toHaveLength(1);
  });

  it("replaces the queue with what remains after a decision, and clears it on null", () => {
    const held = foldPendingDelegations([park("a"), park("b")], undefined);
    expect(foldPendingDelegations(held, { remaining: [park("b")] }).map((d) => d.workflow)).toEqual(["b"]);
    expect(foldPendingDelegations(held, null)).toEqual([]);
  });

  it("still replaces a last-value field", async () => {
    const settled = await foldTwoUpdates({ workflowState: "first" }, { workflowState: "second" });
    expect(settled.workflowState).toBe("second");
  });

  /**
   * Usage is last-value on purpose: an additive channel cannot tell a hook
   * echoing the total from a delta that happens to equal it. The one writer adds
   * its delta to the total it reads.
   */
  it("keeps usage as the last total written", async () => {
    const settled = await foldTwoUpdates(
      { usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 } },
      { usage: { inputTokens: 150, outputTokens: 15, cacheReadTokens: 0, cacheCreationTokens: 0 } },
    );
    expect(settled.usage?.inputTokens).toBe(150);
  });
});

describe("open/finished partition", () => {
  it("classifies a run that is over as finished", () => {
    expect(isFinished(WORKFLOW_STATUSES.completed)).toBe(true);
    expect(isFinished(WORKFLOW_STATUSES.rejected)).toBe(true);
    expect(classifyStatus(WORKFLOW_STATUSES.completed)).toBe("finished");
  });

  it("classifies a suspended run as open — a park is not done", () => {
    expect(isFinished(WORKFLOW_STATUSES.awaitingDecision)).toBe(false);
    expect(isFinished(WORKFLOW_STATUSES.awaitingInput)).toBe(false);
    expect(isFinished(WORKFLOW_STATUSES.running)).toBe(false);
    expect(classifyStatus(WORKFLOW_STATUSES.awaitingInput)).toBe("open");
  });

  it("treats an absent or unknown status as open rather than guessing", () => {
    expect(isFinished(undefined)).toBe(false);
    expect(classifyStatus("mystery")).toBe("open");
  });

  it("covers every declared status exactly once", () => {
    const statuses = Object.values(WORKFLOW_STATUSES);
    const finished = statuses.filter((s) => isFinished(s));
    const open = statuses.filter((s) => !isFinished(s));
    expect(finished.length + open.length).toBe(statuses.length);
    expect(finished.sort()).toEqual(["completed", "rejected"]);
  });
});

describe("delivery re-seeding", () => {
  const settled = { trigger: { value: "manual", locked: true } };

  it("replaces a settled value only when the delivery marker is set", () => {
    const ordinary = mergeVariables(settled, { trigger: { value: "email_reply", locked: true } });
    expect(ordinary.trigger?.value).toBe("manual");
    const seeded = mergeVariables(settled, { trigger: { value: "email_reply", locked: true, reseed: true } });
    expect(seeded.trigger?.value).toBe("email_reply");
  });

  it("does not persist the marker, so a later ordinary write still sees a locked value", () => {
    const seeded = mergeVariables(settled, { trigger: { value: "email_reply", locked: true, reseed: true } });
    expect(seeded.trigger).toEqual({ value: "email_reply", locked: true });
    expect(mergeVariables(seeded, { trigger: { value: "x", locked: false } }).trigger?.value).toBe("email_reply");
  });

  it("folds a store onto itself without changing it", () => {
    const store = { a: { value: 1, locked: true }, b: { value: 2, locked: false } };
    expect(mergeVariables(store, store)).toEqual(store);
  });
});

describe("readReturns", () => {
  const state = {
    variables: {
      summary: { value: "ok", locked: false },
      score: { value: 3, locked: false },
      other: { value: "x", locked: false },
    },
  };

  it("pairs the declaration with the settled values", () => {
    expect(readReturns(state, ["summary", "score"])).toEqual({ summary: "ok", score: 3 });
  });

  it("reads exactly the declared names", () => {
    expect(readReturns(state, ["summary"])).toEqual({ summary: "ok" });
    expect(readReturns(state, ["missing"])).toEqual({ missing: undefined });
  });

  it("is undefined when nothing is declared", () => {
    expect(readReturns(state, undefined)).toBeUndefined();
    expect(readReturns(state, [])).toBeUndefined();
  });
});

describe("usage", () => {
  it("reads a checkpoint carrying no usage as zeroed", () => {
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    expect(readRunUsage({})).toEqual(zero);
    expect(readRunUsage({ usage: undefined })).toEqual(zero);
  });
});
