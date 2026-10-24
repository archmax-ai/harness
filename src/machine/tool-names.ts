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
/** End the session as a failure, with a code and a reason the host reads. */
export const RAISE_TOOL = "archmax_raise";
/** Evaluate inline JavaScript in the QuickJS sandbox (the model's code interpreter). */
export const EVAL_TOOL = "archmax_eval";
/** Execute a workspace script *file* in the QuickJS sandbox. */
export const RUN_TOOL = "archmax_run";
/** Read the run's variables. */
export const GET_VARIABLES_TOOL = "archmax_get_variables";
/** Create, update, and lock the run's variables. */
export const SET_VARIABLES_TOOL = "archmax_set_variables";
/** Read the session's history: its whole transcript and its trail. A grader state's tool. */
export const GET_HISTORY_TOOL = "archmax_get_history";

/**
 * The runtime's own file operations, beside Deep Agents' built-ins and named
 * like them (they act on the workspace, not on the run). Each works on one file
 * and never reads it into the conversation; their path arguments are declared in
 * `tool-paths.ts` and governed like every other tool's.
 */
export const COPY_FILE_TOOL = "copy_file";
export const MOVE_FILE_TOOL = "move_file";
export const REMOVE_FILE_TOOL = "remove_file";

/** The planning scratchpad, a default tool whose prompt guidance follows its grant. */
export const TODO_TOOL = "write_todos";

/** The runtime's file operations, which no host tool may share a name with. */
export const RUNTIME_FILE_TOOLS: ReadonlySet<string> = new Set([COPY_FILE_TOOL, MOVE_FILE_TOOL, REMOVE_FILE_TOOL]);

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

/**
 * The host function behind a code state's `toolCalls`, handed to its sandbox
 * only and hidden from its `tools`. **Not a tool** the agent can see or call;
 * reserved-prefixed so no host tool can claim the name.
 */
export const TOOL_CALLS_QUERY = "archmax_tool_calls";

/** Every harness-owned control tool, by canonical name. */
export const HARNESS_CONTROL_TOOLS: ReadonlySet<string> = new Set([
  ADVANCE_TOOL,
  RESET_TOOL,
  WAIT_TOOL,
  RAISE_TOOL,
  EVAL_TOOL,
  RUN_TOOL,
  GET_VARIABLES_TOOL,
  SET_VARIABLES_TOOL,
  GET_HISTORY_TOOL,
]);

/** Whether a name is reserved for harness-owned controls. */
export function isReservedToolName(name: string): boolean {
  return name.startsWith(ARCHMAX_TOOL_PREFIX);
}

/**
 * The controls an **agent** or **human** state is offered regardless of its
 * `tools` governance. `archmax_advance`'s target is still checked against the
 * state's `transitions`, and a variable write is decided by whether the target
 * is locked. `tools.forbid_always` (or a state's `tools.forbid`) can still block
 * any of them.
 */
export const ALWAYS_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  ADVANCE_TOOL,
  RESET_TOOL,
  WAIT_TOOL,
  RAISE_TOOL,
  GET_VARIABLES_TOOL,
  SET_VARIABLES_TOOL,
]);

/**
 * The controls a **code** state is offered: it moves (`archmax_advance`), fails
 * (`archmax_raise`) and keeps the session's variables. It never parks — a script
 * frame is not durable — and never resets, so `archmax_wait` and
 * `archmax_reset` are not among them.
 */
export const CODE_STATE_CONTROL_TOOLS: ReadonlySet<string> = new Set([
  ADVANCE_TOOL,
  RAISE_TOOL,
  GET_VARIABLES_TOOL,
  SET_VARIABLES_TOOL,
]);

/** The controls a **grader** state is offered: a code state's, plus the history it judges. */
export const GRADER_STATE_CONTROL_TOOLS: ReadonlySet<string> = new Set([
  ...CODE_STATE_CONTROL_TOOLS,
  GET_HISTORY_TOOL,
]);

/**
 * The default tools: the workflow-wide grant of a workflow that does not declare
 * `tools.allow_always` — the file tools (the runtime's file operations among
 * them), `write_todos`, and the two sandbox tools, unconstrained in every state.
 * A declared `allow_always` (an empty list included) *replaces* them: a default
 * tool is then granted only where `allow_always` or a state's `tools.allow`
 * names it. A state entry naming a granted tool narrows it there
 * (`{ tool: archmax_run, paths: [...] }`); a `forbid` closes one.
 */
export const DEFAULT_TOOLS: ReadonlySet<string> = new Set([
  "ls",
  "read_file",
  "write_file",
  "edit_file",
  COPY_FILE_TOOL,
  MOVE_FILE_TOOL,
  REMOVE_FILE_TOOL,
  "glob",
  "grep",
  TODO_TOOL,
  EVAL_TOOL,
  RUN_TOOL,
]);

/**
 * The always-on tools an **automated** state (a grader or a code state) is never
 * offered, whatever its grants: the planning scratchpad, which only a model's
 * own loop reads back, and the two sandbox entry points — a code state *is* a
 * script, and a grader judges rather than computes. A `tools.allow` entry naming
 * one in such a state is a `validate` error.
 */
export const AGENT_ONLY_TOOLS: ReadonlySet<string> = new Set([TODO_TOOL, EVAL_TOOL, RUN_TOOL]);

/**
 * Every tool an automated state is never offered, whatever its own or the
 * workflow-wide grant names: the agent-only tools, and parking and resetting —
 * an automated state cannot park, and a reset is the agent's way back. The one
 * set the machine filters a grant by and `validate` reports a grant against.
 */
export const NOT_OFFERED_TO_AUTOMATED: ReadonlySet<string> = new Set([...AGENT_ONLY_TOOLS, WAIT_TOOL, RESET_TOOL]);

/**
 * Deep Agents' subagent-dispatch tool, which Deep Agents registers whatever the
 * assembly passes (it always builds its general-purpose subagent).
 *
 * It is never grantable: grading is a grader state and delegating work is a
 * sub-workflow, so no state has a use for it. Naming it in a `tools.allow` or
 * `tools.allow_always` entry is a `validate` error, and the kernel refuses a
 * call to it in every state, whatever an entry discloses — withholding it is
 * enforced rather than incidental.
 */
export const UNGRANTABLE_TOOLS: ReadonlySet<string> = new Set(["task"]);

/**
 * Thrown when a host-bound tool claims the reserved `archmax_` prefix or a
 * runtime file operation's name; refused at assembly rather than shadowed.
 */
export class ReservedToolNameError extends Error {
  constructor(
    readonly names: string[],
    /** Which reservation was claimed: the control-tool prefix, or a runtime file operation's name. */
    readonly reservation: "prefix" | "file-operation" = "prefix",
  ) {
    const one = names.length === 1;
    const listed = names.map((n) => `'${n}'`).join(", ");
    super(
      reservation === "prefix"
        ? `Host tool${one ? "" : "s"} ${listed} use${one ? "s" : ""} the reserved ` +
            `'${ARCHMAX_TOOL_PREFIX}' prefix, which names the runtime's own control tools. ` +
            `Rename ${one ? "it" : "them"}.`
        : `Host tool${one ? "" : "s"} ${listed} take${one ? "s" : ""} the name of the runtime's own ` +
            `file operation${one ? "" : "s"} (${[...RUNTIME_FILE_TOOLS].join(", ")}), which every ` +
            `agent already has. Drop ${one ? "it" : "them"}, or rename ${one ? "it" : "them"}.`,
    );
    this.name = "ReservedToolNameError";
  }
}

/**
 * Refuse host tools that claim the `archmax_` namespace or the name of one of the
 * runtime's file operations — two tools sharing a name would leave the model
 * calling whichever the framework happened to keep.
 */
export function assertNoReservedToolNames(tools: readonly { name?: unknown }[] | undefined): void {
  const names = (tools ?? []).map((tool) => tool.name).filter((name): name is string => typeof name === "string");
  const claimed = names.filter(isReservedToolName);
  if (claimed.length > 0) throw new ReservedToolNameError(claimed);
  const shadowing = names.filter((name) => RUNTIME_FILE_TOOLS.has(name));
  if (shadowing.length > 0) throw new ReservedToolNameError(shadowing, "file-operation");
}
