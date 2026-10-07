/**
 * `archmax_raise`: the agent ends its session as a failure. The session is
 * `failed`, the outcome carries the agent's code and reason, the turn ends
 * without another model call, and nothing routes or runs on the way out — no
 * `on_error`, no hook, no `returns` check. A session that never raises is a
 * success.
 */
import { afterEach, describe, expect, it } from "vitest";
import { workflowToolName } from "../index.js";
import {
  advanceTo,
  AGENTS_MD,
  assemble,
  cleanupWorkspaces,
  eventsOf,
  linearSpec,
  makeWorkspace,
  statesEntered,
  toolResults,
  workspaceWith,
  type ScriptedTurn,
} from "./support.js";

afterEach(cleanupWorkspaces);

const RUNTIME = { engine: "archmax-harness", version: "2" };
const CODE = "orders-unavailable";
const REASON = "The orders API failed three times.";
const RAISE: ScriptedTurn = { tool: "archmax_raise", args: { code: CODE, reason: REASON } };
const FAILED_EXIT = { success: false, code: CODE, reason: REASON };

/** The tool answer a call of `name` got in a transcript. */
function answerTo(messages: unknown[], name: string) {
  return toolResults(messages).find((result) => result.name === name);
}

describe("a raise", () => {
  it("ends the session failed with the agent's code and reason, and makes no further model call", async () => {
    const { agent, model, events } = await assemble(workspaceWith(linearSpec()), {
      turns: [RAISE, { reply: "never said" }],
    });
    const outcome = await agent.workflow.send("s1", { message: "which orders are delayed?" });

    expect(outcome).toMatchObject({ kind: "failed", disposition: "turn", status: "failed", state: "start" });
    expect(outcome.exit).toEqual(FAILED_EXIT);
    expect(outcome).not.toHaveProperty("rejected");
    expect(model.calls).toHaveLength(1);
    expect(model.remaining).toBe(1);
    // A raise moves nothing: the trail holds only the turn's arrival.
    expect(outcome.auditTrail.map((step) => step.kind)).toEqual(["trigger"]);
    expect(answerTo(outcome.messages, "archmax_raise")?.status).not.toBe("error");

    const called = eventsOf(events, "tool-called").find((e) => e.tool === "archmax_raise");
    expect(eventsOf(events, "raised")).toEqual([
      expect.objectContaining({ state: "start", sessionId: "s1", code: CODE, reason: REASON, callId: called?.callId }),
    ]);
    expect(eventsOf(events, "state-leave").at(-1)).toMatchObject({ state: "start", next: "start" });
  });

  it("is a success when the agent never raises", async () => {
    const { agent } = await assemble(workspaceWith(linearSpec()), {
      turns: [advanceTo("done"), { reply: "all done" }],
    });
    const outcome = await agent.workflow.send("s1", { message: "go" });
    expect(outcome.kind).toBe("completed");
    expect(outcome.exit).toEqual({ success: true });
  });

  it("is offered in every state, terminal ones included, and says it is for failure only", async () => {
    const { agent, model } = await assemble(workspaceWith(linearSpec()), {
      turns: [advanceTo("done"), RAISE],
    });
    const outcome = await agent.workflow.send("s1", { message: "go" });

    expect(model.calls.map((call) => call.tools.includes("archmax_raise"))).toEqual([true, true]);
    const description = model.boundTools.get("archmax_raise")?.description;
    expect(description).toMatch(/when the task cannot be completed/);
    expect(description).toMatch(/Never call it to finish work that worked/);
    expect(outcome).toMatchObject({ kind: "failed", state: "done" });
  });

  it("is refused beside other calls, and the model is called again", async () => {
    const { agent, model } = await assemble(workspaceWith(linearSpec()), {
      turns: [
        {
          batch: [
            { tool: "write_file", args: { file_path: "scratchpad/notes.md", content: "notes" } },
            { tool: "archmax_raise", args: { code: CODE, reason: REASON } },
          ],
        },
        { reply: "recovered after all" },
      ],
    });
    const outcome = await agent.workflow.send("s1", { message: "go" });

    expect(outcome.kind).toBe("completed");
    expect(outcome.exit).toEqual({ success: true });
    expect(model.calls).toHaveLength(2);
    const refusal = answerTo(outcome.messages, "archmax_raise");
    expect(refusal?.status).toBe("error");
    expect(refusal?.content).toMatch(/stand alone/);
    // The sibling call still ran.
    expect(answerTo(outcome.messages, "write_file")?.status).not.toBe("error");
  });

  it("ends failed without routing on_error, running a hook or checking returns", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        start: {
          triggers: { manual: { returns: ["summary"] } },
          on_error: "escalate",
          after: { script: "hooks/check.js" },
        },
        escalate: {},
      },
    };
    const root = workspaceWith(spec, {
      "workflows/w/hooks/check.js": `/** Fails loudly if it ever runs. */\nexport default () => { throw new Error("the after hook ran"); };\n`,
    });
    const { agent, events } = await assemble(root, { turns: [RAISE] });
    const outcome = await agent.workflow.send("s1", { message: "go" });

    expect(outcome).toMatchObject({ kind: "failed", state: "start" });
    expect(outcome.exit).toEqual(FAILED_EXIT);
    expect(eventsOf(events, "hook-start")).toEqual([]);
    expect(eventsOf(events, "state-error-routed")).toEqual([]);
    expect(statesEntered(events)).toEqual(["start"]);
  });

  it("replaces the rejection a failed sub-run left pending", async () => {
    const child = workflowToolName("enrich");
    const root = makeWorkspace({
      "AGENTS.md": AGENTS_MD,
      "workflows/w/workflow.yaml": {
        runtime: RUNTIME,
        states: {
          start: { triggers: { manual: null }, tools: { allow: [child] }, transitions: [{ to: "done", description: "Finish." }] },
          done: {},
        },
      },
      "workflows/enrich/workflow.yaml": {
        runtime: RUNTIME,
        states: { work: { triggers: { manual: null }, before: { script: "hooks/deny.js" } } },
      },
      "workflows/enrich/hooks/deny.js": `/** Always refuses. */\nexport default () => veto("no customer to enrich");\n`,
    });
    const { agent, events } = await assemble(root, { turns: [{ tool: child, args: {} }, RAISE] });
    const outcome = await agent.workflow.send("s1", { message: "go" });

    expect(eventsOf(events, "sub-workflow-result")).toMatchObject([{ workflow: "enrich", status: "error" }]);
    expect(outcome.kind).toBe("failed");
    expect(outcome.exit).toEqual(FAILED_EXIT);
    expect(outcome).not.toHaveProperty("rejected");

    // The control: the same failure, answered in text instead, ends the session rejected.
    const unraised = await assemble(root, { turns: [{ tool: child, args: {} }, { reply: "could not enrich" }] });
    const rejected = await unraised.agent.workflow.send("s1", { message: "go" });
    expect(rejected.kind).toBe("rejected");
    expect(rejected).not.toHaveProperty("exit");
  });

  it("cannot be called from a script", async () => {
    const { agent } = await assemble(workspaceWith(linearSpec()), {
      turns: [
        { tool: "archmax_eval", args: { code: "typeof tools.archmaxRaise + ':' + Object.keys(tools).includes('archmaxRaise')" } },
        { reply: "checked" },
      ],
    });
    const outcome = await agent.workflow.send("s1", { message: "go" });
    expect(answerTo(outcome.messages, "archmax_eval")?.content).toContain("undefined:false");
    expect(outcome.kind).toBe("completed");
  });
});

describe("a raise and the human states", () => {
  /** work → review [human] → approved | back to work. */
  const REVIEW = {
    runtime: RUNTIME,
    states: {
      work: { triggers: { manual: null }, transitions: [{ to: "review", description: "Hand it to a reviewer." }] },
      review: {
        type: "human",
        transitions: [
          { to: "approved", type: "approve", description: "Fine as it is." },
          { to: "work", type: "refine", description: "Send it back." },
        ],
      },
      approved: {},
    },
  };

  it("is refused on the reply-only turn a park spends, and the session still parks", async () => {
    const { agent, events } = await assemble(workspaceWith(REVIEW), {
      turns: [advanceTo("review"), RAISE],
    });
    const outcome = await agent.workflow.send("s1", { message: "go" });

    expect(outcome).toMatchObject({ kind: "parked", parkedChannel: "decision", state: "review" });
    expect(outcome).not.toHaveProperty("exit");
    expect(eventsOf(events, "tool-blocked").map((e) => e.tool)).toContain("archmax_raise");
    expect(eventsOf(events, "raised")).toEqual([]);
  });

  it("settles a decision whose target state raises as failed", async () => {
    const { agent, model } = await assemble(workspaceWith(REVIEW), {
      turns: [advanceTo("review"), { reply: "Over to you." }],
    });
    await agent.workflow.send("s1", { message: "go" });
    model.enqueue(RAISE);

    const outcome = await agent.workflow.send("s1", { decision: { target: "work", comment: "redo it" } });
    expect(outcome).toMatchObject({ kind: "failed", disposition: "decide", state: "work" });
    expect(outcome.exit).toEqual(FAILED_EXIT);
  });
});

describe("a failed session", () => {
  it("takes its next turn where it raised, as a running turn with the raise cleared", async () => {
    const { agent, model } = await assemble(workspaceWith(linearSpec()), { turns: [RAISE] });
    await agent.workflow.send("s1", { message: "go" });
    expect((await agent.sessions.get("s1"))?.exit?.code).toBe(CODE);

    model.enqueue({ reply: "The orders API is back." });
    const outcome = await agent.workflow.send("s1", { message: "try again" });
    expect(outcome).toMatchObject({ kind: "completed", disposition: "turn", state: "start" });
    expect(outcome.exit).toEqual({ success: true });
    const summary = await agent.sessions.get("s1");
    expect(summary?.status).toBe("completed");
    expect(summary).not.toHaveProperty("exit");
  });
});
