/**
 * The names of the agent-facing control tools the harness owns. Every one
 * carries the reserved `archmax_` prefix, so a host-bound or MCP tool can never
 * shadow (or be shadowed by) a runtime control, and a reader can tell the
 * runtime's controls from the workspace's integrations. Deep Agents' built-ins
 * (`read_file`, `task`, …) keep their names. Disclosure, the always-allowed set,
 * the PTC exclusion set and governance matching all derive from this one list.
 */

/** Reserved prefix for harness-owned agent tools. Host tools may not use it. */
export const ARCHMAX_TOOL_PREFIX = "archmax_";

/** Graph movement: request a transition declared by the current state. */
export const ADVANCE_TOOL = "archmax_advance";
/** Return the run to the entry state it began in. */
export const RESET_TOOL = "archmax_reset";
/** Park the run in the state the call is made in, awaiting an external event. */
export const WAIT_TOOL = "archmax_wait";
/** Evaluate inline JavaScript in the QuickJS sandbox (the model's code interpreter). */
export const EVAL_TOOL = "archmax_eval";
/** Execute a workspace script *file* in the QuickJS sandbox. */
export const RUN_TOOL = "archmax_run";
/** Read the run's variables. */
export const GET_VARIABLES_TOOL = "archmax_get_variables";
/** Create, update, and lock the run's variables. */
export const SET_VARIABLES_TOOL = "archmax_set_variables";

/**
 * Prefix of the tool that runs a sibling workflow as a sub-run:
 * `archmax_workflow_<slug>`, with the slug **verbatim** so the tool name, the
 * directory, the `tools.allow` entry, the mock key and the `ranWorkflow`
 * assertion are one greppable string. Lossless: a slug is kebab-case and never
 * contains `_`, so everything after the prefix is the slug. Reserved-prefixed,
 * but deliberately **not** in {@link HARNESS_CONTROL_TOOLS}: a control tool moves
 * the machine or rewrites variables (scripts may never call one); a delegation
 * tool does work and returns a value, which scripts may call.
 */
export const WORKFLOW_TOOL_PREFIX = "archmax_workflow_";

/** The tool name that runs `workflows/<slug>/` as a sub-run. */
export function workflowToolName(slug: string): string {
  return `${WORKFLOW_TOOL_PREFIX}${slug}`;
}

/**
 * The workflow slug a delegation tool name addresses, or `undefined` for a name
 * that is not one — the inverse of {@link workflowToolName}, shared by governance
 * matching, disclosure, the dispatcher, mocking and `validate`. Shape is *not*
 * checked: a non-slug remainder still resolves, so the caller can report it
 * against the declaration that named it.
 */
export function workflowSlugFromToolName(name: string): string | undefined {
  return name.startsWith(WORKFLOW_TOOL_PREFIX)
    ? name.slice(WORKFLOW_TOOL_PREFIX.length)
    : undefined;
}

/** Whether a name addresses a sibling workflow rather than an ordinary tool. */
export function isWorkflowToolName(name: string): boolean {
  return name.startsWith(WORKFLOW_TOOL_PREFIX);
}

/**
 * The name on the synthetic call a runtime note is shaped as. **Not a tool**:
 * nothing registers it, nothing may call it, and it is absent from
 * {@link HARNESS_CONTROL_TOOLS}. A note is machine output in a transcript, and a
 * tool result is the one portable shape that cannot be read as a person speaking.
 * Reserved-prefixed so no host tool can claim the name.
 */
export const NOTE_TOOL = "archmax_note";

/** Every harness-owned control tool, by canonical name. */
export const HARNESS_CONTROL_TOOLS: ReadonlySet<string> = new Set([
  ADVANCE_TOOL,
  RESET_TOOL,
  WAIT_TOOL,
  EVAL_TOOL,
  RUN_TOOL,
  GET_VARIABLES_TOOL,
  SET_VARIABLES_TOOL,
]);

/** Whether a name is reserved for harness-owned controls. */
export function isReservedToolName(name: string): boolean {
  return name.startsWith(ARCHMAX_TOOL_PREFIX);
}

/**
 * Tools permitted in every state regardless of its `tools` governance: the
 * runtime's own controls. `archmax_advance`'s target is still checked against the
 * state's `transitions`, and a variable write is decided by whether the target
 * is locked. `policy.forbid_tools` can still block any of them workflow-wide.
 */
export const ALWAYS_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  ADVANCE_TOOL,
  RESET_TOOL,
  WAIT_TOOL,
  GET_VARIABLES_TOOL,
  SET_VARIABLES_TOOL,
]);

/**
 * The built-in tools essential in every assembly — always disclosed, always
 * permitted, never declared: the file tools, `write_todos`, and the two sandbox
 * tools. A script's `tools.*` calls are governed against the active state like a
 * direct call. A state entry naming an essential tool *narrows* the grant
 * (`{ tool: archmax_run, paths: [...] }`); `policy.forbid_tools` closes one.
 */
export const ESSENTIAL_TOOLS: ReadonlySet<string> = new Set([
  "ls",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
  "write_todos",
  EVAL_TOOL,
  RUN_TOOL,
]);

/**
 * The framework's subagent-dispatch tool, which the runtime uses only to
 * dispatch its own grading rubrics.
 *
 * It is never disclosed and never grantable. A rubric grades the agent rather
 * than serving it, so the agent has no use for the tool: naming it in a
 * `tools.allow` or `tools.allow_always` entry is a `validate` error, and the
 * kernel refuses an agent-initiated call in every state. Registered rubrics make
 * the tool *exist* in the assembled tool list — the runtime needs a runnable —
 * so withholding it is enforced rather than incidental.
 */
export const UNGRANTABLE_TOOLS: ReadonlySet<string> = new Set(["task"]);

/**
 * Thrown when a host-bound tool claims the reserved `archmax_` prefix; refused at
 * assembly rather than shadowed.
 */
export class ReservedToolNameError extends Error {
  constructor(readonly names: string[]) {
    const one = names.length === 1;
    super(
      `Host tool${one ? "" : "s"} ${names.map((n) => `'${n}'`).join(", ")} use${one ? "s" : ""} ` +
        `the reserved '${ARCHMAX_TOOL_PREFIX}' prefix, which names the runtime's own control ` +
        `tools. Rename ${one ? "it" : "them"}.`,
    );
    this.name = "ReservedToolNameError";
  }
}

/** Refuse host tools that claim the `archmax_` namespace. */
export function assertNoReservedToolNames(tools: readonly { name?: unknown }[] | undefined): void {
  const claimed = (tools ?? [])
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === "string" && isReservedToolName(name));
  if (claimed.length > 0) throw new ReservedToolNameError(claimed);
}
