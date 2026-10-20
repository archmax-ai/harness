/**
 * The workflow's turn budget, `budget.maxModelCalls`: the model calls of one
 * invocation (a message, a decision, a reply or a delivery) across every state.
 * Where `maxTurns` starts over on every entry, so a cycle between states never
 * exhausts it, this bound is the turn's. Its exhaustion routes once, like every
 * budget, through `on_error`, else ends the turn rejected.
 */
import { afterEach, describe, expect, it } from "vitest";
import { workflowToolName } from "../index.js";
import {
  advanceTo,
  AGENTS_MD,
  assemble,
  cleanupWorkspaces,
  eventsOf,
  makeWorkspace,
  workspaceWith,
  type ScriptedTurn,
} from "./support.js";

afterEach(cleanupWorkspaces);

const RUNTIME = { engine: "archmax-harness", version: "2" };
const write = (n: number): ScriptedTurn => ({
  tool: "write_file",
  args: { file_path: `scratchpad/note-${n}.md`, content: String(n) },
});

/** a ⇄ b under a turn budget, each routing to `handle` when it fails. */
function cycle(maxModelCalls: number, onError = true) {
  const route = onError ? { on_error: "handle" } : {};
  return {
    runtime: RUNTIME,
    budget: { maxModelCalls },
    states: {
      a: { triggers: { manual: null }, ...route, transitions: [{ to: "b", description: "Test edge to b." }] },
      b: { ...route, transitions: [{ to: "a", description: "Test edge to a." }] },
      ...(onError ? { handle: {} } : {}),
    },
  };
}
const bouncing = (n: number) => Array.from({ length: n }, (_, i) => advanceTo(i % 2 === 0 ? "b" : "a"));

describe("the turn budget", () => {
  it("routes a cycle between states to on_error once it is spent, and lets the handler work", async () => {
    const { agent, events, model } = await assemble(workspaceWith(cycle(10)), {
      // Ten advances spend the budget; the handler then writes twice and answers.
      turns: [...bouncing(10), write(1), write(2), { reply: "handled" }],
    });
    const outcome = await agent.workflow.send("s1", { message: "go" });

    expect(eventsOf(events, "state-error-routed")).toMatchObject([{ state: "a", to: "handle" }]);
    expect(eventsOf(events, "state-error-routed")[0]?.reason).toMatch(/maxModelCalls: 10/);
    expect(outcome).toMatchObject({ kind: "completed", state: "handle", reply: "handled" });
    expect(model.calls).toHaveLength(13);
  });

  it("warns the agent once a fifth of the budget is left, and not after it is spent", async () => {
    const { agent, model } = await assemble(workspaceWith(cycle(10)), {
      turns: [...bouncing(10), { reply: "handled" }],
    });
    await agent.workflow.send("s1", { message: "go" });
    const warning = (call: number) => /This turn has \d+ model calls? left/.exec(model.calls[call]!.systemPrompt)?.[0];
    expect(warning(7)).toBeUndefined();
    expect(warning(8)).toBe("This turn has 2 model calls left");
    expect(warning(9)).toBe("This turn has 1 model call left");
    // The handler the spent budget routed to is not warned about a budget it no longer has.
    expect(warning(10)).toBeUndefined();
  });

  it("ends the turn rejected when the state declares no on_error", async () => {
    const { agent } = await assemble(workspaceWith(cycle(10, false)), { turns: bouncing(20) });
    const outcome = await agent.workflow.send("s1", { message: "go" });
    expect(outcome.kind).toBe("rejected");
    expect(outcome.rejected).toMatch(/maxModelCalls: 10/);
  });

  it("raises the step limit with the budget, so a long turn the author allowed completes", async () => {
    const spec = { runtime: RUNTIME, budget: { maxModelCalls: 200 }, states: { work: { triggers: { manual: null } } } };
    // 150 calls is far past the 400 steps a turn ran under before the limit followed the budget.
    const turns = [...Array.from({ length: 149 }, (_, i) => write(i)), { reply: "all written" } as ScriptedTurn];
    const { agent } = await assemble(workspaceWith(spec), { turns });
    expect(await agent.workflow.send("s1", { message: "go" })).toMatchObject({ kind: "completed", reply: "all written" });
  }, 60_000);

  it("counts each invocation on its own, so a delivery after a park starts over", async () => {
    const spec = {
      runtime: RUNTIME,
      budget: { maxModelCalls: 3 },
      states: {
        clarify: {
          triggers: { manual: { session: "conversation_id" }, email_reply: { session: "conversation_id" } },
          transitions: [{ to: "answer", description: "Test edge to answer." }],
        },
        answer: {},
      },
    };
    const { agent, model } = await assemble(workspaceWith(spec), {
      turns: [write(1), { tool: "archmax_wait", args: { reason: "need the order id" } }],
    });
    const parked = await agent.workflow.send("conv-1", { message: "help" });
    expect(parked).toMatchObject({ kind: "parked", parkedChannel: "input" });

    // Three calls of its own: over the budget only if the park's two still counted.
    model.enqueue(write(2), write(3), { reply: "found it" });
    const delivered = await agent.workflow.send("conv-1", { delivery: { trigger: { id: "email_reply" } } });
    expect(delivered).toMatchObject({ kind: "completed", reply: "found it" });
  });

  it("counts a delegated child's calls against its own workflow, not its caller's", async () => {
    const child = workflowToolName("enrich");
    const root = makeWorkspace({
      "AGENTS.md": AGENTS_MD,
      "workflows/w/workflow.yaml": {
        runtime: RUNTIME,
        budget: { maxModelCalls: 2 },
        states: { start: { triggers: { manual: null }, tools: { allow: [child] } } },
      },
      "workflows/enrich/workflow.yaml": { runtime: RUNTIME, states: { work: { triggers: { manual: null } } } },
    });
    const { agent } = await assemble(root, {
      turns: [{ tool: child, args: {} }, write(1), write(2), { reply: "enriched" }, { reply: "parent done" }],
    });
    expect(await agent.workflow.send("s1", { message: "go" })).toMatchObject({ kind: "completed", reply: "parent done" });
  });
});
