import { AsyncLocalStorage } from "node:async_hooks";
import type { BackendProtocolV2 } from "deepagents";
import { mountSubtree } from "./path-mapping.js";
import { isSessionAgnosticPath } from "./zones.js";

/**
 * The session zone — the agent's workspace **root**: durable per-session
 * checkpoints, observability artifacts, the agent's `scratchpad/…` working area, the
 * always-writable `scratchpad/…`, and the runtime's context-offload areas, all
 * served by the configured session store as the default route of the workspace
 * `CompositeBackend`.
 *
 * Three calling conventions share this one root, disambiguated by path shape
 * rather than by whether a session happens to be bound:
 *
 *  - **Runtime-internal, already-qualified paths** (e.g.
 *    `<sessionId>/checkpoints/cp-1.json`, built by `sessionPaths`) — the
 *    checkpoint saver and run-artifact writers address their own session's
 *    folder explicitly. These pass through unmodified, whether or not a session
 *    happens to be bound at the time (some, like the inner Deep Agent's own
 *    checkpoint writes, run *during* a bound turn; others, like
 *    `listSessions()`, run outside any turn).
 *  - **Session-agnostic reserved paths** (`_specs/<hash>.json`) — content
 *    addressed and shared by every session on the same spec version, so they
 *    resolve at the store root even while a session is bound.
 *  - **Agent-visible, id-free paths** (e.g. `scratchpad/notes.txt`) — issued by
 *    tool calls while a session's turn is executing. The currently bound
 *    session id (see {@link sessionScoped}) is prefixed on before delegating, and
 *    stripped back off the paths results carry, so the id never appears in an
 *    agent-visible listing.
 *
 * A path is treated as "already qualified" when it (ignoring a leading `/`)
 * equals or starts with the bound session id — safe because internal callers
 * only ever address their own currently-bound session's folder, and a session id
 * may not collide with a reserved root name.
 */
export class SessionZoneRouter implements BackendProtocolV2 {
  private readonly binding = new AsyncLocalStorage<string>();
  private readonly routed: BackendProtocolV2;

  constructor(backend: BackendProtocolV2) {
    this.routed = mountSubtree(backend, () => this.binding.getStore(), {
      // Session-agnostic prefixes resolve to the run-store root whether or not a
      // session is bound: a spec snapshot is shared across sessions, and the
      // session index has to be readable before a session is chosen at all.
      passthrough: (rel, prefix) =>
        rel === prefix || rel.startsWith(`${prefix}/`) || isSessionAgnosticPath(rel),
    });
  }

  /**
   * Bind id-free run-root addressing to `sessionId` for everything `fn` does
   * (the binding propagates through async continuations, so a whole agent
   * turn — including lifecycle hooks, sandboxed scripts, and the inner
   * agent's own checkpoint writes — is covered by wrapping its `invoke`).
   * Concurrent sessions each carry their own binding.
   */
  sessionScoped<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.binding.run(sessionId, fn);
  }

  /** The session id bound to the current async context, if any. */
  boundSessionId(): string | undefined {
    return this.binding.getStore();
  }

  ls(path: string) {
    return this.routed.ls(path);
  }

  read(filePath: string, offset?: number, limit?: number) {
    return this.routed.read(filePath, offset, limit);
  }

  readRaw(filePath: string) {
    return this.routed.readRaw(filePath);
  }

  grep(pattern: string, path?: string | null, glob?: string | null) {
    return this.routed.grep(pattern, path, glob);
  }

  glob(pattern: string, path?: string) {
    return this.routed.glob(pattern, path);
  }

  write(filePath: string, content: string) {
    return this.routed.write(filePath, content);
  }

  edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean) {
    return this.routed.edit(filePath, oldString, newString, replaceAll);
  }
}
