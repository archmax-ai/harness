import { describe, expect, it } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";
import type { BackendProtocolV2 } from "deepagents";
import { Workspace } from "../core/workspace.js";
import { CODE_SESSION, createScriptExecutor } from "./executor.js";
import type { SandboxRuntime } from "./runtime.js";

function workspaceWith(files: Record<string, string>): Workspace {
  const norm = (p: string) => `/${p.replace(/^\/+/, "")}`;
  const backend = {
    async readRaw(filePath: string) {
      const content = files[norm(filePath)];
      return content === undefined
        ? { error: "missing" }
        : { data: { content, mimeType: "text/plain", created_at: "", modified_at: "" } };
    },
  } as unknown as BackendProtocolV2;
  return new Workspace(backend);
}

describe("createScriptExecutor.runCode", () => {
  it("evaluates inline code under the PTC contract when the prelude is asked for", async () => {
    const executor = createScriptExecutor({ workspace: workspaceWith({}) });
    const outcome = await executor.runCode("SANDBOX_CONTRACT.context", {
      sessionId: "e1",
      sessionNamespace: "agent",
      prelude: true,
    });
    executor.dispose("e1");
    expect(outcome.ok, outcome.error?.message).toBe(true);
    expect(outcome.value).toBe("ptc");
  });

  it("keeps REPL state across calls in one session, as the eval tool relies on", async () => {
    const executor = createScriptExecutor({ workspace: workspaceWith({}) });
    const params = { sessionId: "e2", sessionNamespace: "agent", prelude: true } as const;
    await executor.runCode("globalThis.total = 40", params);
    const outcome = await executor.runCode("total + 2", params);
    executor.dispose("e2");
    expect(outcome.value).toBe(42);
  });

  it("leaves code raw when no prelude is requested", async () => {
    const executor = createScriptExecutor({ workspace: workspaceWith({}) });
    const outcome = await executor.runCode("typeof SANDBOX_CONTRACT", {
      sessionId: "e3",
      sessionNamespace: "agent",
    });
    executor.dispose("e3");
    expect(outcome.value).toBe("undefined");
  });

  it("does not give the model's code the code-state vocabulary, nor the retired hook one", async () => {
    const executor = createScriptExecutor({ workspace: workspaceWith({}) });
    const outcome = await executor.runCode("[typeof defineCodeState, typeof veto, typeof defineHook, typeof t]", {
      sessionId: "e4",
      sessionNamespace: "agent",
      prelude: true,
    });
    executor.dispose("e4");
    expect(outcome.value).toEqual(["undefined", "undefined", "undefined", "undefined"]);
  });
});

/**
 * A tool as the session injects it: only the name and `invoke` matter to the
 * bridge. `calls`, when given, records each input the tool is invoked with.
 */
const stubTool = (name: string, calls?: unknown[]): StructuredTool =>
  ({
    name,
    description: name,
    schema: { type: "object" },
    invoke: async (input: unknown) => {
      calls?.push(input);
      return `${name}:done`;
    },
  }) as never;
const STUB_TOOLS = [stubTool("read_file"), stubTool("write_file"), stubTool("archmax_workflow_enrich-order")];

const CODE_SCRIPT = "workflows/order-lookup/scripts/x.js";

/**
 * Run one source as a code state's script, its tools a recording
 * `archmax_advance` plus {@link STUB_TOOLS}, its surface `archmax_advance` unless
 * named. Returns the outcome and every input `archmax_advance` was called with.
 */
async function runCodeState(
  source: string,
  args: Record<string, unknown> = {},
  surface: string[] = ["archmax_advance"],
) {
  const advances: unknown[] = [];
  const executor = createScriptExecutor({ workspace: workspaceWith({ [`/${CODE_SCRIPT}`]: source }) });
  const outcome = await executor.runCodeState(CODE_SCRIPT, {
    sessionId: "code-run",
    args,
    tools: [stubTool("archmax_advance", advances), ...STUB_TOOLS],
    surface,
  });
  executor.dispose("code-run");
  return { outcome, advances };
}

describe("a script's tools, scoped to a surface", () => {
  it("lists only the surface an archmax_eval is run with, camel-cased like the bridge", async () => {
    const executor = createScriptExecutor({ workspace: workspaceWith({}) });
    const outcome = await executor.runCode("Object.keys(tools)", {
      sessionId: "s1",
      sessionNamespace: "agent",
      prelude: true,
      tools: STUB_TOOLS,
      surface: ["read_file", "archmax_workflow_enrich-order"],
    });
    executor.dispose("s1");
    expect(outcome.ok, outcome.error?.message).toBe(true);
    expect(outcome.value).toEqual(["readFile", "archmaxWorkflowEnrichOrder"]);
  });

  it("scopes an archmax_run file the same way", async () => {
    const executor = createScriptExecutor({ workspace: workspaceWith({ "/skills/x/scripts/keys.js": "Object.keys(tools)" }) });
    const outcome = await executor.runFile("skills/x/scripts/keys.js", {
      sessionId: "s2",
      sessionNamespace: "agent",
      tools: STUB_TOOLS,
      surface: ["write_file"],
    });
    executor.dispose("s2");
    expect(outcome.value).toEqual(["writeFile"]);
  });

  it("lists every injected tool without a surface, or without the prelude", async () => {
    const executor = createScriptExecutor({ workspace: workspaceWith({}) });
    const unscoped = await executor.runCode("Object.keys(tools)", {
      sessionId: "s3",
      sessionNamespace: "agent",
      prelude: true,
      tools: STUB_TOOLS,
    });
    const raw = await executor.runCode("Object.keys(tools)", {
      sessionId: "s4",
      sessionNamespace: "agent",
      tools: STUB_TOOLS,
      surface: ["read_file"],
    });
    executor.dispose("s3");
    executor.dispose("s4");
    expect(unscoped.value).toEqual(["readFile", "writeFile", "archmaxWorkflowEnrichOrder"]);
    expect(raw.value).toEqual(["readFile", "writeFile", "archmaxWorkflowEnrichOrder"]);
  });

  it("calls a tool by its own name as well as by its camelCase key, and lists only the key", async () => {
    const executor = createScriptExecutor({ workspace: workspaceWith({}) });
    const outcome = await executor.runCode(
      [
        "const own = await tools.read_file({});",
        'const kebab = await tools["archmax_workflow_enrich-order"]({});',
        "const camel = await tools.readFile({});",
        '[own, kebab, camel, "read_file" in tools, "write_file" in tools, Object.keys(tools)]',
      ].join("\n"),
      {
        sessionId: "s6",
        sessionNamespace: "agent",
        prelude: true,
        tools: STUB_TOOLS,
        surface: ["read_file", "archmax_workflow_enrich-order"],
      },
    );
    executor.dispose("s6");
    expect(outcome.ok, outcome.error?.message).toBe(true);
    expect(outcome.value).toEqual([
      "read_file:done",
      "archmax_workflow_enrich-order:done",
      "read_file:done",
      true,
      false,
      ["readFile", "archmaxWorkflowEnrichOrder"],
    ]);
  });

  it("calls a tool with no input as with an empty one, and keeps each tool's identity", async () => {
    const executor = createScriptExecutor({ workspace: workspaceWith({}) });
    const outcome = await executor.runCode("[await tools.read_file(), tools.read_file === tools.readFile]", {
      sessionId: "s6b",
      sessionNamespace: "agent",
      prelude: true,
      tools: STUB_TOOLS,
      surface: ["read_file"],
    });
    executor.dispose("s6b");
    expect(outcome.ok, outcome.error?.message).toBe(true);
    expect(outcome.value).toEqual(["read_file:done", true]);
  });

  it("leaves a tool outside the surface undefined, and typeof, in and Object.keys agree", async () => {
    // The view is the surface: a name outside it is unreachable however it is
    // spelled or asked about. The kernel still decides every call that is made,
    // so the two gates stay independent.
    const executor = createScriptExecutor({ workspace: workspaceWith({}) });
    const outcome = await executor.runCode(
      [
        "[",
        "  typeof tools.write_file, typeof tools.writeFile, tools.write_file === undefined,",
        '  "write_file" in tools, "writeFile" in tools, Object.keys(tools).includes("writeFile"),',
        '  Object.getOwnPropertyDescriptor(tools, "write_file") === undefined,',
        "  typeof tools.no_such_tool,",
        "]",
      ].join("\n"),
      {
        sessionId: "s7",
        sessionNamespace: "agent",
        prelude: true,
        tools: STUB_TOOLS,
        surface: ["read_file"],
      },
    );
    executor.dispose("s7");
    expect(outcome.ok, outcome.error?.message).toBe(true);
    expect(outcome.value).toEqual(["undefined", "undefined", true, false, false, false, true, "undefined"]);
  });

  it("scopes a code state's tools to its surface the same way", async () => {
    const { outcome } = await runCodeState(
      `console.log(JSON.stringify([Object.keys(tools), typeof tools.write_file, "write_file" in tools, typeof tools.read_file]));`,
      {},
      ["archmax_advance", "read_file"],
    );
    expect(outcome.ok, outcome.error?.message).toBe(true);
    expect(JSON.parse(outcome.logs[0]!)).toEqual([["archmaxAdvance", "readFile"], "undefined", false, "function"]);
  });
});

describe("createScriptExecutor.runFile", () => {
  it("reports a clear error when the script is not served by the backend", async () => {
    const executor = createScriptExecutor({ workspace: workspaceWith({}) });
    const outcome = await executor.runFile("scripts/missing.js", {
      sessionId: "t1",
      sessionNamespace: "agent",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.message).toContain("scripts/missing.js");
  });

  it("reads and evaluates a script sourced from the backend, with its args", async () => {
    const executor = createScriptExecutor({
      workspace: workspaceWith({ "/scripts/add.js": "args.a + args.b + args.variables.c" }),
    });
    const outcome = await executor.runFile("scripts/add.js", {
      sessionId: "t2",
      sessionNamespace: "agent",
      args: { a: 40, b: 1, variables: { c: 1 } },
    });
    executor.dispose("t2");
    expect(outcome.ok).toBe(true);
    expect(outcome.value).toBe(42);
  });

  it("routes execution through a custom sandbox runtime, with namespaced disposal and quotas", async () => {
    const evals: { namespace: string; code: string }[] = [];
    const disposed: string[] = [];
    let seenQuotas: unknown;
    const stub: SandboxRuntime = {
      session(namespace, options) {
        seenQuotas = options.quotas;
        return {
          async eval(code: string) {
            evals.push({ namespace, code });
            return { ok: true, value: "from-stub", logs: [], formatted: "from-stub" };
          },
        };
      },
      dispose(namespace) {
        disposed.push(namespace);
      },
    };

    const executor = createScriptExecutor({
      workspace: workspaceWith({ "/scripts/x.js": "1 + 1" }),
      maxResultChars: 4096,
      sandboxRuntime: stub,
    });
    const outcome = await executor.runFile("scripts/x.js", { sessionId: "t3", sessionNamespace: "agent" });
    executor.dispose("t3", "agent");

    expect(outcome.value).toBe("from-stub");
    expect(evals[0]?.namespace).toBe("t3:agent");
    expect(evals[0]?.code).toContain("1 + 1");
    expect(seenQuotas).toMatchObject({ maxResultChars: 4096 });
    expect(disposed).toEqual(["t3:agent"]);
  });
});

describe("createScriptExecutor.runCodeState", () => {
  it("calls the default-export function with the state's input, its tools included", async () => {
    const { outcome, advances } = await runCodeState(
      `/** Screens the request. */
import { defineCodeState } from "@archmax-ai/harness/sandbox";
export default async function screen({ state, trigger, variables, messages, trail, tools }) {
  const ok = variables.flag === true && messages.length === 1 && trail.length === 2;
  await tools.archmax_advance({ to: ok ? "next" : "decline", reason: \`\${state} via \${trigger}\` });
}`,
      {
        state: "screen-request",
        trigger: "manual",
        variables: { flag: true },
        messages: [{ role: "user", text: "hi" }],
        trail: [{ kind: "trigger" }, { kind: "agent" }],
      },
    );
    expect(outcome.ok, outcome.error?.message).toBe(true);
    expect(advances).toEqual([{ to: "next", reason: "screen-request via manual" }]);
  });

  it("accepts defineCodeState as an alias for export default, and both spellings of a tool", async () => {
    const { outcome, advances } = await runCodeState(
      `import { defineCodeState } from "@archmax-ai/harness/sandbox";
export default defineCodeState(async ({ tools }) => {
  await tools.archmax_advance({ to: "a", reason: "own name" });
  await tools.archmaxAdvance({ to: "b", reason: "camelCase key" });
});`,
    );
    expect(outcome.ok, outcome.error?.message).toBe(true);
    expect(advances).toEqual([
      { to: "a", reason: "own name" },
      { to: "b", reason: "camelCase key" },
    ]);
  });

  it("runs a bare-body script, its input the global args", async () => {
    const { outcome, advances } = await runCodeState(
      `/** Bare body. */\nawait tools.archmax_advance({ to: "next", reason: args.state + ":" + args.variables.n });`,
      { state: "check-refund", variables: { n: 3 } },
    );
    expect(outcome.ok, outcome.error?.message).toBe(true);
    expect(advances).toEqual([{ to: "next", reason: "check-refund:3" }]);
  });

  it("does not read the return value: a code state moves only through its tools", async () => {
    for (const src of [
      `export default () => ({ verdict: "veto", reason: "a verdict is just a value now" });`,
      `export default () => false;`,
      `/** Bare body. */\nconst orders = [1];\norders.length;`,
    ]) {
      const { outcome, advances } = await runCodeState(src);
      expect(outcome.ok, src).toBe(true);
      expect(outcome.value, src).toBeUndefined();
      expect(advances, src).toEqual([]);
    }
  });

  it("captures what the script logs", async () => {
    const { outcome } = await runCodeState(`export default () => { console.log("checked"); };`);
    expect(outcome.logs).toEqual(["checked"]);
  });

  it("runs under the code contract, with no hook vocabulary", async () => {
    const { outcome } = await runCodeState(
      `console.log(JSON.stringify([SANDBOX_CONTRACT.context, SANDBOX_CONTRACT.version, typeof defineCodeState, typeof veto, typeof ok, typeof defineHook, typeof t]));`,
    );
    expect(outcome.ok, outcome.error?.message).toBe(true);
    expect(JSON.parse(outcome.logs[0]!)).toEqual([
      "code",
      3,
      "function",
      "undefined",
      "undefined",
      "undefined",
      "undefined",
    ]);
  });

  it("fails when the script throws", async () => {
    const { outcome } = await runCodeState(`export default () => { throw new Error("script exploded"); };`);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.message).toContain("script exploded");
  });

  it("fails closed on a foreign import, before anything runs", async () => {
    const { outcome, advances } = await runCodeState(
      `import fs from "node:fs";\nawait tools.archmax_advance({ to: "next", reason: "x" });`,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.message).toContain("node:fs");
    expect(outcome.error?.message).toContain("@archmax-ai/harness/*");
    expect(advances).toEqual([]);
  });

  it("fails closed on a source that does not parse", async () => {
    const { outcome } = await runCodeState(`export default async function ( {`);
    expect(outcome.ok).toBe(false);
  });

  it("reports a clear error when the script is not served by the backend", async () => {
    const executor = createScriptExecutor({ workspace: workspaceWith({}) });
    const outcome = await executor.runCodeState("workflows/order-lookup/scripts/missing.js", {
      sessionId: "c1",
      args: {},
      tools: [],
      surface: [],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.message).toContain("workflows/order-lookup/scripts/missing.js");
  });

  it("runs each time in a fresh REPL: nothing one run defines reaches the next, or the agent's", async () => {
    const executor = createScriptExecutor({
      workspace: workspaceWith({
        "/workflows/w/scripts/set.js": `globalThis.leak = "kept";`,
        "/workflows/w/scripts/read.js": `console.log(typeof globalThis.leak, typeof globalThis.agentOwn);`,
      }),
    });
    const params = { sessionId: "c2", args: {}, tools: [], surface: [] };
    await executor.runCode(`globalThis.agentOwn = 1;`, { sessionId: "c2", sessionNamespace: "agent", prelude: true });
    const set = await executor.runCodeState("workflows/w/scripts/set.js", params);
    const read = await executor.runCodeState("workflows/w/scripts/read.js", params);
    // The agent's REPL is a namespace of its own, and a code state's run leaves it standing.
    const agent = await executor.runCode(`[typeof agentOwn, typeof leak]`, {
      sessionId: "c2",
      sessionNamespace: "agent",
      prelude: true,
    });
    executor.dispose("c2");
    expect(set.ok, set.error?.message).toBe(true);
    expect(read.logs).toEqual(["undefined undefined"]);
    expect(agent.value).toEqual(["number", "undefined"]);
  });

  it("evaluates in the code namespace, disposed before the run and again when it settles", async () => {
    const evals: { namespace: string; code: string }[] = [];
    const disposed: string[] = [];
    const stub: SandboxRuntime = {
      session(namespace) {
        return {
          async eval(code: string) {
            evals.push({ namespace, code });
            disposed.push(`eval ${namespace}`);
            return { ok: true, value: undefined, logs: [], formatted: "undefined" };
          },
        };
      },
      dispose(namespace) {
        disposed.push(namespace);
      },
    };
    const executor = createScriptExecutor({
      workspace: workspaceWith({ [`/${CODE_SCRIPT}`]: "export default () => {};" }),
      sandboxRuntime: stub,
    });
    await executor.runCodeState(CODE_SCRIPT, { sessionId: "c3", args: { state: "s" }, tools: [], surface: [] });
    const key = `c3:${CODE_SESSION}`;
    expect(evals.map((e) => e.namespace)).toEqual([key]);
    expect(evals[0]?.code).toContain('context: "code"');
    expect(evals[0]?.code).toContain('globalThis.args = {"state":"s"};');
    expect(disposed).toEqual([key, `eval ${key}`, key]);
  });
});
