/**
 * The runtime's file operations — `copy_file`, `move_file`, `remove_file` — and
 * host tools that declare their path arguments: every one routed through the
 * workspace the built-in file tools use, and governed by the same path rules.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FilesystemBackend } from "deepagents";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgent,
  createMemorySessionStore,
  defaultMounts,
  ReservedToolNameError,
  toolsFromMap,
  ToolPathsError,
  type AgentToolDescriptor,
  type SessionStore,
} from "../index.js";
import {
  AGENTS_MD,
  assemble,
  blockedTools,
  cleanupWorkspaces,
  eventsOf,
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

const RUNTIME = { engine: "archmax-harness", version: "2" };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const TEMPLATE = Array.from({ length: 700 }, (_, i) => `- item ${i + 1}`).join("\n");
const edge = (to: string) => [{ to, description: `Test edge to ${to}.` }];

const spec = {
  runtime: RUNTIME,
  skills: { allow_always: [] },
  mounts: { allow_always: [] },
  states: {
    start: { triggers: { manual: null }, skills: { allow: ["media"] }, transitions: edge("sealed") },
    sealed: { skills: { allow: ["media"] }, tools: { forbid: ["copy_file"] }, transitions: edge("intake") },
    intake: { skills: { allow: ["media"] }, mounts: { allow: ["contracts"] } },
  },
};

/** A workspace with a skill's assets, a governed `contracts/` mount and a memory-backed `tmp/`. */
function workspace(): { root: string; store: SessionStore; params: Record<string, unknown> } {
  const root = workspaceWith(spec, {
    "skills/media/SKILL.md": skillMarkdown("media", "Brand media."),
    "skills/media/assets/template.md": TEMPLATE,
  });
  writeFileSync(join(root, "skills/media/assets/logo.png"), PNG);
  mkdirSync(join(root, "contracts"), { recursive: true });
  writeFileSync(join(root, "contracts/policy.md"), "# Policy");
  const store = createMemorySessionStore();
  const mounts = {
    ...defaultMounts(root),
    "/contracts/": { backend: new FilesystemBackend({ rootDir: join(root, "contracts"), virtualMode: true }), governed: true },
    "/tmp/": { backend: createMemorySessionStore().backend, readOnly: false },
  };
  return { root, store, params: { workspace: { rootDir: root, sessionStore: store, mounts } } };
}

/** A session file's raw bytes from the memory store. */
async function storedBytes(store: SessionStore, path: string): Promise<Buffer | undefined> {
  const [res] = await store.backend.downloadFiles!([path]);
  return res?.content ? Buffer.from(res.content) : undefined;
}

describe("the file operations", () => {
  it("copy a long template and an image into the scratchpad without reading either", async () => {
    const { root, store, params } = workspace();
    const { agent, events } = await assemble(root, {
      store,
      params,
      turns: [
        {
          batch: [
            { tool: "copy_file", args: { source: "skills/media/assets/template.md", destination: "scratchpad/report.md" } },
            { tool: "copy_file", args: { source: "skills/media/assets/logo.png", destination: "scratchpad/logo.png" } },
          ],
        },
        { reply: "copied" },
      ],
    });
    const sessionId = freshSessionId();
    const { messages } = await turn(agent, sessionId, "start a report from the template");

    expect(toolResults(messages).filter((r) => r.name === "copy_file").map((r) => r.content)).toEqual([
      `Copied 'skills/media/assets/template.md' to 'scratchpad/report.md' (${(Buffer.byteLength(TEMPLATE) / 1024).toFixed(1)} KB).`,
      "Copied 'skills/media/assets/logo.png' to 'scratchpad/logo.png' (12 B).",
    ]);
    expect(await storeFile(store, `/${sessionId}/scratchpad/report.md`)).toBe(TEMPLATE);
    expect(await storedBytes(store, `/${sessionId}/scratchpad/logo.png`)).toEqual(PNG);
    expect(JSON.stringify(messages)).not.toContain("- item 700");
    expect(blockedTools(events)).toEqual([]);
  });

  it("refuse a copy into a read-only mount and a move out of one, before anything is written", async () => {
    const { root, store, params } = workspace();
    const { agent, events } = await assemble(root, {
      store,
      params,
      turns: [
        { tool: "copy_file", args: { source: "skills/media/assets/logo.png", destination: "skills/media/logo2.png" } },
        { tool: "move_file", args: { source: "skills/media/assets/logo.png", destination: "scratchpad/logo.png" } },
        { reply: "could not" },
      ],
    });
    const sessionId = freshSessionId();
    const { messages } = await turn(agent, sessionId, "go");

    expect(eventsOf(events, "tool-blocked").map((e) => e.tool)).toEqual(["copy_file", "move_file"]);
    const [copy, move] = toolResults(messages).filter((r) => r.name === "copy_file" || r.name === "move_file");
    expect(copy?.status).toBe("error");
    expect(copy?.content).toContain("'copy_file' on 'skills/media/logo2.png' (destination) targets a read-only mount");
    expect(move?.content).toContain("'move_file' on 'skills/media/assets/logo.png' (source) targets a read-only mount");
    expect(await storedBytes(store, `/${sessionId}/scratchpad/logo.png`)).toBeUndefined();
  });

  it("refuse a copy onto an existing file unless overwrite is set, then move and remove", async () => {
    const { root, store, params } = workspace();
    const { agent } = await assemble(root, {
      store,
      params,
      turns: [
        { tool: "write_file", args: { file_path: "scratchpad/out.md", content: "old" } },
        { tool: "copy_file", args: { source: "skills/media/assets/template.md", destination: "scratchpad/out.md" } },
        { tool: "copy_file", args: { source: "skills/media/assets/template.md", destination: "scratchpad/out.md", overwrite: true } },
        { tool: "move_file", args: { source: "scratchpad/out.md", destination: "drafts/out.md" } },
        { tool: "remove_file", args: { file_path: "drafts/out.md" } },
        { reply: "done" },
      ],
    });
    const sessionId = freshSessionId();
    const { messages } = await turn(agent, sessionId, "go");

    const results = toolResults(messages)
      .filter((r) => ["copy_file", "move_file", "remove_file"].includes(r.name))
      .map((r) => r.content);
    expect(results[0]).toContain("Error: Cannot copy to 'scratchpad/out.md': a file is already there.");
    expect(results.slice(1)).toEqual([
      expect.stringMatching(/^Copied 'skills\/media\/assets\/template.md' to 'scratchpad\/out.md'/),
      expect.stringMatching(/^Moved 'scratchpad\/out.md' to 'drafts\/out.md'/),
      "Removed 'drafts/out.md'.",
    ]);
    expect(await storeFile(store, `/${sessionId}/scratchpad/out.md`)).toBeUndefined();
    expect(await storeFile(store, `/${sessionId}/drafts/out.md`)).toBeUndefined();
  });

  it("refuse a copy out of a governed mount the state was not given", async () => {
    const { root, store, params } = workspace();
    const { agent, events } = await assemble(root, {
      store,
      params,
      turns: [{ tool: "copy_file", args: { source: "contracts/policy.md", destination: "scratchpad/p.md" } }, { reply: "no" }],
    });
    await turn(agent, freshSessionId(), "go");
    expect(eventsOf(events, "tool-blocked")).toMatchObject([{ tool: "copy_file" }]);
    expect(eventsOf(events, "tool-blocked")[0]?.reason).toContain("is under the mount 'contracts'");
  });

  it("are disclosed in every state, and closed where a state forbids one", async () => {
    const { root, store, params } = workspace();
    const { agent, model } = await assemble(root, {
      store,
      params,
      turns: [
        { tool: "archmax_advance", args: { to: "sealed", reason: "next" } },
        { tool: "copy_file", args: { source: "skills/media/assets/logo.png", destination: "scratchpad/logo.png" } },
        { reply: "done" },
      ],
    });
    const { messages } = await turn(agent, freshSessionId(), "go");
    const [inStart, inSealed] = model.calls;
    for (const name of ["copy_file", "move_file", "remove_file"]) expect(inStart?.tools).toContain(name);
    expect(inSealed?.tools).not.toContain("copy_file");
    expect(inSealed?.tools).toContain("move_file");
    expect(toolResults(messages).find((r) => r.name === "copy_file")?.content).toContain("is forbidden by state 'sealed'");
  });

  it("are reachable from a script under the same governance", async () => {
    const evalCopy = (destination: string) => ({
      tool: "archmax_eval",
      args: {
        code: [
          "let out;",
          "try {",
          `  out = await tools.copyFile({ source: "skills/media/assets/logo.png", destination: ${JSON.stringify(destination)} });`,
          '} catch (e) { out = "refused: " + e.message; }',
          "out;",
        ].join("\n"),
      },
    });
    const { root, store, params } = workspace();
    const { agent, events } = await assemble(root, {
      store,
      params,
      turns: [evalCopy("scratchpad/logo.png"), evalCopy("skills/media/logo.png"), { reply: "done" }],
    });
    const sessionId = freshSessionId();
    const { messages } = await turn(agent, sessionId, "go");

    const evals = toolResults(messages).filter((r) => r.name === "archmax_eval");
    expect(evals[0]?.content).toContain("Copied 'skills/media/assets/logo.png' to 'scratchpad/logo.png'");
    expect(await storedBytes(store, `/${sessionId}/scratchpad/logo.png`)).toEqual(PNG);
    expect(evals[1]?.content).toContain("refused:");
    expect(eventsOf(events, "tool-blocked")).toMatchObject([{ tool: "copy_file", origin: "script" }]);
  });

  it("are handed to a plain agent, where a read-only mount still refuses a copy into it", async () => {
    const store = createMemorySessionStore();
    const model = new ScriptedModel([
      { tool: "write_file", args: { file_path: "scratchpad/a.md", content: "alpha" } },
      { tool: "copy_file", args: { source: "scratchpad/a.md", destination: "scratchpad/b.md" } },
      { tool: "copy_file", args: { source: "scratchpad/a.md", destination: "AGENTS.md", overwrite: true } },
      { reply: "copied" },
    ]);
    const agent = await createAgent({
      workflow: false,
      model: model as never,
      onEvent: () => {},
      workspace: { rootDir: makeWorkspace({ "AGENTS.md": AGENTS_MD }), sessionStore: store },
    });
    const result = (await agent.invoke({ messages: [{ role: "user", content: "copy it" }] } as never, {
      configurable: { thread_id: "s1" },
    })) as { messages: unknown[] };

    for (const name of ["copy_file", "move_file", "remove_file"]) expect(model.boundTools.has(name)).toBe(true);
    expect(await storeFile(store, "/s1/scratchpad/b.md")).toBe("alpha");
    expect(toolResults(result.messages).filter((r) => r.name === "copy_file")[1]?.content).toBe(
      "Error: Cannot copy to 'AGENTS.md': it is served by a read-only mount.",
    );
  });
});

describe("a host tool with declared paths", () => {
  /** `get_markdown` as the platform registers it, recording what it read and whether it ran. */
  function hostTools() {
    const ran: string[] = [];
    const descriptors: Record<string, AgentToolDescriptor> = {
      get_markdown: {
        description: "Read a file as Markdown.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        paths: { path: "read" },
        handler: async (input, context) => {
          ran.push(String(input.path));
          const res = await context.workspace.read(String(input.path));
          return res.error ? `Error: ${res.error}` : String(res.content);
        },
      },
      stash_image: {
        description: "Store an image, read it back, delete it.",
        inputSchema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
        paths: { file_path: "write" },
        handler: async (input, { workspace: ws }) => {
          const target = String(input.file_path);
          await ws.uploadFiles!([[target, PNG]]);
          const [back] = await ws.downloadFiles!([target]);
          const same = Buffer.from(back!.content!).equals(PNG);
          const deleted = !(await ws.delete!(target)).error;
          // The workspace refuses on its own, whatever governance decided.
          const [refused] = await ws.uploadFiles!([["skills/media/evil.png", PNG]]);
          const denied = await ws.delete!("skills/media/assets/logo.png");
          return JSON.stringify({ same, deleted, upload: refused, delete: denied.error });
        },
      },
    };
    return { ran, tools: toolsFromMap(descriptors) };
  }

  it("reads through the turn's workspace exactly where read_file does", async () => {
    const { root, store, params } = workspace();
    const { ran, tools } = hostTools();
    const read = (path: string) => ({ tool: "get_markdown", args: { path } });
    const { agent } = await assemble(root, {
      store,
      params: { ...params, tools, essentialTools: ["get_markdown", "stash_image"] },
      turns: [
        { tool: "write_file", args: { file_path: "tmp/note.md", content: "temporary" } },
        { tool: "write_file", args: { file_path: "scratchpad/n.md", content: "scratch" } },
        { batch: [read("skills/media/SKILL.md"), read("AGENTS.md"), read("tmp/note.md"), read("scratchpad/n.md")] },
        { reply: "read" },
      ],
    });
    const { messages } = await turn(agent, freshSessionId(), "go");
    const results = toolResults(messages).filter((r) => r.name === "get_markdown").map((r) => r.content);
    expect(ran).toEqual(["skills/media/SKILL.md", "AGENTS.md", "tmp/note.md", "scratchpad/n.md"]);
    expect(results).toEqual([skillMarkdown("media", "Brand media."), AGENTS_MD, "temporary", "scratch"]);
  });

  it("is refused a governed mount the state was not given, and its handler never runs", async () => {
    const { root, store, params } = workspace();
    const { ran, tools } = hostTools();
    const { agent, events } = await assemble(root, {
      store,
      params: { ...params, tools, essentialTools: ["get_markdown"] },
      turns: [{ tool: "get_markdown", args: { path: "contracts/policy.md" } }, { reply: "no" }],
    });
    await turn(agent, freshSessionId(), "go");
    expect(eventsOf(events, "tool-blocked")).toMatchObject([{ tool: "get_markdown" }]);
    expect(eventsOf(events, "tool-blocked")[0]?.reason).toContain("'contracts'");
    expect(ran).toEqual([]);
  });

  it("moves bytes and deletes through the workspace, which refuses a read-only mount itself", async () => {
    const { root, store, params } = workspace();
    const { tools } = hostTools();
    const { agent } = await assemble(root, {
      store,
      params: { ...params, tools, essentialTools: ["stash_image"] },
      turns: [{ tool: "stash_image", args: { file_path: "scratchpad/a.png" } }, { reply: "ok" }],
    });
    const { messages } = await turn(agent, freshSessionId(), "go");
    const out = JSON.parse(toolResults(messages).find((r) => r.name === "stash_image")!.content);
    expect(out).toEqual({
      same: true,
      deleted: true,
      upload: { path: "/skills/media/evil.png", error: "permission_denied" },
      delete: "Cannot delete 'skills/media/assets/logo.png': it is served by a read-only mount. Only run state is writable in this workspace.",
    });
  });

  it("is declared by the toolPaths option as well as on its descriptor", async () => {
    const { root, store, params } = workspace();
    const { ran, tools } = hostTools();
    const plain = tools.map((t) => Object.assign(Object.create(Object.getPrototypeOf(t)), t, { metadata: {} }));
    const { agent, events } = await assemble(root, {
      store,
      params: { ...params, tools: plain, essentialTools: ["get_markdown"], toolPaths: { get_markdown: { path: "read" } } },
      turns: [{ tool: "get_markdown", args: { path: "contracts/policy.md" } }, { reply: "no" }],
    });
    await turn(agent, freshSessionId(), "go");
    expect(eventsOf(events, "tool-blocked")).toMatchObject([{ tool: "get_markdown" }]);
    expect(ran).toEqual([]);
  });
});

describe("assembly refuses", () => {
  it("a host tool that takes a file operation's name, and a path declaration for a built-in", async () => {
    const { root, store, params } = workspace();
    const copy = toolsFromMap({
      copy_file: { description: "x", inputSchema: { type: "object" }, handler: async () => "x" },
    });
    await expect(assemble(root, { store, params: { ...params, tools: copy } })).rejects.toThrow(ReservedToolNameError);
    await expect(
      assemble(root, { store, params: { ...params, toolPaths: { read_file: { file_path: "read" } } } }),
    ).rejects.toThrow(ToolPathsError);
  });
});
