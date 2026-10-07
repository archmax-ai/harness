import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FilesystemBackend } from "deepagents";
import {
  BINARY_MIME_TYPES,
  READ_FILE_TEXT_ONLY_LINE,
  binaryMimeTypeOf,
  binaryReadError,
  textOnlyReadFileDescription,
} from "./binary-read.js";

/**
 * The classification is a local copy of Deep Agents' unexported extension
 * table and text predicate, so it is pinned against the real thing: whatever
 * `FilesystemBackend.read()` reports for a path is what `read_file` decides by.
 */
describe("binary classification agrees with Deep Agents", () => {
  let root: string;
  let backend: FilesystemBackend;
  const TEXT_NAMES = ["a.svg", "a.json", "a.md", "a.ts", "a.properties", "Dockerfile", "a.csv", "a.js"];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "archmax-binary-"));
    backend = new FilesystemBackend({ rootDir: root, virtualMode: true });
    for (const ext of Object.keys(BINARY_MIME_TYPES)) writeFileSync(join(root, `a${ext}`), "x");
    for (const name of TEXT_NAMES) writeFileSync(join(root, name), "x");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it.each(Object.keys(BINARY_MIME_TYPES))("%s is binary with Deep Agents' MIME type", async (ext) => {
    const result = await backend.read(`/a${ext}`);
    expect(result.mimeType).toBe(BINARY_MIME_TYPES[ext]);
    expect(result.content).toBeInstanceOf(Uint8Array);
    expect(binaryMimeTypeOf(`a${ext.toUpperCase()}`)).toBe(BINARY_MIME_TYPES[ext]);
    expect(binaryReadError(`a${ext}`, result)).toContain(`(${BINARY_MIME_TYPES[ext]}, 1 B)`);
  });

  it.each(TEXT_NAMES)("%s reads as text in both", async (name) => {
    const result = await backend.read(`/${name}`);
    expect(typeof result.content).toBe("string");
    expect(binaryMimeTypeOf(name)).toBeUndefined();
    expect(binaryReadError(name, result)).toBeNull();
  });
});

describe("binaryReadError", () => {
  it("refuses a string carrying NUL as octet-stream, without a size", () => {
    const notice = binaryReadError("/scratchpad/export.zip", { content: "PK\u0003\u0004\u0000\u0000", mimeType: "text/plain" });
    expect(notice).toBe(
      "'scratchpad/export.zip' is a binary file (application/octet-stream) and was not read; " +
        "read_file returns text files only.",
    );
  });

  it("refuses bytes under a text type, with their size", () => {
    expect(binaryReadError("blob", { content: new Uint8Array(2048), mimeType: "text/plain" })).toContain(
      "(application/octet-stream, 2.0 KB)",
    );
  });

  it("refuses the numeric-key object bytes become once serialized", () => {
    expect(binaryReadError("a.png", { content: { 0: 137, 1: 80 } as unknown as Uint8Array })).toContain(
      "(image/png, 2 B)",
    );
  });

  it("prefers the route's MIME type over the extension", () => {
    expect(binaryReadError("upload", { content: new Uint8Array(3 * 1024 * 1024), mimeType: "image/png" })).toContain(
      "(image/png, 3.0 MB)",
    );
  });

  it("refuses a binary type even when the route returned a string", () => {
    expect(binaryReadError("a.pdf", { content: "JVBERi0=", mimeType: "application/pdf" })).toContain(
      "(application/pdf)",
    );
  });

  it("keeps text, including Latin-1 decoded with replacement characters", () => {
    expect(binaryReadError("notes.txt", { content: "caf� au lait", mimeType: "text/plain" })).toBeNull();
  });

  it("never classifies a route's error", () => {
    expect(binaryReadError("missing.png", { error: "File '/missing.png' not found" })).toBeNull();
  });
});

describe("textOnlyReadFileDescription", () => {
  const UPSTREAM =
    "Reads a file.\n\nUsage:\n- Speculatively batch reads.\n" +
    "- Images (`.png`, `.jpg`, etc.), audio, video, and PDFs return multimodal content blocks (https://docs.langchain.com/x).\n" +
    "- For images and PDFs, pagination via `offset`/`limit` is text-only - supply `file_path` only.\n" +
    "- Always read a file before editing it.";

  it("replaces the multimodal lines with the text-only line", () => {
    expect(textOnlyReadFileDescription(UPSTREAM)).toBe(
      `Reads a file.\n\nUsage:\n- Speculatively batch reads.\n${READ_FILE_TEXT_ONLY_LINE}\n- Always read a file before editing it.`,
    );
  });

  it("is idempotent", () => {
    const once = textOnlyReadFileDescription(UPSTREAM)!;
    expect(textOnlyReadFileDescription(once)).toBe(once);
  });

  it("returns null when the upstream line was reworded", () => {
    expect(textOnlyReadFileDescription("Reads a file.\n- Binary files come back as blocks.")).toBeNull();
  });
});
