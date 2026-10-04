import { describe, expect, it } from "vitest";
import { tool } from "langchain";
import { z } from "zod";
import type { StructuredTool } from "@langchain/core/tools";
import {
  assemble,
  blockedTools,
  eventsOf,
  freshSessionId,
  skillMarkdown,
  storeFile,
  toolResults,
  turn,
  workspaceWith,
} from "./support.js";

const RUNTIME = { engine: "archmax-harness", version: "2" };

/**
 * An `archmax_run` script reads the session's variables as `args.variables`
 * (flat name → value), beside whatever the model passed — the same view a hook
 * gets — so an authored fan-out script can work from host-seeded input without
 * the model retyping it.
 */
describe("archmax_run arguments", () => {
  const files = {
    "skills/tally/SKILL.md": skillMarkdown("tally", "Counts things."),
    "skills/tally/scripts/count.js":
      "const list = args.variables?.items ?? []; JSON.stringify({ n: list.length, extra: args.extra ?? null });",
  };
  const spec = {
    runtime: RUNTIME,
    skills: { allow_always: [] },
    states: { start: { triggers: { manual: null }, skills: { allow: ["tally"] } } },
  };

  it("exposes seeded variables as args.variables and the model's arguments beside them", async () => {
    const { agent } = await assemble(workspaceWith(spec, files), {
      turns: [
        {
          tool: "archmax_run",
          args: { file_path: "skills/tally/scripts/count.js", args: { extra: "x" } },
        },
        { reply: "done" },
      ],
      params: { variables: { items: [{ id: 1 }, { id: 2 }] } },
    });
    const { messages } = await turn(agent, "run-vars", "go");

    const run = toolResults(messages).find((r) => r.name === "archmax_run");
    expect(run?.status).not.toBe("error");
    expect(String(run?.content)).toContain('"n":2');
    expect(String(run?.content)).toContain('"extra":"x"');
  });
});

/**
 * A script's `tools.*` call runs on the model's authority, so a state's
 * `${{name}}` argument guard binds it exactly as it binds the model's own call:
 * the guard is resolved against the run's variables and the script passes the
 * literal value. A script's own arguments are never `${{…}}`-substituted — they
 * are computed values, passed verbatim. Scratchpad paths are always open, so the
 * guarded file is a skill asset.
 */
describe("a script's tool call under a variable guard", () => {
  const files = {
    "skills/data/SKILL.md": skillMarkdown("data", "Report data."),
    "skills/data/assets/r.json": '{"report":true}',
    "skills/data/assets/other.json": '{"other":true}',
  };
  const spec = {
    runtime: RUNTIME,
    skills: { allow_always: [] },
    states: {
      start: {
        triggers: { manual: null },
        skills: { allow: ["data"] },
        tools: { allow: [{ tool: "read_file", args: { file_path: ["${{report_path}}"] } }] },
      },
    },
  };
  const evalRead = (path: string) => ({
    tool: "archmax_eval",
    args: {
      code: [
        "let out;",
        `try { out = await tools.readFile({ file_path: ${JSON.stringify(path)} }); }`,
        'catch (e) { out = "refused: " + e.message; }',
        "out;",
      ].join("\n"),
    },
  });
  const params = { variables: { report_path: "skills/data/assets/r.json" } };

  it("allows the script the path the guard resolves to, as it allows the model", async () => {
    const { agent, events } = await assemble(workspaceWith(spec, files), {
      turns: [
        { tool: "read_file", args: { file_path: "${{report_path}}" } },
        evalRead("skills/data/assets/r.json"),
        { reply: "done" },
      ],
      params,
    });
    const { messages } = await turn(agent, freshSessionId(), "go");

    expect(blockedTools(events)).toEqual([]);
    const scriptReads = eventsOf(events, "tool-called").filter((e) => e.tool === "read_file" && e.origin === "script");
    expect(scriptReads).toHaveLength(1);
    const evalResult = toolResults(messages).find((r) => r.name === "archmax_eval");
    expect(evalResult?.status).not.toBe("error");
    expect(evalResult?.content).toContain('"report":true');
  });

  it("refuses the script a path the guard does not name", async () => {
    const { agent, events } = await assemble(workspaceWith(spec, files), {
      turns: [evalRead("skills/data/assets/other.json"), { reply: "done" }],
      params,
    });
    const { messages } = await turn(agent, freshSessionId(), "go");

    expect(eventsOf(events, "tool-blocked")).toMatchObject([{ tool: "read_file", origin: "script", state: "start" }]);
    expect(eventsOf(events, "tool-called").filter((e) => e.tool === "read_file")).toEqual([]);
    expect(toolResults(messages).find((r) => r.name === "archmax_eval")?.content).toContain("refused:");
  });

  it("passes a script argument containing ${{…}} text to the tool verbatim", async () => {
    const sid = freshSessionId();
    const literal = "keep ${{not_a_var}} as written";
    // The script *computes* the text: the model's own `code` argument is
    // substituted at wrapToolCall, so a literal reference there would be the
    // model's unresolved reference, not the script's data.
    const code = [
      'const text = "keep " + "$" + "{{not_a_var}} as written";',
      'await tools.writeFile({ file_path: "scratchpad/note.txt", content: text });',
      '"written";',
    ].join("\n");
    const { agent, events, store } = await assemble(workspaceWith(spec, files), {
      turns: [
        { tool: "archmax_eval", args: { code } },
        { reply: "done" },
      ],
      params,
    });
    const { messages } = await turn(agent, sid, "go");

    expect(blockedTools(events)).toEqual([]);
    expect(toolResults(messages).find((r) => r.name === "archmax_eval")?.status).not.toBe("error");
    expect(await storeFile(store, `/${sid}/scratchpad/note.txt`)).toBe(literal);
  });
});

/**
 * A script's `tools` lists the tools its state offers, as the model's own tool
 * list does, re-scoped at every evaluation — so a run that moves sees the next
 * state's tools in the same REPL. A hook runs on runtime authority and keeps them all.
 */
describe("the tools a script lists", () => {
  const hostTools = (): StructuredTool[] =>
    ["alpha", "beta"].map(
      (name) =>
        tool(async ({ q }: { q: string }) => `${name}:${q}`, {
          name,
          description: `The ${name} tool.`,
          schema: z.object({ q: z.string() }),
        }) as unknown as StructuredTool,
    );
  const spec = {
    runtime: RUNTIME,
    states: {
      start: {
        triggers: { manual: null },
        tools: { allow: ["alpha"] },
        before: { script: "hooks/list.js" },
        transitions: [{ to: "done", description: "Finish." }],
      },
      done: { tools: { allow: ["beta"] } },
    },
  };
  const LIST = "JSON.stringify(Object.keys(tools).filter((name) => name === 'alpha' || name === 'beta'))";

  it("follows the state from one evaluation to the next, while a hook sees every tool", async () => {
    const root = workspaceWith(spec, {
      "workflows/w/hooks/list.js":
        "/** Reports the tools a hook sees. */\nexport default ({ tools }) => { console.log('hook:' + Object.keys(tools).filter((n) => n === 'alpha' || n === 'beta').join(',')); return ok(); };\n",
    });
    const { agent, events } = await assemble(root, {
      turns: [
        { tool: "archmax_eval", args: { code: LIST } },
        { tool: "archmax_advance", args: { to: "done", reason: "listed" } },
        { tool: "archmax_eval", args: { code: LIST } },
        { reply: "done" },
      ],
      params: { tools: hostTools() },
    });
    const { messages } = await turn(agent, freshSessionId(), "go");

    const evals = toolResults(messages).filter((r) => r.name === "archmax_eval").map((r) => r.content);
    expect(evals).toHaveLength(2);
    expect(evals[0]).toContain('["alpha"]');
    expect(evals[1]).toContain('["beta"]');
    expect(eventsOf(events, "hook-output").map((e) => e.line)).toContain("hook:alpha,beta");
  });
});
