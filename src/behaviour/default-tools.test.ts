/**
 * The default tools: what a workflow without `tools.allow_always` is granted in
 * every state, and what a declared list replaces. Observed from the outside —
 * the tools each model call offers, the static prompt it reads, and the verdicts
 * on the calls it makes.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  advanceTo,
  assemble,
  blockedTools,
  cleanupWorkspaces,
  eventsOf,
  toolResults,
  turn,
  workspaceWith,
  type ScriptedModel,
} from "./support.js";

afterEach(cleanupWorkspaces);

const RUNTIME = { engine: "archmax-harness", version: "3" };

/** The text of every system block of the model's `index`th call. */
function systemText(model: ScriptedModel, index = 0): string {
  const system = model.calls[index]?.parts.find((message) => message.type === "system")?.parts ?? [];
  return system.map((part) => String(part.text)).join("\n");
}

describe("write_todos guidance follows the grant", () => {
  const answer = { start: { triggers: { manual: null } } };

  it("is absent when no state is granted write_todos", async () => {
    const { agent, model } = await assemble(
      workspaceWith({ runtime: RUNTIME, tools: { allow_always: ["read_file", "ls"] }, states: answer }),
      { turns: [{ reply: "ok" }] },
    );
    await turn(agent, "s1", "hi");
    expect(systemText(model)).not.toContain("## `write_todos`");
    expect(model.calls[0]?.tools).not.toContain("write_todos");
  });

  it("is present when write_todos is granted, by default or by a state", async () => {
    for (const spec of [
      { runtime: RUNTIME, states: answer },
      {
        runtime: RUNTIME,
        tools: { allow_always: ["read_file"] },
        states: { start: { triggers: { manual: null }, tools: { allow: ["write_todos"] } } },
      },
    ]) {
      const { agent, model } = await assemble(workspaceWith(spec), { turns: [{ reply: "ok" }] });
      await turn(agent, "s1", "hi");
      expect(systemText(model)).toContain("## `write_todos`");
      expect(model.calls[0]?.tools).toContain("write_todos");
    }
  });

  it("leaves out langchain's advice to end on a final answer, which would talk the model out of a raise", async () => {
    const { agent, model } = await assemble(workspaceWith({ runtime: RUNTIME, states: answer }), {
      turns: [{ reply: "ok" }],
    });
    await turn(agent, "s1", "hi");
    expect(systemText(model)).toContain("## Important To-Do List Usage Notes to Remember");
    expect(systemText(model)).not.toContain("## Finishing a task");
    const described = model.calls[0]?.toolDescriptions["write_todos"] ?? "";
    expect(described).toContain("structured task list");
    expect(described).not.toContain("## When You Finish");
  });
});

describe("a declared allow_always replaces the default tools", () => {
  // `read_file` and `ls` everywhere; `write_file` only in `draft`, narrowed to
  // reports/**; nothing else of the default tools anywhere.
  const spec = {
    runtime: RUNTIME,
    tools: { allow_always: ["read_file", "ls"] },
    states: {
      draft: {
        triggers: { manual: null },
        tools: { allow: [{ tool: "write_file", paths: ["reports/**"] }] },
        transitions: [{ to: "check", description: "The draft is written." }],
      },
      check: { type: "code", script: "scripts/check.js", transitions: [{ to: "review", description: "Checked." }] },
      review: {},
    },
  };

  it("discloses and permits per state exactly what the workflow grants", async () => {
    const root = workspaceWith(spec, {
      "workflows/w/scripts/check.js":
        'export default async ({ tools }) => { await tools.archmax_advance({ to: "review", reason: "checked" }); };\n',
    });
    const { agent, model, events } = await assemble(root, {
      turns: [
        { tool: "write_file", args: { file_path: "scratchpad/a.md", content: "x" } },
        advanceTo("check"),
        { tool: "write_file", args: { file_path: "scratchpad/b.md", content: "y" } },
        { tool: "archmax_eval", args: { code: "1 + 1" } },
        { reply: "ok" },
      ],
    });
    const { messages } = await turn(agent, "s1", "go");

    // Disclosure: the declared grant plus the state's own entries, nothing more.
    const [inDraft] = model.calls;
    expect(inDraft?.tools).toEqual(expect.arrayContaining(["read_file", "ls", "write_file"]));
    for (const tool of ["edit_file", "copy_file", "write_todos", "archmax_eval", "archmax_run"]) {
      expect(inDraft?.tools).not.toContain(tool);
    }
    const inReview = model.calls.at(-1);
    expect(inReview?.tools).toContain("read_file");
    expect(inReview?.tools).not.toContain("write_file");

    // The scratchpad is open to write_file where it is granted, despite the
    // narrowing entry, and closed where it is not; the interpreter is withheld.
    const writes = toolResults(messages).filter((r) => r.name === "write_file");
    expect(writes[0]?.status).not.toBe("error");
    expect(blockedTools(events)).toEqual(["write_file", "archmax_eval"]);
    for (const blocked of eventsOf(events, "tool-blocked")) {
      expect(blocked).toMatchObject({ state: "review" });
      expect(blocked.reason).toMatch(/not allowed in state/);
    }

    // The code state ran in the sandbox all the same: running a script needs no grant of the interpreter.
    expect(eventsOf(events, "code-result")).toMatchObject([{ state: "check", status: "ok" }]);
  });
});
