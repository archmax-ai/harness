import {
  SESSION_INTERNAL_DIRS,
  SESSION_OFFLOAD_DIRS,
  SESSION_OPEN_DIR,
  SESSION_AGNOSTIC_PREFIX,
} from "../core/zones.js";

/** Default workflow slug when none is supplied. */
export const DEFAULT_WORKFLOW = "order-lookup";

/**
 * Where a workspace may override the platform system prompt. Nothing needs to be
 * served there: the runtime ships the default prompt in its code.
 */
export const PLATFORM_PROMPT_PATH = ".platform/system/GRAPH_STATE.md";

/** Workspace-relative paths for a named workflow (the read-only authored zone). */
export function workflowPaths(workflow: string) {
  const base = `workflows/${workflow}`;
  return {
    platformPrompt: PLATFORM_PROMPT_PATH,
    agentsPrompt: "AGENTS.md",
    /** The machine spec: a pure YAML mapping. */
    workflowYaml: `${base}/workflow.yaml`,
    /** Optional prose addendum, appended after the spec-rendered prompt section. Never a machine source. */
    workflow: `${base}/WORKFLOW.md`,
    testsDir: `${base}/tests`,
    /** Lifecycle hook scripts: the runtime's code, which the agent can neither read nor execute. */
    hooksDir: `${base}/hooks`,
  };
}

/** Where a hook script must live, relative to its workflow directory. */
export const HOOKS_DIR = "hooks";

/**
 * Resolve a hook's declared `script:` to an authoring-backend path. A hook path
 * is workflow-relative and confined to the workflow's own `hooks/`; anything
 * leaving it is refused with a reason. This keeps the two script classes
 * disjoint: a hook can never be an `archmax_run` target.
 */
export function resolveHookScript(
  workflow: string,
  declared: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  const raw = declared.trim();
  if (raw === "") return { ok: false, reason: "hook script path is empty" };
  if (raw.startsWith("/")) {
    return {
      ok: false,
      reason:
        `hook script '${declared}' is an absolute path; a hook script path is relative to its ` +
        `workflow directory (e.g. '${HOOKS_DIR}/check.js')`,
    };
  }
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    // A `..` climb that leaves `hooks/` is caught by the prefix check below.
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const rel = segments.join("/");
  if (rel !== HOOKS_DIR && !rel.startsWith(`${HOOKS_DIR}/`)) {
    return {
      ok: false,
      reason:
        `hook script '${declared}' resolves outside '${HOOKS_DIR}/'; hook scripts live in ` +
        `'workflows/${workflow}/${HOOKS_DIR}/' and are wired workflow-relative ` +
        `(e.g. '${HOOKS_DIR}/check.js').`,
    };
  }
  if (rel === HOOKS_DIR) {
    return { ok: false, reason: `hook script '${declared}' names the '${HOOKS_DIR}/' directory, not a file` };
  }
  return { ok: true, path: `workflows/${workflow}/${rel}` };
}

/**
 * The runtime-internal layout of one session's folder. These paths carry the
 * session id explicitly (`<sessionId>/…`) because internal writers run both
 * inside and outside a bound turn; the agent addresses the same folders id-free.
 */
export function sessionPaths(sessionId: string) {
  const base = sessionId;
  return {
    base,
    /** Durable checkpoint and pending-write records, one immutable file each. */
    checkpointsDir: `${base}/${SESSION_INTERNAL_DIRS[0]}`,
    artifactsDir: `${base}/${SESSION_INTERNAL_DIRS[1]}`,
    /** The run's working area (`scratchpad/…` to the agent). Durable; nothing cleans it up. */
    scratchpadDir: `${base}/${SESSION_OPEN_DIR}`,
    /** Deep Agents' context-offload areas: agent-readable, never agent-writable. */
    largeToolResultsDir: `${base}/${SESSION_OFFLOAD_DIRS[0]}`,
    conversationHistoryDir: `${base}/${SESSION_OFFLOAD_DIRS[1]}`,
  };
}

/** Paths of a session's observability artifacts under `<sessionId>/artifacts/`. */
export function runArtifactPaths(sessionId: string) {
  const runDir = sessionPaths(sessionId).artifactsDir;
  return {
    runDir,
    graphJson: `${runDir}/graph.json`,
    graphMermaid: `${runDir}/graph.mmd`,
    trajectoryJson: `${runDir}/trajectory.json`,
    metadataJson: `${runDir}/metadata.json`,
    trailJson: `${runDir}/trail.json`,
    variablesJson: `${runDir}/variables.json`,
  };
}

/**
 * Path of a content-addressed spec snapshot, keyed by `specHash`. Lives under
 * the session-agnostic `_specs/` prefix so every session sharing a spec version
 * shares one file; the run-zone router passes this prefix through unprefixed.
 */
export function specSnapshotPath(hash: string): string {
  return `${SESSION_AGNOSTIC_PREFIX}/${hash}.json`;
}
