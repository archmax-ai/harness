/**
 * A hook sees its visit: everything since the session entered the state it is in
 * when the hook runs. `messages` is that visit's transcript, however many control
 * calls it holds, and `toolCalls` queries the tool results of the whole session.
 */
import { tool } from "langchain";
import type { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { workflowToolName, type Agent } from "../index.js";
import {
  advanceTo,
  AGENTS_MD,
  assemble,
  cleanupWorkspaces,
  eventsOf,
  JudgeModel,
  makeWorkspace,
  rubricDeclaration,
  toolResults,
  workspaceWith,
  type ScriptedTurn,
} from "./support.js";

afterEach(cleanupWorkspaces);

const RUNTIME = { engine: "archmax-harness", version: "2" };

const lookup = tool(async ({ id }: { id: string }) => JSON.stringify({ id, status: "pending" }), {
  name: "lookup",
  description: "Look an order up.",
  schema: z.object({ id: z.string() }),
}) as unknown as StructuredTool;

const call = (id = "42"): ScriptedTurn => ({ tool: "lookup", args: { id } });
const getVariables: ScriptedTurn = { tool: "archmax_get_variables", args: {} };

/** A hook that vetoes unless `messages` holds a `lookup` result. */
const needsLookupMessage = `/** Needs the lookup in its visit. */
export default ({ messages }) =>
  messages.some((m) => m.role === "tool" && m.tool === "lookup") ? ok() : veto("no lookup in sight");
`;

/** `work` (allowing `lookup`, gated by \`hook\` on leaving) → `done`. */
function gated(hook: string, extra: Record<string, unknown> = {}) {
  return workspaceWith(
    {
      runtime: RUNTIME,
      states: {
        work: {
          triggers: { manual: null },
          tools: { allow: ["lookup"] },
          after: { script: "hooks/check.js" },
          transitions: [{ to: "done", description: "The order is handled." }],
        },
        done: {},
        ...extra,
      },
    },
    { "workflows/w/hooks/check.js": hook },
  );
}

describe("a hook sees its visit", () => {
  it("still finds a tool result after a dozen control calls", async () => {
    const { agent, events } = await assemble(gated(needsLookupMessage), {
      turns: [call(), ...Array.from({ length: 12 }, () => getVariables), advanceTo("done"), { reply: "done" }],
      params: { tools: [lookup] },
    });
    const outcome = await agent.workflow.send("s1", { message: "cancel order 42" });

    expect(eventsOf(events, "hook-rejected")).toEqual([]);
    expect(outcome).toMatchObject({ kind: "completed", state: "done" });
  });
});

/** The states the session's visits began in, in order. */
async function visitsOf(agent: Agent, sessionId = "s1"): Promise<string[]> {
  const { values } = (await agent.getState({ configurable: { thread_id: sessionId } })) as {
    values: { visits?: Array<{ state: string }> };
  };
  return (values.visits ?? []).map((v) => v.state);
}

const edge = (to: string) => ({ to, description: `Test edge to ${to}.` });

describe("the visit log", () => {
  it("starts a visit when a turn opens a state and on every advance, a cycle included", async () => {
    const spec = {
      runtime: RUNTIME,
      states: { a: { triggers: { manual: null }, transitions: [edge("b")] }, b: { transitions: [edge("a"), edge("c")] }, c: {} },
    };
    const { agent } = await assemble(workspaceWith(spec), {
      turns: [advanceTo("b"), advanceTo("a"), advanceTo("b"), advanceTo("c"), { reply: "done" }],
    });
    await agent.workflow.send("s1", { message: "go" });
    expect(await visitsOf(agent)).toEqual(["a", "b", "a", "b", "c"]);
  });

  it("continues the visit when the next turn continues in the same state", async () => {
    const spec = { runtime: RUNTIME, states: { a: { triggers: { manual: null }, transitions: [edge("b")] }, b: {} } };
    const { agent } = await assemble(workspaceWith(spec), { turns: [{ reply: "which order?" }, advanceTo("b"), { reply: "done" }] });
    await agent.workflow.send("s1", { message: "help" });
    await agent.workflow.send("s1", { message: "order 42" });
    expect(await visitsOf(agent)).toEqual(["a", "b"]);
  });

  it("starts a visit on a reset, even into the state the session is in", async () => {
    const spec = { runtime: RUNTIME, states: { a: { triggers: { manual: null }, transitions: [edge("b")] }, b: {} } };
    const { agent } = await assemble(workspaceWith(spec), {
      turns: [{ tool: "archmax_reset", args: { reason: "start over" } }, { reply: "done" }],
    });
    await agent.workflow.send("s1", { message: "go" });
    expect(await visitsOf(agent)).toEqual(["a", "a"]);
  });

  it("starts a visit on an on_error route", async () => {
    const spec = {
      runtime: RUNTIME,
      states: { a: { triggers: { manual: null }, budget: { maxTurns: 1 }, on_error: "handle", transitions: [edge("b")] }, b: {}, handle: {} },
    };
    const { agent } = await assemble(workspaceWith(spec), { turns: [getVariables, getVariables, { reply: "handled" }] });
    await agent.workflow.send("s1", { message: "go" });
    expect(await visitsOf(agent)).toEqual(["a", "handle"]);
  });

  it("starts a visit on a person's decision, and none on the park itself", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        work: { triggers: { manual: null }, transitions: [edge("review")] },
        review: { type: "human", transitions: [{ to: "done", type: "approve", description: "Approve it." }] },
        done: {},
      },
    };
    const { agent } = await assemble(workspaceWith(spec), {
      turns: [advanceTo("review"), { reply: "over to you" }, { reply: "closed" }],
    });
    await agent.workflow.send("s1", { message: "go" });
    await agent.workflow.send("s1", { decision: { target: "done" } });
    expect(await visitsOf(agent)).toEqual(["work", "review", "done"]);
  });

  it("continues the visit when a delivery resumes a wait", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        clarify: { triggers: { manual: { session: "conversation_id" }, email_reply: { session: "conversation_id" } } },
      },
    };
    const { agent } = await assemble(workspaceWith(spec), {
      turns: [{ tool: "archmax_wait", args: { reason: "need the id" } }, { reply: "waiting" }, { reply: "found it" }],
    });
    await agent.workflow.send("conv-1", { message: "help" });
    await agent.workflow.send("conv-1", { delivery: { trigger: { id: "email_reply" } } });
    expect(await visitsOf(agent, "conv-1")).toEqual(["clarify"]);
  });

  it("continues the caller's visit when a sub-workflow returns", async () => {
    const child = workflowToolName("enrich");
    const root = makeWorkspace({
      "AGENTS.md": AGENTS_MD,
      "workflows/w/workflow.yaml": { runtime: RUNTIME, states: { start: { triggers: { manual: null }, tools: { allow: [child] } } } },
      "workflows/enrich/workflow.yaml": { runtime: RUNTIME, states: { work: { triggers: { manual: null } } } },
    });
    const { agent } = await assemble(root, { turns: [{ tool: child, args: {} }, { reply: "enriched" }, { reply: "parent done" }] });
    await agent.workflow.send("s1", { message: "go" });
    expect(await visitsOf(agent)).toEqual(["start"]);
    expect(await visitsOf(agent, "s1~1")).toEqual(["work"]);
  });
});

/** A hook that logs what it saw of `messages`: a tool result by its tool, a person's message by its text. */
const probe = `/** Reports its visit. */
export default ({ state, phase, messages }) => {
  console.log(JSON.stringify({ state, phase, seen: messages.map((m) =>
    m.role === "tool" ? "tool:" + m.tool : m.role === "user" ? "user:" + m.text : m.role) }));
};
`;

/** What each probe saw, in the order the hooks ran. */
function probed(events: Parameters<typeof eventsOf>[0]): Array<{ state: string; phase: string; seen: string[] }> {
  return eventsOf(events, "hook-output").map((e) => JSON.parse(e.line));
}

describe("what a hook's messages hold", () => {
  it("spans turns: the person's answer in the next turn and the lookup before it", async () => {
    const root = gated(probe);
    const { agent, events } = await assemble(root, {
      turns: [call(), { reply: "Cancel order 42?" }, advanceTo("done"), { reply: "cancelled" }],
      params: { tools: [lookup] },
    });
    await agent.workflow.send("s1", { message: "cancel order 42" });
    await agent.workflow.send("s1", { message: "yes, go ahead" });
    const [after] = probed(events);
    expect(after).toMatchObject({ state: "work", phase: "after" });
    expect(after!.seen).toEqual(
      expect.arrayContaining(["user:cancel order 42", "tool:lookup", "user:yes, go ahead"]),
    );
  });

  it("holds only the current visit of a state entered again", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        a: { triggers: { manual: null }, tools: { allow: ["lookup"] }, after: { script: "hooks/probe.js" }, transitions: [edge("b"), edge("c")] },
        b: { transitions: [edge("a")] },
        c: {},
      },
    };
    const { agent, events } = await assemble(workspaceWith(spec, { "workflows/w/hooks/probe.js": probe }), {
      turns: [call("1"), advanceTo("b"), advanceTo("a"), call("2"), advanceTo("c"), { reply: "done" }],
      params: { tools: [lookup] },
    });
    await agent.workflow.send("s1", { message: "go" });
    const [first, second] = probed(events);
    expect(first!.seen).toContain("user:go");
    expect(second!.seen.filter((s) => s === "tool:lookup")).toHaveLength(1);
    expect(second!.seen).not.toContain("user:go");
  });

  it("is the same visit for the leaving state's after hook and the target's before hook", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        s: { triggers: { manual: null }, tools: { allow: ["lookup"] }, after: { script: "hooks/probe.js" }, transitions: [edge("t")] },
        t: { before: { script: "hooks/probe.js" } },
      },
    };
    const { agent, events } = await assemble(workspaceWith(spec, { "workflows/w/hooks/probe.js": probe }), {
      turns: [call(), advanceTo("t"), { reply: "done" }],
      params: { tools: [lookup] },
    });
    await agent.workflow.send("s1", { message: "go" });
    const [after, before] = probed(events);
    expect(after).toMatchObject({ state: "s", phase: "after" });
    expect(before).toMatchObject({ state: "t", phase: "before" });
    expect(before!.seen).toEqual(after!.seen);
  });

  it("opens with the person's message in a before hook at the start of a turn", async () => {
    const spec = { runtime: RUNTIME, states: { start: { triggers: { manual: null }, before: { script: "hooks/probe.js" } } } };
    const { agent, events } = await assemble(workspaceWith(spec, { "workflows/w/hooks/probe.js": probe }), {
      turns: [{ reply: "hello" }],
    });
    await agent.workflow.send("s1", { message: "requester@acme.com asks" });
    expect(probed(events)[0]!.seen).toEqual(["user:requester@acme.com asks"]);
  });
});

describe("what a rubric is shown", () => {
  it("is the visit it gates, tool results in full, and the session's opening request", async () => {
    const marked = tool(async () => JSON.stringify({ id: "42", status: "MARKER-STATUS" }), {
      name: "lookup",
      description: "Look an order up.",
      schema: z.object({ id: z.string() }),
    }) as unknown as StructuredTool;
    const spec = {
      runtime: RUNTIME,
      states: {
        identify: { triggers: { manual: null }, transitions: [edge("orders")] },
        orders: {
          tools: { allow: ["lookup"] },
          after: { rubric: rubricDeclaration() },
          transitions: [edge("done")],
        },
        done: {},
      },
    };
    const judge = new JudgeModel([{ verdict: "ok", reason: "fine" }]);
    const { agent } = await assemble(workspaceWith(spec), {
      turns: [
        { ...advanceTo("orders"), text: "ROUTING-NARRATION" },
        call(),
        advanceTo("done"),
        { reply: "done" },
      ],
      rubricModel: judge,
      params: { tools: [marked] },
    });
    await agent.workflow.send("s1", { message: "ORIGINAL-REQUEST about order 42" });

    expect(judge.prompts).toHaveLength(1);
    const [prompt] = judge.prompts;
    expect(prompt).toContain("MARKER-STATUS");
    expect(prompt).toContain("ORIGINAL-REQUEST");
    expect(prompt).not.toContain("ROUTING-NARRATION");
  });
});

/** A hook that logs what `toolCalls(filter)` resolved to, then lets the advance through. */
const queries = (filter: string) => `/** Reports its query. */
export default async ({ toolCalls }) => {
  console.log(JSON.stringify(await toolCalls(${filter})));
};
`;

const logged = (events: Parameters<typeof eventsOf>[0]) => eventsOf(events, "hook-output").map((e) => JSON.parse(e.line));

describe("toolCalls", () => {
  it("returns a call made in the visit with its arguments and result", async () => {
    const { agent, events } = await assemble(gated(queries(`{ name: "lookup" }`)), {
      turns: [call(), getVariables, advanceTo("done"), { reply: "done" }],
      params: { tools: [lookup] },
    });
    await agent.workflow.send("s1", { message: "go" });
    expect(logged(events)).toEqual([
      [{ id: expect.any(String), name: "lookup", args: { id: "42" }, result: { id: "42", status: "pending" }, status: "completed", state: "work", visit: 1 }],
    ]);
  });

  it("finds a call from an earlier turn of the same visit", async () => {
    const { agent, events } = await assemble(gated(queries(`{ visit: "current" }`)), {
      turns: [call(), { reply: "Cancel order 42?" }, advanceTo("done"), { reply: "cancelled" }],
      params: { tools: [lookup] },
    });
    await agent.workflow.send("s1", { message: "cancel order 42" });
    await agent.workflow.send("s1", { message: "yes" });
    expect(logged(events)[0]).toMatchObject([{ name: "lookup", visit: 1 }]);
  });

  it("returns calls from every visit, each marked with its own", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        a: { triggers: { manual: null }, tools: { allow: ["lookup"] }, after: { script: "hooks/q.js" }, transitions: [edge("b"), edge("c")] },
        b: { transitions: [edge("a")] },
        c: {},
      },
    };
    const { agent, events } = await assemble(workspaceWith(spec, { "workflows/w/hooks/q.js": queries(`{ name: "lookup" }`) }), {
      turns: [call("1"), advanceTo("b"), advanceTo("a"), call("2"), advanceTo("c"), { reply: "done" }],
      params: { tools: [lookup] },
    });
    await agent.workflow.send("s1", { message: "go" });
    const last = logged(events).at(-1) as Array<{ state: string; visit: number }>;
    expect(last.map((r) => [r.state, r.visit])).toEqual([
      ["a", 1],
      ["a", 3],
    ]);
  });

  it("holds no control call", async () => {
    const { agent, events } = await assemble(gated(queries("")), {
      turns: [{ tool: "archmax_set_variables", args: { variables: { x: 1 } } }, call(), advanceTo("done"), { reply: "done" }],
      params: { tools: [lookup] },
    });
    await agent.workflow.send("s1", { message: "go" });
    expect(logged(events)[0].map((r: { name: string }) => r.name)).toEqual(["lookup"]);
  });

  it("is hidden from the hook's tools and absent from the agent's own sandbox", async () => {
    const hook = `/** Lists its tools. */
export default ({ tools }) => { console.log(JSON.stringify(Object.keys(tools).filter((k) => /call/i.test(k)))); };
`;
    const probeEval = {
      tool: "archmax_eval",
      args: { code: `[typeof toolCalls, typeof globalThis.__archmaxToolCalls, typeof tools.archmaxToolCalls].join(",")` },
    };
    const { agent, events } = await assemble(gated(hook), {
      turns: [probeEval, advanceTo("done"), { reply: "done" }],
      params: { tools: [lookup] },
    });
    const outcome = await agent.workflow.send("s1", { message: "go" });
    expect(logged(events)).toEqual([[]]);
    expect(toolResults(outcome.messages).find((r) => r.name === "archmax_eval")?.content).toContain(
      "undefined,undefined,undefined",
    );
  });

  it("copies into the hook only what it asked for, and that in full", async () => {
    const search = tool(async ({ q }: { q: string }) => `SEARCH-RESULT-${q}`, {
      name: "search",
      description: "Search.",
      schema: z.object({ q: z.string() }),
    }) as unknown as StructuredTool;
    const big = "x".repeat(20_000);
    const large = tool(async () => JSON.stringify({ id: "42", notes: big }), {
      name: "lookup",
      description: "Look an order up.",
      schema: z.object({ id: z.string() }),
    }) as unknown as StructuredTool;
    const hook = `/** Checks its input and its query. */
export default async ({ toolCalls }) => {
  const [order] = await toolCalls({ name: "lookup" });
  console.log(JSON.stringify({ inInput: JSON.stringify(args).includes("SEARCH-RESULT"), notes: order.result.notes.length }));
};
`;
    const spec = {
      runtime: RUNTIME,
      states: {
        work: {
          triggers: { manual: null },
          tools: { allow: ["lookup", "search"] },
          after: { script: "hooks/check.js" },
          transitions: [edge("done")],
        },
        done: {},
      },
    };
    const searches = { batch: Array.from({ length: 100 }, (_, i) => ({ tool: "search", args: { q: String(i) } })) };
    const { agent, events } = await assemble(workspaceWith(spec, { "workflows/w/hooks/check.js": hook }), {
      turns: [searches, call(), advanceTo("done"), { reply: "done" }],
      params: { tools: [search, large] },
    });
    await agent.workflow.send("s1", { message: "go" });
    expect(logged(events)).toEqual([{ inInput: false, notes: 20_000 }]);
  });
});
