/**
 * The binary types of Deep Agents' v2 file format: the extensions `read_file`
 * treats as non-text, and the paths a `write` addresses with base64 that the
 * store decodes. Pure — no `node:*` — so the spec subpath can export it to a
 * host store that honours the convention (`@archmax-ai/harness/spec`).
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

/** A path's extension as `node:path`'s `extname` reads it: from the last dot of the last segment, not a leading one. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

/**
 * The MIME type for a path's binary extension, or `undefined` when Deep Agents
 * would read it as text. A `write` to a path this names carries base64, which a
 * store honouring Deep Agents' convention decodes to the bytes.
 */
export function binaryMimeTypeOf(path: string): string | undefined {
  return BINARY_MIME_TYPES[extensionOf(path).toLocaleLowerCase()];
}
