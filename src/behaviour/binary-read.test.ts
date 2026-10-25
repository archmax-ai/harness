/**
 * Reads are text only. A binary file — by Deep Agents' MIME type or by the NUL
 * bytes of an unknown extension — reaches neither the model nor a script as
 * base64 or decoded bytes: both get the binary notice, and the `read_file`
 * description the model is handed says so.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { READ_FILE_TEXT_ONLY_LINE } from "../core/binary-read.js";
import { createMemorySessionStore, type SessionStore } from "../index.js";
import {
  assemble,
  cleanupWorkspaces,
  eventsOf,
  freshSessionId,
  skillMarkdown,
  toolResults,
  turn,
  workspaceWith,
} from "./support.js";

afterEach(cleanupWorkspaces);

const RUNTIME = { engine: "archmax-harness", version: "3" };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0xc3, 0x28]);
/** The base64 the PNG signature encodes to: what used to reach the model. */
const PNG_BASE64 = "iVBORw0KGgo";

const spec = {
  runtime: RUNTIME,
  skills: { allow_always: [] },
  states: { start: { triggers: { manual: null }, skills: { allow: ["media"] } } },
};

function mediaWorkspace(): string {
  const root = workspaceWith(spec, {
    "skills/media/SKILL.md": skillMarkdown("media", "Brand media."),
    "skills/media/assets/brand.json": '{"name":"Acme"}',
  });
  writeFileSync(join(root, "skills/media/assets/logo.png"), PNG);
  writeFileSync(join(root, "skills/media/assets/export.zip"), ZIP);
  return root;
}

/** Every message's content blocks, flattened: what the model, the checkpoint and the store hold. */
function blocksOf(messages: unknown[]): Array<{ type: string; text?: string }> {
  return messages.flatMap((m) => {
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") return [{ type: "text", text: content }];
    return Array.isArray(content) ? (content as Array<{ type: string; text?: string }>) : [];
  });
}

describe("a binary read", () => {
  it("hands the model the notice, never a multimodal block or base64", async () => {
    const { agent, events } = await assemble(mediaWorkspace(), {
      turns: [
        {
          batch: [
            { tool: "read_file", args: { file_path: "skills/media/assets/logo.png" } },
            { tool: "read_file", args: { file_path: "skills/media/assets/export.zip" } },
            { tool: "read_file", args: { file_path: "skills/media/assets/brand.json" } },
          ],
        },
        { reply: "done" },
      ],
    });
    const { messages } = await turn(agent, freshSessionId(), "show me the logo");

    const reads = toolResults(messages).filter((r) => r.name === "read_file");
    expect(reads.map((r) => r.content)).toEqual([
      "Error: 'skills/media/assets/logo.png' is a binary file (image/png, 12 B) and was not read; " +
        "read_file returns text files only.",
      "Error: 'skills/media/assets/export.zip' is a binary file (application/octet-stream) and was not read; " +
        "read_file returns text files only.",
      expect.stringContaining('{"name":"Acme"}'),
    ]);
    // Deep Agents marks a refused read as an error-status result; the text read succeeds.
    expect(reads.map((r) => r.status === "error")).toEqual([true, true, false]);

    const blocks = blocksOf(messages);
    expect(blocks.filter((b) => ["image", "audio", "video", "file", "image_url"].includes(b.type))).toEqual([]);
    expect(blocks.some((b) => b.text?.includes(PNG_BASE64))).toBe(false);

    // The batch's reads run in parallel, so their events arrive in completion order.
    const previews = eventsOf(events, "tool-result")
      .filter((e) => e.tool === "read_file")
      .map((e) => e.output);
    expect(previews.filter((output) => output.includes("is a binary file"))).toHaveLength(2);
    expect(previews.filter((output) => output.includes("Acme"))).toHaveLength(1);
    expect(previews.some((output) => output.includes(PNG_BASE64))).toBe(false);
    expect(eventsOf(events, "tool-blocked")).toEqual([]);
  });

  it("resolves a script's tools.readFile to the notice string", async () => {
    const { agent } = await assemble(mediaWorkspace(), {
      turns: [
        {
          tool: "archmax_eval",
          args: { code: 'await tools.readFile({ file_path: "skills/media/assets/logo.png" });' },
        },
        { reply: "done" },
      ],
    });
    const { messages } = await turn(agent, freshSessionId(), "go");

    const evalResult = toolResults(messages).find((r) => r.name === "archmax_eval");
    expect(evalResult?.status).not.toBe("error");
    expect(evalResult?.content).toContain("'skills/media/assets/logo.png' is a binary file (image/png, 12 B)");
    expect(evalResult?.content).not.toContain(PNG_BASE64);
  });

  /**
   * An object store labels a file by its registered type, so an Office
   * document unpacked into the scratchpad comes back as `application/xml` and
   * `+xml` text. It is text, and `read_file` hands it on as text, never as the
   * binary notice or a base64 block.
   */
  it("reads the XML and JSON a store labels by its registered type as text", async () => {
    const LABELS: Record<string, string> = {
      ".xml": "application/xml",
      ".rels": "application/vnd.openxmlformats-package.relationships+xml",
      ".json": "application/json; charset=utf-8",
    };
    const memory = createMemorySessionStore();
    const labelled = new Proxy(memory.backend, {
      get(target, prop) {
        if (prop === "read") {
          return async (path: string, offset?: number, limit?: number) => {
            const res = await target.read(path, offset, limit);
            const label = LABELS[path.slice(path.lastIndexOf("."))];
            return label && !res.error ? { ...res, mimeType: label } : res;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const store: SessionStore = { ...memory, backend: labelled };
    const sessionId = freshSessionId();
    await memory.backend.write(`/${sessionId}/scratchpad/docx/word/document.xml`, "<w:document><w:body/></w:document>");
    await memory.backend.write(`/${sessionId}/scratchpad/docx/word/_rels/document.xml.rels`, "<Relationships/>");
    await memory.backend.write(`/${sessionId}/scratchpad/meta.json`, '{"pages":3}');
    const { agent } = await assemble(mediaWorkspace(), {
      store,
      turns: [
        {
          batch: [
            { tool: "read_file", args: { file_path: "scratchpad/docx/word/document.xml" } },
            { tool: "read_file", args: { file_path: "scratchpad/docx/word/_rels/document.xml.rels" } },
            { tool: "read_file", args: { file_path: "scratchpad/meta.json" } },
          ],
        },
        {
          tool: "archmax_eval",
          args: { code: 'await tools.readFile({ file_path: "scratchpad/docx/word/document.xml" });' },
        },
        { reply: "done" },
      ],
    });
    const { messages } = await turn(agent, sessionId, "edit the document");

    const reads = toolResults(messages).filter((r) => r.name === "read_file");
    expect(reads.map((r) => r.content)).toEqual([
      expect.stringContaining("<w:document><w:body/></w:document>"),
      expect.stringContaining("<Relationships/>"),
      expect.stringContaining('{"pages":3}'),
    ]);
    expect(reads.some((r) => r.content.includes("is a binary file"))).toBe(false);
    expect(blocksOf(messages).filter((b) => ["file", "image", "audio", "video"].includes(b.type))).toEqual([]);
    expect(toolResults(messages).find((r) => r.name === "archmax_eval")?.content).toContain("<w:document>");
  });

  it("is announced by the read_file description the model is handed", async () => {
    const { agent, model } = await assemble(mediaWorkspace(), { turns: [{ reply: "done" }] });
    await turn(agent, freshSessionId(), "go");

    const description = model.boundTools.get("read_file")?.description ?? "";
    expect(description).toContain(READ_FILE_TEXT_ONLY_LINE);
    expect(description).not.toContain("multimodal content blocks");
  });
});
