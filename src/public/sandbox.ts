/**
 * `@archmax-ai/harness/sandbox` — the typed authoring surface for lifecycle hook
 * scripts. Inside the QuickJS sandbox these names are provided by the prelude
 * and the import line is stripped before evaluation; importing from here buys
 * IDE completion for the hook input, nothing at runtime.
 *
 * ```js
 * import { veto, ok } from "@archmax-ai/harness/sandbox";
 * /** Vetoes a refund the policy forbids. *\/
 * export default async function hook({ state, phase, variables, messages, toolCalls, tools }) {
 *   const refund = JSON.parse(await tools.readFile({ file_path: "scratchpad/refund.json" }));
 *   if (refund.decision !== "denied") return veto(`order ${refund.orderId} is not eligible`);
 *   return ok();
 * }
 * ```
 *
 * Returning nothing is `ok`; throwing is a veto (hooks are fail-closed).
 */

/** What a hook answers with. */
export interface HookVerdict {
  verdict: "ok" | "correct" | "veto";
  reason: string;
}

/** One transcript message, as plain data. `role` is `user`, `assistant`, `tool`, `system`, or `runtime`. */
export interface HookMessage {
  role: string;
  /** The message's text; empty on a tool result, whose result `toolCalls` returns. */
  text: string;
  toolCalls?: { id?: string; name: string; args: unknown }[];
  /** Tool results: the tool that answered. */
  tool?: string;
  /** Tool results: the id of the call answered, as `toolCalls` records carry it. */
  id?: string;
  /** Runtime notes: which kind of note (an arrival, a decision, an error route). */
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
  /** A visit's number, or `"current"`: the visit the hook sees. */
  visit?: number | "current";
  status?: ToolCallRecord["status"];
  /** Only the last `last` matches. */
  last?: number;
}

/** The machine context a lifecycle hook receives (also the global `args`). */
export interface HookArgs {
  state: string;
  phase: "before" | "after";
  /** Which trigger started the run — its id. A run's input is in `variables`. */
  trigger?: string;
  /** The session's variables as a plain `name → value` map. Read-only: assigning changes nothing. */
  variables: Record<string, unknown>;
  /**
   * The transcript of the current visit, newest last: everything since the
   * session entered the state it is in (on an advance, the state being left).
   */
  messages: HookMessage[];
  /** The session's tool calls with their results, across every visit, oldest first. */
  toolCalls(filter?: ToolCallFilter): Promise<ToolCallRecord[]>;
  /** `after` hooks on an advance: the transition being attempted and the agent's reason. */
  from?: string;
  to?: string;
  reason?: string;
}

/**
 * The privileged tool-call bridge (`tools.*`): the agent's tools as async
 * functions keyed by camelCase name (`tools.readFile({ file_path })`). A hook
 * runs on runtime authority, so the state's allow list does not bind it; the
 * safety rules, the workflow `policy`, and consumer rules do. A refused call
 * rejects with the governance reason.
 */
export type SandboxTools = Record<string, (input?: unknown) => Promise<unknown>>;

/**
 * One committed traversal step of a session's audit trail: the state entered,
 * the kind of edge that committed it, the recorded rationale when one was given
 * (on `trigger` steps, the trigger id), and — on `sub-workflow` steps — the
 * child workflow and whether it completed. Each turn begins with a `trigger`
 * step; the order read back is the order committed.
 */
export interface TrailStep {
  to: string;
  kind: "trigger" | "agent" | "human" | "sub-workflow" | "reset" | "on_error";
  reason?: string;
  workflow?: string;
  status?: "ok" | "error";
  /** Epoch milliseconds at commit. */
  ts: number;
}

/** The single object a hook function is called with. */
export interface HookInput extends HookArgs {
  tools: SandboxTools;
}

/**
 * A hook's return: a verdict, `false` (veto), or nothing (`ok`).
 *
 * Nothing else is read as an opinion. A hook's return value *is* its verdict,
 * so any other object — a misspelled `verdict`, a retired shape like
 * `{ ok: false, reason }` — is a verdict the author got wrong and fails closed
 * with its keys named, rather than being read as `ok` and silently permitting
 * what the hook meant to block. Non-object values (`true`, a number, a bare
 * body's incidental completion value) stay `ok`.
 *
 * These rules are the whole verdict vocabulary, and every hook kind is read
 * through them — a custom kind registered via `hookExecutors` included.
 */
export type HookResult = HookVerdict | false | void | undefined;

export type HookFn = (input: HookInput) => HookResult | Promise<HookResult>;

export function ok(reason = "ok"): HookVerdict {
  return { verdict: "ok", reason };
}

export function veto(reason: string): HookVerdict {
  return { verdict: "veto", reason };
}

export function correct(reason: string): HookVerdict {
  return { verdict: "correct", reason };
}

/** Alias for `export default`: `export default defineHook(async (input) => …)`. Identity at runtime. */
export function defineHook(fn: HookFn): HookFn {
  return fn;
}
