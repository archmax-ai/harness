import type { StructuredTool } from "@langchain/core/tools";
import type { BackendProtocolV2 } from "deepagents";
import { tool } from "langchain";
import { z } from "zod";
import { COPY_FILE_TOOL, MOVE_FILE_TOOL, REMOVE_FILE_TOOL } from "../machine/tool-names.js";
import { binaryMimeTypeOf, formatSize } from "./binary-read.js";
import type { MountPrefixes } from "./mounts.js";
import { canonicalizeRelPath } from "./workspace.js";
import { classifyWorkspacePath } from "./zones.js";

/**
 * The runtime's file operations — `copy_file`, `move_file`, `remove_file` — over
 * the workspace backend, so they route through the host's mounts exactly as the
 * built-in file tools do. Each acts on one file and never reads it into the
 * conversation. Governance is the kernel's, by their declared path arguments
 * (`machine/tool-paths.ts`); what is here is the workspace's own answer.
 *
 * Deep Agents' backend protocol has two channels. `readRaw`/`write` carry text
 * (and bytes for a binary-typed path, whose `write` content is base64), and
 * refuse a symlink. `downloadFiles`/`uploadFiles` carry raw bytes for any path,
 * but follow a symlink. So every path is gated on the first channel and the
 * second carries only what the first cannot:
 *
 *  1. `readRaw` the source — its refusals (missing, a directory, a symlink) are
 *     the operation's. Bytes are taken as they come; text is refined to the
 *     exact bytes by downloading the same, now vetted, path.
 *  2. `write` the destination — base64 for a binary-typed path, the text itself
 *     when the bytes are valid UTF-8 (a byte-order mark kept).
 *  3. Otherwise (non-UTF-8 bytes under a text extension: a `.docx`, a Latin-1
 *     `.txt`), or when the store did not keep what `write` carried, upload the
 *     bytes — claiming the path with an empty `write` first, so a symlink or a
 *     read-only mount refuses it as it refuses any write.
 *  4. Read the destination back (`downloadFiles`, else `readRaw`) and compare:
 *     a store that kept base64 text, or decoded a non-text file, has not made a
 *     copy, and the operation says so — removing a destination it created —
 *     rather than report a success it did not make.
 *
 * Every failure is a sentence this module writes: a backend's own error text
 * can carry the host path or the session id, so it is classified, never relayed.
 */

type Verb = "copy" | "move" | "remove";

/** A successful operation, in workspace form. */
export interface FileOperationDone {
  source: string;
  destination?: string;
  bytes?: number;
}

export type FileOperationResult = FileOperationDone | { error: string };

/** Why the store refused a path, from whatever it said or threw. */
function classify(detail: string): string {
  if (/read-only mount/.test(detail)) return "it is served by a read-only mount";
  if (/symlink|symbolic link|ELOOP/i.test(detail)) return "it is a symbolic link, which the workspace does not follow";
  if (/EISDIR|is_directory|is a directory/i.test(detail)) return "it is a directory; this tool works on one file";
  if (/ENOENT|not found|file_not_found/i.test(detail)) return "it does not exist";
  if (/EACCES|EPERM|permission/i.test(detail)) return "permission was denied";
  if (/cannot delete|not support|not available/i.test(detail)) return "the store serving it cannot do that";
  return "the store refused it";
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A workspace-form path as every backend accepts it. */
const keyOf = (path: string): string => `/${path}`;

/** `TextDecoder` that refuses invalid UTF-8 and keeps a byte-order mark. */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function asText(bytes: Uint8Array): string | null {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** One path's raw bytes, or `null` when the backend has no raw transfer or it failed. */
async function download(backend: BackendProtocolV2, path: string): Promise<Uint8Array | null> {
  if (!backend.downloadFiles) return null;
  try {
    const [res] = await backend.downloadFiles([keyOf(path)]);
    return res?.content ?? null;
  } catch {
    return null;
  }
}

/**
 * `readRaw` as a gate: the file's content, or the refusal any read of it meets.
 * A filesystem `readRaw` reports a directory as not found; the raw channel names
 * it, and is consulted for the reason only.
 */
async function gate(
  backend: BackendProtocolV2,
  path: string,
  verb: Verb,
): Promise<{ content: unknown } | { error: string }> {
  let refusal: string | undefined;
  try {
    const res = await backend.readRaw(keyOf(path));
    if (!res.error && res.data) return { content: res.data.content };
    refusal = res.error ?? "not found";
  } catch (err) {
    refusal = message(err);
  }
  let reason = classify(refusal);
  if (reason === "it does not exist" && backend.downloadFiles) {
    try {
      const [res] = await backend.downloadFiles([keyOf(path)]);
      if (res?.error === "is_directory") reason = classify(res.error);
    } catch {
      // No raw transfer: the first reason stands.
    }
  }
  return { error: `Cannot ${verb} '${path}': ${reason}.` };
}

/** Whether a file is already at `path` (a refusal to read it says nothing either way). */
async function fileExists(backend: BackendProtocolV2, path: string): Promise<boolean> {
  try {
    const res = await backend.readRaw(keyOf(path));
    return !res.error && res.data !== undefined;
  } catch {
    return false;
  }
}

/** The source's exact bytes, gated by `readRaw`'s refusals. */
async function readSource(
  backend: BackendProtocolV2,
  path: string,
  verb: Verb,
): Promise<{ bytes: Uint8Array } | { error: string }> {
  const read = await gate(backend, path, verb);
  if ("error" in read) return read;
  const { content } = read;
  if (ArrayBuffer.isView(content)) {
    return { bytes: new Uint8Array(content.buffer, content.byteOffset, content.byteLength) };
  }
  // Text: the backend decoded it, which loses whatever was not UTF-8. The path
  // has passed `readRaw`'s refusals, so its raw bytes may now be taken.
  const exact = await download(backend, path);
  if (exact) return { bytes: exact };
  const text = Array.isArray(content) ? content.join("\n") : String(content ?? "");
  // Without the raw channel, a replacement character is where decoding may have
  // lost bytes: refuse rather than write something the source never held.
  if (text.includes("�")) {
    return {
      error:
        `Cannot ${verb} '${path}': it is not UTF-8 text, and the store serving it cannot hand over ` +
        `its bytes unchanged.`,
    };
  }
  return { bytes: new TextEncoder().encode(text) };
}

/** A `write`/`uploadFiles` outcome as the refusal, or `null` when it succeeded. */
async function attempt(
  path: string,
  verb: Verb,
  op: () => Promise<{ error?: string | null } | undefined>,
): Promise<string | null> {
  try {
    const res = await op();
    return res?.error ? `Cannot ${verb} to '${path}': ${classify(res.error)}.` : null;
  } catch (err) {
    return `Cannot ${verb} to '${path}': ${classify(message(err))}.`;
  }
}

/**
 * What the store now holds at `path`, read back to confirm a write: the raw
 * bytes when it can download them, else what `readRaw` returns (bytes, or text
 * encoded as UTF-8). `null` when it cannot be read back at all.
 */
async function readBack(backend: BackendProtocolV2, path: string): Promise<Uint8Array | null> {
  const raw = await download(backend, path);
  if (raw) return raw;
  try {
    const res = await backend.readRaw(keyOf(path));
    if (res.error || !res.data) return null;
    const { content } = res.data;
    if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    return new TextEncoder().encode(Array.isArray(content) ? content.join("\n") : String(content));
  } catch {
    return null;
  }
}

/**
 * Write `bytes` at `path` and confirm the store kept them, or say why not.
 *
 * The text channel goes first whenever it can carry the bytes: base64 for a
 * binary-typed path (Deep Agents' convention — the store decodes it), the text
 * itself when the bytes are valid UTF-8. A store that kept something else — the
 * base64 string as given, a decoded variant — gets the raw channel next, when it
 * has one. Bytes no text channel carries claim the path with an empty `write`
 * first, because the upload follows a symlink and a write does not. Every write
 * is read back; a destination the operation created and could not fill is
 * removed again, so a refusal leaves nothing behind.
 */
async function writeDestination(
  backend: BackendProtocolV2,
  path: string,
  bytes: Uint8Array,
  verb: Verb,
  fresh: boolean,
): Promise<string | null> {
  const binaryType = binaryMimeTypeOf(path) !== undefined;
  const text = binaryType ? null : asText(bytes);
  const kept = async () => {
    const back = await readBack(backend, path);
    return back !== null && sameBytes(back, bytes);
  };
  if (binaryType || text !== null) {
    const content = binaryType ? Buffer.from(bytes).toString("base64") : text!;
    const refused = await attempt(path, verb, async () => backend.write(keyOf(path), content));
    if (refused) return refused;
    if (await kept()) return null;
  } else {
    const claimed = await attempt(path, verb, async () => backend.write(keyOf(path), ""));
    if (claimed) return claimed;
  }
  if (backend.uploadFiles) {
    const uploadFiles = backend.uploadFiles.bind(backend);
    const refused = await attempt(path, verb, async () => (await uploadFiles([[keyOf(path), bytes]]))[0]);
    if (refused) return refused + (await leftBehind(backend, path, fresh));
    if (await kept()) return null;
  }
  const why = binaryType
    ? "a write to a binary-typed path carries base64, which the store must decode, and it did not"
    : text === null
      ? "it holds files of this type as text, and this file is not text"
      : "what it holds differs from what was written";
  return (
    `Cannot ${verb} to '${path}': the store serving it did not keep the file's bytes — ${why}.` +
    (await leftBehind(backend, path, fresh))
  );
}

/** Undo a failed write the operation created; the sentence saying what is left. */
async function leftBehind(backend: BackendProtocolV2, path: string, fresh: boolean): Promise<string> {
  if (fresh && (await removeAt(backend, path)) === null) return " Nothing was kept.";
  return ` '${path}' was left as the store wrote it.`;
}

/** Canonical workspace form of each path, or the refusal of the first that has none. */
function canonicalPaths(verb: Verb, ...given: string[]): { paths: string[] } | { error: string } {
  const paths: string[] = [];
  for (const path of given) {
    const resolved = canonicalizeRelPath(path);
    if (resolved.escapes) return { error: `Cannot ${verb} '${path}': it resolves outside the workspace root.` };
    if (resolved.path === "") return { error: `Cannot ${verb} '${path}': it names the workspace root, not a file.` };
    paths.push(resolved.path);
  }
  return { paths };
}

/** The checks a copy and a move share before any byte moves. */
async function precheckTransfer(
  backend: BackendProtocolV2,
  verb: "copy" | "move",
  source: string,
  destination: string,
  overwrite: boolean,
): Promise<{ from: string; to: string; fresh: boolean } | { error: string }> {
  const canonical = canonicalPaths(verb, source, destination);
  if ("error" in canonical) return canonical;
  const [from, to] = canonical.paths as [string, string];
  if (from === to) {
    return { error: `Cannot ${verb} '${from}' onto itself: the source and the destination are the same file.` };
  }
  const existed = await fileExists(backend, to);
  if (existed && !overwrite) {
    return {
      error:
        `Cannot ${verb} to '${to}': a file is already there. Pass overwrite: true to replace it, or ` +
        `choose another destination.`,
    };
  }
  return { from, to, fresh: !existed };
}

/** Copy one workspace file. Paths in any spelling; the result names them in canonical form. */
export async function copyWorkspaceFile(
  backend: BackendProtocolV2,
  source: string,
  destination: string,
  options: { overwrite?: boolean } = {},
): Promise<FileOperationResult> {
  const checked = await precheckTransfer(backend, "copy", source, destination, options.overwrite === true);
  if ("error" in checked) return checked;
  const read = await readSource(backend, checked.from, "copy");
  if ("error" in read) return read;
  const refused = await writeDestination(backend, checked.to, read.bytes, "copy", checked.fresh);
  if (refused) return { error: refused };
  return { source: checked.from, destination: checked.to, bytes: read.bytes.byteLength };
}

/**
 * Move one workspace file: the destination is written (and verified) before the
 * source is removed, so a failure leaves a duplicate rather than a loss. A
 * source the workspace serves read-only is refused before anything is written —
 * the kernel refuses it too, but an ungoverned agent has only this.
 */
export async function moveWorkspaceFile(
  backend: BackendProtocolV2,
  source: string,
  destination: string,
  options: { overwrite?: boolean; mountPrefixes?: MountPrefixes } = {},
): Promise<FileOperationResult> {
  const checked = await precheckTransfer(backend, "move", source, destination, options.overwrite === true);
  if ("error" in checked) return checked;
  const { from, to, fresh } = checked;
  if (classifyWorkspacePath(from, options.mountPrefixes) === "authored") {
    return {
      error:
        `Cannot move '${from}': it is served by a read-only mount, so it cannot be removed. Use ` +
        `copy_file to copy it instead.`,
    };
  }
  const read = await readSource(backend, from, "move");
  if ("error" in read) return read;
  const refused = await writeDestination(backend, to, read.bytes, "move", fresh);
  if (refused) return { error: refused };
  const removed = await removeAt(backend, from);
  if (removed) {
    return {
      error:
        `Copied '${from}' to '${to}', but could not remove '${from}': ${removed}. Both files now ` +
        `exist.`,
    };
  }
  return { source: from, destination: to, bytes: read.bytes.byteLength };
}

/** Delete the file at `path`; the reason it was refused, or `null`. */
async function removeAt(backend: BackendProtocolV2, path: string): Promise<string | null> {
  if (!backend.delete) return "the store serving it cannot delete";
  try {
    const res = await backend.delete(keyOf(path));
    return res.error ? classify(res.error) : null;
  } catch (err) {
    return classify(message(err));
  }
}

/** Remove one workspace file — a file, never a folder. */
export async function removeWorkspaceFile(backend: BackendProtocolV2, path: string): Promise<FileOperationResult> {
  const canonical = canonicalPaths("remove", path);
  if ("error" in canonical) return canonical;
  const [target] = canonical.paths as [string];
  // The same refusals a read meets: a folder, a missing file, a symlink.
  const read = await gate(backend, target, "remove");
  if ("error" in read) return read;
  const refused = await removeAt(backend, target);
  if (refused) return { error: `Cannot remove '${target}': ${refused}.` };
  return { source: target };
}

/** The descriptions the model is handed. */
export const FILE_OPERATION_DESCRIPTIONS = {
  [COPY_FILE_TOOL]: [
    "Copies one file to another path, byte for byte — text or binary (an image, a PDF, a .docx) — " +
      "without reading it into the conversation. Creates the destination's folders and leaves the " +
      "source untouched.",
    "",
    "Usage:",
    "- Use it to start from a template or asset (e.g. one in a skill's assets/) instead of " +
      "read_file followed by write_file.",
    "- A file already at destination is refused unless overwrite is true.",
    "- It copies a single file, not a folder.",
  ].join("\n"),
  [MOVE_FILE_TOOL]: [
    "Moves one file to another path, byte for byte, without reading it into the conversation. The " +
      "destination is written before the source is removed, so a failure leaves a copy, never a loss.",
    "",
    "Usage:",
    "- A file already at destination is refused unless overwrite is true.",
    "- A file in a read-only folder cannot be moved; use copy_file for it.",
    "- It moves a single file, not a folder.",
  ].join("\n"),
  [REMOVE_FILE_TOOL]: [
    "Deletes one file.",
    "",
    "Usage:",
    "- It deletes a single file, not a folder.",
    "- A file in a read-only folder cannot be removed.",
  ].join("\n"),
} as const;

const transferSchema = (verb: "copy" | "move") =>
  z.object({
    source: z.string().describe(`Path of the file to ${verb}`),
    destination: z.string().describe(`Path to ${verb} it to`),
    overwrite: z
      .boolean()
      .optional()
      .describe("Replace a file already at destination (default false: such a destination is refused)"),
  });

/** One line for the model: the success sentence, or `Error: …`. */
function render(res: FileOperationResult, done: (ok: FileOperationDone) => string): string {
  return "error" in res ? `Error: ${res.error}` : done(res);
}

/**
 * The runtime's file operations over `ctx.backend` — the assembly's workspace
 * backend, which resolves agent paths against the session bound for the turn,
 * as Deep Agents' own file tools do.
 */
export function createFileOperationTools(ctx: {
  backend: BackendProtocolV2;
  mountPrefixes: MountPrefixes;
}): StructuredTool[] {
  const { backend, mountPrefixes } = ctx;
  return [
    tool(
      async ({ source, destination, overwrite }) =>
        render(
          await copyWorkspaceFile(backend, source, destination, { overwrite: overwrite === true }),
          (ok) => `Copied '${ok.source}' to '${ok.destination}' (${formatSize(ok.bytes ?? 0)}).`,
        ),
      { name: COPY_FILE_TOOL, description: FILE_OPERATION_DESCRIPTIONS[COPY_FILE_TOOL], schema: transferSchema("copy") },
    ),
    tool(
      async ({ source, destination, overwrite }) =>
        render(
          await moveWorkspaceFile(backend, source, destination, { overwrite: overwrite === true, mountPrefixes }),
          (ok) => `Moved '${ok.source}' to '${ok.destination}' (${formatSize(ok.bytes ?? 0)}).`,
        ),
      { name: MOVE_FILE_TOOL, description: FILE_OPERATION_DESCRIPTIONS[MOVE_FILE_TOOL], schema: transferSchema("move") },
    ),
    tool(
      async ({ file_path }) =>
        render(await removeWorkspaceFile(backend, file_path), (ok) => `Removed '${ok.source}'.`),
      {
        name: REMOVE_FILE_TOOL,
        description: FILE_OPERATION_DESCRIPTIONS[REMOVE_FILE_TOOL],
        schema: z.object({ file_path: z.string().describe("Path of the file to delete") }),
      },
    ),
  ];
}
