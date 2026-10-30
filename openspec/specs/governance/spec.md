# governance Specification

## Purpose

Define how the archmax harness decides what a session may do: the pure decision kernel (`src/kernel/kernel.ts`)
that turns a proposed tool call or transition into a verdict; the allow-only,
per-state tool surface and its precedence; argument guards; tool and skill disclosure, which show
the model only what the kernel would permit; path zones over the session areas and the read-only
mounts; skill governance by slug; the isolation of the authoring backend; and where authored
JavaScript may run from. Runtime enforcement and `archmax validate` share every rule.

## Requirements

### Requirement: One pure decision function

The kernel SHALL expose a single pure, synchronous function, `decide(machine, action, policyRules,
mountPrefixes, variables, skills)`, that returns a typed verdict for a proposed action: a tool call
(`{ state, tool, args, origin?, replyOnly? }`) or a transition (`{ from, to, reason? }`). The kernel
SHALL decide no state entry, and a transition SHALL carry nothing beyond its edge and its reason. A
tool call's `origin` SHALL be one of:

- `agent`, a model's call, the session's agent's or a grader's. It is the default when absent.
- `script`, a call from an agent's sandbox script or from a code state's script.
- `runtime`, the runtime's own `file`-value read check.

A verdict SHALL carry `decision` (`allow` or `block`), a stable `ruleId`, and on a block a
`reason`; it MAY mark the block `terminal` (retrying cannot recover it) or `warn` (it surfaces as
a warn-level event). The kernel SHALL hold no list of authored directory names and SHALL discover
no skills: the resolved mount prefixes and skill table are inputs supplied by the caller, so the
runtime and `archmax validate` reach identical verdicts from identical inputs.

#### Scenario: Purity

- **WHEN** `decide` is called twice with the same machine, action, rules, mount prefixes, variables and skills
- **THEN** it returns the same verdict with the same `ruleId` and has no side effects

### Requirement: Tool-call verdicts come from an ordered rule pipeline

The kernel SHALL decide a tool call by folding an ordered pipeline of pure rules, each returning a
verdict or abstaining; the first verdict wins and every rule abstaining means allow. The order SHALL
be: the non-overridable safety rules — the authoring-backend refusal for `script`- and
`runtime`-origin calls (`zone.governance-plane`), the skill-bundle confinement of `archmax_run`
(`script.skill-only`), the reply-only refusal (`tool.reply-only`), the bare-`eval` block
(`tool.eval`), the read-only mount write block (`zone.read-only`), the runtime-internal area block
(`zone.runtime-internal`), the offload-area write block (`zone.runtime-managed`), and the
disabled-skill block (`skill.not-allowed`, `skill.forbidden`) — then the workflow-wide denials
(`tool.forbidden`), then the active state's denials (`tool.forbidden-here`), then the consumer's
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
or a declared denial. The same rules SHALL govern calls made through the sandbox bridge and every
call an automated state makes, its control tools included. Every rule SHALL see the call's
`origin`: `agent` when absent (the session's agent's or a grader's call), `script` (an agent's
sandbox script or a code state's script), or `runtime` (the runtime's own `file`-value read check).

#### Scenario: Custom rule blocks in every state

- **WHEN** a consumer rule blocks `web_fetch` for a non-allowlisted URL and the model calls it in a
  state whose `tools.allow` names `web_fetch`
- **THEN** the call is blocked with the rule's reason

#### Scenario: A rule sees each caller's origin

- **WHEN** a consumer rule records the `origin` of each call it decides, in a session whose agent
  runs `archmax_eval` code, enters a code state and a grader state, and records a `file` return
- **THEN** the rule sees `agent` for the agent's and the grader's own calls, `script` for the
  `archmax_eval` code's and the code state's script calls, and `runtime` for the `file` check alone

### Requirement: Workflow and state denials

A workflow SHALL declare denial in the same two positions it declares a grant:
`tools.forbid_always` at the root and `tools.forbid` on a state, taking the same entries as their
`allow` counterparts. There SHALL be no `policy` block: a root `policy:` key is an
unrecognized-key load error.

`tools.forbid_always` SHALL block each entry in every state — the always-on tools and the control
tools included — and a state's `tools.forbid` SHALL block each entry while that state is active,
subtracting from the workflow's `allow_always`, the state's own `allow` and the always-on surface
alike. Both SHALL bind every caller in the state they apply to: the session's agent, the agent's
scripts, and an automated state's grader or script, the automated state's control tools included.
A forbid entry MAY name the tool `*`, meaning every tool, which is how a path is denied
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
| code, grader  | `archmax_advance`, `archmax_raise`, `archmax_get_variables`, `archmax_set_variables`, `archmax_get_history` | `write_todos`, `archmax_eval`, `archmax_run`, `archmax_wait`, `archmax_reset` |

A state SHALL never be offered a tool its type withholds: not as a default tool, and not where the
workflow's `tools.allow_always` or the state's own `tools.allow` names one (see "Effective entries
and precedence"). The reserved control tools (`HARNESS_CONTROL_TOOLS`) SHALL be every type's
`controls` plus the two sandbox tools. `archmax_get_history` SHALL be a control tool like the
others: never part of an agent script's surface, and permitted only in a grader or a code state.

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

### Requirement: Effective entries and precedence

The entries that govern a state SHALL be derived once, in precedence order, and read by both
enforcement and disclosure: the state's own `tools.allow` entries; then the workflow-wide grant's
entries for tools the state does not mention and that are not host `essentialTools`; then the host's
`essentialTools` the state does not mention, unconstrained. The workflow-wide grant SHALL be the declared
`tools.allow_always` entries, constraints included, or, when the key is absent, the default tools,
unconstrained. A tool SHALL be decided by exactly one tier, so a state entry naming a granted tool
narrows it, and a workflow-wide entry for a tool the state mentions SHALL be inert in that state.

In a grader or code state, an entry naming a tool its type withholds
(`STATE_TYPE_TOOLS[type].withheld`: `write_todos`, `archmax_eval`, `archmax_run`, `archmax_wait`,
`archmax_reset`) SHALL be dropped, whether it is the state's own, a declared `allow_always` one or
a default tool, so it neither grants nor narrows there. `validate` reports the state's own entry
naming a withheld tool as an error (see "Validation decides through the same kernel").

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

#### Scenario: A withheld tool's entry grants nothing in an automated state

- **WHEN** the root declares `tools: { allow_always: [read_file, archmax_run] }` and code state
  `check-refund` declares `tools.allow: [archmax_eval]`
- **THEN** neither `archmax_eval` nor `archmax_run` is offered in `check-refund` and `decide` blocks
  both there with `tool.not-allowed`, while `read_file` is offered there and an agent state with no
  `tools` block permits `archmax_run`

#### Scenario: An automated state's default tools leave out the withheld ones

- **WHEN** a workflow without `tools.allow_always` enters a code state and a grader state, neither
  with a `tools` block
- **THEN** each is offered the file tools and the file operations, and neither is offered
  `write_todos`, `archmax_eval` or `archmax_run`

### Requirement: Allow entry shapes and argument guards

An entry in `tools.allow` or `tools.allow_always` SHALL be a bare tool name (any arguments),
`{ tool, args: { <param>: [globs] } }` matching each named parameter (dotted keys read nested
arguments), or `{ tool, paths: [...] }`, which guards **every path argument the tool declares**
(see "Tools declare their path arguments"): a grant admits a call only when each declared path the
call names matches one of the globs, and a declared path the call omits matches nothing. For a tool
that declares no path argument, `paths:` SHALL guard `file_path`. An entry without `args`/`paths`
SHALL match any arguments.

An argument SHALL be matched as a **path** when the tool declares it one (or names it through a
built-in alias, such as `path` for `read_file`), and, for a tool that declares no path argument,
when it is `file_path`. A path value SHALL be canonicalized (leading slashes stripped, `.` and empty
segments dropped, `..` applied) before it is matched, so a `./` or `..` spelling cannot dodge a
guard. Every other argument SHALL be matched as **text**: in a grant, its value as given against the
globs as written, with nothing canonicalized; in a denial (`tools.forbid`, `tools.forbid_always`),
the value as given or its canonical path form, either matching, so treating an argument as text
never makes a denial easier to dodge. Glob syntax SHALL be the same for both: `*` does not cross a
`/`, and `**` does. An empty pattern, written or resolved from a `${{…}}` reference, SHALL match
only an empty value and SHALL never fail the call.

#### Scenario: Argument glob

- **WHEN** a state allows `{ tool: alpha, args: { q: ["ok-*"] } }`
- **THEN** `alpha({ q: "ok-1" })` is permitted and `alpha({ q: "bad" })` is blocked

#### Scenario: A paths grant needs every declared path

- **WHEN** a state allows `{ tool: copy_file, paths: ["skills/**", "reports/**"] }`
- **THEN** a copy from `skills/data/t.md` to `reports/t.md` is permitted and a copy to `drafts/t.md`
  is blocked with `tool.not-allowed`

#### Scenario: A paths guard on a search tool guards its own path argument

- **WHEN** a state allows `{ tool: grep, paths: ["reports/**"] }`
- **THEN** `grep({ pattern, path: "reports/q3" })` is permitted and `grep({ pattern, path: "drafts" })`
  is blocked

#### Scenario: A URL is matched as text

- **WHEN** a state allows `{ tool: fetch, args: { url: ["https://api.example.com/**"] } }`
- **THEN** `fetch({ url: "https://api.example.com/v1/orders" })` is permitted and
  `fetch({ url: "https://evil.example.com/v1/orders" })` is blocked

#### Scenario: A stored value matches itself

- **WHEN** a state allows `{ tool: update_address, args: { line: ["${{p.line}}"] } }` and `p.line` is
  `"Unit 4//B"`
- **THEN** `update_address({ line: "Unit 4//B" })` is permitted and `update_address({ line: "Unit 4/B" })`
  is blocked

#### Scenario: An empty value is guarded, not fatal

- **WHEN** a state allows `{ tool: update_address, args: { address2: ["${{p.address2}}"] } }` and
  `p.address2` is `""`
- **THEN** `update_address({ address2: "" })` is permitted, `update_address({ address2: "Suite 4" })`
  is blocked, and the turn goes on

#### Scenario: A path argument is still canonicalized

- **WHEN** a state allows `{ tool: write_file, args: { file_path: ["reports/**"] } }`
- **THEN** `write_file({ file_path: "./reports/q3.md" })` is permitted and
  `write_file({ file_path: "reports/../secrets/k" })` is blocked

#### Scenario: A denial on a text argument catches either form

- **WHEN** the root declares `tools: { forbid_always: [{ tool: sync, args: { target: ["secrets/**"] } }] }`
  for a host tool that declares no path argument, and the state grants `sync`
- **THEN** `sync({ target: "secrets/k" })` and `sync({ target: "./secrets/k" })` are both blocked

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

On an agent-originated call — the session's agent's, or a grader's — the runtime SHALL resolve
`${{…}}` references in the arguments as the first stage of its tool-call handling (`wrapToolCall`
for the session's agent, the grader's own middleware for a grader). This happens before
canonicalization, guard matching and every rule, so governance and the tool see the same resolved
arguments. The value SHALL be substituted verbatim and matched as data, never as pattern syntax. An
unresolvable reference SHALL refuse the call before any rule runs, with a correctable message
naming the reference and the `$${{…}}` escape. Delegation tools (`archmax_workflow_<slug>`) SHALL
be exempt, their parameters being resolved by the dispatcher.

Script arguments passed through the sandbox bridge SHALL NOT be substituted. This holds for an
agent script and a code state's script alike: a script passes computed values and reads the
variables as `args.variables`, so `${{…}}` text in its arguments is data. A script's call SHALL
nonetheless be guarded against the session's variables, so a `${{name}}` guard admits from a
script exactly what it admits from the model:

- an agent script's call against the variables in force at the turn's model call (the PTC gateway
  is refreshed with them);
- a code state's script call against the variables as that state sees them, its own accepted
  writes included (see the `automated-states` capability).

#### Scenario: Both sides resolve

- **WHEN** a guard is `["${{from_email}}"]`, `from_email` holds `a@b.c`, and the model calls with `"${{from_email}}"`
- **THEN** the call is permitted and the tool receives `a@b.c`

#### Scenario: A script's call under a variable guard

- **WHEN** a state allows `read_file` only with `file_path: ["${{report_path}}"]`, `report_path` is set, and code run via `archmax_eval` calls `tools.readFile` with that path
- **THEN** the call is permitted, exactly as the model's own would be, and a different path from the script is blocked

#### Scenario: A grader's arguments are substituted

- **WHEN** a grader state allows `read_file` only with `file_path: ["${{report_path}}"]`,
  `report_path` is set, and the grader calls `read_file` with `file_path: "${{report_path}}"`
- **THEN** the call is permitted and the tool receives the resolved path

### Requirement: Path zones and read-only mounts

Every path decision SHALL classify each canonical path a call names through its tool's declared path
arguments, through one zone table: `authored` for a path under a read-only directory mount or an
exact read-only file mount of the workspace's resolved table; `run-internal` for `checkpoints/`,
`artifacts/`, `_specs/`; `run-offload` for `large_tool_results/`, `conversation_history/`;
`run-open` for `scratchpad/`; `run` for anything else at the session root; `escapes` for a path
climbing above the root. The table SHALL be the resolved keys the composite routes on, supplied to
the kernel and to `validate`. A directory mount name of several segments (`catalogs/eu`) SHALL match
a path by **longest prefix**, so a nested key classifies exactly as a single-segment key does and a
sibling under the same first segment (`catalogs/uk`) does not. A writable mount SHALL NOT classify
as authored, and with no table nothing SHALL. A path argument declared `write` or `remove` on an
`authored` path SHALL be blocked with `zone.read-only` in every state, with a message naming the
mount and directing the model to `scratchpad/`; mounts SHALL also refuse writes, uploads and
deletes themselves, so the kernel rule is the diagnostic layer rather than the only enforcement.

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

#### Scenario: A move out of a read-only mount is a refused removal

- **WHEN** the model calls `move_file` from `skills/data/t.md` to `scratchpad/t.md`
- **THEN** the call is blocked with `zone.read-only`, the reason names `'skills/data/t.md' (source)`,
  and nothing is written

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

### Requirement: Per-state tool disclosure

On every model call the runtime SHALL hand the model only the active state's disclosed tools, and
an automated state SHALL be offered exactly its own state's disclosed tools: a grader as its tool
list, a code state's script as its `tools` (see the `automated-states` capability). A state's
disclosed tools SHALL be every tool an effective entry names, plus the control tools of its type
other than `archmax_advance`, plus `archmax_advance` except in a terminal state, minus the tools a
`forbid_always` or `forbid` entry names by name. The control tools other than `archmax_advance` are,
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

During a reply-only turn the runtime SHALL hand the model the parked state's tool list — the same
definitions any other model call in that state is handed, never an empty list — because a
transcript's tool calls and runtime notes are tool-call pairs, and a provider may refuse a request
that carries them without tool definitions. The volatile block SHALL say the session is parked, and
the kernel SHALL refuse every tool call made in that turn with
`tool.reply-only`, evaluated ahead of every permitting rule — the control tools, `allow_always`, the
always-on set and the scratchpad rule included. The sandbox bridge SHALL carry the reply-only flag on
its live context so a script from an earlier turn is refused by the same rule.

#### Scenario: Control tool refused while parked

- **WHEN** the model calls `archmax_advance` during a reply-only turn
- **THEN** the call is refused, the session's position is unchanged, and the reason says the session is parked

#### Scenario: The reply-only call carries the state's tools

- **WHEN** a session that made tool calls parks at `refund-review` and spends its reply-only model
  call
- **THEN** that call is handed the same tool definitions as any model call in `refund-review`, not
  an empty list

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
enabled set (enabled AND allowed). Enablement SHALL grant no write.

The runtime's own `file`-value read (origin `runtime`) SHALL be exempt from the enabled set, held
only to the workflow's `skills.forbid_always` and the skill denials it inherits. `archmax_eval` and
`archmax_run` code, a code state's script and a grader SHALL NOT be exempt: each is held to the
enabled set of the state it acts in.

#### Scenario: Disabled bundle blocked, enabled bundle served

- **WHEN** state `start` enables `orders` only and the model reads `skills/orders/assets/orders.json` then `skills/policy/assets/rules.md`
- **THEN** the first read is served and the second is blocked with a reason naming skill `policy` and state `start`

#### Scenario: Wide grant cannot widen

- **WHEN** a state enables only `order-data` and declares `{ tool: archmax_run, paths: ["skills/**"] }`
- **THEN** running `skills/order-enrichment/scripts/enrich-orders.js` is blocked by the skill rule

#### Scenario: A code state's script reads only the bundles its state enables

- **WHEN** state `identify-case` declares `skills: { allow: [orders] }`, code state
  `screen-request` enables no skill, and its script calls
  `tools.readFile("skills/orders/assets/orders.json")`
- **THEN** the call throws a `PtcGovernanceError` with `skill.not-allowed` naming `orders` and
  `screen-request`

#### Scenario: The runtime's read is held only to skill denials

- **WHEN** no state enables the skill `billing` and a `file` value names
  `skills/billing/assets/template.pdf`, and in another workflow whose root declares
  `skills: { forbid_always: [billing] }` a `file` value names the same path
- **THEN** the runtime's check admits the first and refuses the second with `skill.forbidden`

### Requirement: A disabled skill is invisible to the model

The runtime SHALL render a "Skills available in this state" section into the volatile prompt block,
naming for each enabled skill its slug, description and `SKILL.md` path, and no section at all when the
state enables nothing; a disabled skill SHALL appear in no prompt section. The results of `ls`, `glob`
and `grep` SHALL be filtered, line by line, to drop every entry inside a bundle the acting state does
not enable — on the model's own call, on a grader's call, and on a script's
`tools.ls`/`tools.glob`/`tools.grep` alike, whether an agent script or a code state's script. No
caller SHALL receive an unfiltered listing. `read_file` results SHALL NOT be filtered.

#### Scenario: Prompt names only enabled skills

- **WHEN** the model advances from a state enabling `orders` to one enabling nothing
- **THEN** the first model call's prompt names `orders` and not the other skill's description, and the second names neither

#### Scenario: Listing cannot reveal a disabled bundle

- **WHEN** a state enables only `order-data` and the model lists `skills/` or globs `skills/**/SKILL.md`
- **THEN** only `order-data` entries are returned, and the same listing through `archmax_eval` is filtered identically

#### Scenario: A code state's listing is filtered to its state

- **WHEN** a code state enabling only `order-data` runs a script that calls `tools.ls("skills/")`
- **THEN** only the `order-data` entry is returned

### Requirement: Validation decides through the same kernel

`archmax validate` SHALL probe each state's `tools.allow` through `decide` with the same mount
prefixes and skill registry the runtime uses. It SHALL report as errors:

- a write entry into a runtime-owned area or a read-only mount;
- an entry a `forbid_always` or `forbid` list denies;
- an entry naming `task` (`TASK_TOOL`, not grantable);
- an `archmax_run` entry outside every skill bundle;
- a path entry that can only match inside a bundle the state does not enable;
- an entry whose `file_path` glob resolves under `workflows/`;
- an entry in a grader or code state naming a tool its type withholds
  (`STATE_TYPE_TOOLS[type].withheld`: `write_todos`, `archmax_eval`, `archmax_run`,
  `archmax_wait`, `archmax_reset`);
- a code state's `script` outside `scripts/` or missing from it;
- a code-state script importing anything but `@archmax-ai/harness/*`.

It SHALL warn on an `archmax_advance` target with no declared edge. A rule that validates as
permitted SHALL NOT be blocked at runtime for the same inputs.

#### Scenario: Policy contradiction

- **WHEN** a state allows `write_file` on a path the workflow's `tools.forbid_always` denies
- **THEN** `validate` reports the contradiction as an error

#### Scenario: A task grant is an error

- **WHEN** a state's `tools.allow` or the workflow's `tools.allow_always` names `task`
- **THEN** `validate` reports an error, and the kernel blocks the call at runtime regardless

#### Scenario: A former prefix is judged like any path

- **WHEN** a state declares an allow entry whose `file_path` glob resolves under `subagents/`
- **THEN** `validate` reports no authoring-plane error for it

#### Scenario: A missing code-state script is an error

- **WHEN** a code state declares `script: scripts/check-refund.js` and no such file exists under
  the workflow's `scripts/`
- **THEN** `validate` reports an error naming the state and the path

### Requirement: A disclosed trigger signature names each variable's type and description

Where the volatile "Current state" block discloses the session's own trigger signature (see
*The graph is disclosed only from the active state*), each variable SHALL be disclosed with its declared type and
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

### Requirement: Tools declare their path arguments

The runtime SHALL keep one table naming, per tool, the arguments that name workspace paths and how a
call uses each — `read`, `list`, `search`, `write`, `remove` or `execute`. The built-in entries SHALL
be `read_file`, `write_file`, `edit_file` (`file_path`: read, write, write), `ls` (`path`: list),
`glob`, `grep` (`path`: search), `archmax_run` (`file_path`: execute), `copy_file` (`source`: read,
`destination`: write), `move_file` (`source`: remove, `destination`: write) and `remove_file`
(`file_path`: remove). For the single-path built-ins the kernel SHALL read the declared argument and,
when it is absent, the second spelling the tool itself accepts (`path` for `file_path` and the
reverse), so a call cannot pass a path ungoverned by spelling it the other way.

A host SHALL declare its own tools' path arguments through `createAgent`'s `toolPaths` or a
`toolsFromMap` descriptor's `paths`, the option winning for a tool declared both ways. A declaration
for a built-in tool, an unknown access, or an empty declaration SHALL fail assembly with
`ToolPathsError`. A tool with no declaration SHALL be subject to no path rule. Every machine of an
assembly, root and delegated, SHALL govern by the same table.

A declared argument SHALL hold one path or a list of paths; each path of a list SHALL be governed
with the argument's access, and an omitted argument or an empty list SHALL name no path. A declared
argument holding anything else — a number, an object, a list containing a non-string — SHALL be
refused before every other rule (`tool.path-argument`), so no path inside it passes ungoverned.

Every path rule SHALL evaluate every declared path a call names, with its access: the read-only zone
and the runtime-managed areas refuse `write` and `remove`; the runtime-internal areas, a skill bundle
the state does not enable, and a governed mount the state was not given refuse every access; a mount
narrowed to `access: read`, or a governed one no grant of the workflow asks to write, refuses `write`
and `remove` (`mount.read-only`); an inherited mount or
skill denial refuses every access; `script.skill-only` confines `execute`; and the authoring-plane
rule reads them for `script`- and `runtime`-origin calls. A call SHALL be refused when any one of its
paths is, and for a tool declaring several, the refusal SHALL name the argument
(`'copy_file' on 'x' (destination)`). A `paths:` guard SHALL test every path of every declared
argument, each element of a list on its own: a grant SHALL need every one to match, and an omitted
argument or an empty list SHALL match no glob. A `paths:` guard in a forbid entry SHALL match a call
when **any** declared path it names matches, so `{ tool: "*", paths: [secrets/**] }` refuses a copy
out of `secrets/` and a copy into it. The kernel, `validate`'s probes and the sandbox's governed
tool bridge SHALL read the same table, so a script's call is governed by its declared paths exactly
as the model's is.

#### Scenario: A host tool's read is refused a mount the state was not given

- **WHEN** a workflow grants the governed mount `contracts` only in `intake`, and in `reply` the model
  calls a host tool declaring `{ path: "read" }` with `path: "contracts/x"`
- **THEN** the call is blocked with `mount.not-allowed` and the tool's handler never runs

#### Scenario: A host tool's write is refused a read-only grant

- **WHEN** a state narrows a writable mount `shared` to `access: read`, and a host tool declaring
  `{ source: "remove", destination: "write" }` names `shared/a.md` as either argument
- **THEN** the call is blocked with `mount.read-only`, while a `read` argument under `shared/` is allowed

#### Scenario: A host tool's read is refused a disabled skill

- **WHEN** a state does not enable the skill `billing` and a host tool declaring `{ path: "read" }`
  names `skills/billing/SKILL.md`
- **THEN** the call is blocked with `skill.not-allowed`

#### Scenario: A path denial covers both sides of a copy

- **WHEN** `tools.forbid_always` declares `{ tool: "*", paths: ["secrets/**"] }`
- **THEN** `copy_file` from `secrets/key.pem` and `copy_file` to `secrets/key.pem` are both blocked with `tool.forbidden`

#### Scenario: The alias spelling is governed

- **WHEN** the model calls `read_file` with `path: "checkpoints/cp-1.json"` and no `file_path`
- **THEN** the call is blocked with `zone.runtime-internal`

#### Scenario: A built-in's paths cannot be redeclared

- **WHEN** a host passes `toolPaths: { read_file: { file_path: "read" } }`
- **THEN** assembly throws `ToolPathsError`

#### Scenario: Each path of a list is governed

- **WHEN** a host tool declares `{ files: "read" }` and, in a state not given the governed mount
  `contracts`, the model calls it with `files: ["attachments/a.txt", "contracts/b.docx"]`
- **THEN** the call is blocked with `mount.not-allowed`

#### Scenario: A paths grant tests each element

- **WHEN** a state grants `{ tool: attach, paths: ["attachments/**"] }` and the model calls `attach`
  with `files: ["attachments/a.txt", "contracts/b.docx"]`
- **THEN** the call is not granted, though the two joined into one string would match the glob

#### Scenario: A path argument of another shape is refused

- **WHEN** a tool declaring `{ files: "read" }` is called with `files: ["a.txt", 3]` or `files: { path: "b.txt" }`
- **THEN** the call is blocked with `tool.path-argument`

### Requirement: The kernel decides a transition on its requirements and its edge

The kernel SHALL decide a transition (`{ from, to, reason? }`) on the leaving state's `requires`
and the declared edge alone: first `transition.requires` (recoverable, naming each unset
variable), then `transition.no-edge` (listing the valid targets), otherwise allow. The same
verdict SHALL decide every `archmax_advance`, whoever calls it: the session's agent, a grader or a
code state's script.

#### Scenario: Requires before the edge

- **WHEN** the model calls `archmax_advance` out of a state whose `requires` names an unset variable
- **THEN** the verdict is a recoverable block naming that variable, whether or not the target is a
  declared edge

#### Scenario: Undeclared edge

- **WHEN** `archmax_advance` names a `to` that is not one of the current state's `transitions`
- **THEN** the transition is blocked with `transition.no-edge`, whatever the state's `tools.allow` says

#### Scenario: An automated state's advance gets the same verdict

- **WHEN** a code state's script calls `tools.archmax_advance({ to: "closed", reason })` and
  `closed` is not one of the code state's `transitions`
- **THEN** the call is refused with `transition.no-edge`, listing the valid targets, exactly as the
  agent's own call would be

### Requirement: An automated state is governed by its own state's surface

Every call an automated state makes SHALL be decided by `decide` against that state: a grader's
with origin `agent`, as the agent's would be there, and a code state's script calls with origin
`script`. Every tool it is offered SHALL pass that decision, its control tools included, so a
`forbid` entry, a consumer rule and every safety rule bind its controls too. Only the state's own
grants SHALL count, never another state's. A refused grader call SHALL reach the grader as an
error tool result, and the tool SHALL NOT run.

#### Scenario: A grader is held to its own state's grants

- **WHEN** agent state `enrich-order` grants `lookup_orders`, advances to grader state
  `review-enrichment`, which grants no host tool, and the grader calls `lookup_orders`
- **THEN** the call is blocked with `tool.not-allowed` naming `review-enrichment`, the grader receives
  an error tool result, and `lookup_orders` does not run

#### Scenario: The previous state's grant does not follow into a code state

- **WHEN** `refund-request` grants `lookup_orders` and advances to code state `check-refund`,
  which grants no host tool
- **THEN** `tools.lookup_orders` is `undefined` in `check-refund`'s script, and `decide` blocks
  `lookup_orders` in `check-refund` with `tool.not-allowed`

### Requirement: Only the runtime's own file-value read runs on runtime authority

The kernel's `runtime` origin SHALL be used only for the runtime's own check that a `file` value
names a file the session may read, decided as a `read_file` of the path. No script or grader SHALL
be decided on it, there SHALL be no `lifecycle` origin, and the runtime SHALL make no write on it.
A `runtime`-origin call SHALL skip the per-state allow rule, the state's `tools.forbid`,
`skills.forbid` and `mounts.forbid`, and the skill enablement check. Every `forbid_always` list
(its own workflow's and every ancestor's), the consumer's rules and every safety rule SHALL still
bind it.

#### Scenario: A state's denial does not bind the runtime's read

- **WHEN** state `route` declares `tools: { forbid: [read_file] }`, the root declares
  `tools: { forbid_always: [{ tool: read_file, paths: [scratchpad/private/**] }] }`, and in `route`
  the agent records `file` returns naming `scratchpad/report.pdf` and
  `scratchpad/private/salaries.pdf`, both present
- **THEN** the runtime's check admits the first and refuses the second with `tool.forbidden`

### Requirement: The runtime's read meets mount grants on workflow scope

A `runtime`-origin call SHALL meet the mount grants of its **workflow**, not of the active state. A
governed mount SHALL be reachable when some grant of the workflow names it (`mounts.allow_always`
or any state's `mounts.allow`), and otherwise refused with `mount.not-allowed`, saying no grant of
the workflow names it. The workflow's `mounts.forbid_always` SHALL refuse it with
`mount.forbidden`. A state's `mounts.allow`, `mounts.forbid` and `access: read` SHALL NOT bind it,
and a grant of another workflow in the same tree SHALL never count.

#### Scenario: The runtime's read admits a mount its workflow grants in another state

- **WHEN** the table governs `catalogs/eu`, only state `triage` enables it, and in state `intake`
  the agent records a `file` return naming `catalogs/eu/skus.csv`, which exists
- **THEN** the runtime's check admits the value, while the agent's own `read_file` of that path in
  `intake` is blocked with `mount.not-allowed`

#### Scenario: The runtime's read cannot reach a mount only another workflow grants

- **WHEN** the table mounts `invoices` governed because a child workflow grants it, the calling
  workflow grants it nowhere, and a `file` value of the calling workflow names `invoices/a.xml`
- **THEN** the check refuses it with `mount.not-allowed`, naming `invoices` and saying no grant of
  the workflow names it

#### Scenario: A workflow's own mount denial binds the runtime's read

- **WHEN** the root declares `mounts: { forbid_always: [reference] }` and a `file` value of that
  workflow names `reference/rates.csv`
- **THEN** the check refuses it with `mount.forbidden`, while a state's `mounts.forbid` naming the
  same mount would not bind the check

### Requirement: A governed mount is reachable only where the acting state enables it

A mount the host declares governed (`MountSpec.governed`) SHALL be reachable from a state only when
that state enables it: the union of the state's `mounts.allow` and the root's `mounts.allow_always`,
minus what `mounts.forbid_always` or the state's `mounts.forbid` names. An ungoverned mount SHALL be
reachable in every state unless a `forbid` names it. One resolution
(`WorkflowMachine.enabledMounts(state, governed)`) SHALL be the single answer every governed reader
consults: the kernel's mount rule, the middleware's listing redaction, prompt disclosure and
`validate`.

A grant SHALL also decide **what** the state may do there: a governed mount is writable in a state
only when the host declared it writable, some grant of the machine's own spec asks
`access: read_write` for it, and no applicable grant narrowed it to `access: read`
(`WorkflowMachine.mountWritable(state, name, prefixes)`, the second reader beside the enabled set).
The host's posture is the ceiling: `access: read_write` opens nothing the wiring serves read-only.
A narrowing at either level holds, so no narrower level widens it back. One workflow's `read_write`
never widens another's bare grant of the same route, though one table serves both.

The kernel SHALL block a file tool call — `read_file`, `ls`, `glob`, `grep`, `write_file`, `edit_file`
and every sandbox tool call on the same origins the skill rule governs — whose canonical path falls
under a mount the active state does not enable, in every state whatever it allows, evaluated among the
safety rules after the zone rules so a write into a hidden read-only mount is still refused as
read-only, the more useful reason. A refusal SHALL distinguish its cause — `mount.forbidden` when a
list denies the name (naming the workflow that denied it when the denial is inherited),
`mount.not-allowed` when nothing enabled it, and `mount.read-only` when the state has the mount
but a grant narrowed it to reads or no grant of the workflow asks to write it, saying which — and SHALL name the mount and say the state does not have it,
never that the path is missing. A write into a mount the **host** serves read-only SHALL stay
`zone.read-only`, so a refusal names the level an author would fix: the wiring or the grant. A
grader's calls and a code state's script calls SHALL be decided on the enabled mounts and access of
their own state, exactly as the agent's are in that state.

Listing results SHALL be redacted to the state's enabled mounts: an `ls`, `glob` or `grep` result
handed to the model, to a grader or to a script SHALL carry no entry under a mount the state does
not enable, the workspace root listing included, so no caller is shown a directory it then cannot
read. Every call SHALL still be decided by the kernel whether or not the mount was listed.

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

- **WHEN** the table mounts `shared` writable and governed, state `edit` enables it as
  `{ mount: shared, access: read_write }` and state `review` enables it as
  `{ mount: shared, access: read }`
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

#### Scenario: A write no grant of the workflow asks for is refused

- **WHEN** the table mounts `exports` writable and governed, and the workflow grants it only bare
- **THEN** a write under `exports/` is blocked with `mount.read-only`, naming the mount and saying
  no grant of this workflow asks for `access: read_write`

#### Scenario: An automated state is held to its own state's mounts

- **WHEN** the table governs `catalogs/eu`, only state `triage` enables it, and the script of code
  state `screen-request` and the grader of grader state `review-enrichment` each read
  `catalogs/eu/skus.csv` and list `/`
- **THEN** both reads are blocked with `mount.not-allowed`, and neither listing shows a
  `catalogs/eu` entry

### Requirement: The graph is disclosed only from the active state

The graph SHALL be disclosed the way the tool surface is: only from where the agent stands. On
every model call of the session's agent the runtime SHALL disclose the active state's **outgoing
transitions and nothing else of the graph** — one line per edge carrying the target's slug, its
declared `type` when not `none`, and its `description` (see the `workflow-spec` capability).
Beyond the target's slug and the markers below, the description SHALL be the only thing the agent
is told about an edge. A state's lone **undescribed** edge, which the schema admits only as an
agent state's single edge into another agent state, SHALL be introduced instead as the only way
out of the state, with no condition of its own: to be taken with `archmax_advance` as soon as the
state's instructions are done, without asking anyone whether to move on. Its line SHALL carry the
target's slug and markers and nothing else. No other state's `title`, `summary`,
`instructions`, `model`, `script`, `triggers`, `budget`, `requires` or transitions SHALL reach any
model call of the session's agent, no state the active state has no edge to SHALL be named, and
neither SHALL a count of the states. So a state the agent cannot advance to is a state it cannot
name, and a grader's criteria never reach the work it judges. What a grader's own model calls are
told is specified by the `automated-states` capability.

An edge's line SHALL mark a target that is a **human decision node**, a **grader** state, a
**code** state or a **terminal** state, because each changes what the call itself must carry or
what follows it — evidence may be attached only when advancing to a human state, a grader or code
state runs on its own and may send the session straight back with a note saying what to change, and
a human or terminal target means the agent stops rather than continues. Nothing further about the
target SHALL be rendered: the marker discloses the consequence of taking the edge, not the state on
the other side of it.

The active state's own markers SHALL be disclosed in the same block: that it is terminal. The
trigger signature SHALL be disclosed for the **run's own trigger only** — the `requires` it was
started with and the `returns` it must set before it completes — never for the triggers of states
this run did not enter.

A reply-only turn SHALL be disclosed no transitions at all, because it cannot move the session.

#### Scenario: Only the active state's edges are disclosed

- **WHEN** a workflow declares states `triage`, `refund-review`, `escalate` and `closed`, and the
  session is in `triage` with one transition to `refund-review`
- **THEN** the model call names `refund-review` and its description, and the prompt contains
  neither `escalate` nor `closed` anywhere

#### Scenario: A description is what the agent routes on

- **WHEN** the active state declares `- to: refund-review, description: "Refunds over $50."`
- **THEN** the disclosed line carries that description verbatim, and carries nothing of
  `refund-review`'s own `title`, `summary` or `instructions`

#### Scenario: A lone undescribed edge is taken once the state's work is done

- **WHEN** the active state `draft` declares `instructions` and its single transition
  `- to: send` with no description, and `send` is an agent state with a `title` and `instructions`
- **THEN** the disclosed block says the edge has no condition of its own and is to be taken as soon
  as the state's instructions are done, without asking anyone whether to move on, the edge's line
  is ``- to `send` `` with its markers, and nothing of `send`'s `title` or `instructions` appears

#### Scenario: A human target is marked, and only that

- **WHEN** a transition's target is a `type: human` state with `instructions`,
  `approvers` and three transitions of its own
- **THEN** the edge is marked as leading to a human decision node, and none of that state's
  `instructions`, `approvers` or transitions appear in the prompt

#### Scenario: An automated target's declaration is not disclosed

- **WHEN** a transition's target is a grader state with `instructions` and a `model`, and another
  transition's target is a code state with a `script`
- **THEN** each edge's line carries the target's slug, the marker `grader` or `code`, and the edge's
  description, and no model call of the session's agent carries the grader's `instructions` or
  `model`, or the code state's `script` path

#### Scenario: A terminal target is marked

- **WHEN** a transition's target declares no transitions of its own
- **THEN** the edge is marked terminal, so the agent finishes the work before advancing rather
  than advancing and expecting another turn

#### Scenario: The active state's terminality is stated, not inferred

- **WHEN** the active state declares no transitions
- **THEN** the block states that the state is terminal and no transition leads out of it, rather
  than leaving the agent to infer it from an absent list, and `archmax_advance` is not disclosed

#### Scenario: Only the run's own trigger signature is disclosed

- **WHEN** a workflow declares triggers `manual` and `inbound-email` on two different states and
  the session was started by `manual`
- **THEN** the block carries `manual`'s `requires` and `returns` and never mentions
  `inbound-email` or the state it enters

#### Scenario: A parked session is disclosed no edges

- **WHEN** a session parked at a human state is handed a reply and spends its reply-only model call
- **THEN** no transition is disclosed, because a reply-only turn cannot move the session

### Requirement: A script's tool calls are governed against the state it runs for

Every `tools.*` call a script makes SHALL run through the same `decide` pipeline as a model call,
via one gateway that wraps the script's tool surface and reads the live state per call. Every such
call SHALL be `script`-origin and SHALL be governed as a model call in the state the script runs
for: code from `archmax_eval` or `archmax_run` in the active state, and a code state's script in
that code state (see the `automated-states` capability). It is bound by that state's allow and
forbid lists, its skill and mount grants, the workflow-wide denials (its own workflow's and every
ancestor's), the consumer's rules and every safety rule. No script SHALL run on runtime authority,
and no grant of another state SHALL count for it.

A script's `tools` SHALL expose exactly its state's surface: `tools.<name>` for a tool outside it
SHALL be `undefined`, as the tool is absent from the listing, rather than a function governance then
refuses. The kernel SHALL still decide every call that is made, so the two gates stay independent.
A refused call SHALL throw a catchable `PtcGovernanceError` carrying the tool, rule id and reason,
and the tool SHALL never run; declarative mocks SHALL be consulted only after governance permits.

The kernel SHALL own the set of tools excluded from an agent script's surface — the control tools
(`archmax_get_history` among them), both sandbox tools, and bare `eval` — consumed by the sandbox
tool selection, even for an explicit allow-list; agent scripts read variables through
`args.variables`. A code state's script SHALL be offered no sandbox tool and no bare `eval`, and
SHALL be offered its own state's control tools as the runtime builds them for that state (see the
`automated-states` capability). A delegation tool SHALL NOT be excluded: a script reaches
`archmax_workflow_<slug>` exactly as any tool the state grants.

#### Scenario: Script bound by the state

- **WHEN** a state declares `{ tool: write_file, paths: ["output/**"] }` and `archmax_eval` code
  calls `tools.writeFile` on `notes/x.md`
- **THEN** the call is refused with the verdict a model-initiated `write_file` would receive

#### Scenario: A tool outside the surface is undefined

- **WHEN** state `route` declares `tools: { forbid: [write_file] }` and does not grant the host tool
  `send_email`, which another state grants, and `archmax_eval` code in `route` reads
  `tools.writeFile` and `tools.send_email`
- **THEN** both are `undefined`, and neither name appears in `Object.keys(tools)`

#### Scenario: An agent script is offered no control tool

- **WHEN** `archmax_eval` code in any state lists `Object.keys(tools)`
- **THEN** no control tool appears, `archmax_get_history` included, and neither sandbox tool does

#### Scenario: A code state's script meets the safety rules

- **WHEN** a code state's script calls `tools.writeFile` on a read-only mount path
- **THEN** the call throws a `PtcGovernanceError` with `zone.read-only`, and nothing is written

#### Scenario: A code state's own denial binds its script

- **WHEN** code state `route` declares `tools: { forbid: [{ tool: read_file, paths: [secrets/**] }] }`
  and its script calls `tools.readFile("secrets/a.txt")`
- **THEN** the call throws a `PtcGovernanceError` with `tool.forbidden-here`, while a read
  elsewhere the state permits runs

### Requirement: The authoring backend is never served inside a session

The runtime SHALL read `workflows/` (specs, `WORKFLOW.md`, code-state scripts, cases) through the
authoring backend — `authoring` at assembly, else the custom `backend`, else a `FilesystemBackend`
over the workspace root — and that prefix SHALL have no route in the agent's workspace composite: a
file tool call on it resolves in the session's own folder, finds no authored content, receives no
governance message, and the root listing shows no entry. A mount table declaring the prefix as a
key SHALL fail assembly with `MountCollisionError` naming the prefix, what it holds and the
`authoring` option; a writable mount served by the same backend as the authoring backend SHALL fail
assembly with `AuthoringBackendExposedError`. A `script`- or `runtime`-origin call whose path
canonicalizes under the prefix SHALL be blocked with `zone.governance-plane`, naming the tool, path
and prefix, in every state whatever it allows.

The set of authoring prefixes SHALL remain a set, though it now holds one member: the classification
is the contract and its cardinality is incidental. Of the machine, the agent SHALL know what the
prompt renders and nothing else. Of an automated state, that is at most its slug: as the target of
an edge out of the active state, or as the state a runtime note names. It SHALL never be a grader's
`instructions` or `model`, nor a code state's `script` path or source, and no tool SHALL read
either.

#### Scenario: Spec unreadable by the model

- **WHEN** the model calls `read_file` on `workflows/order-lookup/workflow.yaml`
- **THEN** no authored content is returned and the result reports the file as absent, with no governance message

#### Scenario: Mounting the prefix is refused

- **WHEN** a consumer supplies a mount at `/workflows/`
- **THEN** assembly throws `MountCollisionError` naming specs, code-state scripts and cases, and the `authoring` option

#### Scenario: A former prefix is ordinary content

- **WHEN** a consumer supplies a mount at `/subagents/`
- **THEN** the mount is accepted and served as ordinary agent-visible content, because no part of the
  runtime reads that prefix

#### Scenario: A code state's script reads the authoring prefix

- **WHEN** a code state's script calls `tools.readFile("workflows/other/workflow.yaml")` or
  `tools.readFile("workflows/order-lookup/scripts/check-refund.js")`
- **THEN** both calls fail with `zone.governance-plane` and a reason naming `workflows/`

### Requirement: Skill-bundle scripts and code-state scripts have disjoint executors

Code-state scripts SHALL live at `workflows/<slug>/scripts/<file>.js|.mjs`, declared
workflow-relative on the code state (`script: scripts/check-refund.js`). The schema SHALL reject a
path outside `scripts/`, with a `..` segment, or absolute. The runtime SHALL resolve the declared
path with the same confinement, and an unresolvable script SHALL fail the code state closed (see
the `automated-states` capability). Code-state scripts SHALL be read through the authoring backend
and run only by the runtime, when a session enters their code state; no tool SHALL run one.

Scripts the model runs with `archmax_run` SHALL be read through the agent workspace and SHALL be
confined by the safety rule `script.skill-only` to paths inside a bundle of the resolved skill
registry — classified through the registry's prefixes, not a literal `skills/` — so an empty
registry blocks every `archmax_run`, and no path under a workflow's `scripts/` is ever runnable by
`archmax_run`. A state entry MAY narrow execution within the bundles and SHALL NOT extend it.
`archmax_eval` SHALL be unaffected by this rule.

#### Scenario: A code state's script runs from its workflow directory

- **WHEN** a code state declares `script: scripts/check-refund.js`
- **THEN** the runtime reads `workflows/<slug>/scripts/check-refund.js` from the authoring backend
  and runs it when a session enters the state

#### Scenario: Agent cannot run a code-state script or a scratchpad file

- **WHEN** the model calls `archmax_run` on `workflows/order-lookup/scripts/screen-request.js` or on `scratchpad/x.js`
- **THEN** the call is blocked with `script.skill-only` and the file is never read
