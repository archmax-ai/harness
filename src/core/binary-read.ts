import { posix } from "node:path";
import type { ReadResult } from "deepagents";

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
 * extension's, through `isTextMimeType` — plus two content checks: bytes, and a
 * NUL character (git's and ripgrep's rule), which survives the backend's UTF-8
 * decoding of an unknown extension.
 */

/**
 * The non-text entries of Deep Agents' extension table (`backends/utils.ts`,
 * identical in 1.13.4 and 1.14.2), which it does not export. Every other
 * extension maps to a text type, or to `text/plain` by default, so only these
 * decide anything. Pinned against `FilesystemBackend` by `binary-read.test.ts`.
 */
export const BINARY_MIME_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".aiff": "audio/aiff",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mpeg": "video/mpeg",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".mpg": "video/mpeg",
  ".wmv": "video/x-ms-wmv",
  ".3gpp": "video/3gpp",
  ".pdf": "application/pdf",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** The MIME type for a path's binary extension, or `undefined` when Deep Agents would read it as text. */
export function binaryMimeTypeOf(path: string): string | undefined {
  return BINARY_MIME_TYPES[posix.extname(path).toLocaleLowerCase()];
}

/** Deep Agents' `isTextMimeType`: the types `read_file` renders as text. */
export function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/javascript" ||
    mimeType === "image/svg+xml"
  );
}

/** Byte length of non-string content: bytes, or the numeric-key object they become once serialized. */
function byteLength(content: unknown): number | undefined {
  if (ArrayBuffer.isView(content)) return content.byteLength;
  if (content !== null && typeof content === "object") return Object.keys(content).length;
  return undefined;
}

function formatSize(bytes: number): string {
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

const MULTIMODAL_LINE = /^- Images \(.*multimodal content blocks.*$/m;
const BINARY_PAGINATION_LINE = /^- For images and PDFs, pagination.*(?:\n|$)/m;

/**
 * Deep Agents' `read_file` description with its binary-file lines replaced by
 * {@link READ_FILE_TEXT_ONLY_LINE}, or `null` when the multimodal line is not
 * there (reworded upstream) — the caller then keeps the description and warns.
 */
export function textOnlyReadFileDescription(description: string): string | null {
  if (description.includes(READ_FILE_TEXT_ONLY_LINE)) return description;
  if (!MULTIMODAL_LINE.test(description)) return null;
  return description.replace(MULTIMODAL_LINE, READ_FILE_TEXT_ONLY_LINE).replace(BINARY_PAGINATION_LINE, "");
}
