## MODIFIED Requirements

### Requirement: The tool surface is allow-only and closed by default

A state SHALL permit only: the always-on tools — the file tools (`ls`, `read_file`, `write_file`,
`edit_file`, `glob`, `grep`), `write_todos`, the sandbox tools (`archmax_eval`, `archmax_run`), and any
name the consumer passes as `essentialTools` —
the workflow's `tools.allow_always` entries, the state's own `tools.allow` entries, and the control
tools. Every other call SHALL be blocked with a reason naming the tool, the state and what the state
permits. A state with no `tools` block and one with an empty `allow` list SHALL behave identically,
and no syntax SHALL declare a fully open state. The control tools (`archmax_advance`, `archmax_reset`,
`archmax_wait`, `archmax_raise`, `archmax_get_variables`, `archmax_set_variables`) SHALL never need
listing: a transition target is checked against the state's `transitions` and a variable write
against whether the variable is locked. A `forbid_always` or `forbid` entry SHALL still block any of
them, and a tool named bare `eval` SHALL always be blocked with a message pointing at `archmax_eval`.

`task` SHALL be neither always-on nor grantable. It is the framework's subagent-dispatch tool, which
the runtime uses only to dispatch its own grading rubrics; the agent has no use for it, because a
rubric grades the agent rather than serving it. An agent-initiated `task` call SHALL be blocked in
every state, whatever the state or the workflow declares.

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

#### Scenario: task is blocked in every state

- **WHEN** the model calls `task` in a workflow that declares rubrics, in a state with no `tools` block
  and in a state whose `tools.allow` names `task`
- **THEN** both calls are blocked

### Requirement: Per-state tool disclosure

On every model call the runtime SHALL hand the model only the active state's disclosed tools: every
tool an effective entry names, plus `archmax_reset`, `archmax_wait`, `archmax_raise`,
`archmax_get_variables` and `archmax_set_variables` in every state, plus `archmax_advance` except in
a terminal state, minus the tools a `forbid_always` or `forbid` entry names by name. `task` SHALL NOT
be disclosed in any state of any assembly,
whether or not the framework registered it for the runtime's own rubric dispatch and whatever a grant
names, and its upstream prompt guidance SHALL be pruned unconditionally. Guidance for a withheld
built-in SHALL be pruned by
exact heading, with one `warning` event and the text left unchanged when the heading is not found.
Disclosure SHALL be by name only: an entry with argument constraints keeps its tool disclosed, and the
binding constraints SHALL be listed in the volatile "Current state" block with `${{…}}` references
rendered resolved (or named as unresolved), never in the cacheable prefix. Every call SHALL still be
decided by the kernel whether or not the tool was disclosed.

#### Scenario: Disclosure follows the state

- **WHEN** state `start` allows `alpha` and state `done` allows `beta`
- **THEN** the model call in `start` offers `alpha` and not `beta`, the call in `done` offers `beta`
  and not `alpha`, and both offer `read_file`, `write_file`, `ls` and `archmax_set_variables`

#### Scenario: Advance hidden in a terminal state

- **WHEN** the active state declares no `transitions`
- **THEN** `archmax_advance` is not offered while `archmax_reset`, `archmax_wait` and `archmax_raise`
  still are

#### Scenario: A forbidden raise is not offered

- **WHEN** `tools.forbid_always` lists `archmax_raise`
- **THEN** no model call in any state offers `archmax_raise`

#### Scenario: task is never offered

- **WHEN** any state of any assembly runs a model call, including a workflow whose rubrics the
  framework registered `task` for
- **THEN** no model call offers `task`, and the static prompt carries no task-tool guidance

#### Scenario: Undisclosed call still governed

- **WHEN** the model calls a registered tool that was not disclosed and is not allowed in the state
- **THEN** the kernel blocks it with the standard not-allowed message
