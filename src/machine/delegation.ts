/**
 * The delegation bounds a dispatcher enforces by default. Declared apart from the
 * dispatcher so a host configuring `bounds` — or a browser-side editor showing
 * what a workflow overrides — reads them without the LangGraph runtime.
 */

/** Default nesting bound: a sub-workflow session is a whole extra agent session. */
export const DEFAULT_SUB_WORKFLOW_DEPTH = 3;

/** Default fan-out bound for one session's in-flight sub-workflow sessions. */
export const DEFAULT_SUB_WORKFLOW_CONCURRENCY = 4;
