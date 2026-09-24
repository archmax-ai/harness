/**
 * The **session scope** — the unit every per-session resource is keyed by (the
 * sandbox REPL session, the middleware's per-session context, the PTC budget).
 * A sub-workflow's child is an ordinary session with its own id
 * (`<parent>~<dispatch identity>`); only the dispatch **chain** (cycle and depth
 * refusals) and the **dispatch id** (event attribution) ride the config.
 */
import type { RunnableConfig } from "@langchain/core/runnables";

/** The session id assumed when a config carries no `thread_id`; every per-session map keys on this spelling. */
export const DEFAULT_SESSION_ID = "__default__";

/**
 * Where the dispatch chain of workflow slugs rides between a parent session and
 * its child; what makes depth and cycle refusals possible without a shared registry.
 */
export const SUB_WORKFLOW_CHAIN_KEY = "archmax_sub_workflow_chain";

/** Where a child session's dispatch id rides, so events emitted inside it can be nested. */
export const SUB_WORKFLOW_DISPATCH_KEY = "archmax_sub_workflow_dispatch";

/**
 * Where the slug of the state a **script's** tool call is made from rides. The
 * PTC gateway is refreshed with the state in force on every model call and hands
 * the tool only a `RunnableConfig`; an agent-initiated delegation never needs it.
 */
export const CALLING_STATE_KEY = "archmax_calling_state";

/** The state a script's call is made from, read from its config. */
export function callingStateFrom(config: { configurable?: Configurable }): string | undefined {
  const slug = config?.configurable?.[CALLING_STATE_KEY];
  return typeof slug === "string" && slug ? slug : undefined;
}

/**
 * Where **per-invocation** variable seeds ride. A child's seeds differ per
 * dispatch while the composed child is shared, and the graph input cannot carry
 * them (the turn boundary rewrites the `variables` channel); the config is the
 * one per-invocation, never-checkpointed channel.
 */
export const SEED_VARIABLES_KEY = "archmax_seed_variables";

/** The `configurable` bag of a runnable config, however partially typed the caller has it. */
type Configurable = Record<string, unknown> | undefined;

/** A turn's execution scope: which session, and how it was reached. */
export interface SessionScope {
  /** The LangGraph `thread_id` — the session whose zone and store this turn uses. */
  sessionId: string;
  /** Workflow slugs from the outermost session down to and including this one. */
  chain: readonly string[];
  /** How many delegations deep this session is; `0` at the top level. */
  depth: number;
  /** The dispatch this child session belongs to, for event nesting; absent at the top level. */
  dispatchId?: string;
}

/** The dispatch chain carried by a config, or an empty chain at the top level. */
export function subWorkflowChain(configurable: Configurable): readonly string[] {
  const chain = configurable?.[SUB_WORKFLOW_CHAIN_KEY];
  return Array.isArray(chain) ? (chain as string[]) : [];
}

/** The dispatch id of the child session this config belongs to, if it is one. */
export function subWorkflowDispatchId(configurable: Configurable): string | undefined {
  const id = configurable?.[SUB_WORKFLOW_DISPATCH_KEY];
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * Variable seeds this invocation carries, layered **over** the assembly's own at
 * the turn boundary. Absent for an ordinary turn.
 */
export function seedVariablesFrom(configurable: Configurable): Record<string, unknown> | undefined {
  const seeds = configurable?.[SEED_VARIABLES_KEY];
  return seeds && typeof seeds === "object" && !Array.isArray(seeds)
    ? (seeds as Record<string, unknown>)
    : undefined;
}

/** Read the session scope from a config; a config with no `thread_id` is {@link DEFAULT_SESSION_ID}. */
export function sessionScopeFrom(
  config: { configurable?: Record<string, unknown> } | undefined,
  fallbackSessionId: string = DEFAULT_SESSION_ID,
): SessionScope {
  const configurable = config?.configurable;
  const sessionId = (configurable?.thread_id as string | undefined) ?? fallbackSessionId;
  const chain = subWorkflowChain(configurable);
  const dispatchId = subWorkflowDispatchId(configurable);
  return {
    sessionId,
    chain,
    depth: chain.length,
    ...(dispatchId ? { dispatchId } : {}),
  };
}

/**
 * Drop `sessionId`'s entry and every child session's entry from a session-keyed
 * map. Disposal is requested per session, so it must reach the children nested
 * under it or a delegating session leaks a REPL per dispatch. Returns the ids
 * released, so a caller holding several parallel maps can release the same set.
 */
export function releaseScopes<V>(map: Map<string, V>, sessionId: string): string[] {
  const released: string[] = [];
  for (const key of map.keys()) {
    if (key === sessionId || isChildSessionOf(key, sessionId)) released.push(key);
  }
  for (const key of released) map.delete(key);
  return released;
}

/**
 * The child identity for one dispatch: `<state>:<workflow>:<ordinal>`. The
 * ordinal keeps a second visit to the same state (an `on_error` loop, a retried
 * turn) and concurrently dispatched children of one state apart.
 */
export function subRunIdentity(state: string, workflow: string, ordinal: number): string {
  return `${state}:${workflow}:${ordinal}`;
}

/**
 * Separator between a parent's session id and a child's dispatch identity. A
 * session id becomes a directory name in the filesystem store, so it must be
 * legal on every platform: `~` is, LangGraph's `|` is not.
 */
const CHILD_SESSION_SEPARATOR = "~";

/**
 * The session id one child gets: `<parent>~<state>:<workflow>:<ordinal>` — an
 * ordinary session with its own checkpoints and zone. Derived rather than minted
 * at random, so a re-dispatch of the same call resolves to the same child and a
 * resumed parent finds the child it parked on.
 */
export function childSessionId(parentSessionId: string, identity: string): string {
  return `${parentSessionId}${CHILD_SESSION_SEPARATOR}${identity}`;
}

/**
 * The shape a dispatch identity takes: `<state>:<workflow>:<ordinal>`. Matched
 * rather than assumed, so a host id like `tenant~conversation` is not read as a
 * child of `tenant` (and disposed with it); only ids this module minted count.
 */
const CHILD_IDENTITY = /^[^~:]+:[^~:]+:\d+$/;

/**
 * The session that dispatched `sessionId`, or `undefined` for a top-level
 * session. Derived from the id, so there is no index to drift.
 */
export function parentSessionIdOf(sessionId: string): string | undefined {
  const at = sessionId.lastIndexOf(CHILD_SESSION_SEPARATOR);
  if (at <= 0) return undefined;
  return CHILD_IDENTITY.test(sessionId.slice(at + 1)) ? sessionId.slice(0, at) : undefined;
}

/** Whether `sessionId` is a session dispatched by `parentSessionId`, at any depth. */
export function isChildSessionOf(sessionId: string, parentSessionId: string): boolean {
  if (!sessionId.startsWith(`${parentSessionId}${CHILD_SESSION_SEPARATOR}`)) return false;
  const descent = sessionId.slice(parentSessionId.length + 1).split(CHILD_SESSION_SEPARATOR);
  return descent.every((segment) => CHILD_IDENTITY.test(segment));
}

/**
 * The config a child session is invoked with: its **own** `thread_id` (see
 * {@link childSessionId}), the extended dispatch chain and the dispatch id.
 * `checkpoint_id` and `checkpoint_ns` are cleared: each pins a position in the
 * *caller's* thread, which the child's thread has never written.
 */
export function childRunConfig(
  parentConfig: RunnableConfig,
  child: { identity: string; workflow: string; dispatchId: string },
): RunnableConfig {
  const configurable = { ...(parentConfig.configurable ?? {}) };
  delete configurable.checkpoint_id;
  delete configurable.checkpoint_ns;
  const parentScope = sessionScopeFrom(parentConfig, "");
  const parentSessionId = (configurable.thread_id as string | undefined) ?? "";
  return {
    ...parentConfig,
    configurable: {
      ...configurable,
      thread_id: childSessionId(parentSessionId, child.identity),
      [SUB_WORKFLOW_CHAIN_KEY]: [...parentScope.chain, child.workflow],
      [SUB_WORKFLOW_DISPATCH_KEY]: child.dispatchId,
    },
  };
}
