/**
 * `@archmax-ai/harness/sandbox` — the typed authoring surface for a code state's
 * script (`workflows/<slug>/scripts/<file>.js`). Inside the QuickJS sandbox these
 * names are provided by the prelude and the import line is stripped before
 * evaluation; importing from here buys IDE completion for the state's input,
 * nothing at runtime.
 *
 * ```js
 * import { defineCodeState } from "@archmax-ai/harness/sandbox";
 * /** Sends a refund the policy forbids back to the agent. *\/
 * export default defineCodeState(async ({ variables, tools }) => {
 *   const refund = JSON.parse(await tools.read_file({ file_path: "scratchpad/refund.json" }));
 *   if (refund.decision === "denied") {
 *     await tools.archmax_advance({ to: "refund-review", reason: "the denial matches the policy" });
 *   } else {
 *     await tools.archmax_advance({ to: "refund-request", reason: `order ${refund.orderId} is not eligible` });
 *   }
 * });
 * ```
 *
 * A code state moves the session itself: `tools.archmax_advance({ to, reason })`
 * along one of its transitions, or `tools.archmax_raise({ code, reason })` to end
 * the session as failed. Nothing the script returns is read. A non-terminal code
 * state that finishes without either call fails, as does one that throws.
 */

/** One transcript message, as plain data. `role` is `user`, `assistant`, `tool`, `system`, or `runtime`. */
export interface HistoryMessage {
  role: string;
  /** The message's text; empty on a tool result, whose result `toolCalls` returns. */
  text: string;
  toolCalls?: { id?: string; name: string; args: unknown }[];
  /** Tool results: the tool that answered. */
  tool?: string;
  /** Tool results: the id of the call answered, as `toolCalls` records carry it. */
  id?: string;
  /** Runtime notes: which kind of note (an arrival, a decision, an error route, an automated state's move). */
  note?: string;
}

/** One tool call of the session, as `toolCalls` returns it. */
export interface ToolCallRecord {
  id?: string;
  name: string;
  args: unknown;
  /** The tool's result, parsed when it is JSON text; absent while `pending`. */
  result?: unknown;
  /** `rejected` is a call governance refused; `pending` has no result yet. */
  status: "completed" | "pending" | "failed" | "rejected";
  /** The state and visit (numbered from 1) of the message that made the call. */
  state: string;
  visit: number;
}

/** What `toolCalls` narrows by; every given key must match, and an unknown key is refused. */
export interface ToolCallFilter {
  name?: string;
  state?: string;
  /** A visit's number, as the records carry it. */
  visit?: number;
  status?: ToolCallRecord["status"];
  /** Only the last `last` matches. */
  last?: number;
}

/**
 * One committed traversal step of a session's audit trail: the state entered,
 * the kind of edge that committed it, the recorded rationale when one was given
 * (on `trigger` steps, the trigger id), and — on `sub-workflow` steps — the
 * child workflow and whether it completed. Each turn begins with a `trigger`
 * step; the order read back is the order committed. A move by the session's
 * agent is `agent`, by a grader state `grader`, by a code state `code`.
 */
export interface TrailStep {
  to: string;
  kind: "trigger" | "agent" | "human" | "grader" | "code" | "sub-workflow" | "reset" | "on_error";
  reason?: string;
  workflow?: string;
  status?: "ok" | "error";
  /** Epoch milliseconds at commit. */
  ts: number;
}

/** What a code state's script is run with (also the global `args`). */
export interface CodeStateArgs {
  /** The code state's own slug. */
  state: string;
  /** Which trigger started the turn — its id. A session's input is in `variables`. */
  trigger?: string;
  /** The session's variables as a plain `name → value` map. Read-only: assigning changes nothing — write with `tools.archmax_set_variables`. */
  variables: Record<string, unknown>;
  /** The session's whole transcript, oldest first. A tool result's text is in `toolCalls`, not here. */
  messages: HistoryMessage[];
  /** The session's whole trail, oldest first. */
  trail: TrailStep[];
  /** The session's domain tool calls with their results, across every visit, oldest first. */
  toolCalls(filter?: ToolCallFilter): Promise<ToolCallRecord[]>;
}

/**
 * The code state's tools (`tools.*`): exactly its state's surface — its grants,
 * the file tools, and its controls (`archmax_advance`, `archmax_raise`,
 * `archmax_get_variables`, `archmax_set_variables`) — as async functions, by
 * their own name (`tools.read_file`) or camelCase (`tools.readFile`). A tool the
 * state does not offer is `undefined`. Every call is governed against the code
 * state as a model's would be; a refused call rejects with the governance reason.
 */
export type SandboxTools = Record<string, (input?: unknown) => Promise<unknown>>;

/** The single object a code state's default export is called with. */
export interface CodeStateInput extends CodeStateArgs {
  tools: SandboxTools;
}

export type CodeStateFn = (input: CodeStateInput) => unknown | Promise<unknown>;

/** Alias for `export default`: `export default defineCodeState(async (input) => …)`. Identity at runtime. */
export function defineCodeState(fn: CodeStateFn): CodeStateFn {
  return fn;
}
