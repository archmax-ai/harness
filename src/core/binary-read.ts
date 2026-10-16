import type { ReadResult } from "deepagents";
import { binaryMimeTypeOf } from "./binary-types.js";

/**
 * Reads are text only. Deep Agents' `read_file` hands a non-text file to the
 * model as a base64 multimodal block (`image`, `audio`, `video`, `file`), which
 * an OpenAI-compatible tool message cannot carry and which would otherwise
 * ride in every checkpoint, script result and event preview; and it decodes a
 * binary file whose extension it does not know as UTF-8 garbage. The workspace
 * router refuses both with the notice built here, and the `read_file`
 * description the model is handed says so.
 *
 * The classification is `read_file`'s own — the route's `mimeType`, else the
 * extension's — through `isTextMimeType`, which also reads the XML and JSON
 * types a store labels by registration as text, plus two content checks: bytes,
 * and a NUL character (git's and ripgrep's rule), which survives the backend's
 * UTF-8 decoding of an unknown extension.
 */

export { BINARY_MIME_TYPES, binaryMimeTypeOf } from "./binary-types.js";

/**
 * The image types the model may be shown (`images` assembly option): the ones
 * chat-completions vision accepts. HEIC/HEIF are binary but not among them, so
 * they stay refused like every other binary file.
 */
export const SHOWN_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The MIME type of a path the model may be shown as an image, or `undefined`. */
export function shownImageMimeTypeOf(path: string): string | undefined {
  const mime = binaryMimeTypeOf(path);
  return mime !== undefined && SHOWN_IMAGE_MIME_TYPES.has(mime) ? mime : undefined;
}

/** Deep Agents' own `isTextMimeType`, which its `read_file` branches on: anything else it hands on as a base64 block. */
function deepAgentsReadsAsText(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/javascript" ||
    mimeType === "image/svg+xml"
  );
}

/** A MIME type's essence: lowercased, its parameters (`; charset=utf-8`) dropped. */
function essenceOf(mimeType: string): string {
  return (mimeType.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * The types `read_file` renders as text: Deep Agents' own (`text/*`,
 * `application/json`, `application/javascript`, `image/svg+xml`), plus
 * `application/xml` and every structured-syntax `+xml` or `+json` type, each
 * compared without its parameters. An object store labels a file by its
 * registered type, so `word/document.xml` arrives as `application/xml`, and an
 * Office document unpacked into the scratchpad is edited as text.
 */
export function isTextMimeType(mimeType: string): boolean {
  const essence = essenceOf(mimeType);
  return (
    deepAgentsReadsAsText(essence) ||
    essence === "application/xml" ||
    essence.endsWith("+xml") ||
    essence.endsWith("+json")
  );
}

/**
 * A text read as Deep Agents' `read_file` must be handed it. Its own rule is
 * narrower than {@link isTextMimeType}: handed `application/xml` text it answers
 * with a base64 `file` block. A result under a type it would not read as text is
 * relabelled `text/plain`, the type it reads line by line; any other is unchanged.
 * Only for a result {@link binaryReadError} found to be text.
 */
export function asTextRead(result: ReadResult): ReadResult {
  const { mimeType } = result;
  return mimeType === undefined || deepAgentsReadsAsText(mimeType) ? result : { ...result, mimeType: "text/plain" };
}

/** Byte length of non-string content: bytes, or the numeric-key object they become once serialized. */
function byteLength(content: unknown): number | undefined {
  if (ArrayBuffer.isView(content)) return content.byteLength;
  if (content !== null && typeof content === "object") return Object.keys(content).length;
  return undefined;
}

/** A byte count as a person reads it: `512 B`, `24.1 KB`, `3.2 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The binary notice for a successful read of `path`, or `null` when the result
 * is text. A result carrying an `error` is the route's own answer and is never
 * classified.
 */
export function binaryReadError(path: string, result: ReadResult): string | null {
  if (result.error) return null;
  const { content } = result;
  const declared = result.mimeType ?? binaryMimeTypeOf(path) ?? "text/plain";
  const typed = !isTextMimeType(declared);
  const bytes = content !== undefined && typeof content !== "string";
  const nul = typeof content === "string" && content.includes("\u0000");
  if (!typed && !bytes && !nul) return null;
  const mime = typed ? declared : "application/octet-stream";
  const size = bytes ? byteLength(content) : undefined;
  const detail = size === undefined ? mime : `${mime}, ${formatSize(size)}`;
  const shown = path.replace(/^\/+/, "");
  return `'${shown}' is a binary file (${detail}) and was not read; read_file returns text files only.`;
}

/** The line the `read_file` description carries in place of Deep Agents' multimodal promise. */
export const READ_FILE_TEXT_ONLY_LINE =
  "- Text files only: a binary file (an image, audio, video, a PDF, an archive, …) is not returned; " +
  "the result says the file is binary and was not read.";

/** The same line for an agent whose model is shown the images it reads (`images` option). */
export const READ_FILE_IMAGES_LINE =
  "- Text files, and images (PNG, JPEG, GIF, WebP): an image is shown to you right after the tool " +
  "result. Any other binary file (audio, video, a PDF, an archive, …) is not returned; the result " +
  "says the file is binary and was not read.";

const MULTIMODAL_LINE = /^- Images \(.*multimodal content blocks.*$/m;
const BINARY_PAGINATION_LINE = /^- For images and PDFs, pagination.*(?:\n|$)/m;

/**
 * Deep Agents' `read_file` description with its binary-file lines replaced by
 * `line` ({@link READ_FILE_TEXT_ONLY_LINE} by default), or `null` when the multimodal line is not
 * there (reworded upstream) — the caller then keeps the description and warns.
 */
export function textOnlyReadFileDescription(
  description: string,
  line: string = READ_FILE_TEXT_ONLY_LINE,
): string | null {
  if (description.includes(line)) return description;
  if (!MULTIMODAL_LINE.test(description)) return null;
  return description.replace(MULTIMODAL_LINE, line).replace(BINARY_PAGINATION_LINE, "");
}
