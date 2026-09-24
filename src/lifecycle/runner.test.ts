import { describe, expect, it } from "vitest";
import type { BackendProtocolV2 } from "deepagents";
import { Workspace } from "../core/workspace.js";
import { WorkflowMachine } from "../machine/machine.js";
import type { ScriptExecutor, ScriptOutcome } from "../sandbox/executor.js";
import type { Rubric } from "../rubrics/rubrics.js";
import type { WorkflowLifecycleEvent } from "../core/events.js";
import { iterationKey } from "./hook-shape.js";
import { LifecycleRunner, parseLifecycleDecision, type LifecycleContext } from "./runner.js";

const SPEC_PATHS = { workflowYaml: "workflow.yaml", workflow: "WORKFLOW.md" };

const MACHINE_YAML = `
states:
  a:
    triggers: { manual: }
    before: { script: hooks/check.js }
    tools:
      allow:
        - { tool: archmax_advance, args: { to: ["b"] } }
    transitions:
      - to: b
        description: go to b
  b:
    after: { script: hooks/after.js }
    tools:
      allow:
        - { tool: archmax_advance, args: { to: ["done"] } }
    transitions:
      - to: done
        description: finish
  done:
`;

function machineWorkspace(yaml: string): Workspace {
  const spec = `${yaml.trim()}\n`;
  const backend = {
    async readRaw(filePath: string) {
      if (filePath.endsWith("workflow.yaml")) {
        return { data: { content: spec, mimeType: "text/yaml", created_at: "", modified_at: "" } };
      }
      return { error: "missing" };
    },
  } as unknown as BackendProtocolV2;
  return new Workspace(backend);
}

function stubExecutor(resultFor: (script: string) => ScriptOutcome): ScriptExecutor {
  return {
    async runFile(filePath: string) {
      return resultFor(filePath);
    },
    async runCode() {
      return { ok: true, value: null, logs: [], formatted: "" };
    },
    dispose() {},
  };
}

function ctx(): LifecycleContext {
  return { sessionId: "t1", tools: [], messages: [], taskTool: undefined, config: {}, iterations: {} };
}

async function loadMachine(): Promise<WorkflowMachine> {
  const machine = await WorkflowMachine.load(machineWorkspace(MACHINE_YAML), SPEC_PATHS);
  if (!machine) throw new Error("failed to load test machine");
  return machine;
}

const vetoOutcome: ScriptOutcome = {
  ok: true,
  value: { verdict: "veto", reason: "requester not found" },
  logs: [],
  formatted: "",
};

const passOutcome: ScriptOutcome = { ok: true, value: null, logs: [], formatted: "" };

describe("LifecycleRunner", () => {
  it("returns a veto reason when a before hook blocks the run", async () => {
    const machine = await loadMachine();
    const runner = new LifecycleRunner(machine, stubExecutor(() => vetoOutcome), new Map(), []);

    const rejection = await runner.runPhase("a", "before", ctx());
    expect(rejection?.reason).toBe("requester not found");
    expect(rejection?.terminal).toBe(false);
  });

  it("lets a passing before hook proceed", async () => {
    const machine = await loadMachine();
    const runner = new LifecycleRunner(machine, stubExecutor(() => passOutcome), new Map(), []);

    const reason = await runner.runPhase("a", "before", ctx());
    expect(reason).toBeNull();
  });

  it("rejects a transition when the source state's after hook vetoes", async () => {
    const machine = await loadMachine();
    const runner = new LifecycleRunner(machine, stubExecutor(() => vetoOutcome), new Map(), []);

    const result = await runner.attemptTransition("b", "done", ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("hook veto: requester not found");
  });

  it("accepts a valid transition when hooks pass", async () => {
    const machine = await loadMachine();
    const runner = new LifecycleRunner(machine, stubExecutor(() => passOutcome), new Map(), []);

    const result = await runner.attemptTransition("b", "done", ctx());
    expect(result.ok).toBe(true);
  });

  describe("the requires gate is decided from the context's variable store", () => {
    const REQUIRES_YAML = `
states:
  a:
    triggers: { manual: }
    requires: [case_id]
    transitions:
      - to: done
        description: finish
  done:
`;

    const requiresMachine = async () => {
      const machine = await WorkflowMachine.load(machineWorkspace(REQUIRES_YAML), SPEC_PATHS);
      if (!machine) throw new Error("failed to load test machine");
      return machine;
    };

    it("blocks the exit while the required variable is unset", async () => {
      const runner = new LifecycleRunner(
        await requiresMachine(),
        stubExecutor(() => passOutcome),
        new Map(),
        [],
      );

      const result = await runner.attemptTransition("a", "done", ctx());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("case_id");
        expect(result.terminal).toBe(false);
      }
    });

    it("permits the exit once the store carries it", async () => {
      const runner = new LifecycleRunner(
        await requiresMachine(),
        stubExecutor(() => passOutcome),
        new Map(),
        [],
      );

      // The regression this pins: the store has to *reach* the kernel. Decided
      // without it, every state declaring `requires` was unleavable no matter
      // what set the name — a host seed, a delivery, or `set_variables`.
      const result = await runner.attemptTransition("a", "done", {
        ...ctx(),
        variableStore: { case_id: { value: "K-9", locked: false } },
      });
      expect(result.ok).toBe(true);
    });

    it("counts a locked host seed as set", async () => {
      const runner = new LifecycleRunner(
        await requiresMachine(),
        stubExecutor(() => passOutcome),
        new Map(),
        [],
      );

      const result = await runner.attemptTransition("a", "done", {
        ...ctx(),
        variableStore: { case_id: { value: "K-9", locked: true } },
      });
      expect(result.ok).toBe(true);
    });
  });

  it("fails closed when an after hook errors: the transition is rejected with the error", async () => {
    const machine = await loadMachine();
    const errorOutcome: ScriptOutcome = {
      ok: false,
      value: undefined,
      logs: [],
      error: { message: "boom in after hook" },
      formatted: "",
    };
    const runner = new LifecycleRunner(machine, stubExecutor(() => errorOutcome), new Map(), []);

    const result = await runner.attemptTransition("b", "done", ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("boom in after hook");
  });

  it("fails closed when an after rubric cannot be dispatched", async () => {
    const machine = await loadListMachine(JUDGE_LIST_YAML);
    const registry = new Map<string, Rubric>([
      ["a--after--0", { id: "a--after--0", state: "a", phase: "after", index: 0, instructions: "s", max_iterations: 1 }],
    ]);
    const runner = new LifecycleRunner(machine, stubExecutor(() => passOutcome), registry, []);

    // No task tool in the context: the rubric dispatch fails, which must veto.
    const result = await runner.attemptTransition("a", "done", ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("could not be dispatched");
  });

  it("forwards the advance reason to the departing state's after hook", async () => {
    const machine = await loadMachine();
    let capturedArgs: Record<string, unknown> | undefined;
    const executor: ScriptExecutor = {
      async runFile(_filePath, params) {
        capturedArgs = params.args;
        return passOutcome;
      },
      async runCode() {
        return passOutcome;
      },
      dispose() {},
    };
    const runner = new LifecycleRunner(machine, executor, new Map(), []);

    const result = await runner.attemptTransition("b", "done", ctx(), "answer is complete");
    expect(result.ok).toBe(true);
    expect(capturedArgs).toMatchObject({ from: "b", to: "done", reason: "answer is complete" });
  });

  it("forwards the trigger id and the run's variables to hook script args", async () => {
    const machine = await loadMachine();
    let capturedArgs: Record<string, unknown> | undefined;
    const executor: ScriptExecutor = {
      async runFile(_filePath, params) {
        capturedArgs = params.args;
        return passOutcome;
      },
      async runCode() {
        return passOutcome;
      },
      dispose() {},
    };
    const runner = new LifecycleRunner(machine, executor, new Map(), []);

    const reason = await runner.runPhase("a", "before", {
      ...ctx(),
      trigger: { id: "email_received" },
      variables: { from_email: "a@b.com", order: { items: [{ sku: "A-1" }] } },
    });
    expect(reason).toBeNull();
    // The trigger is its bare id; the run's input arrives as variables, whole,
    // so a hook can traverse a structured value with ordinary property access.
    expect(capturedArgs).toMatchObject({
      trigger: "email_received",
      variables: { from_email: "a@b.com", order: { items: [{ sku: "A-1" }] } },
    });
  });

  it("rejects an undeclared transition target", async () => {
    const machine = await loadMachine();
    const runner = new LifecycleRunner(machine, stubExecutor(() => passOutcome), new Map(), []);

    const result = await runner.attemptTransition("a", "done", ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("cannot advance from 'a' to 'done'");
  });

  it("emits hook events to the handler instead of console output", async () => {
    const machine = await loadMachine();
    const events: WorkflowLifecycleEvent[] = [];
    const runner = new LifecycleRunner(
      machine,
      stubExecutor(() => passOutcome),
      new Map(),
      [],
      undefined,
      (e) => events.push(e),
    );

    await runner.runPhase("a", "before", ctx());

    expect(events.map((e) => e.type)).toContain("hook-start");
    expect(events.map((e) => e.type)).toContain("hook-passed");
    const start = events.find((e) => e.type === "hook-start");
    expect(start).toMatchObject({ state: "a", phase: "before", label: "hooks/check.js" });
  });

  it("emits an advance event on a successful transition", async () => {
    const machine = await loadMachine();
    const events: WorkflowLifecycleEvent[] = [];
    const runner = new LifecycleRunner(
      machine,
      stubExecutor(() => passOutcome),
      new Map(),
      [],
      undefined,
      (e) => events.push(e),
    );

    await runner.attemptTransition("b", "done", ctx());
    expect(events).toContainEqual(
      expect.objectContaining({ type: "advance", from: "b", to: "done", level: "info" }),
    );
  });
});

const CUSTOM_KIND_YAML = `
states:
  a:
    triggers: { manual: }
    tools:
      allow:
        - { tool: archmax_advance, args: { to: ["b"] } }
    transitions:
      - to: b
        description: go to b
  b:
    after: { webhook: approvals/refund }
    tools:
      allow:
        - { tool: archmax_advance, args: { to: ["done"] } }
    transitions:
      - to: done
        description: finish
  done:
`;

describe("LifecycleRunner custom hook kinds", () => {
  it("dispatches a custom hook kind through its registered executor", async () => {
    const machine = await WorkflowMachine.load(machineWorkspace(CUSTOM_KIND_YAML), SPEC_PATHS);
    if (!machine) throw new Error("failed to load");
    let sawHook: Record<string, string> | undefined;
    const runner = new LifecycleRunner(machine, stubExecutor(() => passOutcome), new Map(), [], {
      webhook: async (hook) => {
        sawHook = hook as Record<string, string>;
        // A passing custom executor returns no verdict → allow.
        return passOutcome;
      },
    });

    const result = await runner.attemptTransition("b", "done", ctx());
    expect(result.ok).toBe(true);
    expect(sawHook).toEqual({ webhook: "approvals/refund" });
  });

  it("lets a custom executor veto through the same kernel path", async () => {
    const machine = await WorkflowMachine.load(machineWorkspace(CUSTOM_KIND_YAML), SPEC_PATHS);
    if (!machine) throw new Error("failed to load");
    const runner = new LifecycleRunner(machine, stubExecutor(() => passOutcome), new Map(), [], {
      webhook: async () => ({
        ok: true,
        value: { verdict: "veto", reason: "approval declined" },
        logs: [],
        formatted: "",
      }),
    });

    const result = await runner.attemptTransition("b", "done", ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("hook veto: approval declined");
  });

  it("fails closed when a hook kind has no registered executor", async () => {
    const machine = await WorkflowMachine.load(machineWorkspace(CUSTOM_KIND_YAML), SPEC_PATHS);
    if (!machine) throw new Error("failed to load");
    const runner = new LifecycleRunner(machine, stubExecutor(() => passOutcome), new Map(), []);

    const result = await runner.attemptTransition("b", "done", ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no executor registered for hook kind 'webhook'");
  });
});

/** The per-hook budget key for `a`'s single `after` script — keyed by position. */
const REVIEW_BUDGET = iterationKey("a", "after", 0);

const SIBLING_CORRECT_YAML = `
states:
  a:
    triggers: { manual: }
    after:
      - { script: hooks/schema.js }
      - { script: hooks/review.js, max_iterations: 1 }
    transitions:
      - to: done
        description: finish
  done:
`;

/** The reviewing hook is the *second* in the list, so its budget is keyed at index 1. */
const SIBLING_REVIEW_BUDGET = iterationKey("a", "after", 1);

/** A hook that returns an explicit `ok` verdict, not a bare pass. */
const okOutcome: ScriptOutcome = { ok: true, value: { verdict: "ok" }, logs: [], formatted: "" };

const SCRIPT_CORRECT_YAML = `
states:
  a:
    triggers: { manual: }
    after: { script: hooks/review.js, max_iterations: 2 }
    transitions:
      - to: done
        description: finish
  done:
`;

const BEFORE_CORRECT_YAML = `
states:
  a:
    triggers: { manual: }
    before: { script: hooks/gate.js }
    after: { rubric: { instructions: judge the reply } }
    transitions:
      - to: done
        description: finish
  done:
`;

const correctOutcome: ScriptOutcome = {
  ok: true,
  value: { verdict: "correct", reason: "answer is missing the totals" },
  logs: [],
  formatted: "",
};

describe("LifecycleRunner verdict uniformity", () => {
  it("gives a script hook's correct verdict the same bounded flow as a rubric", async () => {
    const machine = await WorkflowMachine.load(machineWorkspace(SCRIPT_CORRECT_YAML), SPEC_PATHS);
    if (!machine) throw new Error("failed to load");
    const runner = new LifecycleRunner(machine, stubExecutor(() => correctOutcome), new Map(), []);

    const context = ctx();
    const first = await runner.attemptTransition("a", "done", context);
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.reason).toContain("reply incomplete — answer is missing the totals");
      expect(first.reason).toContain("2 attempt(s) remaining");
      expect(first.corrections[REVIEW_BUDGET]).toBe(1);
    }

    // Exhaust the budget: the third correct verdict is a hard veto.
    context.iterations = { [REVIEW_BUDGET]: 2 };
    const exhausted = await runner.attemptTransition("a", "done", context);
    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) {
      expect(exhausted.reason).toContain("still incomplete after 2 attempt(s)");
      expect(exhausted.terminal).toBe(true);
      // The refusal granted no retry, so it bills none: a state that exhausted
      // its budget once must not enter the next visit already spent (issue #62).
      expect(exhausted.corrections[REVIEW_BUDGET]).toBe(2);
    }
  });

  it("treats a before hook's correct verdict as a veto without consuming the iteration budget", async () => {
    const machine = await WorkflowMachine.load(machineWorkspace(BEFORE_CORRECT_YAML), SPEC_PATHS);
    if (!machine) throw new Error("failed to load");
    const runner = new LifecycleRunner(machine, stubExecutor(() => correctOutcome), new Map(), []);

    const context = ctx();
    const rejection = await runner.runPhase("a", "before", context);
    expect(rejection?.reason).toContain("before hooks cannot request corrections");
    expect(rejection?.terminal).toBe(false);
    expect(context.iterations).toEqual({});
  });

  it("keeps each after hook's iteration budget independent of a passing sibling", async () => {
    // A passing hook ahead of a correcting one used to clear the shared,
    // per-state counter every attempt, so the hard stop never fired and the
    // correction loop ran until the recursion limit (issue #62).
    const machine = await WorkflowMachine.load(machineWorkspace(SIBLING_CORRECT_YAML), SPEC_PATHS);
    if (!machine) throw new Error("failed to load");
    const runner = new LifecycleRunner(
      machine,
      // `hooks/schema.js` explicitly passes; `hooks/review.js` keeps correcting.
      stubExecutor((script) => (script.endsWith("schema.js") ? okOutcome : correctOutcome)),
      new Map(),
      [],
    );

    const context = ctx();
    const first = await runner.attemptTransition("a", "done", context);
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.reason).toContain("1 attempt(s) remaining");
      // The passing sibling released only its own budget.
      expect(first.corrections).toEqual({ [SIBLING_REVIEW_BUDGET]: 1 });
    }

    context.iterations = { [SIBLING_REVIEW_BUDGET]: 1 };
    const second = await runner.attemptTransition("a", "done", context);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toContain("still incomplete after 1 attempt(s)");
      expect(second.terminal).toBe(true);
    }
  });

  it("fails closed when a rubric returns unparseable output", async () => {
    const machine = await WorkflowMachine.load(machineWorkspace(BEFORE_CORRECT_YAML), SPEC_PATHS);
    if (!machine) throw new Error("failed to load");
    const taskTool = {
      name: "task",
      invoke: async () => ({ content: "the totals look fine to me" }),
    } as unknown as LifecycleContext["taskTool"];
    const runner = new LifecycleRunner(machine, stubExecutor(() => passOutcome), new Map(), []);

    const context = { ...ctx(), taskTool };
    const result = await runner.attemptTransition("a", "done", context);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("returned no parseable verdict");
      expect(result.reason).toContain("the totals look fine to me");
    }
  });
});

const LIST_YAML = `
states:
  a:
    triggers: { manual: }
    after:
      - { script: hooks/first.js }
      - { script: hooks/second.js }
    tools:
      allow:
        - { tool: archmax_advance, args: { to: ["done"] } }
    transitions:
      - to: done
        description: finish
  done:
`;

const JUDGE_LIST_YAML = `
states:
  a:
    triggers: { manual: }
    after:
      - rubric: { instructions: judge the reply, max_iterations: 1 }
      - { script: hooks/second.js }
    tools:
      allow:
        - { tool: archmax_advance, args: { to: ["done"] } }
    transitions:
      - to: done
        description: finish
  done:
`;

/** Executor that records the order of script paths it is asked to run. */
function recordingExecutor(resultFor: (script: string) => ScriptOutcome): {
  executor: ScriptExecutor;
  calls: string[];
} {
  const calls: string[] = [];
  const executor: ScriptExecutor = {
    async runFile(filePath: string) {
      calls.push(filePath);
      return resultFor(filePath);
    },
    async runCode() {
      return passOutcome;
    },
    dispose() {},
  };
  return { executor, calls };
}

async function loadListMachine(yaml: string): Promise<WorkflowMachine> {
  const machine = await WorkflowMachine.load(machineWorkspace(yaml), SPEC_PATHS);
  if (!machine) throw new Error("failed to load list machine");
  return machine;
}

describe("LifecycleRunner hook lists", () => {
  it("runs every after hook in order when all allow", async () => {
    const machine = await loadListMachine(LIST_YAML);
    const { executor, calls } = recordingExecutor(() => passOutcome);
    const runner = new LifecycleRunner(machine, executor, new Map(), []);

    const result = await runner.attemptTransition("a", "done", ctx());
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["hooks/first.js", "hooks/second.js"]);
  });

  it("short-circuits on the first vetoing after hook", async () => {
    const machine = await loadListMachine(LIST_YAML);
    const { executor, calls } = recordingExecutor((script) =>
      script === "hooks/first.js" ? vetoOutcome : passOutcome,
    );
    const runner = new LifecycleRunner(machine, executor, new Map(), []);

    const result = await runner.attemptTransition("a", "done", ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("hook veto: requester not found");
    expect(calls).toEqual(["hooks/first.js"]);
  });

  it("short-circuits when an after rubric requests a correction", async () => {
    const machine = await loadListMachine(JUDGE_LIST_YAML);
    const { executor, calls } = recordingExecutor(() => passOutcome);
    const registry = new Map<string, Rubric>([
      ["a--after--0", { id: "a--after--0", state: "a", phase: "after", index: 0, instructions: "s", max_iterations: 1 }],
    ]);
    const runner = new LifecycleRunner(machine, executor, registry, []);
    const taskTool = {
      name: "task",
      invoke: async () => ({ verdict: "correct", reason: "add the tracking number" }),
    } as unknown as LifecycleContext["taskTool"];

    const result = await runner.attemptTransition("a", "done", { ...ctx(), taskTool });
    expect(result.ok).toBe(false);
    // The script after the rubric must not run once a correction is requested.
    expect(calls).toEqual([]);
  });
});

describe("parseLifecycleDecision", () => {
  const ok = (value: unknown): ScriptOutcome => ({ ok: true, value, logs: [], formatted: "" });

  it("surfaces a script error", () => {
    const out: ScriptOutcome = { ok: false, value: undefined, logs: [], error: { message: "boom" }, formatted: "" };
    expect(parseLifecycleDecision(out)).toEqual({ error: "boom" });
  });

  it("holds a raw value to the same contract a script is held to", () => {
    // Reached only by a custom `hookExecutors` kind — a script's value is
    // reduced by the sandbox first — but the vocabulary is the same one, so a
    // consumer's executor gets the same answers a script would.
    expect(parseLifecycleDecision(ok(false))).toMatchObject({ verdict: "veto" });
    // An object that is not a verdict is a verdict got wrong: fail closed with
    // its keys named, never read as `ok`.
    expect(parseLifecycleDecision(ok({ ok: false, reason: "nope" }))).toMatchObject({
      error: expect.stringContaining("'ok', 'reason'"),
    });
    expect(parseLifecycleDecision(ok({ verdict: "VETO" }))).toMatchObject({
      error: expect.stringContaining("is not a verdict"),
    });
    expect(parseLifecycleDecision(ok(["veto"]))).toMatchObject({
      error: expect.stringContaining("an array"),
    });
  });

  it("reads a value that states nothing as no opinion", () => {
    // Returning nothing is `ok`, and so is any non-object: `true` is what
    // `return isAuthorized(x)` yields on the allow side.
    expect(parseLifecycleDecision(ok(undefined))).toBeNull();
    expect(parseLifecycleDecision(ok(null))).toBeNull();
    expect(parseLifecycleDecision(ok(true))).toBeNull();
    expect(parseLifecycleDecision(ok(1))).toBeNull();
  });

  it("reads the verdict shape", () => {
    expect(parseLifecycleDecision(ok({ verdict: "correct", reason: "fix it" }))).toMatchObject({
      verdict: "correct",
      reason: "fix it",
    });
    expect(parseLifecycleDecision(ok({ verdict: "ok", reason: "good" }))).toMatchObject({ verdict: "ok" });
  });
});

describe("LifecycleRunner hook input", () => {
  it("hands a script hook the transcript as plain messages, and no run view", async () => {
    const machine = await loadMachine();
    let capturedArgs: Record<string, unknown> | undefined;
    const executor: ScriptExecutor = {
      async runFile(_filePath, params) {
        capturedArgs = params.args;
        return passOutcome;
      },
      async runCode() {
        return passOutcome;
      },
      dispose() {},
    };
    const runner = new LifecycleRunner(machine, executor, new Map(), []);

    await runner.runPhase("a", "before", {
      ...ctx(),
      messages: [
        { type: "human", content: "refund ORD-1" },
        { type: "ai", content: "", tool_calls: [{ name: "read_file", args: { file_path: "x" } }] },
        { type: "tool", name: "read_file", content: "[]" },
      ],
    });
    expect(capturedArgs?.messages).toEqual([
      { role: "user", text: "refund ORD-1" },
      { role: "assistant", text: "", toolCalls: [{ name: "read_file", args: { file_path: "x" } }] },
      { role: "tool", text: "[]", tool: "read_file" },
    ]);
    expect(capturedArgs).not.toHaveProperty("run");
    expect(capturedArgs).not.toHaveProperty("history");
    expect(capturedArgs).not.toHaveProperty("userRequest");
  });

  it("vetoes on a raw `false` from a custom executor, as a script would", async () => {
    // One vocabulary, whoever implements the kind: `HookResult` declares `false`
    // a veto, so the `hookExecutors` seam answers the way a script does.
    const machine = await loadListMachine(LIST_YAML);
    const bareFalse: ScriptOutcome = { ...passOutcome, value: false };
    const runner = new LifecycleRunner(machine, stubExecutor(() => bareFalse), new Map(), []);

    const result = await runner.attemptTransition("a", "done", ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("precondition not met");
  });

  it("fails the phase closed when a custom executor returns a shape that is not a verdict", async () => {
    const machine = await loadListMachine(LIST_YAML);
    const wrongShape: ScriptOutcome = { ...passOutcome, value: { ok: false, reason: "nope" } };
    const runner = new LifecycleRunner(machine, stubExecutor(() => wrongShape), new Map(), []);

    const result = await runner.attemptTransition("a", "done", ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("is not a verdict");
      expect(result.terminal).toBe(true);
    }
  });
});
