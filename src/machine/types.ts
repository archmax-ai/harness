/**
 * The `workflow.yaml` shape, as types.
 *
 * Every type here is inferred from `machine/spec-schema.ts` — the schema *is*
 * the spec, and these aliases exist so call sites read as domain vocabulary
 * (`MachineState`) rather than as `z.infer<typeof machineStateSchema>`.
 */
import type { z } from "zod";
import type {
  allowEntrySchema,
  forbidEntrySchema,
  machinePromptCacheSettingsSchema,
  machineSettingsSchema,
  machineSpecSchema,
  machineStateSchema,
  machineTransitionSchema,
  stateTypeSchema,
  runtimeMetadataSchema,
  skillsBlockSchema,
  mountsBlockSchema,
  mountAccessSchema,
  mountGrantEntrySchema,
  signatureEntryObjectSchema,
  specMetadataSchema,
  stateBudgetSchema,
  workflowBudgetSchema,
  toolsBlockSchema,
  transitionTypeSchema,
  triggerDeclarationSchema,
  workflowTestsConfigSchema,
  workflowSkillsConfigSchema,
  workflowMountsConfigSchema,
  workflowToolsConfigSchema,
} from "./spec-schema.js";

/**
 * Semantic classification of an outgoing edge, primarily for **human states**: a
 * UI can render `approve`/`reject`/`refine` as distinct decision buttons, and
 * `none` (the default) is an ordinary route. A human state declares at most one
 * transition of each labeled type. Metadata only on agent states.
 */
export type TransitionType = z.infer<typeof transitionTypeSchema>;

/**
 * One outgoing edge of a state. The agent is disclosed the active state's edges
 * and nothing else of the graph, so `description` is what it routes on — write it
 * for a reader standing in the source state, which knows nothing of the target
 * ("Refunds over $50", never "go to refund-review"). An **undescribed** edge
 * (absent, empty or blank) routes on the target state's `instructions` instead,
 * which the edge then discloses; it loads only when the target has some. At a
 * human state the description is also the decision's button label, and required.
 */
export type MachineTransition = z.infer<typeof machineTransitionSchema>;

/**
 * Per-state execution budget. `maxTurns` bounds the model calls of the state's
 * visit — the session's agent in an agent state, the grader's own in a grader
 * state; `timeoutMs` aborts a model call (an agent state) or the whole grader
 * run (a grader state) when exceeded; `maxParks` bounds how many times an agent
 * state may park itself with `archmax_wait`. Any exhaustion is a state failure
 * subject to `on_error`. A code state takes no budget: it makes no model call.
 */
export type StateBudget = z.infer<typeof stateBudgetSchema>;

/**
 * Workflow-wide execution budget. `maxModelCalls` bounds the model calls of one
 * turn (an invocation: a message, a decision, a reply or a delivery) across every
 * state; exhausting it is a failure of the current state, subject to `on_error`.
 */
export type WorkflowBudget = z.infer<typeof workflowBudgetSchema>;

/** The turn budget a workflow runs under when it declares none. */
export const DEFAULT_MAX_MODEL_CALLS = 50;

/** One entry of a `tools.allow` list: a bare tool name, or a constrained shape. */
export type AllowEntry = z.infer<typeof allowEntrySchema>;

/**
 * Per-state tool governance. Allow-only: a state with `allow` permits exactly the
 * listed tools/arg-shapes plus the workflow-wide grant (the declared
 * `allow_always`, else the default tools) and the host's `essentialTools`; a
 * state without one gets those two only.
 */
export type ToolsBlock = z.infer<typeof toolsBlockSchema>;

/**
 * A denial entry: the same grammar as {@link AllowEntry}, plus the tool `*`
 * meaning every tool. Deny beats allow, and no narrower level widens a denial —
 * so a wildcard is safe here and a document-level error in an `allow` list.
 */
export type ForbidEntry = z.infer<typeof forbidEntrySchema>;

/**
 * A **state's** skill governance by slug: what this state adds to the workflow's
 * always-on grant. A skill is enabled only where a list names it — an absent
 * block adds nothing, exactly as `allow: []` does, and exactly as an absent
 * `tools.allow` grants no tool.
 */
export type SkillsBlock = z.infer<typeof skillsBlockSchema>;

/**
 * A **state's** mount governance by name: what this state adds to the
 * workflow's always-on grant, and what it subtracts. A mount the host declared
 * governed is enabled only where a list names it; an ungoverned mount is
 * visible in every state and `forbid` is what takes it away.
 */
/**
 * How a state may use a mount it is given: `read` refuses writes there,
 * `read_write` permits them where the host declared the mount writable. The
 * host's posture is the ceiling — `read_write` cannot open a read-only mount —
 * so this key's real work is narrowing a writable mount in the states that only
 * read it.
 */
export type MountAccess = z.infer<typeof mountAccessSchema>;

/**
 * One entry of a mounts grant list: a bare mount name, taking the write posture
 * the host declared, or `{ mount, access }` naming the access this level gives.
 * Normalized to one shape by `normalizeMountGrants` (`machine/mount-grants.ts`).
 */
export type MountGrantEntry = z.infer<typeof mountGrantEntrySchema>;

export type MountsBlock = z.infer<typeof mountsBlockSchema>;

/**
 * The kind of a state: `agent` (default) runs a Deep Agent turn that picks a
 * transition with `archmax_advance`; `human` parks the session and a person picks
 * the outgoing edge; `grader` runs an isolated grader subagent and `code` runs
 * the state's `script` in the sandbox — the two **automated** types, which the
 * runtime runs on entry with no model call of the session's agent and which
 * leave by `archmax_advance` or end the session by `archmax_raise`.
 */
export type StateType = z.infer<typeof stateTypeSchema>;

/**
 * One state of the graph, keyed in {@link MachineSpec.states} by its **slug** —
 * its sole identity. Every reference to a state (`to`, `on_error`, the `to` the
 * agent passes to `archmax_advance`, events, artifacts, test assertions) is a
 * slug.
 *
 * `model` names the model id this state's turns run on — an id only, resolved
 * over the endpoint and credentials the assembly is already configured with. It
 * is the most specific position of the chain state → {@link MachineSettings}
 * `model` → the assembly's default, read once through `WorkflowMachine.modelFor`.
 */
export type MachineState = z.infer<typeof machineStateSchema>;

/**
 * Workflow-level tool governance. A declared `allow_always` is the whole
 * workflow-wide grant; an absent one grants the default tools.
 */
export type WorkflowToolsConfig = z.infer<typeof workflowToolsConfigSchema>;

/**
 * Workflow-level skill governance: `allow_always` is enabled in every state and
 * a state's `skills.allow` adds to it; `forbid_always` denies in every state and
 * beats every grant. See {@link SkillsBlock} for the state's half.
 */
export type WorkflowSkillsConfig = z.infer<typeof workflowSkillsConfigSchema>;

/**
 * Workflow-level mount governance: `allow_always` enables its governed mounts
 * in every state and a state's `mounts.allow` adds to it; `forbid_always`
 * denies in every state, beats every grant, and binds every descendant session.
 * See {@link MountsBlock} for the state's half.
 */
export type WorkflowMountsConfig = z.infer<typeof workflowMountsConfigSchema>;

/** Workflow-declared provider prompt-cache settings. */
export type MachinePromptCacheSettings = z.infer<typeof machinePromptCacheSettingsSchema>;

/**
 * Sandbox and prompt-cache knobs declared at the spec root, plus `model`: the
 * model id every state of this workflow runs on unless the state names its own.
 * An id only — the endpoint, credentials and sampling stay the assembly's
 * configuration — and it overrides `ARCHMAX_MODEL`, not a host's explicit `model`.
 */
export type MachineSettings = z.infer<typeof machineSettingsSchema>;

/** Offline-test suite configuration declared at the spec root. */
export type WorkflowTestsConfig = z.infer<typeof workflowTestsConfigSchema>;

/**
 * Optional runtime contract declaration: the authoring/runtime semantics a
 * workspace expects, independent of the installed npm version.
 */
export type RuntimeMetadata = z.infer<typeof runtimeMetadataSchema>;

/**
 * One trigger's declaration, under the `triggers:` of the state it enters: how
 * its firings map to a session, and the run's signature. The state it sits on
 * is its entry state and the key it sits under is its id, so neither is a key
 * of the declaration.
 */
export type TriggerDeclaration = z.infer<typeof triggerDeclarationSchema>;

/**
 * The object spelling of a `requires`/`returns` entry: `{ name, type?,
 * description? }`, beside the bare name that means the same untyped entry. Read
 * both spellings through `normalizeSignature`, never by hand.
 */
export type SignatureEntryDeclaration = z.infer<typeof signatureEntryObjectSchema>;

/**
 * Host data, accepted at two positions: the spec root (an authoring UI's canvas
 * state) and a state (a node's position). Preserved across a load, never read by
 * the runtime, and dropped before the spec is hashed.
 */
export type SpecMetadata = z.infer<typeof specMetadataSchema>;

/** The whole of `workflow.yaml`. */
export type MachineSpec = z.infer<typeof machineSpecSchema>;

/** Runtime knobs derived from `settings`, consumed by the harness. */
export interface HarnessSettings {
  timeoutMs: number;
  memoryLimitBytes?: number;
  maxPtcCalls?: number | null;
  maxResultChars?: number;
  /** Prompt-cache declaration, when present. */
  promptCache?: { enabled?: boolean; ttl?: string };
}

/**
 * Whether a spec declares itself out of service — the single interpretation
 * point for {@link MachineSpec.disabled}; a function because some callers hold a
 * spec that cannot build a machine. Read fail-closed: set unless the value is
 * absent, `null`, or boolean `false`, so a mis-authored truthy value stops the
 * workflow rather than running it.
 */
export function specDisabled(spec: MachineSpec | null | undefined): boolean {
  const declared = (spec as { disabled?: unknown } | null | undefined)?.disabled;
  return declared !== undefined && declared !== null && declared !== false;
}
