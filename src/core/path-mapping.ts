import type { BackendProtocolV2 } from "deepagents";
import { normalizeRelPath } from "./workspace.js";

/**
 * Bidirectional path mapping for a backend served under a prefix.
 *
 * Three places in the runtime delegate to a backend whose paths are shifted by
 * a prefix, and all three need the *same* two-way mapping:
 *
 *  - **Authored mounts** — `CompositeBackend` strips the route prefix before
 *    delegating (`/skills/x` → `/x`) and re-prepends it to the paths it returns.
 *    A one-way prepending wrapper therefore double-prefixes every listed path
 *    (`/skills/skills/x`); the outbound half is what keeps the round trip honest.
 *  - **The session store's tenancy prefix** — consumer-owned layout that must never
 *    appear in an SDK-visible or agent-visible path, including result paths.
 *  - **The session zone's session binding** — the bound session id must not appear in
 *    agent-visible listings, so it is stripped on the way out.
 *
 * Inbound: `/x` → `/<prefix>/x`. Outbound: every `path` a result carries
 * (`ls`/`glob` entries, `grep` matches, `write`/`edit` results) is mapped back.
 * A result path that does not start with the prefix is left untouched — the
 * inner backend is free to report paths we did not ask about.
 */

/** The prefix in effect for a call: a fixed string, or resolved per call. */
export type PrefixResolver = () => string | undefined;

function relPrefix(prefix: string): string {
  return normalizeRelPath(prefix).replace(/\/+$/, "");
}

/**
 * Wrap `backend` so it is addressed under `prefix` from the outside, mapping
 * paths in both directions. `prefix` may be a resolver, returning `undefined`
 * when no prefix applies for this call (the session zone outside a bound session) —
 * in which case paths pass through unchanged.
 *
 * `passthrough` marks inbound paths that are already expressed in the inner
 * backend's terms and must not be prefixed (e.g. runtime-internal
 * session-qualified paths, cross-session `_specs/…`). Their result paths are left
 * unmapped as well, since they were never shifted.
 */
export function mountSubtree(
  backend: BackendProtocolV2,
  prefix: string | PrefixResolver,
  options: {
    passthrough?: (relPath: string, prefix: string) => boolean;
    /**
     * Refuse `write`/`edit` at the mount instead of delegating. Read-only is a
     * property of the mount, so an authored mount cannot be written through even
     * by a caller that bypasses governance — the kernel's `zone.read-only` rule
     * remains the agent-facing diagnostic, not the only enforcement.
     */
     readOnly?: boolean;
    /**
     * Route prefix a composite stripped before delegating, re-applied when a
     * read-only refusal names the rejected path. Without it the refusal reports
     * the stripped key (`/orders.json`) rather than the path the caller sent
     * (`data/orders.json`) — pointing an agent at a path it never asked about,
     * which is exactly the confusion that makes it retry with invented paths.
     */
    displayPrefix?: string;
  } = {},
): BackendProtocolV2 {
  const resolvePrefix: PrefixResolver =
    typeof prefix === "function" ? () => optionalRel(prefix()) : () => relPrefix(prefix);
  const passthrough = options.passthrough;
  /**
   * The refused path in workspace terms — the spelling the caller would use to
   * address it — so the diagnostic names the path that was actually rejected.
   */
  const displayPath = (path: string): string => {
    const rel = normalizeRelPath(path);
    const prefix = relPrefix(options.displayPrefix ?? "");
    if (!prefix) return rel === "" ? path : rel;
    return rel === "" ? prefix : `${prefix}/${rel}`;
  };
  const readOnlyError = (op: string, path: string) => ({
    error:
      `Cannot ${op} '${displayPath(path)}': it is served by a read-only mount. ` +
      `Only run state is writable in this workspace.`,
  });

  /** The prefix to apply to `path`, or `undefined` when it passes through. */
  const prefixFor = (path: string): string | undefined => {
    const active = resolvePrefix();
    if (!active) return undefined;
    if (passthrough?.(normalizeRelPath(path), active)) return undefined;
    return active;
  };

  const mapIn = (path: string, active: string | undefined): string => {
    if (!active) return path;
    const hadSlash = path.startsWith("/");
    const rel = normalizeRelPath(path);
    const joined = rel === "" ? active : `${active}/${rel}`;
    return hadSlash || path === "" ? `/${joined}` : joined;
  };

  const mapOut = (path: string, active: string | undefined): string => {
    if (!active) return path;
    const hadSlash = path.startsWith("/");
    const rel = normalizeRelPath(path);
    if (rel !== active && !rel.startsWith(`${active}/`)) return path;
    const stripped = rel === active ? "" : rel.slice(active.length + 1);
    return hadSlash ? `/${stripped}` : stripped;
  };

  const mapFiles = <T extends { path: string }>(files: T[] | undefined, active: string | undefined) =>
    files?.map((file) => ({ ...file, path: mapOut(file.path, active) }));

  return {
    async ls(path: string) {
      const active = prefixFor(path);
      const res = await backend.ls(mapIn(path, active));
      const files = mapFiles(res.files, active);
      return files ? { ...res, files } : res;
    },

    read(filePath: string, offset?: number, limit?: number) {
      return backend.read(mapIn(filePath, prefixFor(filePath)), offset, limit);
    },

    readRaw(filePath: string) {
      return backend.readRaw(mapIn(filePath, prefixFor(filePath)));
    },

    async grep(pattern: string, path?: string | null, glob?: string | null) {
      const target = path ?? "";
      const active = prefixFor(target);
      const searchPath = path == null && !active ? path : mapIn(target, active);
      const res = await backend.grep(pattern, searchPath, glob);
      const matches = res.matches?.map((match) => ({ ...match, path: mapOut(match.path, active) }));
      return matches ? { ...res, matches } : res;
    },

    async glob(pattern: string, path?: string) {
      const target = path ?? "";
      const active = prefixFor(target);
      const searchPath = path === undefined && !active ? undefined : mapIn(target, active);
      const res = await backend.glob(pattern, searchPath);
      const files = mapFiles(res.files, active);
      return files ? { ...res, files } : res;
    },

    async write(filePath: string, content: string) {
      if (options.readOnly) return readOnlyError("write", filePath);
      const active = prefixFor(filePath);
      const res = await backend.write(mapIn(filePath, active), content);
      return res.path === undefined ? res : { ...res, path: mapOut(res.path, active) };
    },

    async edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean) {
      if (options.readOnly) return readOnlyError("edit", filePath);
      const active = prefixFor(filePath);
      const res = await backend.edit(mapIn(filePath, active), oldString, newString, replaceAll);
      return res.path === undefined ? res : { ...res, path: mapOut(res.path, active) };
    },
  };
}

function optionalRel(prefix: string | undefined): string | undefined {
  if (prefix == null) return undefined;
  const rel = relPrefix(prefix);
  return rel === "" ? undefined : rel;
}
