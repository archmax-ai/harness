import { withLangGraph } from "@langchain/langgraph/zod";
import { z } from "zod";
import { emptyUsage, type UsageSummary } from "../core/usage.js";
import type { TrailStep as PublicTrailStep } from "../public/sandbox.js";
import type { VariableStore } from "../machine/variables.js";

/**
 * The checkpointed workflow channels, carried beside `messages` on the one
 * compiled graph. The governance middleware is the only writer.
 *
 * **Every hook echoes the whole state.** A middleware hook returns
 * `{ ...state, ...result }`, so a hook that touches one field rewrites every
 * other with the value it read. Every accumulating reducer here is therefore
 * idempotent on an echo — folding the value it already holds changes nothing —
 * and that property is what the reducer tests pin.
 */

// --- Park records ------------------------------------------------------------

/** The pending-decision record for a session parked at a human state; the machine-authoritative source for presenting it. */
export const pendingDecisionSchema = z.object({
  /** Slug of the human state the session is parked at — the resume routes against this. */
  state: z.string(),
  /** The parked state's `title`, when declared. A label, never a routing target. */
  title: z.string().optional(),
  /** 1-based ordinal of this decision within the session. */
  seq: z.number(),
  /** The selectable outgoing transitions. */
  transitions: z.array(
    z.object({
      to: z.string(),
      description: z.string().optional(),
      type: z.enum(["approve", "reject", "refine", "none"]).optional(),
    }),
  ),
  /** Evidence artifacts surfaced to the person (agent-visible run paths). */
  evidence: z.array(z.string()).optional(),
  createdAt: z.string(),
});

export type PendingDecision = z.infer<typeof pendingDecisionSchema>;

/** The pending-input record for a session parked with `archmax_wait`; a delivery resumes the parked state itself. */
export const pendingInputSchema = z.object({
  /** Slug of the state the session is parked in — the state a delivery resumes. */
  state: z.string(),
  title: z.string().optional(),
  /** Why the agent is waiting, in its own words. */
  reason: z.string(),
  parkedAt: z.string(),
  /** When the run asked to be resumed (absolute). A hint for whoever schedules — the runtime holds no timer. */
  resumeAt: z.string().optional(),
});

export type PendingInput = z.infer<typeof pendingInputSchema>;

/**
 * A delegation call whose sub-run parked. The head of the list is the decision
 * the session currently shows; the run parks again while any remain.
 */
export const pendingDelegationSchema = z.object({
  /** The state that made the call — where the run parks, and resumes. */
  state: z.string(),
  workflow: z.string(),
  /** The tool call this sub-run answers. */
  toolCallId: z.string(),
  /** The sub-run's identity (`<state>:<workflow>:<ordinal>`); the child's session id derives from it. */
  identity: z.string(),
  dispatchId: z.string(),
  /**
   * The child's own park, presented to the person unchanged — a decision when it
   * parked at a human state, an input park when it called `archmax_wait`. The
   * parent parks on whichever channel the child asked for, so an `archmax_wait`
   * child is delivered to rather than decided on.
   */
  decision: z.union([pendingDecisionSchema, pendingInputSchema]),
});

/**
 * Whether a delegated child's park is a decision rather than a wait. Told apart
 * structurally, on the field only a decision carries.
 */
export function isDecisionPark(
  park: PendingDelegation["decision"] | null | undefined,
): park is PendingDecision {
  return Array.isArray((park as PendingDecision | undefined)?.transitions);
}

export type PendingDelegation = z.infer<typeof pendingDelegationSchema>;

/** The state a park record names, or `""` when there is no record. */
export function parkedStateOf(record: { state?: string } | null | undefined): string {
  return record?.state ?? "";
}

/** Which channel a suspended run awaits: a person's `decision`, or external `input`. */
export type ParkChannel = "decision" | "input";

/**
 * Where a park stands: `closing` — the record is committed and the run owes one
 * tool-free message before it suspends; `suspend` — the next hook site suspends
 * the session; `null` — no park in progress.
 */
export const parkPhaseSchema = z.enum(["closing", "suspend"]);

/** Model calls made in `state` since it was entered; `budget.maxTurns` is enforced against the visit. */
export const stateTurnsSchema = z.object({ state: z.string(), count: z.number() });

// --- Trail --------------------------------------------------------------------

export const TRAIL_STEP_KINDS = ["trigger", "agent", "human", "sub-workflow", "reset", "on_error"] as const;

/** One committed traversal step: the state entered, the kind of edge, and the rationale when given. */
export const trailStepSchema = z.object({
  to: z.string(),
  kind: z.enum(TRAIL_STEP_KINDS),
  reason: z.string().optional(),
  /** `sub-workflow` steps only: the child slug and whether it completed — the parent's whole record of the sub-run. */
  workflow: z.string().optional(),
  status: z.enum(["ok", "error"]).optional(),
  /** Epoch milliseconds at commit. */
  ts: z.number(),
});

export type TrailStep = z.infer<typeof trailStepSchema>;

/** One run variable as checkpointed. Locking is monotonic. */
export const variableEntrySchema = z.object({
  value: z.unknown(),
  locked: z.boolean(),
  /** Host-boundary marker; see {@link mergeVariables}. Never persisted as meaningful state. */
  reseed: z.boolean().optional(),
});

/** The run's usage as persisted — structurally identical to {@link UsageSummary} (guarded below). */
export const usageSummarySchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  costUsd: z.number().optional(),
});

// Compile-time drift guards: the public `@archmax-ai/harness/sandbox` typing and the
// runtime usage type must stay structurally identical to the checkpoint schemas.
type _AssertMutual<A, B> = A extends B ? (B extends A ? true : never) : never;
type _TrailStepPublicParity = _AssertMutual<TrailStep, PublicTrailStep>;
const _trailStepPublicParity: _TrailStepPublicParity = true;
void _trailStepPublicParity;
type _UsageParity = _AssertMutual<z.infer<typeof usageSummarySchema>, UsageSummary>;
const _usageParity: _UsageParity = true;
void _usageParity;

// --- Fields -------------------------------------------------------------------

/** The workflow fields persisted in the checkpointer alongside `messages`. */
const workflowStateFields = {
  /** The machine's position. */
  workflowState: z.string().optional(),
  /** Why the current turn was rejected; cleared on every transition and turn. */
  rejected: z.string().nullable().optional(),
  iterations: z.record(z.string(), z.number()).optional(),
  beforeDone: z.record(z.string(), z.boolean()).optional(),
  /** The trigger that started (or last resumed) this run. Its input lives in `variables`. */
  trigger: z.object({ id: z.string() }).nullable().optional(),
  /** The state this run began in. Written once, so the reset tool has a fixed target. */
  entryState: z.string().optional(),
  /** Hash of the machine spec the session last ran under. Introspection only, never a guard. */
  specHash: z.string().optional(),
  /** Coarse lifecycle status; see {@link WORKFLOW_STATUSES}. */
  status: z.string().optional(),
  /** The pending decision — the run's own, or a delegated child's. Cleared on decision. */
  pendingDecision: pendingDecisionSchema.nullable().optional(),
  /** Monotonic count of human decisions this session has parked on. */
  decisionCount: z.number().optional(),
  /** The pending input for a session parked with `archmax_wait`. Cleared on delivery. */
  pendingInput: pendingInputSchema.nullable().optional(),
  /** Sub-runs waiting on a person, in presentation order. */
  pendingDelegations: z.array(pendingDelegationSchema).nullable().optional(),
  parkPhase: parkPhaseSchema.nullable().optional(),
  /**
   * This model call is a reply-only turn: no tools, one text reply. Set by both
   * park moments (the closing turn and a reply to a parked session) so
   * disclosure and governance read one condition. Cleared when spent.
   */
  replyOnly: z.boolean().nullable().optional(),
  /** Parks per state, keyed by slug — what `budget.maxParks` is enforced against. */
  parkCounts: z.record(z.string(), z.number()).optional(),
  stateTurns: stateTurnsSchema.nullable().optional(),
  /** Ordered audit trail. Accumulates: a writer sends only the steps it adds. */
  auditTrail: z.array(trailStepSchema).optional(),
  /**
   * Cumulative token usage (and cost). A last-value channel: the one writer adds
   * its delta to the total it reads, because an additive reducer cannot tell a
   * hook echoing the total from a delta that happens to equal it.
   */
  usage: usageSummarySchema.optional(),
  /** The run's variables, keyed by name. The channel merges, so a writer sends only its delta. */
  variables: z.record(z.string(), variableEntrySchema).optional(),
};

export type WorkflowStateFields = z.infer<z.ZodObject<typeof workflowStateFields>>;

// --- Reducers -----------------------------------------------------------------

/**
 * Merge a variable delta into the store: a host seeding boundary (`reseed`)
 * replaces anything, a locked entry is otherwise kept, any other write replaces.
 * Only runtime-owned boundaries set the marker (never the variable tools), so no
 * agent-reachable write breaks a lock. Folding a store onto itself changes nothing.
 */
export function mergeVariables(acc: VariableStore, update: VariableStore): VariableStore {
  const merged: VariableStore = { ...acc };
  for (const [name, entry] of Object.entries(update)) {
    const existing = merged[name];
    if (existing !== undefined && entry.reseed !== true && existing.locked) continue;
    // The marker is an instruction to the merge, not part of the variable.
    merged[name] = { value: entry.value, locked: entry.locked };
  }
  return merged;
}

/** Mark a delta as written at a host seeding boundary (a turn's opening, a delivery), so it replaces even a locked entry. */
export function reseedAll(delta: VariableStore): VariableStore {
  const out: VariableStore = {};
  for (const [name, entry] of Object.entries(delta)) out[name] = { ...entry, reseed: true };
  return out;
}

/** Whether two steps are the same record; every field counts, so two children delegated on one millisecond stay two steps. */
function sameStep(a: TrailStep, b: TrailStep): boolean {
  return (
    a === b ||
    (a.to === b.to &&
      a.kind === b.kind &&
      a.ts === b.ts &&
      a.reason === b.reason &&
      a.workflow === b.workflow &&
      a.status === b.status)
  );
}

/**
 * The trail's fold: an update equal to the list held is a hook's echo (no-op);
 * an update extending it replaces it; anything else (a tool seam sending only
 * its own steps, two of them in one super-step) is appended.
 */
export function foldTrail(
  acc: TrailStep[] | undefined,
  update: TrailStep[] | undefined,
): TrailStep[] {
  const current = acc ?? [];
  if (!update || update.length === 0) return current;
  if (update.length === current.length && update.every((s, i) => sameStep(s, current[i]!))) {
    return current;
  }
  if (update.length > current.length && current.every((s, i) => sameStep(s, update[i]!))) {
    return [...update];
  }
  const fresh = update.filter((step) => !current.includes(step));
  return fresh.length > 0 ? [...current, ...fresh] : current;
}

/**
 * A `pendingDelegations` update: records to add (union by identity, so a hook's
 * echo is a no-op), `null` to clear, or `{ remaining }` — the list after a
 * decision resolved its head.
 */
export type PendingDelegationsUpdate =
  | PendingDelegation[]
  | null
  | { remaining: PendingDelegation[] };

export function foldPendingDelegations(
  acc: PendingDelegation[] | null | undefined,
  update: PendingDelegationsUpdate | undefined,
): PendingDelegation[] {
  const current = acc ?? [];
  if (update === undefined) return current;
  if (update === null) return [];
  if (!Array.isArray(update)) return [...update.remaining];
  if (update.length === 0) return current;
  const incoming = new Set(update.map((record) => record.identity));
  return [...current.filter((record) => !incoming.has(record.identity)), ...update];
}

const pendingDelegationsUpdateSchema = z.union([
  z.array(pendingDelegationSchema),
  z.null(),
  z.object({ remaining: z.array(pendingDelegationSchema) }),
]);

/** A field wrapped with its channel's fold; typed loosely, the object below is re-typed as a whole. */
function reduced(
  field: z.ZodTypeAny,
  updateSchema: z.ZodTypeAny,
  fn: (acc: unknown, update: unknown) => unknown,
  initial: () => unknown,
): z.ZodTypeAny {
  return withLangGraph(field as z.ZodType<unknown>, {
    reducer: { schema: updateSchema as z.ZodType<unknown>, fn },
    default: initial,
  }) as z.ZodTypeAny;
}

/**
 * The graph's and the middleware's `stateSchema`, with the accumulating
 * channels' reducers applied. Without the wrap every field is last-value, and a
 * tool committing a delta from inside a batch would replace the channel.
 */
export const workflowStateSchema = z.object({
  ...workflowStateFields,
  pendingDelegations: reduced(
    workflowStateFields.pendingDelegations,
    pendingDelegationsUpdateSchema,
    (acc, update) =>
      foldPendingDelegations(
        acc as PendingDelegation[] | null | undefined,
        update as PendingDelegationsUpdate | undefined,
      ),
    (): PendingDelegation[] => [],
  ),
  variables: reduced(
    workflowStateFields.variables,
    workflowStateFields.variables,
    (acc, update) =>
      update
        ? mergeVariables((acc as VariableStore | undefined) ?? {}, update as VariableStore)
        : ((acc as VariableStore | undefined) ?? {}),
    (): VariableStore => ({}),
  ),
  auditTrail: reduced(
    workflowStateFields.auditTrail,
    workflowStateFields.auditTrail,
    (acc, update) => foldTrail(acc as TrailStep[] | undefined, update as TrailStep[] | undefined),
    (): TrailStep[] => [],
  ),
  // The wrap widens the reduced fields; what a hook reads and writes is the field's own shape.
}) as unknown as z.ZodObject<typeof workflowStateFields>;

// --- Readers ------------------------------------------------------------------

/** The checkpointed variable store; a checkpoint predating the field reads as empty. */
export function readVariables(state: unknown): VariableStore {
  return readWorkflowState(state).variables ?? {};
}

/** What a completed run returned, by declared name; `undefined` when nothing is declared. */
export function readReturns(
  state: unknown,
  declared: string[] | undefined,
): Record<string, unknown> | undefined {
  if (!declared || declared.length === 0) return undefined;
  const variables = readVariables(state);
  return Object.fromEntries(declared.map((name) => [name, variables[name]?.value]));
}

/** Coarse session lifecycle values written to {@link WorkflowStateFields.status}. */
export const WORKFLOW_STATUSES = {
  running: "running",
  completed: "completed",
  rejected: "rejected",
  awaitingDecision: "awaiting_decision",
  awaitingInput: "awaiting_input",
} as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[keyof typeof WORKFLOW_STATUSES];

/** The statuses of a run that is over; a parked session is open. */
export const FINISHED_STATUSES: ReadonlySet<string> = new Set<WorkflowStatus>([
  WORKFLOW_STATUSES.completed,
  WORKFLOW_STATUSES.rejected,
]);

export type SessionClassification = "finished" | "open";

export function isFinished(status: string | undefined): boolean {
  return status !== undefined && FINISHED_STATUSES.has(status);
}

export function classifyStatus(status: string | undefined): SessionClassification {
  return isFinished(status) ? "finished" : "open";
}

/** The checkpointed usage totals; a checkpoint predating the field reads as zeroed. */
export function readRunUsage(state: unknown): UsageSummary {
  const usage = readWorkflowState(state).usage;
  return usage ? { ...emptyUsage(), ...usage } : emptyUsage();
}

export function readAuditTrail(state: unknown): TrailStep[] {
  const trail = readWorkflowState(state).auditTrail;
  return Array.isArray(trail) ? trail : [];
}

export function readWorkflowState(state: unknown): WorkflowStateFields {
  if (!state || typeof state !== "object") return {};
  return state as WorkflowStateFields;
}

export function currentWorkflowState(state: unknown, fallback: string): string {
  return readWorkflowState(state).workflowState ?? fallback;
}

/** One reader for disclosure, the prompt section and the kernel, so a parked run cannot be disclosed one way and governed another. */
export function isReplyOnly(state: unknown): boolean {
  return readWorkflowState(state).replyOnly === true;
}

/** What a hook or a serviced tool call commits: a channel delta, appended messages, and where the loop goes next. */
export type WorkflowUpdate = Partial<Omit<WorkflowStateFields, "pendingDelegations">> & {
  pendingDelegations?: PendingDelegationsUpdate;
  messages?: unknown[];
  jumpTo?: "model" | "end";
};

/** The park record a session currently holds, on either channel, or `null`. */
export function pendingParkOf(
  state: unknown,
): { channel: ParkChannel; record: PendingDecision | PendingInput } | null {
  const fields = readWorkflowState(state);
  if (fields.pendingDecision) return { channel: "decision", record: fields.pendingDecision };
  if (fields.pendingInput) return { channel: "input", record: fields.pendingInput };
  return null;
}
