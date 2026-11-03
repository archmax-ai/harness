## MODIFIED Requirements

### Requirement: Workflow and state denials

A workflow SHALL declare denial in the same two positions it declares a grant:
`tools.forbid_always` at the root and `tools.forbid` on a state, taking the same entries as their
`allow` counterparts. There SHALL be no `policy` block: a root `policy:` key is an
unrecognized-key load error.

`tools.forbid_always` SHALL block each entry in every state — the always-on tools and every control
tool other than `archmax_advance` included — and a state's `tools.forbid` SHALL block each entry while that state is active,
subtracting from the workflow's `allow_always`, the state's own `allow` and the always-on surface
alike. Both SHALL bind every caller in the state they apply to: the session's agent, the agent's
scripts, and an automated state's grader or script, the automated state's control tools included.
A forbid entry MAY name the tool `*`, meaning every tool **except `archmax_advance`**, which is how
a path is denied across the board. No `*` entry SHALL block `archmax_advance`, bare or guarded,
in `forbid_always` or `forbid`, inherited or not. `archmax_advance` SHALL be denied only by an
entry that names it **and** guards its arguments, such as
`{ tool: archmax_advance, args: { to: [review] } }`, which blocks the advances it matches. A bare
entry naming it is a load error (see the `workflow-spec` capability, "Allow entries and the tools
blocks"): it could only strand the state, and a state with no transitions is already terminal.
An entry's argument guards narrow what it denies:
`{ tool: write_file, paths: [logs/**] }` denies that tool on those globs and nothing else.

A sub-workflow SHALL inherit every ancestor's workflow-wide denials — `tools.forbid_always` and
`skills.forbid_always`, the root's and each intermediate caller's, accumulated down the delegation
chain — ahead of its own rules, and a block produced by an inherited rule SHALL name the workflow
that declared it. Neither per-state `allow` nor per-state `forbid` SHALL be inherited in either
direction.

Every path glob the runtime matches — a forbid entry's and an `allow` entry's `paths`/`args` alike —
SHALL match dot-prefixed path segments: `secrets/**` SHALL cover `secrets/.env` and `**` SHALL cover
`.env`. A workspace path is not a shell word, so a wildcard that skipped dotfiles would make a
denial bypassable and an allowance incomplete.

#### Scenario: A forbidden dotfile

- **WHEN** the workflow declares `tools: { forbid_always: [{ tool: "*", paths: [secrets/**] }] }`
  and the model calls `write_file` on `secrets/.env`
- **THEN** the call is blocked with `tool.forbidden`

#### Scenario: A bare wildcard spares only the advance

- **WHEN** agent state `work` declares `tools: { forbid: ["*"] }` and has a transition to `done`
- **THEN** `archmax_advance({ to: done })` is accepted, while `read_file`, `archmax_eval`,
  `archmax_raise`, `archmax_reset`, `archmax_wait`, the variable tools and every host tool are
  blocked in `work` with `tool.forbidden-here`

#### Scenario: A workflow-wide wildcard spares the advance in every state type

- **WHEN** the root declares `tools: { forbid_always: ["*"] }`
- **THEN** in an agent state and in a code state alike `archmax_advance` passes the denial, and
  every other tool, `archmax_get_history` included, is blocked with `tool.forbidden`

#### Scenario: A guarded wildcard does not reach the advance

- **WHEN** a state declares `tools: { forbid: [{ tool: "*", args: { to: [review] } }] }` and the
  agent calls `archmax_advance({ to: review })` along an edge it has
- **THEN** the denial does not apply, and the advance is decided by the edge and `requires` alone

#### Scenario: An inherited wildcard spares the child's advance

- **WHEN** the root declares `tools: { forbid_always: ["*"] }` and delegates to a sub-workflow
- **THEN** the child's states can still call `archmax_advance`, and every other child call is
  blocked naming the root workflow

#### Scenario: A forbidden always-on tool

- **WHEN** the workflow declares `tools: { forbid_always: [archmax_eval] }` and the model calls
  `archmax_eval`
- **THEN** the call is blocked naming the workflow's denial, and the tool is not disclosed in any
  state

#### Scenario: A state's denial is scoped to that state

- **WHEN** state `route` declares `tools: { forbid: [write_file] }` while the root grants
  `write_file` in every state
- **THEN** the call is blocked in `route` with `tool.forbidden-here` and the tool is not disclosed
  there, while another state's call succeeds

#### Scenario: A guarded denial denies only what it names

- **WHEN** the root declares `tools: { forbid_always: [{ tool: write_file, paths: [logs/**] }] }`
- **THEN** a write under `logs/` is blocked in every state, a write elsewhere the state grants
  succeeds, and `write_file` stays disclosed because the denial is argument-scoped

#### Scenario: A state's denial binds an automated state's control

- **WHEN** code state `check-refund` declares
  `tools: { forbid: [{ tool: archmax_advance, args: { to: [refund-review] } }] }` and its script
  calls `tools.archmax_advance({ to: "refund-review", reason })`
- **THEN** the call is refused with `tool.forbidden-here` and no decision is recorded, while an
  advance to `refund-request` is accepted

#### Scenario: A workflow-wide denial withholds a control from automated states

- **WHEN** the root declares `tools: { forbid_always: [archmax_set_variables] }`
- **THEN** no grader is offered `archmax_set_variables`, `tools.archmax_set_variables` is
  `undefined` in every code state's script, and `decide` blocks the tool in every state with
  `tool.forbidden`

#### Scenario: Inherited denial

- **WHEN** the root workflow declares `tools: { forbid_always: [send_email] }` and a sub-workflow's
  state allows `send_email`
- **THEN** the child's call is blocked and the reason names the root workflow

#### Scenario: An intermediate caller's denial binds its grandchild

- **WHEN** root delegates to `mid`, `mid` declares `tools: { forbid_always: [write_file] }` and
  delegates to `leaf`, and `leaf` calls `write_file`
- **THEN** the call is blocked in `leaf` and the reason names `mid`

#### Scenario: A state denial is not inherited

- **WHEN** a caller's state declares `tools: { forbid: [send_email] }` and dispatches a sub-workflow
  whose own state grants `send_email`
- **THEN** the child's call succeeds: a state's denial governs that state's turns, not a child
  session

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
- in a code state and in a grader state alike, `archmax_raise`, `archmax_get_variables`,
  `archmax_set_variables` and `archmax_get_history`.

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
  `archmax_raise`, `archmax_get_variables`, `archmax_set_variables` and `archmax_get_history`, and
  neither is offered `write_todos`, `archmax_eval`, `archmax_run`, `archmax_wait` or
  `archmax_reset`. No model call of the session's agent offers `archmax_get_history`

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
