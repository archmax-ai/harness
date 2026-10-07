/**
 * Showing the model the images it reads (`createAgent({ images })`).
 *
 * Reads are text only (`core/binary-read.ts`): Deep Agents' `read_file` would
 * hand an image back as a multimodal block inside the `tool` message, which a
 * chat-completions endpoint refuses there, and the bytes would ride in every
 * checkpoint, event preview and script result. With this middleware the model
 * still sees the image, where chat completions accepts one:
 *
 *  - The model's `read_file` of a PNG, JPEG, GIF or WebP answers with one line —
 *    `Image '<path>' (<type>, <size>) is shown below.` — and marks its tool
 *    message with the path (an `artifact`, never sent to the model). Governance
 *    has already decided the call: this middleware sits inside the workflow's.
 *  - Before every model call the image is read from the workspace and added to
 *    the **request** as a `user` message right after that batch of tool results.
 *    The request is all it changes, so the bytes never enter the message
 *    history, a checkpoint, an event or a script's `tools.readFile` (which keeps
 *    the binary notice).
 *
 * Earlier images stay attached on later calls, the most recent `keep` of them;
 * an older one, and one deleted since, is named in text instead, and the call
 * goes ahead.
 */
import { HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { BackendProtocolV2 } from "deepagents";
import { createMiddleware, type AgentMiddleware } from "langchain";
import { formatSize, shownImageMimeTypeOf } from "../core/binary-read.js";
import {
  asModelCallResult,
  type AnyModelCallHandler,
  type AnyModelCallRequest,
  type AnyToolCallHandler,
  type AnyToolCallRequest,
} from "../core/deepagents.js";
import { canonicalizeRelPath } from "../core/workspace.js";

/** The `images` option of `createAgent`. */
export interface ImageReadOptions {
  /** The largest image sent to the model, in bytes. Default 10 MB, as Deep Agents' `read_file`. */
  maxBytes?: number;
  /**
   * How many of the images read in the session stay attached on a later model
   * call, the most recent first. Default: every one. An older image is named in
   * text, so the model can read it again.
   */
  keep?: number;
}

export const DEFAULT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** The `artifact` key a shown image's tool message carries. */
const IMAGE_MARK = "archmax.image";

/** What a tool message records about the image it showed: never the bytes. */
interface ImageMark {
  path: string;
  mimeType: string;
}

/** The image a tool message showed, or `undefined`. */
export function imageMarkOf(message: BaseMessage): ImageMark | undefined {
  if (!ToolMessage.isInstance(message)) return undefined;
  const mark = (message.artifact as Record<string, unknown> | undefined)?.[IMAGE_MARK];
  if (!mark || typeof mark !== "object") return undefined;
  const { path, mimeType } = mark as Partial<ImageMark>;
  return typeof path === "string" && typeof mimeType === "string" ? { path, mimeType } : undefined;
}

/** Resolve the option: `true` for the defaults, `false`/absent for off. */
export function resolveImageReads(option: boolean | ImageReadOptions | undefined): Required<ImageReadOptions> | null {
  if (!option) return null;
  const given = option === true ? {} : option;
  return {
    maxBytes: given.maxBytes ?? DEFAULT_IMAGE_MAX_BYTES,
    keep: given.keep ?? Number.POSITIVE_INFINITY,
  };
}

/** An image's bytes, read through the workspace's own refusals (`readRaw`), or why not. */
async function readImage(backend: BackendProtocolV2, path: string): Promise<{ bytes: Uint8Array } | { error: string }> {
  try {
    const res = await backend.readRaw(`/${path}`);
    if (res.error || !res.data) return { error: "it does not exist" };
    const { content } = res.data;
    if (ArrayBuffer.isView(content)) {
      return { bytes: new Uint8Array(content.buffer, content.byteOffset, content.byteLength) };
    }
    return { error: "the store does not hold it as an image" };
  } catch {
    return { error: "it could not be read" };
  }
}

/** The request's messages with each batch's images added after it, or the same array when none. */
async function withImages(
  backend: BackendProtocolV2,
  messages: BaseMessage[],
  options: Required<ImageReadOptions>,
): Promise<BaseMessage[]> {
  const marks = messages.map(imageMarkOf);
  const total = marks.filter(Boolean).length;
  if (total === 0) return messages;
  const firstAttached = Math.max(0, total - options.keep);
  const out: BaseMessage[] = [];
  let ordinal = 0;
  let batch: Array<{ mark: ImageMark; attach: boolean }> = [];
  for (const [i, message] of messages.entries()) {
    out.push(message);
    const mark = marks[i];
    if (mark) batch.push({ mark, attach: ordinal++ >= firstAttached });
    const batchEnds = ToolMessage.isInstance(message) && !ToolMessage.isInstance(messages[i + 1]);
    if (batchEnds && batch.length > 0) {
      out.push(await imageMessage(backend, batch, options));
      batch = [];
    }
  }
  return out;
}

/** The user message carrying one batch's images, or what stands in for each. */
async function imageMessage(
  backend: BackendProtocolV2,
  batch: Array<{ mark: ImageMark; attach: boolean }>,
  options: Required<ImageReadOptions>,
): Promise<HumanMessage> {
  const parts: Array<Record<string, unknown>> = [];
  for (const { mark, attach } of batch) {
    if (!attach) {
      parts.push({
        type: "text",
        text: `Image '${mark.path}' was shown earlier and is no longer attached; read it again to see it.`,
      });
      continue;
    }
    const read = await readImage(backend, mark.path);
    if ("error" in read) {
      parts.push({ type: "text", text: `Image '${mark.path}', read earlier, is no longer available: ${read.error}.` });
    } else if (read.bytes.byteLength > options.maxBytes) {
      parts.push({ type: "text", text: `Image '${mark.path}' is now larger than ${formatSize(options.maxBytes)} and is not shown.` });
    } else {
      parts.push({ type: "text", text: `Image '${mark.path}':` });
      const data = Buffer.from(read.bytes).toString("base64");
      parts.push({ type: "image_url", image_url: { url: `data:${mark.mimeType};base64,${data}` } });
    }
  }
  return new HumanMessage({ content: parts as never });
}

/**
 * The middleware. Installed after the workflow's own (so a governed call has
 * already been decided) and before the provider cache and the host's.
 */
export function imageReadMiddleware(
  backend: BackendProtocolV2,
  options: Required<ImageReadOptions>,
): AgentMiddleware {
  return createMiddleware({
    name: "ImageReads",
    wrapToolCall: async (request: AnyToolCallRequest, handler: AnyToolCallHandler) => {
      const call = request.toolCall;
      if (call.name !== "read_file") return handler(request);
      const args = (call.args ?? {}) as Record<string, unknown>;
      const given = args.file_path ?? args.path;
      if (typeof given !== "string") return handler(request);
      const mimeType = shownImageMimeTypeOf(given);
      const { path, escapes } = canonicalizeRelPath(given);
      if (!mimeType || escapes || path === "") return handler(request);
      const read = await readImage(backend, path);
      // A missing file, a symlink, a store holding text: `read_file`'s own answer.
      if ("error" in read) return handler(request);
      const size = formatSize(read.bytes.byteLength);
      if (read.bytes.byteLength > options.maxBytes) {
        return new ToolMessage({
          content:
            `Image '${path}' (${mimeType}, ${size}) was not shown: images over ` +
            `${formatSize(options.maxBytes)} are not sent to the model.`,
          tool_call_id: call.id ?? "",
          name: "read_file",
        });
      }
      return new ToolMessage({
        content: `Image '${path}' (${mimeType}, ${size}) is shown below.`,
        tool_call_id: call.id ?? "",
        name: "read_file",
        artifact: { [IMAGE_MARK]: { path, mimeType } },
      });
    },
    wrapModelCall: async (request: AnyModelCallRequest, handler: AnyModelCallHandler) => {
      const messages = await withImages(backend, request.messages, options);
      const next = messages === request.messages ? request : { ...request, messages };
      return asModelCallResult(await handler(next), "image reads");
    },
  }) as unknown as AgentMiddleware;
}
