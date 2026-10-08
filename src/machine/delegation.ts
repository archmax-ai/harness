/**
 * The delegation bounds every dispatcher enforces. No `createAgent` option and no
 * spec setting changes them; they are declared apart from the dispatcher so a
 * host or a browser-side editor can show them without the LangGraph runtime.
 */

/** Default nesting bound: a sub-workflow session is a whole extra agent session. */
export const DEFAULT_SUB_WORKFLOW_DEPTH = 3;

/** Default fan-out bound for one session's in-flight sub-workflow sessions. */
export const DEFAULT_SUB_WORKFLOW_CONCURRENCY = 4;
