/**
 * Movement through the machine: `archmax_advance`, refused edges, terminal
 * states, retained position across turns, and `archmax_reset`. Observed only
 * through the event stream, the returned transcript and session summaries.
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

/** start → middle → done, with `middle` also able to loop back to `start`. */
const CHAIN = {
  runtime: { engine: "archmax-harness", version: "2" },
  states: {
    start: { triggers: { manual: null }, transitions: [{ to: "middle", description: "Test edge to middle." }] },
    middle: { transitions: [{ to: "done", description: "Test edge to done." }, { to: "start", description: "Test edge to start." }] },
    done: {},
  },
};

describe("archmax_advance", () => {
  it("moves along a declared edge and records the reason on the advance event", async () => {
    const { agent, events } = await assemble(workspaceWith(linearSpec()), {
      turns: [advanceTo("done", "the work is finished"), { reply: "ok" }],
    });
    await turn(agent, "s1", "go");

    expect(advances(events)).toEqual([{ from: "start", to: "done", reason: "the work is finished" }]);
    // A terminal state's own leave names itself; the transition's leave names the target.
    const leave = eventsOf(events, "state-leave").filter((e) => e.state !== e.next);
    expect(leave).toMatchObject([{ state: "start", next: "done" }]);
  });

  it("correlates the advance event with the tool call that drove it", async () => {
    const { agent, events } = await assemble(workspaceWith(linearSpec()), {
      turns: [advanceTo("done"), { reply: "ok" }],
    });
    await turn(agent, "s1", "go");

    const [advance] = advances(events).length ? eventsOf(events, "advance").filter((e) => e.from === "start") : [];
    expect(advance?.callId).toBeDefined();
    const called = eventsOf(events, "tool-called").find((e) => e.tool === "archmax_advance");
    expect(called?.callId).toBe(advance?.callId);
    const settled = eventsOf(events, "tool-result").find((e) => e.tool === "archmax_advance");
    expect(settled?.callId).toBe(advance?.callId);
    expect(settled?.status).toBe("ok");
  });

  it("confirms the transition to the agent in the tool result", async () => {
    const { agent } = await assemble(workspaceWith(linearSpec()), {
      turns: [advanceTo("done"), { reply: "ok" }],
    });
    const { messages } = await turn(agent, "s1", "go");
    const result = toolResults(messages).find((r) => r.name === "archmax_advance");
    expect(result?.content).toMatch(/done/);
  });

  it("refuses a transition to a state the current one declares no edge to", async () => {
    const { agent, events } = await assemble(workspaceWith(CHAIN), {
      turns: [advanceTo("done", "skipping ahead"), { reply: "stuck" }],
    });
    const { messages } = await turn(agent, "s1", "go");

    expect(advances(events)).toEqual([]);
    expect(statesEntered(events)).toEqual(["start"]);
    const refusal = toolResults(messages).find((r) => r.name === "archmax_advance");
    expect(refusal?.content).toMatch(/done/);
    expect(refusal?.content).not.toMatch(/Advanced to/);
    const summary = await agent.sessions.get("s1");
    expect(summary?.workflowState).toBe("start");
  });

  it("refuses a transition to a state that does not exist", async () => {
    const { agent, events } = await assemble(workspaceWith(CHAIN), {
      turns: [advanceTo("nowhere"), { reply: "stuck" }],
    });
    await turn(agent, "s1", "go");
    expect(advances(events)).toEqual([]);
    expect(statesEntered(events)).toEqual(["start"]);
  });

  it("refuses an advance without a reason", async () => {
    const { agent, events } = await assemble(workspaceWith(linearSpec()), {
      turns: [{ tool: "archmax_advance", args: { to: "done" } }, { reply: "stuck" }],
    });
    const { messages } = await turn(agent, "s1", "go");
    expect(advances(events)).toEqual([]);
    const refusal = toolResults(messages).find((r) => r.name === "archmax_advance");
    expect(refusal?.content).toMatch(/reason/i);
  });

  it("withholds archmax_advance from the model in a terminal state", async () => {
    const { agent, model } = await assemble(workspaceWith(linearSpec()), {
      turns: [advanceTo("done"), { reply: "ok" }],
    });
    await turn(agent, "s1", "go");
    const [inStart, inDone] = model.calls;
    expect(inStart?.tools).toContain("archmax_advance");
    expect(inDone?.tools).not.toContain("archmax_advance");
  });
});

describe("terminal states", () => {
  it("ends the run when the agent finishes in a state with no transitions", async () => {
    const { agent, events } = await assemble(workspaceWith(linearSpec()), {
      turns: [advanceTo("done"), { reply: "finished" }],
    });
    const { reply } = await turn(agent, "s1", "go");

    expect(reply).toBe("finished");
    expect(statesEntered(events)).toEqual(["start", "done"]);
    const summary = await agent.sessions.get("s1");
    expect(summary).toMatchObject({
      status: "completed",
      classification: "finished",
      workflowState: "done",
    });
  });

  it("enters each state exactly once, in traversal order, along a chain", async () => {
    const { agent, events } = await assemble(workspaceWith(CHAIN), {
      turns: [advanceTo("middle"), advanceTo("done"), { reply: "ok" }],
    });
    await turn(agent, "s1", "go");

    expect(statesEntered(events)).toEqual(["start", "middle", "done"]);
    expect(
      eventsOf(events, "state-leave")
        .filter((e) => e.state !== e.next)
        .map((e) => `${e.state}>${e.next}`),
    ).toEqual(["start>middle", "middle>done"]);
    // The opening arrival is an `advance` from the graph's origin marker.
    const opening = eventsOf(events, "advance")[0];
    expect(opening).toMatchObject({ from: "__start__", to: "start" });
    expect(opening?.callId).toBeUndefined();
  });

  it("follows a declared back-edge", async () => {
    const { agent, events } = await assemble(workspaceWith(CHAIN), {
      turns: [advanceTo("middle"), advanceTo("start", "again"), advanceTo("middle"), advanceTo("done"), { reply: "ok" }],
    });
    await turn(agent, "s1", "go");
    expect(statesEntered(events)).toEqual(["start", "middle", "start", "middle", "done"]);
  });
});

describe("position across turns", () => {
  it("retains the state a turn ended in and continues there on the next turn", async () => {
    const { agent, events, model } = await assemble(workspaceWith(CHAIN), {
      turns: [advanceTo("middle"), { reply: "paused in the middle" }],
    });
    await turn(agent, "s1", "first");
    expect(statesEntered(events)).toEqual(["start", "middle"]);
    expect((await agent.sessions.get("s1"))?.workflowState).toBe("middle");

    events.length = 0;
    model.enqueue(advanceTo("done"), { reply: "now finished" });
    const { reply } = await turn(agent, "s1", "second");

    expect(reply).toBe("now finished");
    // The second turn opens in `middle`, not at the entry state.
    expect(statesEntered(events)).toEqual(["middle", "done"]);
    expect(eventsOf(events, "advance")[0]).toMatchObject({ from: "__start__", to: "middle" });
    expect(eventsOf(events, "workflow-reset")).toEqual([]);
  });

  it("keeps sessions independent: a second session starts at the entry state", async () => {
    const { agent, events, model } = await assemble(workspaceWith(CHAIN), {
      turns: [advanceTo("middle"), { reply: "a" }],
    });
    await turn(agent, "a", "first");
    events.length = 0;
    model.enqueue({ reply: "b" });
    await turn(agent, "b", "other");
    expect(statesEntered(events)).toEqual(["start"]);
    expect((await agent.sessions.get("b"))?.workflowState).toBe("start");
  });

  it("carries the transcript across turns of the same session", async () => {
    const { agent, model } = await assemble(workspaceWith(CHAIN), {
      turns: [{ reply: "first answer" }],
    });
    await turn(agent, "s1", "hello");
    model.enqueue({ reply: "second answer" });
    const { messages } = await turn(agent, "s1", "again");
    const humans = messages.filter((m) => (m as { getType?: () => string }).getType?.() === "human");
    expect(humans.length).toBe(2);
  });
});

describe("archmax_reset", () => {
  it("returns the run to the entry state it began in and continues from there", async () => {
    const { agent, events, model } = await assemble(workspaceWith(CHAIN), {
      turns: [advanceTo("middle"), { reply: "in the middle" }],
    });
    await turn(agent, "s1", "first");
    expect((await agent.sessions.get("s1"))?.workflowState).toBe("middle");

    events.length = 0;
    model.enqueue(
      { tool: "archmax_reset", args: { reason: "wrong branch" } },
      { reply: "back at the start" },
    );
    const { messages, reply } = await turn(agent, "s1", "start over");

    expect(reply).toBe("back at the start");
    const result = toolResults(messages).find((r) => r.name === "archmax_reset");
    expect(result?.content).toMatch(/Reset to state 'start'/);
    expect((await agent.sessions.get("s1"))?.workflowState).toBe("start");
    expect(statesEntered(events)[0]).toBe("middle");
  });

  it("is disclosed even in a terminal state", async () => {
    const { agent, model } = await assemble(workspaceWith(linearSpec()), {
      turns: [advanceTo("done"), { reply: "ok" }],
    });
    await turn(agent, "s1", "go");
    expect(model.calls.at(-1)?.tools).toContain("archmax_reset");
  });

  it("lets a follow-up turn in a finished session start the machine over", async () => {
    const { agent, events, model } = await assemble(workspaceWith(linearSpec()), {
      turns: [advanceTo("done"), { reply: "ok" }],
    });
    await turn(agent, "s1", "go");
    expect((await agent.sessions.get("s1"))?.status).toBe("completed");

    events.length = 0;
    model.enqueue(
      { tool: "archmax_reset", args: { reason: "a new request in a finished run" } },
      advanceTo("done"),
      { reply: "did it again" },
    );
    const { reply } = await turn(agent, "s1", "one more");
    expect(reply).toBe("did it again");
    expect(eventsOf(events, "advance").some((e) => e.from === "start" && e.to === "done")).toBe(true);
  });

  it("refuses a reset without a reason", async () => {
    const { agent } = await assemble(workspaceWith(CHAIN), {
      turns: [advanceTo("middle"), { tool: "archmax_reset", args: {} }, { reply: "hm" }],
    });
    const { messages } = await turn(agent, "s1", "go");
    const result = toolResults(messages).find((r) => r.name === "archmax_reset");
    expect(result?.content).toMatch(/rejected/);
    expect((await agent.sessions.get("s1"))?.workflowState).toBe("middle");
  });
});

describe("where a turn begins", () => {
  it("enters the start state the invocation's trigger declares", async () => {
    const spec = {
      runtime: { engine: "archmax-harness", version: "2" },
      states: {
        start: { triggers: { manual: null }, transitions: [{ to: "done", description: "Test edge to done." }] },
        handle: { triggers: { email_received: null }, transitions: [{ to: "done", description: "Test edge to done." }] },
        done: {},
      },
    };
    const { agent, events } = await assemble(workspaceWith(spec), { turns: [{ reply: "handled" }] });
    await turn(agent, "s1", "an email", { trigger: { id: "email_received" } });
    expect(statesEntered(events)).toEqual(["handle"]);
    expect(eventsOf(events, "advance")[0]).toMatchObject({ from: "__start__", to: "handle" });
    expect((await agent.sessions.get("s1"))?.variables?.trigger).toEqual({ value: "email_received", locked: true });
  });

  it("reopens at the trigger's entry when the retained state was dropped from the definition", async () => {
    const root = workspaceWith(CHAIN);
    const first = await assemble(root, { turns: [advanceTo("middle"), { reply: "paused" }] });
    await turn(first.agent, "s1", "go");
    expect((await first.agent.sessions.get("s1"))?.workflowState).toBe("middle");

    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { stringify } = await import("yaml");
    writeFileSync(
      join(root, "workflows/w/workflow.yaml"),
      stringify({ ...CHAIN, states: { start: { triggers: { manual: null }, transitions: [{ to: "done", description: "Test edge to done." }] }, done: {} } }),
    );
    const second = await assemble(root, { turns: [{ reply: "started over" }], store: first.store });
    await turn(second.agent, "s1", "again");
    expect(eventsOf(second.events, "workflow-reset")).toMatchObject([{ entry: "start" }]);
    expect(statesEntered(second.events)).toEqual(["start"]);
    // The definition the turn ran under is snapshotted afresh.
    expect((await second.agent.sessions.get("s1"))?.specHash).not.toBe(
      (await first.agent.sessions.get("s1"))?.specHash,
    );
  });

  it("refuses a turn on a disabled workflow without calling the model", async () => {
    const { agent, events, model } = await assemble(workspaceWith({ ...linearSpec(), disabled: true }), {
      turns: [{ reply: "never" }],
    });
    await turn(agent, "s1", "go");
    expect(model.calls).toHaveLength(0);
    expect(statesEntered(events)).toEqual([]);
    expect(eventsOf(events, "warning").some((w) => /disabled/.test(w.message))).toBe(true);
    expect((await agent.sessions.get("s1"))).toMatchObject({ status: "rejected", classification: "finished" });
  });
});
