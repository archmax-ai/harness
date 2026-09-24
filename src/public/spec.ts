/**
 * `@archmax-ai/harness/spec` — the workflow vocabulary with **no runtime behind it**:
 * the `workflow.yaml` schema, the pure validator, the slug, variable and
 * session-path grammars, the reserved names and the path conventions.
 *
 * Browser-safe by construction: nothing reachable from here imports `node:*`,
 * LangGraph, Deep Agents, the sandbox or a filesystem library, and a unit test
 * walks this module's import graph to keep it that way. An editor bundles it
 * into a page; an API request path that only has to parse or validate a spec
 * imports it without loading the runtime.
 *
 * What is **not** here, because it cannot be pure: loading a spec from a
 * backend (`loadMachineSpec`), compiling one (`WorkflowMachine`), the full
 * validator (`validateWorkflow`, which also probes the kernel and reads hook
 * scripts), resolving a trigger against a machine, and every store and mount.
 * Those stay on the package root.
 *
 * Several names here are also on the root. That is deliberate: this subpath
 * exists for the weight of the import, not to move the names — and a test pins
 * that a shared name is the same binding on both.
 */

// --- The schema --------------------------------------------------------------

export {
  /** The whole `workflow.yaml` document. Parse with it and pass the **output** on; never compose it into another schema. */
  machineSpecSchema,
  /** One state. */
  machineStateSchema,
  /** A trigger's declaration under a state's `triggers:`. Loose: host keys pass through. */
  triggerDeclarationSchema,
  /** A state's `triggers:` mapping — trigger id to declaration (or `null`). */
  stateTriggersSchema,
  /** One transition. */
  machineTransitionSchema,
  transitionTypeSchema,
  stateTypeSchema,
  stateBudgetSchema,
  allowEntrySchema,
  forbidEntrySchema,
  /** The `*` entry a `forbid` list uses to refuse every tool. */
  FORBID_ANY_TOOL,
  toolsBlockSchema,
  skillsBlockSchema,
  mountAccessSchema,
  mountGrantEntrySchema,
  mountsBlockSchema,
  workflowMountsConfigSchema,
  hookSchema,
  hookSpecSchema,
  rubricDeclarationSchema,
  workflowToolsConfigSchema,
  workflowSkillsConfigSchema,
  machineSettingsSchema,
  machinePromptCacheSettingsSchema,
  workflowTestsConfigSchema,
  runtimeMetadataSchema,
  specExtensionsSchema,
  /** The loose slot for host metadata at the root, on a state and on a rubric. */
  specMetadataSchema,
  /** Shape plus document-level cross-references, as one total function. */
  parseMachineSpec,
  /** The document-level rules alone, over a spec the shape has accepted. */
  refineSpec,
} from "../machine/spec-schema.js";
export type { SpecSchemaIssue } from "../machine/spec-schema.js";

export type {
  MachineSpec,
  MachineState,
  MachineTransition,
  TransitionType,
  Hook,
  HookSpec,
  StateBudget,
  AllowEntry,
  ForbidEntry,
  ToolsBlock,
  SkillsBlock,
  MountAccess,
  MountGrantEntry,
  MountsBlock,
  WorkflowMountsConfig,
  StateType,
  WorkflowToolsConfig,
  WorkflowSkillsConfig,
  MachineSettings,
  MachinePromptCacheSettings,
  WorkflowTestsConfig,
  RuntimeMetadata,
  TriggerDeclaration,
  SpecExtensions,
  SpecMetadata,
  RubricDeclaration,
} from "../machine/types.js";
/** Whether a spec declares itself out of service (`disabled: true`). */
export { specDisabled } from "../machine/types.js";

// --- Validation and advisories --------------------------------------------------

export {
  /** Everything the document alone can say: shape, cross-references and lint, as diagnostics. */
  validateSpec,
  /** One structural issue as an error-severity diagnostic. */
  schemaIssueDiagnostic,
} from "../machine/validate-spec.js";
export type { SpecValidation } from "../machine/validate-spec.js";
/** The advisories alone, over a spec the schema has accepted. */
export { lintSpec } from "../machine/lint-spec.js";
export type { Diagnostic, DiagnosticSeverity } from "../machine/diagnostic.js";

// --- Mount grants -----------------------------------------------------------------

export { normalizeMountGrants } from "../machine/mount-grants.js";
export type { NormalizedMountGrant } from "../machine/mount-grants.js";
export {
  /** The mount a canonical relative path addresses, longest key first. */
  mountNameOf,
  /** The mount a glob can only ever match inside, or `null` when it is broader. */
  mountNameOfPattern,
} from "../core/zones.js";

// --- Hooks ------------------------------------------------------------------------

export {
  /** A `before:`/`after:` declaration as a flat list of hooks. */
  normalizeHooks,
  /** A hook's kind (`script`, `subagent`, a custom one). */
  hookKind,
  /** A hook's value: the script path, the rubric name. */
  hookValue,
  /** The keys that ride beside a hook's kind (`max_iterations`) rather than naming one. */
  HOOK_SIDECAR_KEYS,
} from "../lifecycle/hook-shape.js";

// --- Slugs, triggers, variables --------------------------------------------------

export { SLUG_PATTERN, isSlug } from "../machine/slug.js";

export {
  MANUAL_TRIGGER,
  DEFAULT_TRIGGER_ID,
  /** Parse a dotted session path (`triggers.-1.conversationId`). */
  parseSessionPath,
  /** Resolve a parsed session path against a firing's variables. */
  resolveSessionId,
  /** The session id a firing of a trigger resolves to under a spec, or `undefined` when the runtime would mint one. */
  sessionIdForTrigger,
  /** Every trigger a spec declares, keyed by id, with the state each enters. */
  triggerBindings,
  /** The trigger ids one state declares. */
  stateTriggerIds,
  /** Every variable a spec's `requires` declarations guarantee. */
  declaredVariableNames,
} from "../machine/triggers.js";
export type {
  SessionPath,
  SessionPathParse,
  TriggerBinding,
  TriggerInput,
  ResolvedTrigger,
} from "../machine/triggers.js";

export {
  VARIABLE_NAME_PATTERN,
  /** The reserved variable holding the session's current trigger id. */
  TRIGGER_VARIABLE,
  /** The reserved variable naming the session's task for a listing. */
  TITLE_VARIABLE,
  TITLE_MAX_LENGTH,
  /** Whether a glob or text carries a `${{…}}` reference. */
  hasVariableReference,
  /** Every `${{…}}` reference in a glob or text. */
  parseReferences,
  /** Why a reference cannot be written, or `undefined` when it can. */
  referenceError,
  /** Step into a structured value along a dotted path. */
  resolvePath,
  /** Substitute every reference in a text against a variable store. */
  resolveText,
} from "../machine/variables.js";
export type { VariableReference, VariableStore, VariableEntry } from "../machine/variables.js";

// --- Tool names ---------------------------------------------------------------------

export {
  ARCHMAX_TOOL_PREFIX,
  ADVANCE_TOOL,
  RESET_TOOL,
  WAIT_TOOL,
  EVAL_TOOL,
  RUN_TOOL,
  GET_VARIABLES_TOOL,
  SET_VARIABLES_TOOL,
  /** The tool name a runtime note's call pair wears; registered nowhere. */
  NOTE_TOOL,
  WORKFLOW_TOOL_PREFIX,
  workflowToolName,
  workflowSlugFromToolName,
  isWorkflowToolName,
  /** Whether a name is one the runtime owns (`archmax_*`). */
  isReservedToolName,
  /** The control tools: advance, reset, wait, get/set variables. */
  HARNESS_CONTROL_TOOLS,
  /** Tools permitted in every state regardless of `allow`. */
  ALWAYS_ALLOWED_TOOLS,
  /** The always-on built-ins a state's own entry may narrow but `allow_always` cannot add to. */
  ESSENTIAL_TOOLS,
  /** Tools no list may grant (`task`). */
  UNGRANTABLE_TOOLS,
  ReservedToolNameError,
} from "../machine/tool-names.js";
export { DEFAULT_SUB_WORKFLOW_DEPTH, DEFAULT_SUB_WORKFLOW_CONCURRENCY } from "../machine/delegation.js";

// --- The root namespace ---------------------------------------------------------------

export {
  SESSION_INTERNAL_DIRS,
  SESSION_OFFLOAD_DIRS,
  SESSION_OPEN_DIR,
  SESSION_AGNOSTIC_PREFIX,
  SESSION_AGNOSTIC_PREFIXES,
  NO_MOUNTS,
  /** Every session-area name the runtime owns at the workspace root. */
  sessionAreaNames,
  classifyWorkspacePath,
  isReservedRootName,
  isSessionAgnosticPath,
  /** The prefixes the authoring backend serves (`workflows`), reserved at the root. */
  AUTHORING_PREFIXES,
  isAuthoringPrefix,
  /** The authoring prefix a canonical path addresses, or `null`. */
  authoringPlanePrefix,
  describeAuthoringPrefix,
} from "../core/zones.js";
export type { MountPrefixes, WorkspaceZone, AuthoringPrefix } from "../core/zones.js";

// --- Session ids -----------------------------------------------------------------------

export {
  /** Why a session id cannot own a session folder, or `null` when it can. */
  sessionIdRejection,
  SessionStoreIdError,
  /** Directory of the zero-config filesystem session store (`sessions`). */
  DEFAULT_SESSIONS_DIR,
} from "../core/session-id.js";
export {
  /** Whether one session was dispatched by another, at any depth. */
  isChildSessionOf,
  /** The session that dispatched this one, or `undefined` at the top level. */
  parentSessionIdOf,
  /** The id a child session gets: `<parent>~<identity>`. */
  childSessionId,
  /** A dispatch identity: `<state>:<workflow>:<ordinal>`. */
  subRunIdentity,
} from "../sessions/scope.js";

// --- Paths -------------------------------------------------------------------------------

export {
  DEFAULT_WORKFLOW,
  /** Where a hook script lives, relative to its workflow directory. */
  HOOKS_DIR,
  /** Where a workspace may override the bundled platform prompt (`.platform/system/GRAPH_STATE.md`). */
  PLATFORM_PROMPT_PATH,
  /** The authored paths of one workflow (`workflow.yaml`, `WORKFLOW.md`, `tests/`, `hooks/`). */
  workflowPaths,
  /** The runtime-internal layout of one session's folder. */
  sessionPaths,
  /** Resolve a hook's declared `script:` to an authoring-backend path, or refuse it with a reason. */
  resolveHookScript,
} from "../workflow/paths.js";

// --- Scripts -------------------------------------------------------------------------------

export { parseCodeDescription } from "../core/code-description.js";
export type { CodeDescription } from "../core/code-description.js";
