/**
 * Stores serving only the backend protocol's required methods. Deep Agents makes
 * `downloadFiles`, `uploadFiles` and `delete` optional and feature-detects them,
 * so the workspace must keep them optional too: a skill is found, a text file
 * copies and a removal is refused in words, never a throw. And whatever the
 * stores can do, the agent's one way to delete a file is `remove_file`.
 */
import { join } from "node:path";
import { FilesystemBackend, type BackendProtocolV2 } from "deepagents";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent, createBackendSessionStore, createMemorySessionStore } from "../index.js";
import {
  AGENTS_MD,
  assemble,
  cleanupWorkspaces,
  freshSessionId,
  makeWorkspace,
  ScriptedModel,
  skillMarkdown,
  storeFile,
  toolResults,
  turn,
  workspaceWith,
} from "./support.js";

afterEach(cleanupWorkspaces);

/** The protocol's required methods of `backend`, and nothing else. */
function bare(backend: BackendProtocolV2): BackendProtocolV2 {
  return {
    ls: backend.ls.bind(backend),
    read: backend.read.bind(backend),
    readRaw: backend.readRaw.bind(backend),
    write: backend.write.bind(backend),
    edit: backend.edit.bind(backend),
    grep: backend.grep.bind(backend),
    glob: backend.glob.bind(backend),
  };
}

describe("a plain agent over stores without the optional methods", () => {
  it("finds its skills, copies a text file and says the store cannot delete", async () => {
    const root = makeWorkspace({ "AGENTS.md": AGENTS_MD, "skills/media/SKILL.md": skillMarkdown("media", "Brand media.") });
    const fs = (dir: string) => bare(new FilesystemBackend({ rootDir: dir, virtualMode: true }));
    const memory = createMemorySessionStore().backend;
    const store = createBackendSessionStore({ backend: bare(memory) });
    const model = new ScriptedModel([
      { tool: "write_file", args: { file_path: "scratchpad/a.md", content: "# Draft\n\ncafé" } },
      { tool: "copy_file", args: { source: "scratchpad/a.md", destination: "scratchpad/b.md" } },
      { tool: "remove_file", args: { file_path: "scratchpad/b.md" } },
      { reply: "done" },
    ]);
    const agent = await createAgent({
      workflow: false,
      model: model as never,
      onEvent: () => {},
      backend: fs(root),
      workspace: {
        sessionStore: store,
        mounts: { "/skills/": fs(join(root, "skills")), "/AGENTS.md": fs(root) },
      },
    });

    const result = (await agent.invoke({ messages: [{ role: "user", content: "go" }] } as never, {
      configurable: { thread_id: "bare" },
    })) as { messages: unknown[] };

    // Deep Agents' skills loader reads each SKILL.md through `downloadFiles`
    // when the workspace has one: answered through `readRaw`, the skill is found.
    expect(model.calls[0]?.systemPrompt).toContain("Brand media.");
    const results = toolResults(result.messages as never);
    expect(results.find((r) => r.name === "copy_file")?.content).toBe(
      "Copied 'scratchpad/a.md' to 'scratchpad/b.md' (14 B).",
    );
    expect(await storeFile(store, "/bare/scratchpad/b.md")).toBe("# Draft\n\ncafé");
    expect(results.find((r) => r.name === "remove_file")?.content).toBe(
      "Error: Cannot remove 'scratchpad/b.md': the store serving it cannot do that.",
    );
  });
});

describe("deleting a file", () => {
  it("is remove_file's alone: a plain agent has no Deep Agents delete tool", async () => {
    const model = new ScriptedModel([{ reply: "done" }]);
    const agent = await createAgent({
      workflow: false,
      model: model as never,
      onEvent: () => {},
      workspace: { rootDir: makeWorkspace({ "AGENTS.md": AGENTS_MD }), sessionStore: createMemorySessionStore() },
    });
    await agent.invoke({ messages: [{ role: "user", content: "hi" }] } as never, { configurable: { thread_id: "d" } });

    expect(model.boundTools.has("remove_file")).toBe(true);
    expect(model.boundTools.has("delete")).toBe(false);
  });

  it("is remove_file's alone: a governed agent registers no delete tool either", async () => {
    const root = workspaceWith({
      runtime: { engine: "archmax-harness", version: "2" },
      states: { start: { triggers: { manual: null }, tools: { allow: ["delete"] } } },
    });
    const { agent, model } = await assemble(root, {
      turns: [{ tool: "delete", args: { file_path: "/scratchpad/notes.md" } }, { reply: "done" }],
    });
    const { messages } = await turn(agent, freshSessionId(), "go");

    expect(model.boundTools.has("delete")).toBe(false);
    // Deep Agents registers the tool with the graph and hides it per model
    // call; named anyway, even in a state that grants it, it can delete nothing.
    expect(toolResults(messages).find((r) => r.name === "delete")?.content).toBe(
      "Error: deletion is not available for '/scratchpad/notes.md'.",
    );
  });
});
