import { existsSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";
import { FilesystemBackend, StoreBackend, type BackendProtocolV2 } from "deepagents";
import { mountSubtree } from "./path-mapping.js";
import {
  DEFAULT_SESSIONS_DIR,
  SessionStoreIdError,
  sessionIdRejection,
  storeRelativeSessionId as rel,
} from "./session-id.js";

/**
 * Consumer-owned physical storage for the session zone — the agent's workspace root.
 *
 * The ownership boundary: the SDK owns the *logical* session namespace — the
 * per-session `<sessionId>/…` layout, reserved areas (`checkpoints/`,
 * `artifacts/`, `scratchpad/`, `large_tool_results/`,
 * `conversation_history/`), the session-agnostic `_specs/` prefix, session-scoped
 * path routing, and lazy creation — while the consumer owns the *physical*
 * storage: which backend, under what prefix/tenancy, how durable, and for how
 * long. A `SessionStore` is that consumer-side choice, made explicitly (or by the
 * documented zero-config default) and mounted exactly once.
 */

// The id vocabulary is pure and lives in `session-id.ts`; re-exported so the
// stores and the rule they enforce are reached from one module.
export { DEFAULT_SESSIONS_DIR, SessionStoreIdError, sessionIdRejection };

export interface SessionStoreCapabilities {
  /** Whether the store can enumerate session folders (`sessions.list()`). */
  list: boolean;
  /** Whether the store can remove a session's content (`sessions.delete()`). */
  delete: boolean;
}

export interface SessionStore {
  /** Store flavor for diagnostics and error messages. */
  kind: "filesystem" | "backend" | "memory";
  /**
   * Backend serving the session zone. The SDK wraps it in a `SessionZoneRouter`
   * (session-scoped, id-free addressing) and mounts it on the workspace
   * `CompositeBackend`; consumers never address it directly.
   */
  backend: BackendProtocolV2;
  capabilities: SessionStoreCapabilities;
  /**
   * Remove everything stored under a session's namespace. Returns whether
   * anything was removed. Throws {@link SessionStoreCapabilityError} when the
   * store cannot delete (see {@link SessionStoreCapabilities.delete}).
   */
  deleteSession(sessionId: string): Promise<boolean>;
}

/**
 * Thrown at assembly when a custom authored `backend` is supplied without an
 * explicit `sessionStore`. The runtime never silently runs without session-scoped
 * routing and never silently writes session state to local disk beside a
 * virtual workspace — the consumer must name the storage.
 */
export class SessionStoreRequiredError extends Error {
  constructor() {
    super(
      "A custom `backend` requires an explicit `sessionStore` for session state " +
        "(checkpoints, artifacts, output, scratch). Pass one of: " +
        "createFilesystemSessionStore({ dir }), createBackendSessionStore({ backend, prefix? }), " +
        "or createMemorySessionStore().",
    );
    this.name = "SessionStoreRequiredError";
  }
}

/** Thrown when a session operation needs a capability the configured store lacks. */
export class SessionStoreCapabilityError extends Error {
  constructor(
    readonly storeKind: string,
    readonly capability: keyof SessionStoreCapabilities,
  ) {
    super(
      `The configured ${storeKind} session store does not support '${capability}'. ` +
        `Provide a store with that capability (e.g. createFilesystemSessionStore) to use it.`,
    );
    this.name = "SessionStoreCapabilityError";
  }
}

/**
 * Store-relative session id with traversal and reserved names contained: strips
 * leading slashes, then rejects any id that would resolve outside its zone or
 * shadow a reserved root name. Callers pass the id straight to `rmSync`/subtree
 * deletion and to root-relative run paths, so this is the single point that keeps
 * both inside the session zone.
 */
function containedSessionId(sessionId: string): string {
  const rejection = sessionIdRejection(sessionId);
  if (rejection) throw new SessionStoreIdError(sessionId, rejection);
  return rel(sessionId);
}

/**
 * Local-directory session store: a filesystem backend rooted at `dir`, with full
 * listing and deletion capabilities. The zero-config default is this store at
 * `<workspaceRoot>/sessions`.
 */
export function createFilesystemSessionStore(options: { dir: string }): SessionStore {
  const dir = resolve(options.dir);
  return {
    kind: "filesystem",
    backend: new FilesystemBackend({ rootDir: dir, virtualMode: true }),
    capabilities: { list: true, delete: true },
    async deleteSession(sessionId: string): Promise<boolean> {
      const target = resolve(dir, containedSessionId(sessionId));
      // Belt-and-suspenders: even with `..` rejected, assert the resolved path
      // stays strictly under `dir` before touching real `fs`.
      if (target !== dir && !target.startsWith(dir + sep)) {
        throw new SessionStoreIdError(sessionId);
      }
      if (target === dir || !existsSync(target)) return false;
      rmSync(target, { recursive: true, force: true });
      return true;
    },
  };
}

/**
 * Session store over any {@link BackendProtocolV2} (object storage, database,
 * remote). The `prefix` is the consumer's tenancy/layout concern: it is
 * applied inside the store and never appears in SDK-visible or agent-visible
 * paths. Deletion is available only when the consumer supplies a
 * `deleteSession` implementation (the backend protocol models no delete);
 * listing can be disabled for backends whose `ls` cannot enumerate folders.
 */
export function createBackendSessionStore(options: {
  backend: BackendProtocolV2;
  prefix?: string;
  /** Remove `<prefix>/<sessionId>/…` from the underlying storage. */
  deleteSession?: (sessionId: string) => Promise<boolean>;
  /** Whether the backend's `ls` can enumerate session folders (default true). */
  list?: boolean;
}): SessionStore {
  const prefix = options.prefix ? rel(options.prefix).replace(/\/+$/, "") : "";
  const backend = prefix ? mountSubtree(options.backend, prefix) : options.backend;
  const capabilities: SessionStoreCapabilities = {
    list: options.list ?? true,
    delete: options.deleteSession !== undefined,
  };
  return {
    kind: "backend",
    backend,
    capabilities,
    async deleteSession(sessionId: string): Promise<boolean> {
      if (!options.deleteSession) throw new SessionStoreCapabilityError("backend", "delete");
      return options.deleteSession(sessionId);
    },
  };
}

/**
 * Ephemeral in-memory session store for tests and throwaway sessions: Deep
 * Agents' own `StoreBackend` over a LangGraph `InMemoryStore`, so nothing
 * touches the filesystem or any external service, and everything vanishes with
 * the process. Overwrites in place like every Deep Agents backend from
 * deepagents 1.12.0 on; fully listable and deletable.
 */
export function createMemorySessionStore(): SessionStore {
  const store = new InMemoryStore();
  const namespace = ["sessions"];
  const backend = new StoreBackend({ store, namespace });
  return {
    kind: "memory",
    backend,
    capabilities: { list: true, delete: true },
    async deleteSession(sessionId: string): Promise<boolean> {
      const id = containedSessionId(sessionId);
      // Collect first, then delete: the store's pagination is by offset.
      const keys: string[] = [];
      const limit = 500;
      for (let offset = 0; ; offset += limit) {
        const page = await store.search(namespace, { limit, offset });
        for (const item of page) {
          const key = String(item.key);
          if (key === `/${id}` || key.startsWith(`/${id}/`) || key === id || key.startsWith(`${id}/`)) {
            keys.push(key);
          }
        }
        if (page.length < limit) break;
      }
      await Promise.all(keys.map((key) => store.delete(namespace, key)));
      return keys.length > 0;
    },
  };
}
