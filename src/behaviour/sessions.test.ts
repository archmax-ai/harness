/**
 * Run-level surfaces: session handles (`list` / `get` / `delete` / `seed`),
 * token accounting (`model-usage` events and summary totals), the spec snapshot,
 * and run artifacts — all read back through the public API and the session
 * store, never the filesystem directly.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createMemorySessionStore, type MachineSpec } from "../index.js";
import {
  advanceTo,
  assemble,
  cleanupWorkspaces,
  eventsOf,
  linearSpec,
  ScriptedModel,
  storeFile,
  toolResults,
  turn,
  workspaceWith,
} from "./support.js";

afterEach(cleanupWorkspaces);

describe("sessions", () => {
  it("reports no session before a run and a projection after it", async () => {
    const { agent } = await assemble(workspaceWith(linearSpec()), {
      turns: [advanceTo("done"), { reply: "ok" }],
    });
    expect(await agent.sessions.get("s1")).toBeNull();
    await turn(agent, "s1", "go");
    const summary = await agent.sessions.get("s1");
    expect(summary).toMatchObject({
      sessionId: "s1",
      status: "completed",
      classification: "finished",
      workflowState: "done",
    });
    expect(typeof summary?.specHash).toBe("string");
    expect(summary?.parentSessionId).toBeUndefined();
  });

  it("lists every durable session, each under its own id", async () => {
    const { agent, model } = await assemble(workspaceWith(linearSpec()), {
      turns: [advanceTo("done"), { reply: "a" }],
    });
    await turn(agent, "a", "go");
    model.enqueue({ reply: "b" });
    await turn(agent, "b", "go");
    const listed = await agent.sessions.list();
    expect(listed.map((s) => s.sessionId).sort()).toEqual(["a", "b"]);
    expect(listed.find((s) => s.sessionId === "a")?.workflowState).toBe("done");
    expect(listed.find((s) => s.sessionId === "b")?.workflowState).toBe("start");
  });

  it("deletes a session's state and reports whether anything was removed", async () => {
    const { agent, store } = await assemble(workspaceWith(linearSpec()), {
      turns: [{ tool: "write_file", args: { file_path: "scratchpad/x.txt", content: "x" } }, { reply: "ok" }],
    });
    await turn(agent, "s1", "go");
    expect(await storeFile(store, "/s1/scratchpad/x.txt")).toBe("x");

    expect(await agent.sessions.delete("s1")).toBe(true);
    expect(await agent.sessions.get("s1")).toBeNull();
    expect(await storeFile(store, "/s1/scratchpad/x.txt")).toBeUndefined();
    expect((await agent.sessions.list()).map((s) => s.sessionId)).not.toContain("s1");
    expect(await agent.sessions.delete("s1")).toBe(false);
  });

  it("starts a deleted session over as a new one", async () => {
    const { agent, events, model } = await assemble(workspaceWith(linearSpec()), {
      turns: [advanceTo("done"), { reply: "ok" }],
    });
    await turn(agent, "s1", "go");
    await agent.sessions.delete("s1");
    events.length = 0;
    model.enqueue({ reply: "fresh" });
    await turn(agent, "s1", "again");
    expect(eventsOf(events, "advance")[0]).toMatchObject({ from: "__start__", to: "start" });
  });

  it("seeds run-zone files the agent can read on its first turn", async () => {
    const { agent } = await assemble(workspaceWith(linearSpec()), {
      turns: [{ tool: "read_file", args: { file_path: "trigger.json" } }, { reply: "ok" }],
    });
    await agent.sessions.seed("s1", { "trigger.json": { company: "Acme" } });
    const { messages } = await turn(agent, "s1", "go");
    expect(toolResults(messages).find((r) => r.name === "read_file")?.content).toContain("Acme");
  });

  it("refuses to seed into a harness-internal or authored path", async () => {
    const { agent } = await assemble(workspaceWith(linearSpec()), { turns: [] });
    await expect(agent.sessions.seed("s1", { "checkpoints/x.json": "x" })).rejects.toThrow(/run-internal/);
    await expect(agent.sessions.seed("s1", { "skills/data/SKILL.md": "x" })).rejects.toThrow(/authored/);
  });

  it("shares one store between two assemblies, so a session is visible to both", async () => {
    const store = createMemorySessionStore();
    const root = workspaceWith(linearSpec());
    const first = await assemble(root, { turns: [advanceTo("done"), { reply: "ok" }], store });
    await turn(first.agent, "s1", "go");
    const second = await assemble(root, { turns: [], store });
    expect((await second.agent.sessions.get("s1"))?.status).toBe("completed");
  });
});

describe("usage", () => {
  it("emits model-usage per segment and accumulates the session's totals", async () => {
    const { agent, events } = await assemble(workspaceWith(linearSpec()), {
      turns: [
        { ...advanceTo("done"), usage: { input: 100, output: 10 } },
        { reply: "ok", usage: { input: 200, output: 20 } },
      ],
    });
    await turn(agent, "s1", "go");

    const usage = eventsOf(events, "model-usage");
    expect(usage).toMatchObject([
      { state: "start", inputTokens: 100, outputTokens: 10 },
      { state: "done", inputTokens: 200, outputTokens: 20 },
    ]);
    expect(usage[0]?.costUsd).toBeUndefined();
    // Neither the response nor the model exposes an id, so there is nothing to
    // attribute the call to and nothing is invented.
    expect(usage[0]?.model).toBeUndefined();

    const summary = await agent.sessions.get("s1");
    expect(summary?.usage).toMatchObject({ inputTokens: 300, outputTokens: 30 });
  });

  it("emits no usage when the model reports none, and the summary carries none", async () => {
    const { agent, events } = await assemble(workspaceWith(linearSpec()), {
      turns: [advanceTo("done"), { reply: "ok" }],
    });
    await turn(agent, "s1", "go");
    expect(eventsOf(events, "model-usage")).toEqual([]);
    expect((await agent.sessions.get("s1"))?.usage).toBeUndefined();
  });

  it("prices usage from a `default` entry", async () => {
    const { agent, events } = await assemble(workspaceWith(linearSpec()), {
      turns: [{ reply: "ok", usage: { input: 1_000_000, output: 1_000_000 } }],
      params: { pricing: { default: { input: 1, output: 2 } } },
    });
    await turn(agent, "s1", "go");
    expect(eventsOf(events, "model-usage")[0]?.costUsd).toBeCloseTo(3, 6);
    expect((await agent.sessions.get("s1"))?.usage?.costUsd).toBeCloseTo(3, 6);
  });

  it("prices usage from an entry named for the configured model when the response names none", async () => {
    // An OpenAI-compatible endpoint is not obliged to echo the model back, and
    // many proxies do not. The table below has no `default` to fall through to,
    // so the only way to a cost is the id the runtime asked the endpoint to run.
    const { agent, events } = await assemble(workspaceWith(linearSpec()), {
      model: new ScriptedModel([{ reply: "ok", usage: { input: 1_000_000, output: 1_000_000 } }], {
        model: "claude-opus-5",
      }),
      params: { pricing: { "claude-opus-5": { input: 1, output: 2 } } },
    });
    await turn(agent, "s1", "go");
    const usage = eventsOf(events, "model-usage")[0];
    expect(usage?.costUsd).toBeCloseTo(3, 6);
    expect(usage?.model).toBe("claude-opus-5");
    expect((await agent.sessions.get("s1"))?.usage?.costUsd).toBeCloseTo(3, 6);
  });

  it("prices against the model that answered, not the one that was asked for", async () => {
    // A proxy may serve an alias, a fallback or a load-balanced deployment; what
    // it served is the honest thing to price, so a reported id outranks ours.
    const { agent, events } = await assemble(workspaceWith(linearSpec()), {
      model: new ScriptedModel(
        [{ reply: "ok", usage: { input: 1_000_000, output: 0 }, reports: "served-model" }],
        { model: "requested-model" },
      ),
      params: {
        pricing: { "requested-model": { input: 1 }, "served-model": { input: 7 } },
      },
    });
    await turn(agent, "s1", "go");
    const usage = eventsOf(events, "model-usage")[0];
    expect(usage?.model).toBe("served-model");
    expect(usage?.costUsd).toBeCloseTo(7, 6);
  });

  it("prices each state against its own declared model when no response names one", async () => {
    const spec = linearSpec({ settings: { model: "small-model" } });
    (spec.states as Record<string, Record<string, unknown>>).done.model = "large-model";
    const models = new Map<string, ScriptedModel>();
    const { agent, events } = await assemble(workspaceWith(spec), {
      modelFactory: (_role, _env, requested) => {
        const id = requested ?? "small-model";
        let model = models.get(id);
        if (!model) {
          model = new ScriptedModel([], { model: id });
          models.set(id, model);
        }
        return model as unknown as never;
      },
    });
    models.get("small-model")?.enqueue({
      ...advanceTo("done"),
      usage: { input: 1_000_000, output: 0 },
    });
    models.get("large-model")?.enqueue({ reply: "ok", usage: { input: 1_000_000, output: 0 } });
    await turn(agent, "s1", "go");

    expect(eventsOf(events, "model-usage")).toMatchObject([
      { state: "start", model: "small-model" },
      { state: "done", model: "large-model" },
    ]);
  });

  it("accumulates usage across turns of one session", async () => {
    const { agent, model } = await assemble(workspaceWith(linearSpec()), {
      turns: [{ reply: "one", usage: { input: 10, output: 1 } }],
    });
    await turn(agent, "s1", "first");
    model.enqueue({ reply: "two", usage: { input: 20, output: 2 } });
    await turn(agent, "s1", "second");
    expect((await agent.sessions.get("s1"))?.usage).toMatchObject({ inputTokens: 30, outputTokens: 3 });
  });
});

describe("spec snapshot", () => {
  it("persists the governing spec by hash on the session's first run, resolvable later", async () => {
    const { agent } = await assemble(workspaceWith(linearSpec({ title: "Snapshotted" })), {
      turns: [advanceTo("done"), { reply: "ok" }],
    });
    expect(await agent.getSpecSnapshot("nope")).toBeNull();
    await turn(agent, "s1", "go");
    const hash = (await agent.sessions.get("s1"))!.specHash!;
    const spec = (await agent.getSpecSnapshot(hash)) as MachineSpec;
    expect(spec.title).toBe("Snapshotted");
    expect(Object.keys(spec.states ?? {})).toEqual(["start", "done"]);
  });

  it("hashes the machine, not its host metadata", async () => {
    const plain = await assemble(workspaceWith(linearSpec()), { turns: [{ reply: "ok" }] });
    await turn(plain.agent, "s1", "go");
    const decorated = await assemble(
      workspaceWith(linearSpec({ metadata: { nodes: { start: { x: 1, y: 2 } } } })),
      { turns: [{ reply: "ok" }] },
    );
    await turn(decorated.agent, "s1", "go");
    expect((await decorated.agent.sessions.get("s1"))?.specHash).toBe(
      (await plain.agent.sessions.get("s1"))?.specHash,
    );
  });
});

describe("run artifacts", () => {
  it("writes metadata, the trail, and the variables record for a governed run", async () => {
    const { agent, store } = await assemble(workspaceWith(linearSpec()), {
      turns: [
        { tool: "archmax_set_variables", args: { variables: { case_id: "K-1" } } },
        advanceTo("done", "all set"),
        { reply: "final answer" },
      ],
      params: { variables: { from_email: "a@b.c" } },
    });
    await turn(agent, "s1", "go");

    const dir = await agent.emitRunArtifacts("s1", {
      sessionId: "s1",
      workflow: "w",
      finalAnswer: "final answer",
      segments: [],
    });
    expect(dir).not.toBeNull();

    const metadata = JSON.parse((await storeFile(store, "/s1/artifacts/metadata.json"))!);
    expect(metadata.specHash).toBe((await agent.sessions.get("s1"))?.specHash);
    expect(typeof metadata.packageVersion).toBe("string");

    const trail = JSON.parse((await storeFile(store, "/s1/artifacts/trail.json"))!);
    expect(trail.workflow).toBe("w");
    expect(trail.steps.map((s: { to: string; kind: string }) => `${s.kind}:${s.to}`)).toEqual([
      "trigger:start",
      "agent:done",
    ]);
    expect(trail.steps[1].reason).toBe("all set");

    const variables = JSON.parse((await storeFile(store, "/s1/artifacts/variables.json"))!);
    expect(variables.variables.from_email).toEqual({ value: "a@b.c", locked: true });
    expect(variables.variables.case_id).toEqual({ value: "K-1", locked: false });
    expect(variables.variables.trigger).toEqual({ value: "manual", locked: true });

    const trajectory = await storeFile(store, "/s1/artifacts/trajectory.json");
    expect(trajectory).toContain("final answer");
  });

  it("records the session's usage in the metadata when something was spent", async () => {
    const { agent, store } = await assemble(workspaceWith(linearSpec()), {
      turns: [{ reply: "ok", usage: { input: 5, output: 7 } }],
    });
    await turn(agent, "s1", "go");
    await agent.emitRunArtifacts("s1", { sessionId: "s1", workflow: "w", finalAnswer: "ok", segments: [] });
    const metadata = JSON.parse((await storeFile(store, "/s1/artifacts/metadata.json"))!);
    expect(metadata.usage).toMatchObject({ inputTokens: 5, outputTokens: 7 });
  });
});
