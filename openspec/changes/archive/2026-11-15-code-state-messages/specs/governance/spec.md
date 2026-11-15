## MODIFIED Requirements

### Requirement: The tool surface is allow-only and closed by default

A state SHALL permit only: the workflow-wide grant, the state's own `tools.allow` entries, any name
the consumer passes as `essentialTools`, and the control tools of its type. The workflow-wide grant
SHALL be the workflow's `tools.allow_always` entries when the workflow declares that key, an empty
list included, and otherwise the **default tools**: the file tools (`ls`, `read_file`,
`write_file`, `edit_file`, `glob`, `grep`), the runtime's file operations (`copy_file`,
`move_file`, `remove_file`), `write_todos` and the sandbox tools (`archmax_eval`, `archmax_run`). A
declared `tools.allow_always` SHALL replace the default tools rather than add to them, so a default
tool is then permitted in a state only where `allow_always` or that state's `tools.allow` names it.
The host's `essentialTools` SHALL be permitted in every state whatever the workflow declares.

What each state type is offered beyond its grants, and what no grant gives it, SHALL come from one
table, `STATE_TYPE_TOOLS` (exported from `@archmax-ai/harness/spec`). Per type it holds the
type's `controls`, the control tools the type always has whatever its `tools` governance, and its
`withheld` tools, which no entry grants it. The machine's tool surface, the kernel's grant and
`validate` SHALL all read this table:

| State type    | `controls`                                                                                                 | `withheld`                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| agent, human  | `archmax_advance`, `archmax_reset`, `archmax_wait`, `archmax_raise`, `archmax_get_variables`, `archmax_set_variables` | none                                                                           |
| code          | `archmax_advance`, `archmax_raise`, `archmax_get_variables`, `archmax_set_variables`, `archmax_get_history`, `archmax_add_message` | `write_todos`, `archmax_eval`, `archmax_run`, `archmax_wait`, `archmax_reset` |
| grader        | `archmax_advance`, `archmax_raise`, `archmax_get_variables`, `archmax_set_variables`, `archmax_get_history` | `write_todos`, `archmax_eval`, `archmax_run`, `archmax_wait`, `archmax_reset`, `archmax_add_message` |

A state SHALL never be offered a tool its type withholds: not as a default tool, and not where the
workflow's `tools.allow_always` or the state's own `tools.allow` names one (see "Effective entries
and precedence"). The reserved control tools (`HARNESS_CONTROL_TOOLS`) SHALL be every type's
`controls` plus the two sandbox tools. `archmax_get_history` SHALL be a control tool like the
others: never part of an agent script's surface, and permitted only in a grader or a code state.
`archmax_add_message` SHALL be one too, permitted only in a code state.

Every other call SHALL be blocked with a reason naming the tool, the state and what the state
permits. A state with no `tools` block and one with an empty `allow` list SHALL behave identically,
and no syntax SHALL declare a fully open state. The control tools SHALL never need listing: a
transition target is checked against the state's `transitions` and a variable write against
whether the variable is locked. A `forbid_always` or `forbid` entry SHALL still block any of them,
and a tool named bare `eval` SHALL always be blocked with a message pointing at `archmax_eval`.

One derivation (`WorkflowMachine.disclosedTools(state)` and `checkAllowed`) SHALL answer what a
state permits, for every state type. The kernel, prompt disclosure, the agent scripts' listing and
the tool surface an automated state is offered SHALL all read it unchanged, so what a code state
may call cannot drift from what its script sees.

`task` (`TASK_TOOL`) SHALL be neither a default tool nor grantable. Deep Agents always registers
it for its general-purpose subagent. The runtime registers no subagent and dispatches nothing through it: a
grade is a grader state, and delegated work is a sub-workflow reached through a declared
`archmax_workflow_<slug>` tool. A `task` call SHALL be blocked in every state, whatever the state
or the workflow declares, with a refusal that points at grader states and the workflow's declared
`archmax_workflow_<slug>` tools.

#### Scenario: Undeclared tool blocked

- **WHEN** a state declares `tools.allow: [alpha]` and the model calls `beta`
- **THEN** the call is blocked with a reason matching `not allowed in state`, the tool result is an
  error marked `governance_blocked`, and no `tool-called` event is emitted for it

#### Scenario: Forbidden control tool

- **WHEN** `tools.forbid_always` lists `archmax_wait` and a state's `tools.allow` omits it
- **THEN** `archmax_wait` is blocked in every state, because the denial stages run ahead of the per-state defaults

#### Scenario: Raise is permitted without a grant and forbiddable per state

- **WHEN** a state with no `tools` block calls `archmax_raise`, and another state whose
  `tools.forbid` names `archmax_raise` calls it
- **THEN** the first call is permitted and the second is blocked

#### Scenario: The control set follows the type

- **WHEN** `decide` is asked about `archmax_get_history` in an agent state, and about
  `archmax_wait`, `archmax_reset` and `archmax_eval` in a code state and in a grader state, none of
  which a `tools` block names
- **THEN** each is blocked with `tool.not-allowed`, while `archmax_raise` is permitted in all three
  states and `archmax_get_history` in the code state and in the grader state

#### Scenario: The message control is a code state's alone

- **WHEN** `decide` is asked about `archmax_add_message` in an agent state, a grader state and a
  code state, none of which a `tools` block names
- **THEN** it is permitted in the code state and blocked with `tool.not-allowed` in the agent state
  and in the grader state

#### Scenario: task is blocked in every state

- **WHEN** the model calls `task` in a state with no `tools` block and in a state whose
  `tools.allow` names `task`
- **THEN** both calls are blocked, and the refusal points at grader states and the declared
  `archmax_workflow_<slug>` tools

#### Scenario: The file operations need no grant and close by name

- **WHEN** a workflow without `tools.allow_always` enters a state with no `tools` block, and another
  state's `tools.forbid` names `copy_file`
- **THEN** `copy_file`, `move_file` and `remove_file` are disclosed in the first, and in the second
  `copy_file` is neither disclosed nor callable (`tool.forbidden-here`) while the other two are

#### Scenario: A workflow without allow_always gets the default tools

- **WHEN** a workflow's root `tools` block omits `allow_always` (or the workflow has no root `tools`
  block) and the model calls `read_file`, `write_todos` and `archmax_eval` in a state with no `tools`
  block
- **THEN** every call is permitted and all three tools are disclosed

#### Scenario: A declared allow_always replaces the default tools

- **WHEN** a workflow declares `tools.allow_always: [read_file, ls]`, a state with no `tools` block
  calls `write_file`, and a state whose `tools.allow` names `write_file` calls it too
- **THEN** in the first state `write_file` is neither disclosed nor callable (`tool.not-allowed`) while
  `read_file` and `ls` are, and in the second state the call is permitted

#### Scenario: An empty allow_always leaves every tool state-specific

- **WHEN** a workflow declares `tools.allow_always: []` and a state with no `tools` block is entered
- **THEN** the state discloses only the control tools and the host's `essentialTools`, and a call to
  `read_file` is blocked with `tool.not-allowed`

#### Scenario: Host essentialTools survive a declared allow_always

- **WHEN** the host passes `essentialTools: ["get_markdown"]` and the workflow declares
  `tools.allow_always: [read_file]`
- **THEN** `get_markdown` is disclosed and permitted in every state

### Requirement: Per-state tool disclosure

On every model call the runtime SHALL hand the model only the active state's disclosed tools, and
an automated state SHALL be offered exactly its own state's disclosed tools: a grader as its tool
list, a code state's script as its `tools` (see the `automated-states` capability). A state's
disclosed tools SHALL be every tool an effective entry names, plus the control tools of its type
other than `archmax_advance`, plus `archmax_advance` except in a terminal state, minus the tools a
`forbid_always` or `forbid` entry names by name. A bare `*` entry SHALL withdraw every disclosed
tool except `archmax_advance`, so a non-terminal state is offered only that and a terminal state
nothing; a guarded `*` withdraws nothing, and the kernel refuses each call its guards match. The control tools other than `archmax_advance` are,
by type (`STATE_TYPE_TOOLS[type].controls`, see "The tool surface is allow-only and closed by
default"):

- in an agent or human state, `archmax_reset`, `archmax_wait`, `archmax_raise`,
  `archmax_get_variables` and `archmax_set_variables`;
- in a grader state, `archmax_raise`, `archmax_get_variables`, `archmax_set_variables` and
  `archmax_get_history`;
- in a code state, the grader state's and `archmax_add_message`.

`task` SHALL NOT be disclosed in any state of any assembly, though Deep Agents registers it in every
assembly for its general-purpose subagent, and whatever a grant names. Deep Agents adds no prompt
guidance for `task`, and the runtime SHALL hand the model the composed static prompt unchanged: no
section of it is removed, and no `warning` is raised about one. Disclosure SHALL be by name only:
an entry with argument constraints keeps its tool disclosed, and the binding constraints SHALL be
listed in the volatile "Current state" block with `${{…}}` references rendered resolved (or named
as unresolved), never in the cacheable prefix. Every call SHALL still be decided by the kernel
whether or not the tool was disclosed.

#### Scenario: Disclosure follows the state

- **WHEN** state `start` allows `alpha` and state `done` allows `beta`
- **THEN** the model call in `start` offers `alpha` and not `beta`, the call in `done` offers `beta`
  and not `alpha`, and both offer `read_file`, `write_file`, `ls` and `archmax_set_variables`

#### Scenario: Disclosure follows the type

- **WHEN** a session passes through a non-terminal code state and a grader state, neither of which
  declares a `tools` block
- **THEN** the code state's script and the grader are both offered the file tools, `archmax_advance`,
  `archmax_raise`, `archmax_get_variables`, `archmax_set_variables` and `archmax_get_history`, the
  code state's script also `archmax_add_message`, and neither is offered `write_todos`,
  `archmax_eval`, `archmax_run`, `archmax_wait` or `archmax_reset`. No model call of the session's
  agent offers `archmax_get_history` or `archmax_add_message`, and the grader is not offered
  `archmax_add_message`

#### Scenario: Advance hidden in a terminal state

- **WHEN** the active agent state declares no `transitions`
- **THEN** `archmax_advance` is not offered while `archmax_reset`, `archmax_wait` and `archmax_raise`
  still are

#### Scenario: A forbidden raise is not offered

- **WHEN** `tools.forbid_always` lists `archmax_raise`
- **THEN** no model call in any state offers `archmax_raise`, and no grader or code state's script
  is offered it

#### Scenario: A bare wildcard leaves only the advance offered

- **WHEN** agent state `work`, which has a transition, declares `tools: { forbid: ["*"] }`
- **THEN** the model call in `work` offers exactly `archmax_advance`, and in a terminal state with
  the same denial it offers no tool

#### Scenario: task is never offered

- **WHEN** any state of any assembly runs a model call, though Deep Agents registered `task` for
  its general-purpose subagent
- **THEN** no model call offers `task`, no grader or code state's script is offered it, and the
  static prompt carries no task-tool guidance

#### Scenario: Nothing is pruned and nothing warned about

- **WHEN** a governed agent makes its first model call
- **THEN** no `warning` event concerns the withheld `task` tool or its guidance, the `prompt-shaping`
  event names `task` as withheld, and the static block is the composed prompt byte for byte

#### Scenario: Undisclosed call still governed

- **WHEN** the model calls a registered tool that was not disclosed and is not allowed in the state
- **THEN** the kernel blocks it with the standard not-allowed message
