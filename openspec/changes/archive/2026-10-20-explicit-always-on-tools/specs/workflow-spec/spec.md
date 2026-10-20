## MODIFIED Requirements

### Requirement: Allow entries and the tools blocks

An entry in any of the four tools lists SHALL be a tool name string or a mapping. The lists are
`tools.allow` and `tools.forbid` on a state, `tools.allow_always` and `tools.forbid_always` at the
root, and an entry's mapping form is
`{ tool, args?, paths?, connection?, source? }`: `args` maps an argument name (dotted paths
allowed) to a glob or list of globs — the entry's **argument guards** — and `paths` is
shorthand for `args: { file_path: … }`. `connection` and `source` are free-form strings the
runtime preserves and does not read. In a **forbid** entry only, the tool MAY be `*`, meaning every
tool: `{ tool: "*", paths: [logs/**] }` denies every tool on those globs, and `*` in an `allow`
entry SHALL be a document-level error, since a wildcard grant is not a thing this governance has.

`tools.allow_always` SHALL be the workflow-wide grant when it is declared, an empty list included:
the tools it lists, with their guards, in every state, and nothing else. When the key is absent, the
workflow-wide grant SHALL be the **default tools** (`ls`, `read_file`, `write_file`, `edit_file`,
`glob`, `grep`, `copy_file`, `move_file`, `remove_file`, `write_todos`, `archmax_eval`,
`archmax_run`), unconstrained. A declared list SHALL replace the default tools, never add to them.
A state with no `tools` block permits the workflow-wide grant only. A state entry naming a tool the
workflow grants narrows it there (`{ tool: archmax_run, paths: [skills/x/scripts/**] }`), and a state
entry naming a default tool that a declared `allow_always` omits grants it in that state. A default
tool listed in `allow_always`, bare or guarded, SHALL be an ordinary grant and draw no warning.

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

### Requirement: Skills blocks

Every skills list SHALL contain skill slugs only — bundle directory names in kebab-case, never
paths or globs. The lists are `skills.allow_always` and `skills.forbid_always` at the root, and
`skills.allow` and `skills.forbid` on a state. There SHALL be exactly one skills model: a root
`skills.allow` is an unrecognized-key load error, and no list is a ceiling over another.

`skills.allow_always` SHALL enable its slugs in **every** state of the workflow, and a state's
`skills.allow` SHALL **add to** it — the enabled set of a state is the union of the state's own list
and the root's always-on list, in that order, mirroring `tools.allow` composing with
`tools.allow_always`. A state's list is itself a grant.

Denial mirrors the grant, and beats it. `skills.forbid_always` SHALL put its slugs out of reach of
the whole workflow: no state enables one, whatever any list names. A state's `skills.forbid` SHALL
remove its slugs from that state's enabled set, subtracting from the workflow's `allow_always` and
from the state's own `allow` alike. Both SHALL resolve through the one enabled-set resolution the
runtime uses, so the kernel's skill rule, prompt disclosure and the `archmax_run` listing redaction
follow without a second answer; a refusal caused by a forbid SHALL say so rather than report the
slug as merely not enabled.

An absent list SHALL mean the same as an empty list at every level, so no skill is ever enabled
without a list naming it, matching `tools.allow`, where a state without a list gets the workflow-wide
grant only. An empty `allow` SHALL NOT act as a denial.

`archmax validate` SHALL report a slug no source provides (error, naming the known slugs) under
every key, and:

- a slug named both in the root's `allow_always` and in a state's `allow` SHALL be a warning (the
  state entry grants nothing the workflow had not already given);
- a state's `allow: []` beside a non-empty `allow_always` SHALL be a warning that an empty state
  list subtracts nothing and that `skills.forbid` is what subtracts;
- a `forbid` entry for a slug nothing would have enabled where it applies SHALL be a warning that
  the entry governs nothing;
- a `forbid_always` slug that some list also grants SHALL be a warning that the grant reaches
  nothing;
- for a spec with no root `skills` block at all in a workspace that serves bundles: one warning that
  the workflow can reach none of them (naming them), pointing at `skills.allow_always` as the key to
  add; any root `skills` block SHALL silence it — `allow_always: []` included — since the spec has
  then stated its workflow-wide grant deliberately.

All SHALL use the same registry and enabled-set resolution the runtime uses.

#### Scenario: Path-shaped entry rejected

- **WHEN** a state declares `skills: { allow: ["skills/order-data/**"] }`, or the root declares
  `skills: { forbid_always: ["skills/order-data/**"] }`
- **THEN** loading fails stating that entries are skill slugs, not paths or globs

#### Scenario: The retired ceiling is a load error

- **WHEN** a spec declares a root `skills: { allow: [order-data] }`
- **THEN** loading fails naming the unrecognized key; the identical resolution is
  `skills: { allow_always: [] }` with the state lists the ceiling stood over

#### Scenario: An always-on grant reaches a state that names nothing

- **WHEN** the root declares `skills: { allow_always: [order-data] }` and state `lookup` declares no
  `skills` block
- **THEN** `order-data` is enabled in `lookup`, and `validate` reports no warning about either

#### Scenario: An empty always-on list makes state lists the grant

- **WHEN** the root declares `skills: { allow_always: [] }` and state `read` declares
  `skills: { allow: [order-data] }`
- **THEN** `read` enables `order-data` and `validate` reports no error: a state's list is a grant,
  and there is no ceiling to climb past

#### Scenario: A state's forbid subtracts from the workflow's grant

- **WHEN** the root declares `skills: { allow_always: [order-data] }` and state `route` declares
  `skills: { forbid: [order-data] }`
- **THEN** `order-data` is not enabled in `route`: a read inside the bundle is refused with a reason
  saying the state forbids it, the slug is absent from that state's prompt, and `ls skills/` there
  does not list it — while every other state still has it

#### Scenario: An empty state list subtracts nothing, and the diagnostic says what does

- **WHEN** the root declares `skills: { allow_always: [order-data] }` and state `route` declares
  `skills: { allow: [] }`
- **THEN** `order-data` is still enabled in `route`, and `validate` warns that an empty state list
  subtracts nothing and that `skills: { forbid: [order-data] }` is what removes it

#### Scenario: A workflow-wide skill denial binds every state

- **WHEN** the root declares `skills: { allow_always: [order-data], forbid_always: [order-data] }`,
  or a state names a slug the root forbids
- **THEN** no state enables it, the deny winning in both spellings, and `validate` warns that the
  grant reaches nothing

#### Scenario: A state adds to the always-on grant

- **WHEN** the root declares `skills: { allow_always: [order-data] }` and state `review` declares
  `skills: { allow: [refund-policy] }`
- **THEN** `review` enables both, the state's own slug first, and no other state enables
  `refund-policy`

#### Scenario: Naming a slug at both levels is inert

- **WHEN** the root declares `skills: { allow_always: [order-data] }` and a state declares
  `skills: { allow: [order-data] }`
- **THEN** the state enables `order-data` once and `validate` warns that the state entry grants
  nothing the workflow had not already given

#### Scenario: Absent block enables nothing

- **WHEN** a workflow declares no root `skills` block, or a state declares no `skills` block while
  the root grants nothing always-on
- **THEN** the state's enabled set is empty — the spec loads without error and the skill is simply
  not enabled there

#### Scenario: A workflow that can reach no bundle is told once

- **WHEN** the sources provide `order-data` and `refund-policy` and the spec declares no root
  `skills` block
- **THEN** `archmax validate` reports one warning naming both bundles as unreachable from this
  workflow and naming `skills.allow_always` as the key to add — and reports none at all when the
  spec declares any root `skills` block, `allow_always: []` included

#### Scenario: One workflow is not warned about another's bundles

- **WHEN** a workspace serves `order-data`, `refund-policy` and `order-enrichment`, and a workflow
  declares `skills: { allow_always: [order-data] }`
- **THEN** `archmax validate` reports no skills warning: the registry is workspace-wide while
  enablement is per workflow
