import { canonicalizeRelPath } from "./workspace.js";

/**
 * The workspace root namespace — and the one thing in it the framework owns.
 *
 * The root **is the current run**: the executing session's folder in the
 * configured session store, served as the default route of the workspace
 * `CompositeBackend`. The framework's path vocabulary stops at the run areas
 * below; **which directories are authored is workspace shape, not framework
 * knowledge**, resolved per assembly into an {@link AuthoredMounts} table by
 * discovery or consumer declaration (see {@link resolveAuthoredMounts}).
 *
 * Every consumer that needs to know "which zone is this path in?" — the decision
 * kernel, the workspace router's routing and root shaping, and static
 * validation — classifies through {@link classifyWorkspacePath} with that one
 * resolved table, so runtime enforcement and validation cannot disagree.
 */

/**
 * The mount keys of one workspace, split by shape and write posture — the input
 * every path classification takes. Produced by `resolveMounts` (`core/mounts.ts`)
 * from the very keys the composite routes on, so routing and classification cannot
 * drift. Declared here, with the classifier that consumes it, so this namespace
 * module stays a leaf: composition depends on classification, never the reverse.
 */
export interface MountPrefixes {
  /** Directory mount names (no slashes), e.g. `["skills", "workflows"]`. */
  readonly dirs: readonly string[];
  /** Exact-path file mount names, e.g. `["AGENTS.md"]`. */
  readonly files: readonly string[];
  /** Names of mounts declared writable; excluded from the read-only rules. */
  readonly writable: readonly string[];
  /**
   * Names of mounts the host declared `governed`: closed by default, reachable
   * only from the states a `mounts` list enables (see
   * `WorkflowMachine.enabledMounts`). A name absent from this list is visible
   * in every state, which is what every table without the flag resolves to.
   */
  readonly governed: readonly string[];
  /**
   * Names of directory mounts the host declared `searchable: false`: the
   * runtime never searches them on its own initiative (a root-wide `grep` or
   * `glob` skips them), while a search addressed at one still reaches its
   * backend so the backend can answer with its own refusal. A file mount is
   * never listed here — a file is not searched as a tree. Not a governance
   * concern: the kernel and `validate` do not read it.
   */
  readonly unsearchable: readonly string[];
}

/** No mounts: every path resolves in the run root. */
export const NO_MOUNTS: MountPrefixes = {
  dirs: [],
  files: [],
  writable: [],
  governed: [],
  unsearchable: [],
};

/**
 * Runtime-internal run areas: checkpoint records, observability artifacts, and
 * the cross-session content-addressed spec snapshots. Written by the runtime
 * through the workspace, never addressable by agent tools.
 */
export const SESSION_INTERNAL_DIRS = ["checkpoints", "artifacts", "_specs"] as const;

/**
 * Context-offload areas. Deep Agents' filesystem and summarization middleware
 * write to these fixed root paths when a tool result or human message exceeds
 * its eviction threshold, and hand the model a pointer to read back. Because
 * the session store serves the root, they land in `<sessionId>/…` with no upstream
 * patching. Agent-readable (it must follow the pointer), never agent-writable.
 */
export const SESSION_OFFLOAD_DIRS = ["large_tool_results", "conversation_history"] as const;

/**
 * The run's working area: intermediate files *and* the results a state produces.
 * Always agent-readable/writable, independent of state policy — one area, so an
 * author never has to decide which of two working directories a file belongs in.
 *
 * Being always-open is the trade: a state cannot narrow *where inside it* a write
 * may land. A workflow that needs the write itself governed names an ordinary run
 * path instead (anything else in the root classifies as `run`, matched against the
 * state's `tools.allow` like any other argument).
 */
export const SESSION_OPEN_DIR = "scratchpad";

/**
 * Cross-session reserved prefix inside the session store, resolved at the store
 * root whether or not a session is bound (see `SessionZoneRouter`).
 */
export const SESSION_AGNOSTIC_PREFIX = "_specs";

/**
 * Store prefixes that resolve to the root whether or not a session is bound:
 * data shared across sessions, like a spec snapshot. One list, so a second such
 * prefix is a one-line change.
 */
export const SESSION_AGNOSTIC_PREFIXES: readonly string[] = [SESSION_AGNOSTIC_PREFIX];

/** Whether a run-store-relative path addresses a session-agnostic prefix. */
export function isSessionAgnosticPath(rel: string): boolean {
  return SESSION_AGNOSTIC_PREFIXES.some(
    (prefix) => rel === prefix || rel.startsWith(`${prefix}/`),
  );
}

/**
 * Zone of a canonical workspace path:
 *
 * - `authored` — read-only authored mount or authored root file
 * - `run-internal` — runtime-only run area (no agent access)
 * - `run-offload` — runtime-managed offload area (agent read-only)
 * - `run-open` — `scratchpad/…` (always agent read/write)
 * - `run` — anything else in the run root; governed by the active state's
 *   `tools.allow`
 * - `escapes` — climbs above the workspace root
 * - `root` — the workspace root itself
 */
export type WorkspaceZone =
  | "authored"
  | "run-internal"
  | "run-offload"
  | "run-open"
  | "run"
  | "escapes"
  | "root";

const INTERNAL_DIR_SET: ReadonlySet<string> = new Set(SESSION_INTERNAL_DIRS);
const OFFLOAD_DIR_SET: ReadonlySet<string> = new Set(SESSION_OFFLOAD_DIRS);

/**
 * Session-area names the framework owns at the workspace root. An authored
 * directory may not shadow one of these, and a session id may not be one of them.
 */
export function sessionAreaNames(): string[] {
  return [
    ...SESSION_INTERNAL_DIRS,
    ...SESSION_OFFLOAD_DIRS,
    SESSION_OPEN_DIR,
  ];
}

const SESSION_AREA_SET: ReadonlySet<string> = new Set(sessionAreaNames());

// --- The authoring prefixes ------------------------------------------------------

/**
 * The authoring prefixes: the workspace-root names holding what the **runtime**
 * reads. `workflows/` carries the machine specs — grading rubrics included — the
 * prose addenda, the lifecycle hook scripts, and the offline test cases a session
 * is enforced with. It is served by the *authoring* backend and is not routed into
 * the agent's workspace composite.
 *
 * It is reserved rather than merely omitted: a workspace that mounted it would hand
 * a session its own spec, its sibling workflows' specs, the tests grading it, and
 * the criteria (with the iteration budget) of the rubric that vetoes it. Refusing
 * the key makes the isolation a property of composition instead of a rule
 * something downstream could relax.
 *
 * Still a **set**, though it holds one member: the classification is the contract
 * and its cardinality is incidental. One list, three consumers — mount resolution,
 * the decision kernel's script diagnostic, and static validation — so a further
 * prefix is a one-line change and the three can never disagree about what the
 * authoring backend serves. Declared here, with the rest of the root namespace
 * vocabulary, so a browser-safe consumer can read it without the mount composition.
 */
export const AUTHORING_PREFIXES = ["workflows"] as const;

/** A root name on the authoring backend. */
export type AuthoringPrefix = (typeof AUTHORING_PREFIXES)[number];

/**
 * What each prefix holds, as a noun phrase a diagnostic can drop into a sentence.
 * Kept per-prefix rather than collapsed into "the authoring backend" so a
 * diagnostic describes the prefix the consumer actually named.
 */
const AUTHORING_CONTENT: Record<AuthoringPrefix, string> = {
  workflows: "machine specs, grading rubrics, hook scripts, and test cases",
};

/** Whether a bare root name is an authoring prefix. */
export function isAuthoringPrefix(name: string): name is AuthoringPrefix {
  return (AUTHORING_PREFIXES as readonly string[]).includes(name);
}

/**
 * The authoring prefix a **canonicalized** relative path addresses, or `null`
 * when it addresses none. The matched prefix is returned rather than a boolean so
 * a caller can name it — and describe its content with
 * {@link describeAuthoringPrefix} — in the diagnostic it produces.
 */
export function authoringPlanePrefix(rel: string): AuthoringPrefix | null {
  for (const prefix of AUTHORING_PREFIXES) {
    if (rel === prefix || rel.startsWith(`${prefix}/`)) return prefix;
  }
  return null;
}

/** The noun phrase naming what an authoring prefix holds. */
export function describeAuthoringPrefix(prefix: AuthoringPrefix): string {
  return AUTHORING_CONTENT[prefix];
}

/**
 * The mount name a **canonicalized** relative path addresses, or `null` when it
 * addresses none — the longest matching name, so a nested key (`catalogs/eu`)
 * wins over a single-segment one (`catalogs`) mounted beside it, and a sibling
 * under the same first segment (`catalogs/uk`) matches neither.
 *
 * Longest prefix rather than first segment because a mount key of several
 * segments is an ordinary mount: the composite already routes the longer prefix
 * first, so classification has to agree or a nested mount would be governed as
 * a run path.
 */
export function mountNameOf(rel: string, mounts: MountPrefixes = NO_MOUNTS): string | null {
  let match: string | null = null;
  for (const name of mounts.dirs) {
    if ((rel === name || rel.startsWith(`${name}/`)) && name.length > (match?.length ?? -1)) {
      match = name;
    }
  }
  for (const name of mounts.files) {
    // A file mount is an exact path: `AGENTS.md.bak` is not captured.
    if (rel === name && name.length > (match?.length ?? -1)) match = name;
  }
  return match;
}

/**
 * Whether a glob or path pattern can only ever match inside one mount — the
 * shape `validate` needs to spot a `tools.allow` entry that contradicts the
 * state's enabled mounts. Returns the mount name when the pattern's literal
 * prefix (everything before its first wildcard) is already inside a mount, else
 * `null`: a broader pattern is left to the runtime rule, which refuses the
 * unreachable paths call by call.
 */
export function mountNameOfPattern(
  pattern: string,
  mounts: MountPrefixes = NO_MOUNTS,
): string | null {
  const literal = canonicalizeRelPath(pattern).path.split(/[*?[{]/, 1)[0] ?? "";
  const upToSegment = literal.slice(0, literal.lastIndexOf("/") + 1).replace(/\/+$/, "");
  if (upToSegment === "") return null;
  return mountNameOf(upToSegment, mounts);
}

/**
 * Classify a workspace path against the workspace's resolved authored mounts.
 * Canonicalizes first (leading slashes stripped, `.`/`//` segments dropped, `..`
 * applied) so equivalent spellings — `./data/x`, `//data/x`, `data/./x` — land in
 * the same zone and none can be dodged with a prefix.
 *
 * With no table supplied, nothing classifies as `authored` — a caller probing the
 * kernel in isolation gets run-state classification. That is safe because authored
 * mounts refuse writes themselves (see `mountSubtree({ readOnly })`), so the
 * kernel's read-only rule is the diagnostic layer rather than the only enforcement.
 */
export function classifyWorkspacePath(
  path: string,
  mounts: MountPrefixes = NO_MOUNTS,
): WorkspaceZone {
  const { path: rel, escapes } = canonicalizeRelPath(path);
  if (escapes) return "escapes";
  if (rel === "") return "root";
  const [top] = rel.split("/");
  const mount = mountNameOf(rel, mounts);
  // A writable mount is not authored: its paths are governed like run paths.
  if (mount != null && !mounts.writable.includes(mount)) return "authored";
  if (INTERNAL_DIR_SET.has(top)) return "run-internal";
  if (OFFLOAD_DIR_SET.has(top)) return "run-offload";
  if (top === SESSION_OPEN_DIR) return "run-open";
  return "run";
}

/**
 * Whether `name` is reserved at the workspace root. Used to refuse a session id
 * that would route its own run folder (`<sessionId>/checkpoints/…`) into a run
 * area or a declared mount. Without a mount table only the framework-owned run
 * areas are reserved — a colliding mount name then fails loudly at the read-only
 * mount instead of silently corrupting authored content.
 */
export function isReservedRootName(
  name: string,
  mounts: MountPrefixes = NO_MOUNTS,
): boolean {
  if (SESSION_AREA_SET.has(name)) return true;
  // A nested mount name reserves its own first segment too: a session folder
  // called `catalogs` would route `catalogs/eu/…` into the mount.
  const firstSegments = [...mounts.dirs, ...mounts.files].map((mount) => mount.split("/")[0]);
  return firstSegments.includes(name);
}
