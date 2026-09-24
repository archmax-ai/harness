/**
 * The model a turn runs on: a workflow names one for every state
 * (`settings.model`), a state names its own, and each is resolved through the
 * assembly's factory seam. What is asserted here is which model actually
 * answered each turn — the parked state's for a reply, the child's own spec for
 * a sub-workflow — not merely which id was requested.
 */
import { afterEach, describe, expect, it } from "vitest";
import { workflowToolName } from "../index.js";
import {
  advanceTo,
  assemble,
  AGENTS_MD,
  cleanupWorkspaces,
  makeWorkspace,
  ScriptedModel,
  turn,
  workspaceWith,
  type ScriptedTurn,
} from "./support.js";

afterEach(cleanupWorkspaces);

const RUNTIME = { engine: "archmax-harness", version: "2" };

/**
 * One scripted model per id the spec declares, built on demand. `""` is the
 * assembly default — the model a state with no declaration runs on.
 */
function modelBench(scripts: Record<string, ScriptedTurn[]> = {}) {
  const built = new Map<string, ScriptedModel>();
  const requested: string[] = [];
  const modelFor = (id: string): ScriptedModel => {
    let model = built.get(id);
    if (!model) {
      model = new ScriptedModel(scripts[id] ?? [], { fallbackReply: `answered by ${id || "default"}` });
      built.set(id, model);
    }
    return model;
  };
  return {
    requested,
    built,
    /** Which ids answered a call, in the order their first call came in. */
    answered: () => [...built].filter(([, model]) => model.calls.length > 0).map(([id]) => id),
    callsFor: (id: string) => built.get(id)?.calls.length ?? 0,
    modelFactory: ((role: string, _env: unknown, id?: string) => {
      if (role === "agent") requested.push(id ?? "");
      return modelFor(id ?? "") as never;
    }) as never,
  };
}

describe("a workflow that names the model its states run on", () => {
  /** triage (workflow model) → draft (its own model) → done. */
  const SPEC = {
    runtime: RUNTIME,
    settings: { model: "small-model" },
    states: {
      triage: {
        triggers: { manual: null },
        transitions: [{ to: "draft", description: "hand the case to drafting" }],
      },
      draft: {
        model: "large-model",
        transitions: [{ to: "done", description: "finish" }],
      },
      done: {},
    },
  };

  it("runs each state's turns on the id in force, and builds one model per id", async () => {
    const bench = modelBench({
      "small-model": [advanceTo("draft", "triage is done")],
      "large-model": [advanceTo("done", "the draft is ready")],
    });
    const { agent } = await assemble(workspaceWith(SPEC), { modelFactory: bench.modelFactory });

    await turn(agent, "s1", "please handle this");

    // The workflow's own model answered `triage`, the state's answered `draft`,
    // and the assembly default was never asked to answer anything.
    expect(bench.answered()).toEqual(["small-model", "large-model"]);
    expect(bench.callsFor("")).toBe(0);
    // Each id is built once, however many calls run on it.
    expect(bench.requested.filter((id) => id === "large-model")).toHaveLength(1);
  });

  it("leaves a state that declares nothing on the assembly's own model", async () => {
    const bench = modelBench({ "": [advanceTo("draft", "triage is done")] });
    const { agent } = await assemble(
      workspaceWith({
        runtime: RUNTIME,
        states: {
          triage: {
            triggers: { manual: null },
            transitions: [{ to: "draft", description: "hand over" }],
          },
          draft: { transitions: [{ to: "done", description: "finish" }] },
          done: {},
        },
      }),
      { modelFactory: bench.modelFactory },
    );

    await turn(agent, "s1", "please handle this");

    expect(bench.answered()).toEqual([""]);
  });

  it("answers a parked session's reply on the parked state's model", async () => {
    const bench = modelBench({
      "small-model": [advanceTo("review", "ready for a person")],
    });
    const { agent } = await assemble(
      workspaceWith({
        runtime: RUNTIME,
        settings: { model: "small-model" },
        states: {
          work: {
            triggers: { manual: null },
            transitions: [{ to: "review", description: "hand the draft to a reviewer" }],
          },
          review: {
            type: "human",
            model: "large-model",
            title: "Review the draft",
            transitions: [{ to: "done", type: "approve", description: "the draft is fine" }],
          },
          done: {},
        },
      }),
      { modelFactory: bench.modelFactory },
    );

    await turn(agent, "s1", "please draft this");
    const before = bench.callsFor("large-model");
    await agent.workflow.reply("s1", "what is the deadline?");

    // The handoff message is a reply-only turn made in the state the session is
    // parked at, so it runs on that state's model, not the workflow's.
    expect(bench.callsFor("large-model")).toBe(before + 1);
  });
});

describe("a delegated workflow", () => {
  const CHILD_TOOL = workflowToolName("enrich");

  it("runs on the ids its own spec declares, inheriting none from its caller", async () => {
    const root = makeWorkspace({
      "AGENTS.md": AGENTS_MD,
      "workflows/w/workflow.yaml": {
        runtime: RUNTIME,
        settings: { model: "parent-model" },
        states: {
          start: { triggers: { manual: null }, tools: { allow: [CHILD_TOOL] }, transitions: [{ to: "done", description: "Test edge to done." }] },
          done: {},
        },
      },
      // The child declares nothing, so its turns run on the assembly default —
      // the caller's `settings.model` is the caller's alone.
      "workflows/enrich/workflow.yaml": {
        runtime: RUNTIME,
        states: { work: { triggers: { manual: null } } },
      },
    });

    const bench = modelBench({
      "parent-model": [{ tool: CHILD_TOOL, args: { prompt: "enrich this" } }],
      "": [],
    });
    const { agent } = await assemble(root, { modelFactory: bench.modelFactory });

    await turn(agent, "s1", "please handle this");

    expect(bench.callsFor("parent-model")).toBeGreaterThan(0);
    // The child answered on the default model, never on the parent's.
    expect(bench.callsFor("")).toBeGreaterThan(0);
  });
});
