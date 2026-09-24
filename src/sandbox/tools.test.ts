import { describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { PTC_EXCLUDED_TOOLS } from "../kernel/kernel.js";
import type { ScriptExecutor, ScriptOutcome } from "./executor.js";
import { AGENT_SESSION } from "./executor.js";
import { createInterpreter, resolvePtcTools } from "./tools.js";
import { EVAL_TOOL, RUN_TOOL } from "../machine/tool-names.js";

/** Pick one of the interpreter's tools by name (order is not a contract). */
function toolNamed(interpreter: ReturnType<typeof createInterpreter>, name: string) {
  const found = interpreter.tools.find((t) => t.name === name);
  if (!found) throw new Error(`interpreter exposes no '${name}' tool`);
  return found as unknown as { invoke(input: unknown, config: unknown): Promise<unknown> };
}

const fakeTool = (name: string) => ({ name });

const ALL_TOOLS = [
  fakeTool("read_file"),
  fakeTool("archmax_run"),
  fakeTool("write_file"),
  fakeTool("archmax_advance"),
  fakeTool("archmax_eval"),
  fakeTool("eval"),
  fakeTool("ls"),
];

describe("resolvePtcTools", () => {
  it("returns every tool except the PTC-excluded set when the allow-list is empty", () => {
    const resolved = resolvePtcTools(ALL_TOOLS, []);
    expect(resolved.map((t) => t.name)).toEqual(["read_file", "write_file", "ls"]);
    for (const tool of resolved) {
      expect(PTC_EXCLUDED_TOOLS.has(tool.name)).toBe(false);
    }
  });

  it("resolves a named allow-list in the given order", () => {
    const resolved = resolvePtcTools(ALL_TOOLS, ["ls", "read_file"]);
    expect(resolved.map((t) => t.name)).toEqual(["ls", "read_file"]);
  });

  it("drops unknown names from the allow-list", () => {
    const resolved = resolvePtcTools(ALL_TOOLS, ["read_file", "no_such_tool", "write_file"]);
    expect(resolved.map((t) => t.name)).toEqual(["read_file", "write_file"]);
  });

  it("returns an empty set when no names match", () => {
    expect(resolvePtcTools(ALL_TOOLS, ["nope"])).toEqual([]);
  });

  it("applies the governance exclusions even when named in the allow-list", () => {
    const resolved = resolvePtcTools(ALL_TOOLS, [
      "archmax_run",
      "read_file",
      "archmax_advance",
      "archmax_eval",
      "eval",
    ]);
    expect(resolved.map((t) => t.name)).toEqual(["read_file"]);
  });
});

describe("createInterpreter dispose", () => {
  function stubExecutor(): { executor: ScriptExecutor; disposals: Array<[string, string | undefined]> } {
    const disposals: Array<[string, string | undefined]> = [];
    const outcome: ScriptOutcome = { ok: true, value: null, logs: [], formatted: "" };
    const executor: ScriptExecutor = {
      async runFile() {
        return outcome;
      },
      async runCode() {
        return outcome;
      },
      dispose(sessionId, sessionNamespace) {
        disposals.push([sessionId, sessionNamespace]);
      },
    };
    return { executor, disposals };
  }

  it("tears down the agent REPL session for the session and is idempotent", () => {
    const { executor, disposals } = stubExecutor();
    const interpreter = createInterpreter({ executor, ptcNames: [] });

    interpreter.dispose("t1");
    interpreter.dispose("t1");

    expect(disposals).toEqual([
      ["t1", AGENT_SESSION],
      ["t1", AGENT_SESSION],
    ]);
  });
});

describe("createInterpreter run-scope isolation", () => {
  function recordingExecutor(): {
    executor: ScriptExecutor;
    runs: Array<{ sessionId: string; tools: string[] }>;
    disposals: Array<[string, string | undefined]>;
  } {
    const runs: Array<{ sessionId: string; tools: string[] }> = [];
    const disposals: Array<[string, string | undefined]> = [];
    const outcome: ScriptOutcome = { ok: true, value: null, logs: [], formatted: "" };
    const executor: ScriptExecutor = {
      async runFile(_path, opts) {
        runs.push({
          sessionId: opts.sessionId,
          tools: (opts.tools ?? []).map((t) => (t as { name: string }).name),
        });
        return outcome;
      },
      async runCode(_code, opts) {
        runs.push({
          sessionId: opts.sessionId,
          tools: (opts.tools ?? []).map((t) => (t as { name: string }).name),
        });
        return outcome;
      },
      dispose(sessionId, sessionNamespace) {
        disposals.push([sessionId, sessionNamespace]);
      },
    };
    return { executor, runs, disposals };
  }

  /** A runtime config as LangGraph hands it to a node, optionally inside a sub-run. */
  // A sub-run is an ordinary session, so its scope is just its own session id.
  const configFor = (sessionId: string) => ({
    configurable: {
      thread_id: sessionId,
      // LangGraph rewrites this per node; the scope must not be derived from it.
      checkpoint_ns: "someNode:1a2b",
    },
  });

  async function capture(
    interpreter: ReturnType<typeof createInterpreter>,
    config: ReturnType<typeof configFor>,
    tools: { name: string }[],
  ): Promise<void> {
    // Drive the middleware's capture point, then the script tool, the way a
    // segment does.
    await (interpreter.middleware as unknown as {
      wrapModelCall(req: unknown, handler: (r: unknown) => unknown): Promise<unknown>;
    }).wrapModelCall({ runtime: config, tools, state: {} }, () => new AIMessage("ok"));
    await toolNamed(interpreter, RUN_TOOL).invoke({ file_path: "scripts/x.js" }, config);
  }

  it("gives a top-level run the bare session id, exactly as before", async () => {
    const { executor, runs } = recordingExecutor();
    const interpreter = createInterpreter({ executor, ptcNames: [] });

    await capture(interpreter, configFor("s1"), [fakeTool("read_file")]);

    expect(runs[0]?.sessionId).toBe("s1");
  });

  it("keeps two concurrent sub-runs of one session on separate REPL sessions", async () => {
    const { executor, runs } = recordingExecutor();
    const interpreter = createInterpreter({ executor, ptcNames: [] });

    // Two sub-runs of one caller: separate sessions, so separate scopes.
    await capture(interpreter, configFor("s1~n:w:0"), [fakeTool("read_file")]);
    await capture(interpreter, configFor("s1~n:w:1"), [fakeTool("ls")]);

    expect(runs.map((r) => r.sessionId)).toEqual(["s1~n:w:0", "s1~n:w:1"]);
    // Neither sub-run sees the other's captured tool set.
    expect(runs[0]?.tools).toEqual(["read_file"]);
    expect(runs[1]?.tools).toEqual(["ls"]);
  });

  it("runs inline code on the same scope and PTC surface as a script file", async () => {
    const { executor, runs } = recordingExecutor();
    const interpreter = createInterpreter({ executor, ptcNames: [] });
    const config = configFor("s1~n:w:0");

    await (interpreter.middleware as unknown as {
      wrapModelCall(req: unknown, handler: (r: unknown) => unknown): Promise<unknown>;
    }).wrapModelCall({ runtime: config, tools: [fakeTool("read_file")], state: {} }, () =>
      new AIMessage("ok"),
    );
    await toolNamed(interpreter, EVAL_TOOL).invoke({ code: "1 + 1" }, config);

    expect(runs[0]).toEqual({ sessionId: "s1~n:w:0", tools: ["read_file"] });
  });

  it("releases nested sub-run scopes when the session is disposed", async () => {
    const { executor, disposals } = recordingExecutor();
    const interpreter = createInterpreter({ executor, ptcNames: [] });

    await capture(interpreter, configFor("s1~n:w:0"), [fakeTool("read_file")]);
    await capture(interpreter, configFor("s1~n:w:1"), [fakeTool("ls")]);
    disposals.length = 0;

    interpreter.dispose("s1");

    expect(disposals.map(([scope]) => scope).sort()).toEqual(["s1", "s1~n:w:0", "s1~n:w:1"]);
  });
});

describe("archmax_run argument contract", () => {
  it("hands the script the model's args plus the session's variables by name", async () => {
    let seenArgs: Record<string, unknown> | undefined;
    const outcome: ScriptOutcome = { ok: true, value: null, logs: [], formatted: "" };
    const executor: ScriptExecutor = {
      async runFile(_path, opts) {
        seenArgs = opts.args;
        return outcome;
      },
      async runCode() {
        return outcome;
      },
      dispose() {},
    };
    const interpreter = createInterpreter({ executor, ptcNames: [] });
    const config = { configurable: { thread_id: "s1" } };
    const state = { variables: { orders_to_enrich: { value: [{ order_id: "ORD-1" }], locked: true } } };

    // The middleware captures the variables at the tool call, then the tool runs.
    const call = { toolCall: { name: RUN_TOOL, args: { file_path: "skills/x/scripts/y.js" } }, state, runtime: config };
    await (interpreter.middleware as unknown as {
      wrapToolCall(req: unknown, handler: (r: unknown) => unknown): Promise<unknown>;
    }).wrapToolCall(call, async () =>
      toolNamed(interpreter, RUN_TOOL).invoke({ file_path: "skills/x/scripts/y.js", args: { limit: 2 } }, config),
    );

    expect(seenArgs).toEqual({ limit: 2, variables: { orders_to_enrich: [{ order_id: "ORD-1" }] } });
  });
});
