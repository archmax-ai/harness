import type { StructuredTool } from "@langchain/core/tools";
import { createMiddleware, tool } from "langchain";
import type { AgentMiddleware } from "langchain";
import { z } from "zod";
import {
  asModelCallResult,
  type AnyModelCallHandler,
  type AnyModelCallRequest,
  type AnyToolCallHandler,
  type AnyToolCallRequest,
} from "../core/deepagents.js";
import { EVAL_TOOL, RUN_TOOL } from "../machine/tool-names.js";
import { PTC_EXCLUDED_TOOLS } from "../kernel/kernel.js";
import type { PtcToolGateway } from "./ptc-gateway.js";
import { AGENT_SESSION, type ScriptExecutor } from "./executor.js";
import { DEFAULT_SESSION_ID, releaseScopes, sessionScopeFrom } from "../sessions/scope.js";
import { readVariables } from "../workflow/state.js";

/**
 * The two sandbox tools — `archmax_eval` (inline code) and `archmax_run` (an
 * authored script file) — plus the middleware that scopes their PTC tools,
 * snapshots the session's variables for `archmax_run`, and tears down REPL
 * sessions per scope. Both evaluate in the *same* REPL session for a run scope,
 * so a helper defined by one is in scope for the other.
 */
export interface Interpreter {
  middleware: AgentMiddleware;
  tools: StructuredTool[];
  executor: ScriptExecutor;
  /**
   * Release the resources held for a session: the cached PTC tool sets and the
   * agent REPL sessions of the session's own run scope **and of every sub-run
   * scope nested beneath it**. Idempotent; safe after aborted runs.
   */
  dispose(sessionId: string): void;
}

/** Pick PTC tools from the agent's full tool set. Empty `names` = all except {@link PTC_EXCLUDED_TOOLS}. */
export function resolvePtcTools(allTools: unknown[], names: string[]): StructuredTool[] {
  const tools = allTools as StructuredTool[];
  if (names.length === 0) {
    return tools.filter((t) => !PTC_EXCLUDED_TOOLS.has(t.name));
  }
  const byName = new Map(tools.map((t) => [t.name, t]));
  // Governance-owned exclusions hold even for an explicit allow-list: scripts
  // may never call the runtime's controls (both sandbox entry points among them)
  // through PTC.
  return names
    .map((n) => byName.get(n))
    .filter((t): t is StructuredTool => t !== undefined && !PTC_EXCLUDED_TOOLS.has(t.name));
}

/** The session's variables as the flat `name → value` map a script reads. */
function flatVariables(state: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(readVariables(state)).map(([name, entry]) => [name, entry.value]));
}

export function createInterpreter(opts: {
  executor: ScriptExecutor;
  ptcNames: string[];
  /**
   * Governs and instruments the `tools.*` calls scripts make. Optional so a
   * test can assemble a bare interpreter; the runtime always supplies one, and
   * without it a script's tool calls run ungoverned.
   */
  ptcGateway?: PtcToolGateway;
}): Interpreter {
  const { executor, ptcNames, ptcGateway } = opts;
  // Keyed by **run scope**, not session: two sub-runs of one session execute
  // concurrently and must not share a REPL or each other's PTC tool set. At the
  // top level the scope key is the session id.
  const ptcToolsByScope = new Map<string, StructuredTool[]>();
  // The variables in force for the `archmax_run` call being serviced, captured at
  // the tool call so the script reads the store the call was made against.
  const variablesByScope = new Map<string, Record<string, unknown>>();

  /** The PTC surface a call in this scope may use, wrapped by the gateway. */
  const scopeTools = (scope: string): StructuredTool[] => ptcToolsByScope.get(scope) ?? [];

  const evalCode = tool(
    async (input: { code: string }, runtimeConfig) => {
      const scope = sessionScopeFrom(runtimeConfig, DEFAULT_SESSION_ID).sessionId;
      const outcome = await executor.runCode(input.code, {
        sessionId: scope,
        sessionNamespace: AGENT_SESSION,
        tools: scopeTools(scope),
        prelude: true,
      });
      return outcome.formatted;
    },
    {
      name: EVAL_TOOL,
      description:
        "Evaluate JavaScript in a sandboxed REPL with persistent state across calls, " +
        "console capture, and `tools.*` for tool calls. " +
        "Prefer it over many small tool calls when work is loops, filtering, or arithmetic. " +
        "Every `tools.*` call is governed by the workflow graph exactly as a direct call is.",
      schema: z.object({
        code: z
          .string()
          .describe("JavaScript to evaluate. The last expression is returned."),
      }),
    },
  );

  const runScript = tool(
    async (input: { file_path: string; args?: Record<string, unknown> }, runtimeConfig) => {
      const scope = sessionScopeFrom(runtimeConfig, DEFAULT_SESSION_ID).sessionId;
      const outcome = await executor.runFile(input.file_path, {
        sessionId: scope,
        sessionNamespace: AGENT_SESSION,
        // The script's `args`: what the model passed, plus the session's
        // variables by name — a script reads the run's input without the model
        // having to retype it.
        args: { ...(input.args ?? {}), variables: variablesByScope.get(scope) ?? {} },
        tools: scopeTools(scope),
      });
      return outcome.formatted;
    },
    {
      name: RUN_TOOL,
      description:
        "Run an authored workspace JavaScript file in the same sandboxed REPL as " +
        `\`${EVAL_TOOL}\`, with \`tools.*\` for tool calls. The script reads its input as the ` +
        "global `args`: the arguments you pass plus `args.variables`, the session's variables " +
        "by name. Which files may run is enforced by the workflow graph.",
      schema: z.object({
        file_path: z
          .string()
          .describe("Workspace-relative path, e.g. skills/orders/scripts/check.js."),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Exposed to the script as global `args`, beside `args.variables`."),
      }),
    },
  );

  function releaseScope(scope: string): void {
    ptcToolsByScope.delete(scope);
    variablesByScope.delete(scope);
    ptcGateway?.release(scope);
    executor.dispose(scope, AGENT_SESSION);
  }

  function dispose(sessionId: string): void {
    // A session's scopes are its own plus every sub-run's, so disposal sweeps by
    // prefix. The executor is told about each one: a REPL leaked per dispatch
    // would outlive the run that opened it.
    const released = releaseScopes(ptcToolsByScope, sessionId);
    releaseScopes(variablesByScope, sessionId);
    if (!released.includes(sessionId)) released.push(sessionId);
    for (const scope of released) releaseScope(scope);
  }

  const middleware = createMiddleware({
    name: "ScriptInterpreter",
    // A middleware's hooks see the agent state parsed through *its own* schema,
    // so without declaring `variables` here the snapshot below would read an
    // empty store. Declared read-only in shape: the workflow middleware owns
    // the channel and its reducer (the first declaration of a key wins).
    stateSchema: z.object({
      variables: z
        .record(z.string(), z.object({ value: z.unknown(), locked: z.boolean() }).passthrough())
        .optional(),
    }),
    wrapModelCall: async (request: AnyModelCallRequest, handler: AnyModelCallHandler) => {
      const scope = sessionScopeFrom(request.runtime, DEFAULT_SESSION_ID).sessionId;
      // Selection stays pure (which tools a script may see); the gateway adds
      // enforcement (what each call may do), which it decides per call against
      // the scope's live context rather than at this capture point.
      const selected = resolvePtcTools(request.tools ?? [], ptcNames);
      ptcToolsByScope.set(
        scope,
        ptcGateway ? ptcGateway.wrap(selected, { origin: "script", sessionId: scope }) : selected,
      );
      // Narrowed like the workflow middleware: whichever is innermost is named
      // when the model handler returns something outside the contract.
      return asModelCallResult(await handler(request), "the script interpreter");
    },
    wrapToolCall: async (request: AnyToolCallRequest, handler: AnyToolCallHandler) => {
      if (request.toolCall.name === RUN_TOOL) {
        const scope = sessionScopeFrom(request.runtime, DEFAULT_SESSION_ID).sessionId;
        variablesByScope.set(scope, flatVariables(request.state));
      }
      return handler(request);
    },
    afterAgent: async (state, runtime) => {
      // Released at the scope this agent ran in, not the session: a sub-run
      // finishing must not tear down its parent's REPL, which is still mid-run.
      releaseScope(sessionScopeFrom(runtime, DEFAULT_SESSION_ID).sessionId);
      return state;
    },
  });

  return {
    middleware,
    tools: [evalCode, runScript] as unknown as StructuredTool[],
    executor,
    dispose,
  };
}
