/**
 * The session-id vocabulary: what makes an id able to own a session folder, and
 * the error an id that cannot is refused with. Pure — it depends on nothing but
 * the root-namespace classifier — so a browser-side host can refuse a bad id
 * with the same words the runtime uses, before it reaches a store. The stores
 * themselves live in `session-store.ts`.
 */
import { isReservedRootName, type MountPrefixes } from "./zones.js";

/**
 * Directory name of the zero-config filesystem session store
 * (`<workspace>/sessions`, one folder per session inside it). Physical detail
 * only: it appears in no SDK-visible or agent-visible path.
 */
export const DEFAULT_SESSIONS_DIR = "sessions";

/**
 * Thrown when a `sessionId` cannot own a session folder: it would address storage
 * outside the session zone (absolute or `..` traversal), or it collides with a name
 * reserved at the workspace root. The latter matters because session state is
 * addressed as `<sessionId>/…` at the root — a session called `skills` would route
 * its own checkpoints into the authored `skills/` mount. Deletion is also the
 * one session operation that touches real `node:fs` directly (bypassing the
 * backend's virtual mode), so it must contain its target itself.
 */
export class SessionStoreIdError extends Error {
  constructor(
    readonly sessionId: string,
    reason = "it must stay within the session zone (no absolute paths or '..' traversal)",
  ) {
    super(`Invalid session id ${JSON.stringify(sessionId)}: ${reason}.`);
    this.name = "SessionStoreIdError";
  }
}

/** Strip leading slashes to the store-relative form. */
export function storeRelativeSessionId(sessionId: string): string {
  return String(sessionId).replace(/^\/+/, "");
}

/**
 * Why a session id cannot own a session folder, or `null` when it can: non-empty
 * once leading slashes are stripped, free of `..` traversal segments, and with a
 * first segment that is not reserved at the workspace root. Exposed so
 * untrusted-id ingress points (the CLI, `invoke`, session handles, a host's own
 * API) can reject a bad id up front with their own message, rather than relying
 * on a store throwing deep inside a delete.
 */
export function sessionIdRejection(
  sessionId: string,
  mountPrefixes?: MountPrefixes,
): string | null {
  const relative = storeRelativeSessionId(sessionId);
  const segments = relative.split(/[\\/]+/);
  if (relative === "") return "it must not be empty";
  if (segments.some((segment) => segment === "..")) {
    return "it must stay within the session zone (no absolute paths or '..' traversal)";
  }
  // Session areas are the framework's own namespace, so they are always reserved.
  // Mount names are workspace shape: reserved once the caller supplies the
  // resolved mount keys (assembly does). Without it a colliding authored name
  // still fails safely — the read-only mount refuses the write.
  if (isReservedRootName(segments[0], mountPrefixes)) {
    return `'${segments[0]}' is reserved at the workspace root (a session area or an authored mount)`;
  }
  return null;
}
