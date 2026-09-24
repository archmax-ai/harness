import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemBackend } from "deepagents";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionZoneRouter } from "./session-zone.js";

let runRoot: string;

beforeEach(() => {
  runRoot = mkdtempSync(join(tmpdir(), "run-zone-test-"));
});

afterEach(() => {
  rmSync(runRoot, { recursive: true, force: true });
});

function makeRouter(): SessionZoneRouter {
  return new SessionZoneRouter(new FilesystemBackend({ rootDir: runRoot, virtualMode: true }));
}

describe("SessionZoneRouter — bound, id-free addressing", () => {
  it("writes and reads back an agent-visible path without embedding the session id", async () => {
    const router = makeRouter();

    await router.sessionScoped("session-a", async () => {
      await router.write("/scratchpad/notes.txt", "a's scratch");
      const back = await router.read("/scratchpad/notes.txt");
      expect(back.content).toContain("a's scratch");
    });

    expect(existsSync(join(runRoot, "session-a", "scratchpad", "notes.txt"))).toBe(true);
  });

  it("isolates concurrent sessions writing the same relative path", async () => {
    const router = makeRouter();

    await Promise.all(
      ["session-a", "session-b"].map((sessionId) =>
        router.sessionScoped(sessionId, async () => {
          await router.write("/scratchpad/who.txt", sessionId);
          const back = await router.read("/scratchpad/who.txt");
          expect(back.content).toContain(sessionId);
        }),
      ),
    );

    expect(existsSync(join(runRoot, "session-a", "scratchpad", "who.txt"))).toBe(true);
    expect(existsSync(join(runRoot, "session-b", "scratchpad", "who.txt"))).toBe(true);
  });

  it("does not leak one session's scratch to another", async () => {
    const router = makeRouter();

    await router.sessionScoped("session-a", async () => {
      await router.write("/scratchpad/only-in-a.txt", "secret");
    });

    await router.sessionScoped("session-b", async () => {
      await expect(async () => router.readRaw("/scratchpad/only-in-a.txt")).rejects.toThrow();
    });
  });
});

describe("SessionZoneRouter — explicit session-qualified addressing", () => {
  it("passes through an already-qualified path unmodified while that same session is bound", async () => {
    // Mirrors the checkpoint saver: it builds `<sessionId>/checkpoints/...`
    // explicitly and writes it *while* that session's segment is executing
    // (bound). The router must not double-prefix it.
    const router = makeRouter();

    await router.sessionScoped("session-a", async () => {
      await router.write("/session-a/checkpoints/cp-1.json", "{}");
    });

    expect(existsSync(join(runRoot, "session-a", "checkpoints", "cp-1.json"))).toBe(true);
    expect(existsSync(join(runRoot, "session-a", "session-a"))).toBe(false);
  });

  it("passes through an explicit path unmodified with no session bound at all", async () => {
    const router = makeRouter();

    await router.write("/session-a/checkpoints/cp-1.json", "{}");

    expect(existsSync(join(runRoot, "session-a", "checkpoints", "cp-1.json"))).toBe(true);
  });

  it("does not throw when unbound (unlike the old work-mount router's fail-closed behavior)", async () => {
    const router = makeRouter();
    await expect(router.write("/session-a/output/result.txt", "done")).resolves.toBeDefined();
    expect(existsSync(join(runRoot, "session-a", "output", "result.txt"))).toBe(true);
  });

  it("internal explicit writes and agent-visible bound reads agree on physical location", async () => {
    const router = makeRouter();

    // Internal caller, unbound, explicit path.
    await router.write("/session-a/scratchpad/notes.txt", "from internal caller");

    // Agent-visible, bound, id-free path — same physical file.
    await router.sessionScoped("session-a", async () => {
      const back = await router.read("/scratchpad/notes.txt");
      expect(back.content).toContain("from internal caller");
    });
  });
});

describe("SessionZoneRouter — grep/glob with no explicit path", () => {
  it("scopes an omitted path to the bound session's own directory", async () => {
    const router = makeRouter();

    await router.sessionScoped("session-a", async () => {
      await router.write("/scratchpad/needle.txt", "needle");
    });
    await router.write("/session-b/scratchpad/needle.txt", "needle");

    await router.sessionScoped("session-a", async () => {
      const result = await router.grep("needle", undefined, null);
      const paths = (result.matches ?? []).map((m: { path?: string }) => m.path ?? "");
      // Scoped to this session's folder, and reported id-free.
      expect(paths).toEqual(["/scratchpad/needle.txt"]);
    });
  });
});

describe("SessionZoneRouter — the session id never reaches the caller", () => {
  it("strips the bound session id from ls, glob, and write result paths", async () => {
    const router = makeRouter();

    await router.sessionScoped("session-a", async () => {
      const written = await router.write("/output/answer.json", "{}");
      expect(written.path).toBe("/output/answer.json");

      const listed = await router.ls("/output");
      expect(listed.files?.map((f) => f.path)).toEqual(["/output/answer.json"]);

      const globbed = await router.glob("**/*.json", "/output");
      expect(globbed.files?.map((f) => f.path)).toEqual(["/output/answer.json"]);
    });
  });

  it("leaves an internal session-qualified path in results as given", async () => {
    const router = makeRouter();
    const written = await router.write("/session-a/checkpoints/cp-1.json", "{}");
    expect(written.path).toBe("/session-a/checkpoints/cp-1.json");
  });
});

describe("SessionZoneRouter — session-agnostic prefix", () => {
  it("resolves _specs at the store root whether or not a session is bound", async () => {
    const router = makeRouter();

    await router.sessionScoped("session-a", async () => {
      await router.write("/_specs/hash1.json", "{}");
    });
    expect(existsSync(join(runRoot, "_specs", "hash1.json"))).toBe(true);
    expect(existsSync(join(runRoot, "session-a", "_specs"))).toBe(false);

    // Readable from another session's bound segment — one snapshot per spec hash.
    await router.sessionScoped("session-b", async () => {
      const back = await router.read("/_specs/hash1.json");
      expect(back.content).toContain("{}");
    });
  });
});
