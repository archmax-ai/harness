import { describe, expect, it } from "vitest";
import { ToolMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import type { MountPrefixes } from "../core/zones.js";
import { decide } from "../kernel/kernel.js";
import { WorkflowMachine } from "../machine/machine.js";
import type { MachineSpec } from "../machine/types.js";
import {
  advanceEvidence,
  createControlTools,
  entryStateOf,
  handleAdvance,
  handleRaise,
  handleReset,
  handleSetVariables,
  handleWait,
  MAX_ADVANCE_EVIDENCE,
  MAX_RAISE_CODE,
  RAISE_TOOL,
  RESET_TOOL,
  resolveWaitUntil,
  transitionRefusal,
  transitionUpdate,
  validateAdvanceEvidence,
  WAIT_TOOL,
} from "./control-tools.js";
import { SET_VARIABLES_TOOL } from "../machine/tool-names.js";
import { mergeVariables, type WorkflowStateFields } from "./state.js";
import type { VariableStore } from "../machine/variables.js";

function commandUpdate(result: unknown): Record<string, unknown> {
  expect(result).toBeInstanceOf(Command);
  return (result as Command).update as Record<string, unknown>;
}

// --- Evidence -----------------------------------------------------------------

const mounts: MountPrefixes = { dirs: ["data", "workflows"], files: ["AGENTS.md"], writable: [], governed: [], unsearchable: [] };

function refused(paths: string[]): string {
  const result = validateAdvanceEvidence(paths, mounts);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.reason;
}

function accepted(paths: string[]): string[] {
  const result = validateAdvanceEvidence(paths, mounts);
  expect(result.ok, result.ok ? "" : result.reason).toBe(true);
  return result.ok ? result.paths : [];
}

describe("validateAdvanceEvidence", () => {
  it("accepts every zone the agent can read", () => {
    expect(
      accepted(["scratchpad/refund.json", "notes/summary.md", "data/orders.json", "large_tool_results/x.txt"]),
    ).toEqual(["scratchpad/refund.json", "notes/summary.md", "data/orders.json", "large_tool_results/x.txt"]);
  });

  it("accepts an empty list", () => {
    expect(accepted([])).toEqual([]);
  });

  it("refuses a path that escapes the workspace", () => {
    expect(refused(["../etc/passwd"])).toMatch(/outside the workspace/);
  });

  it("refuses a runtime-internal path", () => {
    expect(refused(["checkpoints/cp-1.json"])).toMatch(/runtime-internal/);
  });

  it("refuses the workspace root and an empty entry", () => {
    expect(refused([""])).toMatch(/empty/);
    expect(refused(["."])).toMatch(/empty/);
  });

  it("refuses more paths than the bound allows", () => {
    const many = Array.from({ length: MAX_ADVANCE_EVIDENCE + 1 }, (_, i) => `scratchpad/${i}.md`);
    expect(refused(many)).toMatch(/at most/);
  });

  it("canonicalizes and de-duplicates equivalent spellings, keeping first position", () => {
    expect(accepted([" scratchpad/a.md ", "./scratchpad/a.md", "scratchpad/b.md"])).toEqual([
      "scratchpad/a.md",
      "scratchpad/b.md",
    ]);
  });
});

// --- archmax_advance -----------------------------------------------------------

const REVIEW: MachineSpec = {
  states: {
    a: { triggers: { manual: null }, transitions: [{ to: "b", description: "Test edge to b." }, { to: "review", description: "Test edge to review." }] },
    b: {},
    review: {
      type: "human",
      title: "Review",
      evidence: ["scratchpad/draft.md"],
      transitions: [{ to: "b", type: "approve", description: "Test edge to b." }],
    },
  },
};
const machine = WorkflowMachine.fromSpec(REVIEW);

function advance(args: Record<string, unknown>, state: Record<string, unknown> = { workflowState: "a" }) {
  return handleAdvance({ machine }, { toolCallId: "call-1", args, state });
}

describe("handleAdvance", () => {
  it("advances with a reason and commits the move", () => {
    const outcome = advance({ to: "b", reason: "answer is complete" });
    expect(outcome.moved).toEqual({ from: "a", to: "b", reason: "answer is complete" });
    const update = commandUpdate(outcome.message);
    expect(update.workflowState).toBe("b");
    expect(update.auditTrail).toMatchObject([{ to: "b", kind: "agent", reason: "answer is complete" }]);
    const [message] = update.messages as ToolMessage[];
    expect(String(message!.content)).toContain("Advanced to state 'b'");
    expect(message!.tool_call_id).toBe("call-1");
  });

  it("opens a park in its closing phase when the target is a human state", () => {
    const outcome = advance(
      { to: "review", reason: "ready", evidence: ["scratchpad/notes.md"] },
      { workflowState: "a", decisionCount: 1 },
    );
    const update = commandUpdate(outcome.message);
    expect(update.status).toBe("awaiting_decision");
    expect(update.parkPhase).toBe("closing");
    expect(update.decisionCount).toBe(2);
    expect(update.pendingDecision).toBe(outcome.moved?.park);
    expect(outcome.moved?.park).toMatchObject({
      state: "review",
      title: "Review",
      seq: 2,
      // Declared evidence first, the attachment after.
      evidence: ["scratchpad/draft.md", "scratchpad/notes.md"],
      transitions: [{ to: "b", type: "approve", description: "Test edge to b." }],
    });
  });

  it("refuses evidence attached to an agent target, without moving", () => {
    const outcome = advance({ to: "b", reason: "go", evidence: ["scratchpad/x.md"] });
    expect(outcome.moved).toBeUndefined();
    expect((outcome.message as ToolMessage).status).toBe("error");
    expect(String((outcome.message as ToolMessage).content)).toMatch(/not one/);
  });

  // A refused transition is the agent's to correct: it replies without erroring
  // the message and commits nothing — no position, no trail step, no rejection.
  it("refuses an edge the state does not declare, naming the valid targets", () => {
    const outcome = advance({ to: "nowhere", reason: "guessing" });
    expect(outcome.moved).toBeUndefined();
    expect(outcome.message).toBeInstanceOf(ToolMessage);
    const message = outcome.message as ToolMessage;
    expect(message.status).toBeUndefined();
    expect(String(message.content)).toBe(
      "archmax_advance rejected: cannot advance from 'a' to 'nowhere'. Valid target slugs: b, review.",
    );
  });

  it("refuses to leave a state that still owes a required variable, then moves once it is set", () => {
    const owing = WorkflowMachine.fromSpec({
      states: {
        a: { triggers: { manual: null }, requires: ["verdict"], transitions: [{ to: "b", description: "Test edge to b." }] },
        b: {},
      },
    });
    const refused = handleAdvance(
      { machine: owing },
      { toolCallId: "call-1", args: { to: "b", reason: "done" }, state: { workflowState: "a", variables: {} } },
    );
    expect(refused.moved).toBeUndefined();
    expect((refused.message as ToolMessage).status).toBeUndefined();
    expect(String((refused.message as ToolMessage).content)).toBe(
      "archmax_advance rejected: cannot leave 'a' yet: 'verdict' is not set. Record it with " +
        "archmax_set_variables, then advance.",
    );

    const moved = handleAdvance(
      { machine: owing },
      {
        toolCallId: "call-2",
        args: { to: "b", reason: "done" },
        state: { workflowState: "a", variables: { verdict: { value: "ok", locked: false } } },
      },
    );
    expect(moved.moved).toMatchObject({ from: "a", to: "b" });
  });

  it("clears an earlier rejection marker on success", () => {
    const update = commandUpdate(advance({ to: "b", reason: "advance" }, { workflowState: "a", rejected: "earlier" }).message);
    expect(update.rejected).toBeNull();
    expect(update.failedDelegations).toBeNull();
  });

  it("rejects a call with an empty or missing reason without moving", () => {
    for (const args of [{ to: "b", reason: "" }, { to: "b" }]) {
      const outcome = advance(args);
      expect(outcome.moved).toBeUndefined();
      expect((outcome.message as ToolMessage).status).toBe("error");
    }
  });
});

/**
 * The update every mover commits: the session's agent through `handleAdvance`,
 * and a grader or code state's run when it settles.
 */
describe("transitionUpdate", () => {
  it("records the mover as the trail step's kind", () => {
    for (const kind of ["agent", "grader", "code"] as const) {
      const { update, park } = transitionUpdate(machine, { workflowState: "a" }, { to: "b", kind, reason: "checked" });
      expect(update).toMatchObject({ workflowState: "b", rejected: null });
      expect(update.auditTrail).toMatchObject([{ to: "b", kind, reason: "checked" }]);
      expect(park).toBeUndefined();
      // Messages are the caller's: a tool reply, or a runtime note.
      expect(update.messages).toBeUndefined();
    }
  });

  it("commits the park record with a move into a human state", () => {
    const { update, park } = transitionUpdate(
      machine,
      { workflowState: "a" },
      { to: "review", kind: "code", reason: "ready", evidence: ["scratchpad/notes.md"] },
    );
    expect(park).toMatchObject({ state: "review", seq: 1, evidence: ["scratchpad/draft.md", "scratchpad/notes.md"] });
    expect(update).toMatchObject({
      pendingDecision: park,
      decisionCount: 1,
      status: "awaiting_decision",
      parkPhase: "closing",
    });
  });
});

describe("transitionRefusal", () => {
  const owing = WorkflowMachine.fromSpec({
    states: {
      a: { triggers: { manual: null }, requires: ["verdict"], transitions: [{ to: "b", description: "Test edge to b." }] },
      b: {},
    },
  });

  it("checks the state's requires before the edge, against the variables it is given", () => {
    expect(transitionRefusal(owing, "a", "nowhere", {})).toMatch(/cannot leave 'a' yet: 'verdict' is not set/);
    const set = { verdict: { value: "ok", locked: false } };
    expect(transitionRefusal(owing, "a", "nowhere", set)).toMatch(/cannot advance from 'a' to 'nowhere'/);
    expect(transitionRefusal(owing, "a", "b", set)).toBeUndefined();
  });

  it("says a terminal state has nowhere to go", () => {
    expect(transitionRefusal(owing, "b", "a", {})).toMatch(/No transitions from this state/);
  });
});

describe("advanceEvidence", () => {
  it("accepts no attachment for any target", () => {
    expect(advanceEvidence(machine, "b", [])).toEqual({ ok: true, paths: [] });
  });

  it("accepts an attachment only into a human state, validated as the agent's own reads", () => {
    expect(advanceEvidence(machine, "review", ["./scratchpad/a.md"], mounts)).toEqual({
      ok: true,
      paths: ["scratchpad/a.md"],
    });
    const refused = advanceEvidence(machine, "b", ["scratchpad/a.md"]);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.reason).toMatch(/'b' is not one/);
    expect(advanceEvidence(machine, "review", ["checkpoints/cp-1.json"]).ok).toBe(false);
  });
});

// --- archmax_wait ----------------------------------------------------------------

const NOW = Date.parse("2026-08-12T09:00:00.000Z");

describe("resolveWaitUntil", () => {
  it("resolves each relative unit against the given clock", () => {
    expect(resolveWaitUntil("90ms", NOW).resumeAt).toBe("2026-08-12T09:00:00.090Z");
    expect(resolveWaitUntil("30s", NOW).resumeAt).toBe("2026-08-12T09:00:30.000Z");
    expect(resolveWaitUntil("45m", NOW).resumeAt).toBe("2026-08-12T09:45:00.000Z");
    expect(resolveWaitUntil("2h", NOW).resumeAt).toBe("2026-08-12T11:00:00.000Z");
    expect(resolveWaitUntil("1d", NOW).resumeAt).toBe("2026-08-13T09:00:00.000Z");
  });

  it("accepts an absolute instant as given, respecting an offset", () => {
    expect(resolveWaitUntil("2026-09-01T06:30:00Z", NOW).resumeAt).toBe("2026-09-01T06:30:00.000Z");
    expect(resolveWaitUntil("2026-09-01", NOW).resumeAt).toBe("2026-09-01T00:00:00.000Z");
    expect(resolveWaitUntil("2026-09-01T08:30:00+02:00", NOW).resumeAt).toBe("2026-09-01T06:30:00.000Z");
  });

  it("accepts an instant already past — due immediately", () => {
    expect(resolveWaitUntil("2026-08-11T09:00:00Z", NOW).resumeAt).toBe("2026-08-11T09:00:00.000Z");
  });

  it("tolerates surrounding whitespace", () => {
    expect(resolveWaitUntil("  1d  ", NOW).resumeAt).toBe("2026-08-13T09:00:00.000Z");
  });

  it("refuses prose, malformed durations, empty input, and non-positive durations", () => {
    for (const bad of ["tomorrow morning", "1 day", "d1", "1w", "soon", "", "   ", "0m", "-5m"]) {
      const result = resolveWaitUntil(bad, NOW);
      expect(result.resumeAt, bad).toBeUndefined();
      expect(result.error, bad).toBeTruthy();
    }
  });

  it("refuses a date-shaped value that is not a real date", () => {
    expect(resolveWaitUntil("2026-13-45", NOW).error).toBeTruthy();
  });
});

const WAITING: MachineSpec = {
  states: {
    clarify: { triggers: { manual: null }, title: "Clarify", budget: { maxParks: 2 }, transitions: [{ to: "answer", description: "Test edge to answer." }] },
    answer: {},
  },
};
const waiting = WorkflowMachine.fromSpec(WAITING);

function wait(
  args: Record<string, unknown> = { reason: "waiting for the customer's reply" },
  state: Record<string, unknown> = { workflowState: "clarify", messages: [] },
) {
  return handleWait(waiting, { toolCallId: "call-1", args, state });
}

describe("handleWait", () => {
  it("commits the pending-input record with the agent's reason and the state's title", () => {
    const outcome = wait();
    const update = commandUpdate(outcome.message);
    expect(update.pendingInput).toMatchObject({
      state: "clarify",
      title: "Clarify",
      reason: "waiting for the customer's reply",
    });
    expect(update.status).toBe("awaiting_input");
    expect(outcome.park).toBe(update.pendingInput);
    expect(typeof outcome.park?.parkedAt).toBe("string");
  });

  it("moves the run nowhere", () => {
    const update = commandUpdate(wait().message);
    expect(update.workflowState).toBeUndefined();
    expect(update.auditTrail).toBeUndefined();
  });

  it("owes a closing turn on silence, and none when the model already spoke", () => {
    expect(commandUpdate(wait().message).parkPhase).toBe("closing");
    const spoken = wait(undefined, {
      workflowState: "clarify",
      messages: [{ getType: () => "human", content: "hi" }, { getType: () => "ai", content: "which order?" }],
    });
    expect(commandUpdate(spoken.message).parkPhase).toBe("suspend");
  });

  it("counts the park against the state's budget", () => {
    const update = commandUpdate(wait(undefined, { workflowState: "clarify", parkCounts: { clarify: 1 } }).message);
    expect(update.parkCounts).toEqual({ clarify: 2 });
  });

  it("commits an exhausted park budget as a rejection rather than a park", () => {
    const outcome = wait(undefined, { workflowState: "clarify", parkCounts: { clarify: 2 } });
    expect(outcome.park).toBeUndefined();
    expect(outcome.exhausted).toMatch(/maxParks: 2/);
    const update = commandUpdate(outcome.message);
    expect(update.rejected).toMatch(/exhausted its park budget/);
    expect(update.pendingInput).toBeUndefined();
  });

  it("tells the model it is parked and should stop", () => {
    const [message] = commandUpdate(wait().message).messages as ToolMessage[];
    expect(String(message!.content)).toContain("clarify");
    expect(String(message!.content)).toContain("stop working");
  });

  it("records a due time, resolved to an absolute instant, and says the runtime schedules nothing", () => {
    const outcome = wait({ reason: "overnight", until: "1d" });
    const parkedAt = Date.parse(outcome.park!.parkedAt);
    expect(Date.parse(outcome.park!.resumeAt!) - parkedAt).toBeGreaterThanOrEqual(86_400_000 - 1000);
    const [message] = commandUpdate(outcome.message).messages as ToolMessage[];
    expect(String(message!.content)).toMatch(/Nothing is scheduled by the runtime/);
  });

  it("omits the due time when no until is given", () => {
    expect(wait().park).not.toHaveProperty("resumeAt");
  });

  it("refuses an unparseable due time rather than parking without it", () => {
    const outcome = wait({ reason: "overnight", until: "tomorrow morning" });
    expect(outcome.message).toBeInstanceOf(ToolMessage);
    const content = String((outcome.message as ToolMessage).content);
    expect(content).toContain(WAIT_TOOL);
    expect(content).toMatch(/relative duration/);
    expect(content).toMatch(/ISO-8601/);
  });

  it("rejects an empty or missing reason without parking", () => {
    for (const args of [{ reason: "" }, {}]) {
      const outcome = wait(args);
      expect(outcome.message).toBeInstanceOf(ToolMessage);
      expect(outcome.park).toBeUndefined();
      expect(String((outcome.message as ToolMessage).content)).toContain("reason");
    }
  });
});

describe("wait tool declaration", () => {
  it("declares a required reason and an optional due time", () => {
    const tool = createControlTools().find((t) => t.name === WAIT_TOOL)!;
    expect(tool.name).toBe(WAIT_TOOL);
    expect(Object.keys((tool.schema as { shape: Record<string, unknown> }).shape)).toEqual(["reason", "until"]);
  });
});

describe("wait tool governance", () => {
  const spec = {
    states: {
      work: { triggers: { manual: null }, tools: { allow: [{ tool: "read_file" }] }, transitions: [{ to: "done", description: "Test edge to done." }] },
      done: {},
    },
  };

  it("is permitted and disclosed in every state, terminal ones included", () => {
    const m = WorkflowMachine.fromSpec(spec as never);
    for (const state of ["work", "done"]) {
      expect(m.checkAllowed(state, WAIT_TOOL, {})).toBe(true);
      expect(m.disclosedTools(state).has(WAIT_TOOL)).toBe(true);
    }
    expect(m.disclosedTools("done").has("archmax_advance")).toBe(false);
  });

  // A script frame is not durable and a grader judges rather than waits: nothing
  // an automated state runs can park.
  it("is neither offered nor permitted in an automated state", () => {
    const m = WorkflowMachine.fromSpec({
      states: {
        ...spec.states,
        check: { type: "code", script: "scripts/check.js", transitions: [{ to: "done", description: "Checked." }] },
        grade: { type: "grader", instructions: "Grade it.", transitions: [{ to: "done", description: "Good." }] },
      },
    } as never);
    for (const state of ["check", "grade"]) {
      expect(m.checkAllowed(state, WAIT_TOOL, {})).toBe(false);
      expect(m.disclosedTools(state).has(WAIT_TOOL)).toBe(false);
    }
  });

  it("is removable workflow-wide by a denial", () => {
    const m = WorkflowMachine.fromSpec({
      ...spec,
      tools: { forbid_always: [{ tool: WAIT_TOOL }] },
    } as never);
    expect(m.disclosedTools("work").has(WAIT_TOOL)).toBe(false);
    const verdict = decide(m, { kind: "tool-call", state: "work", tool: WAIT_TOOL, args: {} });
    expect(verdict.decision).toBe("block");
    expect(verdict.ruleId).toBe("tool.forbidden");
  });
});

// --- archmax_raise ---------------------------------------------------------------

const RAISING: MachineSpec = {
  states: {
    lookup: { triggers: { manual: null }, transitions: [{ to: "answer", description: "Test edge to answer." }] },
    answer: {},
  },
};
const raising = WorkflowMachine.fromSpec(RAISING);

/** A state whose last assistant message makes `calls` (the raise among them, as `call-1`). */
function raisingState(calls: { id: string; name: string }[] = [{ id: "call-1", name: RAISE_TOOL }]) {
  return {
    workflowState: "lookup",
    rejected: "an earlier sub-run failed",
    messages: [{ type: "ai", content: "", tool_calls: calls.map((c) => ({ ...c, args: {} })) }],
  };
}

function raise(
  args: Record<string, unknown> = { code: "orders-unavailable", reason: "The orders API failed three times." },
  state: Record<string, unknown> = raisingState(),
) {
  return handleRaise(raising, { toolCallId: "call-1", args, state });
}

function refusalText(message: unknown): string {
  expect(message).toBeInstanceOf(ToolMessage);
  const reply = message as ToolMessage;
  expect(reply.status).toBe("error");
  return String(reply.content);
}

describe("handleRaise", () => {
  it("commits the record, the failed status and a cleared rejection", () => {
    const outcome = raise();
    const update = commandUpdate(outcome.message);
    const record = { code: "orders-unavailable", reason: "The orders API failed three times.", state: "lookup" };
    expect(update.raised).toEqual(record);
    expect(outcome.raised).toEqual(record);
    expect(update.status).toBe("failed");
    expect(update.rejected).toBeNull();
    // The position stays, and nothing joins the trail: a raise moves nothing.
    expect(update.workflowState).toBeUndefined();
    expect(update.auditTrail).toBeUndefined();
    const reply = (update.messages as ToolMessage[])[0]!;
    expect(reply.status).not.toBe("error");
    expect(String(reply.content)).toMatch(/ended as failed/);
  });

  it("trims what it records", () => {
    const outcome = raise({ code: "  orders-unavailable ", reason: " down \n" });
    expect(outcome.raised).toMatchObject({ code: "orders-unavailable", reason: "down" });
  });

  it("refuses an empty, overlong or multi-line code, naming the field", () => {
    for (const code of ["", "   ", "x".repeat(MAX_RAISE_CODE + 1), "orders\nunavailable"]) {
      const outcome = raise({ code, reason: "down" });
      expect(outcome.raised, JSON.stringify(code)).toBeUndefined();
      expect(refusalText(outcome.message)).toMatch(/archmax_raise rejected: invalid arguments — code:/);
    }
    expect(raise({ code: "x".repeat(MAX_RAISE_CODE), reason: "down" }).raised).toBeDefined();
  });

  it("refuses a missing or empty reason, naming the field", () => {
    for (const args of [{ code: "x" }, { code: "x", reason: "  " }]) {
      const outcome = raise(args);
      expect(outcome.raised).toBeUndefined();
      expect(refusalText(outcome.message)).toMatch(/reason:/);
    }
  });

  it("refuses a raise made beside other calls, and commits nothing", () => {
    const state = raisingState([
      { id: "call-0", name: "read_file" },
      { id: "call-1", name: RAISE_TOOL },
    ]);
    const outcome = raise(undefined, state);
    expect(outcome.raised).toBeUndefined();
    expect(refusalText(outcome.message)).toMatch(/1 other tool call\b.*stand alone/s);
  });

  it("reads the message that carries the call, not a later one", () => {
    const state = {
      workflowState: "lookup",
      messages: [
        { type: "ai", content: "", tool_calls: [{ id: "call-1", name: RAISE_TOOL, args: {} }] },
        { type: "ai", content: "", tool_calls: [{ id: "x", name: "ls", args: {} }, { id: "y", name: "ls", args: {} }] },
      ],
    };
    expect(raise(undefined, state).raised).toBeDefined();
  });
});

describe("raise tool declaration and governance", () => {
  it("declares a code and a reason, and no success flag", () => {
    const tool = createControlTools().find((t) => t.name === RAISE_TOOL)!;
    expect(Object.keys((tool.schema as { shape: Record<string, unknown> }).shape)).toEqual(["code", "reason"]);
    expect(tool.description).toMatch(/when the task cannot be completed/);
    expect(tool.description).toMatch(/Never call it to finish work that worked/);
    // A reply that only explains the failure is the miss it has to prevent.
    expect(tool.description).toMatch(/a reply that only explains the failure reports it as one/);
    expect(tool.description).toMatch(/Call it alone/);
  });

  it("is permitted without a grant and disclosed in every state, terminal ones included", () => {
    for (const state of ["lookup", "answer"]) {
      expect(raising.checkAllowed(state, RAISE_TOOL, {})).toBe(true);
      expect(raising.disclosedTools(state).has(RAISE_TOOL)).toBe(true);
    }
  });

  it("is removable workflow-wide, and per state, by a denial", () => {
    const everywhere = WorkflowMachine.fromSpec({ ...RAISING, tools: { forbid_always: [{ tool: RAISE_TOOL }] } } as never);
    expect(everywhere.disclosedTools("lookup").has(RAISE_TOOL)).toBe(false);
    expect(decide(everywhere, { kind: "tool-call", state: "answer", tool: RAISE_TOOL, args: {} }).decision).toBe("block");

    const here = WorkflowMachine.fromSpec({
      states: {
        ...RAISING.states,
        lookup: { ...RAISING.states.lookup, tools: { forbid: [{ tool: RAISE_TOOL }] } },
      },
    } as never);
    expect(here.disclosedTools("lookup").has(RAISE_TOOL)).toBe(false);
    expect(here.disclosedTools("answer").has(RAISE_TOOL)).toBe(true);
    const verdict = decide(here, { kind: "tool-call", state: "lookup", tool: RAISE_TOOL, args: {} });
    expect(verdict.decision).toBe("block");
    expect(decide(here, { kind: "tool-call", state: "answer", tool: RAISE_TOOL, args: {} }).decision).toBe("allow");
  });

  it("is refused on a reply-only turn", () => {
    const verdict = decide(raising, { kind: "tool-call", state: "lookup", tool: RAISE_TOOL, args: {}, replyOnly: true });
    expect(verdict.decision).toBe("block");
    expect(verdict.ruleId).toBe("tool.reply-only");
  });
});

// --- archmax_reset ---------------------------------------------------------------

/** Just enough machine for the entry-state fallback. */
const resetMachine = {
  entry: "identify-case",
  startStateForTrigger: (id: string) =>
    id === "report_requested" ? "report-requested" : id === "manual" ? "identify-case" : undefined,
} as unknown as WorkflowMachine;

function reset(state: Partial<WorkflowStateFields>, args: Record<string, unknown> = { reason: "wrong branch" }) {
  return handleReset(resetMachine, { toolCallId: "call-1", args, state });
}

describe("entryStateOf", () => {
  it("prefers the recorded entry state", () => {
    expect(entryStateOf({ entryState: "report-requested", trigger: { id: "manual" } }, resetMachine)).toBe(
      "report-requested",
    );
  });

  it("falls back to the trigger's start state on a pre-change checkpoint", () => {
    expect(entryStateOf({ trigger: { id: "report_requested" } }, resetMachine)).toBe("report-requested");
  });

  it("falls back to the machine entry when the trigger resolves nothing", () => {
    expect(entryStateOf({ trigger: { id: "unknown" } }, resetMachine)).toBe("identify-case");
    expect(entryStateOf({}, resetMachine)).toBe("identify-case");
  });
});

describe("handleReset", () => {
  const parked: Partial<WorkflowStateFields> = {
    workflowState: "orders-question",
    entryState: "identify-case",
    trigger: { id: "manual" },
    rejected: "an earlier refusal",
    auditTrail: [
      { to: "identify-case", kind: "trigger", reason: "manual", ts: 1 },
      { to: "orders-question", kind: "agent", reason: "order question", ts: 2 },
    ],
    variables: { from_email: { value: "a@b.com", locked: true } },
  };

  it("returns the run to its recorded entry state and reports the move", () => {
    const outcome = reset(parked);
    expect(commandUpdate(outcome.message).workflowState).toBe("identify-case");
    expect(outcome.moved).toEqual({ from: "orders-question", to: "identify-case" });
  });

  it("clears the bookkeeping that gates progress", () => {
    const u = commandUpdate(reset(parked).message);
    expect(u.rejected).toBeNull();
  });

  it("tells the agent what was kept", () => {
    const [message] = commandUpdate(reset(parked).message).messages as ToolMessage[];
    expect(String(message!.content)).toBe(
      "Reset to state 'identify-case'. Earlier work in the conversation and in scratchpad/ is untouched.",
    );
  });

  it("records only the reset step, leaving the history to the channel", () => {
    const trail = commandUpdate(reset(parked).message).auditTrail as Array<Record<string, unknown>>;
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ to: "identify-case", kind: "reset", reason: "wrong branch" });
  });

  it("leaves the host's variables and messages alone", () => {
    const u = commandUpdate(reset(parked).message);
    expect(u.variables).toBeUndefined();
    expect((u.messages as unknown[]).length).toBe(1);
  });

  it("releases the locks the agent set, keeping their values, and no other lock", () => {
    const u = commandUpdate(
      reset({
        ...parked,
        variables: {
          from_email: { value: "a@b.com", locked: true },
          case_id: { value: "K-9", locked: true, lockedBy: "agent" },
          note: { value: "n", locked: false },
        },
      }).message,
    );
    expect(u.variables).toEqual({ case_id: { value: "K-9", locked: false, reseed: true } });
    const reply = String(((u.messages as unknown[])[0] as ToolMessage).content);
    expect(reply).toContain("'case_id' can be written again");
    // Folded into the store, the agent's lock is gone and the host's is not.
    const held = mergeVariables(
      { from_email: { value: "a@b.com", locked: true }, case_id: { value: "K-9", locked: true, lockedBy: "agent" } },
      u.variables as VariableStore,
    );
    expect(held).toEqual({ from_email: { value: "a@b.com", locked: true }, case_id: { value: "K-9", locked: false } });
  });

  it("rejects an empty or missing reason without moving the run", () => {
    for (const args of [{ reason: "" }, {}]) {
      const outcome = reset(parked, args);
      expect(outcome.message).toBeInstanceOf(ToolMessage);
      expect(outcome.moved).toBeUndefined();
      expect(String((outcome.message as ToolMessage).content)).toContain(RESET_TOOL);
    }
  });

  it("resets a session checkpointed before entryState existed", () => {
    const legacy = { ...parked, entryState: undefined, trigger: { id: "report_requested" } };
    expect(commandUpdate(reset(legacy).message).workflowState).toBe("report-requested");
  });
});

describe("reset tool declaration", () => {
  const description = () => createControlTools().find((t) => t.name === RESET_TOOL)!.description;

  // A reset is not a ritual for a new turn: one from where it would land moves nothing.
  it("says when a reset is not needed", () => {
    expect(description()).toMatch(/Not needed when this state can serve the message/);
    expect(description()).toMatch(/never from the state the conversation began in/);
  });

  it("asks for one only in a terminal state the run moved into", () => {
    expect(description()).toMatch(/a terminal state the run moved into and finished in/);
  });
});

describe("handleSetVariables — typed returns", () => {
  const typedMachine = WorkflowMachine.fromSpec({
    states: {
      work: {
        triggers: {
          manual: { returns: [{ name: "approved", type: "boolean" }, { name: "note" }] },
          other: null,
        },
      },
    },
  } as MachineSpec);
  const state = (trigger = "manual") => ({ trigger: { id: trigger }, variables: {} });
  const set = (variables: Record<string, unknown>, trigger?: string) =>
    handleSetVariables(
      { toolCallId: "c1", args: { variables }, state: state(trigger) },
      typedMachine,
    );

  it("refuses a mistyped return atomically, naming the variable, the type and the trigger", () => {
    const outcome = set({ approved: "yes", scratch: 1 });
    expect(outcome.delta).toBeUndefined();
    const text = String(outcome.message.content);
    expect(outcome.message.status).toBe("error");
    expect(text).toContain("'approved' must be a boolean");
    expect(text).toContain('a string ("yes")');
    expect(text).toContain("trigger 'manual'");
    expect(text).toContain("Nothing was written");
  });

  it("writes a conforming return", () => {
    const outcome = set({ approved: true });
    expect(outcome.delta).toEqual({ approved: { value: true, locked: false } });
  });

  it("writes an untyped return and an undeclared variable whatever they hold", () => {
    expect(set({ note: null, scratch: { a: 1 } }).delta).toEqual({
      note: { value: null, locked: false },
      scratch: { value: { a: 1 }, locked: false },
    });
  });

  it("holds only the current turn's trigger to its returns", () => {
    expect(set({ approved: "yes" }, "other").delta).toEqual({ approved: { value: "yes", locked: false } });
  });

  it("refuses a return breaking its rule with the rule's message, and writes one meeting it", () => {
    const ruled = WorkflowMachine.fromSpec({
      states: { work: { triggers: { manual: { returns: [{ name: "contact", type: "string", format: "email" }] } } } },
    } as MachineSpec);
    const write = (contact: unknown) =>
      handleSetVariables({ toolCallId: "c1", args: { variables: { contact } }, state: state() }, ruled);
    const refused = write("nobody");
    expect(refused.delta).toBeUndefined();
    expect(refused.message.status).toBe("error");
    const text = String(refused.message.content);
    expect(text).toContain("trigger 'manual'");
    expect(text).toContain("'contact' must be an email address");
    expect(text).toContain("Write a value of the declared type that meets its rules.");
    expect(write("ann@example.co").delta).toEqual({ contact: { value: "ann@example.co", locked: false } });
  });

  it("checks nothing without the machine", () => {
    const outcome = handleSetVariables({ toolCallId: "c1", args: { variables: { approved: "yes" } }, state: state() });
    expect(outcome.delta).toBeDefined();
  });
});

describe("handleSetVariables — a return's lock is the agent's call", () => {
  const machine = WorkflowMachine.fromSpec({
    states: {
      draft: {
        triggers: { manual: { returns: ["summary"] } },
        transitions: [{ to: "finish", description: "Drafted." }],
      },
      finish: {},
    },
  } as MachineSpec);
  const set = (variables: Record<string, unknown>, opts: { lock?: boolean; held?: object } = {}) =>
    handleSetVariables(
      {
        toolCallId: "c1",
        args: { variables, ...(opts.lock !== undefined ? { lock: opts.lock } : {}) },
        state: { trigger: { id: "manual" }, variables: opts.held ?? {} },
      },
      machine,
    );

  it("writes a return unlocked, and lets a later write replace it", () => {
    expect(set({ summary: "draft" }).delta).toEqual({ summary: { value: "draft", locked: false } });
    const held = { summary: { value: "draft", locked: false } };
    expect(set({ summary: "final" }, { held }).delta).toEqual({ summary: { value: "final", locked: false } });
  });

  it("locks a return when asked, after which a write of it is refused", () => {
    expect(set({ summary: "final" }, { lock: true }).delta).toEqual({
      summary: { value: "final", locked: true, lockedBy: "agent" },
    });
    const held = { summary: { value: "final", locked: true } };
    expect(set({ summary: "other" }, { held }).delta).toBeUndefined();
  });
});

describe("set-variables tool declaration", () => {
  const description = (opts?: { child?: boolean }) =>
    createControlTools(opts).find((t) => t.name === SET_VARIABLES_TOOL)!.description;

  it("asks a top-level session for its title", () => {
    expect(description()).toMatch(/`title` is reserved .* set it early/);
  });

  it("asks for a rename only when the whole conversation's subject changes", () => {
    expect(description()).toMatch(/rename it only when the whole conversation has moved to a different subject/);
    expect(description()).toMatch(/a follow-up on the same one keeps it/);
  });

  // A child's title describes a session nothing lists: nothing it reads asks for one.
  it("asks a child session for none, and is otherwise the same", () => {
    expect(description({ child: true })).not.toMatch(/title/);
    expect(description().startsWith(description({ child: true }))).toBe(true);
  });
});

describe("handleSetVariables — a variable a state owns", () => {
  const machine = WorkflowMachine.fromSpec({
    states: {
      lookup: { triggers: { manual: null }, locks: ["order_id"], transitions: [{ to: "act", description: "Found." }] },
      act: {},
    },
  } as MachineSpec);
  const set = (at: string, variables: Record<string, unknown>, opts: { lock?: boolean; held?: object } = {}) =>
    handleSetVariables(
      {
        toolCallId: "c1",
        args: { variables, ...(opts.lock !== undefined ? { lock: opts.lock } : {}) },
        state: { workflowState: at, variables: opts.held ?? {} },
      },
      machine,
    );

  it("is written, and rewritten, in its owner", () => {
    expect(set("lookup", { order_id: "1" }).delta).toEqual({ order_id: { value: "1", locked: false } });
    const held = { order_id: { value: "1", locked: false } };
    expect(set("lookup", { order_id: "2" }, { held }).delta).toEqual({ order_id: { value: "2", locked: false } });
  });

  it("is refused anywhere else, atomically, naming the owner to go back to", () => {
    const outcome = set("act", { order_id: "2", note: "x" });
    expect(outcome.delta).toBeUndefined();
    expect(String(outcome.message.content)).toContain(
      "'order_id' belongs to state 'lookup': only 'lookup' can change it. Go back to 'lookup' to change it.",
    );
  });

  it("cannot be locked, even in its owner", () => {
    const outcome = set("lookup", { order_id: "1" }, { lock: true });
    expect(outcome.delta).toBeUndefined();
    expect(String(outcome.message.content)).toContain("cannot be locked");
  });

  it("stays the host's when the host seeded it", () => {
    const held = { order_id: { value: "9", locked: true } };
    expect(String(set("lookup", { order_id: "1" }, { held }).message.content)).toContain("'order_id' is locked");
  });

  it("leaves an unowned lock final, recording that the agent set it", () => {
    expect(set("act", { note: "x" }, { lock: true }).delta).toEqual({ note: { value: "x", locked: true, lockedBy: "agent" } });
  });
});
