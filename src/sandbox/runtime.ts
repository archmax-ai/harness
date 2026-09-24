import type { StructuredTool } from "@langchain/core/tools";
import { formatReplResult, ReplSession, type SubagentBridgeOptions } from "@langchain/quickjs";

/**
 * The pluggable script-execution backend and its bundled QuickJS default.
 *
 * Namespaced sessions with an `eval` operation and disposal: QuickJS is what
 * ships ({@link createQuickJsSandboxRuntime}); a consumer may supply another
 * implementation to run scripts in a worker or remotely alongside a remote Deep
 * Agents backend. The executor talks only to this interface.
 */

/** Resource quotas applied to a sandbox session, uniformly across implementations. */
export interface SandboxQuotas {
  memoryLimitBytes?: number;
  maxPtcCalls?: number | null;
  maxResultChars?: number;
}

/** Options for creating (or reusing) a namespaced sandbox session. */
export interface SandboxSessionOptions {
  /** Privileged tools scripts may call (PTC). */
  tools?: StructuredTool[];
  /** Quotas bounding this session's execution. */
  quotas?: SandboxQuotas;
  /** Capture `console.*` output into the eval result's `logs`. */
  captureConsole?: boolean;
  /** Session id surfaced to scripts (the run/session id). */
  sessionId?: string;
  /** Subagent bridge dispatch for `task()` calls, and its concurrency cap. */
  subagentDispatch?: SubagentBridgeOptions["dispatch"];
  subagentMaxConcurrency?: number;
}

/** The normalized result of one sandbox `eval` — the shape the executor surfaces. */
export interface SandboxEvalResult {
  ok: boolean;
  value: unknown;
  logs: string[];
  error?: { name?: string; message?: string };
  /** Human-readable rendering of the result (value or error), for tool replies. */
  formatted: string;
}

/** A namespaced sandbox session that evaluates code with a per-call timeout. */
export interface SandboxSession {
  eval(code: string, timeoutMs?: number): Promise<SandboxEvalResult>;
}

export interface SandboxRuntime {
  /** Get or create the session for a namespace, applying the given options. */
  session(namespace: string, options: SandboxSessionOptions): SandboxSession;
  /** Release the session for a namespace (idempotent). */
  dispose(namespace: string): void;
}

const DEFAULT_SUBAGENT_CONCURRENCY = 32;
/** Fallback per-eval timeout when a caller omits one (mirrors the executor default). */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * The bundled default: `@langchain/quickjs`'s `ReplSession` behind the
 * interface. Sessions are keyed by namespace and reused across evals (the
 * runtime namespaces per session + session kind), and `formatReplResult`
 * renders the outcome so the executor stays engine-agnostic.
 */
export function createQuickJsSandboxRuntime(): SandboxRuntime {
  return {
    session(namespace: string, options: SandboxSessionOptions): SandboxSession {
      const bridge =
        options.subagentDispatch != null
          ? {
              dispatch: options.subagentDispatch,
              maxConcurrency: options.subagentMaxConcurrency ?? DEFAULT_SUBAGENT_CONCURRENCY,
            }
          : undefined;

      const session = ReplSession.getOrCreate(namespace, {
        tools: options.tools ?? [],
        memoryLimitBytes: options.quotas?.memoryLimitBytes,
        maxPtcCalls: options.quotas?.maxPtcCalls,
        maxResultChars: options.quotas?.maxResultChars,
        captureConsole: options.captureConsole ?? true,
        sessionId: options.sessionId,
        subagentBridge: bridge,
      });
      // Refresh the bridge dispatch each acquisition so a reused session picks up
      // the current request's `task()` wiring.
      if (bridge) session.updateBridgeDispatch(bridge.dispatch);

      return {
        async eval(code: string, timeoutMs?: number) {
          const result = await session.eval(code, timeoutMs ?? DEFAULT_TIMEOUT_MS);
          return {
            ok: result.ok,
            value: result.value,
            logs: result.logs,
            error: result.error,
            formatted: formatReplResult(result),
          };
        },
      };
    },

    dispose(namespace: string): void {
      ReplSession.deleteSession(namespace);
    },
  };
}
