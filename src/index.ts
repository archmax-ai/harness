/**
 * `@archmax-ai/harness` — a generic, backend-driven agent runtime built on LangChain Deep
 * Agents. Assemble a governed agent with {@link createAgent}, point it at a
 * workspace of authored workflows, and drive it like any Deep Agent.
 *
 * The runtime reads its entire agent definition (machine spec, system prompt,
 * skills, scripts) and session state through a single Deep Agents
 * backend, so the same code runs over a local filesystem, a store, a sandbox, or
 * a remote backend without modification.
 *
 * **What is public.** This barrel is the supported surface, and every export
 * carries a docstring saying what it is for. It is deliberately small: an export
 * is here because a real consumer needs it, not because a module happened to
 * expose it. Adjacent surfaces live on their own subpaths — `@archmax-ai/harness/testing`
 * (the case engine), `@archmax-ai/harness/cli` (the state-flow renderer), and
 * `@archmax-ai/harness/sandbox` (hook and script authoring) — so a production import never
 * pulls in test machinery.
 *
 * Two **light** subpaths mirror part of this surface without the runtime behind
 * it: `@archmax-ai/harness/spec` (the schema, the pure validator and the grammars —
 * browser-safe) and `@archmax-ai/harness/messages` (transcript readers). A name on
 * both is the same binding.
 *
 * Anything not exported here is internal and may change without a major version.
 */

// --- Assembly -----------------------------------------------------------------

/**
 * Assemble an agent: Deep Agents' own parameters plus `workflow`. Omit `workflow`
 * for a plain Deep Agent; supply it and the same agent is governed by that
 * machine. Returns a wrapper over the compiled graph — `invoke` / `stream` /
 * `graph` — with governance under `.workflow`.
 */
export { createAgent } from "./assembly/index.js";
/** The wrapper class {@link createAgent} returns. */
export { ArchmaxAgent } from "./agent.js";
export type {
  /** Parameters for {@link createAgent}. */
  CreateAgentParams,
  /** Where files come from and where sessions go (the `workspace` group). */
  AgentWorkspaceParams,
} from "./assembly/index.js";
export type {
  /** What {@link createAgent} returns. */
  Agent,
  /** The governance surface at `agent.workflow`, `undefined` when ungoverned. */
  WorkflowSurface,
  /** A turn's input to `agent.workflow.send`. */
  TurnInput,
  /** What `agent.workflow.send` takes: a turn or a resume. */
  SendInput,
} from "./agent.js";
/** Session handles over the configured session store (`agent.sessions`). */
export type { SessionOperations } from "./sessions/operations.js";
export type {
  /** How a session is started: a trigger id. */
  TriggerInput,
  /** A resolved trigger: its id plus the start state it enters. */
  ResolvedTrigger,
} from "./machine/triggers.js";
export type {
  /** What one `send` produced, whichever way it entered the session. */
  Outcome,
  /** One of the three resumes: a decision, a reply, or a delivery. */
  ResumePayload,
  /** The person's answer, as `agent.workflow.decide()` takes it. */
  DecisionResolution,
  /** A firing delivered into a parked session, as `agent.workflow.deliver()` takes it. */
  TriggerDelivery,
  /** The outcome of deciding a parked human state. */
  DecideOutcome,
  /** The outcome of replying to a session parked at a human state. */
  ReplyOutcome,
  /** The outcome of delivering into a session parked with `archmax_wait`. */
  DeliverOutcome,
  /** The child a parked session's pending decision belongs to (`Outcome.delegation`). */
  DelegatedPark,
} from "./sessions/resume.js";
/**
 * Read a session that must be parked in `status` — the checkpointed status **and**
 * a live suspension — or `null`. What every resume asks before touching the graph.
 */
export { readParkedSession } from "./sessions/resume.js";
export {
  /** The park record a session's checkpointed values hold, on either channel, or `null`. */
  pendingParkOf,
  /** The state a park record names, or `""` when there is none. */
  parkedStateOf,
} from "./workflow/state.js";
export type {
  /** What `agent.workflow.resolveSession()` takes: one firing. */
  ResolveSessionInput,
  /** Where a firing lands: the session and its disposition. */
  ResolvedSession,
} from "./sessions/resolve.js";
export type {
  /** The checkpointed record a session parked at a human state presents. */
  PendingDecision,
  /** The checkpointed record a session parked with `archmax_wait` presents. */
  PendingInput,
} from "./workflow/state.js";
/**
 * The checkpoint-facing half of a compiled graph, for a host that drives
 * LangGraph directly (`getState`, `updateState`) against `agent.graph`.
 */
export type { IntrospectableStateGraph } from "./core/deepagents.js";
/** One session's projection: status, position, variables, usage, parent. */
export type { SessionSummary } from "./sessions/summary.js";

// --- Errors -------------------------------------------------------------------
//
// Each is thrown by assembly or by a public operation, so a consumer that wants
// to distinguish a cause from a message needs the class.

export {
  /** A named workflow has no loadable machine spec — assembly fails closed. */
  WorkflowLoadError,
  /** A turn would start a session on a workflow that declares `disabled: true`. */
  WorkflowDisabledError,
} from "./machine/load-spec.js";
/** A trigger id the machine does not declare. */
export { UnknownTriggerError } from "./machine/triggers.js";
/** A host tool wearing a reserved `archmax_` name. */
export { ReservedToolNameError } from "./machine/tool-names.js";
/** A seeded variable name that is not a legal identifier. */
export { InvalidVariableNameError } from "./machine/variables.js";
/** A mount key shadows a session area. */
export { MountCollisionError } from "./core/mounts.js";
export {
  /** A custom `backend` was supplied without a `sessionStore`. */
  SessionStoreRequiredError,
  /** A session id that would escape its zone or shadow a reserved name. */
  SessionStoreIdError,
  /** A session operation the configured store cannot perform (delete, list). */
  SessionStoreCapabilityError,
} from "./core/session-store.js";
export {
  /** The authoring backend was also served by a writable mount. */
  AuthoringBackendExposedError,
  /** A partly composed workspace needed a filesystem default and no `rootDir` was given. */
  WorkspaceRootRequiredError,
} from "./core/workspace-context.js";
/** A workspace declared a `runtime.version` this build does not implement. */
export { UnsupportedRuntimeContractError } from "./runtime/contract.js";
export {
  /** A decision or reply for a session not parked at a human state. */
  SessionNotParkedError,
  /** A decision naming a target the parked state does not declare. */
  InvalidDecisionTargetError,
  /** A reply with nothing to answer. */
  EmptyMessageError,
  /** A delivery to a session not parked with `archmax_wait`. */
  SessionNotAwaitingInputError,
  /** A delivery naming no trigger id. */
  MissingDeliveryTriggerError,
} from "./sessions/resume.js";
/** A firing for a session whose turn is still in progress. */
export { SessionNotResumableError } from "./sessions/resolve.js";

// --- Workspace composition ----------------------------------------------------

/** The conventional mount table for a filesystem workspace. */
export { defaultMounts } from "./core/mounts.js";
/** Rebase one backend so it can serve several mounts. */
export { mountSubtree } from "./core/path-mapping.js";
/** One mount: a backend, or `{ backend, readOnly }`. */
export type { MountSpec } from "./core/mounts.js";

export {
  /** Filesystem session store (the zero-config default). */
  createFilesystemSessionStore,
  /** Session store over any Deep Agents backend (e.g. S3). */
  createBackendSessionStore,
  /** Ephemeral session store, for tests and one-shot sessions. */
  createMemorySessionStore,
} from "./core/session-store.js";
/** Physical storage for sessions. */
export type { SessionStore } from "./core/session-store.js";

/** Whether a name is reserved at the workspace root (a session area or a mount). */
export { isReservedRootName } from "./core/zones.js";
/** Why a session id cannot own a session folder, or `null` when it can — the rule every ingress applies. */
export { sessionIdRejection } from "./core/session-id.js";
/** Whether one session was dispatched by another (`<parent>~<state>:<workflow>:<n>`), at any depth. */
export { isChildSessionOf } from "./sessions/scope.js";
/** Which zone a workspace path belongs to — the kernel's own classifier (a host maps evidence paths with it). */
export { classifyWorkspacePath } from "./core/zones.js";
export type { WorkspaceZone } from "./core/zones.js";
/** The resolved mount keys a workspace classifies paths against. */
export type { MountPrefixes } from "./core/zones.js";

/**
 * Build the workspace composite the assembly uses. Public because a consumer
 * serving authored content from its own backend needs the same composition.
 */
export { createWorkspaceContext } from "./core/workspace-context.js";
/** What {@link createWorkspaceContext} returns: the composed backends and mounts. */
export type { WorkspaceContext } from "./core/workspace-context.js";
/** Where a workspace may override the bundled platform prompt (`.platform/system/GRAPH_STATE.md`). */
export { PLATFORM_PROMPT_PATH } from "./workflow/paths.js";

// --- Prompt and message plumbing ---------------------------------------------
//
// Blessed internals. A consumer that assembles its own agent needs exactly these
// to compose a system prompt and read what a session said.

/** Compose the system prompt from persona, platform, zones and workflow layers. */
export { resolveSystemPrompt } from "./core/prompt.js";
/** Bind a `name → tool` map in the shape the `tools` option takes. */
export { toolsFromMap } from "./workflow/agent-tools.js";
/** A message's text, whatever content-block shape it arrived in. */
export { contentToString } from "./core/messages.js";
/** Whether a message is the assistant's turn. */
export { isAiMessage } from "./core/messages.js";
/** The last thing the agent said to the person; tool results and runtime notes are skipped. */
export { lastAgentText } from "./core/messages.js";
/**
 * Whether the runtime wrote a transcript message rather than a person — a
 * decision, an arrival, an error route, a completion check, a child's result.
 * A host slicing a turn out of a session's messages, or rendering a transcript,
 * asks this instead of inferring authorship from role.
 */
export { isRuntimeNote } from "./core/messages.js";
/** Which kind of runtime note a message is, or `null` if a person wrote it. */
export { runtimeNoteKind } from "./core/messages.js";
export type { RuntimeNoteKind } from "./core/messages.js";
/** One grading rubric, as declared inline on the hook that applies it. */
export type { RubricDeclaration } from "./machine/types.js";
/** Host data the runtime never reads, at the spec root, on a state, or on a rubric. */
export type { SpecMetadata } from "./machine/types.js";
/** Parse a sandbox script's leading description block. */
export { parseCodeDescription } from "./core/code-description.js";

// --- The machine --------------------------------------------------------------

/** Load and shape-check a `workflow.yaml` without assembling an agent. */
export { loadMachineSpec } from "./machine/load-spec.js";
/** A `before:`/`after:` declaration as a flat list of hooks. */
export { normalizeHooks } from "./lifecycle/hook-shape.js";
export type { MachineSpec, MachineState } from "./machine/types.js";
/** The compiled machine, as `agent.workflow.machine` exposes it. */
export { WorkflowMachine } from "./machine/machine.js";

/** Statically validate a workflow scaffold — no model calls. */
export { validateWorkflow } from "./validate/validate.js";
export type { ValidationResult, Diagnostic } from "./validate/validate.js";

/** A custom governance rule, inserted after the safety and policy rules. */
export type { GovernanceRule } from "./kernel/kernel.js";

/**
 * The dispatcher's default delegation bounds. Public because a host configuring
 * `bounds` needs to know what it is overriding.
 */
export {
  DEFAULT_SUB_WORKFLOW_DEPTH,
  DEFAULT_SUB_WORKFLOW_CONCURRENCY,
} from "./machine/delegation.js";

// --- Names a host must not hard-code -----------------------------------------

export {
  /** The entry trigger id (`manual`). */
  MANUAL_TRIGGER,
  /** The trigger applied when none is supplied (same value as `MANUAL_TRIGGER`). */
  DEFAULT_TRIGGER_ID,
  /** The session id a firing of a trigger resolves to under a spec, or `undefined` when the runtime mints one. */
  sessionIdForTrigger,
} from "./machine/triggers.js";
/** Default workflow slug when none is named. */
export { DEFAULT_WORKFLOW } from "./workflow/paths.js";
export {
  /** Prefix of every delegation tool name. */
  WORKFLOW_TOOL_PREFIX,
  /** The delegation tool name for a workflow slug. */
  workflowToolName,
  /** The workflow slug a delegation tool name refers to. */
  workflowSlugFromToolName,
} from "./machine/tool-names.js";

// --- Event stream -------------------------------------------------------------

export type {
  /** Every runtime diagnostic, as one typed union. */
  WorkflowLifecycleEvent,
  /** The `onEvent` subscriber. */
  WorkflowEventHandler,
} from "./core/events.js";

// --- Token accounting ---------------------------------------------------------

/** Fold `model-usage` events into per-session totals and cost. */
export { createUsageTracker } from "./core/usage.js";
/** Render a usage summary for a footer or a log line. */
export { formatUsage } from "./core/usage.js";
export type { UsageSummary, PricingTable } from "./core/usage.js";

// --- Environment --------------------------------------------------------------
//
// A backend that assembles its own runtime needs these and there is no `./env`
// subpath. Dropping one is a silent break: destructuring a missing named export
// off a dynamic `import()` yields `undefined`.

/** Build the env-configured chat model to pass as `model`. */
export { createChatModel } from "./env.js";
export {
  /**
   * The bundled authoring skill's parent directory (holding `archmax-harness/`), so an
   * authoring agent's reference always matches the installed SDK.
   */
  BUNDLED_AUTHORING_SKILL_DIR,
} from "./env.js";
/** This package's version, as session metadata records it. */
export { PACKAGE_VERSION } from "./env.js";

// --- Runtime contract ---------------------------------------------------------

/** The resolved `runtime.version` and the surfaces it implies. */
export type { RuntimeContract, ResolvedRuntimeContract } from "./runtime/contract.js";
