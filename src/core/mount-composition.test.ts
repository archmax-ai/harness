import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemBackend } from "deepagents";
import { MountCollisionError, defaultMounts } from "./mounts.js";
import { DEFAULT_SESSIONS_DIR, createMemorySessionStore } from "./session-store.js";
import { createWorkspaceContext } from "./workspace-context.js";

/**
 * The properties that follow from mounts being a consumer-composed route table:
 * the conventional default works with no options, an extra mount needs no
 * framework change, a writable mount is expressible, unmounted content (including
 * credentials) is simply not served, and a mount shadowing a run area is refused.
 */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "mount-comp-"));
  mkdirSync(join(root, "skills"), { recursive: true });
  writeFileSync(join(root, "skills", "orders.json"), "[]");
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(join(root, "templates", "reply.md"), "hello template");
  writeFileSync(join(root, "AGENTS.md"), "persona");
  writeFileSync(join(root, ".env"), "ARCHMAX_API_KEY=secret");
  return root;
}

const withWorkspace = async (fn: (root: string) => Promise<void>) => {
  const root = workspace();
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe("mount composition", () => {
  it("applies the conventional default with no options, leaving unnamed paths unserved", () =>
    withWorkspace(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });
      expect(ctx.mountPrefixes.dirs).toContain("skills");
      expect(ctx.mountPrefixes.files).toEqual(["AGENTS.md"]);

      await ctx.sessionZone.sessionScoped("t1", async () => {
        expect(await ctx.workspace.readText("skills/orders.json")).toBe("[]");
        expect(await ctx.workspace.readText("AGENTS.md")).toBe("persona");
        // Never mounted, so never served — no exclusion rule needed.
        expect(await ctx.workspace.readText(".env")).toBeNull();
        expect(await ctx.workspace.readText("templates/reply.md")).toBeNull();
      });
    }));

  it("extends the default with one spread, and refuses writes to the added mount", () =>
    withWorkspace(async (root) => {
      const ctx = createWorkspaceContext({
        rootDir: root,
        mounts: {
          ...defaultMounts(root),
          "/templates/": new FilesystemBackend({
            rootDir: join(root, "templates"),
            virtualMode: true,
          }),
        },
      });
      expect(ctx.mountPrefixes.dirs).toContain("templates");

      await ctx.sessionZone.sessionScoped("t1", async () => {
        expect(await ctx.workspace.readText("templates/reply.md")).toBe("hello template");
        await expect(ctx.workspace.writeText("templates/reply.md", "no")).rejects.toThrow(
          /read-only/,
        );
        await expect(ctx.workspace.writeText("AGENTS.md", "no")).rejects.toThrow(/read-only/);
      });
      // Refused at the mount: the authored file is untouched and no shadow copy
      // was created in run state.
      expect(existsSync(join(root, DEFAULT_SESSIONS_DIR, "t1", "templates"))).toBe(false);
    }));

  it("serves a declared writable mount", () =>
    withWorkspace(async (root) => {
      const shared = createMemorySessionStore().backend;
      const ctx = createWorkspaceContext({
        rootDir: root,
        mounts: { ...defaultMounts(root), "/memories/": { backend: shared, readOnly: false } },
      });
      expect(ctx.mountPrefixes.writable).toEqual(["memories"]);

      await ctx.sessionZone.sessionScoped("t1", async () => {
        await ctx.workspace.writeText("memories/note.md", "remembered");
        expect(await ctx.workspace.readText("memories/note.md")).toBe("remembered");
      });
      // It lives in the mounted store, not in the session's run folder.
      expect(existsSync(join(root, DEFAULT_SESSIONS_DIR, "t1", "memories"))).toBe(false);
      expect((await shared.readRaw("/note.md")) as { data?: { content?: unknown } }).toMatchObject({
        data: { content: "remembered" },
      });
    }));

  it("serves a searchable table through one composite, and a refusing mount does not break root-wide search", () =>
    withWorkspace(async (root) => {
      // No unsearchable mount: the router's search path and routing path are one
      // composite, so nothing about an existing table can differ.
      const plain = createWorkspaceContext({ rootDir: root });
      expect(plain.mountPrefixes.unsearchable).toEqual([]);
      await plain.sessionZone.sessionScoped("s1", async () => {
        const wide = await plain.backend.grep("hello");
        expect(wide.matches?.map((m) => m.path)).toEqual([]);
      });
      // An unsearchable mount is routed for every non-search operation and left
      // out of the fan-out only.
      const refusing = {
        ls: async () => ({ files: [{ path: "/a.md", is_dir: false }] }),
        read: async () => "remote",
        readRaw: async () => ({ data: { content: "remote", encoding: "text" } }),
        grep: async () => ({ error: "refused" }),
        glob: async () => ({ error: "refused" }),
        write: async () => ({ error: "read-only" }),
        edit: async () => ({ error: "read-only" }),
      } as unknown as import("deepagents").BackendProtocolV2;
      const ctx = createWorkspaceContext({
        rootDir: root,
        mounts: { ...defaultMounts(root), "/remote/": { backend: refusing, searchable: false } },
      });
      expect(ctx.mountPrefixes.unsearchable).toEqual(["remote"]);
      await ctx.sessionZone.sessionScoped("s1", async () => {
        expect((await ctx.backend.grep("hello")).error).toBeUndefined();
        expect((await ctx.backend.glob("**/*")).error).toBeUndefined();
        expect(await ctx.backend.grep("hello", "remote")).toEqual({ error: "refused" });
        expect(await ctx.backend.read("remote/a.md")).toMatchObject({ content: "remote" });
        expect((await ctx.backend.ls("/")).files?.map((f) => f.path)).toContain("/remote/");
      });
    }));

  it("refuses a mount that would shadow a run area", () =>
    withWorkspace(async (root) => {
      expect(() =>
        createWorkspaceContext({
          rootDir: root,
          mounts: { "/scratchpad/": new FilesystemBackend({ rootDir: root, virtualMode: true }) },
        }),
      ).toThrow(MountCollisionError);
    }));

  it("serves nothing authored for a custom backend with no mounts declared", () =>
    withWorkspace(async (root) => {
      const ctx = createWorkspaceContext({
        rootDir: root,
        backend: new FilesystemBackend({ rootDir: root, virtualMode: true }),
        sessionStore: createMemorySessionStore(),
      });
      expect(ctx.mountPrefixes).toEqual({ dirs: [], files: [], writable: [], governed: [], unsearchable: [] });
      await ctx.sessionZone.sessionScoped("t1", async () => {
        expect(await ctx.workspace.readText("skills/orders.json")).toBeNull();
      });
    }));
});
