import type { StructuredTool } from "@langchain/core/tools";
import { transformForEval } from "@langchain/quickjs";
import type { Workspace } from "../core/workspace.js";
import { normalizeRelPath } from "../core/workspace.js";
import { readPrelude } from "./prelude.js";
import { prepareHookSource } from "./imports.js";
import { DEFAULT_SANDBOX_VERSION, type SandboxContext } from "../runtime/contract.js";
import { createQuickJsSandboxRuntime, type SandboxRuntime } from "./runtime.js";

/**
 * Sandboxed execution for the two sandbox tools (`archmax_eval`, `archmax_run`)
 * and for lifecycle hooks.
 *
 * Script *sources* are read through the {@link Workspace} backend (not the
 * local filesystem), so scripts work against whatever Deep Agents backend the
 * runtime is configured with. Inline code and an authored file evaluate in the
 * same REPL session for a scope and under the same PTC contract — the only
 * difference is where the source came from.
 */

const DEFAULT_TIMEOUT_MS = 5_000;
export const AGENT_SESSION = "agent";
export const PROCESS_SESSION = "process";

export interface ScriptRunParams {
  sessionId: string;
  sessionNamespace: string;
  args?: Record<string, unknown>;
  tools?: StructuredTool[];
  /** Run as a lifecycle hook: the hook prelude, the hook input, a verdict back. */
  lifecycle?: boolean;
  /**
   * `runCode` only: prepend the context's prelude, so inline code runs under
   * the same contract as an authored file. The agent's `archmax_eval` sets it;
   * bespoke callers that assemble their own preamble leave it off.
   */
  prelude?: boolean;
}

export interface ScriptOutcome {
  ok: boolean;
  value: unknown;
  logs: string[];
  error?: { name?: string; message?: string };
  formatted: string;
}

export interface ScriptExecutor {
  runFile(filePath: string, params: ScriptRunParams): Promise<ScriptOutcome>;
  runCode(code: string, params: ScriptRunParams): Promise<ScriptOutcome>;
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

/** Lifecycle hooks get the hook contract; everything else the PTC contract. */
function sandboxContext(params: ScriptRunParams): SandboxContext {
  return params.lifecycle ? "lifecycle-hook" : "ptc";
}

const argsAssignment = (args: Record<string, unknown> | undefined) =>
  `globalThis.args = ${JSON.stringify(args ?? {})};`;

/**
 * The code a lifecycle hook runs as. The hook body is evaluated as its own
 * async IIFE (`transformForEval`) so its completion value can be read — a
 * bare-body hook may end in `veto("…")` — and a registered `export default`
 * function is then called with the hook input: the arguments plus `tools`.
 * Whatever came back is reduced to a verdict by the prelude.
 */
function buildHookCode(prepared: string, filePath: string, prelude: string, args?: Record<string, unknown>): string {
  return [
    prelude,
    "globalThis.__hookDef = undefined;",
    argsAssignment(args),
    `globalThis.__scriptPath = ${JSON.stringify(normalizeRelPath(filePath))};`,
    `globalThis.__hookBody = await ${transformForEval(prepared)};`,
    "globalThis.__hookVerdict(",
    "  typeof globalThis.__hookDef === \"function\"",
    "    ? await globalThis.__hookDef(Object.assign({}, globalThis.args, {",
    "        tools: typeof tools === \"undefined\" ? undefined : tools,",
    "      }))",
    "    : globalThis.__hookBody,",
    ");",
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
    return session.eval(code, timeoutMs);
  }

  async function runHook(source: string, filePath: string, params: ScriptRunParams): Promise<ScriptOutcome> {
    // Typed `@archmax-ai/harness/*` imports are stripped (the prelude provides the
    // globals) and `export default` becomes the hook registration; any other
    // import — or a source that does not parse — fails closed here, host-side.
    let code: string;
    try {
      const prelude = readPrelude("lifecycle-hook", sandboxVersion);
      code = buildHookCode(prepareHookSource(source, { file: filePath }), filePath, prelude, params.args);
    } catch (err) {
      return errorOutcome((err as Error).message);
    }
    return evalCode(code, params);
  }

  return {
    async runFile(filePath, params) {
      const source = await workspace.readText(filePath);
      if (source == null) return errorOutcome(`cannot read script '${filePath}' from the agent workspace.`);
      if (params.lifecycle) return runHook(source, filePath, params);

      const prelude = readPrelude(sandboxContext(params), sandboxVersion);
      const code = [
        prelude,
        argsAssignment(params.args),
        `globalThis.__scriptPath = ${JSON.stringify(normalizeRelPath(filePath))};`,
        source,
      ].join("\n");
      return evalCode(code, params);
    },

    runCode(code, params) {
      if (!params.prelude) return evalCode(code, params);
      // Same contract as an authored file: the PTC prelude runs first so inline
      // code sees the same `SANDBOX_CONTRACT` marker and the same absence of
      // the hook-only vocabulary.
      return evalCode(`${readPrelude(sandboxContext(params), sandboxVersion)}\n${code}`, params);
    },

    dispose(sessionId, sessionNamespace) {
      if (sessionNamespace) {
        runtime.dispose(sessionKey(sessionId, sessionNamespace));
        return;
      }
      for (const ns of [AGENT_SESSION, PROCESS_SESSION]) {
        runtime.dispose(sessionKey(sessionId, ns));
      }
    },
  };
}
