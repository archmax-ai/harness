## MODIFIED Requirements

### Requirement: Per-state tool disclosure

On every model call the runtime SHALL hand the model only the active state's disclosed tools: every
tool an effective entry names, plus `archmax_reset`, `archmax_wait`, `archmax_raise`,
`archmax_get_variables` and `archmax_set_variables` in every state, plus `archmax_advance` except in
a terminal state, minus the tools a `forbid_always` or `forbid` entry names by name. `task` SHALL NOT
be disclosed in any state of any assembly,
whether or not the framework registered it for the runtime's own rubric dispatch and whatever a grant
names. Deep Agents adds no prompt guidance for `task`, and the runtime SHALL hand the model the
composed static prompt unchanged: no section of it is removed, and no `warning` is raised about one.
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

#### Scenario: Nothing is pruned and nothing warned about

- **WHEN** a governed agent makes its first model call
- **THEN** no `warning` event concerns the withheld `task` tool or its guidance, the `prompt-shaping`
  event names `task` as withheld, and the static block is the composed prompt byte for byte

#### Scenario: Undisclosed call still governed

- **WHEN** the model calls a registered tool that was not disclosed and is not allowed in the state
- **THEN** the kernel blocks it with the standard not-allowed message
