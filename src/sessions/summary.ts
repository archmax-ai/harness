/**
 * One session's projection, read by key from its latest checkpoint — and the
 * listing built from it. A reading of checkpointed state rather than part of the
 * saver, so it works for any `BaseCheckpointSaver`, an in-memory one included.
 */
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { z } from "zod";
import { hasUsage, type UsageSummary } from "../core/usage.js";
import type { Workspace } from "../core/workspace.js";
import { isReservedRootName } from "../core/zones.js";
import type { VariableStore } from "../machine/variables.js";
import {
  classifyStatus,
  parkedStateOf,
  usageSummarySchema,
  variableEntrySchema,
  type SessionClassification,
  type WorkflowStatus,
} from "../workflow/state.js";
import { parentSessionIdOf } from "./scope.js";

/** Coarse projection of a durable session, derived from its latest checkpoint. */
export interface SessionSummary {
  /** The conversation this summary describes — the only id there is. */
  sessionId: string;
  status?: WorkflowStatus;
  /** Which side of the open/finished partition {@link status} falls on — a parked session is open, never finished. */
  classification?: SessionClassification;
  /** The state the session currently occupies — where its next turn continues. */
  workflowState?: string;
  /** The definition the session's latest turn ran under (metadata, never a guard). */
  specHash?: string;
  /** For parked sessions, the state awaiting a human decision or an external event. */
  state?: string;
  /**
   * For a session the agent parked with `archmax_wait`, its own stated reason. A
   * park declares no awaited trigger ids (any firing resumes it), so this is
   * what a surface shows instead.
   */
  waitReason?: string;
  /**
   * When such a park asked to be resumed (absolute), when it declared an `until`.
   * A host's scheduler is a query over this listing; the runtime schedules nothing.
   */
  resumeAt?: string;
  /**
   * The session's variables as the checkpoint holds them — `name → { value, locked }`,
   * omitted when the session has none. `locked` marks a host-established entry;
   * an unlocked one came from the agent's own `archmax_set_variables`.
   */
  variables?: VariableStore;
  /**
   * What the session has cost so far: cumulative token counts, plus `costUsd`
   * when pricing is configured; omitted when nothing has been spent. Read from
   * the checkpoint, so a session resumed in another process reports the whole.
   */
  usage?: UsageSummary;
  /** The session that dispatched this one, when it is a child session (see `isChildSessionOf`). */
  parentSessionId?: string;
}

/**
 * Project a session's latest checkpoint into a {@link SessionSummary} using only
 * `getTuple`, so it works for **any** `BaseCheckpointSaver`. Session resolution
 * depends on this answer being real: `null` means "this session has not run yet".
 */
export async function summarizeCheckpointedSession(
  checkpointer: BaseCheckpointSaver,
  sessionId: string,
): Promise<SessionSummary | null> {
  const tuple = await checkpointer.getTuple({ configurable: { thread_id: sessionId } });
  if (!tuple) return null;
  const values = (tuple.checkpoint.channel_values ?? {}) as Record<string, unknown>;
  const pendingDecision = values.pendingDecision as { state?: string } | null | undefined;
  const pendingInput = values.pendingInput as
    | { state?: string; reason?: string; resumeAt?: string }
    | null
    | undefined;
  const parkedAt = parkedStateOf(pendingDecision) || parkedStateOf(pendingInput);
  const status = typeof values.status === "string" ? (values.status as WorkflowStatus) : undefined;
  // Parsed rather than cast: an older or malformed checkpoint reads as "none"
  // instead of failing a listing.
  const parsedVariables = z.record(z.string(), variableEntrySchema).safeParse(values.variables);
  const variables = parsedVariables.success ? parsedVariables.data : undefined;
  const parsedUsage = usageSummarySchema.safeParse(values.usage);
  const usage = parsedUsage.success ? parsedUsage.data : undefined;
  const parent = parentSessionIdOf(sessionId);
  return {
    sessionId,
    status,
    classification: classifyStatus(status),
    workflowState: typeof values.workflowState === "string" ? values.workflowState : undefined,
    specHash: typeof values.specHash === "string" ? values.specHash : undefined,
    ...(parkedAt ? { state: parkedAt } : {}),
    ...(typeof pendingInput?.reason === "string" ? { waitReason: pendingInput.reason } : {}),
    ...(typeof pendingInput?.resumeAt === "string" ? { resumeAt: pendingInput.resumeAt } : {}),
    ...(variables && Object.keys(variables).length > 0 ? { variables } : {}),
    ...(usage && hasUsage(usage) ? { usage } : {}),
    ...(parent ? { parentSessionId: parent } : {}),
  };
}

/**
 * Enumerate durable sessions by listing the session store's root (one
 * `<sessionId>/` folder per session) and projecting each latest checkpoint.
 * Runs outside any bound session, so the listing is the raw store root: reserved
 * root names (authored mounts, `_specs/`, session areas) and sessions without a
 * readable checkpoint are skipped.
 */
export async function listSessions(
  workspace: Workspace,
  checkpointer: BaseCheckpointSaver,
): Promise<SessionSummary[]> {
  const entries = await workspace.listDir("");
  const sessionIds = entries
    .map((entry) => String(entry.path ?? "").replace(/\/+$/, "").split("/").pop() ?? "")
    .filter((sessionId) => sessionId && !isReservedRootName(sessionId));
  const summaries = await Promise.all(
    sessionIds.map((id) => summarizeCheckpointedSession(checkpointer, id)),
  );
  return summaries.filter((summary): summary is SessionSummary => summary !== null);
}
