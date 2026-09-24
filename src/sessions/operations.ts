/**
 * The session operations an assembled agent carries — `sessions.list/get/
 * delete/seed` over the configured session store, and the artifact emitter —
 * governed or not. Assembly wires them; nothing here knows how the agent was composed.
 */
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { asDecisionGraph, type CompiledAgentGraph } from "../core/deepagents.js";
import type { WorkflowEventEmitter } from "../core/events.js";
import { SessionStoreIdError, sessionIdRejection, type SessionStore } from "../core/session-store.js";
import { hasUsage, type UsageTracker } from "../core/usage.js";
import { canonicalizeRelPath, Workspace } from "../core/workspace.js";
import { classifyWorkspacePath, type MountPrefixes } from "../core/zones.js";
import { PACKAGE_VERSION } from "../env.js";
import type { WorkflowMachine } from "../machine/machine.js";
import type { MachineSpec } from "../machine/types.js";
import type { ResolvedRuntimeContract } from "../runtime/contract.js";
import { BackendCheckpointSaver } from "../workflow/checkpointer.js";
import {
  describeMachineTopology,
  serializeGraph,
  serializeMachineGraph,
  writeRunArtifacts,
  type Trajectory,
} from "../workflow/session-artifacts.js";
import { readSpecSnapshot } from "../workflow/snapshot.js";
import { readAuditTrail, readRunUsage, readVariables, type TrailStep } from "../workflow/state.js";
import { listSessions, summarizeCheckpointedSession, type SessionSummary } from "./summary.js";

export { describeMachineTopology };

/**
 * Session handles over the configured session store — the supported
 * alternative to manipulating a store's `<sessionId>/…` folders directly.
 */
export interface SessionOperations {
  /**
   * Enumerate durable sessions, projected from each session's latest checkpoint.
   * Empty when the checkpointer or store cannot enumerate sessions (an ephemeral
   * `MemorySaver`, a backend store without listing capability).
   */
  list(): Promise<SessionSummary[]>;
  /** A single session's summary, or `null` when no such session exists. */
  get(sessionId: string): Promise<SessionSummary | null>;
  /**
   * How many messages the session's transcript holds, from its latest checkpoint;
   * `0` for a session that has not run. A **cursor**: read it before a turn and
   * hand it to `messagesSince(messages, cursor)` afterwards to slice exactly what
   * that turn appended — seeds, notes and all — without counting them yourself.
   */
  messageCount(sessionId: string): Promise<number>;
  /**
   * Remove all of a session's state — checkpoints, artifacts, scratchpad — through
   * the session store, and evict it from the live checkpointer. Returns whether
   * anything was removed. Throws `SessionStoreCapabilityError` when the store
   * cannot delete.
   */
  delete(sessionId: string): Promise<boolean>;
  /**
   * Seed input files into a session's workspace through the store. Keys are
   * workspace-relative paths classified against the assembly's mounts: only
   * agent-visible session paths (root-level files like `trigger.json`, plus
   * `scratchpad/…`) are seedable, and one bad path seeds nothing. Strings are
   * written verbatim, other values as pretty-printed JSON; existing files are overwritten.
   */
  seed(sessionId: string, files: Record<string, unknown>): Promise<void>;
}

/** Persist a session's graph snapshot, trajectory, trail, variables and metadata. */
export type EmitRunArtifacts = (
  sessionId: string,
  trajectory: Trajectory,
  opts?: { trail?: TrailStep[] },
) => Promise<string | null>;

export function createSessionOperations(deps: {
  checkpointer: BaseCheckpointSaver;
  sessionStore: SessionStore;
  /** The agent's workspace — its root, outside a bound session, is the raw store root. */
  workspace: Workspace;
  mountPrefixes: MountPrefixes;
  dispose: (sessionId: string) => void;
}): SessionOperations {
  const { checkpointer, sessionStore, workspace, mountPrefixes, dispose } = deps;
  return {
    list: () =>
      checkpointer instanceof BackendCheckpointSaver && sessionStore.capabilities.list
        ? listSessions(workspace, checkpointer)
        : Promise.resolve([]),
    // One session's projection via `getTuple` alone, so it works for any
    // checkpointer — it must: `null` means "this session has not run yet", and
    // resolution would then treat a live session's next turn as its first.
    get: (sessionId) => summarizeCheckpointedSession(checkpointer, sessionId),
    messageCount: async (sessionId) => {
      const tuple = await checkpointer.getTuple({ configurable: { thread_id: sessionId } });
      const messages = (tuple?.checkpoint.channel_values as { messages?: unknown } | undefined)?.messages;
      return Array.isArray(messages) ? messages.length : 0;
    },
    delete: async (sessionId) => {
      // Evict live checkpointer state first so a deleted session cannot be resumed
      // from memory, then remove the persisted namespace through the store.
      await checkpointer.deleteThread(sessionId);
      const removed = await sessionStore.deleteSession(sessionId);
      dispose(sessionId);
      return removed;
    },
    seed: async (sessionId, files) => {
      const idRejection = sessionIdRejection(sessionId, mountPrefixes);
      if (idRejection) throw new SessionStoreIdError(sessionId, idRejection);
      const id = sessionId.replace(/^\/+/, "");
      // Validate every path before writing any.
      const entries = Object.entries(files).map(([path, value]) => {
        const canonical = canonicalizeRelPath(path);
        const zone = classifyWorkspacePath(path, mountPrefixes);
        if (zone !== "run" && zone !== "run-open") {
          throw new Error(
            `Cannot seed ${JSON.stringify(path)}: it resolves to the '${zone}' zone. ` +
              `Seedable paths are agent-visible session files (e.g. 'trigger.json', 'scratchpad/…').`,
          );
        }
        const contents = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
        return [canonical.path, contents] as const;
      });
      // Address the store as `<sessionId>/…` explicitly, like the checkpointer.
      const store = new Workspace(sessionStore.backend);
      for (const [path, contents] of entries) {
        const key = `${id}/${path}`;
        try {
          await store.writeText(key, contents);
        } catch (err) {
          // A create-only backend refuses to overwrite; replace the whole content
          // through `edit` instead (seeding is idempotent).
          const existing = await store.readText(key);
          if (existing == null) throw err;
          if (existing !== contents) await store.editText(key, existing, contents);
        }
      }
    },
  };
}

export function createArtifactEmitter(deps: {
  graph: CompiledAgentGraph;
  /** The governing machine, or `null` for a plain assembly. */
  machine: WorkflowMachine | null;
  workspace: Workspace;
  workflowName: string;
  runtimeContract: ResolvedRuntimeContract;
  usage: UsageTracker;
  emit: WorkflowEventEmitter;
}): EmitRunArtifacts {
  const { graph, machine, workspace, workflowName, runtimeContract, usage, emit } = deps;
  return async (sessionId, trajectory, opts) => {
    // One checkpoint read serves the trail, the usage and the variables.
    // `undefined` means unreadable — distinct from a checkpoint that holds
    // nothing: an empty trail.json must mean "no transitions", never "unreadable".
    async function readCheckpointValues(): Promise<unknown | undefined> {
      try {
        const snapshot = await asDecisionGraph(graph).getState({ configurable: { thread_id: sessionId } });
        return snapshot?.values;
      } catch {
        return undefined;
      }
    }
    // A governed session's graph is the machine's own topology; a plain agent
    // has only its compiled graph.
    const [serialized, values] = await Promise.all([
      machine ? serializeMachineGraph(machine) : serializeGraph(graph),
      machine ? readCheckpointValues() : undefined,
    ]);
    const trail = machine
      ? (opts?.trail ?? (values !== undefined ? readAuditTrail(values) : undefined))
      : undefined;
    // Usage comes from the checkpoint when there is one (a session resumed in
    // another process would otherwise report only this process's share); the
    // in-memory tracker is the fallback.
    const checkpointed = values !== undefined ? readRunUsage(values) : undefined;
    const sessionUsage = checkpointed && hasUsage(checkpointed) ? checkpointed : usage.totals(sessionId);
    // An empty store is still recorded: "took no seeded input" is a fact.
    const variables = machine && values !== undefined ? readVariables(values) : undefined;
    return writeRunArtifacts(
      workspace,
      workflowName,
      sessionId,
      {
        graph: serialized,
        trajectory,
        metadata: {
          runtimeContract,
          packageVersion: PACKAGE_VERSION,
          ...(machine ? { specHash: machine.specHash } : {}),
          ...(hasUsage(sessionUsage) ? { usage: sessionUsage } : {}),
        },
        ...(trail ? { trail } : {}),
        ...(variables !== undefined ? { variables } : {}),
      },
      emit,
    );
  };
}

/** Resolve a persisted machine spec by its `specHash`, or `null`. */
export function createSpecSnapshotReader(workspace: Workspace): (hash: string) => Promise<MachineSpec | null> {
  return (hash) => readSpecSnapshot(workspace, hash);
}
