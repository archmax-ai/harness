import { describe, expect, it } from "vitest";
import type { BackendProtocolV2, FileData } from "deepagents";
import {
  Workspace,
  canonicalizeRelPath,
  dirName,
  fileDataToText,
  normalizeRelPath,
  toBackendPath,
} from "./workspace.js";

function fakeBackend(files: Record<string, string>): BackendProtocolV2 {
  const norm = (p: string) => `/${p.replace(/^\/+/, "")}`;
  return {
    async readRaw(filePath: string) {
      const content = files[norm(filePath)];
      if (content === undefined) return { error: `not found: ${filePath}` };
      return {
        data: { content, mimeType: "text/plain", created_at: "", modified_at: "" },
      };
    },
    async ls(dirPath: string) {
      const prefix = norm(dirPath).replace(/\/$/, "");
      const seen = new Set<string>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(`${prefix}/`)) continue;
        const rest = path.slice(prefix.length + 1);
        const [head, ...tail] = rest.split("/");
        seen.add(tail.length ? `${prefix}/${head}/` : `${prefix}/${head}`);
      }
      return {
        files: [...seen].map((p) => ({ path: p, is_dir: p.endsWith("/") })),
      };
    },
  } as unknown as BackendProtocolV2;
}

describe("path helpers", () => {
  it("normalizes and converts paths", () => {
    expect(normalizeRelPath("/a/b")).toBe("a/b");
    expect(normalizeRelPath("a/b")).toBe("a/b");
    expect(toBackendPath("a/b")).toBe("/a/b");
    expect(toBackendPath("/a/b")).toBe("/a/b");
  });

  it("extracts directory basenames", () => {
    expect(dirName("/subagents/judge/")).toBe("judge");
    expect(dirName("subagents/judge")).toBe("judge");
  });
});

describe("canonicalizeRelPath", () => {
  it("strips leading slashes and collapses `.` and `//` segments", () => {
    expect(canonicalizeRelPath("a/b").path).toBe("a/b");
    expect(canonicalizeRelPath("/a/b").path).toBe("a/b");
    expect(canonicalizeRelPath("./a/b").path).toBe("a/b");
    expect(canonicalizeRelPath(".//a//b").path).toBe("a/b");
    expect(canonicalizeRelPath("././a/./b").path).toBe("a/b");
  });

  it("resolves `..` against the accumulated path", () => {
    expect(canonicalizeRelPath("a/../b").path).toBe("b");
    expect(canonicalizeRelPath("run/scratch/../../output/x").path).toBe("output/x");
    expect(canonicalizeRelPath("a/b/../../c").path).toBe("c");
  });

  it("preserves and flags `..` that climbs above the root", () => {
    expect(canonicalizeRelPath("../victim")).toEqual({ path: "../victim", escapes: true });
    expect(canonicalizeRelPath("a/../../b")).toEqual({ path: "../b", escapes: true });
    expect(canonicalizeRelPath("a/../b").escapes).toBe(false);
  });
});

describe("fileDataToText", () => {
  it("handles v2 string, v1 array, and binary", () => {
    expect(fileDataToText({ content: "hi" } as FileData)).toBe("hi");
    expect(fileDataToText({ content: ["a", "b"] } as unknown as FileData)).toBe("a\nb");
    expect(
      fileDataToText({ content: new TextEncoder().encode("bin") } as FileData),
    ).toBe("bin");
  });
});

describe("Workspace", () => {
  const ws = new Workspace(
    fakeBackend({
      "/data.json": '{"n":1}',
      "/notes.txt": "hello",
      "/subagents/judge/SUBAGENT.md": "x",
    }),
  );

  it("reads text and json, reporting missing files as null", async () => {
    expect(await ws.readText("notes.txt")).toBe("hello");
    expect(await ws.readJson<{ n: number }>("data.json")).toEqual({ n: 1 });
    expect(await ws.readText("missing")).toBeNull();
    expect(await ws.readJson("notes.txt")).toBeNull();
  });

  it("reports existence", async () => {
    expect(await ws.exists("notes.txt")).toBe(true);
    expect(await ws.exists("missing")).toBe(false);
  });

  it("lists directory children", async () => {
    const entries = await ws.listDir("subagents");
    expect(entries.map((e) => e.path)).toContain("/subagents/judge/");
  });

});
