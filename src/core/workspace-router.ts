import type {
  BackendProtocolV2,
  CompositeBackend,
  DeleteResult,
  FileDownloadResponse,
  FileInfo,
  FileUploadResponse,
} from "deepagents";
import { binaryReadError } from "./binary-read.js";
import { downloadViaReadRaw } from "./raw-download.js";
import { canonicalizeRelPath } from "./workspace.js";
import { SESSION_INTERNAL_DIRS, classifyWorkspacePath, mountNameOf } from "./zones.js";
import type { MountPrefixes } from "./mounts.js";

/**
 * The workspace's single entry point, wrapping the mount-routing
 * {@link CompositeBackend}. It owns the things prefix routing cannot do
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
 *  5. **Text-only reads.** A `read` whose result is binary — a non-text MIME
 *     type, bytes, or NUL in decoded text — is answered with the binary notice
 *     (`core/binary-read.ts`) instead of content, so no caller of `read_file`
 *     or `tools.readFile` ever gets base64 or decoded bytes. A route's own
 *     `{ error }` and `readRaw` are untouched.
 *  6. **Raw-byte transfer and deletion.** `downloadFiles`/`uploadFiles` and
 *     `delete` route each path as a read or a write does (exact file mount, else
 *     the composite), so the file operations can move bytes no text channel
 *     carries and remove a file. The protocol makes all three optional and Deep
 *     Agents feature-detects them, so none throws for want of support:
 *     `downloadFiles` is always present and reads a route without the raw
 *     channel through `readRaw` (exact bytes or an error); `uploadFiles` is
 *     present exactly when the session zone has it, and a route without it
 *     answers that file with an error; `delete` answers a route without it with
 *     an error. Deep Agents itself is handed the router without `delete`
 *     ({@link withoutDeletion}).
 */
export interface WorkspaceRouterOptions {
  /** Mount-routing backend: session zone as default route, authored zone mounted. */
  composite: CompositeBackend;
  /**
   * The composite's default route, the session zone. The router has
   * `uploadFiles` exactly when it does: that is where Deep Agents writes.
   */
  defaultRoute: BackendProtocolV2;
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

  /** A routed read's result, or the binary notice in its place. */
  const textOnly = async (target: string, pending: ReturnType<BackendProtocolV2["read"]>) => {
    const res = await pending;
    // A v1 file mount answers a bare string; read it as Deep Agents' adapter wraps it.
    const raw: unknown = res;
    const binary = binaryReadError(target, typeof raw === "string" ? { content: raw } : res);
    return binary === null ? res : { error: binary };
  };

  /** One file's bytes from a store: its raw channel, else `readRaw`. */
  const downloadFrom = async (backend: BackendProtocolV2, key: string) =>
    backend.downloadFiles ? (await backend.downloadFiles([key]))[0] : downloadViaReadRaw(backend, key);

  /** One composite-routed file's bytes; a route without the raw channel is read through `readRaw`. */
  const downloadRouted = async (target: string) => {
    try {
      return (await composite.downloadFiles([target]))[0];
    } catch {
      return downloadViaReadRaw(composite, target);
    }
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
      return textOnly(
        target,
        file ? file.backend.read(file.key, offset, limit) : composite.read(target, offset, limit),
      );
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

    async delete(filePath: string): Promise<DeleteResult> {
      const target = canonical(filePath);
      const file = fileMount(target);
      if (!file) return composite.delete(target);
      if (!file.backend.delete) return { error: `Cannot delete '${target.slice(1)}': the store serving it cannot delete.` };
      return file.backend.delete(file.key);
    },

    async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
      const out: FileDownloadResponse[] = [];
      for (const path of paths) {
        const target = canonical(path);
        const file = fileMount(target);
        const res = file ? await downloadFrom(file.backend, file.key) : await downloadRouted(target);
        out.push({ path: target, content: res?.content ?? null, error: res?.error ?? null });
      }
      return out;
    },
  };

  if (options.defaultRoute.uploadFiles) {
    router.uploadFiles = async (files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> => {
      const out: FileUploadResponse[] = [];
      for (const [path, content] of files) {
        const target = canonical(path);
        const file = fileMount(target);
        let error: FileUploadResponse["error"];
        if (file) {
          error = file.backend.uploadFiles
            ? ((await file.backend.uploadFiles([[file.key, content]]))[0]?.error ?? null)
            : "permission_denied";
        } else {
          try {
            error = (await composite.uploadFiles([[target, content]]))[0]?.error ?? null;
          } catch {
            // The composite throws for a route without uploads: this file is refused, not the batch.
            error = "permission_denied";
          }
        }
        out.push({ path: target, error });
      }
      return out;
    };
  }

  return router;
}

/**
 * The workspace as Deep Agents is handed it: everything but `delete`. Deep
 * Agents registers its own `delete` tool (recursive: a folder and all beneath
 * it) whenever its backend can delete; deleting files is `remove_file`'s, so
 * that tool must not exist. The file operations and host tools keep the router
 * itself, `delete` included.
 */
export function withoutDeletion<T extends BackendProtocolV2>(backend: T): T {
  return new Proxy(backend, {
    get: (target, key, receiver) => (key === "delete" ? undefined : Reflect.get(target, key, receiver)),
    has: (target, key) => key !== "delete" && Reflect.has(target, key),
  });
}

/** Re-exported so callers can classify a path with the router's own rules. */
export { classifyWorkspacePath };
