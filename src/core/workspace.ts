import type { BackendProtocolV2, FileData, FileInfo } from "deepagents";

/**
 * Single file-access layer for the runtime.
 *
 * Every read of a file in the agent workspace — machine config, system prompt,
 * hook scripts, `archmax_run` sources, lifecycle artifacts — flows
 * through here so it is served by the configured LangChain Deep Agents
 * {@link BackendProtocolV2}. Swap the backend (filesystem, store, sandbox,
 * remote) and the whole runtime follows, with no direct `fs` coupling.
 * Deletion — the one operation the backend protocol does not model — is owned
 * by the session store (`SessionStore.deleteSession`), not this layer.
 */
export class Workspace {
  constructor(private readonly backend: BackendProtocolV2) {}

  async readText(path: string): Promise<string | null> {
    const res = await this.tryReadRaw(path);
    if (!res || res.error || !res.data) return null;
    return fileDataToText(res.data);
  }

  /**
   * Write text to a workspace file through the backend. Parent directories are
   * created by the backend. Throws if the backend reports a write error.
   */
  async writeText(path: string, contents: string): Promise<void> {
    const res = await this.backend.write(toBackendPath(path), contents);
    const error = (res as { error?: string } | undefined)?.error;
    if (error) throw new Error(error);
  }

  /** Write a value as pretty-printed JSON through {@link writeText}. */
  async writeJson(path: string, value: unknown): Promise<void> {
    await this.writeText(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  /**
   * Replace `oldString` with `newString` in an existing workspace file through
   * the backend's `edit` operation. Used to update an already-written file (e.g.
   * an approval request's frontmatter on decision) on a create-only backend, which
   * refuses to overwrite. Throws if the backend reports an error.
   */
  async editText(
    path: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ): Promise<void> {
    const res = await this.backend.edit(toBackendPath(path), oldString, newString, replaceAll);
    const error = (res as { error?: string } | undefined)?.error;
    if (error) throw new Error(error);
  }

  /** Backends throw on e.g. path traversal; treat any failure as "absent". */
  private async tryReadRaw(path: string) {
    try {
      return await this.backend.readRaw(toBackendPath(path));
    } catch {
      return null;
    }
  }

  async readJson<T = unknown>(path: string): Promise<T | null> {
    const text = await this.readText(path);
    if (text == null) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  async exists(path: string): Promise<boolean> {
    const res = await this.tryReadRaw(path);
    return res != null && !res.error && res.data != null;
  }

  /**
   * Immediate children of a directory as {@link FileInfo} entries. A missing
   * directory and an unreadable one both read as empty — which is what most
   * callers want, and is wrong for anything replaying durable state: see
   * {@link listDirStrict}.
   */
  async listDir(path: string): Promise<FileInfo[]> {
    try {
      const res = await this.backend.ls(toBackendPath(path));
      return res.error || !res.files ? [] : res.files;
    } catch {
      return [];
    }
  }

  /**
   * {@link listDir}, but a backend that failed to answer throws instead of
   * reading as an empty directory. For a caller that replays durable state, the
   * difference is everything: a transient read error must not be indistinguishable
   * from a session with no checkpoints, or the session silently forks (issue #27).
   *
   * A directory the backend reports as absent is still empty, not an error — a
   * session's first turn has no `checkpoints/` folder yet.
   */
  async listDirStrict(path: string): Promise<FileInfo[]> {
    const res = await this.backend.ls(toBackendPath(path));
    if (res.error) {
      if (isAbsentError(res.error)) return [];
      throw new Error(`cannot list '${path}': ${res.error}`);
    }
    return res.files ?? [];
  }

  /**
   * {@link readJson}, but distinguishes the three outcomes a durable replay has
   * to tell apart: the file is absent (`null`), or it is there and unreadable —
   * an unparseable or unfetchable checkpoint throws rather than being skipped.
   */
  async readJsonStrict<T = unknown>(path: string): Promise<T | null> {
    const res = await this.backend.readRaw(toBackendPath(path));
    if (res.error) {
      if (isAbsentError(res.error)) return null;
      throw new Error(`cannot read '${path}': ${res.error}`);
    }
    if (!res.data) return null;
    const text = fileDataToText(res.data);
    if (text == null) throw new Error(`cannot read '${path}': its content is not decodable text`);
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new Error(`cannot parse '${path}' as JSON: ${(err as Error).message}`, { cause: err });
    }
  }
}

/**
 * Whether a backend error says the path does not exist, as opposed to saying it
 * could not be read. Backends phrase this themselves, so the test is on the
 * wording every one of them uses.
 */
function isAbsentError(error: string): boolean {
  return /not found|no such file|does not exist|missing|enoent/i.test(error);
}

/** Strip leading slashes to get a workspace-relative path. */
export function normalizeRelPath(p: string): string {
  return String(p).replace(/^\/+/, "");
}

/** A canonicalized workspace-relative path plus whether it escapes the root. */
export interface CanonicalRelPath {
  /** The resolved relative path: `//` and `.` collapsed, `..` applied. */
  path: string;
  /** True when a `..` segment climbs above the workspace root. */
  escapes: boolean;
}

/**
 * Canonicalize a workspace-relative path to the single form the backend will
 * resolve to: strip leading slashes, drop `.` and empty (`//`) segments, and
 * apply `..` against the accumulated path. A `..` that would climb above the
 * root is preserved as a leading `..` and flags `escapes`.
 *
 * Every path-governance decision (read-only zone, `forbid_paths`, scratchpad,
 * `scratchpad/`) canonicalizes through here so none can be dodged with a
 * `./`, `.//`, or `..` prefix: all three mechanisms see the same path the
 * backend will act on.
 */
export function canonicalizeRelPath(p: string): CanonicalRelPath {
  const out: string[] = [];
  let escapes = false;
  for (const seg of normalizeRelPath(String(p)).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else {
        out.push("..");
        escapes = true;
      }
      continue;
    }
    out.push(seg);
  }
  return { path: out.join("/"), escapes };
}

/** Convert a relative or virtual path to the leading-slash form backends expect. */
export function toBackendPath(p: string): string {
  return `/${normalizeRelPath(p)}`;
}

/** Workspace-relative basename of a (possibly trailing-slash) directory path. */
export function dirName(path: string): string {
  return normalizeRelPath(path).replace(/\/+$/, "").split("/").pop() ?? "";
}

/** Decode {@link FileData} (v1 line array, v2 string, or binary) to text. */
export function fileDataToText(data: FileData): string | null {
  const content = (data as { content: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.join("\n");
  if (content instanceof Uint8Array) return new TextDecoder().decode(content);
  return null;
}
