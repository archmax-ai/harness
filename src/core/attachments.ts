/**
 * A session's attachments: the one folder, `scratchpad/attachments/`, where the
 * runtime places every file it hands a session — a host's turn file, a copied
 * sub-workflow argument, a copied `file` return — and the one rule that names
 * them so a placement never overwrites a file.
 *
 * Placements into one session are serialized in-process: listing the folder,
 * choosing a free name and writing it happen as one step, so concurrent children
 * of one caller settling at once each take their own name. A session's turn runs
 * in one process, so nothing else can place into it concurrently.
 */
import type { BackendProtocolV2 } from "deepagents";
import { readWorkspaceBytes, workspaceEntryKind, writeWorkspaceBytes } from "./file-operations.js";

/** Where the runtime places the files it hands a session. */
export const ATTACHMENTS_DIR = "scratchpad/attachments";

/**
 * Whether `name` is one plain file name: non-empty, not `.` or `..`, and free of
 * `/`, `\` and NUL — something a host or a source path may name a placement by.
 */
export function isPlainFileName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[/\\\0]/.test(name);
}

/** The last segment of a workspace path: what a copied file keeps as its name. */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/**
 * The name a placement of `fileName` takes when `taken` already holds some:
 * `fileName` itself when free, else the lowest free `-1`, `-2`, … inserted
 * before the last extension (`report.pdf` → `report-1.pdf`, `archive.tar.gz` →
 * `archive.tar-1.gz`). A name with no extension, or whose only dot leads it,
 * takes the suffix at its end (`notes-1`, `.env-1`).
 */
export function attachmentName(taken: ReadonlySet<string>, fileName: string): string {
  if (!taken.has(fileName)) return fileName;
  const dot = fileName.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [fileName.slice(0, dot), fileName.slice(dot)] : [fileName, ""];
  for (let n = 1; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The names `scratchpad/attachments/` already holds, files and folders alike. */
async function namesIn(backend: BackendProtocolV2): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    const listing = await backend.ls(`/${ATTACHMENTS_DIR}`);
    for (const entry of listing.files ?? []) names.add(baseName(entry.path));
  } catch {
    // A folder that does not exist yet holds nothing.
  }
  return names;
}

/** The tail of each session's placement queue, so one session's placements run one at a time. */
const queues = new Map<string, Promise<unknown>>();

/** Run `fn` after every placement already queued for `sessionId`. */
function serialized<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => undefined);
  queues.set(sessionId, tail);
  void tail.then(() => {
    if (queues.get(sessionId) === tail) queues.delete(sessionId);
  });
  return run;
}

/** A placed attachment: its workspace path, or why it could not be placed. */
export type Placement = { path: string } | { error: string };

/**
 * Place `bytes` in `sessionId`'s `scratchpad/attachments/` under `fileName`, or
 * the first free name the suffix rule gives, never overwriting a file. `backend`
 * must already resolve id-free paths against `sessionId` (a bound workspace).
 * The bytes are written and read back exactly, or the placement fails and
 * nothing is left at the path.
 */
export function placeAttachment(
  backend: BackendProtocolV2,
  sessionId: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<Placement> {
  if (!isPlainFileName(fileName)) {
    return Promise.resolve({ error: `Cannot place '${fileName}': it is not a plain file name.` });
  }
  return serialized(sessionId, async () => {
    const name = attachmentName(await namesIn(backend), fileName);
    const path = `${ATTACHMENTS_DIR}/${name}`;
    const refused = await writeWorkspaceBytes(backend, path, bytes);
    return refused ? { error: refused } : { path };
  });
}

/**
 * The runtime's access to **another** session's files: what a sub-workflow
 * dispatch copies a `file` argument into a child with, and a `file` return back
 * out of it. Each call binds the session it names for its own duration, so the
 * caller's turn — already bound to the caller — can read or place in its child's
 * folder without the child's id ever appearing in a path.
 */
export interface SessionFiles {
  /** What `path` names in `sessionId`'s workspace. */
  kind(sessionId: string, path: string): Promise<"file" | "directory" | "missing">;
  /** One file's exact bytes from `sessionId`'s workspace, or why they cannot be read. */
  read(sessionId: string, path: string): Promise<{ bytes: Uint8Array } | { error: string }>;
  /** Place bytes in `sessionId`'s `scratchpad/attachments/` under a name nothing holds. */
  place(sessionId: string, fileName: string, bytes: Uint8Array): Promise<Placement>;
}

/** A {@link SessionFiles} over the workspace, binding each session with `bind` (the assembly's session binder). */
export function createSessionFiles(
  backend: BackendProtocolV2,
  bind: <T>(sessionId: string, fn: () => Promise<T>) => Promise<T>,
): SessionFiles {
  return {
    kind: (sessionId, path) => bind(sessionId, () => workspaceEntryKind(backend, path)),
    read: (sessionId, path) => bind(sessionId, () => readWorkspaceBytes(backend, path)),
    place: (sessionId, fileName, bytes) => bind(sessionId, () => placeAttachment(backend, sessionId, fileName, bytes)),
  };
}
