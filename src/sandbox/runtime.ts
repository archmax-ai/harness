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
  /**
   * Evaluate `code`. `signal` is the turn's: once it aborts, the evaluation
   * settles with an error rather than at its timeout, and a host call the
   * script makes from then on is refused before it reaches the tool.
   */
  eval(code: string, timeoutMs?: number, signal?: AbortSignal): Promise<SandboxEvalResult>;
}

export interface SandboxRuntime {
  /** Get or create the session for a namespace, applying the given options. */
  session(namespace: string, options: SandboxSessionOptions): SandboxSession;
  /**
   * Release the session for a namespace (idempotent). Safe while a script's host
   * call is still pending: the next `session` for the namespace starts afresh,
   * and the released one is freed once nothing running can write into it.
   */
  dispose(namespace: string): void;
}

const DEFAULT_SUBAGENT_CONCURRENCY = 32;
/** Fallback per-eval timeout when a caller omits one (mirrors the executor default). */
const DEFAULT_TIMEOUT_MS = 5_000;
/** How long a released REPL is kept past its last eval's deadline before it is freed regardless. */
const RELEASE_GRACE_MS = 1_000;

/** Why a script was stopped, or its host call refused: the turn's signal aborted. */
const TURN_ABORTED = "the turn was aborted";
/** Why a host call was refused: the REPL it was made from was disposed. */
const SESSION_RELEASED = "the sandbox session was disposed";

/**
 * One REPL and what is still running in it. A host call made from a script
 * settles by writing its result into the REPL's context, so disposal releases
 * the lease rather than freeing the REPL outright: the context is freed once no
 * call is pending and no eval is polling it. Freeing it under either is what
 * `@langchain/quickjs` cannot survive — QuickJS asserts on the live promise, and
 * the late settle throws where no caller can catch it.
 */
interface Lease {
  repl: ReplSession;
  /** The `task()` dispatch in force, refreshed at every acquisition. */
  dispatch?: SubagentBridgeOptions["dispatch"];
  /** The signal of the turn whose eval ran last: a call made from the REPL stops with it. */
  turn?: AbortSignal;
  /** Aborted at disposal: no call starts from then on, and a pending one is abandoned. */
  released: AbortController;
  freed: boolean;
  /** Host calls made from the REPL that have not settled. */
  calls: number;
  /** Evals of the REPL that have not returned. */
  evals: number;
  /** The latest deadline of an eval started in the REPL. */
  deadline: number;
  backstop?: ReturnType<typeof setTimeout>;
}

/** Why a call from this lease may not run now, if it may not. */
function stopReason(lease: Lease): string | undefined {
  if (lease.released.signal.aborted) return SESSION_RELEASED;
  if (lease.turn?.aborted) return TURN_ABORTED;
  return undefined;
}

function free(lease: Lease): void {
  if (lease.freed) return;
  lease.freed = true;
  clearTimeout(lease.backstop);
  lease.repl.dispose();
}

/**
 * Free a released lease once it is idle. On a later macrotask, not now: the
 * bridge writes a settled call into the context, and runs the script's next
 * jobs, in the microtasks that follow the settle.
 */
function freeWhenIdle(lease: Lease): void {
  if (!lease.released.signal.aborted || lease.freed || lease.calls > 0 || lease.evals > 0) return;
  setImmediate(() => {
    if (lease.calls === 0 && lease.evals === 0) free(lease);
  });
}

/**
 * Run one host call made from the lease's REPL. Refused once the turn has
 * aborted or the REPL was released, and abandoned — rejected without waiting
 * for the tool — when either happens while it runs, so the script resumes
 * promptly and the call settles into a context that is still alive. A call
 * that would settle after the REPL was freed never settles: the bridge would
 * write it into freed memory.
 */
function guardCall<T>(lease: Lease, call: () => Promise<T>): Promise<T> {
  if (lease.freed) return new Promise<T>(() => {});
  const refused = stopReason(lease);
  if (refused) return Promise.reject(new Error(refused));

  lease.calls += 1;
  const sources = lease.turn ? [lease.released.signal, lease.turn] : [lease.released.signal];
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      for (const source of sources) source.removeEventListener("abort", onAbort);
      lease.calls -= 1;
      if (!lease.freed) settle();
      freeWhenIdle(lease);
    };
    const onAbort = () => finish(() => reject(new Error(stopReason(lease) ?? TURN_ABORTED)));
    for (const source of sources) source.addEventListener("abort", onAbort, { once: true });

    let pending: Promise<T>;
    try {
      pending = Promise.resolve(call());
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.then(
      (value) => finish(() => resolve(value)),
      (err) => finish(() => reject(err)),
    );
  });
}

/** A drop-in for `tool` whose calls run under {@link guardCall}. */
function guardTool(lease: Lease, tool: StructuredTool): StructuredTool {
  const invoke = (input: unknown, config?: unknown) =>
    guardCall(lease, () => tool.invoke(input as never, config as never));
  // A Proxy, as the PTC gateway's: the bridge reads `name`, and nothing else changes.
  return new Proxy(tool, {
    get(target, prop) {
      if (prop === "invoke") return invoke;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The result an eval stopped host-side settles with, rendered as the REPL renders an error. */
function stoppedResult(message: string): SandboxEvalResult {
  const error = { name: "AbortError", message };
  return {
    ok: false,
    value: undefined,
    logs: [],
    error,
    formatted: formatReplResult({ ok: false, error, logs: [], logsDroppedChars: 0 }),
  };
}

/**
 * `running`, or the stopped result as soon as `signal` aborts, whichever comes
 * first. A rejection after the abort settled the call lands on a handler.
 */
function untilAborted(
  running: Promise<SandboxEvalResult>,
  signal: AbortSignal,
): Promise<SandboxEvalResult> {
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(stoppedResult(TURN_ABORTED));
    signal.addEventListener("abort", onAbort, { once: true });
    running.finally(() => signal.removeEventListener("abort", onAbort)).then(resolve, reject);
  });
}

/**
 * The bundled default: `@langchain/quickjs`'s `ReplSession` behind the
 * interface. Sessions are keyed by namespace and reused across evals (the
 * runtime namespaces per session + session kind), and `formatReplResult`
 * renders the outcome so the executor stays engine-agnostic.
 *
 * Each REPL is held as a {@link Lease} in this runtime's own map, never in
 * `ReplSession`'s process-wide one, so a namespace disposed while a call is
 * pending can start afresh while the released REPL waits to be freed.
 */
export function createQuickJsSandboxRuntime(): SandboxRuntime {
  const leases = new Map<string, Lease>();

  function acquire(namespace: string, options: SandboxSessionOptions): Lease {
    const existing = leases.get(namespace);
    if (existing) {
      // A reused session picks up the current request's `task()` wiring.
      if (options.subagentDispatch) existing.dispatch = options.subagentDispatch;
      return existing;
    }
    const lease = {
      dispatch: options.subagentDispatch,
      released: new AbortController(),
      freed: false,
      calls: 0,
      evals: 0,
      deadline: 0,
    } as Lease;
    const dispatch: SubagentBridgeOptions["dispatch"] = (input) =>
      guardCall(lease, () => lease.dispatch!(input));
    lease.repl = new ReplSession(namespace, {
      // The REPL keeps the tools it is first handed, so they are guarded once, here.
      tools: (options.tools ?? []).map((tool) => guardTool(lease, tool)),
      memoryLimitBytes: options.quotas?.memoryLimitBytes,
      maxPtcCalls: options.quotas?.maxPtcCalls,
      maxResultChars: options.quotas?.maxResultChars,
      captureConsole: options.captureConsole ?? true,
      sessionId: options.sessionId,
      subagentBridge: options.subagentDispatch
        ? {
            dispatch,
            maxConcurrency: options.subagentMaxConcurrency ?? DEFAULT_SUBAGENT_CONCURRENCY,
          }
        : undefined,
    });
    leases.set(namespace, lease);
    return lease;
  }

  return {
    session(namespace: string, options: SandboxSessionOptions): SandboxSession {
      const lease = acquire(namespace, options);
      return {
        async eval(code: string, timeoutMs?: number, signal?: AbortSignal) {
          if (lease.released.signal.aborted) return stoppedResult(SESSION_RELEASED);
          if (signal?.aborted) return stoppedResult(TURN_ABORTED);
          const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
          lease.turn = signal;
          lease.evals += 1;
          lease.deadline = Math.max(lease.deadline, Date.now() + timeout);
          const running = lease.repl
            .eval(code, timeout)
            .then((result) => ({
              ok: result.ok,
              value: result.value,
              logs: result.logs,
              error: result.error,
              formatted: formatReplResult(result),
            }))
            .finally(() => {
              lease.evals -= 1;
              freeWhenIdle(lease);
            });
          return signal ? untilAborted(running, signal) : running;
        },
      };
    },

    dispose(namespace: string): void {
      const lease = leases.get(namespace);
      if (!lease) return;
      leases.delete(namespace);
      lease.released.abort();
      // Pending calls were just abandoned and an eval returns by its deadline, so
      // the lease goes idle on its own. The backstop bounds what neither covers;
      // freeing under a running eval leaks that REPL rather than crashing.
      lease.backstop = setTimeout(
        () => free(lease),
        Math.max(0, lease.deadline - Date.now()) + RELEASE_GRACE_MS,
      );
      lease.backstop.unref?.();
      freeWhenIdle(lease);
    },
  };
}
