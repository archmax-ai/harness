import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BackendProtocolV2 } from "deepagents";
import {
  copyWorkspaceFile,
  createFileOperationTools,
  moveWorkspaceFile,
  removeWorkspaceFile,
} from "./file-operations.js";
import { createMemorySessionStore } from "./session-store.js";
import { createWorkspaceContext, type WorkspaceContext } from "./workspace-context.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
/** Zip-container bytes (what a `.docx` is): not UTF-8, under an extension Deep Agents types as text. */
const DOCX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0xff, 0xd8, 0x00, 0x80]);
const LATIN1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // "café" in Latin-1
const LONG = Array.from({ length: 900 }, (_, i) => `line ${i + 1}`).join("\n");

type Ctx = Pick<WorkspaceContext, "backend" | "sessionZone" | "mountPrefixes">;

function withWorkspace<T>(fn: (root: string, ctx: Ctx) => Promise<T>, options: { memory?: boolean } = {}): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "archmax-fileops-"));
  const assets = join(root, "skills", "data", "assets");
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, "template.md"), LONG);
  writeFileSync(join(assets, "logo.png"), PNG);
  writeFileSync(join(assets, "template.docx"), DOCX);
  writeFileSync(join(assets, "bom.csv"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a,b\n")]));
  writeFileSync(join(assets, "latin1.txt"), LATIN1);
  writeFileSync(join(root, "outside.txt"), "secret");
  symlinkSync(join(root, "outside.txt"), join(assets, "link.txt"));
  const ctx = createWorkspaceContext({
    rootDir: root,
    ...(options.memory ? { sessionStore: createMemorySessionStore() } : {}),
  });
  return ctx.sessionZone
    .sessionScoped("s1", () => fn(root, ctx))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

/** A session file's path on disk, under the filesystem session store. */
const sessionFile = (root: string, path: string) => join(root, "sessions", "s1", path);

describe("copyWorkspaceFile", () => {
  it("copies a long text file whole, without paging", () =>
    withWorkspace(async (root, { backend }) => {
      expect(await copyWorkspaceFile(backend, "skills/data/assets/template.md", "scratchpad/report.md")).toEqual({
        source: "skills/data/assets/template.md",
        destination: "scratchpad/report.md",
        bytes: Buffer.byteLength(LONG),
      });
      expect(readFileSync(sessionFile(root, "scratchpad/report.md"), "utf8")).toBe(LONG);
      // The source is untouched.
      expect(readFileSync(join(root, "skills/data/assets/template.md"), "utf8")).toBe(LONG);
    }));

  it("copies binary files byte for byte: a typed image and an untyped container", () =>
    withWorkspace(async (root, { backend }) => {
      await copyWorkspaceFile(backend, "skills/data/assets/logo.png", "scratchpad/logo.png");
      await copyWorkspaceFile(backend, "skills/data/assets/template.docx", "scratchpad/draft.docx");
      expect(readFileSync(sessionFile(root, "scratchpad/logo.png"))).toEqual(PNG);
      expect(readFileSync(sessionFile(root, "scratchpad/draft.docx"))).toEqual(DOCX);
    }));

  it("keeps a byte-order mark and bytes that are not UTF-8", () =>
    withWorkspace(async (root, { backend }) => {
      await copyWorkspaceFile(backend, "skills/data/assets/bom.csv", "scratchpad/bom.csv");
      await copyWorkspaceFile(backend, "skills/data/assets/latin1.txt", "scratchpad/latin1.txt");
      expect(readFileSync(sessionFile(root, "scratchpad/bom.csv"))).toEqual(readFileSync(join(root, "skills/data/assets/bom.csv")));
      expect(readFileSync(sessionFile(root, "scratchpad/latin1.txt"))).toEqual(LATIN1);
    }));

  it("creates the destination's folders", () =>
    withWorkspace(async (root, { backend }) => {
      const res = await copyWorkspaceFile(backend, "skills/data/assets/template.md", "./scratchpad//out/deep/x.md");
      expect(res).toMatchObject({ destination: "scratchpad/out/deep/x.md" });
      expect(readFileSync(sessionFile(root, "scratchpad/out/deep/x.md"), "utf8")).toBe(LONG);
    }));

  it("refuses an existing destination unless overwrite is set", () =>
    withWorkspace(async (root, { backend }) => {
      await backend.write("/scratchpad/out.md", "old");
      expect(await copyWorkspaceFile(backend, "skills/data/assets/template.md", "scratchpad/out.md")).toEqual({
        error:
          "Cannot copy to 'scratchpad/out.md': a file is already there. Pass overwrite: true to replace it, " +
          "or choose another destination.",
      });
      expect(readFileSync(sessionFile(root, "scratchpad/out.md"), "utf8")).toBe("old");
      await copyWorkspaceFile(backend, "skills/data/assets/template.md", "scratchpad/out.md", { overwrite: true });
      expect(readFileSync(sessionFile(root, "scratchpad/out.md"), "utf8")).toBe(LONG);
    }));

  it("refuses a missing source without leaking the store's own message", () =>
    withWorkspace(async (root, { backend }) => {
      expect(await copyWorkspaceFile(backend, "scratchpad/missing.md", "scratchpad/x.md")).toEqual({
        error: "Cannot copy 'scratchpad/missing.md': it does not exist.",
      });
      expect(existsSync(sessionFile(root, "scratchpad/x.md"))).toBe(false);
    }));

  it("refuses a directory and a symlink, as a read does, and writes nothing", () =>
    withWorkspace(async (root, { backend }) => {
      expect(await copyWorkspaceFile(backend, "skills/data/assets", "scratchpad/assets")).toEqual({
        error: "Cannot copy 'skills/data/assets': it is a directory; this tool works on one file.",
      });
      expect(await copyWorkspaceFile(backend, "skills/data/assets/link.txt", "scratchpad/leak.txt")).toEqual({
        error: "Cannot copy 'skills/data/assets/link.txt': it is a symbolic link, which the workspace does not follow.",
      });
      expect(existsSync(sessionFile(root, "scratchpad/leak.txt"))).toBe(false);
    }));

  it("refuses copying a file onto itself, however it is spelled", () =>
    withWorkspace(async (root, { backend }) => {
      await backend.write("/scratchpad/a.md", "alpha");
      expect(await copyWorkspaceFile(backend, "scratchpad/a.md", "/scratchpad/a.md", { overwrite: true })).toEqual({
        error: "Cannot copy 'scratchpad/a.md' onto itself: the source and the destination are the same file.",
      });
      expect(readFileSync(sessionFile(root, "scratchpad/a.md"), "utf8")).toBe("alpha");
    }));

  it("refuses a destination in a read-only mount, for text and for untyped bytes alike", () =>
    withWorkspace(async (root, { backend }) => {
      await backend.write("/scratchpad/a.md", "alpha");
      expect(await copyWorkspaceFile(backend, "scratchpad/a.md", "skills/data/a.md")).toEqual({
        error: "Cannot copy to 'skills/data/a.md': it is served by a read-only mount.",
      });
      expect(await copyWorkspaceFile(backend, "skills/data/assets/template.docx", "skills/data/b.docx")).toEqual({
        error: "Cannot copy to 'skills/data/b.docx': it is served by a read-only mount.",
      });
      expect(existsSync(join(root, "skills/data/a.md"))).toBe(false);
      expect(existsSync(join(root, "skills/data/b.docx"))).toBe(false);
    }));

  it("refuses a path above the workspace root or the root itself", () =>
    withWorkspace(async (_root, { backend }) => {
      expect(await copyWorkspaceFile(backend, "../outside.txt", "scratchpad/x.txt")).toEqual({
        error: "Cannot copy '../outside.txt': it resolves outside the workspace root.",
      });
      expect(await copyWorkspaceFile(backend, "scratchpad/a.md", "/")).toEqual({
        error: "Cannot copy '/': it names the workspace root, not a file.",
      });
    }));

  it("says so when the store cannot hold the bytes under that name", () =>
    withWorkspace(
      async (_root, { backend }) => {
        // The memory store keeps a text-typed path as decoded text.
        const res = await copyWorkspaceFile(backend, "skills/data/assets/template.docx", "scratchpad/draft.docx");
        expect(res).toMatchObject({ error: expect.stringMatching(/did not keep the file's bytes/) });
        // A typed binary and text still copy exactly there.
        expect(await copyWorkspaceFile(backend, "skills/data/assets/logo.png", "scratchpad/logo.png")).toMatchObject({
          bytes: PNG.byteLength,
        });
        const [png] = await backend.downloadFiles!(["/scratchpad/logo.png"]);
        expect(Buffer.from(png!.content!)).toEqual(PNG);
      },
      { memory: true },
    ));

  it("copies text and typed binaries through a backend with no raw transfer, and refuses what it cannot", () =>
    withWorkspace(async (root, { backend }) => {
      const bare: BackendProtocolV2 = {
        ls: (p) => backend.ls(p),
        read: (p, o, l) => backend.read(p, o, l),
        readRaw: (p) => backend.readRaw(p),
        grep: (p, path, g) => backend.grep(p, path, g),
        glob: (p, path) => backend.glob(p, path),
        write: (p, c) => backend.write(p, c),
        edit: (p, a, b, r) => backend.edit(p, a, b, r),
      };
      await copyWorkspaceFile(bare, "skills/data/assets/template.md", "scratchpad/t.md");
      await copyWorkspaceFile(bare, "skills/data/assets/logo.png", "scratchpad/logo.png");
      expect(readFileSync(sessionFile(root, "scratchpad/t.md"), "utf8")).toBe(LONG);
      expect(readFileSync(sessionFile(root, "scratchpad/logo.png"))).toEqual(PNG);
      // Without the raw channel a non-UTF-8 file arrives already decoded, so
      // the copy refuses it rather than write bytes the source never held.
      expect(await copyWorkspaceFile(bare, "skills/data/assets/latin1.txt", "scratchpad/latin1.txt")).toEqual({
        error:
          "Cannot copy 'skills/data/assets/latin1.txt': it is not UTF-8 text, and the store serving it " +
          "cannot hand over its bytes unchanged.",
      });
      expect(existsSync(sessionFile(root, "scratchpad/latin1.txt"))).toBe(false);
    }));
});

describe("moveWorkspaceFile", () => {
  it("writes the destination, then removes the source", () =>
    withWorkspace(async (root, { backend, mountPrefixes }) => {
      await copyWorkspaceFile(backend, "skills/data/assets/template.docx", "scratchpad/a.docx");
      expect(await moveWorkspaceFile(backend, "scratchpad/a.docx", "drafts/b.docx", { mountPrefixes })).toEqual({
        source: "scratchpad/a.docx",
        destination: "drafts/b.docx",
        bytes: DOCX.byteLength,
      });
      expect(readFileSync(sessionFile(root, "drafts/b.docx"))).toEqual(DOCX);
      expect(existsSync(sessionFile(root, "scratchpad/a.docx"))).toBe(false);
    }));

  it("refuses a source in a read-only mount before writing anything", () =>
    withWorkspace(async (root, { backend, mountPrefixes }) => {
      expect(
        await moveWorkspaceFile(backend, "skills/data/assets/logo.png", "scratchpad/logo.png", { mountPrefixes }),
      ).toEqual({
        error:
          "Cannot move 'skills/data/assets/logo.png': it is served by a read-only mount, so it cannot be " +
          "removed. Use copy_file to copy it instead.",
      });
      expect(existsSync(sessionFile(root, "scratchpad/logo.png"))).toBe(false);
      expect(existsSync(join(root, "skills/data/assets/logo.png"))).toBe(true);
    }));

  it("follows the overwrite rule and refuses a missing source", () =>
    withWorkspace(async (root, { backend, mountPrefixes }) => {
      await backend.write("/scratchpad/a.md", "alpha");
      await backend.write("/scratchpad/b.md", "beta");
      expect(await moveWorkspaceFile(backend, "scratchpad/a.md", "scratchpad/b.md", { mountPrefixes })).toMatchObject({
        error: expect.stringContaining("a file is already there"),
      });
      expect(readFileSync(sessionFile(root, "scratchpad/a.md"), "utf8")).toBe("alpha");
      await moveWorkspaceFile(backend, "scratchpad/a.md", "scratchpad/b.md", { overwrite: true, mountPrefixes });
      expect(readFileSync(sessionFile(root, "scratchpad/b.md"), "utf8")).toBe("alpha");
      expect(existsSync(sessionFile(root, "scratchpad/a.md"))).toBe(false);
      expect(await moveWorkspaceFile(backend, "scratchpad/a.md", "scratchpad/c.md", { mountPrefixes })).toEqual({
        error: "Cannot move 'scratchpad/a.md': it does not exist.",
      });
    }));

  it("moves within the memory store", () =>
    withWorkspace(
      async (_root, { backend, mountPrefixes }) => {
        await backend.write("/scratchpad/a.md", "alpha");
        await moveWorkspaceFile(backend, "scratchpad/a.md", "scratchpad/b.md", { mountPrefixes });
        expect((await backend.readRaw("/scratchpad/b.md")).data?.content).toBe("alpha");
        expect((await backend.readRaw("/scratchpad/a.md")).error).toBeDefined();
      },
      { memory: true },
    ));
});

describe("removeWorkspaceFile", () => {
  it("removes one file", () =>
    withWorkspace(async (root, { backend }) => {
      await backend.write("/scratchpad/a.md", "alpha");
      expect(await removeWorkspaceFile(backend, "./scratchpad/a.md")).toEqual({ source: "scratchpad/a.md" });
      expect(existsSync(sessionFile(root, "scratchpad/a.md"))).toBe(false);
    }));

  it("refuses a missing file, a folder, and a file in a read-only mount", () =>
    withWorkspace(async (root, { backend }) => {
      await backend.write("/scratchpad/dir/a.md", "alpha");
      expect(await removeWorkspaceFile(backend, "scratchpad/missing.md")).toEqual({
        error: "Cannot remove 'scratchpad/missing.md': it does not exist.",
      });
      expect(await removeWorkspaceFile(backend, "scratchpad/dir")).toEqual({
        error: "Cannot remove 'scratchpad/dir': it is a directory; this tool works on one file.",
      });
      expect(existsSync(sessionFile(root, "scratchpad/dir/a.md"))).toBe(true);
      expect(await removeWorkspaceFile(backend, "skills/data/assets/logo.png")).toEqual({
        error: "Cannot remove 'skills/data/assets/logo.png': it is served by a read-only mount.",
      });
      expect(existsSync(join(root, "skills/data/assets/logo.png"))).toBe(true);
    }));
});

describe("the file-operation tools", () => {
  it("answer with one line on success and an error line on failure", () =>
    withWorkspace(async (_root, ctx) => {
      const [copy, move, remove] = createFileOperationTools(ctx);
      expect([copy!.name, move!.name, remove!.name]).toEqual(["copy_file", "move_file", "remove_file"]);
      expect(await copy!.invoke({ source: "skills/data/assets/logo.png", destination: "scratchpad/logo.png" })).toBe(
        "Copied 'skills/data/assets/logo.png' to 'scratchpad/logo.png' (11 B).",
      );
      expect(await move!.invoke({ source: "scratchpad/logo.png", destination: "scratchpad/brand.png" })).toBe(
        "Moved 'scratchpad/logo.png' to 'scratchpad/brand.png' (11 B).",
      );
      expect(await remove!.invoke({ file_path: "scratchpad/brand.png" })).toBe("Removed 'scratchpad/brand.png'.");
      expect(await remove!.invoke({ file_path: "scratchpad/brand.png" })).toBe(
        "Error: Cannot remove 'scratchpad/brand.png': it does not exist.",
      );
    }));
});

describe("a copy is verified on every backend", () => {
  /**
   * A store like a key-value tree that keeps whatever `write` hands it — the
   * base64 string as given — and offers raw transfer and deletion only when asked.
   */
  function literalStore(options: { upload?: boolean; remove?: boolean } = {}) {
    const files = new Map<string, string | Uint8Array>([["/src/logo.png", new Uint8Array(PNG)]]);
    const stamp = "2026-10-07T00:00:00.000Z";
    const backend: BackendProtocolV2 = {
      ls: () => ({ files: [] }),
      read: () => ({ error: "unused" }),
      readRaw: (path) => {
        const content = files.get(path);
        if (content === undefined) return { error: `File '${path}' not found` };
        return { data: { content, mimeType: "application/octet-stream", created_at: stamp, modified_at: stamp } };
      },
      grep: () => ({ matches: [] }),
      glob: () => ({ files: [] }),
      write: (path, content) => {
        files.set(path, content);
        return { path, filesUpdate: null };
      },
      edit: () => ({ error: "unused" }),
      ...(options.upload
        ? {
            uploadFiles: (batch: Array<[string, Uint8Array]>) =>
              batch.map(([path, content]) => {
                files.set(path, content);
                return { path, error: null };
              }),
          }
        : {}),
      ...(options.remove
        ? {
            delete: (path: string) => {
              files.delete(path);
              return { path };
            },
          }
        : {}),
    };
    return { backend, files };
  }

  it("refuses a copy the store kept as base64 text, and removes what it created", async () => {
    const { backend, files } = literalStore({ remove: true });
    expect(await copyWorkspaceFile(backend, "src/logo.png", "out/copy.png")).toEqual({
      error:
        "Cannot copy to 'out/copy.png': the store serving it did not keep the file's bytes — a write " +
        "to a binary-typed path carries base64, which the store must decode, and it did not. Nothing was kept.",
    });
    expect(files.has("/out/copy.png")).toBe(false);
  });

  it("says what is left when it cannot remove it", async () => {
    const { backend, files } = literalStore();
    expect(await copyWorkspaceFile(backend, "src/logo.png", "out/copy.png")).toMatchObject({
      error: expect.stringMatching(/'out\/copy.png' was left as the store wrote it\.$/),
    });
    expect(typeof files.get("/out/copy.png")).toBe("string");
  });

  it("carries the bytes raw when the text channel did not keep them", async () => {
    const { backend, files } = literalStore({ upload: true });
    expect(await copyWorkspaceFile(backend, "src/logo.png", "out/copy.png")).toEqual({
      source: "src/logo.png",
      destination: "out/copy.png",
      bytes: PNG.byteLength,
    });
    expect(Buffer.from(files.get("/out/copy.png") as Uint8Array)).toEqual(PNG);
  });
});
