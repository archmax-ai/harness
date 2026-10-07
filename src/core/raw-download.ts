import type { BackendProtocolV2, FileDownloadResponse, FileOperationError } from "deepagents";

/**
 * `downloadFiles` for a store without the raw channel, through `readRaw`.
 *
 * Deep Agents makes `downloadFiles` optional and its own code feature-detects
 * it (the skills loader reads every `SKILL.md` through it when present), so a
 * wrapper that defines it must answer every path it can read, not throw. The
 * answer is the file's exact bytes or an error, never something else:
 *
 *  - bytes from `readRaw` (a binary-typed file) are the file's bytes;
 *  - text is the store's decoding of the file, which is exact only when the file
 *    was UTF-8. Encoded back, it is the file's bytes unless decoding replaced
 *    some: text holding U+FFFD is refused with `permission_denied`, because the
 *    store cannot hand over those bytes unchanged.
 */
export async function downloadViaReadRaw(
  backend: Pick<BackendProtocolV2, "readRaw">,
  path: string,
): Promise<FileDownloadResponse> {
  try {
    const res: unknown = await backend.readRaw(path);
    const content = fileContentOf(res);
    if (content === undefined) return refused(path, errorCodeOf((res as { error?: unknown })?.error));
    if (ArrayBuffer.isView(content)) {
      return { path, content: new Uint8Array(content.buffer, content.byteOffset, content.byteLength), error: null };
    }
    const text = Array.isArray(content) ? content.join("\n") : String(content ?? "");
    if (text.includes("�")) return refused(path, "permission_denied");
    return { path, content: new TextEncoder().encode(text), error: null };
  } catch (err) {
    return refused(path, errorCodeOf(err instanceof Error ? err.message : err));
  }
}

const refused = (path: string, error: FileOperationError): FileDownloadResponse => ({ path, content: null, error });

/** The content a `readRaw` result carries: v2's `{ data }`, or a v1 store's bare `FileData`. */
function fileContentOf(res: unknown): unknown {
  if (res === null || typeof res !== "object") return undefined;
  const result = res as { data?: { content?: unknown }; error?: unknown; content?: unknown };
  if (result.error) return undefined;
  if (result.data !== undefined) return result.data.content;
  return "content" in result ? result.content : undefined;
}

/** A store's refusal as the protocol's error code; a read that found nothing is `file_not_found`. */
function errorCodeOf(detail: unknown): FileOperationError {
  const text = typeof detail === "string" ? detail : "";
  if (/EISDIR|is_directory|is a directory/i.test(text)) return "is_directory";
  if (/EACCES|EPERM|permission/i.test(text)) return "permission_denied";
  if (/invalid_path|invalid path/i.test(text)) return "invalid_path";
  return "file_not_found";
}
