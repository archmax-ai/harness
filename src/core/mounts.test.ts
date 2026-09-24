import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CompositeBackend, FilesystemBackend, type BackendProtocolV2 } from "deepagents";
import {
  MountCollisionError,
  defaultMounts,
  normalizeMountKey,
  resolveMounts,
} from "./mounts.js";
import { createMemorySessionStore } from "./session-store.js";

const stub = () => ({ ls: () => ({ files: [] }) }) as unknown as BackendProtocolV2;

describe("normalizeMountKey", () => {
  it("canonicalizes keys while preserving the dir/file distinction", () => {
    expect(normalizeMountKey("skills/")).toBe("/skills/");
    expect(normalizeMountKey("/skills/")).toBe("/skills/");
    expect(normalizeMountKey("//skills//")).toBe("/skills/");
    expect(normalizeMountKey("AGENTS.md")).toBe("/AGENTS.md");
    expect(normalizeMountKey("/AGENTS.md")).toBe("/AGENTS.md");
  });
});

describe("resolveMounts", () => {
  it("splits directory and file mounts and defaults to read-only", () => {
    const { mounts, prefixes } = resolveMounts({
      "skills/": stub(),
      "/data/": stub(),
      "AGENTS.md": stub(),
    });
    expect(mounts.map((m) => m.key)).toEqual(["/skills/", "/data/", "/AGENTS.md"]);
    expect(mounts.every((m) => m.readOnly)).toBe(true);
    expect(prefixes).toEqual({
      dirs: ["skills", "data"],
      files: ["AGENTS.md"],
      writable: [],
      governed: [],
      unsearchable: [],
    });
  });

  it("honors a declared writable mount", () => {
    const { mounts, prefixes } = resolveMounts({
      "/skills/": stub(),
      "/memories/": { backend: stub(), readOnly: false },
    });
    expect(mounts.find((m) => m.name === "memories")?.readOnly).toBe(false);
    expect(prefixes.writable).toEqual(["memories"]);
  });

  it("refuses a mount that would shadow a run area", () => {
    for (const key of ["/scratchpad/", "scratchpad/", "/checkpoints/", "/_specs/"]) {
      expect(() => resolveMounts({ [key]: stub() }), key).toThrow(MountCollisionError);
    }
  });

  /**
   * The reservation is on the *first* segment: a key several levels inside the
   * reserved prefix is the same exposure as the prefix itself.
   */
  it("refuses a mount nested under a reserved prefix, naming the prefix", () => {
    expect(() => resolveMounts({ "/workflows/": stub() })).toThrow(MountCollisionError);
    expect(() => resolveMounts({ "/workflows/order-lookup/": stub() })).toThrow(
      /authoring plane/,
    );
    expect(() => resolveMounts({ "/scratchpad/notes/": stub() })).toThrow(
      /run area 'scratchpad\/'/,
    );
  });

  it("carries a declared governed mount into the prefixes", () => {
    const { mounts, prefixes } = resolveMounts({
      "/skills/": stub(),
      "/reference/": { backend: stub(), governed: true },
      "/catalogs/eu/": { backend: stub(), governed: true },
    });
    expect(mounts.find((m) => m.name === "reference")?.governed).toBe(true);
    expect(mounts.find((m) => m.name === "skills")?.governed).toBe(false);
    expect(prefixes.governed).toEqual(["reference", "catalogs/eu"]);
    expect(prefixes.dirs).toEqual(["skills", "reference", "catalogs/eu"]);
  });

  it("carries a declared unsearchable directory mount into the prefixes", () => {
    const { mounts, prefixes } = resolveMounts({
      "/skills/": stub(),
      "/contracts/": { backend: stub(), governed: true, searchable: false },
      "/data/": { backend: stub(), searchable: true },
    });
    expect(mounts.find((m) => m.name === "contracts")?.searchable).toBe(false);
    expect(mounts.find((m) => m.name === "skills")?.searchable).toBe(true);
    expect(mounts.find((m) => m.name === "data")?.searchable).toBe(true);
    expect(prefixes.unsearchable).toEqual(["contracts"]);
    // Search posture and governance compose without touching each other.
    expect(prefixes.governed).toEqual(["contracts"]);
    expect(prefixes.dirs).toEqual(["skills", "contracts", "data"]);
  });

  it("ignores the flag on a file mount, which is never searched as a tree", () => {
    const { mounts, prefixes } = resolveMounts({
      "/AGENTS.md": { backend: stub(), searchable: false },
    });
    expect(mounts.find((m) => m.name === "AGENTS.md")?.searchable).toBe(false);
    expect(prefixes.files).toEqual(["AGENTS.md"]);
    expect(prefixes.unsearchable).toEqual([]);
  });

  it("is empty for an empty table", () => {
    expect(resolveMounts().prefixes).toEqual({ dirs: [], files: [], writable: [], governed: [], unsearchable: [] });
  });
});

describe("defaultMounts", () => {
  it("is the conventional table over the workspace root", () => {
    const keys = Object.keys(defaultMounts("/ws"));
    // Deliberately short: a capability's scripts and data ship inside its skill
    // bundle, so there is no workspace-wide `scripts/` or `data/` mount — and
    // neither authoring-plane prefix is here, because both are served to the
    // harness by the authoring backend and are reachable by no agent tool.
    expect(keys).toEqual(["/skills/", "/.platform/", "/AGENTS.md"]);
    // A zero-config workspace governs nothing: every mount is visible in every state.
    expect(resolveMounts(defaultMounts("/ws")).prefixes.governed).toEqual([]);
    expect(keys).not.toContain("/workflows/");
    expect(keys).not.toContain("/subagents/");
    // Extending is a spread, not a retype.
    const extended = { ...defaultMounts("/ws"), "/templates/": stub() };
    expect(resolveMounts(extended).prefixes.dirs).toContain("templates");
  });
});

describe("native composition", () => {
  it("serves a mount from a rooted backend with no path adaptation", async () => {
    const root = mkdtempSync(join(tmpdir(), "mounts-"));
    try {
      mkdirSync(join(root, "skills", "refund"), { recursive: true });
      writeFileSync(join(root, "skills", "refund", "SKILL.md"), "body");

      // Rooted AT the mounted directory: the composite strips `/skills/` before
      // delegating, so the backend sees its own root-relative path and results come
      // back workspace-shaped — the reason no rebasing wrapper is needed.
      const composite = new CompositeBackend(createMemorySessionStore().backend, {
        "/skills/": new FilesystemBackend({ rootDir: join(root, "skills"), virtualMode: true }),
      });

      expect(
        (await composite.readRaw("/skills/refund/SKILL.md")) as { data?: { content?: unknown } },
      ).toMatchObject({ data: { content: "body" } });
      expect((await composite.ls("/skills/refund")).files?.map((f) => f.path)).toEqual([
        "/skills/refund/SKILL.md",
      ]);
      expect((await composite.glob("**/*.md", "/skills")).files?.map((f) => f.path)).toEqual([
        "/skills/refund/SKILL.md",
      ]);
      expect((await composite.grep("body", "/skills", null)).matches?.map((m) => m.path)).toEqual([
        "/skills/refund/SKILL.md",
      ]);
      // Anything outside the mount falls through to the default route (run state).
      expect((await composite.write("/output/answer.json", "{}")).path).toBe("/output/answer.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
