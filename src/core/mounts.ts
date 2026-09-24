import { join } from "node:path";
import { FilesystemBackend, type BackendProtocolV2 } from "deepagents";
import { normalizeRelPath } from "./workspace.js";
import { PLATFORM_PROMPT_PATH } from "../workflow/paths.js";
import {
  AUTHORING_PREFIXES,
  authoringPlanePrefix,
  describeAuthoringPrefix,
  isAuthoringPrefix,
  NO_MOUNTS,
  sessionAreaNames,
  type AuthoringPrefix,
  type MountPrefixes,
} from "./zones.js";

/**
 * Authored mounts, expressed in the framework's own vocabulary: a
 * {@link CompositeBackend}-style route table of ordinary backends the consumer
 * composes. The runtime owns only the **default route** — the session store, which
 * must catch the runtime's fixed offload paths — and mounts this table beside it.
 *
 * A backend rooted *at* the mounted directory needs no path adaptation: the
 * composite strips the route prefix before delegating and re-applies it to result
 * paths. A consumer serving several mounts from one backend rebases with
 * `mountSubtree` (exported from `core/path-mapping.ts`).
 */

/**
 * A mount: a backend (read-only), or a backend with its write posture and its
 * governance declared.
 *
 * `governed: true` says the spec decides which **states** may see this mount:
 * it is closed by default and reachable only where a `mounts` list enables it,
 * exactly as a skill bundle is. An ungoverned mount (the default, and every
 * existing table) is visible in every state, and only a `mounts.forbid` takes
 * it away. The consumer owns which backend serves a mount, its write posture
 * and whether it is governed; the spec owns which states enable it, and neither
 * is inferred from the other.
 *
 * `searchable: false` says the runtime must never search this mount on its own
 * initiative: a root-wide `grep` or `glob` leaves it out, so a backend that
 * refuses searches (a remote folder a search would download) cannot fail every
 * root-wide search. A search the agent addresses at the mount still reaches the
 * backend, whose own answer — matches or refusal — is returned verbatim. The
 * flag is inert on a file mount, which is never searched as a tree.
 */
export type MountSpec =
  | BackendProtocolV2
  | {
      backend: BackendProtocolV2;
      readOnly?: boolean;
      governed?: boolean;
      searchable?: boolean;
    };

/** One resolved mount: its normalized key, backend, write posture and governance. */
export interface ResolvedMount {
  /** Directory mounts keep their trailing slash; file mounts have none. */
  key: string;
  /** Key without leading slash or trailing slash — the reserved root name. */
  name: string;
  backend: BackendProtocolV2;
  readOnly: boolean;
  isDir: boolean;
  /** Whether the spec's `mounts` lists decide which states may reach it. */
  governed: boolean;
  /** Whether a root-wide search may fan out into it (`true` unless declared otherwise). */
  searchable: boolean;
}

// The classification input type lives with the classifier (`core/zones.ts`);
// re-exported here so consumers reach the whole mount vocabulary from one module.
export { NO_MOUNTS, type MountPrefixes };

/**
 * Thrown when a declared mount key would shadow a run area or serve an
 * authoring-plane prefix to the agent. A declared route is the consumer's wiring
 * rather than incidental noise, so it fails loudly instead of being skipped.
 */
export class MountCollisionError extends Error {
  constructor(readonly key: string) {
    const name = key.replace(/^\/+|\/+$/g, "");
    // The collision is with the key's *first* segment, so a nested key
    // (`/workflows/order-lookup/`) is named for the prefix it reaches into.
    const top = name.split("/")[0] ?? "";
    const plane = isAuthoringPrefix(top) ? top : null;
    super(
      plane
        ? `Mount '${key}' would serve the authoring plane to the agent. ` +
            `'${plane}/' holds ${describeAuthoringPrefix(plane)}; the runtime ` +
            `reads them through the authoring backend, and no agent tool may address them. ` +
            `Configure them with the 'authoring' option instead of mounting them.`
        : `Mount '${key}' collides with the run area '${top}/', which the ` +
            `session store owns at the workspace root. Mount it under a different key.`,
    );
    this.name = "MountCollisionError";
  }
}

const SESSION_AREA_SET: ReadonlySet<string> = new Set(sessionAreaNames());

// The authoring prefixes are root-namespace vocabulary and live with the rest of
// it in `core/zones.ts`; re-exported here so consumers reach the whole mount
// vocabulary from one module.
export {
  AUTHORING_PREFIXES,
  authoringPlanePrefix,
  describeAuthoringPrefix,
  isAuthoringPrefix,
  type AuthoringPrefix,
};

/**
 * Canonical mount key: one leading slash, collapsed separators, trailing slash
 * preserved (it is what distinguishes a directory mount from a file mount).
 */
export function normalizeMountKey(key: string): string {
  const isDir = /\/\s*$/.test(key);
  const rel = normalizeRelPath(key).replace(/\/+$/, "");
  return `/${rel}${isDir ? "/" : ""}`;
}

function specParts(spec: MountSpec): {
  backend: BackendProtocolV2;
  readOnly: boolean;
  governed: boolean;
  searchable: boolean;
} {
  if (typeof spec === "object" && spec !== null && "backend" in spec) {
    return {
      backend: spec.backend,
      readOnly: spec.readOnly ?? true,
      governed: spec.governed ?? false,
      searchable: spec.searchable ?? true,
    };
  }
  return { backend: spec, readOnly: true, governed: false, searchable: true };
}

/**
 * Resolve a consumer's mount table into the composite routes and the prefixes
 * governance classifies against. Throws {@link MountCollisionError} when a key
 * would shadow a run area or name an {@link AUTHORING_PREFIXES} prefix.
 */
export function resolveMounts(table: Record<string, MountSpec> = {}): {
  mounts: ResolvedMount[];
  prefixes: MountPrefixes;
} {
  const mounts: ResolvedMount[] = [];
  for (const [rawKey, spec] of Object.entries(table)) {
    const key = normalizeMountKey(rawKey);
    const name = key.replace(/^\/+|\/+$/g, "");
    if (name === "") continue;
    // The *first* segment decides: a key several levels down the reserved
    // prefix is the same exposure as the prefix itself, so `/workflows/x/`
    // fails exactly as `/workflows/` does.
    const [top = ""] = name.split("/");
    if (SESSION_AREA_SET.has(top) || isAuthoringPrefix(top)) {
      throw new MountCollisionError(key);
    }
    const { backend, readOnly, governed, searchable } = specParts(spec);
    mounts.push({
      key,
      name,
      backend,
      readOnly,
      isDir: key.endsWith("/"),
      governed,
      searchable,
    });
  }
  return {
    mounts,
    prefixes: {
      dirs: mounts.filter((m) => m.isDir).map((m) => m.name),
      files: mounts.filter((m) => !m.isDir).map((m) => m.name),
      writable: mounts.filter((m) => !m.readOnly).map((m) => m.name),
      governed: mounts.filter((m) => m.governed).map((m) => m.name),
      // Only a directory is ever searched as a tree, so the flag on a file
      // mount is recorded on the resolved mount but classifies nothing.
      unsearchable: mounts.filter((m) => m.isDir && !m.searchable).map((m) => m.name),
    },
  };
}

/**
 * Conventional authored directories — a default value, never a constraint.
 *
 * Deliberately short, and deliberately missing every {@link AUTHORING_PREFIXES}
 * prefix. That plane is not workspace furniture the agent browses: it is what the
 * runtime enforces the run *with*, served by the authoring backend and reachable by
 * no tool call. `workflows/` holds the spec — its grading rubrics included, so a run
 * cannot read the criteria it is judged against — plus the prose addendum, the hook
 * scripts, and the cases grading the run.
 *
 * What ships in a skill bundle is the other kind of script — the ones the *agent*
 * runs with `archmax_run` — together with the data a state reads
 * (`skills/<name>/scripts/…`, `skills/<name>/assets/…`), reaching the agent through
 * the `skills/` mount, which also lets a state scope execution to one capability
 * (`skills/triage/scripts/**`).
 *
 * None of the conventional mounts is `governed`: a zero-config workspace's
 * content is visible in every state, exactly as it was before the `mounts`
 * block existed.
 */
const CONVENTIONAL_DIRS = [
  "skills",
  PLATFORM_PROMPT_PATH.split("/")[0], // `.platform` — the runtime reads its prompt from here
] as const;

/** Conventional authored root files, mounted by exact path. */
const CONVENTIONAL_FILES = ["AGENTS.md"] as const;

/**
 * The conventional mount table for a filesystem workspace: each authored
 * directory as a {@link FilesystemBackend} rooted at itself, plus `AGENTS.md`
 * served from the workspace root by exact path.
 *
 * This is a **default value**, applied only when the consumer supplies no table
 * on the default backend — not framework law. Nothing in the framework
 * classifies, validates, or enforces against these names; spread it to extend
 * (`{ ...defaultMounts(root), "/templates/": … }`) or ignore it entirely.
 */
export function defaultMounts(rootDir: string): Record<string, MountSpec> {
  const fs = (dir: string) => new FilesystemBackend({ rootDir: dir, virtualMode: true });
  const table: Record<string, MountSpec> = {};
  for (const dir of CONVENTIONAL_DIRS) table[`/${dir}/`] = fs(join(rootDir, dir));
  // Root files live in the workspace root itself, addressed by their exact key.
  for (const file of CONVENTIONAL_FILES) table[`/${file}`] = fs(rootDir);
  return table;
}
