import { describe, expect, it } from "vitest";
import { ToolMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import type { MountPrefixes } from "../core/zones.js";
import { decide } from "../kernel/kernel.js";
import type { LifecycleContext, LifecycleRunner } from "../lifecycle/runner.js";
import { WorkflowMachine } from "../machine/machine.js";
import type { MachineSpec } from "../machine/types.js";
import {
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
  validateAdvanceEvidence,
  WAIT_TOOL,
} from "./control-tools.js";
import { SET_VARIABLES_TOOL } from "../machine/tool-names.js";
import type { WorkflowStateFields } from "./state.js";

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

function ctx(iterations: Record<string, number> = {}): LifecycleContext {
  return { sessionId: "t", tools: [], messages: [], config: {}, iterations };
}

function withRunner(attempt: LifecycleRunner["attemptTransition"]) {
  return { machine, lifecycle: { attemptTransition: attempt } as unknown as LifecycleRunner };
}

const passing: LifecycleRunner["attemptTransition"] = async (from, to) => ({
  ok: true,
  from,
  to,
  corrections: {},
});

describe("handleAdvance", () => {
  it("advances with a reason, forwards it to the runner, and commits the move", async () => {
    let received: { from?: string; reason?: string } = {};
    const opts = withRunner(async (from, to, _ctx, reason) => {
      received = { from, reason };
      return { ok: true, from, to, corrections: {} };
    });
    const outcome = await handleAdvance(opts, {
      toolCallId: "call-1",
      args: { to: "b", reason: "answer is complete" },
      state: { workflowState: "a" },
      ctx: ctx(),
    });
    expect(received).toEqual({ from: "a", reason: "answer is complete" });
    expect(outcome.moved).toEqual({ from: "a", to: "b" });
    const update = commandUpdate(outcome.message);
    expect(update.workflowState).toBe("b");
    expect(update.stateTurns).toBeNull();
    expect(update.auditTrail).toMatchObject([{ to: "b", kind: "agent", reason: "answer is complete" }]);
    const [message] = update.messages as ToolMessage[];
    expect(String(message!.content)).toContain("Advanced to state 'b'");
    expect(message!.tool_call_id).toBe("call-1");
  });

  it("opens a park in its closing phase when the target is a human state", async () => {
    const outcome = await handleAdvance(withRunner(passing), {
      toolCallId: "call-1",
      args: { to: "review", reason: "ready", evidence: ["scratchpad/notes.md"] },
      state: { workflowState: "a", decisionCount: 1 },
      ctx: ctx(),
    });
    const update = commandUpdate(outcome.message);
    expect(update.status).toBe("awaiting_decision");
    expect(update.parkPhase).toBe("closing");
    expect(update.decisionCount).toBe(2);
    expect(outcome.moved?.park).toMatchObject({
      state: "review",
      title: "Review",
      seq: 2,
      // Declared evidence first, the attachment after.
      evidence: ["scratchpad/draft.md", "scratchpad/notes.md"],
      transitions: [{ to: "b", type: "approve", description: "Test edge to b." }],
    });
  });

  it("refuses evidence attached to an agent target, without attempting the transition", async () => {
    let attempted = false;
    const opts = withRunner(async (from, to) => {
      attempted = true;
      return { ok: true, from, to, corrections: {} };
    });
    const outcome = await handleAdvance(opts, {
      toolCallId: "call-1",
      args: { to: "b", reason: "go", evidence: ["scratchpad/x.md"] },
      state: { workflowState: "a" },
      ctx: ctx(),
    });
    expect(attempted).toBe(false);
    expect(outcome.moved).toBeUndefined();
    expect((outcome.message as ToolMessage).status).toBe("error");
    expect(String((outcome.message as ToolMessage).content)).toMatch(/not one/);
  });

  it("commits a terminal rejection as `rejected` so on_error routing fires", async () => {
    const opts = withRunner(async () => ({
      ok: false,
      reason: "judge veto: still incomplete after 2 correction attempt(s)",
      terminal: true,
      corrections: { a: 3 },
    }));
    const outcome = await handleAdvance(opts, {
      toolCallId: "call-1",
      args: { to: "b", reason: "try again" },
      state: { workflowState: "a" },
      ctx: ctx(),
    });
    const update = commandUpdate(outcome.message);
    expect(update.rejected).toContain("still incomplete after 2");
    expect(update.workflowState).toBeUndefined();
    expect(update.iterations).toEqual({ a: 3 });
    expect(outcome.moved).toBeUndefined();
  });

  it("does not set `rejected` for a recoverable rejection, and clears it on success", async () => {
    const recoverable = withRunner(async () => ({
      ok: false,
      reason: "judge: add totals",
      terminal: false,
      corrections: { a: 1 },
    }));
    const rejected = commandUpdate(
      (
        await handleAdvance(recoverable, {
          toolCallId: "call-1",
          args: { to: "b", reason: "advance" },
          state: { workflowState: "a" },
          ctx: ctx(),
        })
      ).message,
    );
    expect(rejected.rejected).toBeUndefined();
    const [message] = rejected.messages as ToolMessage[];
    expect(String(message!.content)).toContain("archmax_advance rejected: judge: add totals");
    expect(message!.status).toBeUndefined();

    const success = commandUpdate(
      (
        await handleAdvance(withRunner(passing), {
          toolCallId: "call-2",
          args: { to: "b", reason: "advance" },
          state: { workflowState: "a", rejected: "earlier" },
          ctx: ctx(),
        })
      ).message,
    );
    expect(success.rejected).toBeNull();
  });

  it("rejects a call with an empty or missing reason without attempting the transition", async () => {
    let attempted = false;
    const opts = withRunner(async (from, to) => {
      attempted = true;
      return { ok: true, from, to, corrections: {} };
    });
    for (const args of [{ to: "b", reason: "" }, { to: "b" }]) {
      const outcome = await handleAdvance(opts, {
        toolCallId: "call-1",
        args,
        state: { workflowState: "a" },
        ctx: ctx(),
      });
      expect((outcome.message as ToolMessage).status).toBe("error");
    }
    expect(attempted).toBe(false);
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
    iterations: { "orders-question": 2 },
    beforeDone: { "orders-question": true },
    rejected: "an earlier veto",
    stateTurns: { state: "orders-question", count: 3 },
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
    expect(u.iterations).toEqual({});
    expect(u.beforeDone).toEqual({});
    expect(u.rejected).toBeNull();
    expect(u.stateTurns).toBeNull();
  });

  it("records only the reset step, leaving the history to the channel", () => {
    const trail = commandUpdate(reset(parked).message).auditTrail as Array<Record<string, unknown>>;
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ to: "identify-case", kind: "reset", reason: "wrong branch" });
  });

  it("leaves variables and messages alone", () => {
    const u = commandUpdate(reset(parked).message);
    expect(u.variables).toBeUndefined();
    expect((u.messages as unknown[]).length).toBe(1);
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

  it("checks nothing without the machine", () => {
    const outcome = handleSetVariables({ toolCallId: "c1", args: { variables: { approved: "yes" } }, state: state() });
    expect(outcome.delta).toBeDefined();
  });
});

describe("set-variables tool declaration", () => {
  const description = (opts?: { child?: boolean }) =>
    createControlTools(opts).find((t) => t.name === SET_VARIABLES_TOOL)!.description;

  it("asks a top-level session for its title", () => {
    expect(description()).toMatch(/`title` is reserved .* set it early/);
  });

  // A child's title describes a session nothing lists: nothing it reads asks for one.
  it("asks a child session for none, and is otherwise the same", () => {
    expect(description({ child: true })).not.toMatch(/title/);
    expect(description().startsWith(description({ child: true }))).toBe(true);
  });
});
