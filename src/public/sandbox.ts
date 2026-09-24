/**
 * `@archmax-ai/harness/sandbox` — the typed authoring surface for lifecycle hook
 * scripts. Inside the QuickJS sandbox these names are provided by the prelude
 * and the import line is stripped before evaluation; importing from here buys
 * IDE completion for the hook input, nothing at runtime.
 *
 * ```js
 * import { veto, ok } from "@archmax-ai/harness/sandbox";
 * /** Vetoes a refund the policy forbids. *\/
 * export default async function hook({ state, phase, variables, messages, tools }) {
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
  text: string;
  toolCalls?: { name: string; args: unknown }[];
  /** Tool results: the tool that produced the text. */
  tool?: string;
  /** Runtime notes: which kind of note (an arrival, a decision, an error route). */
  note?: string;
}

/** The machine context a lifecycle hook receives (also the global `args`). */
export interface HookArgs {
  state: string;
  phase: "before" | "after";
  /** Which trigger started the run — its id. A run's input is in `variables`. */
  trigger?: string;
  /** The session's variables as a plain `name → value` map. Read-only: assigning changes nothing. */
  variables: Record<string, unknown>;
  /** The recent transcript, newest last. */
  messages: HookMessage[];
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
