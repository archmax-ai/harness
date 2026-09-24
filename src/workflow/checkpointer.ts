import { createHash } from "node:crypto";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  MemorySaver,
  WRITES_IDX_MAP,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import type { Workspace } from "../core/workspace.js";
import { isReservedRootName } from "../core/zones.js";
import { sessionPaths } from "./paths.js";

/** Persisted record (one immutable file each): a checkpoint (`cp`) or a write (`w`). */
type CheckpointRecord =
  | { k: "cp"; ns: string; id: string; parent: string | null; cp: string; md: string }
  | { k: "w"; ns: string; id: string; ik: string; taskId: string; channel: string; val: string };

const enc = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const dec = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, "base64"));

/** Longest encoded key a record file name may carry: `cp-`/`w-` and `.json` must fit in 255 bytes with it. */
const MAX_ENCODED_NAME = 200;

/**
 * Filesystem-safe encoding for record keys in file names: base64url while it
 * fits, else a truncated prefix plus a digest of the whole key. Truncation is
 * safe because nothing decodes a file name — a record carries its own
 * `ns`/`id`/`ik` in its body. Without the bound a nested child session's
 * `checkpoint_ns` fails with `ENAMETOOLONG`.
 */
const encName = (s: string): string => {
  const encoded = Buffer.from(s, "utf8").toString("base64url");
  if (encoded.length <= MAX_ENCODED_NAME) return encoded;
  const digest = createHash("sha256").update(s, "utf8").digest("base64url");
  return `${encoded.slice(0, MAX_ENCODED_NAME - digest.length - 1)}~${digest}`;
};

// Record keys are NUL-joined, so a session checkpointed by an earlier build resolves to the same file names.
function checkpointFileName(ns: string, id: string): string {
  return `cp-${encName(`${ns}\u0000${id}`)}.json`;
}

function writeFileName(ns: string, id: string, innerKey: string): string {
  return `w-${encName(`${ns}\u0000${id}\u0000${innerKey}`)}.json`;
}

/** LangGraph's own key for the per-checkpoint writes map — the same derivation `MemorySaver` uses. */
function writesKey(sessionId: string, ns: string, id: string): string {
  return JSON.stringify([sessionId, ns, id]);
}

/**
 * A `MemorySaver` with write-through to the session store and lazy per-session
 * replay from it. Every record the parent accepts is also persisted as one
 * immutable file under the session's `checkpoints/` folder (one record per path,
 * so durability is an append-only log of files); the first access to a session
 * replays its files into the inherited maps.
 *
 * Concurrency: single-writer-per-session. Distinct session ids are independent;
 * concurrent turns on the same id are unsupported.
 */
export class BackendCheckpointSaver extends MemorySaver {
  /**
   * Sessions being (or already) replayed, holding the in-flight promise rather
   * than a done marker: a marker set before the `await` would let a concurrent
   * caller proceed against a half-replayed map (concurrent child sessions share
   * a parent's id under different namespaces).
   */
  private readonly loading = new Map<string, Promise<void>>();

  constructor(private readonly workspace: Workspace) {
    super();
  }

  private ensureLoaded(sessionId: string): Promise<void> {
    let inFlight = this.loading.get(sessionId);
    if (!inFlight) {
      // A failed replay is not cached: the next access retries rather than treating the session as empty.
      inFlight = this.replay(sessionId).catch((err) => {
        this.loading.delete(sessionId);
        throw err;
      });
      this.loading.set(sessionId, inFlight);
    }
    return inFlight;
  }

  /**
   * Replay one session's checkpoint files into the inherited maps.
   *
   * Strict reads throughout: a backend that cannot answer must not read as a
   * session with no checkpoints. The lenient helpers return `[]`/`null` on a
   * transient failure, which would replay a live session as empty, cache it as
   * loaded, and fork it on the next write (issue #27). `ensureLoaded` does not
   * cache a throw, so a failed replay is retried instead of believed.
   */
  private async replay(sessionId: string): Promise<void> {
    const dir = sessionPaths(sessionId).checkpointsDir;
    for (const entry of await this.workspace.listDirStrict(dir)) {
      const name = (entry.path ?? "").split("/").pop() ?? "";
      if (!name.endsWith(".json")) continue;
      const rec = await this.workspace.readJsonStrict<CheckpointRecord>(`${dir}/${name}`);
      // Absent is legitimate: a listing can race a session being deleted.
      if (!rec) continue;
      if (rec.k === "cp") {
        const byNs = (this.storage[sessionId] ??= Object.create(null));
        const byId = (byNs[rec.ns] ??= Object.create(null));
        byId[rec.id] = [dec(rec.cp), dec(rec.md), rec.parent ?? undefined];
      } else if (rec.k === "w") {
        const outer = writesKey(sessionId, rec.ns, rec.id);
        const inner = (this.writes[outer] ??= Object.create(null));
        inner[rec.ik] = [rec.taskId, rec.channel, dec(rec.val)];
      }
    }
  }

  /** Every session folder at the store root, for a listing that names no session. */
  private async hydrateAll(): Promise<void> {
    const entries = await this.workspace.listDir("");
    const ids = entries
      .map((entry) => String(entry.path ?? "").replace(/\/+$/, "").split("/").pop() ?? "")
      .filter((id) => id && !isReservedRootName(id));
    await Promise.all(ids.map((id) => this.ensureLoaded(id)));
  }

  /**
   * Persist one immutable record file. A re-emitted record carries the same bytes,
   * so a backend that replaces the file and one that refuses it with "already
   * exists" (any create-only backend a consumer supplies) both leave it correct.
   */
  private async writeRecord(sessionId: string, fileName: string, record: CheckpointRecord): Promise<void> {
    const path = `${sessionPaths(sessionId).checkpointsDir}/${fileName}`;
    try {
      await this.workspace.writeText(path, `${JSON.stringify(record)}\n`);
    } catch (err) {
      if (!/already exists/i.test((err as Error).message)) throw err;
    }
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const sessionId = config.configurable?.thread_id as string | undefined;
    if (sessionId !== undefined) await this.ensureLoaded(sessionId);
    return super.getTuple(config);
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const sessionId = config.configurable?.thread_id as string | undefined;
    if (sessionId !== undefined) await this.ensureLoaded(sessionId);
    else await this.hydrateAll();
    yield* super.list(config, options);
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    const sessionId = config.configurable?.thread_id as string | undefined;
    if (sessionId === undefined) {
      throw new Error("BackendCheckpointSaver.put requires configurable.thread_id");
    }
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    await this.ensureLoaded(sessionId);
    const next = await super.put(config, checkpoint, metadata);
    // Write through exactly what the parent stored — the same bytes it deserializes on replay.
    const [cpBytes, mdBytes, parentId] = this.storage[sessionId][ns][checkpoint.id];
    await this.writeRecord(sessionId, checkpointFileName(ns, checkpoint.id), {
      k: "cp",
      ns,
      id: checkpoint.id,
      parent: parentId ?? null,
      cp: enc(cpBytes),
      md: enc(mdBytes),
    });
    return next;
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const sessionId = config.configurable?.thread_id as string | undefined;
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const checkpointId = config.configurable?.checkpoint_id as string | undefined;
    if (sessionId === undefined || checkpointId === undefined) {
      throw new Error("BackendCheckpointSaver.putWrites requires thread_id and checkpoint_id");
    }
    await this.ensureLoaded(sessionId);
    const outer = writesKey(sessionId, ns, checkpointId);
    const before = new Set(Object.keys(this.writes[outer] ?? {}));
    await super.putWrites(config, writes, taskId);
    // Persist what the parent accepted: regular writes (idx >= 0) it did not already
    // hold, and the negative-index writes (error/interrupt/resume) it always overwrites.
    const inner = this.writes[outer] ?? {};
    for (let idx = 0; idx < writes.length; idx++) {
      const [channel] = writes[idx];
      const writeIdx = WRITES_IDX_MAP[channel] ?? idx;
      const innerKey = `${taskId},${writeIdx}`;
      const stored = inner[innerKey];
      if (!stored || (writeIdx >= 0 && before.has(innerKey))) continue;
      const [storedTask, storedChannel, value] = stored;
      await this.writeRecord(sessionId, writeFileName(ns, checkpointId, innerKey), {
        k: "w",
        ns,
        id: checkpointId,
        ik: innerKey,
        taskId: storedTask,
        channel: storedChannel,
        val: enc(value),
      });
    }
  }

  /**
   * Evict a session from memory and stop replaying its record files; physical
   * removal is the session store's job. Named `deleteThread` because LangGraph owns the word.
   */
  async deleteThread(sessionId: string): Promise<void> {
    await super.deleteThread(sessionId);
    // Marked as replayed (with nothing to replay) so a later access does not resurrect the files.
    this.loading.set(sessionId, Promise.resolve());
  }
}
