## MODIFIED Requirements

### Requirement: The tool surface is allow-only and closed by default

A state SHALL permit only: the workflow-wide grant, the state's own `tools.allow` entries, any name
the consumer passes as `essentialTools`, and the control tools. The workflow-wide grant SHALL be the
workflow's `tools.allow_always` entries when the workflow declares that key, an empty list included,
and otherwise the **default tools**: the file tools (`ls`, `read_file`, `write_file`, `edit_file`,
`glob`, `grep`), the runtime's file operations (`copy_file`, `move_file`, `remove_file`),
`write_todos` and the sandbox tools (`archmax_eval`, `archmax_run`). A declared `tools.allow_always`
SHALL replace the default tools rather than add to them, so a default tool is then permitted in a
state only where `allow_always` or that state's `tools.allow` names it. The host's `essentialTools`
SHALL be permitted in every state whatever the workflow declares. Every other call SHALL be blocked
with a reason naming the tool, the state and what the state permits. A state with no `tools` block
and one with an empty `allow` list SHALL behave identically, and no syntax SHALL declare a fully open
state. The control tools (`archmax_advance`, `archmax_reset`, `archmax_wait`, `archmax_raise`,
`archmax_get_variables`, `archmax_set_variables`) SHALL never need listing: a transition target is
checked against the state's `transitions` and a variable write against whether the variable is
locked. A `forbid_always` or `forbid` entry SHALL still block any of them, and a tool named bare
`eval` SHALL always be blocked with a message pointing at `archmax_eval`.

`task` SHALL be neither a default tool nor grantable. It is the framework's subagent-dispatch tool,
which the runtime uses only to dispatch its own grading rubrics; the agent has no use for it, because
a rubric grades the agent rather than serving it. An agent-initiated `task` call SHALL be blocked in
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

### Requirement: Effective entries and precedence

The entries that govern a state SHALL be derived once, in precedence order, and read by both
enforcement and disclosure: the state's own `tools.allow` entries; then the workflow-wide grant's
entries for tools the state does not mention and that are not host `essentialTools`; then the host's
`essentialTools` the state does not mention, unconstrained. The workflow-wide grant SHALL be the declared
`tools.allow_always` entries, constraints included, or, when the key is absent, the default tools,
unconstrained. A tool SHALL be decided by exactly one tier, so a state entry naming a granted tool
narrows it, and a workflow-wide entry for a tool the state mentions SHALL be inert in that state.

#### Scenario: State entry narrows an always-on tool

- **WHEN** a workflow without `tools.allow_always` has a state declaring
  `{ tool: write_file, paths: ["output/**"] }` and the model writes `notes/private.md`
- **THEN** the call is blocked, while a write to `output/report.md` is permitted

#### Scenario: State constraint beats allow_always

- **WHEN** `tools.allow_always` lists `read_file` and the state declares
  `{ tool: read_file, args: { file_path: ["skills/**"] } }`
- **THEN** a read outside `skills/` is blocked despite the `allow_always` grant

#### Scenario: An allow_always constraint on a default tool is enforced

- **WHEN** a workflow declares `tools.allow_always: [{ tool: write_file, paths: ["reports/**"] }]`
  and, in a state that does not name `write_file`, the model writes `notes/x.md` and then
  `reports/x.md`
- **THEN** the first write is blocked with `tool.not-allowed` and the second is permitted

### Requirement: Session areas

The runtime-internal areas SHALL admit no path of any access (`zone.runtime-internal`). The offload
areas SHALL admit an open-area tool's `read` or `list` path without an `allow` entry
(`tool.offload-read`) and never a `write` or `remove` path (`zone.runtime-managed`). `scratchpad/`
SHALL admit a `read`, `list`, `write` or `remove` path without an `allow` entry (`tool.scratchpad`),
evaluated ahead of the per-state default, when every path the call names is so admitted and the tool
is an open-area tool in the active state. An open-area tool SHALL be a default tool that the active
state is granted by any tier, whatever the granting entry constrains, or one of the host's
`essentialTools`. The open areas SHALL NOT admit a call to any other tool, which the state's grant
decides as anywhere, so declaring a host tool's path arguments only ever narrows what it may do, and
a default tool the state is not granted stays uncallable there. So an `allow` entry naming a path
inside `scratchpad/` SHALL NOT narrow where inside it a write lands, and a call naming a path outside
the open areas SHALL be decided by the state's entries. Any other session-root path SHALL be matched
against the state's entries unchanged. Every block message SHALL point at `scratchpad/` and name no
second working area.

#### Scenario: Scratchpad open under a narrowing entry

- **WHEN** a state declares `{ tool: write_file, paths: ["output/**"] }` and the model writes `scratchpad/work.md`
- **THEN** the write is permitted with `tool.scratchpad`

#### Scenario: File operations inside the scratchpad need no grant

- **WHEN** a workflow without `tools.allow_always` copies, moves and removes files inside
  `scratchpad/` in any state
- **THEN** each call is permitted with `tool.scratchpad`

#### Scenario: The scratchpad does not open a tool the state does not grant

- **WHEN** a host tool declaring `{ attachment: "read" }` is granted only in `intake`, and in `reply`
  the model calls it with `attachment: "scratchpad/x.pdf"`
- **THEN** the call is blocked with `tool.not-allowed`, and in `intake` it is allowed

#### Scenario: The scratchpad does not open an ungranted default tool

- **WHEN** a workflow declares `tools.allow_always: [read_file]`, the state `draft` declares
  `{ tool: write_file, paths: ["reports/**"] }`, and the model writes `scratchpad/a.md` in `draft`
  and in a state with no `tools` block
- **THEN** the write in `draft` is permitted with `tool.scratchpad`, and the other is blocked with
  `tool.not-allowed`

#### Scenario: The scratchpad stays open to an essential host tool

- **WHEN** a host tool named in `essentialTools` and declaring `{ path: "read" }` reads `scratchpad/x.md` in any state
- **THEN** the call is permitted with `tool.scratchpad`
