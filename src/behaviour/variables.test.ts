/**
 * Run variables: the agent's `archmax_set_variables`/`archmax_get_variables`,
 * host seeds (locked), `requires` on a state and on a trigger, and the reserved
 * `title` with its own `title-set` event.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  advanceTo,
  advances,
  assemble,
  cleanupWorkspaces,
  eventsOf,
  linearSpec,
  statesEntered,
  toolResults,
  turn,
  workspaceWith,
} from "./support.js";

afterEach(cleanupWorkspaces);

const setVars = (variables: Record<string, unknown>, lock?: boolean) => ({
  tool: "archmax_set_variables",
  args: { variables, ...(lock !== undefined ? { lock } : {}) },
});

describe("archmax_set_variables and archmax_get_variables", () => {
  it("records a value the agent sets, unlocked, and announces the names only", async () => {
    const { agent, events } = await assemble(workspaceWith(linearSpec()), {
      turns: [setVars({ case_id: "K-9", notes: { priority: "high" } }), advanceTo("done"), { reply: "ok" }],
    });
    await turn(agent, "s1", "go");

    const set = eventsOf(events, "variables-set");
    expect(set).toMatchObject([{ state: "start", names: ["case_id", "notes"], locked: false }]);
    expect(set[0]?.callId).toBeDefined();
    expect(JSON.stringify(set[0])).not.toContain("K-9");

    const summary = await agent.sessions.get("s1");
    expect(summary?.variables?.case_id).toEqual({ value: "K-9", locked: false });
    expect(summary?.variables?.notes).toEqual({ value: { priority: "high" }, locked: false });
  });

  it("reads a value back, whole or by dotted path", async () => {
    const { agent } = await assemble(workspaceWith(linearSpec()), {
      turns: [
        setVars({ order: { items: [{ sku: "A-1" }, { sku: "B-2" }] } }),
        { tool: "archmax_get_variables", args: { name: "order" } },
        { tool: "archmax_get_variables", args: { name: "order", path: "items.-1.sku" } },
        { tool: "archmax_get_variables", args: {} },
        advanceTo("done"),
        { reply: "ok" },
      ],
    });
    const { messages } = await turn(agent, "s1", "go");
    const reads = toolResults(messages).filter((r) => r.name === "archmax_get_variables");
    expect(reads).toHaveLength(3);
    expect(reads[0]?.content).toContain("A-1");
    expect(reads[1]?.content).toContain("B-2");
    expect(reads[1]?.content).not.toContain("A-1");
    // Reading everything also shows the built-in trigger.
    expect(reads[2]?.content).toContain("trigger");
  });

  it("lets a later state rewrite an unlocked value, and carries it across states", async () => {
    const { agent } = await assemble(workspaceWith(linearSpec()), {
      turns: [setVars({ status: "draft" }), advanceTo("done"), setVars({ status: "final" }), { reply: "ok" }],
    });
    await turn(agent, "s1", "go");
    expect((await agent.sessions.get("s1"))?.variables?.status).toEqual({ value: "final", locked: false });
  });

  it("locks a value on request, after which the agent cannot rewrite it", async () => {
    const { agent, events } = await assemble(workspaceWith(linearSpec()), {
      turns: [setVars({ decision: "approved" }, true), setVars({ decision: "denied" }), advanceTo("done"), { reply: "ok" }],
    });
    const { messages } = await turn(agent, "s1", "go");
    expect(eventsOf(events, "variables-set")).toMatchObject([{ names: ["decision"], locked: true }]);
    const writes = toolResults(messages).filter((r) => r.name === "archmax_set_variables");
    expect(writes[1]?.status).toBe("error");
    expect((await agent.sessions.get("s1"))?.variables?.decision).toEqual({ value: "approved", locked: true });
  });

  it("carries agent-set variables across a turn boundary", async () => {
    const { agent, model } = await assemble(workspaceWith(linearSpec()), {
      turns: [setVars({ memo: "remember me" }), { reply: "noted" }],
    });
    await turn(agent, "s1", "first");
    model.enqueue({ tool: "archmax_get_variables", args: { name: "memo" } }, { reply: "recalled" });
    const { messages } = await turn(agent, "s1", "second");
    const read = toolResults(messages).find((r) => r.name === "archmax_get_variables");
    expect(read?.content).toContain("remember me");
  });

  it("refuses an invalid variable name", async () => {
    const { agent, events } = await assemble(workspaceWith(linearSpec()), {
      turns: [setVars({ "Bad-Name": 1 }), advanceTo("done"), { reply: "ok" }],
    });
    const { messages } = await turn(agent, "s1", "go");
    const write = toolResults(messages).find((r) => r.name === "archmax_set_variables");
    expect(write?.status).toBe("error");
    expect(eventsOf(events, "variables-set")).toEqual([]);
  });
});

describe("host-seeded variables", () => {
  it("seeds every value locked, alongside the built-in trigger", async () => {
    const { agent, events } = await assemble(workspaceWith(linearSpec()), {
      turns: [advanceTo("done"), { reply: "ok" }],
      params: { variables: { from_email: "a@b.c", account: { region: "eu" } } },
    });
    await turn(agent, "s1", "go");
    const summary = await agent.sessions.get("s1");
    expect(summary?.variables?.from_email).toEqual({ value: "a@b.c", locked: true });
    expect(summary?.variables?.account).toEqual({ value: { region: "eu" }, locked: true });
    expect(summary?.variables?.trigger).toEqual({ value: "manual", locked: true });
    // Seeding is the host's act, not the agent's: no state-attributed write is announced.
    expect(eventsOf(events, "variables-set").filter((e) => e.state !== undefined)).toEqual([]);
  });

  it("refuses the agent's attempt to overwrite a seeded value, which stands", async () => {
    const { agent, events } = await assemble(workspaceWith(linearSpec()), {
      turns: [setVars({ from_email: "attacker@x" }), advanceTo("done"), { reply: "ok" }],
      params: { variables: { from_email: "a@b.c" } },
    });
    const { messages } = await turn(agent, "s1", "go");
    const write = toolResults(messages).find((r) => r.name === "archmax_set_variables");
    expect(write?.status).toBe("error");
    expect(write?.content).toMatch(/from_email/);
    expect(eventsOf(events, "variables-set").filter((e) => e.state !== undefined)).toEqual([]);
    expect((await agent.sessions.get("s1"))?.variables?.from_email).toEqual({ value: "a@b.c", locked: true });
  });

  it("rejects an illegal seed name at assembly", async () => {
    await expect(
      assemble(workspaceWith(linearSpec()), { turns: [], params: { variables: { "From-Email": "x" } } }),
    ).rejects.toThrow(/From-Email/);
  });

  it("exposes the seeded value to the agent through archmax_get_variables", async () => {
    const { agent } = await assemble(workspaceWith(linearSpec()), {
      turns: [{ tool: "archmax_get_variables", args: { name: "from_email" } }, advanceTo("done"), { reply: "ok" }],
      params: { variables: { from_email: "a@b.c" } },
    });
    const { messages } = await turn(agent, "s1", "go");
    expect(toolResults(messages).find((r) => r.name === "archmax_get_variables")?.content).toContain("a@b.c");
  });
});

describe("requires on a state", () => {
  // `requires` names what a state must establish: the advance out of it is
  // refused until every named variable holds a value.
  const spec = linearSpec({
    states: {
      start: { triggers: { manual: null }, requires: ["case_id"], transitions: [{ to: "done", description: "Test edge to done." }] },
      done: {},
    },
  });

  it("refuses the advance out of the state until the required variable is set, then admits it", async () => {
    const { agent, events } = await assemble(workspaceWith(spec), {
      turns: [advanceTo("done", "too soon"), setVars({ case_id: "K-1" }), advanceTo("done", "now"), { reply: "ok" }],
    });
    const { messages } = await turn(agent, "s1", "go");

    const results = toolResults(messages).filter((r) => r.name === "archmax_advance");
    expect(results[0]?.content).toMatch(/case_id/);
    expect(results[0]?.content).not.toMatch(/Advanced to/);
    expect(results[1]?.content).toMatch(/Advanced to state 'done'/);
    expect(advances(events)).toEqual([{ from: "start", to: "done", reason: "now" }]);
    expect(statesEntered(events)).toEqual(["start", "done"]);
  });

  it("is satisfied by a host seed with no agent action", async () => {
    const { agent, events } = await assemble(workspaceWith(spec), {
      turns: [advanceTo("done"), { reply: "ok" }],
      params: { variables: { case_id: "K-2" } },
    });
    await turn(agent, "s1", "go");
    expect(statesEntered(events)).toEqual(["start", "done"]);
  });
});

describe("requires on a trigger", () => {
  // The signature is declared on the state the trigger enters.
  const spec = {
    runtime: { engine: "archmax-harness", version: "2" },
    states: {
      start: { triggers: { manual: { requires: ["order_id"] } }, transitions: [{ to: "done", description: "Test edge to done." }] },
      done: {},
    },
  };

  it("refuses to start the turn when the firing does not supply the input", async () => {
    const { agent, events, model } = await assemble(workspaceWith(spec), { turns: [{ reply: "never" }] });
    await turn(agent, "s1", "go");

    expect(model.calls).toHaveLength(0);
    expect(statesEntered(events)).toEqual([]);
    expect(eventsOf(events, "warning").some((w) => /requires 'order_id'/.test(w.message))).toBe(true);
    expect((await agent.sessions.get("s1"))?.status).toBe("rejected");
  });

  it("starts once the input is seeded", async () => {
    const { agent, events } = await assemble(workspaceWith(spec), {
      turns: [advanceTo("done"), { reply: "ok" }],
      params: { variables: { order_id: "ORD-1" } },
    });
    await turn(agent, "s1", "go");
    expect(statesEntered(events)).toEqual(["start", "done"]);
    expect((await agent.sessions.get("s1"))?.status).toBe("completed");
  });
});

describe("a typed trigger signature", () => {
  const typedSpec = (manual: Record<string, unknown>) => ({
    runtime: { engine: "archmax-harness", version: "2" },
    states: {
      start: { triggers: { manual }, transitions: [{ to: "done", description: "Test edge to done." }] },
      done: {},
    },
  });

  it("names why on the outcome of a refused start", async () => {
    const { agent, model } = await assemble(
      workspaceWith(typedSpec({ requires: [{ name: "quantity", type: "integer" }] })),
      { turns: [{ reply: "never" }], params: { variables: { quantity: "4" } } },
    );
    const outcome = await agent.workflow!.send("s1", { message: "go" });
    expect(model.calls).toHaveLength(0);
    expect(outcome).toMatchObject({ kind: "rejected", status: "rejected" });
    expect(outcome.rejected).toContain("'quantity' must be an integer");
  });

  it("refuses a start whose seed does not conform, before any model call", async () => {
    const { agent, events, model } = await assemble(
      workspaceWith(typedSpec({ requires: [{ name: "quantity", type: "integer" }] })),
      { turns: [{ reply: "never" }], params: { variables: { quantity: "4" } } },
    );
    await turn(agent, "s1", "go");

    expect(model.calls).toHaveLength(0);
    expect(statesEntered(events)).toEqual([]);
    const warning = eventsOf(events, "warning").find((w) => w.message.startsWith("Refusing to start"))?.message;
    expect(warning).toContain("trigger 'manual'");
    expect(warning).toContain("'quantity' must be an integer");
    expect(warning).toContain('a string ("4") arrived');
    expect((await agent.sessions.get("s1"))?.status).toBe("rejected");
  });

  it("refuses null for a typed input and takes it for an untyped one", async () => {
    const refused = await assemble(workspaceWith(typedSpec({ requires: [{ name: "approved", type: "boolean" }] })), {
      turns: [{ reply: "never" }],
      params: { variables: { approved: null } },
    });
    await turn(refused.agent, "s1", "go");
    expect(refused.model.calls).toHaveLength(0);
    expect(eventsOf(refused.events, "warning").some((w) => /'approved' must be a boolean/.test(w.message))).toBe(true);

    const started = await assemble(workspaceWith(typedSpec({ requires: ["note"] })), {
      turns: [advanceTo("done"), { reply: "ok" }],
      params: { variables: { note: null } },
    });
    await turn(started.agent, "s1", "go");
    expect((await started.agent.sessions.get("s1"))?.status).toBe("completed");
  });

  it("starts on a conforming seed", async () => {
    const { agent, events } = await assemble(
      workspaceWith(typedSpec({ requires: [{ name: "due", type: "date" }] })),
      { turns: [advanceTo("done"), { reply: "ok" }], params: { variables: { due: "2026-03-01" } } },
    );
    await turn(agent, "s1", "go");
    expect(statesEntered(events)).toEqual(["start", "done"]);
  });

  it("refuses the agent's mistyped write of a typed return, then takes a conforming one", async () => {
    const { agent, events } = await assemble(
      workspaceWith(typedSpec({ returns: [{ name: "total", type: "number" }] })),
      { turns: [setVars({ total: "12.50" }), setVars({ total: 12.5 }), advanceTo("done"), { reply: "ok" }] },
    );
    const { messages } = await turn(agent, "s1", "go");
    const [refusal, accepted] = toolResults(messages).filter((r) => r.name === "archmax_set_variables");
    expect(refusal?.status).toBe("error");
    expect(refusal?.content).toContain("'total' must be a number");
    expect(accepted?.status).not.toBe("error");
    expect(eventsOf(events, "variables-set")).toMatchObject([{ names: ["total"] }]);
    expect((await agent.sessions.get("s1"))?.status).toBe("completed");
  });

  // The write check guards the agent's own writes; a seed reaches the store
  // without one, so the completion check is what holds it to the type.
  it("rejects a completion whose typed return does not conform", async () => {
    const { agent } = await assemble(
      workspaceWith(typedSpec({ returns: [{ name: "total", type: "number" }] })),
      { turns: [advanceTo("done"), { reply: "ok" }], params: { variables: { total: "12.50" } } },
    );
    const outcome = await agent.workflow!.send("s1", { message: "go" });
    expect(outcome.kind).toBe("rejected");
    expect(outcome.rejected).toContain("state 'done'");
    expect(outcome.rejected).toContain("'total' must be a number");
    expect((await agent.sessions.get("s1"))?.status).toBe("rejected");
  });

  it("discloses each typed return identically on every model call of the turn", async () => {
    const { agent, model } = await assemble(
      workspaceWith(
        typedSpec({ returns: [{ name: "total", type: "number", description: "Refunded amount in EUR." }, "note"] }),
      ),
      {
        turns: [{ tool: "archmax_get_variables", args: {} }, advanceTo("done"), { reply: "ok" }],
        params: { variables: { total: 12.5, note: "ok" } },
      },
    );
    await turn(agent, "s1", "go");
    const [first, second] = model.calls.map((call) => call.systemPrompt);
    expect(first).toContain("- total (number) — Refunded amount in EUR.\n- note");
    expect(second).toBe(first);
  });

  it("never shows the model the trigger's description", async () => {
    const { agent, model } = await assemble(
      workspaceWith(typedSpec({ description: "Refund one order and report the amount." })),
      { turns: [advanceTo("done"), { reply: "ok" }] },
    );
    await turn(agent, "s1", "go");
    expect(model.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(model.calls)).not.toContain("Refund one order");
  });
});

describe("the reserved title", () => {
  it("emits title-set with the value when the agent sets it, and stores it unlocked", async () => {
    const { agent, events } = await assemble(workspaceWith(linearSpec()), {
      turns: [setVars({ title: "  Inbound refund  " }), advanceTo("done"), { reply: "ok" }],
    });
    await turn(agent, "s1", "go");

    const titles = eventsOf(events, "title-set");
    expect(titles).toMatchObject([{ title: "Inbound refund", state: "start" }]);
    expect(titles[0]?.callId).toBeDefined();
    expect((await agent.sessions.get("s1"))?.variables?.title).toEqual({ value: "Inbound refund", locked: false });
  });

  it("emits title-set for a host seed, and the seed does not lock the title", async () => {
    const { agent, events } = await assemble(workspaceWith(linearSpec()), {
      turns: [advanceTo("done"), { reply: "ok" }],
      params: { variables: { title: "Seeded title" } },
    });
    await turn(agent, "s1", "go");
    const seeded = eventsOf(events, "title-set")[0];
    expect(seeded).toMatchObject({ title: "Seeded title" });
    expect(seeded?.state).toBeUndefined();
    expect((await agent.sessions.get("s1"))?.variables?.title?.locked).toBe(false);
  });

  it("refuses a multi-line title and emits nothing", async () => {
    const { agent, events } = await assemble(workspaceWith(linearSpec()), {
      turns: [setVars({ title: "line one\nline two" }), advanceTo("done"), { reply: "ok" }],
    });
    const { messages } = await turn(agent, "s1", "go");
    expect(toolResults(messages).find((r) => r.name === "archmax_set_variables")?.status).toBe("error");
    expect(eventsOf(events, "title-set")).toEqual([]);
  });

  it("lets the agent retitle the run later, announcing the new value", async () => {
    const { agent, events } = await assemble(workspaceWith(linearSpec()), {
      turns: [setVars({ title: "First" }), advanceTo("done"), setVars({ title: "Second" }), { reply: "ok" }],
    });
    await turn(agent, "s1", "go");
    expect(eventsOf(events, "title-set").map((e) => e.title)).toEqual(["First", "Second"]);
  });
});
