import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBackendSessionStore,
  createFilesystemSessionStore,
  createMemorySessionStore,
  SessionStoreCapabilityError,
  SessionStoreIdError,
  sessionIdRejection,
} from "./session-store.js";

describe("createFilesystemSessionStore", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("lists and deletes session folders", async () => {
    dir = mkdtempSync(join(tmpdir(), "run-store-"));
    mkdirSync(join(dir, "session-1", "checkpoints"), { recursive: true });
    writeFileSync(join(dir, "session-1", "checkpoints", "cp.json"), "{}");

    const store = createFilesystemSessionStore({ dir });
    expect(store.kind).toBe("filesystem");
    expect(store.capabilities).toEqual({ list: true, delete: true });

    const ls = await store.backend.ls("/");
    expect((ls.files ?? []).map((f) => f.path)).toContain("/session-1/");

    expect(await store.deleteSession("session-1")).toBe(true);
    expect(existsSync(join(dir, "session-1"))).toBe(false);
    expect(await store.deleteSession("session-1")).toBe(false);
  });

  it("refuses to delete outside the session zone via '..' traversal", async () => {
    dir = mkdtempSync(join(tmpdir(), "run-store-"));
    const runDir = join(dir, "run");
    const victim = join(dir, "victim");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "important.txt"), "keep me");

    const store = createFilesystemSessionStore({ dir: runDir });
    await expect(store.deleteSession("../victim")).rejects.toBeInstanceOf(SessionStoreIdError);
    await expect(store.deleteSession("/../victim")).rejects.toBeInstanceOf(SessionStoreIdError);
    await expect(store.deleteSession("a/../../victim")).rejects.toBeInstanceOf(
      SessionStoreIdError,
    );
    await expect(store.deleteSession("")).rejects.toBeInstanceOf(SessionStoreIdError);
    // The sibling directory survives every attempt.
    expect(existsSync(victim)).toBe(true);
  });

  it("refuses a session id colliding with a run area", async () => {
    dir = mkdtempSync(join(tmpdir(), "run-store-"));
    const store = createFilesystemSessionStore({ dir: join(dir, "run") });

    // The framework reserves its own run areas with no workspace knowledge.
    for (const id of ["_specs", "scratchpad", "checkpoints", "artifacts"]) {
      await expect(store.deleteSession(id)).rejects.toBeInstanceOf(SessionStoreIdError);
      expect(sessionIdRejection(id)).toContain("reserved");
    }
    // Ordinary ids stay usable — including `output`, which the framework
    // stopped owning when the run gained a single working area.
    expect(sessionIdRejection("session-1")).toBeNull();
    expect(sessionIdRejection("output")).toBeNull();
  });

  it("refuses a session id colliding with a declared mount when told the mounts", () => {
    const mounts = { dirs: ["skills", "data"], files: ["AGENTS.md"], writable: [], governed: [], unsearchable: [] };
    // Mount names are workspace shape: reserved only once the caller supplies
    // the resolved keys (assembly does).
    expect(sessionIdRejection("skills")).toBeNull();
    for (const id of ["skills", "data", "AGENTS.md"]) {
      expect(sessionIdRejection(id, mounts), id).toContain("reserved");
    }
    expect(sessionIdRejection("session-1", mounts)).toBeNull();
  });
});

describe("createBackendSessionStore", () => {
  it("prefixes every operation inside the store", async () => {
    const memory = createMemorySessionStore();
    const store = createBackendSessionStore({ backend: memory.backend, prefix: "tenants/a" });

    await store.backend.write("/t1/scratchpad/x.txt", "hi");
    const raw = await memory.backend.readRaw("/tenants/a/t1/scratchpad/x.txt");
    expect((raw as { data?: { content?: unknown } }).data?.content).toBe("hi");
  });

  it("keeps the tenancy prefix out of result paths", async () => {
    const memory = createMemorySessionStore();
    const store = createBackendSessionStore({ backend: memory.backend, prefix: "tenants/a" });

    const written = await store.backend.write("/t1/output/a.json", "{}");
    expect(written.path).toBe("/t1/output/a.json");

    const listed = await store.backend.ls("/t1/output");
    expect((listed.files ?? []).map((f) => f.path)).toEqual(["/t1/output/a.json"]);

    const globbed = await store.backend.glob("**/*.json", "/t1");
    expect((globbed.files ?? []).map((f) => f.path)).toEqual(["/t1/output/a.json"]);

    const grepped = await store.backend.grep("{}", "/t1", null);
    expect((grepped.matches ?? []).map((m) => m.path)).toEqual(["/t1/output/a.json"]);
  });

  it("has no delete capability unless one is supplied, and throws typed on use", async () => {
    const memory = createMemorySessionStore();
    const store = createBackendSessionStore({ backend: memory.backend });
    expect(store.capabilities.delete).toBe(false);
    await expect(store.deleteSession("t1")).rejects.toBeInstanceOf(SessionStoreCapabilityError);
  });

  it("delegates a supplied deleteSession", async () => {
    const deleted: string[] = [];
    const memory = createMemorySessionStore();
    const store = createBackendSessionStore({
      backend: memory.backend,
      deleteSession: async (id) => {
        deleted.push(id);
        return true;
      },
    });
    expect(store.capabilities.delete).toBe(true);
    expect(await store.deleteSession("t9")).toBe(true);
    expect(deleted).toEqual(["t9"]);
  });

  it("can declare listing unsupported", () => {
    const memory = createMemorySessionStore();
    const store = createBackendSessionStore({ backend: memory.backend, list: false });
    expect(store.capabilities.list).toBe(false);
  });
});

describe("createMemorySessionStore", () => {
  // The store the session zone lists: one folder per session at the root, and a
  // deletion that removes exactly that session's subtree.
  it("lists one folder per session at the root, and deletes one session at a time", async () => {
    const store = createMemorySessionStore();
    await store.backend.write("/s1/checkpoints/cp-1.json", "{}");
    await store.backend.write("/s1/scratchpad/notes.md", "hi");
    await store.backend.write("/s2/checkpoints/cp-1.json", "{}");
    await store.backend.write("/_specs/abc.json", "{}");

    const root = await store.backend.ls("/");
    expect((root.files ?? []).map((f) => f.path).sort()).toEqual(["/_specs/", "/s1/", "/s2/"]);

    expect(await store.deleteSession("s1")).toBe(true);
    expect(await store.deleteSession("s1")).toBe(false);
    const after = await store.backend.ls("/");
    expect((after.files ?? []).map((f) => f.path).sort()).toEqual(["/_specs/", "/s2/"]);
    expect((await store.backend.readRaw("/s2/checkpoints/cp-1.json")) as object).not.toHaveProperty("error");
  });

  it("round-trips reads, ls, grep, glob", async () => {
    const store = createMemorySessionStore();
    const b = store.backend;

    expect((await b.write("/t1/output/a.json", '{"n":1}')) as object).not.toHaveProperty("error");

    expect((await b.read("/t1/output/a.json")) as object).toMatchObject({ content: '{"n":1}' });
    const ls = await b.ls("/t1");
    expect((ls.files ?? []).map((f) => f.path)).toEqual(["/t1/output/"]);

    const grep = await b.grep('"n"', "/t1", null);
    expect(grep.matches).toHaveLength(1);

    const glob = await b.glob("**/*.json", "/t1");
    expect((glob.files ?? []).map((f) => f.path)).toEqual(["/t1/output/a.json"]);
  });

  // Deep Agents backends refused to overwrite through deepagents 1.11.x and replace
  // the file from 1.12.0 on, with no option to pick. The SDK depends on neither
  // posture: every write that can collide guards with a read first or falls back to
  // `edit`. Pinned so a future upstream flip surfaces here rather than silently.
  it("replaces an existing path rather than refusing the write", async () => {
    const b = createMemorySessionStore().backend;

    await b.write("/t1/output/a.txt", "one");
    expect((await b.write("/t1/output/a.txt", "two")) as object).not.toHaveProperty("error");
    expect((await b.read("/t1/output/a.txt")) as object).toMatchObject({ content: "two" });
  });

  it("edits in place and deletes per session", async () => {
    const store = createMemorySessionStore();
    await store.backend.write("/t1/scratch/n.txt", "one two one");
    await store.backend.edit("/t1/scratch/n.txt", "one", "1", true);
    expect((await store.backend.read("/t1/scratch/n.txt")) as object).toMatchObject({
      content: "1 two 1",
    });

    await store.backend.write("/t2/scratch/n.txt", "other");
    expect(await store.deleteSession("t1")).toBe(true);
    expect((await store.backend.read("/t1/scratch/n.txt")) as { error?: string }).toHaveProperty(
      "error",
    );
    expect((await store.backend.read("/t2/scratch/n.txt")) as object).toMatchObject({
      content: "other",
    });
  });

  it("rejects a traversing session id on delete", async () => {
    const store = createMemorySessionStore();
    await expect(store.deleteSession("../escape")).rejects.toBeInstanceOf(SessionStoreIdError);
  });
});
