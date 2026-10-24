import { describe, expect, it } from "vitest";
import type { BackendProtocolV2 } from "deepagents";
import type { StructuredTool } from "@langchain/core/tools";
import { Workspace } from "../core/workspace.js";
import type { WorkflowLifecycleEvent } from "../core/events.js";
import { WorkflowMachine } from "../machine/machine.js";
import type { MachineSpec } from "../machine/types.js";
import { AGENT_SESSION, createScriptExecutor } from "./executor.js";
import { createPtcToolGateway } from "./ptc-gateway.js";
import { SUB_WORKFLOW_PARK } from "../workflow/sub-workflow.js";

/**
 * End-to-end coverage of the PTC path as scripts actually take it — the
 * agent's `archmax_eval`/`archmax_run` and a code state's script: a real
 * QuickJS session, the sandbox bridge's own `tools.*` injection, and
 * gateway-wrapped tools. The unit tests in `ptc-gateway.test.ts` call the
 * wrapped tool directly; these prove the wrap survives the bridge — which
 * camel-cases tool names and calls `invoke` with no config of its own.
 */

const SPEC: MachineSpec = {
  states: {
    work: {
      triggers: { manual: null },
      tools: { allow: [{ tool: "write_file", args: { file_path: ["output/**"] } }] },
      transitions: [{ to: "done", description: "Test edge to done." }],
    },
    done: {},
  },
};

function workspaceWith(files: Record<string, string>): Workspace {
  const norm = (p: string) => `/${p.replace(/^\/+/, "")}`;
  const backend = {
    async readRaw(filePath: string) {
      const content = files[norm(filePath)];
      return content === undefined
        ? { error: "missing" }
        : { data: { content, mimeType: "text/plain", created_at: "", modified_at: "" } };
    },
  } as unknown as BackendProtocolV2;
  return new Workspace(backend);
}

function recordingTool(name: string) {
  const calls: unknown[] = [];
  const tool = {
    name,
    description: name,
    schema: { type: "object" },
    async invoke(input: unknown) {
      calls.push(input);
      return `${name}:done`;
    },
  };
  return { tool: tool as unknown as StructuredTool, calls };
}

function harness(files: Record<string, string>) {
  const machine = WorkflowMachine.fromSpec(SPEC);
  const events: WorkflowLifecycleEvent[] = [];
  const gateway = createPtcToolGateway({
    machine,
    // The mount keys are workspace shape, supplied by assembly; the kernel holds
    // no list of its own.
    mountPrefixes: { dirs: ["skills", "workflows", "data"], files: ["AGENTS.md"], writable: [], governed: [], unsearchable: [] },
    emit: (event) => events.push(event as WorkflowLifecycleEvent),
  });
  const executor = createScriptExecutor({ workspace: workspaceWith(files) });
  return { gateway, executor, events };
}

describe("PTC governance through the sandbox", () => {
  it("refuses a read-only-zone write and lets the script catch it", async () => {
    const write = recordingTool("write_file");
    const { gateway, executor, events } = harness({
      "/scripts/bad-write.js": `
        let caught = null;
        try {
          await tools.writeFile({ file_path: "skills/x.md", content: "nope" });
        } catch (err) {
          caught = String(err.message);
        }
        caught;
      `,
    });
    gateway.refresh("t1", { state: "work", config: { configurable: { thread_id: "t1" } } });

    const outcome = await executor.runFile("scripts/bad-write.js", {
      sessionId: "t1",
      sessionNamespace: AGENT_SESSION,
      tools: gateway.wrap([write.tool], { origin: "script", sessionId: "t1" }),
    });
    executor.dispose("t1");

    expect(outcome.ok).toBe(true);
    expect(String(outcome.value)).toContain("read-only");
    // Fail closed: the refusal never reached the real tool.
    expect(write.calls).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual(["tool-blocked"]);
    expect(events[0]).toMatchObject({ type: "tool-blocked", origin: "script", tool: "write_file" });
  });

  it("runs an allowed call and brackets it with origin-tagged events", async () => {
    const write = recordingTool("write_file");
    const { gateway, executor, events } = harness({
      "/scripts/ok-write.js": `await tools.writeFile({ file_path: "output/a.md", content: "hi" });`,
    });
    gateway.refresh("t2", { state: "work", config: { configurable: { thread_id: "t2" } } });

    const outcome = await executor.runFile("scripts/ok-write.js", {
      sessionId: "t2",
      sessionNamespace: AGENT_SESSION,
      tools: gateway.wrap([write.tool], { origin: "script", sessionId: "t2" }),
    });
    executor.dispose("t2");

    expect(outcome.ok).toBe(true);
    expect(write.calls).toEqual([{ file_path: "output/a.md", content: "hi" }]);
    expect(events.map((e) => e.type)).toEqual(["tool-called", "tool-result"]);
    expect(events[0]).toMatchObject({ origin: "script", state: "work" });
    expect(events[1]).toMatchObject({ origin: "script", status: "ok" });
  });

  it("blocks a script call the active state does not allow", async () => {
    const write = recordingTool("write_file");
    const { gateway, executor } = harness({
      "/scripts/off-limits.js": `
        try { await tools.writeFile({ file_path: "elsewhere/a.md" }); return "allowed"; }
        catch (err) { return "blocked"; }
      `,
    });
    gateway.refresh("t3", { state: "work", config: { configurable: { thread_id: "t3" } } });

    const outcome = await executor.runFile("scripts/off-limits.js", {
      sessionId: "t3",
      sessionNamespace: AGENT_SESSION,
      tools: gateway.wrap([write.tool], { origin: "script", sessionId: "t3" }),
    });
    executor.dispose("t3");

    expect(outcome.value).toBe("blocked");
    expect(write.calls).toHaveLength(0);
  });

  it("governs an archmax_eval call by the tool's own name exactly as by its camelCase key", async () => {
    const write = recordingTool("write_file");
    const { gateway, executor, events } = harness({});
    gateway.refresh("t3b", { state: "work", config: { configurable: { thread_id: "t3b" } } });

    const outcome = await executor.runCode(
      `
        await tools.write_file({ file_path: "output/a.md", content: "hi" });
        let caught = null;
        try { await tools.write_file({ file_path: "elsewhere/a.md" }); } catch (err) { caught = String(err.message); }
        caught;
      `,
      {
        sessionId: "t3b",
        sessionNamespace: AGENT_SESSION,
        prelude: true,
        tools: gateway.wrap([write.tool], { origin: "script", sessionId: "t3b" }),
        surface: gateway.surface("t3b"),
      },
    );
    executor.dispose("t3b");

    expect(outcome.ok, outcome.error?.message).toBe(true);
    expect(String(outcome.value)).toMatch(/elsewhere\/a\.md/);
    expect(write.calls).toEqual([{ file_path: "output/a.md", content: "hi" }]);
    expect(events.map((e) => e.type)).toEqual(["tool-called", "tool-result", "tool-blocked"]);
  });

  it("governs a code state's script against its state, like any script: its grant and the safety rules", async () => {
    const CODE_SPEC: MachineSpec = {
      states: {
        check: {
          type: "code",
          script: "scripts/check.js",
          triggers: { manual: null },
          tools: { allow: [{ tool: "write_file", args: { file_path: ["output/**"] } }] },
          transitions: [{ to: "done", description: "Test edge to done." }],
        },
        done: {},
      },
    };
    const machine = WorkflowMachine.fromSpec(CODE_SPEC);
    const events: WorkflowLifecycleEvent[] = [];
    const gateway = createPtcToolGateway({
      machine,
      mountPrefixes: { dirs: ["skills"], files: ["AGENTS.md"], writable: [], governed: [], unsearchable: [] },
      emit: (event) => events.push(event as WorkflowLifecycleEvent),
    });
    const executor = createScriptExecutor({
      workspace: workspaceWith({
        "/workflows/w/scripts/check.js": `
          export default async function ({ tools }) {
            const results = [];
            for (const file_path of ["output/a.md", "elsewhere/a.md", "AGENTS.md"]) {
              try { await tools.write_file({ file_path }); results.push("ok"); }
              catch (err) { results.push("blocked"); }
            }
            console.log(JSON.stringify(results));
          }
        `,
      }),
    });
    const write = recordingTool("write_file");
    gateway.refresh("t4", { state: "check", config: { configurable: { thread_id: "t4" } } });

    const outcome = await executor.runCodeState("workflows/w/scripts/check.js", {
      sessionId: "t4",
      args: { state: "check" },
      tools: gateway.wrap([write.tool], { origin: "script", sessionId: "t4" }),
      surface: [...machine.disclosedTools("check")],
    });
    executor.dispose("t4");

    expect(outcome.ok, outcome.error?.message).toBe(true);
    expect(JSON.parse(outcome.logs[0]!)).toEqual(["ok", "blocked", "blocked"]);
    expect(write.calls).toEqual([{ file_path: "output/a.md" }]);
    expect(events.filter((e) => e.type === "tool-blocked")).toHaveLength(2);
    for (const event of events) expect(event).toMatchObject({ origin: "script", state: "check" });
  });

  it("serves a declarative tool mock to a script's PTC call", async () => {
    const read = recordingTool("read_file");
    const { gateway, executor } = harness({
      "/scripts/read.js": `await tools.readFile({ file_path: "data/orders.json" });`,
    });
    gateway.refresh("t5", {
      state: "work",
      config: {
        configurable: {
          thread_id: "t5",
          __toolMocks: [{ name: "read_file", result: "MOCKED ORDERS" }],
        },
      },
    });

    const outcome = await executor.runFile("scripts/read.js", {
      sessionId: "t5",
      sessionNamespace: AGENT_SESSION,
      tools: gateway.wrap([read.tool], { origin: "script", sessionId: "t5" }),
    });
    executor.dispose("t5");

    expect(outcome.value).toBe("MOCKED ORDERS");
    expect(read.calls).toHaveLength(0);
  });
});

describe("delegation through the sandbox", () => {
  const DELEGATING: MachineSpec = {
    states: {
      work: { triggers: { manual: null }, tools: { allow: ["archmax_workflow_enrich-order"] }, transitions: [{ to: "done", description: "Test edge to done." }] },
      done: {},
    },
  };

  /** A delegation tool whose calls overlap observably until released. */
  function gatedDelegationTool() {
    let inFlight = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const tool = {
      name: "archmax_workflow_enrich-order",
      description: "runs enrich-order",
      schema: { type: "object" },
      async invoke(input: unknown) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => gates.push(resolve));
        inFlight -= 1;
        return JSON.stringify({ message: "ok", returns: { id: (input as { id: string }).id } });
      },
    };
    return {
      tool: tool as unknown as StructuredTool,
      peak: () => peak,
      release: () => gates.splice(0).forEach((g) => g()),
      pending: () => gates.length,
    };
  }

  function delegatingHarness(files: Record<string, string>) {
    const events: WorkflowLifecycleEvent[] = [];
    return {
      events,
      gateway: createPtcToolGateway({
        machine: WorkflowMachine.fromSpec(DELEGATING),
        mountPrefixes: { dirs: ["skills", "workflows", "data"], files: [], writable: [], governed: [], unsearchable: [] },
        emit: (event) => events.push(event as WorkflowLifecycleEvent),
      }),
      executor: createScriptExecutor({ workspace: workspaceWith(files) }),
    };
  }

  it("lets a script call a delegation tool the state allows", async () => {
    const delegate = recordingTool("archmax_workflow_enrich-order");
    const { gateway, executor, events } = delegatingHarness({
      "/scripts/delegate.js": `await tools.archmaxWorkflowEnrichOrder({ order_id: "ORD-1" });`,
    });
    gateway.refresh("d1", { state: "work", config: { configurable: { thread_id: "d1" } } });

    const outcome = await executor.runFile("scripts/delegate.js", {
      sessionId: "d1",
      sessionNamespace: AGENT_SESSION,
      tools: gateway.wrap([delegate.tool], { origin: "script", sessionId: "d1" }),
    });
    executor.dispose("d1");

    expect(outcome.ok).toBe(true);
    expect(delegate.calls).toEqual([{ order_id: "ORD-1" }]);
    expect(events.map((e) => e.type)).toEqual(["tool-called", "tool-result"]);
  });

  it("refuses a delegation the calling state does not allow", async () => {
    const other = recordingTool("archmax_workflow_audit");
    const { gateway, executor, events } = delegatingHarness({
      "/scripts/nope.js": `
        let caught = null;
        try { await tools.archmaxWorkflowAudit({}); } catch (err) { caught = String(err.message); }
        caught;
      `,
    });
    gateway.refresh("d2", { state: "work", config: { configurable: { thread_id: "d2" } } });

    const outcome = await executor.runFile("scripts/nope.js", {
      sessionId: "d2",
      sessionNamespace: AGENT_SESSION,
      tools: gateway.wrap([other.tool], { origin: "script", sessionId: "d2" }),
    });
    executor.dispose("d2");

    // The same kernel verdict an agent-initiated call would get: a delegation
    // tool is governed by name like any other, with no rule of its own — and the
    // refusal is catchable, so a script handles it rather than dying on it.
    expect(outcome.ok).toBe(true);
    expect(String(outcome.value)).toMatch(/not allowed|BLOCKED/i);
    expect(other.calls).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual(["tool-blocked"]);
  });

  it("fails a script's delegation closed when the child parks", async () => {
    // A QuickJS frame is not durable, so there is nothing to resume into. The
    // suspension must not escape either: it would unwind the segment that ran
    // the script, which is the one thing the delegated-park design prevents.
    const parking = {
      name: "archmax_workflow_enrich-order",
      description: "runs enrich-order",
      schema: { type: "object" },
      async invoke() {
        const err = Object.assign(new Error("interrupt"), {
          interrupts: [{ value: { state: "review" } }],
        });
        Object.defineProperty(err, SUB_WORKFLOW_PARK, {
          value: {
            workflow: "enrich-order",
            identity: "1",
            dispatchId: "1",
            decision: { state: "review" },
          },
          enumerable: false,
        });
        throw err;
      },
    } as unknown as StructuredTool;

    const { gateway, executor } = delegatingHarness({
      "/scripts/parks.js": `
        let caught = null;
        try { await tools.archmaxWorkflowEnrichOrder({ order_id: "A" }); }
        catch (err) { caught = String(err.message); }
        caught;
      `,
    });
    gateway.refresh("d4", { state: "work", config: { configurable: { thread_id: "d4" } } });

    const outcome = await executor.runFile("scripts/parks.js", {
      sessionId: "d4",
      sessionNamespace: AGENT_SESSION,
      tools: gateway.wrap([parking], { origin: "script", sessionId: "d4" }),
    });
    executor.dispose("d4");

    expect(outcome.ok).toBe(true);
    expect(String(outcome.value)).toContain("stopped for a person");
    expect(String(outcome.value)).toContain("a script cannot wait for one");
  });

  it("runs Promise.all delegations concurrently across the bridge", async () => {
    // The reason there is no fan-out argument: the bridge starts each host call
    // detached and returns its promise handle immediately, so calls issued
    // before an await are all in flight at once.
    const gated = gatedDelegationTool();
    const { gateway, executor } = delegatingHarness({
      "/scripts/fan-out.js": `
        const ids = ["a", "b", "c"];
        const results = await Promise.all(
          ids.map((id) => tools.archmaxWorkflowEnrichOrder({ id })),
        );
        results.length;
      `,
    });
    gateway.refresh("d3", { state: "work", config: { configurable: { thread_id: "d3" } } });

    const running = executor.runFile("scripts/fan-out.js", {
      sessionId: "d3",
      sessionNamespace: AGENT_SESSION,
      tools: gateway.wrap([gated.tool], { origin: "script", sessionId: "d3" }),
    });

    // All three reach the gate before any of them settles.
    while (gated.pending() < 3) await new Promise((r) => setTimeout(r, 1));
    expect(gated.peak()).toBe(3);
    gated.release();

    const outcome = await running;
    executor.dispose("d3");
    expect(outcome.ok).toBe(true);
    expect(String(outcome.value)).toContain("3");
  });
});

describe("skill governance through the sandbox", () => {
  const SKILLS = [
    { slug: "order-data", prefix: "skills/order-data" },
    { slug: "refund-policy", prefix: "skills/refund-policy" },
  ];
  const SKILL_SPEC: MachineSpec = {
    skills: { allow_always: [] },
    states: { work: { triggers: { manual: null }, skills: { allow: ["order-data"] } } },
  };

  function skillHarness(files: Record<string, string>) {
    const events: WorkflowLifecycleEvent[] = [];
    const gateway = createPtcToolGateway({
      machine: WorkflowMachine.fromSpec(SKILL_SPEC),
      mountPrefixes: { dirs: ["skills"], files: [], writable: [], governed: [], unsearchable: [] },
      skills: SKILLS,
      emit: (event) => events.push(event as WorkflowLifecycleEvent),
    });
    const executor = createScriptExecutor({ workspace: workspaceWith(files) });
    return { gateway, executor, events };
  }

  const PROBE = `
    const results = [];
    for (const path of [
      "skills/order-data/assets/orders.json",
      "skills/refund-policy/rules.json",
    ]) {
      try { await tools.readFile({ file_path: path }); results.push("ok"); }
      catch (err) { results.push("blocked"); }
    }
    results;
  `;

  it("binds a script's call to the state's enabled skills", async () => {
    const read = recordingTool("read_file");
    const { gateway, executor, events } = skillHarness({ "/scripts/probe.js": PROBE });
    gateway.refresh("s1", { state: "work", config: { configurable: { thread_id: "s1" } } });

    const outcome = await executor.runFile("scripts/probe.js", {
      sessionId: "s1",
      sessionNamespace: AGENT_SESSION,
      tools: gateway.wrap([read.tool], { origin: "script", sessionId: "s1" }),
    });
    executor.dispose("s1");

    expect(outcome.value).toEqual(["ok", "blocked"]);
    expect(read.calls).toEqual([{ file_path: "skills/order-data/assets/orders.json" }]);
    expect(events.at(-1)).toMatchObject({ type: "tool-blocked", origin: "script" });
  });

  it("filters a script's listing to the state's enabled bundles", async () => {
    // The leak this closes: the model is refused `ls skills/` directly, then
    // reaches for the same tool through the sandbox.
    const ls = {
      name: "ls",
      description: "ls",
      schema: { type: "object" },
      async invoke() {
        return ["/skills/order-data (directory)", "/skills/refund-policy (directory)"].join("\n");
      },
    } as unknown as StructuredTool;
    const { gateway, executor } = skillHarness({
      "/scripts/list.js": `await tools.ls({ path: "skills/" });`,
    });
    gateway.refresh("s3", { state: "work", config: { configurable: { thread_id: "s3" } } });

    const outcome = await executor.runFile("scripts/list.js", {
      sessionId: "s3",
      sessionNamespace: AGENT_SESSION,
      tools: gateway.wrap([ls], { origin: "script", sessionId: "s3" }),
    });
    executor.dispose("s3");

    expect(outcome.value).toBe("/skills/order-data (directory)");
  });

  it("holds a code state's script to the same enabled set and listing filter", async () => {
    const read = recordingTool("read_file");
    const ls = {
      name: "ls",
      description: "ls",
      schema: { type: "object" },
      async invoke() {
        return ["/skills/order-data (directory)", "/skills/refund-policy (directory)"].join("\n");
      },
    } as unknown as StructuredTool;
    const { gateway, executor } = skillHarness({
      "/workflows/w/scripts/probe.js": `${PROBE.replace(/results;\s*$/, "")}
        console.log(JSON.stringify([results, await tools.ls({ path: "skills/" })]));`,
    });
    gateway.refresh("s2", { state: "work", config: { configurable: { thread_id: "s2" } } });

    const outcome = await executor.runCodeState("workflows/w/scripts/probe.js", {
      sessionId: "s2",
      args: {},
      tools: gateway.wrap([read.tool, ls], { origin: "script", sessionId: "s2" }),
      surface: ["read_file", "ls"],
    });
    executor.dispose("s2");

    expect(outcome.ok, outcome.error?.message).toBe(true);
    expect(JSON.parse(outcome.logs[0]!)).toEqual([["ok", "blocked"], "/skills/order-data (directory)"]);
    expect(read.calls).toEqual([{ file_path: "skills/order-data/assets/orders.json" }]);
  });
});

describe("a script's tools follow its state", () => {
  /** `work` offers `alpha`, `done` offers `beta`; both are registered. */
  const SCOPED: MachineSpec = {
    states: {
      work: { triggers: { manual: null }, tools: { allow: ["alpha"] }, transitions: [{ to: "done", description: "Finish." }] },
      done: { tools: { allow: ["beta"] } },
    },
  };

  function scopedHarness() {
    const machine = WorkflowMachine.fromSpec(SCOPED);
    const events: WorkflowLifecycleEvent[] = [];
    const gateway = createPtcToolGateway({ machine, emit: (event) => events.push(event as WorkflowLifecycleEvent) });
    const executor = createScriptExecutor({ workspace: workspaceWith({}) });
    const alpha = recordingTool("alpha");
    const beta = recordingTool("beta");
    const tools = gateway.wrap([alpha.tool, beta.tool], { origin: "script", sessionId: "v1" });
    /** One `archmax_eval`, as the interpreter runs it: the scope's tools and its current surface. */
    const evaluate = (code: string) =>
      executor.runCode(code, {
        sessionId: "v1",
        sessionNamespace: AGENT_SESSION,
        prelude: true,
        tools,
        surface: gateway.surface("v1"),
      });
    const enter = (state: string) => gateway.refresh("v1", { state, config: { configurable: { thread_id: "v1" } } });
    return { executor, events, alpha, beta, evaluate, enter };
  }

  it("lists the active state's tools, and the next state's after the run moves", async () => {
    const { executor, evaluate, enter } = scopedHarness();
    enter("work");
    const inWork = await evaluate("[Object.keys(tools), 'alpha' in tools, 'beta' in tools]");
    enter("done");
    const inDone = await evaluate("Object.keys(tools)");
    executor.dispose("v1");

    expect(inWork.value).toEqual([["alpha"], true, false]);
    expect(inDone.value).toEqual(["beta"]);
  });

  it("keeps one object, so a reference an earlier evaluation kept reads the current state", async () => {
    const { executor, evaluate, enter } = scopedHarness();
    enter("work");
    await evaluate("const kept = tools; const listing = () => Object.keys(tools);");
    enter("done");
    const later = await evaluate("[Object.keys(kept), kept === tools, listing()]");
    executor.dispose("v1");

    expect(later.value).toEqual([["beta"], true, ["beta"]]);
  });

  it("puts the view back on the next evaluation after a script overwrites it", async () => {
    const { executor, evaluate, enter } = scopedHarness();
    enter("work");
    await evaluate("tools = null;");
    const restored = await evaluate("Object.keys(tools)");
    executor.dispose("v1");

    expect(restored.value).toEqual(["alpha"]);
  });

  it("leaves a hidden tool undefined, so a call to it never reaches the tool or governance", async () => {
    const { executor, events, beta, evaluate, enter } = scopedHarness();
    enter("work");
    const outcome = await evaluate(`
      let caught = null;
      try { await tools.beta({}); } catch (err) { caught = err instanceof TypeError; }
      [typeof tools.beta, "beta" in tools, caught];
    `);
    executor.dispose("v1");

    expect(outcome.ok, outcome.error?.message).toBe(true);
    expect(outcome.value).toEqual(["undefined", false, true]);
    expect(beta.calls).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it("calls a visible tool as before", async () => {
    const { executor, alpha, evaluate, enter } = scopedHarness();
    enter("work");
    const outcome = await evaluate("await tools.alpha({ n: 1 })");
    executor.dispose("v1");

    expect(outcome.value).toBe("alpha:done");
    expect(alpha.calls).toEqual([{ n: 1 }]);
  });

  it("gives a code state's script its state's surface, its controls included", async () => {
    const CODE_SCOPED: MachineSpec = {
      states: {
        work: { triggers: { manual: null }, tools: { allow: ["alpha"] }, transitions: [{ to: "check", description: "Check." }] },
        check: { type: "code", script: "scripts/keys.js", tools: { allow: ["beta"] }, transitions: [{ to: "work", description: "Back." }] },
      },
    };
    const machine = WorkflowMachine.fromSpec(CODE_SCOPED);
    const gateway = createPtcToolGateway({ machine, emit: () => {} });
    gateway.refresh("h1", { state: "check", config: {} });
    const executor = createScriptExecutor({
      workspace: workspaceWith({
        "/workflows/w/scripts/keys.js": `export default ({ tools }) => { console.log(JSON.stringify(Object.keys(tools).sort())); };`,
      }),
    });
    const registered = ["alpha", "beta", "archmax_advance", "archmax_raise", "archmax_eval"].map((n) => recordingTool(n).tool);
    const outcome = await executor.runCodeState("workflows/w/scripts/keys.js", {
      sessionId: "h1",
      args: { state: "check" },
      tools: gateway.wrap(registered, { origin: "script", sessionId: "h1" }),
      surface: [...machine.disclosedTools("check")],
    });
    executor.dispose("h1");

    expect(outcome.ok, outcome.error?.message).toBe(true);
    // `alpha` is the other state's, and `archmax_eval` no automated state offers.
    expect(JSON.parse(outcome.logs[0]!)).toEqual(["archmaxAdvance", "archmaxRaise", "beta"]);
  });
});
