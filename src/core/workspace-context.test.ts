import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSkillsMiddleware, type BackendProtocolV2 } from "deepagents";

/** The repository's reference workspace (not shipped in the package). */
const EXAMPLE_DIR = fileURLToPath(new URL("../../examples/customer-support", import.meta.url));
import { createBackendSessionStore, createFilesystemSessionStore, createMemorySessionStore, SessionStoreRequiredError } from "./session-store.js";
import { MountCollisionError } from "./mounts.js";
import { createWorkspaceContext, WorkspaceRootRequiredError } from "./workspace-context.js";

/** A stub authored backend that reports every file as missing. */
function stubBackend(): BackendProtocolV2 {
  return {
    async readRaw() {
      return { error: "missing" };
    },
  } as unknown as BackendProtocolV2;
}

describe("createWorkspaceContext", () => {
  it("uses a filesystem backend when no backend is supplied", async () => {
    const ctx = createWorkspaceContext({ rootDir: EXAMPLE_DIR });
    expect(ctx.rootDir).toBe(EXAMPLE_DIR);
    expect(ctx.sessionStore.kind).toBe("filesystem");

    const agents = await ctx.workspace.readText("AGENTS.md");
    expect(agents).toContain("customer support agent");
  });

  it("serves authored mounts from the authored backend", async () => {
    const ctx = createWorkspaceContext({ rootDir: EXAMPLE_DIR });

    expect(await ctx.workspace.readText("skills/order-data/assets/orders.json")).toContain("[");
    // Dot-prefixed spelling routes to the same mount (the skills-glob shape).
    const listed = await ctx.workspace.listDir("./skills/");
    expect(listed.length).toBeGreaterThan(0);
  });

  it("serves the governance plane to the harness and to nothing the agent holds", async () => {
    const ctx = createWorkspaceContext({ rootDir: EXAMPLE_DIR });

    // The harness reads the machine it enforces...
    expect(await ctx.authoring.readText("workflows/order-lookup/workflow.yaml")).toContain(
      "states:",
    );
    // ...and the agent's workspace has no route to it, so the same path resolves
    // in the run root and serves nothing. Not a refusal — an absence.
    expect(await ctx.workspace.readText("workflows/order-lookup/workflow.yaml")).toBeNull();
    expect(await ctx.workspace.listDir("./workflows/")).toEqual([]);
  });

  it("refuses a mount that would serve the governance plane", () => {
    expect(() =>
      createWorkspaceContext({
        rootDir: EXAMPLE_DIR,
        mounts: { "/workflows/": stubBackend() },
      }),
    ).toThrow(MountCollisionError);
  });

  it("requires an explicit session store with a custom backend", () => {
    expect(() =>
      createWorkspaceContext({ rootDir: EXAMPLE_DIR, backend: stubBackend() }),
    ).toThrow(SessionStoreRequiredError);
  });
});

describe("run-rooted workspace routing", () => {
  const withTempRoot = async (fn: (root: string) => Promise<void>) => {
    const root = mkdtempSync(join(tmpdir(), "ws-ctx-run-"));
    try {
      await fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("serves the workspace root from the session store, per session", () =>
    withTempRoot(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });
      expect(ctx.sessionZone).toBeDefined();

      await ctx.sessionZone.sessionScoped("session-a", async () => {
        await ctx.workspace.writeText("scratchpad/notes.txt", "scratch");
        await ctx.workspace.writeText("notes.txt", "loose");

        // Same content whether addressed with or without a leading slash.
        expect(await ctx.workspace.readText("scratchpad/notes.txt")).toBe("scratch");
        expect(await ctx.workspace.readText("/scratchpad/notes.txt")).toBe("scratch");
      });

      // Everything the agent wrote landed in its own session folder in the run
      // store — nothing beside the authored files at the workspace root.
      expect(existsSync(join(root, "sessions", "session-a", "scratchpad", "notes.txt"))).toBe(true);
      expect(existsSync(join(root, "sessions", "session-a", "notes.txt"))).toBe(true);
      expect(existsSync(join(root, "scratchpad", "notes.txt"))).toBe(false);
      expect(existsSync(join(root, "notes.txt"))).toBe(false);
    }));

  it("isolates two session ids: neither sees the other's run content", () =>
    withTempRoot(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });

      await ctx.sessionZone.sessionScoped("session-a", async () => {
        await ctx.workspace.writeText("scratchpad/shared-name.txt", "a's content");
      });
      await ctx.sessionZone.sessionScoped("session-b", async () => {
        expect(await ctx.workspace.readText("scratchpad/shared-name.txt")).toBeNull();
        await ctx.workspace.writeText("scratchpad/shared-name.txt", "b's content");
      });
      await ctx.sessionZone.sessionScoped("session-a", async () => {
        expect(await ctx.workspace.readText("scratchpad/shared-name.txt")).toBe("a's content");
      });
    }));

  it("resolves output/ per session inside the session store", () =>
    withTempRoot(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });

      await ctx.sessionZone.sessionScoped("session-a", async () => {
        await ctx.workspace.writeText("output/answer.json", '{"from":"a"}');
        expect(await ctx.workspace.readText("output/answer.json")).toBe('{"from":"a"}');
      });
      // The same relative path is a different file for another session, so the
      // write lands on its own path instead of colliding.
      await ctx.sessionZone.sessionScoped("session-b", async () => {
        expect(await ctx.workspace.readText("output/answer.json")).toBeNull();
        await ctx.workspace.writeText("output/answer.json", '{"from":"b"}');
      });

      expect(existsSync(join(root, "sessions", "session-a", "output", "answer.json"))).toBe(true);
      expect(existsSync(join(root, "sessions", "session-b", "output", "answer.json"))).toBe(true);
      expect(existsSync(join(root, "output", "answer.json"))).toBe(false);
    }));

  it("routes relative run paths through the raw backend (tool-call shape)", () =>
    withTempRoot(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });

      // The deepagents file tools pass `file_path` to the backend verbatim,
      // so a conventional relative path (`output/x.json`) must hit the run
      // root exactly as its absolute form does.
      await ctx.sessionZone.sessionScoped("session-a", async () => {
        await ctx.backend.write("output/refund.json", '{"decision":"approved"}');

        const relative = await ctx.backend.readRaw("output/refund.json");
        const absolute = await ctx.backend.readRaw("/output/refund.json");
        expect((relative as { data?: { content?: unknown } }).data?.content).toBe(
          '{"decision":"approved"}',
        );
        expect((absolute as { data?: { content?: unknown } }).data?.content).toBe(
          '{"decision":"approved"}',
        );

        await ctx.backend.write("scratchpad/notes.txt", "scratch");
        const scratch = await ctx.backend.readRaw("scratchpad/notes.txt");
        expect((scratch as { data?: { content?: unknown } }).data?.content).toBe("scratch");
      });

      expect(existsSync(join(root, "sessions", "session-a", "output", "refund.json"))).toBe(true);
      expect(existsSync(join(root, "output"))).toBe(false);
    }));

  it("routes the runtime's fixed offload paths into the session's run folder", () =>
    withTempRoot(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });

      await ctx.sessionZone.sessionScoped("session-a", async () => {
        // The Deep Agents filesystem middleware writes these root paths itself.
        await ctx.backend.write("/large_tool_results/call_1.txt", "big");
        await ctx.backend.write("/conversation_history/abc", "history");
      });

      expect(
        existsSync(join(root, "sessions", "session-a", "large_tool_results", "call_1.txt")),
      ).toBe(true);
      expect(existsSync(join(root, "sessions", "session-a", "conversation_history", "abc"))).toBe(true);
      expect(existsSync(join(root, "large_tool_results"))).toBe(false);
    }));

  it("does not leak the session id into result paths", () =>
    withTempRoot(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });

      await ctx.sessionZone.sessionScoped("session-a", async () => {
        const written = await ctx.backend.write("output/answer.json", "{}");
        expect(written.path).toBe("/output/answer.json");

        const listed = await ctx.backend.ls("/output");
        expect(listed.files?.map((f) => f.path)).toEqual(["/output/answer.json"]);
      });
    }));

  it("shapes the agent-visible root and keeps internal listings raw", () =>
    withTempRoot(async (root) => {
      writeFileSync(join(root, "AGENTS.md"), "persona");
      mkdirSync(join(root, "skills"), { recursive: true });
      writeFileSync(join(root, "skills", "orders.json"), "[]");
      const ctx = createWorkspaceContext({ rootDir: root });

      await ctx.sessionZone.sessionScoped("session-a", async () => {
        await ctx.workspace.writeText("scratchpad/n.txt", "x");
        await ctx.workspace.writeText("output/a.json", "{}");
      });
      // An internal writer's session-qualified path (unbound) — the shape the
      // checkpoint saver uses.
      await ctx.workspace.writeText("session-a/checkpoints/cp-1.json", "{}");

      const shaped = await ctx.sessionZone.sessionScoped("session-a", async () =>
        (await ctx.backend.ls("/")).files?.map((f) => f.path) ?? [],
      );
      expect(shaped).toContain("/AGENTS.md");
      expect(shaped).toContain("/skills/");
      expect(shaped.some((p) => p.includes("scratchpad"))).toBe(true);
      expect(shaped.some((p) => p.includes("checkpoints"))).toBe(false);

      // Outside a bound session the run-store root is returned unshaped, which is
      // how sessions are enumerated.
      const raw = (await ctx.backend.ls("/")).files?.map((f) => f.path) ?? [];
      expect(raw.some((p) => p.includes("session-a"))).toBe(true);
    }));

  it("passes the shared _specs prefix through, bound or not", () =>
    withTempRoot(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });

      await ctx.sessionZone.sessionScoped("session-a", async () => {
        await ctx.workspace.writeText("_specs/hash1.json", "{}");
      });
      expect(existsSync(join(root, "sessions", "_specs", "hash1.json"))).toBe(true);
      expect(existsSync(join(root, "sessions", "session-a", "_specs"))).toBe(false);
      expect(await ctx.workspace.readText("_specs/hash1.json")).toBe("{}");
    }));

  it("serves Deep Agents skill discovery from the authored mount via './skills/'", () =>
    withTempRoot(async (root) => {
      mkdirSync(join(root, "skills", "refund-request"), { recursive: true });
      writeFileSync(
        join(root, "skills", "refund-request", "SKILL.md"),
        "---\nname: refund-request\ndescription: How to handle refunds\n---\n\nBody\n",
      );
      const ctx = createWorkspaceContext({ rootDir: root });
      // The harness passes this exact source shape to `createDeepAgent`; it only
      // reaches the authored mount because the router canonicalizes `./skills/`.
      const middleware = createSkillsMiddleware({
        backend: ctx.backend,
        sources: ["./skills/"],
      }) as unknown as {
        beforeAgent(state: unknown): Promise<{ skillsMetadata?: { name: string }[] } | undefined>;
      };

      const loaded = await ctx.sessionZone.sessionScoped("session-a", async () =>
        middleware.beforeAgent({ messages: [] }),
      );
      expect(loaded?.skillsMetadata?.map((s) => s.name)).toEqual(["refund-request"]);
    }));

  it("keeps authored mounts read-only-shaped: writes never reach the session store", () =>
    withTempRoot(async (root) => {
      mkdirSync(join(root, "skills"), { recursive: true });
      writeFileSync(join(root, "skills", "orders.json"), "[]");
      const ctx = createWorkspaceContext({ rootDir: root });

      await ctx.sessionZone.sessionScoped("session-a", async () => {
        expect(await ctx.workspace.readText("skills/orders.json")).toBe("[]");
      });
      // Reads of an authored path are never satisfied from run state.
      expect(existsSync(join(root, "sessions", "session-a", "skills"))).toBe(false);
    }));

  it("deletes a session's run state through the store", () =>
    withTempRoot(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });
      await ctx.sessionZone.sessionScoped("session-a", async () => {
        await ctx.workspace.writeText("scratchpad/f.txt", "x");
      });
      expect(existsSync(join(root, "sessions", "session-a"))).toBe(true);
      expect(await ctx.sessionStore.deleteSession("session-a")).toBe(true);
      expect(existsSync(join(root, "sessions", "session-a"))).toBe(false);
      expect(await ctx.sessionStore.deleteSession("session-a")).toBe(false);
    }));

  it("wraps an explicit session store's backend in a SessionZoneRouter", () =>
    withTempRoot(async (root) => {
      const reads: string[] = [];
      const backend = {
        async readRaw(p: string) {
          reads.push(p);
          throw new Error("missing");
        },
      } as unknown as BackendProtocolV2;

      const ctx = createWorkspaceContext({
        rootDir: root,
        backend,
        sessionStore: createFilesystemSessionStore({ dir: join(root, "elsewhere") }),
      });

      await ctx.sessionZone.sessionScoped("session-a", async () => {
        await ctx.workspace.writeText("scratchpad/f.txt", "x");
        expect(await ctx.workspace.readText("scratchpad/f.txt")).toBe("x");
      });
      expect(existsSync(join(root, "elsewhere", "session-a", "scratchpad", "f.txt"))).toBe(true);
      // The custom authored backend never saw a run-root read.
      expect(reads.every((p) => !p.includes("scratchpad"))).toBe(true);
    }));

  it("applies a backend session store's prefix inside the store, invisibly to paths", () =>
    withTempRoot(async (root) => {
      const memory = createMemorySessionStore();
      const prefixed = createBackendSessionStore({
        backend: memory.backend,
        prefix: "tenants/acme/runs",
      });
      const ctx = createWorkspaceContext({
        rootDir: root,
        backend: stubBackend(),
        sessionStore: prefixed,
      });

      await ctx.sessionZone.sessionScoped("session-a", async () => {
        await ctx.workspace.writeText("scratchpad/f.txt", "x");
        // The agent-visible path carries neither prefix nor session id.
        expect(await ctx.workspace.readText("scratchpad/f.txt")).toBe("x");
        const written = await ctx.backend.write("scratchpad/g.txt", "y");
        expect(written.path).toBe("/scratchpad/g.txt");
      });
      // The unprefixed store sees the full tenant-prefixed key.
      const raw = await memory.backend.readRaw("/tenants/acme/runs/session-a/scratchpad/f.txt");
      expect((raw as { data?: { content?: unknown } }).data?.content).toBe("x");
    }));
});

describe("the workspace root", () => {
  it("defaults to the working directory only in the fully zero-config case", () => {
    const ctx = createWorkspaceContext();
    expect(ctx.rootDir).toBe(process.cwd());
  });

  it("refuses to build a filesystem default over the cwd once the workspace is composed", () => {
    expect(() => createWorkspaceContext({ mounts: {} })).toThrow(WorkspaceRootRequiredError);
    let caught: unknown;
    try {
      createWorkspaceContext({ mounts: {}, authoring: stubBackend() });
    } catch (err) {
      caught = err;
    }
    expect((caught as WorkspaceRootRequiredError).option).toBe("sessionStore");
    expect((caught as Error).message).toMatch(/'sessionStore'/);
  });

  it("resolves no root at all when every source is supplied", () => {
    const ctx = createWorkspaceContext({
      mounts: {},
      sessionStore: createMemorySessionStore(),
      authoring: stubBackend(),
    });
    expect(ctx.rootDir).toBeUndefined();
    expect(ctx.usingDefaultBackend).toBe(true);
  });

  it("resolves no root for a custom backend with its store", () => {
    const ctx = createWorkspaceContext({ backend: stubBackend(), sessionStore: createMemorySessionStore() });
    expect(ctx.rootDir).toBeUndefined();
  });

  it("keeps an explicit root whatever else is supplied", () => {
    const ctx = createWorkspaceContext({ rootDir: EXAMPLE_DIR, mounts: {}, sessionStore: createMemorySessionStore() });
    expect(ctx.rootDir).toBe(EXAMPLE_DIR);
  });
});
