import { AsyncLocalStorage } from "node:async_hooks";
import type { BackendProtocolV2 } from "deepagents";

/**
 * What a host tool's handler is handed besides its input: the turn's
 * workspace, so a host tool resolves paths exactly as the built-in file tools
 * do instead of rebuilding the mount table beside the SDK, and the id of the
 * session the call is made in, so a host that keeps a session's files in its
 * own store addresses the same folder.
 */
export interface ToolContext {
  /**
   * The turn's workspace: the host's mounts with their read-only posture and the
   * session zone at the root, bound to this session — the same instance
   * `read_file` resolves through. Besides text `read`/`write`, it carries raw
   * bytes and `delete`, each optional in the protocol and degrading rather than
   * throwing: `downloadFiles` always (through `readRaw` where a store has no raw
   * channel), `uploadFiles` when the session store has it, `delete` answering an
   * error where a store cannot. A read-only mount refuses every write, upload
   * and delete. Outside a turn, reading it throws; the property is
   * non-enumerable there.
   */
  workspace: BackendProtocolV2;
  /**
   * The id of the session the call is made in: inside a sub-workflow's child,
   * the child's own id (`<parent>~<n>`), never the session the host sent the
   * turn to. The session's agent-visible files are stored under
   * `<sessionId>/` in the session store, the address `workspace` resolves
   * `scratchpad/…` to. Outside a turn, reading it throws, like `workspace`.
   */
  sessionId: string;
}

const current = new AsyncLocalStorage<ToolContext>();

/**
 * Run `fn` with `context` as the tool context of everything it does. Bound per
 * turn, beside the session binding, by both compositions, so it holds for a
 * model's tool call and for a script's call through the PTC gateway alike.
 */
export function runWithToolContext<T>(context: ToolContext, fn: () => Promise<T>): Promise<T> {
  return current.run(context, fn);
}

/** The tool context of the turn in progress, or `undefined` outside one. */
export function currentToolContext(): ToolContext | undefined {
  return current.getStore();
}
