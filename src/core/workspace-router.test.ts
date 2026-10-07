import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { BackendProtocolV2 } from "deepagents";
import { defaultMounts } from "./mounts.js";
import { createWorkspaceContext } from "./workspace-context.js";
import { WorkspacePathEscapeError } from "./workspace-router.js";

/**
 * The workspace router's contract is spelling-independence: `CompositeBackend`
 * routes by literal `startsWith` against absolute mount keys (`/skills/`), so an
 * unnormalized relative path would miss its mount and fall through to the
 * session zone — a read reporting the file missing and a write landing in run
 * state instead of being refused. Meanwhile Deep Agents' own tool descriptions
 * tell the model `ls` "requires absolute path" while this workspace's authoring
 * convention is relative (`skills/orders.json`), so both spellings reach the
 * router in practice and neither may be the privileged one.
 *
 * These cases pin that symmetry per operation. They are the guard against a
 * regression that would not fail loudly: misrouting is silent, surfacing only as
 * an agent being told a file it can see does not exist.
 */

const SPELLINGS = ["skills/orders.json", "/skills/orders.json", "./skills/orders.json", "//skills//orders.json"];

function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "archmax-router-"));
  mkdirSync(join(root, "skills"), { recursive: true });
  writeFileSync(join(root, "skills", "orders.json"), '[{"id":"A-1"}]');
  writeFileSync(join(root, "AGENTS.md"), "persona");
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe("workspace router path spellings", () => {
  it("reads an authored file through every equivalent spelling", () =>
    withWorkspace(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });
      await ctx.sessionZone.sessionScoped("s1", async () => {
        for (const spelling of SPELLINGS) {
          const res = await ctx.backend.read(spelling);
          expect(res.error, `read ${spelling}`).toBeUndefined();
          expect(String(res.content), `read ${spelling}`).toContain("A-1");
        }
      });
    }));

  it("lists an authored directory through every equivalent spelling, with or without a trailing slash", () =>
    withWorkspace(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });
      await ctx.sessionZone.sessionScoped("s1", async () => {
        for (const spelling of ["skills", "/skills", "skills/", "/skills/", "./skills"]) {
          const res = await ctx.backend.ls(spelling);
          expect(res.error, `ls ${spelling}`).toBeUndefined();
          // Result paths come back in one canonical leading-slash form whatever
          // was asked, so a listing can be fed straight back into a read.
          expect(res.files?.map((f) => f.path), `ls ${spelling}`).toEqual(["/skills/orders.json"]);
        }
      });
    }));

  it("scopes glob and grep to the authored mount through either spelling", () =>
    withWorkspace(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });
      await ctx.sessionZone.sessionScoped("s1", async () => {
        for (const spelling of ["skills", "/skills"]) {
          const globbed = await ctx.backend.glob("**/*.json", spelling);
          expect(globbed.files?.map((f) => f.path), `glob ${spelling}`).toEqual([
            "/skills/orders.json",
          ]);
          const grepped = await ctx.backend.grep("A-1", spelling);
          expect(grepped.matches?.map((m) => m.path), `grep ${spelling}`).toEqual([
            "/skills/orders.json",
          ]);
        }
      });
    }));

  it("writes run state to the same file whichever spelling addresses it", () =>
    withWorkspace(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });
      await ctx.sessionZone.sessionScoped("s1", async () => {
        expect((await ctx.backend.write("output/reply.json", '{"v":1}')).error).toBeUndefined();
        // The absolute spelling resolves to the file the relative one created,
        // rather than a second shadow file at a different key.
        const res = await ctx.backend.read("/output/reply.json");
        expect(res.error).toBeUndefined();
        expect(String(res.content)).toContain('"v":1');
        expect((await ctx.backend.ls("/output")).files?.map((f) => f.path)).toEqual([
          "/output/reply.json",
        ]);
      });
    }));

  it("refuses an authored write under either spelling, naming the path the caller sent", () =>
    withWorkspace(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });
      await ctx.sessionZone.sessionScoped("s1", async () => {
        for (const spelling of ["skills/orders.json", "/skills/orders.json"]) {
          const res = await ctx.backend.write(spelling, "tampered");
          // A refusal that named the composite's stripped key ('/orders.json')
          // would point the agent at a path it never asked about.
          expect(res.error, `write ${spelling}`).toContain("skills/orders.json");
          expect(res.error, `write ${spelling}`).toContain("read-only mount");
        }
        const untouched = await ctx.backend.read("skills/orders.json");
        expect(String(untouched.content)).toContain("A-1");
      });
    }));

  it("names a refused file mount by its own key", () =>
    withWorkspace(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });
      await ctx.sessionZone.sessionScoped("s1", async () => {
        const res = await ctx.backend.write("AGENTS.md", "tampered");
        expect(res.error).toContain("'AGENTS.md'");
      });
    }));

  it("treats the empty path as the root listing, like '/'", () =>
    withWorkspace(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });
      await ctx.sessionZone.sessionScoped("s1", async () => {
        const slash = await ctx.backend.ls("/");
        const empty = await ctx.backend.ls("");
        expect(empty.files?.map((f) => f.path)).toEqual(slash.files?.map((f) => f.path));
        expect(slash.files?.map((f) => f.path)).toContain("/skills/");
      });
    }));

  it("rejects a path that climbs above the workspace root instead of routing it", () =>
    withWorkspace(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });
      await ctx.sessionZone.sessionScoped("s1", async () => {
        // `ls` is async, so its refusal arrives as a rejection; the remaining
        // operations raise before returning their promise. Both shapes reach a
        // tool caller the same way (it awaits), and the message names the path.
        await expect(ctx.backend.ls("../")).rejects.toThrow(WorkspacePathEscapeError);
        expect(() => ctx.backend.read("../secrets.env")).toThrow(WorkspacePathEscapeError);
        expect(() => ctx.backend.write("data/../../escape.txt", "x")).toThrow(
          /resolves outside the workspace root/,
        );
      });
    }));
});

/**
 * A mount declared `searchable: false` stands for a backend a search would be
 * expensive or impossible against (a remote folder served live). The composite's
 * fan-out cannot tell an addressed search from a root-wide one — it hands the
 * route `/` either way — so the router decides by where the search was
 * addressed: a fan-out never enters the mount, and a search addressed at it
 * reaches the backend so the backend's own answer comes back verbatim.
 */
describe("workspace router search posture", () => {
  const REFUSAL = "contracts is a live folder: searching it would download it";

  /** A backend that lists and reads but refuses every search, with spies. */
  function refusing() {
    const grep = vi.fn(async () => ({ error: REFUSAL }));
    const glob = vi.fn(async () => ({ error: REFUSAL }));
    const backend = {
      ls: async (path: string) => ({
        files: path === "/" ? [{ path: "/2026/", is_dir: true }] : [{ path: "/2026/a.md", is_dir: false }],
      }),
      read: async () => "contract text",
      readRaw: async () => ({ data: { content: "contract text", encoding: "text" } }),
      grep,
      glob,
      write: async () => ({ error: "read-only" }),
      edit: async () => ({ error: "read-only" }),
    } as unknown as BackendProtocolV2;
    return { backend, grep, glob };
  }

  const withContracts = <T>(
    fn: (ctx: ReturnType<typeof createWorkspaceContext>, spies: ReturnType<typeof refusing>) => Promise<T>,
    extra: Record<string, import("./mounts.js").MountSpec> = {},
  ) =>
    withWorkspace(async (root) => {
      const spies = refusing();
      const ctx = createWorkspaceContext({
        rootDir: root,
        mounts: {
          ...defaultMounts(root),
          "/contracts/": { backend: spies.backend, governed: true, searchable: false },
          ...extra,
        },
      });
      return ctx.sessionZone.sessionScoped("s1", () => fn(ctx, spies));
    });

  it("keeps a root-wide grep and glob away from the refusing mount", () =>
    withContracts(async (ctx, spies) => {
      for (const at of [undefined, "/", ""]) {
        const grepped = await ctx.backend.grep("A-1", at);
        expect(grepped.error, `grep at ${JSON.stringify(at)}`).toBeUndefined();
        expect(grepped.matches?.map((m) => m.path)).toEqual(["/skills/orders.json"]);
        const globbed = await ctx.backend.glob("**/*.json", at);
        expect(globbed.error, `glob at ${JSON.stringify(at)}`).toBeUndefined();
        expect(globbed.files?.map((f) => f.path)).toEqual(["/skills/orders.json"]);
      }
      expect(spies.grep).not.toHaveBeenCalled();
      expect(spies.glob).not.toHaveBeenCalled();
    }));

  it("hands a search addressed at the mount to its backend and returns the refusal verbatim", () =>
    withContracts(async (ctx, spies) => {
      for (const spelling of ["contracts", "/contracts/", "./contracts"]) {
        expect(await ctx.backend.grep("x", spelling), `grep ${spelling}`).toEqual({ error: REFUSAL });
        expect(spies.grep).toHaveBeenLastCalledWith("x", "/", undefined);
      }
      expect(await ctx.backend.glob("**/*.md", "/contracts/2026")).toEqual({ error: REFUSAL });
      expect(spies.glob).toHaveBeenLastCalledWith("**/*.md", "/2026");
      expect(await ctx.backend.grep("x", "contracts/2026", "*.md")).toEqual({ error: REFUSAL });
      expect(spies.grep).toHaveBeenLastCalledWith("x", "/2026", "*.md");
    }));

  it("returns an addressed search that succeeds in workspace form", () =>
    withContracts(async (ctx, spies) => {
      spies.grep.mockResolvedValueOnce({
        matches: [{ path: "/2026/a.md", line: 1, text: "x" }],
      } as never);
      spies.glob.mockResolvedValueOnce({
        files: [{ path: "/2026/a.md", is_dir: false }],
        truncated: true,
      } as never);
      const grepped = await ctx.backend.grep("x", "contracts/2026");
      expect(grepped.matches?.map((m) => m.path)).toEqual(["/contracts/2026/a.md"]);
      const globbed = await ctx.backend.glob("*.md", "contracts/2026");
      expect(globbed.files?.map((f) => f.path)).toEqual(["/contracts/2026/a.md"]);
      expect(globbed.truncated).toBe(true);
    }));

  it("still lists and reads the mount", () =>
    withContracts(async (ctx) => {
      const root = await ctx.backend.ls("/");
      expect(root.files?.map((f) => f.path)).toContain("/contracts/");
      const inside = await ctx.backend.ls("contracts/2026");
      expect(inside.files?.map((f) => f.path)).toEqual(["/contracts/2026/a.md"]);
      expect(await ctx.backend.read("contracts/2026/a.md")).toMatchObject({ content: "contract text" });
    }));

  it("skips a nested unsearchable mount when searching its ancestor", () =>
    withWorkspace(async (root) => {
      const spies = refusing();
      const ctx = createWorkspaceContext({
        rootDir: root,
        mounts: { ...defaultMounts(root), "/catalogs/eu/": { backend: spies.backend, searchable: false } },
      });
      await ctx.sessionZone.sessionScoped("s1", async () => {
        const grepped = await ctx.backend.grep("x", "/catalogs");
        expect(grepped.error).toBeUndefined();
        expect(spies.grep).not.toHaveBeenCalled();
        expect(await ctx.backend.grep("x", "catalogs/eu/2026")).toEqual({ error: REFUSAL });
      });
    }));

  it("routes by longest prefix, so a searchable mount inside an unsearchable one is searched", () =>
    withWorkspace(async (root) => {
      const spies = refusing();
      const inner = vi.fn(async () => ({ matches: [{ path: "/reports/q1.md", line: 1, text: "x" }] }));
      const innerBackend = { ...refusing().backend, grep: inner } as unknown as BackendProtocolV2;
      const ctx = createWorkspaceContext({
        rootDir: root,
        mounts: {
          ...defaultMounts(root),
          "/data/": { backend: spies.backend, searchable: false },
          "/data/public/": innerBackend,
        },
      });
      await ctx.sessionZone.sessionScoped("s1", async () => {
        const grepped = await ctx.backend.grep("x", "data/public/reports");
        expect(grepped.matches?.map((m) => m.path)).toEqual(["/data/public/reports/q1.md"]);
        // The composite adds its own trailing arguments; the routing is what matters.
        expect(inner.mock.lastCall?.slice(0, 2)).toEqual(["x", "/reports"]);
        expect(spies.grep).not.toHaveBeenCalled();
        // The root-wide search still reaches the searchable inner mount only.
        const wide = await ctx.backend.grep("x");
        expect(wide.error).toBeUndefined();
        expect(wide.matches?.map((m) => m.path)).toContain("/data/public/reports/q1.md");
        expect(spies.grep).not.toHaveBeenCalled();
      });
    }));

  it("lists every route, searchable or not, on the composite duck-type", () =>
    withContracts(async (ctx) => {
      expect((ctx.backend as { routePrefixes?: string[] }).routePrefixes).toContain("/contracts/");
    }));
});

describe("workspace router text-only reads", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0xc3, 0x28]);

  /** A consumer backend that answers every read with the given result. */
  function answering(result: unknown): BackendProtocolV2 {
    return {
      ls: async () => ({ files: [] }),
      read: async () => result,
      readRaw: async () => ({ error: "unused" }),
      grep: async () => ({ matches: [] }),
      glob: async () => ({ files: [] }),
      write: async () => ({ error: "read-only" }),
      edit: async () => ({ error: "read-only" }),
    } as unknown as BackendProtocolV2;
  }

  const withAssets = <T>(
    fn: (ctx: ReturnType<typeof createWorkspaceContext>) => Promise<T>,
    extra: Record<string, import("./mounts.js").MountSpec> = {},
  ) =>
    withWorkspace(async (root) => {
      writeFileSync(join(root, "skills", "logo.png"), PNG);
      writeFileSync(join(root, "skills", "export.zip"), ZIP);
      writeFileSync(join(root, "skills", "icon.svg"), "<svg/>");
      const ctx = createWorkspaceContext({ rootDir: root, mounts: { ...defaultMounts(root), ...extra } });
      return ctx.sessionZone.sessionScoped("s1", () => fn(ctx));
    });

  it("refuses an image by its type, naming the path, the type and the size", () =>
    withAssets(async (ctx) => {
      const res = await ctx.backend.read("/skills/logo.png");
      expect(res).toEqual({
        error:
          "'skills/logo.png' is a binary file (image/png, 10 B) and was not read; read_file returns text files only.",
      });
    }));

  it("refuses an unknown-extension binary by its NUL bytes", () =>
    withAssets(async (ctx) => {
      const res = await ctx.backend.read("skills/export.zip");
      expect(res.content).toBeUndefined();
      expect(res.error).toContain("'skills/export.zip' is a binary file (application/octet-stream)");
    }));

  it("refuses bytes a custom mount serves, and bytes a file mount serves", () =>
    withAssets(
      async (ctx) => {
        const viaDir = await ctx.backend.read("uploads/scan");
        expect(viaDir.error).toContain("'uploads/scan' is a binary file (image/png, 3 B)");
        const viaFile = await ctx.backend.read("COVER.png");
        expect(viaFile.error).toContain("'COVER.png' is a binary file (image/png, 2 B)");
      },
      {
        "/uploads/": answering({ content: new Uint8Array(3), mimeType: "image/png" }),
        "/COVER.png": answering({ content: new Uint8Array(2), mimeType: "image/png" }),
      },
    ));

  it("passes a route's own error through", () =>
    withAssets(async (ctx) => {
      const res = await ctx.backend.read("skills/missing.png");
      expect(res.error).toBeDefined();
      expect(res.error).not.toContain("binary file");
    }));

  it("reads text unchanged: JSON, SVG and a v1 file mount's bare string", () =>
    withAssets(
      async (ctx) => {
        expect(String((await ctx.backend.read("skills/orders.json")).content)).toContain("A-1");
        expect(String((await ctx.backend.read("skills/icon.svg")).content)).toContain("<svg/>");
        expect(await ctx.backend.read("NOTES.md")).toBe("plain notes");
      },
      { "/NOTES.md": answering("plain notes") },
    ));

  it("refuses a v1 file mount's bare string carrying NUL", () =>
    withAssets(
      async (ctx) => {
        expect((await ctx.backend.read("DATA.bin")).error).toContain("'DATA.bin' is a binary file");
      },
      { "/DATA.bin": answering("ab\u0000cd") },
    ));

  it("leaves readRaw alone: the runtime still gets the bytes", () =>
    withAssets(async (ctx) => {
      const res = await ctx.backend.readRaw("skills/logo.png");
      expect(res.error).toBeUndefined();
      expect(res.data?.content).toBeInstanceOf(Uint8Array);
    }));
});

describe("workspace router raw-byte transfer", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

  it("downloads from a directory mount, a file mount and the session zone", () =>
    withWorkspace(async (root) => {
      writeFileSync(join(root, "skills", "logo.png"), PNG);
      const ctx = createWorkspaceContext({ rootDir: root });
      await ctx.sessionZone.sessionScoped("s1", async () => {
        await ctx.backend.write("scratchpad/notes.md", "hello");
        const res = await ctx.backend.downloadFiles!(["./skills/logo.png", "AGENTS.md", "scratchpad/notes.md"]);
        expect(res.map((r) => r.path)).toEqual(["/skills/logo.png", "/AGENTS.md", "/scratchpad/notes.md"]);
        expect(res.map((r) => r.error)).toEqual([null, null, null]);
        expect(Buffer.from(res[0]!.content!)).toEqual(Buffer.from(PNG));
        expect(new TextDecoder().decode(res[1]!.content!)).toBe("persona");
        expect(new TextDecoder().decode(res[2]!.content!)).toBe("hello");
      });
    }));

  it("uploads bytes into the session zone, under the bound session", () =>
    withWorkspace(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });
      await ctx.sessionZone.sessionScoped("s1", async () => {
        const res = await ctx.backend.uploadFiles!([["scratchpad/logo.png", PNG]]);
        expect(res).toEqual([{ path: "/scratchpad/logo.png", error: null }]);
        const [back] = await ctx.backend.downloadFiles!(["scratchpad/logo.png"]);
        expect(Buffer.from(back!.content!)).toEqual(Buffer.from(PNG));
      });
    }));

  it("refuses an upload into a read-only directory mount or file mount", () =>
    withWorkspace(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });
      await ctx.sessionZone.sessionScoped("s1", async () => {
        const res = await ctx.backend.uploadFiles!([
          ["skills/orders.json", PNG],
          ["AGENTS.md", PNG],
        ]);
        expect(res.map((r) => r.error)).toEqual(["permission_denied", "permission_denied"]);
        const orders = await ctx.backend.readRaw("skills/orders.json");
        expect(orders.data?.content).toContain("A-1");
      });
    }));

  it("reports a missing file as the route does", () =>
    withWorkspace(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });
      await ctx.sessionZone.sessionScoped("s1", async () => {
        const [res] = await ctx.backend.downloadFiles!(["scratchpad/missing.png"]);
        expect(res).toEqual({ path: "/scratchpad/missing.png", content: null, error: "file_not_found" });
      });
    }));
});

describe("workspace router deletion", () => {
  it("deletes a session file under the bound session", () =>
    withWorkspace(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });
      await ctx.sessionZone.sessionScoped("s1", async () => {
        await ctx.backend.uploadFiles!([["scratchpad/a.png", new Uint8Array([1, 2, 3])]]);
        const res = await ctx.backend.delete!("./scratchpad/a.png");
        expect(res.error).toBeUndefined();
        // The session id never reaches a result path.
        expect(res.path).toBe("/scratchpad/a.png");
        const [gone] = await ctx.backend.downloadFiles!(["scratchpad/a.png"]);
        expect(gone?.error).toBe("file_not_found");
      });
    }));

  it("refuses a delete in a read-only directory or file mount, naming the path as written", () =>
    withWorkspace(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });
      await ctx.sessionZone.sessionScoped("s1", async () => {
        expect(await ctx.backend.delete!("skills/orders.json")).toEqual({
          error:
            "Cannot delete 'skills/orders.json': it is served by a read-only mount. " +
            "Only run state is writable in this workspace.",
        });
        expect((await ctx.backend.delete!("AGENTS.md")).error).toMatch(/read-only mount/);
        const orders = await ctx.backend.readRaw("skills/orders.json");
        expect(orders.data?.content).toContain("A-1");
      });
    }));
});
