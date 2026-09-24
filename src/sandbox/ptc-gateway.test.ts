import { describe, expect, it } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { WorkflowMachine } from "../machine/machine.js";
import type { MachineSpec } from "../machine/types.js";
import type { WorkflowLifecycleEvent } from "../core/events.js";
import type { GovernanceRule } from "../kernel/kernel.js";
import { createPtcToolGateway, PtcGovernanceError, type PtcToolGateway } from "./ptc-gateway.js";

const SPEC: MachineSpec = {
  states: {
    work: {
      triggers: { manual: null },
      tools: { allow: [{ tool: "write_file", args: { file_path: ["output/**"] } }] },
      transitions: [{ to: "done", description: "Test edge to done." }],
    },
    // Narrower than `work`, so the same call's verdict depends on which state
    // is active — `write_file` is an essential built-in, so a state must name
    // it to constrain it at all.
    done: { tools: { allow: [{ tool: "write_file", args: { file_path: ["output/final/**"] } }] } },
  },
};

/** A stand-in for a bound agent tool: records what it was invoked with. */
function fakeTool(
  name: string,
  impl: (input: unknown, config?: RunnableConfig) => unknown = () => "ok",
): StructuredTool & { calls: { input: unknown; config?: RunnableConfig }[] } {
  const calls: { input: unknown; config?: RunnableConfig }[] = [];
  const tool = {
    name,
    description: `the ${name} tool`,
    schema: { type: "object" },
    calls,
    async invoke(input: unknown, config?: RunnableConfig) {
      calls.push({ input, config });
      return impl(input, config);
    },
  };
  return tool as unknown as StructuredTool & typeof tool;
}

function setup(opts: { spec?: MachineSpec; policyRules?: GovernanceRule[] } = {}) {
  const machine = WorkflowMachine.fromSpec(opts.spec ?? SPEC);
  const events: WorkflowLifecycleEvent[] = [];
  const gateway: PtcToolGateway = createPtcToolGateway({
    machine,
    mountPrefixes: { dirs: ["skills", "workflows", "data"], files: ["AGENTS.md"], writable: [], governed: [], unsearchable: [] },
    ...(opts.policyRules ? { policyRules: opts.policyRules } : {}),
    emit: (event) => events.push(event as WorkflowLifecycleEvent),
  });
  gateway.refresh("t1", { state: "work", config: { configurable: { thread_id: "t1" } } });
  return { machine, gateway, events };
}

const toolEvents = (events: WorkflowLifecycleEvent[]) =>
  events.filter((e) => e.type.startsWith("tool-")).map((e) => e.type);

describe("PTC tool gateway", () => {
  it("preserves the tool's identity so the sandbox bridge is unaffected", () => {
    const { gateway } = setup();
    const inner = fakeTool("read_file");
    const [wrapped] = gateway.wrap([inner], { origin: "script", sessionId: "t1" });
    expect(wrapped.name).toBe("read_file");
    expect(wrapped.description).toBe("the read_file tool");
    expect(wrapped.schema).toBe(inner.schema);
  });

  it("runs an allowed script call and emits a paired call/result", async () => {
    const { gateway, events } = setup();
    const inner = fakeTool("write_file");
    const [wrapped] = gateway.wrap([inner], { origin: "script", sessionId: "t1" });

    await wrapped.invoke({ file_path: "output/a.md", content: "x" } as never);

    expect(inner.calls).toHaveLength(1);
    expect(toolEvents(events)).toEqual(["tool-called", "tool-result"]);
    const [called, result] = events as [
      Extract<WorkflowLifecycleEvent, { type: "tool-called" }>,
      Extract<WorkflowLifecycleEvent, { type: "tool-result" }>,
    ];
    expect(called.origin).toBe("script");
    expect(called.state).toBe("work");
    expect(called.detail).toBe("output/a.md");
    expect(result.callId).toBe(called.callId);
    expect(result.status).toBe("ok");
    expect(result.origin).toBe("script");
  });

  it("hands the call's own id to the tool, so a dispatch of its own can name it", async () => {
    // A delegation tool reads the call id off its runtime to name the sub-run it
    // starts. LangChain populates that for an agent-initiated call and leaves it
    // empty for one the sandbox bridge makes — so the gateway passes the id it
    // just announced, and a script's sub-run is as attributable as an agent's.
    const { gateway, events } = setup();
    const inner = fakeTool("write_file");
    const [wrapped] = gateway.wrap([inner], { origin: "script", sessionId: "t1" });

    await wrapped.invoke({ file_path: "output/a.md", content: "x" } as never);

    const called = events.find((e) => e.type === "tool-called") as { callId: string };
    const config = inner.calls[0]?.config as { toolCallId?: string; configurable?: unknown };
    expect(config.toolCallId).toBe(called.callId);
    // The segment's own config still reaches the tool alongside it.
    expect(config.configurable).toMatchObject({ thread_id: "t1" });
  });

  it("blocks a script call the state forbids, emitting only tool-blocked", async () => {
    const { gateway, events } = setup();
    const inner = fakeTool("write_file");
    const [wrapped] = gateway.wrap([inner], { origin: "script", sessionId: "t1" });

    await expect(
      wrapped.invoke({ file_path: "elsewhere/nope.md" } as never),
    ).rejects.toBeInstanceOf(PtcGovernanceError);

    expect(inner.calls).toHaveLength(0);
    expect(toolEvents(events)).toEqual(["tool-blocked"]);
    const blocked = events[0] as Extract<WorkflowLifecycleEvent, { type: "tool-blocked" }>;
    expect(blocked.origin).toBe("script");
    expect(blocked.tool).toBe("write_file");
  });

  it("blocks a read-only-zone write whatever the origin", async () => {
    const { gateway } = setup();
    for (const origin of ["script", "lifecycle"] as const) {
      const inner = fakeTool("write_file");
      const [wrapped] = gateway.wrap([inner], { origin, sessionId: "t1" });
      const err = await wrapped
        .invoke({ file_path: "skills/x.md", content: "x" } as never)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PtcGovernanceError);
      expect((err as PtcGovernanceError).ruleId).toBe("zone.read-only");
      expect(inner.calls).toHaveLength(0);
    }
  });

  it("lets a lifecycle call past the state's allow list", async () => {
    const { gateway } = setup();
    const inner = fakeTool("write_file");
    const [wrapped] = gateway.wrap([inner], { origin: "lifecycle", sessionId: "t1" });
    // Outside the state's `output/**` constraint — refused for a script,
    // permitted for a hook running on harness authority.
    await wrapped.invoke({ file_path: "other/a.md", content: "x" } as never);
    expect(inner.calls).toHaveLength(1);
  });

  it("surfaces the governance reason in a catchable error", async () => {
    const { gateway } = setup();
    const [wrapped] = gateway.wrap([fakeTool("write_file")], { origin: "script", sessionId: "t1" });
    let caught: unknown;
    try {
      await wrapped.invoke({ file_path: "skills/x.md" } as never);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PtcGovernanceError);
    expect((caught as Error).message).toContain("read-only");
    expect((caught as PtcGovernanceError).tool).toBe("write_file");
  });

  it("applies consumer policy rules to PTC calls", async () => {
    const blockFetch: GovernanceRule = (action) =>
      action.kind === "tool-call" && action.tool === "web_fetch"
        ? { decision: "block", ruleId: "custom.fetch", reason: "no network", warn: true }
        : null;
    const { gateway } = setup({ policyRules: [blockFetch] });
    const inner = fakeTool("web_fetch");
    const [wrapped] = gateway.wrap([inner], { origin: "script", sessionId: "t1" });
    const err = await wrapped.invoke({ url: "https://x.test" } as never).catch((e: unknown) => e);
    expect((err as PtcGovernanceError).ruleId).toBe("custom.fetch");
    expect(inner.calls).toHaveLength(0);
  });

  it("forwards the segment's runtime config to the underlying tool", async () => {
    const { gateway } = setup();
    const signal = new AbortController().signal;
    gateway.refresh("t1", {
      state: "work",
      config: { configurable: { thread_id: "t1" }, signal },
    });
    const inner = fakeTool("read_file");
    const [wrapped] = gateway.wrap([inner], { origin: "script", sessionId: "t1" });

    await wrapped.invoke({ file_path: "data/orders.json" } as never);

    expect(inner.calls[0]?.config?.configurable?.thread_id).toBe("t1");
    expect(inner.calls[0]?.config?.signal).toBe(signal);
  });

  it("governs each call against the state current at call time", async () => {
    const { gateway, events } = setup();
    const inner = fakeTool("write_file");
    // Wrapped once, as a frozen REPL session would hold it.
    const [wrapped] = gateway.wrap([inner], { origin: "script", sessionId: "t1" });

    await wrapped.invoke({ file_path: "output/a.md" } as never);
    expect(inner.calls).toHaveLength(1);

    // The run advances; `done` declares no allow list, so the same call is now
    // outside the state's surface.
    gateway.refresh("t1", { state: "done", config: { configurable: { thread_id: "t1" } } });
    await expect(wrapped.invoke({ file_path: "output/a.md" } as never)).rejects.toBeInstanceOf(
      PtcGovernanceError,
    );
    expect(inner.calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "tool-blocked", state: "done" });
  });

  it("keeps each session's context independent", async () => {
    const { gateway } = setup();
    gateway.refresh("t2", { state: "done", config: { configurable: { thread_id: "t2" } } });
    const one = fakeTool("write_file");
    const two = fakeTool("write_file");
    const [wrappedOne] = gateway.wrap([one], { origin: "script", sessionId: "t1" });
    const [wrappedTwo] = gateway.wrap([two], { origin: "script", sessionId: "t2" });

    await wrappedOne.invoke({ file_path: "output/a.md" } as never);
    await expect(wrappedTwo.invoke({ file_path: "output/a.md" } as never)).rejects.toThrow();

    expect(one.calls).toHaveLength(1);
    expect(two.calls).toHaveLength(0);
  });

  it("serves a declarative mock instead of the real tool", async () => {
    const { gateway, events } = setup();
    gateway.refresh("t1", {
      state: "work",
      config: {
        configurable: {
          thread_id: "t1",
          __toolMocks: [{ name: "read_file", whenInput: { file_path: "data/orders.json" }, result: "MOCKED" }],
        },
      },
    });
    const inner = fakeTool("read_file");
    const [wrapped] = gateway.wrap([inner], { origin: "script", sessionId: "t1" });

    const hit = await wrapped.invoke({ file_path: "data/orders.json" } as never);
    expect(hit).toBe("MOCKED");
    expect(inner.calls).toHaveLength(0);
    expect(toolEvents(events)).toEqual(["tool-called", "tool-result"]);

    // A non-matching input falls through to the real tool.
    const miss = await wrapped.invoke({ file_path: "data/other.json" } as never);
    expect(miss).toBe("ok");
    expect(inner.calls).toHaveLength(1);
  });

  it("refuses a mocked call the state forbids (governance precedes mocks)", async () => {
    const { gateway } = setup();
    gateway.refresh("t1", {
      state: "work",
      config: {
        configurable: {
          thread_id: "t1",
          __toolMocks: [{ name: "write_file", result: "MOCKED" }],
        },
      },
    });
    const [wrapped] = gateway.wrap([fakeTool("write_file")], { origin: "script", sessionId: "t1" });
    await expect(wrapped.invoke({ file_path: "skills/x.md" } as never)).rejects.toBeInstanceOf(
      PtcGovernanceError,
    );
  });

  it("reports a failing tool as an error result and rethrows", async () => {
    const { gateway, events } = setup();
    const inner = fakeTool("read_file", () => {
      throw new Error("disk on fire");
    });
    const [wrapped] = gateway.wrap([inner], { origin: "script", sessionId: "t1" });

    await expect(wrapped.invoke({ file_path: "data/x.json" } as never)).rejects.toThrow(
      "disk on fire",
    );
    expect(toolEvents(events)).toEqual(["tool-called", "tool-result"]);
    expect(events.at(-1)).toMatchObject({ type: "tool-result", status: "error" });
    expect((events.at(-1) as { output: string }).output).toContain("disk on fire");
  });
});

describe("PTC calls are not interpolated", () => {
  // The agent's own arguments are substituted at `wrapToolCall`; a script's are
  // not, even with variables in force. A script passes computed values and holds
  // the run's variables as `args.variables`, so reference text reaching a
  // `tools.*` call is data — substituting would refuse or rewrite it.
  const passesThrough = async (origin: "script" | "lifecycle") => {
    const { gateway } = setup();
    gateway.refresh("t1", {
      state: "work",
      config: { configurable: { thread_id: "t1" } },
      variables: { order_id: { value: "ORD-7", locked: true } },
    });
    const inner = fakeTool("write_file");
    const [wrapped] = gateway.wrap([inner], { origin, sessionId: "t1" });
    await wrapped.invoke({ file_path: "output/a.json", content: "${{order_id}} and ${{not_a_var}}" });
    return inner.calls[0]?.input;
  };

  it("passes a script's reference text through untouched", async () => {
    expect(await passesThrough("script")).toEqual({
      file_path: "output/a.json",
      content: "${{order_id}} and ${{not_a_var}}",
    });
  });

  it("passes a lifecycle hook's reference text through untouched", async () => {
    expect(await passesThrough("lifecycle")).toEqual({
      file_path: "output/a.json",
      content: "${{order_id}} and ${{not_a_var}}",
    });
  });

  it("resolves a state's variable guard for a script call the same way it does for the model", async () => {
    const guarded: MachineSpec = {
      states: {
        work: {
          triggers: { manual: null },
          tools: { allow: [{ tool: "write_file", args: { file_path: ["${{report_path}}"] } }] },
        },
      },
    };
    const { gateway, events } = setup({ spec: guarded });
    gateway.refresh("t1", {
      state: "work",
      config: { configurable: { thread_id: "t1" } },
      variables: { report_path: { value: "output/r.json", locked: true } },
    });
    const inner = fakeTool("write_file");
    const [wrapped] = gateway.wrap([inner], { origin: "script", sessionId: "t1" });

    await wrapped.invoke({ file_path: "output/r.json", content: "x" } as never);
    expect(inner.calls).toHaveLength(1);
    await expect(wrapped.invoke({ file_path: "output/other.json", content: "x" } as never)).rejects.toBeInstanceOf(
      PtcGovernanceError,
    );
    expect(inner.calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "tool-blocked", tool: "write_file", origin: "script" });
  });
});
