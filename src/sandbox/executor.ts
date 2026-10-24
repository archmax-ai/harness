import type { StructuredTool } from "@langchain/core/tools";
import { toCamelCase, transformForEval } from "@langchain/quickjs";
import type { Workspace } from "../core/workspace.js";
import { normalizeRelPath } from "../core/workspace.js";
import { readPrelude } from "./prelude.js";
import { prepareScriptSource } from "./imports.js";
import { TOOL_CALLS_QUERY } from "../machine/tool-names.js";
import { DEFAULT_SANDBOX_VERSION } from "../runtime/contract.js";
import { createQuickJsSandboxRuntime, type SandboxRuntime } from "./runtime.js";

/**
 * Sandboxed execution for the two sandbox tools (`archmax_eval`, `archmax_run`)
 * and for code states.
 *
 * Script *sources* are read through the {@link Workspace} backend (not the
 * local filesystem), so scripts work against whatever Deep Agents backend the
 * runtime is configured with. Inline code and an authored file evaluate in the
 * same REPL session for a scope and under the same PTC contract — the only
 * difference is where the source came from. A code state's script runs in a
 * REPL of its own, fresh per run.
 */

const DEFAULT_TIMEOUT_MS = 5_000;
/** The REPL namespace of the agent's own sandbox tools: one per session scope, kept across states. */
export const AGENT_SESSION = "agent";
/** The REPL namespace a code state's script runs in: fresh per run, disposed when it settles. */
export const CODE_SESSION = "code";

export interface ScriptRunParams {
  sessionId: string;
  sessionNamespace: string;
  args?: Record<string, unknown>;
  tools?: StructuredTool[];
  /**
   * `runCode` only: prepend the context's prelude, so inline code runs under
   * the same contract as an authored file. The agent's `archmax_eval` sets it;
   * bespoke callers that assemble their own preamble leave it off.
   */
  prelude?: boolean;
  /**
   * The tool names a script lists and reaches under `tools`: the active state's
   * surface, re-applied at the start of this evaluation. Absent, `tools` is
   * every tool the session injected (a bare executor, in a test).
   */
  surface?: readonly string[];
  /**
   * The turn's abort signal. Once it aborts, the evaluation settles with an
   * error, and a `tools.*` call the script makes is refused before the tool.
   */
  signal?: AbortSignal;
}

export interface ScriptOutcome {
  ok: boolean;
  value: unknown;
  logs: string[];
  error?: { name?: string; message?: string };
  formatted: string;
}

/** What a code state's run is given: its session, its input, its state's tools. */
export interface CodeStateRunParams {
  sessionId: string;
  /** The state's input: the default export's argument (without `tools`) and the global `args`. */
  args: Record<string, unknown>;
  /** The code state's tools, already governed. */
  tools: StructuredTool[];
  /** The names `tools` lists and reaches — the code state's surface. */
  surface: readonly string[];
  /**
   * The host function behind the script's `toolCalls(filter)`, named
   * {@link TOOL_CALLS_QUERY}: injected beside `tools`, never listed among them.
   * Absent, `toolCalls` answers with no records.
   */
  toolCalls?: StructuredTool;
  /** The turn's abort signal: once it aborts, the run settles with an error. */
  signal?: AbortSignal;
}

export interface ScriptExecutor {
  runFile(filePath: string, params: ScriptRunParams): Promise<ScriptOutcome>;
  runCode(code: string, params: ScriptRunParams): Promise<ScriptOutcome>;
  /**
   * Run a code state's script (`code` context) in a REPL of its own: fresh for
   * the run and disposed when it settles, so its injected `tools` are exactly its
   * state's and nothing it defines reaches the next run. The default export is
   * called with `args` plus `tools`; its return value is not read.
   */
  runCodeState(filePath: string, params: CodeStateRunParams): Promise<ScriptOutcome>;
  dispose(sessionId: string, sessionNamespace?: string): void;
}

export interface ScriptExecutorOptions {
  workspace: Workspace;
  timeoutMs?: number;
  memoryLimitBytes?: number;
  maxPtcCalls?: number | null;
  maxResultChars?: number;
  /** Sandbox contract version injected into each prelude (default: current). */
  sandboxVersion?: number;
  /** Script-execution backend; defaults to the bundled QuickJS runtime. */
  sandboxRuntime?: SandboxRuntime;
}

function errorOutcome(message: string): ScriptOutcome {
  return { ok: false, value: undefined, logs: [], error: { message }, formatted: `error: ${message}` };
}

const argsAssignment = (args: Record<string, unknown> | undefined) =>
  `globalThis.args = ${JSON.stringify(args ?? {})};`;

/**
 * The line that scopes `tools` to a surface, after the `ptc` prelude installed
 * the view: named the way the session keys its injected tools, so the two match,
 * plus each tool's own name mapped to that key, so a script may call either.
 */
const scopeCall = (surface: readonly string[] | undefined, tools: readonly StructuredTool[] = []): string[] =>
  surface
    ? [
        `globalThis.__archmaxScope(${JSON.stringify(surface.map((name) => toCamelCase(name)))}, ${JSON.stringify(ownNames(tools))});`,
      ]
    : [];

/** Each tool's own name → the camelCase key the session injects it under, where the two differ. */
function ownNames(tools: readonly StructuredTool[]): Record<string, string> {
  return Object.fromEntries(
    tools.map((tool) => [tool.name, toCamelCase(tool.name)]).filter(([own, key]) => own !== key),
  );
}

/**
 * The code a code state's script runs as. The body is evaluated as its own
 * async IIFE (`transformForEval`) — a bare-body script simply runs — and a
 * registered `export default` function is then called with the state's input:
 * the arguments, the `toolCalls` query and the scoped `tools`. The value is
 * `undefined` either way: a code state moves the session through its tools,
 * never through a return.
 *
 * The query is a host function injected beside the state's tools under
 * {@link TOOL_CALLS_QUERY}: taken off `tools` before the scoped view is
 * installed, so it is the script's `toolCalls` and never one of its tools.
 */
function buildCodeStateCode(
  prepared: string,
  filePath: string,
  prelude: string,
  scope: readonly string[],
  args: Record<string, unknown>,
): string {
  const query = toCamelCase(TOOL_CALLS_QUERY);
  return [
    prelude,
    `const __archmaxQuery = typeof tools !== "undefined" ? tools.${query} : undefined;`,
    "globalThis.__archmaxToolCalls = async (filter) =>",
    "  typeof __archmaxQuery === \"function\" ? JSON.parse(await __archmaxQuery(filter ?? {})) : [];",
    ...scope,
    "globalThis.__stateDef = undefined;",
    argsAssignment(args),
    "globalThis.args.toolCalls = globalThis.__archmaxToolCalls;",
    `globalThis.__scriptPath = ${JSON.stringify(normalizeRelPath(filePath))};`,
    `await ${transformForEval(prepared)};`,
    "if (typeof globalThis.__stateDef === \"function\") {",
    "  await globalThis.__stateDef(Object.assign({}, globalThis.args, { tools }));",
    "}",
    "undefined;",
  ].join("\n");
}

export function createScriptExecutor(opts: ScriptExecutorOptions): ScriptExecutor {
  const { workspace } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sandboxVersion = opts.sandboxVersion ?? DEFAULT_SANDBOX_VERSION;
  const runtime = opts.sandboxRuntime ?? createQuickJsSandboxRuntime();
  const sessionKey = (sessionId: string, ns: string) => `${sessionId}:${ns}`;

  async function evalCode(code: string, params: ScriptRunParams): Promise<ScriptOutcome> {
    const session = runtime.session(sessionKey(params.sessionId, params.sessionNamespace), {
      tools: params.tools ?? [],
      quotas: {
        memoryLimitBytes: opts.memoryLimitBytes,
        maxPtcCalls: opts.maxPtcCalls,
        maxResultChars: opts.maxResultChars,
      },
      captureConsole: true,
      sessionId: params.sessionId,
    });
    return session.eval(code, timeoutMs, params.signal);
  }

  return {
    async runFile(filePath, params) {
      const source = await workspace.readText(filePath);
      if (source == null) return errorOutcome(`cannot read script '${filePath}' from the agent workspace.`);

      const prelude = readPrelude("ptc", sandboxVersion);
      const code = [
        prelude,
        ...scopeCall(params.surface, params.tools),
        argsAssignment(params.args),
        `globalThis.__scriptPath = ${JSON.stringify(normalizeRelPath(filePath))};`,
        source,
      ].join("\n");
      return evalCode(code, params);
    },

    runCode(code, params) {
      if (!params.prelude) return evalCode(code, params);
      // Same contract as an authored file: the PTC prelude runs first so inline
      // code sees the same `SANDBOX_CONTRACT` marker, the same scoped `tools` and
      // the same absence of the code-state vocabulary.
      const preamble = [readPrelude("ptc", sandboxVersion), ...scopeCall(params.surface, params.tools)];
      return evalCode(`${preamble.join("\n")}\n${code}`, params);
    },

    async runCodeState(filePath, params) {
      const source = await workspace.readText(filePath);
      if (source == null) return errorOutcome(`cannot read script '${filePath}' from the authoring backend.`);
      // Typed `@archmax-ai/harness/*` imports are stripped (the prelude provides the
      // globals) and `export default` becomes the state's registration; any
      // other import — or a source that does not parse — fails closed here,
      // host-side, before a REPL exists.
      const tools = [...params.tools, ...(params.toolCalls ? [params.toolCalls] : [])];
      let code: string;
      try {
        code = buildCodeStateCode(
          prepareScriptSource(source, { file: filePath }),
          filePath,
          readPrelude("code", sandboxVersion),
          scopeCall(params.surface, params.tools),
          params.args,
        );
      } catch (err) {
        return errorOutcome((err as Error).message);
      }
      // Fresh per run: a REPL keeps the tools it was first handed for good, and a
      // code state's are its own state's.
      const key = sessionKey(params.sessionId, CODE_SESSION);
      runtime.dispose(key);
      try {
        return await evalCode(code, {
          sessionId: params.sessionId,
          sessionNamespace: CODE_SESSION,
          tools,
          ...(params.signal ? { signal: params.signal } : {}),
        });
      } finally {
        runtime.dispose(key);
      }
    },

    dispose(sessionId, sessionNamespace) {
      if (sessionNamespace) {
        runtime.dispose(sessionKey(sessionId, sessionNamespace));
        return;
      }
      for (const ns of [AGENT_SESSION, CODE_SESSION]) {
        runtime.dispose(sessionKey(sessionId, ns));
      }
    },
  };
}
