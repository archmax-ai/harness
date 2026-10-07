## MODIFIED Requirements

### Requirement: The tool surface is allow-only and closed by default

A state SHALL permit only: the always-on tools — the file tools (`ls`, `read_file`, `write_file`,
`edit_file`, `glob`, `grep`) and the runtime's file operations (`copy_file`, `move_file`,
`remove_file`), `write_todos`, the sandbox tools (`archmax_eval`, `archmax_run`), and any name the
consumer passes as `essentialTools` —
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

#### Scenario: The file operations need no grant and close by name

- **WHEN** a state with no `tools` block is entered, and another state's `tools.forbid` names `copy_file`
- **THEN** `copy_file`, `move_file` and `remove_file` are disclosed in the first, and in the second
  `copy_file` is neither disclosed nor callable (`tool.forbidden-here`) while the other two are

### Requirement: Allow entry shapes and argument guards

An entry in `tools.allow` or `tools.allow_always` SHALL be a bare tool name (any arguments),
`{ tool, args: { <param>: [globs] } }` matching each named parameter (dotted keys read nested
arguments), or `{ tool, paths: [...] }`, which guards **every path argument the tool declares**
(see "Tools declare their path arguments"): a grant admits a call only when each declared path the
call names matches one of the globs, and a declared path the call omits matches nothing. For a tool
that declares no path argument, `paths:` SHALL guard `file_path`. An entry without `args`/`paths`
SHALL match any arguments. An argument value SHALL be canonicalized (leading slashes stripped, `.`
and empty segments dropped, `..` applied) before it is matched, so a `./` or `..` spelling cannot
dodge a guard.

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
areas SHALL admit a `read` or `list` path without an `allow` entry (`tool.offload-read`) and never a
`write` or `remove` path (`zone.runtime-managed`). `scratchpad/` SHALL admit a `read`, `list`,
`write` or `remove` path in every state without an `allow` entry (`tool.scratchpad`), evaluated ahead
of the per-state default, when every path the call names is so admitted; so an `allow` entry naming a
path inside `scratchpad/` SHALL NOT narrow where inside it a write lands, and a call naming a path
outside the open areas SHALL be decided by the state's entries. Any other session-root path SHALL be
matched against the state's entries unchanged. Every block message SHALL point at `scratchpad/` and
name no second working area.

#### Scenario: Scratchpad open under a narrowing entry

- **WHEN** a state declares `{ tool: write_file, paths: ["output/**"] }` and the model writes `scratchpad/work.md`
- **THEN** the write is permitted with `tool.scratchpad`

#### Scenario: File operations inside the scratchpad need no grant

- **WHEN** the model copies, moves and removes files inside `scratchpad/` in any state
- **THEN** each call is permitted with `tool.scratchpad`

## ADDED Requirements

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

Every path rule SHALL evaluate every declared path a call names, with its access: the read-only zone
and the runtime-managed areas refuse `write` and `remove`; the runtime-internal areas, a skill bundle
the state does not enable, and a governed mount the state was not given refuse every access; a mount
narrowed to `access: read` refuses `write` and `remove` (`mount.read-only`); an inherited mount or
skill denial refuses every access; `script.skill-only` confines `execute`; and the authoring-plane
rule reads them for scripts and hooks. A call SHALL be refused when any one of its paths is, and for a
tool declaring several, the refusal SHALL name the argument (`'copy_file' on 'x' (destination)`). A
`paths:` guard in a forbid entry SHALL match a call when **any** declared path it names matches, so
`{ tool: "*", paths: [secrets/**] }` refuses a copy out of `secrets/` and a copy into it. The kernel,
`validate`'s probes and the sandbox's governed tool bridge SHALL read the same table, so a script's
call is governed by its declared paths exactly as the model's is.

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
