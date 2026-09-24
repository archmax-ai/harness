import type { BackendProtocolV2, CompositeBackend, FileInfo } from "deepagents";
import { canonicalizeRelPath } from "./workspace.js";
import { SESSION_INTERNAL_DIRS, classifyWorkspacePath, mountNameOf } from "./zones.js";
import type { MountPrefixes } from "./mounts.js";

/**
 * The workspace's single entry point, wrapping the mount-routing
 * {@link CompositeBackend}. It owns the three things prefix routing cannot do
 * on its own:
 *
 *  1. **Canonicalization.** `CompositeBackend` routes by literal prefix, but
 *     the workspace convention — agent tool calls, generated lifecycle scripts,
 *     the runtime's own `./skills/` discovery glob, documented authoring style —
 *     uses relative and dot-prefixed paths. Without canonicalizing first,
 *     `./skills/x` misses the `/skills/` mount and silently falls through to
 *     the run root: reads report the file missing and writes land in run state.
 *  2. **File mounts.** A mount key without a trailing slash (`/AGENTS.md`) names
 *     one file, which a route prefix cannot express: prefix matching is
 *     `startsWith`, so `/AGENTS.md` would also capture `/AGENTS.md.bak`, and the
 *     stripped key would collapse to `/`.
 *  3. **Agent-visible root shaping.** While a session is bound, a listing of `/`
 *     shows exactly the namespace the agent may address: authored mounts and
 *     authored root files plus the agent-addressable run areas, with the
 *     runtime-internal areas omitted. Listings outside a bound session (e.g.
 *     enumerating session folders for `runs.list()`) are returned untouched.
 *  4. **Search posture.** A root-wide `grep`/`glob` fans out to every route and
 *     one route's `{ error }` is fatal to it, and the composite hands a route
 *     `/` whether the search was addressed at the mount or fanned out. A mount
 *     declared `searchable: false` is therefore absent from the composite that
 *     serves searches, and a search addressed at it (the mount or a path inside
 *     it) is delegated to its route directly, so the backend's own answer —
 *     matches or refusal — reaches the caller verbatim.
 */
export interface WorkspaceRouterOptions {
  /** Mount-routing backend: session zone as default route, authored zone mounted. */
  composite: CompositeBackend;
  /**
   * The composite `grep`/`glob` fan out through: the same default route and the
   * searchable directory routes only. Defaults to `composite`, which is exact
   * when no mount is unsearchable.
   */
  searchComposite?: CompositeBackend;
  /**
   * Unsearchable directory mounts by mount name → the very route object the
   * composite would have called, so an addressed search keeps the route's
   * read-only wrapping and prefix-aware refusals. Default: none.
   */
  unsearchableRoutes?: ReadonlyMap<string, BackendProtocolV2>;
  /** Exact-path file mounts, by mount name (e.g. `AGENTS.md` → its backend). */
  fileMounts: Map<string, BackendProtocolV2>;
  /** This workspace's resolved mount keys, for root-listing shaping. */
  mountPrefixes: MountPrefixes;
  /** The session id bound to the current async context, if any. */
  boundSessionId: () => string | undefined;
}

/** Thrown when a workspace path resolves above the workspace root. */
export class WorkspacePathEscapeError extends Error {
  constructor(readonly path: string) {
    super(
      `Path ${JSON.stringify(path)} resolves outside the workspace root; ` +
        `workspace paths may not traverse above it.`,
    );
    this.name = "WorkspacePathEscapeError";
  }
}

const INTERNAL_DIR_SET: ReadonlySet<string> = new Set(SESSION_INTERNAL_DIRS);

/** Canonical, leading-slash form of a workspace path. Throws on escapes. */
function canonical(path: string): string {
  const { path: rel, escapes } = canonicalizeRelPath(path);
  if (escapes) throw new WorkspacePathEscapeError(path);
  return `/${rel}`;
}

/** Directory-entry name of a `FileInfo` path (trailing slash tolerated). */
function entryName(path: string): string {
  return canonicalizeRelPath(path).path.split("/")[0] ?? "";
}

export function createWorkspaceRouter(options: WorkspaceRouterOptions): BackendProtocolV2 {
  const { composite, fileMounts, mountPrefixes, boundSessionId } = options;
  const searchComposite = options.searchComposite ?? composite;
  const unsearchableRoutes = options.unsearchableRoutes ?? new Map<string, BackendProtocolV2>();

  /** The file mount serving `path` exactly, or `null` for normal routing. */
  const fileMount = (path: string): { backend: BackendProtocolV2; key: string } | null => {
    const rel = canonical(path).slice(1);
    const backend = fileMounts.get(rel);
    return backend ? { backend, key: `/${rel}` } : null;
  };

  /**
   * The unsearchable mount a search at `target` is addressed at, with the
   * route-relative path the composite would have handed its route, or `null`
   * when the search belongs to the fan-out composite. The routing mount is the
   * longest-prefix match across every mount, so a searchable mount nested in an
   * unsearchable one (or the reverse) is still routed to its own backend.
   */
  const addressedUnsearchable = (
    target: string,
  ): { backend: BackendProtocolV2; name: string; routePath: string } | null => {
    const name = mountNameOf(target.slice(1), mountPrefixes);
    const backend = name === null ? undefined : unsearchableRoutes.get(name);
    if (!name || !backend) return null;
    // The composite's own formula: strip the route prefix, keep the leading
    // slash, and the mount itself becomes `/`.
    return { backend, name, routePath: target.slice(name.length + 1) || "/" };
  };

  /** Hide runtime-internal areas and surface file mounts at `/`. */
  const shapeRoot = async (path: string, files: FileInfo[]): Promise<FileInfo[]> => {
    if (path !== "/" || !boundSessionId()) return files;
    const visible = files.filter((file) => !INTERNAL_DIR_SET.has(entryName(file.path)));
    const present = new Set(visible.map((file) => canonicalizeRelPath(file.path).path));
    for (const name of mountPrefixes.files) {
      if (present.has(name)) continue;
      const mounted = fileMounts.get(name);
      if (!mounted) continue;
      const res = await mounted.readRaw(`/${name}`);
      if (!res.error && res.data) visible.push({ path: `/${name}`, is_dir: false });
    }
    return visible.sort((a, b) => a.path.localeCompare(b.path));
  };

  const router: BackendProtocolV2 & { routePrefixes: string[] } = {
    // Preserve the CompositeBackend duck-type (`routePrefixes`) so Deep Agents
    // components that detect mount-routing backends still recognize this one.
    get routePrefixes() {
      return composite.routePrefixes;
    },

    async ls(path: string) {
      const target = canonical(path);
      const file = fileMount(target);
      const res = file ? await file.backend.ls(file.key) : await composite.ls(target);
      if (res.error || !res.files) return res;
      return { ...res, files: await shapeRoot(target, res.files) };
    },

    read(filePath: string, offset?: number, limit?: number) {
      const target = canonical(filePath);
      const file = fileMount(target);
      return file
        ? file.backend.read(file.key, offset, limit)
        : composite.read(target, offset, limit);
    },

    readRaw(filePath: string) {
      const target = canonical(filePath);
      const file = fileMount(target);
      return file ? file.backend.readRaw(file.key) : composite.readRaw(target);
    },

    async grep(pattern: string, path?: string | null, glob?: string | null) {
      if (path == null) return searchComposite.grep(pattern, path, glob);
      const target = canonical(path);
      const direct = addressedUnsearchable(target);
      if (!direct) return searchComposite.grep(pattern, target, glob);
      const res = await direct.backend.grep(pattern, direct.routePath, glob);
      if (res.error) return res;
      // Re-apply the route prefix as the composite does for its own routes.
      return {
        ...res,
        matches: (res.matches ?? []).map((m) => ({ ...m, path: `/${direct.name}${m.path}` })),
      };
    },

    async glob(pattern: string, path?: string) {
      if (path === undefined) return searchComposite.glob(pattern, path);
      const target = canonical(path);
      const direct = addressedUnsearchable(target);
      if (!direct) return searchComposite.glob(pattern, target);
      const res = await direct.backend.glob(pattern, direct.routePath);
      if (res.error) return res;
      return {
        ...res,
        files: (res.files ?? []).map((f) => ({ ...f, path: `/${direct.name}${f.path}` })),
      };
    },

    write(filePath: string, content: string) {
      const target = canonical(filePath);
      // Route the write to the file mount so its own read-only semantics answer,
      // rather than creating a run-state shadow copy at the same path.
      const file = fileMount(target);
      return file ? file.backend.write(file.key, content) : composite.write(target, content);
    },

    edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean) {
      const target = canonical(filePath);
      const file = fileMount(target);
      return file
        ? file.backend.edit(file.key, oldString, newString, replaceAll)
        : composite.edit(target, oldString, newString, replaceAll);
    },
  };

  return router;
}

/** Re-exported so callers can classify a path with the router's own rules. */
export { classifyWorkspacePath };
