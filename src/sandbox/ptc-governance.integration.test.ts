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
 * End-to-end coverage of the PTC path as scripts actually take it: a real
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

  it("lets a lifecycle hook past the state's allow list but not past a safety rule", async () => {
    const write = recordingTool("write_file");
    const { gateway, executor } = harness({
      "/scripts/hook.js": `
        const results = [];
        try {
          await tools.writeFile({ file_path: "elsewhere/a.md" });
          results.push("outside-allow:ok");
        } catch (err) { results.push("outside-allow:blocked"); }
        try {
          await tools.writeFile({ file_path: "AGENTS.md" });
          results.push("read-only:ok");
        } catch (err) { results.push("read-only:blocked"); }
        results;
      `,
    });
    gateway.refresh("t4", { state: "work", config: { configurable: { thread_id: "t4" } } });

    const outcome = await executor.runFile("scripts/hook.js", {
      sessionId: "t4",
      sessionNamespace: AGENT_SESSION,
      tools: gateway.wrap([write.tool], { origin: "lifecycle", sessionId: "t4" }),
    });
    executor.dispose("t4");

    expect(outcome.value).toEqual(["outside-allow:ok", "read-only:blocked"]);
    expect(write.calls).toEqual([{ file_path: "elsewhere/a.md" }]);
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
            identity: "s:enrich-order:0",
            dispatchId: "subwf-1",
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

  it("leaves a lifecycle hook's listing whole", async () => {
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
    gateway.refresh("s4", { state: "work", config: { configurable: { thread_id: "s4" } } });

    const outcome = await executor.runFile("scripts/list.js", {
      sessionId: "s4",
      sessionNamespace: AGENT_SESSION,
      tools: gateway.wrap([ls], { origin: "lifecycle", sessionId: "s4" }),
    });
    executor.dispose("s4");

    expect(String(outcome.value).split("\n")).toHaveLength(2);
  });

  it("exempts a lifecycle hook's call from the enabled set", async () => {
    const read = recordingTool("read_file");
    const { gateway, executor } = skillHarness({ "/scripts/probe.js": PROBE });
    gateway.refresh("s2", { state: "work", config: { configurable: { thread_id: "s2" } } });

    const outcome = await executor.runFile("scripts/probe.js", {
      sessionId: "s2",
      sessionNamespace: AGENT_SESSION,
      tools: gateway.wrap([read.tool], { origin: "lifecycle", sessionId: "s2" }),
    });
    executor.dispose("s2");

    expect(outcome.value).toEqual(["ok", "ok"]);
    expect(read.calls).toHaveLength(2);
  });
});
