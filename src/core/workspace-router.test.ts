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
