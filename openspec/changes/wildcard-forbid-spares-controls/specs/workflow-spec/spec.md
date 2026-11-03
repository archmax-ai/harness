## MODIFIED Requirements

### Requirement: Allow entries and the tools blocks

An entry in any of the four tools lists SHALL be a tool name string or a mapping. The lists are
`tools.allow` and `tools.forbid` on a state, `tools.allow_always` and `tools.forbid_always` at the
root, and an entry's mapping form is
`{ tool, args?, paths?, connection?, source? }`: `args` maps an argument name (dotted paths
allowed) to a glob or list of globs — the entry's **argument guards** — and `paths` is
shorthand for `args: { file_path: … }`. `connection` and `source` are free-form strings the
runtime preserves and does not read. In a **forbid** entry only, the tool MAY be `*`, meaning every
tool except the active state type's control tools (see the `governance` capability, "Workflow and
state denials"): `{ tool: "*", paths: [logs/**] }` denies every such tool on those globs, a control
is denied only by an entry naming it, and `*` in an `allow`
entry SHALL be a document-level error, since a wildcard grant is not a thing this governance has.

`tools.allow_always` SHALL be the workflow-wide grant when it is declared, an empty list included:
the tools it lists, with their guards, in every state, and nothing else. When the key is absent, the
workflow-wide grant SHALL be the **default tools** (`ls`, `read_file`, `write_file`, `edit_file`,
`glob`, `grep`, `copy_file`, `move_file`, `remove_file`, `write_todos`, `archmax_eval`,
`archmax_run`), unconstrained. A declared list SHALL replace the default tools, never add to them.
A state with no `tools` block permits the workflow-wide grant only. A state entry naming a tool the
workflow grants narrows it there (`{ tool: archmax_run, paths: [skills/x/scripts/**] }`), and a state
entry naming a default tool that a declared `allow_always` omits grants it in that state. A default
tool listed in `allow_always`, bare or guarded, SHALL be an ordinary grant and draw no warning. In
a grader or code state the workflow-wide grant SHALL leave out the tools that state type withholds
(`STATE_TYPE_TOOLS[type].withheld`: `write_todos`, `archmax_eval`, `archmax_run`, `archmax_wait`
and `archmax_reset`), whether they arrive as default tools or are listed in a declared
`allow_always` (see the `governance` capability).

A workflow that declares `tools.allow_always` and names none of the default tools there or in any
state's `tools.allow` SHALL draw one lint warning. The warning SHALL name the default tools and say
that a declared `allow_always` replaces them.

**Denial and grant compose by one rule: deny beats allow, and no narrower level widens a denial.**
`tools.forbid_always` SHALL block its entries in every state, ahead of every grant, consumer rule
and argument guard. A state's `tools.forbid` SHALL block its entries in that state, subtracting from
every grant that would otherwise reach it — the workflow-wide grant, the state's own `allow`, and
the host's always-on tools alike. These four lists SHALL be the whole of tool governance: there
SHALL be no `policy` block, and no other key SHALL grant or deny a tool.

Every `${{…}}` reference in a guard SHALL be structurally valid — `${{name}}` or `${{name.path}}`
with a valid variable name and no empty segment — as a document-level error. See the `governance`
capability for enforcement.

#### Scenario: Malformed guard reference

- **WHEN** a guard glob contains `${{}}`, `${{ .id }}` or `${{From-Email}}`
- **THEN** loading fails naming the entry's key path and the required form, and no path segment
  beyond the name is checked

#### Scenario: Scratchpad-only narrowing

- **WHEN** a state allows `write_file` with `file_path: [scratchpad/refund.json]` and nothing
  else, or `tools.allow_always` lists the same entry
- **THEN** the lint warns, at the entry's key path, that `scratchpad/**` writes are permitted
  wherever the tool is granted, so the entry does not constrain where inside `scratchpad/` the write
  lands

#### Scenario: A state's forbid beats the workflow's grant

- **WHEN** the root declares `tools: { allow_always: [write_file] }` and state `route` declares
  `tools: { forbid: [write_file] }`
- **THEN** `write_file` is blocked in `route`, is not disclosed there, and is still granted in every
  other state

#### Scenario: A wildcard forbid denies a path to every tool

- **WHEN** the root declares `tools: { forbid_always: [{ tool: "*", paths: [logs/**] }] }`
- **THEN** every tool is blocked on a path under `logs/`, reads included, in every state — and a
  wildcard in an `allow` entry is a load error

#### Scenario: A state cannot widen a workflow denial

- **WHEN** the root declares `tools: { forbid_always: [send_email] }` and a state declares
  `tools: { allow: [send_email] }`
- **THEN** the call is blocked in that state, and `validate` reports that the allow entry grants
  nothing

#### Scenario: Absent allow_always grants the default tools

- **WHEN** the root declares `tools: { forbid_always: [archmax_reset] }` and no `allow_always`
- **THEN** every state is granted the default tools, unconstrained, and the lint reports nothing
  about them

#### Scenario: A default tool listed in allow_always is a grant, not a warning

- **WHEN** the root declares `tools: { allow_always: [read_file, { tool: write_file, paths: ["reports/**"] }] }`
- **THEN** `archmax validate` reports no warning for either entry, `read_file` is granted in every
  state, and `write_file` is granted in every state on `reports/**` only (and in `scratchpad/`)

#### Scenario: A declared allow_always that grants no default tool

- **WHEN** the root declares `tools: { allow_always: [] }` and no state's `tools.allow` names a
  default tool
- **THEN** the lint warns once at `tools.allow_always`, naming the default tools and saying that a
  declared list replaces them — and it does not warn once any state's `tools.allow` or the root list
  names one of them
