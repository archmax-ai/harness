import { AsyncLocalStorage } from "node:async_hooks";
import type { BackendProtocolV2 } from "deepagents";

/**
 * What a host tool's handler is handed besides its input: the turn's
 * workspace, so a host tool resolves paths exactly as the built-in file tools
 * do instead of rebuilding the mount table beside the SDK.
 */
export interface ToolContext {
  /**
   * The turn's workspace: the host's mounts with their read-only posture and the
   * session zone at the root, bound to this session — the same instance
   * `read_file` resolves through. Besides text `read`/`write`, it carries raw
   * bytes (`downloadFiles`/`uploadFiles`) and `delete`; a read-only mount refuses
   * every write, upload and delete.
   */
  workspace: BackendProtocolV2;
}

const current = new AsyncLocalStorage<ToolContext>();

/**
 * Run `fn` with `context` as the tool context of everything it does. Bound per
 * turn, beside the session binding, by both compositions.
 */
export function runWithToolContext<T>(context: ToolContext, fn: () => Promise<T>): Promise<T> {
  return current.run(context, fn);
}

/** The tool context of the turn in progress, or `undefined` outside one. */
export function currentToolContext(): ToolContext | undefined {
  return current.getStore();
}
