import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tool } from "langchain";
import { z } from "zod";
import { FilesystemBackend } from "deepagents";
import type { StructuredTool } from "@langchain/core/tools";
import { createMemorySessionStore, defaultMounts } from "../index.js";
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
 * `archmax_run` runs any authored script: a skill bundle's, or a workflow's own
 * file on the authoring backend, which the agent can run but never read. It never
 * runs a lifecycle hook, nor a file of the session or of a mount, so a script the
 * agent wrote during the turn stays unrunnable wherever it put it.
 */
describe("archmax_run runs authored scripts", () => {
  const SCRIPT = "workflows/w/scripts/tally.js";
  const files = {
    [SCRIPT]: "JSON.stringify({ n: (args.variables?.items ?? []).length, from: 'authored' });",
    "workflows/w/hooks/gate.js": "export default () => ok();",
    "data/run.js": "'from the mount'",
  };
  // The default tools, and no skill anywhere: a workflow's script needs neither a
  // bundle nor a grant beyond `archmax_run` itself.
  const spec = { runtime: RUNTIME, states: { start: { triggers: { manual: null } } } };
  const run = (file_path: string) => ({ tool: "archmax_run", args: { file_path } });
  const runResults = (messages: unknown[]) => toolResults(messages).filter((r) => r.name === "archmax_run");

  it("runs a workflow's script from the authoring backend, outside every skill bundle", async () => {
    const { agent, events } = await assemble(workspaceWith(spec, files), {
      turns: [run(SCRIPT), { reply: "done" }],
      params: { variables: { items: [1, 2, 3] } },
    });
    const { messages } = await turn(agent, freshSessionId(), "go");

    expect(blockedTools(events)).toEqual([]);
    expect(runResults(messages)[0]?.content).toContain('"n":3,"from":"authored"');
  });

  it("never runs a file the agent wrote at a workflows/ path in its session", async () => {
    // The agent may write `workflows/w/scripts/own.js` into its session, where the
    // path resolves. `archmax_run` reads the authoring backend, which has no such
    // file, so the agent's code never runs.
    const own = "workflows/w/scripts/own.js";
    const sid = freshSessionId();
    const { agent, store } = await assemble(workspaceWith(spec, files), {
      turns: [
        { tool: "write_file", args: { file_path: own, content: "'agent code ran'" } },
        run(own),
        { reply: "done" },
      ],
    });
    const { messages } = await turn(agent, sid, "go");

    expect(await storeFile(store, `/${sid}/${own}`)).toBe("'agent code ran'");
    const [result] = runResults(messages);
    expect(result?.content).toContain("cannot read script 'workflows/w/scripts/own.js' from the authoring backend");
    expect(result?.content).not.toContain("agent code ran");
  });

  it("refuses a hook script and a scratchpad script, whatever the grant", async () => {
    const { agent, events } = await assemble(workspaceWith(spec, files), {
      turns: [
        { tool: "write_file", args: { file_path: "scratchpad/x.js", content: "'agent code ran'" } },
        run("scratchpad/x.js"),
        run("workflows/w/hooks/gate.js"),
        { reply: "done" },
      ],
    });
    const { messages } = await turn(agent, freshSessionId(), "go");

    expect(blockedTools(events)).toEqual(["archmax_run", "archmax_run"]);
    const [scratch, hook] = runResults(messages);
    expect(scratch?.content).toContain("a script written during the session cannot run");
    expect(hook?.content).toContain("is a lifecycle hook script");
    expect(runResults(messages).map((r) => r.content).join("\n")).not.toContain("agent code ran");
  });

  it("refuses a script under a mount", async () => {
    const root = workspaceWith(spec, files);
    const store = createMemorySessionStore();
    const mounts = {
      ...defaultMounts(root),
      "/data/": new FilesystemBackend({ rootDir: join(root, "data"), virtualMode: true }),
    };
    const { agent, events } = await assemble(root, {
      store,
      turns: [{ tool: "read_file", args: { file_path: "data/run.js" } }, run("data/run.js"), { reply: "done" }],
      params: { workspace: { rootDir: root, sessionStore: store, mounts } },
    });
    const { messages } = await turn(agent, freshSessionId(), "go");

    // Readable, because the mount is; never executed, because it is not authored.
    expect(toolResults(messages).find((r) => r.name === "read_file")?.content).toContain("from the mount");
    expect(blockedTools(events)).toEqual(["archmax_run"]);
    expect(runResults(messages)[0]?.content).toContain("runs only authored scripts");
  });

  it("is still narrowed by a state's own entry", async () => {
    const narrowed = {
      runtime: RUNTIME,
      states: {
        start: {
          triggers: { manual: null },
          tools: { allow: [{ tool: "archmax_run", paths: ["workflows/w/scripts/other.js"] }] },
        },
      },
    };
    const { agent, events } = await assemble(workspaceWith(narrowed, files), {
      turns: [run(SCRIPT), { reply: "done" }],
    });
    await turn(agent, freshSessionId(), "go");

    expect(eventsOf(events, "tool-blocked")).toMatchObject([{ tool: "archmax_run", state: "start" }]);
    expect(eventsOf(events, "tool-blocked")[0]?.reason).toContain("is not allowed in state 'start'");
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
