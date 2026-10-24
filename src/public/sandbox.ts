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
 * state that finishes without either call fails, as does one that throws. It
 * reads the session it checks with `tools.archmax_get_history()`.
 */

/** One transcript message, as plain data. `role` is `user`, `assistant`, `tool`, `system`, or `runtime`. */
export interface HistoryMessage {
  role: string;
  /** The message's text; on a tool result, the result. */
  text: string;
  /** Assistant messages: the tool calls the message made. */
  toolCalls?: { id?: string; name: string; args: unknown }[];
  /** Tool results: the tool that answered. */
  tool?: string;
  /** Tool results: the id of the call answered. */
  id?: string;
  /** Runtime notes: which kind of note (an arrival, a decision, an error route, an automated state's move). */
  note?: string;
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
}

/**
 * What `tools.archmax_get_history()` answers, as JSON: the session's whole
 * transcript and its whole trail, oldest first — the same history a grader reads.
 * `const { messages, trail } = JSON.parse(await tools.archmax_get_history())`.
 */
export interface SessionHistory {
  messages: HistoryMessage[];
  trail: TrailStep[];
}

/**
 * The code state's tools (`tools.*`): exactly its state's surface — its grants,
 * the workflow-wide grant, and its controls (`archmax_advance`, `archmax_raise`,
 * `archmax_get_variables`, `archmax_set_variables`, `archmax_get_history`) — as async functions, by
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
