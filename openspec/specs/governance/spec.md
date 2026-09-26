# governance Specification

## Purpose

Define how the archmax harness decides what a session may do: the pure decision kernel (`src/kernel/kernel.ts`)
that turns a proposed tool call, transition or hook outcome into a verdict; the allow-only,
per-state tool surface and its precedence; argument guards; tool and skill disclosure, which show
the model only what the kernel would permit; path zones over the session areas and the read-only
mounts; skill governance by slug; the isolation of the authoring backend; and where authored
JavaScript may run from. Runtime enforcement and `archmax validate` share every rule.

## Requirements

### Requirement: One pure decision function

The kernel SHALL expose a single pure, synchronous function, `decide(machine, action, policyRules,
mountPrefixes, variables, skills)`, that returns a typed verdict for a proposed action: a tool call
(`{ state, tool, args, origin?, replyOnly? }`), a transition (`{ from, to, reason?, hookFacts }`), or a
state entry (`{ state, hookFacts }`). A verdict SHALL carry `decision` (`allow` or `block`), a stable
`ruleId`, and on a block a `reason`; it MAY mark the block `terminal` (retrying cannot recover it) or
`warn` (it surfaces as a warn-level event). The kernel SHALL hold no list of authored directory names
and SHALL discover no skills: the resolved mount prefixes and skill table are inputs supplied by the
caller, so the runtime and `archmax validate` reach identical verdicts from identical inputs.

#### Scenario: Purity

- **WHEN** `decide` is called twice with the same machine, action, rules, mount prefixes, variables and skills
- **THEN** it returns the same verdict with the same `ruleId` and has no side effects

### Requirement: Tool-call verdicts come from an ordered rule pipeline

The kernel SHALL decide a tool call by folding an ordered pipeline of pure rules, each returning a
verdict or abstaining; the first verdict wins and every rule abstaining means allow. The order SHALL
be: the non-overridable safety rules — the authoring-backend refusal for script and hook calls
(`zone.governance-plane`), the skill-bundle confinement of `archmax_run` (`script.skill-only`), the
reply-only refusal (`tool.reply-only`), the bare-`eval` block (`tool.eval`), the read-only mount write
block (`zone.read-only`), the runtime-internal area block (`zone.runtime-internal`), the offload-area
write block (`zone.runtime-managed`), and the disabled-skill block (`skill.not-allowed`,
`skill.forbidden`) — then the workflow-wide denials (`tool.forbidden`), then the active state's
denials (`tool.forbidden-here`), then the consumer's
`policyRules`, then the always-open session access rules (`tool.scratchpad`, `tool.offload-read`), and
last the per-state allow default (`tool.allowed`, `tool.not-allowed`, `tool.unresolved-variable`).

Every declared denial therefore precedes every grant and every consumer rule: **deny beats allow, and
no narrower level widens a denial.**

#### Scenario: Safety rules cannot be loosened

- **WHEN** a call matches a safety rule and also a permitting rule — a consumer rule, the scratchpad
  rule, an `allow_always` entry or a state `tools.allow` entry
- **THEN** the safety rule's block wins, because it is evaluated first

#### Scenario: A declared denial cannot be loosened either

- **WHEN** a call matches `tools.forbid_always` or the active state's `tools.forbid` and also a
  permitting rule — a consumer rule, the scratchpad rule, an `allow_always` entry or the state's own
  `tools.allow`
- **THEN** the denial wins, because both denial stages are evaluated ahead of every grant

### Requirement: Consumer governance rules

`createAgent` SHALL accept `policyRules`: pure functions over the proposed action and a read-only
`RuleApi` (`machine`, `variables`, `mountPrefixes`, `skills`), inserted after the safety rules and
the workflow's and state's declared denials, and before the always-open access and per-state
defaults. A consumer rule MAY block a call a state would permit and SHALL NOT loosen a safety rule
or a declared denial. The same rules SHALL govern calls made
through the sandbox bridge, and every rule SHALL see the call's `origin` (`agent` when absent,
`script`, or `lifecycle`).

#### Scenario: Custom rule blocks in every state

- **WHEN** a consumer rule blocks `web_fetch` for a non-allowlisted URL and the model calls it in a
  state whose `tools.allow` names `web_fetch`
- **THEN** the call is blocked with the rule's reason

### Requirement: Workflow and state denials

A workflow SHALL declare denial in the same two positions it declares a grant:
`tools.forbid_always` at the root and `tools.forbid` on a state, taking the same entries as their
`allow` counterparts. There SHALL be no `policy` block: a root `policy:` key is an
unrecognized-key load error.

`tools.forbid_always` SHALL block each entry in every state — the always-on tools and the control
tools included — and a state's `tools.forbid` SHALL block each entry while that state is active,
subtracting from the workflow's `allow_always`, the state's own `allow` and the always-on surface
alike. A forbid entry MAY name the tool `*`, meaning every tool, which is how a path is denied
across the board. An entry's argument guards narrow what it denies: `{ tool: write_file, paths:
[logs/**] }` denies that tool on those globs and nothing else.

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

### Requirement: Hook outcomes reduce to verdicts in the kernel

Hooks SHALL execute outside the kernel and their outcomes SHALL reach it as hook facts that the kernel
reduces. A fact carrying an execution error SHALL reduce to a block (`hook.error`, fail-closed). For a
transition the kernel SHALL first block on an unset `requires` variable (`transition.requires`,
recoverable, naming the variables, before any `after` hook is reduced), then on an undeclared edge
(`transition.no-edge`, listing the valid targets), and only then reduce the leaving state's `after`
facts, where `veto` blocks and `correct` blocks while consuming one iteration of the hook's
`max_iterations`. For a state entry a `before` fact's `correct` SHALL reduce to a veto.

The reduction SHALL be identical for every hook kind: a rubric's verdict and a script's verdict take
the same path, with no rubric-specific branch.

#### Scenario: Requires before hooks

- **WHEN** the model calls `archmax_advance` out of a state whose `requires` names an unset variable
- **THEN** the verdict is a recoverable block naming that variable, and the state's `after` hooks do not run

#### Scenario: Undeclared edge

- **WHEN** `archmax_advance` names a `to` that is not one of the current state's `transitions`
- **THEN** the transition is blocked with `transition.no-edge`, whatever the state's `tools.allow` says

#### Scenario: A rubric verdict reduces like a script's

- **WHEN** an `after` rubric returns `veto` and an `after` script returns `veto` in another state
- **THEN** both reduce through the same rule to a block carrying the hook's reason

### Requirement: The tool surface is allow-only and closed by default

A state SHALL permit only: the always-on tools — the file tools (`ls`, `read_file`, `write_file`,
`edit_file`, `glob`, `grep`), `write_todos`, the sandbox tools (`archmax_eval`, `archmax_run`), and any
name the consumer passes as `essentialTools` —
the workflow's `tools.allow_always` entries, the state's own `tools.allow` entries, and the control
tools. Every other call SHALL be blocked with a reason naming the tool, the state and what the state
permits. A state with no `tools` block and one with an empty `allow` list SHALL behave identically,
and no syntax SHALL declare a fully open state. The control tools (`archmax_advance`, `archmax_reset`,
`archmax_wait`, `archmax_get_variables`, `archmax_set_variables`) SHALL never need listing: a transition
target is checked against the state's `transitions` and a variable write against whether the variable
is locked. A `forbid_always` or `forbid` entry SHALL still block any of them, and a tool named bare `eval` SHALL
always be blocked with a message pointing at `archmax_eval`.

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

#### Scenario: task is blocked in every state

- **WHEN** the model calls `task` in a workflow that declares rubrics, in a state with no `tools` block
  and in a state whose `tools.allow` names `task`
- **THEN** both calls are blocked

### Requirement: Effective entries and precedence

The entries that govern a state SHALL be derived once, in precedence order, and read by both
enforcement and disclosure: the state's own `tools.allow` entries; then the always-on tools the state
does not mention, unconstrained; then `tools.allow_always` entries for tools the state does not mention
and that are not always-on. A tool SHALL be decided by exactly one tier, so a state entry naming an
always-on tool narrows it, and an `allow_always` entry for a tool the state mentions or that is
always-on SHALL be inert.

#### Scenario: State entry narrows an always-on tool

- **WHEN** a state declares `{ tool: write_file, paths: ["output/**"] }` and the model writes `notes/private.md`
- **THEN** the call is blocked, while a write to `output/report.md` is permitted

#### Scenario: State constraint beats allow_always

- **WHEN** `tools.allow_always` lists `read_file` and the state declares
  `{ tool: read_file, args: { file_path: ["skills/**"] } }`
- **THEN** a read outside `skills/` is blocked despite the `allow_always` grant

### Requirement: Allow entry shapes and argument guards

An entry in `tools.allow` or `tools.allow_always` SHALL be a bare tool name (any arguments),
`{ tool, args: { <param>: [globs] } }` matching each named parameter (dotted keys read nested
arguments), or `{ tool, paths: [...] }` as shorthand for `args: { file_path: [...] }`. An entry
without `args`/`paths` SHALL match any arguments. An argument value SHALL be canonicalized (leading
slashes stripped, `.` and empty segments dropped, `..` applied) before it is matched, so a `./` or
`..` spelling cannot dodge a guard.

#### Scenario: Argument glob

- **WHEN** a state allows `{ tool: alpha, args: { q: ["ok-*"] } }`
- **THEN** `alpha({ q: "ok-1" })` is permitted and `alpha({ q: "bad" })` is blocked

### Requirement: Variable references in guards

The kernel SHALL resolve `${{name}}` and `${{name.dotted.path}}` references in a guard glob against
the session's variables at every call, never once per entry, so a value set earlier in the same turn
binds the next call. Only the reference span SHALL be replaced and the substituted value SHALL be
glob-escaped, so a value such as `*`, `**` or `{a,b}` matches only itself. A reference that cannot be
resolved — unset variable, missing path, non-own property, index out of range, or a non-scalar value —
SHALL make the entry match nothing, and the verdict SHALL be a terminal block
(`tool.unresolved-variable`): the turn ends rejected, routed through the state's `on_error` when one is
declared, and the model is not invited to retry. A call decided without a variables snapshot SHALL fail
the same way.

#### Scenario: Guard follows a mid-turn write

- **WHEN** `folder_id` is set to `F-123` and the model then calls a tool guarded by `["${{folder_id}}"]`
- **THEN** `F-123` is permitted and `F-999` is blocked

#### Scenario: Unresolvable reference is terminal

- **WHEN** a guard references `${{case_id}}`, nothing has set it, and the model calls the guarded tool
- **THEN** the verdict is a terminal block naming `case_id`, and the session is marked rejected and
  routes through `on_error` when declared

### Requirement: Agent argument substitution precedes governance

On an agent-originated call the runtime SHALL resolve `${{…}}` references in the arguments as the
first stage of `wrapToolCall` — before canonicalization, guard matching and every rule — so governance
and the tool see the same resolved arguments. The value SHALL be substituted verbatim and matched as
data, never as pattern syntax. An unresolvable reference SHALL refuse the call before any rule runs,
with a correctable message naming the reference and the `$${{…}}` escape. Delegation tools
(`archmax_workflow_<slug>`) SHALL be exempt, their parameters being resolved by the dispatcher, and
script arguments passed through the sandbox bridge SHALL NOT be substituted — a script passes
computed values and reads the variables as `args.variables`, so `${{…}}` text in its arguments is
data. A script's call SHALL nonetheless be guarded against the variables in force at the turn's
model call (the PTC gateway is refreshed with them), so a `${{name}}` guard admits from a script
exactly what it admits from the model.

#### Scenario: Both sides resolve

- **WHEN** a guard is `["${{from_email}}"]`, `from_email` holds `a@b.c`, and the model calls with `"${{from_email}}"`
- **THEN** the call is permitted and the tool receives `a@b.c`

#### Scenario: A script's call under a variable guard

- **WHEN** a state allows `read_file` only with `file_path: ["${{report_path}}"]`, `report_path` is set, and code run via `archmax_eval` calls `tools.readFile` with that path
- **THEN** the call is permitted, exactly as the model's own would be, and a different path from the script is blocked

### Requirement: Path zones and read-only mounts

Every path decision SHALL classify the canonical `file_path` (or `path`) argument through one zone
table: `authored` for a path under a read-only directory mount or an exact read-only file mount of the
workspace's resolved table; `run-internal` for `checkpoints/`, `artifacts/`, `_specs/`; `run-offload`
for `large_tool_results/`, `conversation_history/`; `run-open` for `scratchpad/`; `run` for anything
else at the session root; `escapes` for a path climbing above the root. The table SHALL be the resolved
keys the composite routes on, supplied to the kernel and to `validate`. A directory mount name of
several segments (`catalogs/eu`) SHALL match a path by **longest prefix**, so a nested key classifies
exactly as a single-segment key does and a sibling under the same first segment (`catalogs/uk`) does
not. A writable mount SHALL NOT
classify as authored, and with no table nothing SHALL. `write_file` and `edit_file` on an `authored`
path SHALL be blocked with `zone.read-only` in every state, with a message naming the mount and
directing the model to `scratchpad/`; mounts SHALL also refuse writes themselves, so the kernel rule is
the diagnostic layer rather than the only enforcement.

#### Scenario: Skill file cannot be tampered with

- **WHEN** the model calls `write_file` or `edit_file` on `skills/data/SKILL.md`
- **THEN** both calls are blocked with a reason matching `read-only`, and the file on disk is unchanged

#### Scenario: Traversal out of the scratchpad

- **WHEN** the model writes `scratchpad/../checkpoints/cp-1.json`
- **THEN** the path canonicalizes to `checkpoints/cp-1.json` and is blocked as runtime-internal, not permitted as scratchpad

#### Scenario: A nested mount name is a read-only zone

- **WHEN** the table mounts `/catalogs/eu/` read-only and nothing at `/catalogs/`, and the model
  writes `catalogs/eu/skus.csv`
- **THEN** the call is blocked with `zone.read-only` naming `catalogs/eu`, while `catalogs/uk/x`
  classifies as `run`

### Requirement: Governed mounts are enabled per state

A mount the host declares governed (`MountSpec.governed`) SHALL be reachable from a state only when
that state enables it: the union of the state's `mounts.allow` and the root's `mounts.allow_always`,
minus what `mounts.forbid_always` or the state's `mounts.forbid` names. An ungoverned mount SHALL be
reachable in every state unless a `forbid` names it. One resolution
(`WorkflowMachine.enabledMounts(state, governed)`) SHALL be the single answer every governed reader
consults: the kernel's mount rule, the middleware's listing redaction, prompt disclosure and
`validate`.

A grant SHALL also decide **what** the state may do there: a mount is writable in a state only when
the host declared it writable and no applicable grant narrowed it to `access: read`
(`WorkflowMachine.mountWritable(state, name, prefixes)`, the second reader beside the enabled set).
The host's posture is the ceiling — `access: read_write` opens nothing the wiring serves read-only —
and a narrowing at either level holds, so no narrower level widens it back.

The kernel SHALL block a file tool call — `read_file`, `ls`, `glob`, `grep`, `write_file`, `edit_file`
and every sandbox tool call on the same origins the skill rule governs — whose canonical path falls
under a mount the active state does not enable, in every state whatever it allows, evaluated among the
safety rules after the zone rules so a write into a hidden read-only mount is still refused as
read-only, the more useful reason. A refusal SHALL distinguish its cause — `mount.forbidden` when a
list denies the name (naming the workflow that denied it when the denial is inherited),
`mount.not-allowed` when nothing enabled it, and `mount.read-only` when the state has the mount
but a grant narrowed it to reads — and SHALL name the mount and say the state does not have it,
never that the path is missing. A write into a mount the **host** serves read-only SHALL stay
`zone.read-only`, so a refusal names the level an author would fix: the wiring or the grant. A rubric grader and a lifecycle hook SHALL be bound by
`mounts.forbid_always` and not by a state's `forbid`, as they are for tools.

Listing results SHALL be redacted to the state's enabled mounts: an `ls`, `glob` or `grep` result
handed to the model SHALL carry no entry under a mount the state does not enable, the workspace root
listing included, so the agent is not shown a directory it then cannot read. Every call SHALL still be
decided by the kernel whether or not the mount was listed.

#### Scenario: A governed mount is hidden where nothing enables it

- **WHEN** the table governs `catalogs/eu`, state `intake` does not enable it and the model calls
  `read_file` on `catalogs/eu/skus.csv`, `ls` on `/`, and `grep` over `/`
- **THEN** the read is blocked with `mount.not-allowed`, the root listing shows no `catalogs/eu`
  entry, and the grep result carries no match under it

#### Scenario: The same mount is served where a state enables it

- **WHEN** state `triage` declares `mounts: { allow: [catalogs/eu] }`
- **THEN** in `triage` the same read succeeds, `ls /` lists `catalogs/eu/`, and a write there is
  refused with `zone.read-only`

#### Scenario: A grant narrows a writable mount to reads

- **WHEN** the table mounts `shared` writable and governed, state `edit` enables it plainly and
  state `review` enables it as `{ mount: shared, access: read }`
- **THEN** a write in `edit` succeeds, the same write in `review` is blocked with
  `mount.read-only` naming the mount, and `review` still reads and lists it in full

#### Scenario: A forbid says so

- **WHEN** the root declares `mounts: { forbid_always: [reference] }` and the model reads
  `reference/rates.csv`
- **THEN** the call is blocked with `mount.forbidden`, naming `reference` and the denying workflow

#### Scenario: An ungoverned mount needs no grant

- **WHEN** the table mounts `skills/` ungoverned and a state declares no `mounts` block
- **THEN** reads and listings under `skills/` are governed only by the skill rules, as today

#### Scenario: Undisclosed mount still governed

- **WHEN** the model calls `read_file` on a path under a governed mount that was redacted from its
  listing
- **THEN** the kernel blocks it with the mount rule's message, whether or not the listing showed it

### Requirement: Session areas

The runtime-internal areas SHALL admit no file tool call at all (`zone.runtime-internal`). The offload
areas SHALL be readable and listable without an `allow` entry (`tool.offload-read`) and never writable
(`zone.runtime-managed`). `scratchpad/` SHALL be readable, writable, editable and listable in every
state without an `allow` entry (`tool.scratchpad`), evaluated ahead of the per-state default, so an
`allow` entry naming a path inside `scratchpad/` SHALL NOT narrow where inside it a write lands; any
other session-root path SHALL be matched against the state's entries unchanged. Every block message
SHALL point at `scratchpad/` and name no second working area.

#### Scenario: Scratchpad open under a narrowing entry

- **WHEN** a state declares `{ tool: write_file, paths: ["output/**"] }` and the model writes `scratchpad/work.md`
- **THEN** the write is permitted with `tool.scratchpad`

### Requirement: Per-state tool disclosure

On every model call the runtime SHALL hand the model only the active state's disclosed tools: every
tool an effective entry names, plus `archmax_reset`, `archmax_wait`, `archmax_get_variables` and
`archmax_set_variables` in every state, plus `archmax_advance` except in a terminal state, minus the
tools a `forbid_always` or `forbid` entry names by name. `task` SHALL NOT be disclosed in any state of any assembly,
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
- **THEN** `archmax_advance` is not offered while `archmax_reset` and `archmax_wait` still are

#### Scenario: task is never offered

- **WHEN** any state of any assembly runs a model call, including a workflow whose rubrics the
  framework registered `task` for
- **THEN** no model call offers `task`, and the static prompt carries no task-tool guidance

#### Scenario: Undisclosed call still governed

- **WHEN** the model calls a registered tool that was not disclosed and is not allowed in the state
- **THEN** the kernel blocks it with the standard not-allowed message

### Requirement: Per-state graph disclosure

The graph SHALL be disclosed the way the tool surface is: only from where the agent stands. On
every model call the runtime SHALL disclose the active state's **outgoing transitions and nothing
else of the graph** — one line per edge carrying the target's slug, its declared `type` when not
`none`, and its required `description`. No other state's slug, `title`, `summary`, hook presence,
`triggers`, `budget`, `requires` or transitions SHALL reach any model call, and neither SHALL a
count of the states, so a state the agent cannot advance to is a state it cannot name.

An edge's line SHALL mark a target that is a **human decision node** or a **terminal** state,
because each changes what the call itself must carry or what follows it — evidence may be attached
only when advancing to a human state, and both mean the agent stops rather than continues. Nothing
further about the target SHALL be rendered: the marker discloses the consequence of taking the
edge, not the state on the other side of it.

The active state's own markers SHALL be disclosed in the same block: that it is terminal, and the
presence of its `before`/`after` hooks by kind (a `rubric` hook as the bare word `rubric`, never
its name or any part of its declaration), because a graded exit can return a correction the agent
must act on. The trigger signature SHALL be disclosed for the **run's own trigger only** — the
`requires` it was started with and the `returns` it must set before it completes — never for the
triggers of states this run did not enter.

A reply-only turn SHALL be disclosed no transitions at all, consistent with being handed no tools.

#### Scenario: Only the active state's edges are disclosed

- **WHEN** a workflow declares states `triage`, `refund-review`, `escalate` and `closed`, and the
  session is in `triage` with one transition to `refund-review`
- **THEN** the model call names `refund-review` and its description, and the prompt contains
  neither `escalate` nor `closed` anywhere

#### Scenario: A description is what the agent routes on

- **WHEN** the active state declares `- to: refund-review, description: "Refunds over $50."`
- **THEN** the disclosed line carries that description verbatim, and carries nothing of
  `refund-review`'s own `title`, `summary`, `instructions` or hooks

#### Scenario: A human target is marked, and only that

- **WHEN** a transition's target is a `type: human` state with `instructions`, `approvers` and
  three transitions of its own
- **THEN** the edge is marked as leading to a human decision node, and none of that state's
  `instructions`, `approvers` or transitions appear in the prompt

#### Scenario: A terminal target is marked

- **WHEN** a transition's target declares no transitions of its own
- **THEN** the edge is marked terminal, so the agent finishes the work before advancing rather
  than advancing and expecting another turn

#### Scenario: The active state's terminality is stated, not inferred

- **WHEN** the active state declares no transitions
- **THEN** the block states that the state is terminal and no transition leads out of it, rather
  than leaving the agent to infer it from an absent list, and `archmax_advance` is not disclosed

#### Scenario: A rubric hook is disclosed by kind only

- **WHEN** the active state declares `after: { rubric: { instructions: … } }`
- **THEN** the block records an `after` hook of kind `rubric`, and no model call carries the
  rubric's criteria, budget, model or any name for it

#### Scenario: Only the run's own trigger signature is disclosed

- **WHEN** a workflow declares triggers `manual` and `inbound-email` on two different states and
  the session was started by `manual`
- **THEN** the block carries `manual`'s `requires` and `returns` and never mentions
  `inbound-email` or the state it enters

#### Scenario: A parked session is disclosed no edges

- **WHEN** a session parked at a human state is handed a reply and spends its reply-only model call
- **THEN** no transition is disclosed, matching the tools it is handed

### Requirement: Tool names — resolution and the reserved prefix

`wrapToolCall` SHALL resolve the name the model called to a registered tool by exact match, or by the
bare action of a namespaced `<collection>__<action>` id when that suffix is unambiguous; a name that
resolves to nothing SHALL be answered with an error tool message saying it is not a tool (listing the
candidates when ambiguous), with no `tool-blocked` event, because a hallucinated name is a different
mistake from a governance denial. A host tool whose name starts with `archmax_` SHALL be refused at
assembly with `ReservedToolNameError`, so nothing can shadow a control, sandbox or delegation tool.

#### Scenario: Not a tool

- **WHEN** the model calls `gamma` and no registered tool has that name or ends in `__gamma`
- **THEN** the tool result is an error matching `not a tool` and no tool is reported blocked

### Requirement: No tool is callable during a reply-only turn

During a reply-only turn the runtime SHALL hand the model no tool definitions, the volatile block
SHALL say the session is parked, and the kernel SHALL refuse every tool call made in that turn with
`tool.reply-only`, evaluated ahead of every permitting rule — the control tools, `allow_always`, the
always-on set and the scratchpad rule included. The sandbox bridge SHALL carry the reply-only flag on
its live context so a script from an earlier turn is refused by the same rule.

#### Scenario: Control tool refused while parked

- **WHEN** the model calls `archmax_advance` during a reply-only turn
- **THEN** the call is refused, the session's position is unchanged, and the reason says the session is parked

### Requirement: Sandbox tool calls are governed on their origin

Every `tools.*` call a script makes SHALL run through the same `decide` pipeline as a model call, via
one gateway that wraps the PTC tool surface and reads the live state per call. A `script`-origin call
(code from `archmax_eval` or `archmax_run`) SHALL be governed as a model call in the active state. A
`lifecycle`-origin call (a hook script) SHALL skip the per-state allow rule, the per-state denial
(`tools.forbid`, `skills.forbid`) and the skill rule, and nothing else: a hook runs on runtime
authority, outside the state's tool surface in both directions, while the workflow-wide denials
(`tools.forbid_always`, `skills.forbid_always`) and every safety rule still bind it. A refused call SHALL throw a catchable `PtcGovernanceError` carrying the tool, rule id
and reason, and the tool SHALL never run; declarative mocks SHALL be consulted only after governance
permits. The kernel SHALL own the set of tools excluded from the PTC surface — the control tools, both
sandbox tools, and bare `eval` — consumed by the sandbox tool selection and the lifecycle runner alike,
even for an explicit allow-list; scripts read variables through `args.variables`. A delegation tool
SHALL NOT be excluded: a script reaches `archmax_workflow_<slug>` exactly as any tool the state grants.

#### Scenario: Script bound by the state

- **WHEN** a state does not allow `write_file` and `archmax_eval` code calls `tools.writeFile`
- **THEN** the call is refused with the verdict a model-initiated `write_file` would receive

#### Scenario: Hook keeps the full surface but not the safety rules

- **WHEN** a hook script calls a tool the state's `allow` list omits, and separately calls
  `tools.writeFile` on a read-only mount path
- **THEN** the first call runs and the second is blocked by `zone.read-only`

#### Scenario: A hook is bound by the workflow's denial and not the state's

- **WHEN** state `route` declares `tools: { forbid: [read_file] }`, the root declares
  `tools: { forbid_always: [write_file] }`, and a `before` hook on `route` calls both
- **THEN** the `read_file` call runs — a hook is outside the state's surface — and the `write_file`
  call is refused with a `PtcGovernanceError` naming the workflow-wide denial

### Requirement: Skills are governed by slug at the workflow root and per state

A spec SHALL grant skills by slug under `skills.allow_always` at the root — the slugs enabled in
every state — and under `skills.allow` on any state, which SHALL **add to** the root's always-on
list. It SHALL deny them in the same two positions: `skills.forbid_always` at the root puts a slug
out of reach of every state, and a state's `skills.forbid` removes a slug from that state's enabled
set, subtracting from the workflow's grant and the state's own list alike. Deny SHALL beat allow at
both levels.

One resolution (`WorkflowMachine.enabledSkills(state, available)`) SHALL be the single answer
every governed reader consults: prompt disclosure, the kernel's skill rule, the PTC
listing redaction and `validate`. A refusal SHALL distinguish its cause — `skill.forbidden` when a
list denies the slug, `skill.not-allowed` when nothing granted it.

An absent list SHALL enable nothing and SHALL be indistinguishable in effect from an empty list, at
every level, so a skill is enabled only where a list names it. An empty state `allow` SHALL NOT act
as a denial: `skills.forbid` is what subtracts.

There SHALL be one skills model: a root `skills.allow` is an unrecognized-key load error, and no
list is a ceiling over another. `validate` SHALL error on any slug no source provides.

#### Scenario: Absent lists enable nothing

- **WHEN** a workflow declares no root `skills` block, or state `done` declares
  `skills: { allow: [] }` while the root grants nothing always-on
- **THEN** a read inside any bundle is blocked there, the prompt renders no "Skills available in
  this state" section, and `ls skills/` returns no bundle

#### Scenario: An always-on grant is enabled where a state names nothing

- **WHEN** the root declares `skills: { allow_always: [orders] }` and state `draft` declares no
  `skills` block
- **THEN** `draft` reads `skills/orders/**` with no `tools.allow` path entry, the prompt's "Skills
  available in this state" section names `orders`, and `ls skills/` there lists that bundle

#### Scenario: A state's forbid subtracts from the workflow's grant

- **WHEN** the root declares `skills: { allow_always: [orders] }` and state `route` declares
  `skills: { forbid: [orders] }`
- **THEN** a read inside the bundle is blocked in `route` with `skill.forbidden`, the slug is absent
  from that state's prompt and from `ls skills/` there, and every other state still reads it

#### Scenario: A workflow-wide skill denial binds every state

- **WHEN** the root declares `skills: { forbid_always: [policy] }` and a state declares
  `skills: { allow: [policy] }`
- **THEN** the bundle is unreachable and undisclosed in every state, the denial winning over the
  state's grant

#### Scenario: A state's list adds to the always-on grant

- **WHEN** the root declares `skills: { allow_always: [orders] }` and state `read` declares
  `skills: { allow: [policy] }`
- **THEN** `read` reads inside both bundles, while a state declaring no `skills` block reads
  `skills/orders/**` and is blocked by `skill.not-allowed` inside `skills/policy/**`

#### Scenario: Enabling is the whole grant

- **WHEN** the root declares `skills: { allow_always: [orders] }` and nothing narrows it
- **THEN** every state reads `skills/orders/**` with no `tools.allow` path entry, and a bundle no
  list names is blocked everywhere

### Requirement: Skill sources resolve into one registry

Skill sources SHALL be an assembly input (`skills`, default `["skills/"]`; `[]` for none), read through
the workspace backend and resolved once into a registry mapping each slug to its description and bundle
prefix. A skill's slug SHALL be its directory name; a `SKILL.md` `name:` that disagrees SHALL be a
runtime warning and a `validate` error; a later source providing a known slug SHALL shadow it with a
warning. That registry SHALL be the single input to disclosure, the kernel's skill rule and
`validate`, and no governance module SHALL name `skills/`.

#### Scenario: Directory name is the slug

- **WHEN** `skills/order-data/SKILL.md` declares `name: order_data`
- **THEN** the mismatch is reported and the governed slug remains `order-data`

### Requirement: Enablement is the grant; a disabled skill is unreachable

A skill enabled in the acting state SHALL be readable and its scripts runnable with no `tools.allow`
path entry. A path inside a bundle the acting state does not enable SHALL be blocked by the safety rule
`skill.not-allowed` for `read_file`, `write_file`, `edit_file`, `ls`, `glob`, `grep` and `archmax_run`,
naming the slug and the state, after canonicalization, and no `tools.allow`, `allow_always`, denial
or consumer rule SHALL widen it. A state entry naming one of those tools SHALL still narrow within the
enabled set (enabled AND allowed). Enablement SHALL grant no write. Hook scripts SHALL be exempt;
`archmax_eval`/`archmax_run` code SHALL NOT be.

#### Scenario: Disabled bundle blocked, enabled bundle served

- **WHEN** state `start` enables `orders` only and the model reads `skills/orders/assets/orders.json` then `skills/policy/assets/rules.md`
- **THEN** the first read is served and the second is blocked with a reason naming skill `policy` and state `start`

#### Scenario: Wide grant cannot widen

- **WHEN** a state enables only `order-data` and declares `{ tool: archmax_run, paths: ["skills/**"] }`
- **THEN** running `skills/order-enrichment/scripts/enrich-orders.js` is blocked by the skill rule

### Requirement: A disabled skill is invisible to the model

The runtime SHALL render a "Skills available in this state" section into the volatile prompt block,
naming for each enabled skill its slug, description and `SKILL.md` path, and no section at all when the
state enables nothing; a disabled skill SHALL appear in no prompt section. The results of `ls`, `glob`
and `grep` SHALL be filtered, line by line, to drop every entry inside a bundle the state does not
enable — on the model's own call and on a script's `tools.ls`/`tools.glob`/`tools.grep` alike — while
hook scripts receive whole listings. `read_file` results SHALL NOT be filtered.

#### Scenario: Prompt names only enabled skills

- **WHEN** the model advances from a state enabling `orders` to one enabling nothing
- **THEN** the first model call's prompt names `orders` and not the other skill's description, and the second names neither

#### Scenario: Listing cannot reveal a disabled bundle

- **WHEN** a state enables only `order-data` and the model lists `skills/` or globs `skills/**/SKILL.md`
- **THEN** only `order-data` entries are returned, and the same listing through `archmax_eval` is filtered identically

### Requirement: The authoring backend is never served to the model

The runtime SHALL read `workflows/` (specs including the rubrics their states declare, `WORKFLOW.md`, hook
scripts, cases) through the authoring backend — `authoring` at assembly, else the custom
`backend`, else a `FilesystemBackend` over the workspace root — and that prefix SHALL have no route
in the agent's workspace composite: a file tool call on it resolves in the session's own folder,
finds no authored content, receives no governance message, and the root listing shows no entry. A
mount table declaring the prefix as a key SHALL fail assembly with `MountCollisionError` naming the
prefix, what it holds and the `authoring` option; a writable mount served by the same backend as the
authoring backend SHALL fail assembly with `AuthoringBackendExposedError`. A `script`- or
`lifecycle`-origin call whose path canonicalizes under the prefix SHALL be blocked with
`zone.governance-plane`, naming the tool, path and prefix, in every state whatever it allows.

The set of authoring prefixes SHALL remain a set, though it now holds one member: the classification
is the contract and its cardinality is incidental. What the model knows of a grader SHALL be that a
phase of a state carries one — the kind alone, from the rendered graph — and nothing else: not its
name, not its criteria, and no tool that takes either. Of the machine, what the prompt renders.

#### Scenario: Spec unreadable by the model

- **WHEN** the model calls `read_file` on `workflows/order-lookup/workflow.yaml`
- **THEN** no authored content is returned and the result reports the file as absent, with no governance message

#### Scenario: Mounting the prefix is refused

- **WHEN** a consumer supplies a mount at `/workflows/`
- **THEN** assembly throws `MountCollisionError` naming specs, rubrics, hook scripts and cases, and the `authoring` option

#### Scenario: A former prefix is ordinary content

- **WHEN** a consumer supplies a mount at `/subagents/`
- **THEN** the mount is accepted and served as ordinary agent-visible content, because no part of the
  runtime reads that prefix

#### Scenario: Hook reads a sibling spec

- **WHEN** a hook script calls `tools.readFile("workflows/other/workflow.yaml")`
- **THEN** the call fails with a reason naming `workflows/`

### Requirement: Two script homes with disjoint executors

Hook scripts SHALL live at `workflows/<slug>/hooks/<file>.js|.mjs`, declared workflow-relative
(`{ script: hooks/check.js }`): the schema SHALL reject a path outside `hooks/`, with a `..` segment,
or absolute, and the runtime SHALL resolve the declared path with the same confinement, an
unresolvable hook erroring and therefore vetoing fail-closed. Hook sources SHALL be read through the
authoring backend. Scripts the model runs with `archmax_run` SHALL be read through the agent workspace
and SHALL be confined by the safety rule `script.skill-only` to paths inside a bundle of the resolved
skill registry — classified through the registry's prefixes, not a literal `skills/` — so an empty
registry blocks every `archmax_run`. A state entry MAY narrow execution within the bundles and SHALL
NOT extend it. `archmax_eval` SHALL be unaffected by this rule.

#### Scenario: Hook runs from its workflow directory

- **WHEN** a state declares `before: { script: hooks/check-requester.js }`
- **THEN** the runtime reads `workflows/<slug>/hooks/check-requester.js` from the authoring backend and runs it

#### Scenario: Agent cannot run a hook or a scratchpad file

- **WHEN** the model calls `archmax_run` on `workflows/order-lookup/hooks/check-requester.js` or on `scratchpad/x.js`
- **THEN** the call is blocked with `script.skill-only` and the file is never read

### Requirement: Validation decides through the same kernel

`archmax validate` SHALL probe each state's `tools.allow` through `decide` with the same mount prefixes
and skill registry the runtime uses, and SHALL report as errors: a write entry into a runtime-owned
area or a read-only mount, an entry a `forbid_always` or `forbid` list denies, an entry naming
`task` (not grantable), an `archmax_run`
entry outside every skill bundle, a path entry that can only match inside a bundle the state does not
enable, an entry whose `file_path` glob resolves under `workflows/`, a hook `script`
outside `hooks/` or missing from it, and a hook script importing anything but `@archmax-ai/harness/*`. It SHALL
warn on an `archmax_advance` target with no declared edge. A rule that validates as permitted SHALL NOT
be blocked at runtime for the same inputs.

#### Scenario: Policy contradiction

- **WHEN** a state allows `write_file` on a path the workflow's `tools.forbid_always` denies
- **THEN** `validate` reports the contradiction as an error

#### Scenario: A task grant is an error

- **WHEN** a state's `tools.allow` or the workflow's `tools.allow_always` names `task`
- **THEN** `validate` reports an error, and the kernel blocks the call at runtime regardless

#### Scenario: A former prefix is judged like any path

- **WHEN** a state declares an allow entry whose `file_path` glob resolves under `subagents/`
- **THEN** `validate` reports no authoring-plane error for it

### Requirement: A disclosed trigger signature names each variable's type and description

Where the volatile "Current state" block discloses the session's own trigger signature (see
*Per-state graph disclosure*), each variable SHALL be disclosed with its declared type and
description beside its name when its entry declares them, and by name alone when it does not.
The disclosure SHALL keep its scope: the session's own trigger only, and never the trigger
declaration's `description`, which describes the entry to a caller rather than to the agent
serving it. The rendering SHALL be deterministic for one signature, so the block stays
byte-identical across the model calls of a turn.

#### Scenario: A typed return is disclosed with its type

- **WHEN** a session started by `manual` declaring
  `returns: [{ name: total, type: number, description: "Refunded amount in EUR." }, note]`
  makes a model call
- **THEN** the block names `total` as a `number` with its description and `note` by name alone

#### Scenario: The entry's description is not disclosed

- **WHEN** the `manual` declaration also carries `description: "Refund one order."`
- **THEN** no model call of the session carries that sentence

#### Scenario: An untyped signature renders as before

- **WHEN** a trigger declares `requires: [order_id]` and `returns: [status]`
- **THEN** the block names both by name alone
