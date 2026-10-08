/**
 * `grep`'s `max_count` reaches the store, wherever the search lands: Deep Agents
 * passes the cap to the backend as a fourth argument, and every layer of the
 * workspace forwards it, so a search over five matches capped at two answers
 * two and says it stopped early.
 */
import { join } from "node:path";
import { FilesystemBackend, type BackendProtocolV2 } from "deepagents";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent, createMemorySessionStore, mountSubtree } from "../index.js";
import {
  AGENTS_MD,
  cleanupWorkspaces,
  makeWorkspace,
  ScriptedModel,
  toolResults,
} from "./support.js";

afterEach(cleanupWorkspaces);

const FIVE = "needle 1\nneedle 2\nneedle 3\nneedle 4\nneedle 5\n";

/** A store whose `grep` ignores the cap, as a store predating it would. */
function ignoringCap(backend: BackendProtocolV2): BackendProtocolV2 {
  return new Proxy(backend, {
    get: (target, key, receiver) =>
      key === "grep"
        ? (pattern: string, path?: string | null, glob?: string | null) =>
            target.grep(pattern, path, glob)
        : Reflect.get(target, key, receiver),
  });
}

/** The match lines of a content-mode grep answer (`  <line>: <text>`). */
function matchLines(answer: string): string[] {
  return answer.split("\n").filter((line) => /^\s+\d+: /.test(line));
}

describe("grep's max_count", () => {
  it("caps the matches in the session zone, on a mount, on a mountSubtree mount and on an unsearchable mount", async () => {
    const root = makeWorkspace({
      "AGENTS.md": AGENTS_MD,
      "data/five.md": FIVE,
      "library/notes/five.md": FIVE,
      "archive/five.md": FIVE,
    });
    const fs = (dir: string) => new FilesystemBackend({ rootDir: dir, virtualMode: true });
    const grep = (path: string) => ({
      tool: "grep",
      args: { pattern: "needle", path, max_count: 2 },
    });
    const model = new ScriptedModel([
      { tool: "write_file", args: { file_path: "scratchpad/five.md", content: FIVE } },
      grep("scratchpad"),
      grep("data"),
      grep("notes"),
      grep("archive"),
      { reply: "done" },
    ]);
    const agent = await createAgent({
      workflow: false,
      model: model as never,
      onEvent: () => {},
      backend: fs(root),
      workspace: {
        sessionStore: createMemorySessionStore(),
        mounts: {
          "/AGENTS.md": fs(root),
          "/data/": fs(join(root, "data")),
          "/notes/": mountSubtree(fs(root), "library/notes"),
          // Addressed directly rather than through the composite, and over a
          // store that ignores the cap: the router caps it.
          "/archive/": { backend: ignoringCap(fs(join(root, "archive"))), searchable: false },
        },
      },
    });

    const result = (await agent.invoke(
      { messages: [{ role: "user", content: "search" }] } as never,
      {
        configurable: { thread_id: "grep-cap" },
      },
    )) as { messages: unknown[] };

    const answers = toolResults(result.messages as never).filter((r) => r.name === "grep");
    expect(answers).toHaveLength(4);
    for (const answer of answers) {
      expect(matchLines(answer.content), answer.content).toEqual([
        "  1: needle 1",
        "  2: needle 2",
      ]);
      expect(answer.content).toContain("hit the maximum match count");
    }
  });

  it("leaves a search under its cap whole", async () => {
    const model = new ScriptedModel([
      { tool: "write_file", args: { file_path: "scratchpad/five.md", content: FIVE } },
      { tool: "grep", args: { pattern: "needle", path: "scratchpad", max_count: 5 } },
      { reply: "done" },
    ]);
    const agent = await createAgent({
      workflow: false,
      model: model as never,
      onEvent: () => {},
      workspace: {
        rootDir: makeWorkspace({ "AGENTS.md": AGENTS_MD }),
        sessionStore: createMemorySessionStore(),
      },
    });

    const result = (await agent.invoke(
      { messages: [{ role: "user", content: "search" }] } as never,
      {
        configurable: { thread_id: "grep-whole" },
      },
    )) as { messages: unknown[] };

    const answer = toolResults(result.messages as never).find((r) => r.name === "grep")!;
    expect(matchLines(answer.content)).toHaveLength(5);
    expect(answer.content).not.toContain("hit the maximum match count");
  });
});
