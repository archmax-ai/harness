/**
 * The plain (ungoverned) composition as a first-class host path: it honours the
 * host's middleware, and every call is bound to the session named by
 * `configurable.thread_id`, so the agent's id-free paths land under that
 * session in the store exactly as a governed session's do.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createAgent, createMemorySessionStore, SessionStoreIdError } from "../index.js";
import { AGENTS_MD, cleanupWorkspaces, makeWorkspace, ScriptedModel } from "./support.js";

afterEach(cleanupWorkspaces);

async function plainAgent(turns: ConstructorParameters<typeof ScriptedModel>[0]) {
  const store = createMemorySessionStore();
  const model = new ScriptedModel(turns);
  const agent = await createAgent({
    workflow: false,
    model: model as never,
    onEvent: () => {},
    workspace: { rootDir: makeWorkspace({ "AGENTS.md": AGENTS_MD }), sessionStore: store },
  });
  return { agent, store, model };
}

/** Whether the store holds a file at a store-root path (`<sessionId>/…`). */
async function stored(store: { backend: { readRaw(path: string): unknown } }, path: string): Promise<boolean> {
  const result = (await store.backend.readRaw(path)) as { data?: unknown; error?: unknown };
  return result.data !== undefined && result.error === undefined;
}

describe("a plain agent", () => {
  it("writes the session's scratchpad under the session named by thread_id", async () => {
    const { agent, store } = await plainAgent([
      { tool: "write_file", args: { file_path: "scratchpad/note.md", content: "# note" } },
      { reply: "written" },
    ]);
    const result = (await agent.invoke({ messages: [{ role: "user", content: "write a note" }] } as never, {
      configurable: { thread_id: "s1" },
    })) as { messages: unknown[] };
    expect(result.messages.length).toBeGreaterThan(1);

    expect(await stored(store, "/s1/scratchpad/note.md")).toBe(true);
    // Not at the store root, id-free, where an unbound plain agent used to put it.
    expect(await stored(store, "/scratchpad/note.md")).toBe(false);
    // And the session is a session: its checkpoint is listed and countable.
    expect((await agent.sessions.get("s1"))?.sessionId).toBe("s1");
    expect(await agent.sessions.messageCount("s1")).toBe(result.messages.length);
  });

  it("keeps two sessions' scratchpads apart", async () => {
    const { agent, store, model } = await plainAgent([
      { tool: "write_file", args: { file_path: "scratchpad/a.md", content: "a" } },
      { reply: "a" },
    ]);
    await agent.invoke({ messages: [{ role: "user", content: "a" }] } as never, { configurable: { thread_id: "one" } });
    model.enqueue({ tool: "write_file", args: { file_path: "scratchpad/b.md", content: "b" } }, { reply: "b" });
    await agent.invoke({ messages: [{ role: "user", content: "b" }] } as never, { configurable: { thread_id: "two" } });

    expect(await stored(store, "/one/scratchpad/a.md")).toBe(true);
    expect(await stored(store, "/one/scratchpad/b.md")).toBe(false);
    expect(await stored(store, "/two/scratchpad/b.md")).toBe(true);
  });

  it("refuses a session id that would shadow a reserved root name, before anything is written", async () => {
    const { agent } = await plainAgent([{ reply: "hi" }]);
    await expect(
      agent.invoke({ messages: [{ role: "user", content: "hi" }] } as never, {
        configurable: { thread_id: "scratchpad" },
      }),
    ).rejects.toThrow(SessionStoreIdError);
  });

  it("binds a streamed turn the same way", async () => {
    const { agent, store } = await plainAgent([
      { tool: "write_file", args: { file_path: "scratchpad/streamed.md", content: "s" } },
      { reply: "streamed" },
    ]);
    const stream = await agent.stream({ messages: [{ role: "user", content: "go" }] } as never, {
      configurable: { thread_id: "st" },
    } as never);
    for await (const _chunk of stream) {
      // drain
    }
    expect(await stored(store, "/st/scratchpad/streamed.md")).toBe(true);
  });

  it("reports the message count of a session that has not run as zero", async () => {
    const { agent } = await plainAgent([]);
    expect(await agent.sessions.messageCount("never")).toBe(0);
  });
});
