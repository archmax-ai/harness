import { describe, expect, it } from "vitest";
import type { BackendProtocolV2, FileInfo } from "deepagents";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { emptyCheckpoint, type Checkpoint, type CheckpointMetadata } from "@langchain/langgraph-checkpoint";
import { Workspace } from "../core/workspace.js";
import { sessionPaths } from "./paths.js";
/** LangGraph's checkpoint-namespace separator. */
const NAMESPACE_SEPARATOR = "|";
import { subRunIdentity } from "../sessions/scope.js";
import { listSessions, summarizeCheckpointedSession } from "../sessions/summary.js";
import { BackendCheckpointSaver } from "./checkpointer.js";

/**
 * A minimal in-memory {@link BackendProtocolV2} supporting the read/write/ls
 * surface the saver uses. Two savers over the SAME instance model a process
 * restart: the second replays the first's persisted JSONL.
 */
function memoryBackend() {
  const files = new Map<string, string>();
  const norm = (p: string) => `/${String(p).replace(/^\/+/, "")}`;
  const backend = {
    async readRaw(filePath: string) {
      const content = files.get(norm(filePath));
      return content === undefined
        ? { error: "missing" }
        : { data: { content, mimeType: "text/plain", created_at: "", modified_at: "" } };
    },
    async write(filePath: string, content: string) {
      files.set(norm(filePath), content);
      return {};
    },
    async ls(dir: string) {
      const prefix = norm(dir).replace(/\/+$/, "") + "/";
      const children = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const seg = rest.split("/")[0];
        children.add(seg);
      }
      const list: FileInfo[] = [...children].map((seg) => ({
        path: `${prefix}${seg}`,
        is_dir: true,
      }) as unknown as FileInfo);
      return { files: list };
    },
  } as unknown as BackendProtocolV2;
  return { backend, files };
}

function checkpointWith(id: string, values: Record<string, unknown>): Checkpoint {
  const cp = emptyCheckpoint();
  cp.id = id;
  cp.channel_values = values;
  return cp;
}

const META: CheckpointMetadata = { source: "input", step: 0, parents: {} } as CheckpointMetadata;

describe("BackendCheckpointSaver — persistence round-trip", () => {
  it("persists a checkpoint and reloads it in a fresh saver (restart)", async () => {
    const { backend } = memoryBackend();
    const ws = new Workspace(backend);
    const saver = new BackendCheckpointSaver(ws);
    const config = { configurable: { thread_id: "t1", checkpoint_ns: "" } };

    await saver.put(config, checkpointWith("0001", { greeting: "hello", status: "running" }), META);

    const reloaded = new BackendCheckpointSaver(ws);
    const tuple = await reloaded.getTuple({ configurable: { thread_id: "t1" } });
    expect(tuple).toBeDefined();
    expect(tuple?.checkpoint.id).toBe("0001");
    expect((tuple?.checkpoint.channel_values as Record<string, unknown>).greeting).toBe("hello");
  });

  it("writes one immutable record file per checkpoint under the session's run folder", async () => {
    const { backend, files } = memoryBackend();
    const saver = new BackendCheckpointSaver(new Workspace(backend));
    const config = { configurable: { thread_id: "t1", checkpoint_ns: "" } };
    await saver.put(config, checkpointWith("0001", {}), META);
    await saver.put(config, checkpointWith("0002", {}), META);

    const dir = `/${sessionPaths("t1").checkpointsDir}/`;
    const records = [...files.keys()].filter((k) => k.startsWith(dir));
    expect(records).toHaveLength(2);
    const ids = records.map((k) => JSON.parse(files.get(k)!).id).sort();
    expect(ids).toEqual(["0001", "0002"]);
  });

  it("lists checkpoints newest-first and getTuple returns the latest", async () => {
    const saver = new BackendCheckpointSaver(new Workspace(memoryBackend().backend));
    const config = { configurable: { thread_id: "t1", checkpoint_ns: "" } };
    await saver.put(config, checkpointWith("0001", {}), META);
    await saver.put(config, checkpointWith("0002", {}), META);
    await saver.put(config, checkpointWith("0003", {}), META);

    const ids: string[] = [];
    for await (const t of saver.list({ configurable: { thread_id: "t1" } })) ids.push(t.checkpoint.id);
    expect(ids).toEqual(["0003", "0002", "0001"]);

    const latest = await saver.getTuple({ configurable: { thread_id: "t1" } });
    expect(latest?.checkpoint.id).toBe("0003");
  });

  it("records parent links between successive checkpoints", async () => {
    const saver = new BackendCheckpointSaver(new Workspace(memoryBackend().backend));
    await saver.put({ configurable: { thread_id: "t1", checkpoint_ns: "" } }, checkpointWith("0001", {}), META);
    await saver.put(
      { configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "0001" } },
      checkpointWith("0002", {}),
      META,
    );
    const tuple = await saver.getTuple({ configurable: { thread_id: "t1", checkpoint_id: "0002" } });
    expect(tuple?.parentConfig?.configurable?.checkpoint_id).toBe("0001");
  });
});

describe("BackendCheckpointSaver — pending writes", () => {
  it("round-trips pending writes and is idempotent per (task, index)", async () => {
    const { backend } = memoryBackend();
    const ws = new Workspace(backend);
    const saver = new BackendCheckpointSaver(ws);
    const config = { configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "0001" } };
    await saver.put({ configurable: { thread_id: "t1", checkpoint_ns: "" } }, checkpointWith("0001", {}), META);

    await saver.putWrites(config, [["channelA", 1]], "task-1");
    await saver.putWrites(config, [["channelA", 2]], "task-1"); // same (task, idx) → ignored

    const reloaded = new BackendCheckpointSaver(new Workspace(backend));
    const tuple = await reloaded.getTuple(config);
    const writes = tuple?.pendingWrites ?? [];
    const channelA = writes.filter(([, ch]) => ch === "channelA");
    expect(channelA).toHaveLength(1);
    expect(channelA[0][2]).toBe(1);
  });
});

describe("BackendCheckpointSaver — session listing and deletion", () => {
  it("projects status, workflowState, and specHash from each session's latest checkpoint", async () => {
    const { backend } = memoryBackend();
    const ws = new Workspace(backend);
    const saver = new BackendCheckpointSaver(ws);
    await saver.put(
      { configurable: { thread_id: "alpha", checkpoint_ns: "" } },
      checkpointWith("0001", { status: "completed", workflowState: "done", specHash: "abc" }),
      META,
    );
    await saver.put(
      { configurable: { thread_id: "beta", checkpoint_ns: "" } },
      checkpointWith("0001", { status: "running", workflowState: "collect", specHash: "def" }),
      META,
    );

    const sessions = (await listSessions(ws, saver)).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    expect(sessions).toEqual([
      {
        sessionId: "alpha",
        status: "completed",
        classification: "finished",
        workflowState: "done",
        specHash: "abc",
      },
      {
        sessionId: "beta",
        status: "running",
        classification: "open",
        workflowState: "collect",
        specHash: "def",
      },
    ]);
  });

  it("projects an agent park with its wait reason, under its addressable id", async () => {
    const { backend } = memoryBackend();
    const ws = new Workspace(backend);
    const saver = new BackendCheckpointSaver(ws);
    await saver.put(
      { configurable: { thread_id: "parked", checkpoint_ns: "" } },
      checkpointWith("0001", {
        status: "awaiting_input",
        workflowState: "clarify",
        pendingInput: {
          state: "clarify",
          reason: "waiting for the customer to name an order",
          parkedAt: "2026-08-10T00:00:00.000Z",
          resumeAt: "2026-08-11T00:00:00.000Z",
        },
      }),
      META,
    );

    const [session] = await listSessions(ws, saver);
    // A park is open, never finished — and carries enough to resume it.
    expect(session).toMatchObject({
      status: "awaiting_input",
      classification: "open",
      state: "clarify",
      waitReason: "waiting for the customer to name an order",
      // Reported so a host's scheduler is a query over this listing.
      resumeAt: "2026-08-11T00:00:00.000Z",
      // The id the summary reports is the id callers address the session by —
      // `sessions.get`/`delete`/`deliver` all take this one. There is no second
      // id to diverge from it.
      sessionId: "parked",
    });
  });

  it("carries the session's variables, with their lock state, from the checkpoint", async () => {
    const { backend } = memoryBackend();
    const ws = new Workspace(backend);
    const saver = new BackendCheckpointSaver(ws);
    await saver.put(
      { configurable: { thread_id: "seeded", checkpoint_ns: "" } },
      checkpointWith("0001", {
        status: "completed",
        workflowState: "done",
        variables: {
          trigger: { value: "email_received", locked: true },
          from_email: { value: "a@b.c", locked: true },
          case_id: { value: "K-9", locked: false },
        },
      }),
      META,
    );

    const [session] = await listSessions(ws, saver);
    // The listing is how a run's inputs are recovered when nothing emitted
    // artifacts — a CLI-driven run, for instance.
    expect(session?.variables).toEqual({
      trigger: { value: "email_received", locked: true },
      from_email: { value: "a@b.c", locked: true },
      case_id: { value: "K-9", locked: false },
    });
  });

  it("omits variables for a session that holds none", async () => {
    const { backend } = memoryBackend();
    const ws = new Workspace(backend);
    const saver = new BackendCheckpointSaver(ws);
    await saver.put(
      { configurable: { thread_id: "bare", checkpoint_ns: "" } },
      checkpointWith("0001", { status: "running", workflowState: "start" }),
      META,
    );

    const [session] = await listSessions(ws, saver);
    expect(session?.variables).toBeUndefined();
  });

  it("reads a malformed variable store as none rather than failing the listing", async () => {
    const { backend } = memoryBackend();
    const ws = new Workspace(backend);
    const saver = new BackendCheckpointSaver(ws);
    await saver.put(
      { configurable: { thread_id: "odd", checkpoint_ns: "" } },
      checkpointWith("0001", { status: "running", variables: { from_email: "not-an-entry" } }),
      META,
    );

    const [session] = await listSessions(ws, saver);
    expect(session?.variables).toBeUndefined();
    expect(session?.status).toBe("running");
  });

  it("clears a session's in-memory checkpoints on deleteThread", async () => {
    const { backend } = memoryBackend();
    const ws = new Workspace(backend);
    const saver = new BackendCheckpointSaver(ws);
    await saver.put({ configurable: { thread_id: "t1", checkpoint_ns: "" } }, checkpointWith("0001", {}), META);
    await saver.deleteThread("t1");
    expect(await saver.getTuple({ configurable: { thread_id: "t1" } })).toBeUndefined();
  });
});

describe("BackendCheckpointSaver — graph restart", () => {
  it("resumes an interrupted graph across a fresh saver over the same backend", async () => {
    const StateAnnotation = Annotation.Root({
      count: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
    });

    const build = (saver: BackendCheckpointSaver) => {
      // Node names are string literals added at runtime, so type the graph with
      // a `string` node-name parameter (as the production graph does) instead of
      // LangGraph's default literal-name union.
      const g = new StateGraph<
        typeof StateAnnotation.spec,
        typeof StateAnnotation.State,
        Partial<typeof StateAnnotation.State>,
        string
      >(StateAnnotation);
      g.addNode("a", (s: { count: number }) => ({ count: s.count + 1 }));
      g.addNode("b", (s: { count: number }) => ({ count: s.count + 10 }));
      g.addEdge(START, "a");
      g.addEdge("a", "b");
      g.addEdge("b", END);
      return g.compile({ checkpointer: saver, interruptBefore: ["b"] });
    };

    const { backend } = memoryBackend();
    const ws = new Workspace(backend);
    const config = { configurable: { thread_id: "run-1" } };

    // First "process": run until interrupted before node b.
    const first = build(new BackendCheckpointSaver(ws));
    const paused = await first.invoke({ count: 0 }, config);
    expect(paused.count).toBe(1);

    // Fresh saver (restart) replays the persisted checkpoints and resumes b.
    const resumed = build(new BackendCheckpointSaver(ws));
    const done = await resumed.invoke(null, config);
    expect(done.count).toBe(11);
  });
});

describe("BackendCheckpointSaver — concurrent namespaces of one session", () => {
  /**
   * Concurrent sub-runs share a session id and differ only by checkpoint
   * namespace. Replay must therefore be safe to enter twice at once: a marker set
   * before the await would let the second caller proceed against a half-replayed
   * map and see the session as emptier than it is.
   */
  it("replays a session's records once even when two namespaces hydrate at once", async () => {
    const { backend, files } = memoryBackend();
    const seed = new BackendCheckpointSaver(new Workspace(backend));
    await seed.put(
      { configurable: { thread_id: "s1", checkpoint_ns: "a" } },
      checkpointWith("cp-a", { v: "from-a" }),
      META,
    );
    await seed.put(
      { configurable: { thread_id: "s1", checkpoint_ns: "b" } },
      checkpointWith("cp-b", { v: "from-b" }),
      META,
    );

    // A fresh saver over the same store models a cold start, where both
    // namespaces race to hydrate.
    let reads = 0;
    const counting = new Proxy(backend, {
      get(target, prop) {
        if (prop === "readRaw") {
          return async (path: string) => {
            reads += 1;
            return (target as unknown as { readRaw(p: string): unknown }).readRaw(path);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as BackendProtocolV2;

    const saver = new BackendCheckpointSaver(new Workspace(counting));
    const [a, b] = await Promise.all([
      saver.getTuple({ configurable: { thread_id: "s1", checkpoint_ns: "a" } }),
      saver.getTuple({ configurable: { thread_id: "s1", checkpoint_ns: "b" } }),
    ]);

    // Each namespace sees its own checkpoint — neither observed a partial replay.
    expect((a?.checkpoint.channel_values as { v: string }).v).toBe("from-a");
    expect((b?.checkpoint.channel_values as { v: string }).v).toBe("from-b");
    // And the records were read once, not once per concurrent caller.
    expect(reads).toBe(files.size);
  });

  it("retries replay after a failed hydration rather than caching emptiness", async () => {
    const { backend } = memoryBackend();
    const seed = new BackendCheckpointSaver(new Workspace(backend));
    await seed.put(
      { configurable: { thread_id: "s2", checkpoint_ns: "" } },
      checkpointWith("cp-1", { v: "kept" }),
      META,
    );

    // Injected at the backend, where a real transient failure happens: replay
    // reads strictly, so the error reaches the caller instead of being read as a
    // session with no checkpoints (issue #27).
    let failNext = true;
    const flaky = {
      ...backend,
      async ls(dir: string) {
        if (failNext) {
          failNext = false;
          throw new Error("transient store failure");
        }
        return (backend as unknown as { ls(d: string): Promise<unknown> }).ls(dir);
      },
    } as unknown as BackendProtocolV2;

    const saver = new BackendCheckpointSaver(new Workspace(flaky));
    await expect(
      saver.getTuple({ configurable: { thread_id: "s2", checkpoint_ns: "" } }),
    ).rejects.toThrow(/transient store failure/);

    const recovered = await saver.getTuple({
      configurable: { thread_id: "s2", checkpoint_ns: "" },
    });
    expect((recovered?.checkpoint.channel_values as { v: string }).v).toBe("kept");
  });

  it("propagates a backend that reports the listing as failed, not as empty", async () => {
    const { backend } = memoryBackend();
    const seed = new BackendCheckpointSaver(new Workspace(backend));
    await seed.put(
      { configurable: { thread_id: "s3", checkpoint_ns: "" } },
      checkpointWith("cp-1", { v: "kept" }),
      META,
    );

    // A backend that answers with an `error` rather than throwing: the lenient
    // read turned this into `[]`, so the session replayed as brand new.
    const erroring = {
      ...backend,
      async ls() {
        return { error: "store unavailable" };
      },
    } as unknown as BackendProtocolV2;
    const saver = new BackendCheckpointSaver(new Workspace(erroring));

    await expect(
      saver.getTuple({ configurable: { thread_id: "s3", checkpoint_ns: "" } }),
    ).rejects.toThrow(/store unavailable/);
  });

  it("reads a session with no checkpoints folder yet as empty, not as an error", async () => {
    const { backend } = memoryBackend();
    const saver = new BackendCheckpointSaver(new Workspace(backend));
    // A first turn has written nothing, so the backend reports the folder absent.
    await expect(
      saver.getTuple({ configurable: { thread_id: "fresh", checkpoint_ns: "" } }),
    ).resolves.toBeUndefined();
  });
});

describe("BackendCheckpointSaver — record names are storable at any namespace depth", () => {
  /**
   * The namespace a nested sub-run runs under, as the runtime actually builds it:
   * LangGraph extends `checkpoint_ns` per node and per super-step, and a
   * delegation extends it again with the dispatch's identity
   * (`<node>:<workflow>:<ordinal>`). At the default `max_depth` of 3 that is far
   * past what base64url can encode into a 255-byte file name.
   */
  const nestedNamespace = (depth: number) =>
    Array.from({ length: depth }, (_, i) =>
      [
        `enrichment-fan-out-state-${i}`,
        subRunIdentity(`delegating-state-${i}`, `enrich-order-workflow-${i}`, i),
        `tasks:${"c".repeat(36)}`,
      ].join(NAMESPACE_SEPARATOR),
    ).join(NAMESPACE_SEPARATOR);

  const namesIn = (files: Map<string, string>) =>
    [...files.keys()].map((p) => p.split("/").pop() ?? "").filter((n) => n.endsWith(".json"));

  it("keeps a deeply nested sub-run's record names within the filesystem limit", async () => {
    const { backend, files } = memoryBackend();
    const ns = nestedNamespace(3);
    expect(ns.length).toBeGreaterThan(255);

    const saver = new BackendCheckpointSaver(new Workspace(backend));
    const config = { configurable: { thread_id: "s1", checkpoint_ns: ns } };
    await saver.put(config, checkpointWith("cp-deep", { v: "nested" }), META);
    await saver.putWrites(
      { configurable: { ...config.configurable, checkpoint_id: "cp-deep" } },
      [["messages", { role: "ai" }]],
      "task-1",
    );

    const names = namesIn(files);
    expect(names).toHaveLength(2);
    for (const name of names) expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(255);
  });

  it("replays a deeply nested sub-run's records in a fresh saver", async () => {
    const { backend } = memoryBackend();
    const ws = new Workspace(backend);
    const config = { configurable: { thread_id: "s1", checkpoint_ns: nestedNamespace(3) } };

    await new BackendCheckpointSaver(ws).put(
      config,
      checkpointWith("cp-deep", { v: "nested" }),
      META,
    );

    // A fresh saver models a restart: a record carries its own `ns`/`id` in its
    // body, so a hashed file name costs nothing on the way back.
    const reloaded = await new BackendCheckpointSaver(ws).getTuple(config);
    expect((reloaded?.checkpoint.channel_values as { v: string }).v).toBe("nested");
  });

  it("does not collide two long namespaces sharing a prefix", async () => {
    const { backend, files } = memoryBackend();
    const saver = new BackendCheckpointSaver(new Workspace(backend));
    const shared = nestedNamespace(3);

    await saver.put(
      { configurable: { thread_id: "s1", checkpoint_ns: `${shared}${NAMESPACE_SEPARATOR}a` } },
      checkpointWith("cp-1", { v: "a" }),
      META,
    );
    await saver.put(
      { configurable: { thread_id: "s1", checkpoint_ns: `${shared}${NAMESPACE_SEPARATOR}b` } },
      checkpointWith("cp-1", { v: "b" }),
      META,
    );

    expect(new Set(namesIn(files)).size).toBe(2);
  });

  it("leaves a short namespace's record name exactly as it was", async () => {
    const { backend, files } = memoryBackend();
    const saver = new BackendCheckpointSaver(new Workspace(backend));
    await saver.put(
      { configurable: { thread_id: "s1", checkpoint_ns: "" } },
      checkpointWith("cp-1", { v: "top" }),
      META,
    );

    // The pre-existing derivation, asserted literally: a session checkpointed
    // before this bound existed must still resolve to the same file.
    const expected = Buffer.from("\u0000cp-1", "utf8").toString("base64url");
    expect(namesIn(files)).toEqual([`cp-${expected}.json`]);
  });
});

/**
 * Cost is answerable from a session handle. The metrics ledger that used to
 * carry it is gone; usage stayed, because pricing is a host *input* the SDK is
 * uniquely placed to apply once — and because a parked run has to be able to
 * report what it has spent so far.
 */
describe("BackendCheckpointSaver — usage projection", () => {
  it("projects a session's cumulative usage and cost", async () => {
    const { backend } = memoryBackend();
    const ws = new Workspace(backend);
    const saver = new BackendCheckpointSaver(ws);
    await saver.put(
      { configurable: { thread_id: "priced", checkpoint_ns: "" } },
      checkpointWith("0001", {
        status: "completed",
        workflowState: "done",
        usage: {
          inputTokens: 900,
          outputTokens: 40,
          cacheReadTokens: 800,
          cacheCreationTokens: 0,
          costUsd: 0.0042,
        },
      }),
      META,
    );

    const summary = await summarizeCheckpointedSession(saver, "priced");
    expect(summary?.usage).toEqual({
      inputTokens: 900,
      outputTokens: 40,
      cacheReadTokens: 800,
      cacheCreationTokens: 0,
      costUsd: 0.0042,
    });
  });

  // Without pricing the SDK reports tokens and omits cost — never a guess.
  it("reports tokens without cost when no pricing is configured", async () => {
    const { backend } = memoryBackend();
    const ws = new Workspace(backend);
    const saver = new BackendCheckpointSaver(ws);
    await saver.put(
      { configurable: { thread_id: "unpriced", checkpoint_ns: "" } },
      checkpointWith("0001", {
        status: "running",
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      }),
      META,
    );

    const summary = await summarizeCheckpointedSession(saver, "unpriced");
    expect(summary?.usage?.inputTokens).toBe(10);
    expect(summary?.usage?.costUsd).toBeUndefined();
  });

  // A session that has spent nothing carries no usage key at all — absent and
  // zero are different facts, and a listing should not imply a run happened.
  it("omits usage entirely when nothing has been spent", async () => {
    const { backend } = memoryBackend();
    const ws = new Workspace(backend);
    const saver = new BackendCheckpointSaver(ws);
    await saver.put(
      { configurable: { thread_id: "quiet", checkpoint_ns: "" } },
      checkpointWith("0001", { status: "running" }),
      META,
    );

    const summary = await summarizeCheckpointedSession(saver, "quiet");
    expect(summary?.usage).toBeUndefined();
  });
});
