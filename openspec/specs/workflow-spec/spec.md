# workflow-spec Specification

## Purpose

Define `workflow.yaml` — the declarative spec a workflow is authored in — and what
The archmax harness does with it: the two files of a workflow, the one strict schema every key is held
to, the cross-references the runtime cannot run without, the advisories `archmax validate`
adds, how triggers wire sessions into start states, how session variables are named,
seeded, referenced and gated, and how a trigger's `requires`/`returns` signature holds at a
session's boundary and across a sub-workflow call.

## Requirements

### Requirement: A workflow is two files, and only one of them is the spec

A workflow SHALL be authored under `workflows/<slug>/` as `workflow.yaml` — a pure YAML
mapping that is the sole machine source, read through the authoring backend — plus an
optional `WORKFLOW.md` holding plain Markdown prose that the runtime appends to the system
prompt after the graph section it renders from the spec. `WORKFLOW.md` SHALL never be a
machine source: a YAML frontmatter block in it beside `workflow.yaml` is a load error of kind
`competing-machines`. A missing `workflow.yaml` is a `missing` load issue; one that does not
parse to a YAML mapping is `not-a-mapping`. Loading SHALL be implemented once
(`loadMachineSpec`) and shared by assembly and `archmax validate`, so both report the same
problem for the same file. `createAgent` SHALL fail closed with `WorkflowLoadError` when the
named workflow has no usable spec, rather than running an ungoverned agent.

#### Scenario: Prose is appended, not parsed

- **WHEN** a workflow directory holds a valid `workflow.yaml` and a prose-only `WORKFLOW.md`
- **THEN** the machine is built from `workflow.yaml` alone and the prose is appended to the
  system prompt after the rendered graph section

#### Scenario: Frontmatter beside the spec is an error

- **WHEN** `WORKFLOW.md` begins with a `---`-delimited frontmatter block next to `workflow.yaml`
- **THEN** loading reports a `competing-machines` error naming both files and directing the
  author to remove the frontmatter, the spec is unusable, and `archmax validate` reports the
  same error against `WORKFLOW.md`

#### Scenario: Missing or malformed spec fails assembly closed

- **WHEN** `workflow.yaml` is absent, or exists but is not a YAML mapping
- **THEN** `createAgent` throws `WorkflowLoadError` naming the workflow and the path, and
  `archmax validate` reports an error for the same reason

### Requirement: One strict schema defines the spec

`workflow.yaml` SHALL be defined by a single Zod schema (`src/machine/spec-schema.ts`) from
which the exported TypeScript types are inferred. Every object in it SHALL be strict except
the documented loose slots (a `states.<slug>.triggers.<id>` declaration, and `metadata` at the
root, on a state and on a rubric): an unrecognized
key at any level is a load error naming the key and its dotted path
(`states.review.transtions`). Document-level rules (`refineSpec`) SHALL run only once the
shape holds, and the same `parseMachineSpec` SHALL back loading and `archmax validate`, so a
spec that validates cleanly loads and a spec that fails to load fails `validate` with the same
message. When the shape holds but a document-level rule fails, the typed spec SHALL still be
handed to the lint so one dangling target does not hide every advisory behind it. The machine
SHALL expose a stable content hash of the governing spec — every key except `metadata` at any
of its positions,
serialized with sorted object keys and ordered arrays — written into a session's first
checkpoint and its `_specs/<hash>.json` snapshot; any governing edit changes it, including an
edit to a rubric, and a cosmetic one (key order, whitespace, `metadata`) does not.

A retired key SHALL be diagnosed as exactly what it is — an unrecognized key at its path — with
no mapping to its replacement. The schema carries no memory of a former spelling, so `editor`,
`max_corrections`, a root `name`, a root `triggers`, a state's `trigger`, and
`{ subagent: … }` are reported the way a typo is.

#### Scenario: A misspelled key is caught with its path

- **WHEN** a state declares `transtions:` or a spec declares `tools: { allows: [] }`
- **THEN** loading fails with an error naming the unrecognized key and its path, and
  `archmax validate` reports the identical diagnostic

#### Scenario: A retired key is caught the same way

- **WHEN** a spec declares `editor:`, a root `name:`, a root `triggers:`, a state's `trigger:`,
  or `max_corrections` on a hook or a rubric
- **THEN** loading fails with the same unrecognized-key diagnostic naming the key and its path,
  carrying no suggestion of a replacement

#### Scenario: Structural checks are not hand-written

- **WHEN** a value has the wrong type, a required field is missing, or an enum member is unknown
- **THEN** the diagnostic comes from the schema, addressed by key path, in `validate` and at
  load alike

### Requirement: Root keys

The spec root SHALL accept exactly: `title` (string, a human label — the workflow's identity
is its directory slug), `instructions` (non-empty string of standing guidance rendered into
the system prompt for the whole session), `disabled` (boolean), `runtime`,
`settings`, `tools` (`allow_always`, `forbid_always`), `skills` (`allow_always`, `forbid_always`),
`mounts` (`allow_always`, `forbid_always`), `tests`, `extensions`,
`metadata`, and `states` — a mapping of state slug to state, which SHALL be present and
non-empty. A spec with no `instructions` SHALL load with a lint warning that the workflow
ships no standing guidance. There SHALL be no root `triggers`: a trigger is declared on the
state it enters.

#### Scenario: Empty states rejected

- **WHEN** a spec declares no `states`, or `states: {}`
- **THEN** loading fails with "Machine spec is missing or has empty 'states'"

#### Scenario: metadata is a recognized root key, rubrics and triggers are not

- **WHEN** a spec declares `metadata:` at the root
- **THEN** it is accepted, and a misspelling (`metadatas:`) is a load error naming the key and its
  path

- **WHEN** a spec declares `rubrics:` or `triggers:` at the root
- **THEN** loading fails naming the unrecognized key: a rubric is declared on the hook that applies
  it and a trigger on the state it enters, neither as a first-order item

#### Scenario: The root governance blocks accept their own keys and no others

- **WHEN** a spec declares `tools: { allow_always: [...], forbid_always: [...] }`,
  `skills: { allow_always: [...], forbid_always: [...] }` and
  `mounts: { allow_always: [...], forbid_always: [...] }`
- **THEN** each loads under the strict schema, while a state-level key at the root
  (`tools: { allow: [...] }`, `skills: { forbid: [...] }`, `mounts: { allow: [...] }`) is a load
  error naming the key and its path

#### Scenario: The retired governance spellings are load errors

- **WHEN** a spec declares a root `policy:` block, or a root `skills: { allow: [...] }`
- **THEN** loading fails naming the unrecognized key and its path, as every retired spelling in this
  schema does — denial is declared beside the grant it overrides (`tools.forbid_always`,
  `skills.forbid_always`), and there is one skills model rather than a ceiling and a grant

### Requirement: State keys

Each state SHALL accept exactly: `type` (`agent`, the default, or `human`), `title`
(non-empty string), `instructions`, `summary` (a one-line authoring and host label, rendered
into no part of the prompt), `evidence` (list of paths),
`approvers` (list of strings, presented to a reviewer and otherwise uninterpreted),
`triggers`, `before`, `after`, `budget`, `model` (a non-empty model id this state's turns run
on), `on_error` (a state slug), `tools` (`allow`, `forbid`),
`skills` (`allow`, `forbid`), `mounts` (`allow`, `forbid`), `requires` (list of variable names),
`metadata` (the loose, runtime-inert host slot), and `transitions`. A bare `done:` (YAML
`null`) SHALL be read as an empty state — terminal, `agent`, always-on tools only.

#### Scenario: Unknown state type

- **WHEN** a state declares `type: wait` or `type: workflow`
- **THEN** loading fails naming the type and the two accepted kinds, `agent` and `human`

#### Scenario: A state's metadata is accepted and inert

- **WHEN** a state declares `metadata: { x: 120, y: 340 }`
- **THEN** it loads clean, the block survives on the parsed state, no part of it is rendered into
  the prompt, and it takes no part in governance, routing or the spec hash

#### Scenario: A state's summary reaches no model call

- **WHEN** two workflows differ only in that one declares `summary` on every state and the other
  declares none
- **THEN** every model call of both sees byte-identical prompt text, and the summaries survive on
  the parsed spec for hosts and authors to read

#### Scenario: A state's governance blocks accept their own keys and no others

- **WHEN** a state declares `tools: { allow: [...], forbid: [...] }`,
  `skills: { allow: [...], forbid: [...] }` and `mounts: { allow: [...], forbid: [...] }`
- **THEN** each loads under the strict schema, while a root-level key on a state
  (`tools: { allow_always: [...] }`, `skills: { forbid_always: [...] }`,
  `mounts: { allow_always: [...] }`) is a load error naming the key and its path

#### Scenario: A state's mounts block is part of the machine

- **WHEN** two specs differ only in one state's `mounts.allow`
- **THEN** their spec hashes differ, and a session pinned to one keeps its mount governance when
  the other is published

#### Scenario: A state's model is an id string

- **WHEN** a state declares `model: small-model`
- **THEN** it loads clean and the id survives on the parsed state, while `model: ""` and
  `model: 3` are load errors naming `states.<slug>.model`

#### Scenario: A state stays strict otherwise

- **WHEN** a state declares an undefined key that is not `metadata` (for example `position:`)
- **THEN** loading fails naming the key and its path

#### Scenario: Routing context advisory

- **WHEN** a non-human state with several transitions declares no `instructions`
- **THEN** the lint warns, because the agent has nothing telling it how to classify the request
  before it routes

#### Scenario: Singular trigger is not a state key

- **WHEN** a state declares `trigger: chat`
- **THEN** loading fails naming the unrecognized key `states.<slug>.trigger` and its path

### Requirement: Slugs are identity, titles are labels

A state's key in `states` SHALL be its slug — the only token that resolves it, in `to`,
`on_error`, the `to`
the agent passes to `archmax_advance`, events, artifacts and case assertions. A workflow's slug
SHALL be its `workflows/<slug>/` directory name and the CLI argument. A trigger id SHALL be the
key of a `states.<slug>.triggers` entry, and a trigger SHALL have no key of its own anywhere
else in the document. A rubric SHALL have no
slug at all: it is declared inline and identified by position. The rest SHALL take the
shape `^[a-z0-9]+(-[a-z0-9]+)*$` (`SLUG_PATTERN`), enforced by `archmax validate` as an error
(empty key reported as a missing identity, nonconforming key as a shape error); the loader and
the runtime SHALL treat a slug as opaque so a nonconforming slug still runs. A `title` on the
root or a state SHALL be presentational only: never unique, never a routing target, rendered
beside the slug in the graph section and carried in a human state's decision record. A rubric
SHALL have no `title`: nothing routes to one and nothing labels one in the prompt.

Per-node host data SHALL live on the node — a state's own `metadata` — rather than in a
root-level table keyed by state slug, so a renamed state carries its host data with it and no
second reference to the former slug is left behind.

#### Scenario: Title is not a target

- **WHEN** the agent passes a state's `title` as `archmax_advance`'s `to`
- **THEN** the transition is refused as an undeclared target (`transition.no-edge`)

#### Scenario: Nonconforming slugs reported statically

- **WHEN** a spec declares states keyed `Identify Case`, `snake_case` or `double--hyphen`, a
  or the workflow directory is `order_lookup`
- **THEN** `archmax validate` reports an error for each naming the kebab-case shape, and the
  workflow still loads and runs

#### Scenario: Renaming a state carries its host data

- **WHEN** a state's slug is renamed and its `metadata` block moves with it
- **THEN** the spec loads clean and nothing outside that state's mapping refers to the former slug

#### Scenario: A trigger id is a key, never a slug

- **WHEN** a state keyed `intake` declares `triggers: { slack-message: … }`
- **THEN** `slack-message` is a trigger id and `intake` a state slug, and neither the trigger
  nor the declaration carries a key anywhere else in the document

### Requirement: Transitions, terminal states and error routes

A state's `transitions` SHALL be a list of `{ to, description, type? }` where `to` names a
declared state, `description` is a **required non-empty string**, and `type` is one of `approve`,
`reject`, `refine`, `none`. The `description` is the only thing the agent is told about where an
edge leads — no attribute of the target state is disclosed — so a missing, blank or mistyped one
SHALL be a load error addressed to `states.<slug>.transitions.<index>.description`, which names the
edge, stating that the description is what the agent routes on and what to write instead. A state
with no transitions SHALL be terminal: the session completes when the agent finishes there and
`archmax_advance` is not disclosed in it. `on_error`, when declared, SHALL name a declared
state; a state's failure (an exhausted budget, a terminal hook rejection) routes there, and a
state without one ends the session rejected. Transitions carry no preconditions of their own:
an edge is decided only by its existence, the state's `requires`, and the verdicts of the
`after`/`before` hooks.

#### Scenario: Missing description rejected

- **WHEN** a state declares `transitions: [{ to: review }]`, or a `description` that is empty,
  whitespace-only or not a string
- **THEN** loading fails with one error addressed to that transition's `description` field, saying
  what the description is for and what to write instead

#### Scenario: Dangling targets rejected

- **WHEN** a transition's `to` or a state's `on_error` names a state that does not exist
- **THEN** loading fails with an error addressed to that field naming the undefined state

#### Scenario: Advance guard without an edge

- **WHEN** a state's `tools.allow` grants `archmax_advance` with `args: { to: [x] }` and
  declares no transition to `x`
- **THEN** `archmax validate` warns that the runtime will block the transition

### Requirement: Human-state rules are split between schema and lint

A `type: human` state parks the session for a person's decision, so it SHALL declare
`instructions` describing the decision, at least one transition, at most one transition of each
labeled `type` (`approve`/`reject`/`refine`), no transition to itself, and no `before`/`after`
hook (a human state runs no agent turn in which a hook could fire). These SHALL be **lint
errors**: the runtime tolerates them and the spec still loads, while `archmax validate` fails on
them. The shape rules a human state shares with every state — the `type` enum, the transition
`type` enum, an existing `to`, a non-empty transition `description` — remain schema errors, so a
human state's decision button labels are now guaranteed by the schema rather than by lint. The
decision record SHALL be built from the state's `title`, `instructions`, declared `evidence`
(leading, deduplicated with any evidence the advancing call attached) and its transitions'
`to`/`description`/`type`.

#### Scenario: Human state without a button label

- **WHEN** a `type: human` state declares a transition with no `description`
- **THEN** loading fails under the strict schema naming that transition's `description`, the same
  way it does for an agent state

#### Scenario: Hook on a human state

- **WHEN** a `type: human` state declares `after: { rubric: { instructions: … } }`
- **THEN** `archmax validate` reports an error stating the hook can never run and naming the
  agent state it belongs on

### Requirement: Hook shape

A `before` or `after` SHALL be one hook or an ordered list of hooks. A hook SHALL be a
single-key tagged object — `{ script: <path> }`, `{ rubric: <declaration> }`, or
`{ <custom-kind>: <target> }` for an executor registered at assembly through `hookExecutors` —
optionally beside the one sidecar `max_iterations` (integer, at least 0), which bounds
`correct` verdicts on an `after` hook. A `script` path SHALL be workflow-relative, inside
`hooks/`, ending in `.js` or `.mjs`, with no `..` segment (`hooks/check.js` resolves to
`workflows/<slug>/hooks/check.js`); the custom-kind branch SHALL NOT rescue a malformed
built-in. A `before` hook declaring `max_iterations` SHALL be a document-level
error, because `before` hooks are ok/veto only.

A `{ rubric: … }` hook's value SHALL be a **rubric declaration**, not a name: the grader is
declared where it is applied (see the `grading-rubrics` capability). Its `max_iterations` and
`model` live inside that declaration, so the `max_iterations` sidecar SHALL be refused beside a
`rubric` key while remaining accepted beside a `script` or custom kind. No `instructions` sidecar
SHALL be accepted on any hook.

#### Scenario: Confined script path

- **WHEN** a hook declares `{ script: skills/x/scripts/check.js }`, `{ script: /abs/check.js }`
  or `{ script: hooks/../escape.js }`
- **THEN** loading fails naming the required location inside `hooks/`

#### Scenario: Iteration budget on the wrong phase

- **WHEN** a state declares `before: { script: hooks/x.js, max_iterations: 2 }`
- **THEN** loading fails stating that the budget applies to `after` hooks

#### Scenario: A rubric is a declaration, not a reference

- **WHEN** a state declares `after: { rubric: tone-check }` — a name rather than a declaration
- **THEN** loading fails, and `validate` reports the same diagnostic, because there is no named
  rubric to resolve

### Requirement: Budgets

A state's `budget` SHALL accept `maxTurns`, `timeoutMs` and `maxParks`, each a positive
integer when present and unbounded when absent. `maxTurns` counts the state's model turns,
`timeoutMs` bounds a model call in the state, `maxParks` counts the state's `archmax_wait`
parks; exhausting any of them fails the state, which routes through `on_error` when declared
and otherwise rejects the session.

#### Scenario: Non-positive budget rejected

- **WHEN** a state declares `budget: { maxParks: 0 }` or a non-integer value
- **THEN** loading fails with "must be a positive number" addressed to that field

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

A state with no `tools` block permits the always-on tools only. A state entry naming an always-on
tool narrows it (`{ tool: archmax_run, paths: [skills/x/scripts/**] }`); an `allow_always` entry
naming one is inert and SHALL draw a lint warning.

**Denial and grant compose by one rule: deny beats allow, and no narrower level widens a denial.**
`tools.forbid_always` SHALL block its entries in every state, ahead of every grant, consumer rule
and argument guard. A state's `tools.forbid` SHALL block its entries in that state, subtracting from
every grant that would otherwise reach it — the workflow's `allow_always`, the state's own `allow`,
and the always-on surface alike. These four lists SHALL be the whole of tool governance: there SHALL be no `policy` block, and no
other key SHALL grant or deny a tool.

Every `${{…}}` reference in a guard SHALL be structurally valid — `${{name}}` or `${{name.path}}`
with a valid variable name and no empty segment — as a document-level error. See the `governance`
capability for enforcement.

#### Scenario: Malformed guard reference

- **WHEN** a guard glob contains `${{}}`, `${{ .id }}` or `${{From-Email}}`
- **THEN** loading fails naming the entry's key path and the required form, and no path segment
  beyond the name is checked

#### Scenario: Scratchpad-only narrowing

- **WHEN** a state allows `write_file` with `file_path: [scratchpad/refund.json]` and nothing
  else
- **THEN** the lint warns that `scratchpad/**` writes are permitted in every state, so the
  entry governs nothing

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
without a list naming it, matching `tools.allow`, where a state without a list gets the essential
surface only. An empty `allow` SHALL NOT act as a denial.

`archmax validate` SHALL report a slug no source provides (error, naming the known slugs) under
every key, and:

- a slug named both in the root's `allow_always` and in a state's `allow` SHALL be a warning (the
  state entry grants nothing the workflow had not already given — the skills analogue of an inert
  `tools.allow_always` entry);
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

### Requirement: Mounts blocks

Every mounts list SHALL name mounts only — the keys of the host's mount table with their
slashes stripped (`reference`, `catalogs/eu`, `AGENTS.md`), never globs. A **grant** entry
(`mounts.allow_always`, `mounts.allow`) SHALL accept either a bare name or
`{ mount: <name>, access: read | read_write }`; a **denial** entry (`mounts.forbid_always`,
`mounts.forbid`) SHALL accept a name only, since a denial is total and has no access to
qualify. The lists are `mounts.allow_always` and `mounts.forbid_always` at the root, and
`mounts.allow` and `mounts.forbid` on a state. There SHALL be exactly one mounts model, the
model `skills` uses: a root `mounts.allow` is an unrecognized-key load error, and no list is a
ceiling over another.

A mount SHALL be **governed** when the host declares it so (`MountSpec.governed`, see
`workspace-and-sessions`), and ungoverned otherwise. `mounts.allow_always` SHALL enable its
governed mounts in **every** state, and a state's `mounts.allow` SHALL **add to** it — the
enabled set of a state is the union of the state's own list and the root's always-on list, in
that order. A governed mount no list names SHALL be enabled nowhere. An ungoverned mount SHALL
be enabled in every state without being named, exactly as today, so a spec with no `mounts`
block loads and runs unchanged over any table.

A mount SHALL be readable wherever it is enabled, and writable there only when the host
declared it writable **and** no applicable grant narrowed it to `access: read`. A grant naming
no access SHALL take the host's posture. The host's `readOnly` posture SHALL be a **ceiling**:
`access: read_write` on a mount the workspace serves read-only SHALL open nothing and SHALL be
a `validate` warning. `access: read` SHALL be a restriction like every other in this schema —
whichever level asks for it gets it, and no narrower level SHALL widen it back — so a state
cannot re-open a mount the workflow narrowed. An ungoverned mount SHALL take the host's posture
in every state, carrying no grant to qualify.

Denial mirrors the grant, and beats it. `mounts.forbid_always` SHALL put its names out of reach
of the whole workflow, governed or not. A state's `mounts.forbid` SHALL remove its names from
that state's enabled set, subtracting from the workflow's `allow_always`, from the state's own
`allow`, and from an ungoverned mount's standing visibility alike. Both SHALL resolve through
the one enabled-set resolution the runtime uses, so the kernel's mount rule, listing redaction,
prompt disclosure and `validate` follow without a second answer; a refusal caused by a forbid
SHALL say so rather than report the mount as merely not enabled.

`archmax validate` SHALL report a name no mount of the table carries (error, naming the mounts
the table declares) under every key, and:

- a name in a grant list that is not governed SHALL be a warning that the entry grants nothing
  (an ungoverned mount is visible everywhere already);
- a name both in the root's `allow_always` and in a state's `allow` SHALL be a warning that the
  state entry grants nothing the workflow had not already given;
- a state's `allow: []` beside a non-empty `allow_always` SHALL be a warning that an empty state
  list subtracts nothing and that `mounts.forbid` is what subtracts;
- a `forbid` entry for a name nothing would have enabled where it applies SHALL be a warning
  that the entry governs nothing;
- a `forbid_always` name that some list also grants SHALL be a warning that the grant reaches
  nothing;
- an `access: read_write` on a mount the table serves read-only SHALL be a warning that the
  entry opens nothing, the host's write posture being the ceiling;
- a state `tools.allow` path entry under a governed mount the state does not enable SHALL be a
  warning that the grant reaches nothing;
- for a spec with no root `mounts` block at all in a workspace whose table declares governed
  mounts: one warning that the workflow can reach none of them (naming them), pointing at
  `mounts.allow_always` as the key to add; any root `mounts` block SHALL silence it —
  `allow_always: []` included.

#### Scenario: Glob-shaped entry rejected

- **WHEN** a state declares `mounts: { allow: ["reference/**"] }`
- **THEN** loading fails stating that entries are mount names, not globs

#### Scenario: An access on a denial entry is a load error

- **WHEN** a state declares `mounts: { forbid: [{ mount: reference, access: read }] }`
- **THEN** loading fails naming the entry, because a denial is total; and
  `mounts: { allow: [{ mount: reference, access: write }] }` fails naming the two accepted
  values, `read` and `read_write`

#### Scenario: The ceiling spelling is a load error

- **WHEN** a spec declares a root `mounts: { allow: [reference] }`
- **THEN** loading fails naming the unrecognized key

#### Scenario: An always-on grant reaches a state that names nothing

- **WHEN** the table governs `reference`, the root declares `mounts: { allow_always: [reference] }`
  and state `lookup` declares no `mounts` block
- **THEN** `reference` is enabled in `lookup`, and `validate` reports no warning about either

#### Scenario: A state adds to the always-on grant

- **WHEN** the table governs `reference` and `catalogs/eu`, the root declares
  `mounts: { allow_always: [reference] }` and state `triage` declares
  `mounts: { allow: [catalogs/eu] }`
- **THEN** `triage` enables both, and no other state enables `catalogs/eu`

#### Scenario: A governed mount no list names is enabled nowhere

- **WHEN** the table governs `catalogs/eu` and no list names it
- **THEN** no state enables it: reads under it are refused, it is absent from every listing and
  every prompt

#### Scenario: An ungoverned mount stays visible without a block

- **WHEN** the table mounts `skills/` and `AGENTS.md` ungoverned and the spec declares no `mounts`
  block
- **THEN** every state reads both, exactly as before the block existed

#### Scenario: A state may read a mount it may not write

- **WHEN** the table mounts `shared` writable and governed, the root declares
  `mounts: { allow_always: [shared] }` and state `review` declares
  `mounts: { allow: [{ mount: shared, access: read }] }`
- **THEN** `review` reads `shared/**` and its listing there is complete, a write there is
  refused naming the mount and the access, and every other state still writes it

#### Scenario: A narrowing at the root binds every state

- **WHEN** the root declares `mounts: { allow_always: [{ mount: shared, access: read }] }` and
  state `edit` declares `mounts: { allow: [{ mount: shared, access: read_write }] }`
- **THEN** no state writes `shared/**`: read-only is a restriction, and the narrower level does
  not widen it back

#### Scenario: The host's posture is the ceiling

- **WHEN** the table mounts `reference` read-only and a grant declares
  `{ mount: reference, access: read_write }`
- **THEN** writes there are still refused, and `validate` warns that the entry opens nothing
  because the host serves the mount read-only

#### Scenario: A state's forbid subtracts an ungoverned mount

- **WHEN** the table mounts `reference` ungoverned and state `route` declares
  `mounts: { forbid: [reference] }`
- **THEN** `route` cannot read `reference/**`, its listing there is empty, and every other state
  still reads it

#### Scenario: A workflow-wide mount denial binds every state

- **WHEN** the root declares `mounts: { allow_always: [reference], forbid_always: [reference] }`,
  or a state names a mount the root forbids
- **THEN** no state enables it, and `validate` warns that the grant reaches nothing

#### Scenario: Naming a mount at both levels is inert

- **WHEN** the root declares `mounts: { allow_always: [reference] }` and a state declares
  `mounts: { allow: [reference] }`
- **THEN** the state enables `reference` once and `validate` warns that the state entry grants
  nothing the workflow had not already given

#### Scenario: A grant on an ungoverned mount is inert

- **WHEN** the table mounts `skills/` ungoverned and a state declares
  `mounts: { allow: [skills] }`
- **THEN** the spec loads and `validate` warns that the entry grants nothing, since the mount is
  visible everywhere already

#### Scenario: A name the table does not carry is an error

- **WHEN** a list names `refrence`
- **THEN** `validate` reports an error naming the mounts the table declares

#### Scenario: A path grant under an unenabled mount is inert

- **WHEN** the table governs `reference`, state `route` does not enable it, and `route` declares
  `tools: { allow: [{ tool: read_file, paths: ["reference/**"] }] }`
- **THEN** `validate` warns that the grant reaches nothing in that state

#### Scenario: A workflow that can reach no governed mount is told once

- **WHEN** the table governs `reference` and `catalogs/eu` and the spec declares no root `mounts`
  block
- **THEN** `archmax validate` reports one warning naming both as unreachable from this workflow and
  naming `mounts.allow_always` as the key to add — and reports none at all when the spec declares
  any root `mounts` block, `allow_always: []` included

### Requirement: Governance diagnostics for denial

`archmax validate` SHALL report, from the same kernel the runtime uses:

- a state that both grants and denies the same tool or skill — a **warning**, because the denial
  wins and the grant governs nothing;
- a `forbid` or `forbid_always` entry for a tool or slug that nothing would have granted where it
  applies — a **warning**, because the entry governs nothing;
- `archmax_advance` named by `tools.forbid_always` in a workflow that has
  a non-terminal state — an **error**, because no state could ever move and every run would strand.

#### Scenario: A grant the state's own denial cancels

- **WHEN** state `draft` declares `tools: { allow: [write_file], forbid: [write_file] }`
- **THEN** `validate` warns that the allow entry governs nothing, and the runtime blocks the call

#### Scenario: A denial with nothing to deny

- **WHEN** a state declares `skills: { forbid: [refund-policy] }` and nothing grants that slug there
- **THEN** `validate` warns that the entry governs nothing

#### Scenario: Forbidding movement strands the graph

- **WHEN** a workflow with two states declares `tools: { forbid_always: [archmax_advance] }`
- **THEN** `validate` reports an error: no state can leave itself, so no run can reach a terminal
  state

### Requirement: Settings, tests, runtime, extensions and metadata

`settings` SHALL accept `model` (a non-empty model id every state of this workflow runs on),
`timeoutMs` (default 15000 ms for sandbox execution),
`memoryLimitBytes`, `maxPtcCalls` (integer at least 0, or `null`), `maxResultChars`, and
`prompt_cache: { enabled?, ttl? }`; omitted fields take the runtime default. `tests` SHALL
accept `maxConcurrency` (positive integer; a value above 1 is a document-level error because
cases run sequentially), `caseTimeoutMs`, and the grader's model configuration under the key
`judge: { model?, modelOptions? }` — a case grader's model, which `settings.model` SHALL NOT
change. `runtime` SHALL accept `engine` and `version` (string or
number), preserved verbatim; omitted, the contract is `archmax-harness@1`, and a contract outside the
supported set (`archmax-harness@1`, `archmax-harness@2`) is a `validate` error and an assembly failure. `extensions`
SHALL accept `hooks`, the list of custom hook kinds `validate` accepts offline. `metadata`
SHALL be a loose mapping of host data, accepted at the spec root, on every state and inside every
rubric declaration: preserved on the parsed spec, never read by
the runtime, never rendered into the prompt, taking no part in governance, routing or
validation, and excluded from the spec hash, so a canvas edit mints no new spec version.
Everywhere else the root stays strict, and `metadata` SHALL NOT be nested under `extensions`.

#### Scenario: Unsupported runtime contract

- **WHEN** a spec declares `runtime: { engine: other-engine, version: "1" }`
- **THEN** `archmax validate` reports an unsupported contract naming the supported set, and
  assembly fails closed

#### Scenario: No governance key hides in settings

- **WHEN** a spec declares `settings: { forbid_tools: [...] }` or `extensions: { policy: … }`
- **THEN** loading fails naming the unrecognized key: tool and skill governance is declared only in
  the `tools` and `skills` blocks

#### Scenario: The workflow model and the grader's model are separate

- **WHEN** a spec declares `settings: { model: small-model }` and `tests: { judge: { model: grader-model } }`
- **THEN** the workflow's turns run on `small-model` and the case grader runs on `grader-model`

#### Scenario: Metadata is inert at every position

- **WHEN** a spec carries `metadata` at the root, on two states and on a rubric
- **THEN** it loads clean, every block survives on the parsed spec, the prompt carries none of
  them, and the spec hash equals that of the same spec without them

#### Scenario: Arbitrary contents accepted

- **WHEN** a `metadata` block carries nested mappings, arrays, numbers, booleans and strings
- **THEN** none of it is shape-checked and no diagnostic is produced

### Requirement: A workflow and a state may name the model they run on

A spec SHALL be able to name the model its turns run on at two positions: `settings.model` at
the root, applying to every state of that workflow, and `model` on a state, applying to that
state's turns. Each SHALL be a non-empty string naming a **model id only** — never an object,
never an endpoint, never credentials, and never sampling knobs — so that a declared model is
resolved over the endpoint and credentials already configured for the assembly, exactly as a
rubric's `model` is. Precedence SHALL be, most specific first: the state's `model`, the spec's
`settings.model`, then whatever the assembly resolved with no id (an explicit `model`, a
`modelFactory`, or `ARCHMAX_MODEL`). A spec naming neither SHALL behave exactly as before.

The ids SHALL be opaque to the runtime: no allow-list, no provider inference, no validation
beyond the non-empty string, so a new model id needs no SDK release. Neither key SHALL take any
part in governance — naming a model changes which model answers, never which tools or skills a
state may use — and both SHALL be part of the spec hash, because they change what runs.

#### Scenario: A state's model overrides the workflow's

- **WHEN** a spec declares `settings: { model: small-model }` and one state declares
  `model: large-model`
- **THEN** that state's turns run on `large-model`, every other state's turns run on
  `small-model`, and no state runs on `ARCHMAX_MODEL`

#### Scenario: The workflow's model overrides the environment

- **WHEN** a spec declares `settings: { model: small-model }`, no state declares a `model`, and
  `ARCHMAX_MODEL` names another id
- **THEN** every state's turns run on `small-model` over the endpoint and credentials
  `ARCHMAX_API_BASE_URL` / `ARCHMAX_API_KEY` configure

#### Scenario: An unknown id is not the schema's business

- **WHEN** a spec names a model id the configured endpoint does not serve
- **THEN** the spec loads clean and `archmax validate` reports nothing, because the id is opaque
  and only the endpoint can judge it

#### Scenario: Only an id, never a block

- **WHEN** a spec declares `model: { id: small-model, temperature: 0.2 }` at either position
- **THEN** loading fails naming the key and its path, directing the author to a model id string;
  sampling is environment and host configuration

#### Scenario: A redundant state model is an advisory

- **WHEN** a state declares the same `model` as the spec's `settings.model`
- **THEN** the spec loads and runs, and the lint warns that the state's declaration changes
  nothing

### Requirement: Disabled

`disabled` SHALL be a boolean; a non-boolean value is a schema error whose message states
the runtime reads it fail-closed. The runtime SHALL read the key as set unless it is absent,
`null` or `false`. A disabled workflow SHALL remain a loadable, validatable machine that
starts no new turn: `archmax run` refuses with `WorkflowDisabledError`, a trigger firing is
rejected at the turn boundary, a delegation to it is refused at call time, `archmax test`
skips its cases, and sessions already parked can still be decided, replied to and delivered
to. `archmax validate` SHALL warn on the disabled workflow and, from the caller's side, warn
on any state that allows `archmax_workflow_<slug>` for a disabled target. `disabled`
participates in the spec hash like every governing key, and the hash is not a resume guard
for flipping it.

#### Scenario: Disabled still validates in full

- **WHEN** a workflow declaring `disabled: true` also transitions to an unknown state
- **THEN** `archmax validate` reports the disabled warning and the dangling-target error

#### Scenario: Non-boolean value

- **WHEN** a spec declares `disabled: "no"`
- **THEN** loading fails, and the message says such a value would be read as disabled

### Requirement: A state's trigger declaration

A state's `triggers:` SHALL be a mapping of trigger id to a **loose** declaration, and SHALL be
the one place a trigger is declared: the key is the id, and the state it is declared on is its
entry state. A state declaring any is a start state for each id, in declaration order, read
through the single interpretation point `stateTriggerIds` — the mapping's keys. A declaration's
value MAY be `null` or empty, which declares the id and nothing more.

A declaration's harness-read keys are: `session` (a dotted path over the firing's variables
yielding the session id — first segment a variable name, no empty segment, never
`${{…}}`-wrapped), `message` (such a path, or `false` when firings carry no message),
`connection` (a non-empty string naming something in the host's environment), `requires` and
`returns`. `message` and `connection` are host-resolved: shape-checked, preserved, exposed on
the machine (`messagePathForTrigger`, `connectionForTrigger`) and never acted on by the archmax harness. Any
other key SHALL be preserved and reported as a lint warning naming the trigger and the key,
**except** `entry` and `name`, which SHALL be load errors: the state is the entry and the key is
the id, so each has one spelling and nothing to reconcile. Malformed paths and an empty
`connection` SHALL be errors.

#### Scenario: A trigger is read from the state it enters

- **WHEN** state `intake` declares
  `triggers: { manual: , slack-message: { session: triggers.-1.threadId, piece: slack } }`
- **THEN** its trigger ids are `[manual, slack-message]`, it is the start state for both,
  `slack-message` resolves sessions by `triggers.-1.threadId`, and `piece` is preserved with a
  lint warning naming the trigger and the key

#### Scenario: Malformed paths

- **WHEN** a declaration has `session: "${{conversation_id}}"`, `message: "triggers..text"` or
  `connection: ""`
- **THEN** loading fails naming the trigger and the key, worded for whoever wrote the path

#### Scenario: entry and name are refused

- **WHEN** a declaration carries `entry: intake` or `name: slack-message`
- **THEN** loading fails naming the key and the trigger, stating that the state a trigger is
  declared on is its entry and that the mapping key is its id

### Requirement: Start wiring and the reserved manual trigger

`manual` SHALL be the one reserved trigger id: the entry at which a machine is started by the
CLI, an SDK invocation naming no trigger, a host firing that names it, and a delegation from
another workflow. It SHALL be declared like any other trigger — a `manual` key under the
`triggers:` of the state a run starts in. A workflow SHALL declare at least one start state;
a trigger SHALL have at most one entry state, so two states declaring one
id — `manual` or any other — is a
document-level error naming both. The machine's `entry` SHALL be the `manual` start state,
else the first declared start state, else the first state. `resolveTrigger` SHALL default to
`manual` and throw `UnknownTriggerError` (naming the declared triggers) for an id no start
state declares. Every declared trigger SHALL be a start trigger: a trigger that enters no state
cannot be declared, so a host delivering an event into a live session SHALL name that session
(`agent.workflow.send(sessionId, …)`, `archmax deliver <session> --trigger <id>`) or supply a
`sessionPath` on the firing. A trigger's entry applies to a session's first turn; a later turn
continues from the session's retained position unless the current spec no longer declares it.
The archmax harness SHALL NOT listen for events: a firing is always an invocation the host makes, and its
payload arrives as session variables.

#### Scenario: No start state

- **WHEN** no state declares `triggers`
- **THEN** loading fails with "Workflow has no start state"

#### Scenario: Ambiguous manual

- **WHEN** one state declares `triggers: { manual: }` and another `triggers: { manual: , chat: }`
- **THEN** loading fails naming both states

### Requirement: A trigger's signature

A trigger declaration's `requires` and `returns` SHALL each be a list of distinct variable
names, declared on the state the trigger enters. `returns` SHALL NOT name `trigger`
(runtime-set and locked) or `title` (a child's title
describes the child; returning it would rename the caller's task). `requires` MAY name either;
a firing supplying `title` seeds it unlocked. The signature names the contract only — what a
variable holds belongs in the state `instructions` that set it. The machine SHALL expose both
per trigger (`requiresForTrigger`, `returnsForTrigger`), and every variable a signature
requires SHALL count as declared for the purpose of guard-reference advisories.

#### Scenario: Malformed signature

- **WHEN** a declaration has `requires: "order_id"`, `returns: [risk_level, risk_level]` or
  `returns: [title]`
- **THEN** loading fails naming the trigger and the offending entry, and `archmax validate`
  reports the identical message

### Requirement: The signature holds at the session boundary

A session on a trigger declaring `requires` SHALL be refused at the turn boundary — after
this turn's opening variables are built from the host's seeds, the invocation's seeds and
`trigger` — unless every named variable is set, to any value, `null` included, with a message
naming the trigger and every missing name. When a session completes in a terminal state, the
runtime SHALL check the `returns` of the trigger that started the **current turn** and reject
the session naming the state and every unset name; a session that parks (a human state,
`archmax_wait`) is not checked because it has not completed. A declared return is an ordinary
variable: declaring it creates nothing.

#### Scenario: Missing required input

- **WHEN** a session starts on a trigger declaring `requires: [order_id]` with no `order_id`
  among its seeds
- **THEN** no model call is made and the session is rejected naming the trigger and `order_id`

#### Scenario: Unset return at completion

- **WHEN** a session on a trigger declaring `returns: [enrichment_file, delayed]` finishes
  having set only `enrichment_file`
- **THEN** the session is rejected naming the terminal state and `delayed`

### Requirement: The signature crosses a sub-workflow boundary

The `manual` trigger's signature SHALL also be a workflow's call signature: `requires` names
the arguments an `archmax_workflow_<slug>` call must supply, `returns` what the call's result
carries, one declaration for both ingresses. A child session's opening variables SHALL be
exactly the call's arguments — seeded through the same construction and name rule a host's
`variables` go through, locked (except `title`) — plus the built-in `trigger`, which reads
`manual`; nothing of the caller's store is copied down and no name is reserved for it. A call
missing a required argument, or supplying an invalid name, SHALL be refused before the child
runs. A string argument carrying a `${{…}}` reference SHALL be resolved against the
**caller's** variables, verbatim (not glob-escaped), and an unresolvable reference fails the
call closed. When the child settles, the runtime SHALL read exactly its declared `returns`
out of its settled store into the call's result and discard the rest; no lock, reseed or
value crosses upward otherwise, and nothing writes a caller variable — an agent that needs the
value in one sets it with `archmax_set_variables`. Dispatch itself — the tool, depth and
concurrency bounds, child sessions — is the `delegation` capability's.

#### Scenario: Only declared returns cross up

- **WHEN** a child finishes with six variables set and its `manual` trigger declares two
  returns
- **THEN** the two reach the caller as the tool result and the caller's own store is unchanged

#### Scenario: Argument reference resolved caller-side

- **WHEN** a script calls the tool with `{ account_id: "${{account_id}}" }` and the caller
  holds `acct-42`
- **THEN** the child is seeded with `account_id: acct-42`; were the reference unset, the call
  would fail naming the argument

### Requirement: Variable names and the two reserved variables

A session's variables SHALL form one flat, undeclared namespace: a variable exists when
something sets it, and there is no `variables:` block in the spec. A name SHALL match
`^[a-z][a-z0-9_]*$` (never dotted), checked wherever a name enters — a host seed, a delivery,
a call argument, `requires`/`returns`, and `archmax_set_variables`. Two names are reserved.
`trigger` holds the id of the current turn's arrival, set by the runtime and locked, re-stamped
at every arrival boundary (turn start and delivery), refused to every write, and available
before the start state's `before` hook runs, so a guard may reference `${{trigger}}` without
a seed. `title` is a short label for the session's task, agent-owned: never locked by any
route (a seed stores it unlocked; `archmax_set_variables` refuses `lock: true` with it),
shape-checked on write (non-empty, single-line, at most 200 characters after trimming, stored
trimmed; a bad seed throws `InvalidTitleError` at the seeding boundary), treated as an opening
label when seeded (it does not overwrite a title the session already holds), and replaced by
a delivery that carries one.

#### Scenario: Invalid name refused at the door

- **WHEN** a seed, a delivery, or a write uses the name `Customer.Id`
- **THEN** it is refused naming the required shape, and a dotted name is told there is no
  sub-path write

#### Scenario: Seeded title yields to an established one

- **WHEN** a host seeds `title: "Inbound refund request"`, the first turn sets `title` to
  `"Refund for order A-1042"`, and a second turn starts with the same seed
- **THEN** `title` still reads `Refund for order A-1042`

### Requirement: Seeds are locked; locking is monotonic

Every host-supplied variable SHALL be seeded locked (`title` excepted) through one
construction, `buildSeededVariables`, whether it arrives as `createAgent`'s `variables`, a
delivery's variables or a call's arguments, so a guard bound to a seed cannot be invalidated
by the agent. A locked variable SHALL NOT be unlocked, deleted or rewritten by any tool, hook
or script; only a host seeding boundary (a turn start or a delivery) replaces a locked entry,
re-establishing the session's facts. Variables SHALL be checkpointed with the session and survive transitions,
parks and turn boundaries; successive writes in one state accumulate.

#### Scenario: Delivery re-seeds a locked name

- **WHEN** a delivery into a parked session carries `reply_body` again
- **THEN** the new value replaces the old, stays locked, and the agent still cannot rewrite it

### Requirement: References

A `${{name}}` or `${{name.dotted.path}}` reference SHALL address exactly one value: the first
segment is the variable, each further segment descends one level by own-property lookup
(never `length`, `constructor`, `toString` or `__proto__`), an array is addressed by a
canonical non-negative index or a from-the-end index `-1`, `-2`, … (`-0`, `-01` are keys),
and a miss anywhere is unresolved. A resolved value SHALL be a scalar (string, number,
boolean). In an argument guard the value is glob-escaped so a value of `*` matches only `*`;
in prose and in the agent's own tool arguments it is substituted verbatim. `$${{…}}` SHALL
render the literal text `${{…}}` with no lookup, and substitution is a single pass, never
recursive. Resolution SHALL fail closed: a literal `${{…}}` never reaches a tool or a model. An
unresolvable reference in a **guard** makes the entry match nothing and is a terminal
governance failure (an authoring defect); an unresolvable reference in an **agent-written
argument** is a correctable tool refusal naming the reference and the reason, with no partial
substitution delivered. Script- and hook-originated calls are not substituted.

#### Scenario: Negative index and prototype guard

- **WHEN** `order.items` holds two entries and references are `${{order.items.-1.sku}}`,
  `${{order.items.-3.sku}}` and `${{tags.length}}`
- **THEN** the first resolves to the last item's `sku` and the other two are unresolved

#### Scenario: Non-scalar in an argument

- **WHEN** `order` holds an object and the agent passes `"${{order}}"`
- **THEN** the call is refused naming the non-scalar result and the session continues

### Requirement: The variable tools

`archmax_get_variables` SHALL take optional `name` and `path`; a blank or whitespace-only
argument counts as absent. With no `name` it returns every variable with its value and locked
flag; an unknown `name` is an error naming the set variables; a `path` that does not resolve
is an error rather than the whole value. `archmax_set_variables` SHALL take `variables` (name
to whole value; any JSON value, no sub-path write) and optional `lock`; it creates or replaces
each variable and locks them all when `lock` is true. A call SHALL be refused atomically —
nothing written — when it names no variables, uses an invalid name, targets a locked variable,
locks `title`, or writes a malformed `title`. Both tools SHALL be disclosed in every state,
terminal states included.

#### Scenario: Blank name reads everything

- **WHEN** the agent calls `archmax_get_variables({ name: "" })`
- **THEN** it receives every variable, not an unknown-variable error

#### Scenario: One bad key refuses the call

- **WHEN** one call writes `{ case_id: "K-9", title: "Refund" }` with `lock: true`
- **THEN** neither is written and the reason names `title`

### Requirement: A state's requires must be met before it is left

A state's `requires` SHALL list variable names that must be set before the state may be left.
The kernel SHALL block `archmax_advance` out of the state while any is unset (rule
`transition.requires`, evaluated before the edge and its hooks), naming the unset variables;
the block is recoverable — the agent sets them and retries — and neither rejects the session
nor routes `on_error`. A seeded variable satisfies it without agent action. The lint SHALL
warn on a duplicated entry, and SHALL NOT diagnose a required name nothing references. A
`${{…}}` guard reference that no seed, no `requires` (state or trigger) and not the built-in
`trigger` guarantees SHALL be a warning — at assembly, where the seeds are known, and in
`validate` without them — stating that the guard then rests on the agent having set it; an
`allow_always` reference adds that it binds in states reached before anything sets it.

#### Scenario: Exit blocked then permitted

- **WHEN** the active state declares `requires: [case_id]`, nothing set it, and the agent
  advances
- **THEN** the transition is refused naming `case_id`; once the agent sets it, the advance
  proceeds through the normal `after`-hook path

#### Scenario: Unguaranteed guard reference

- **WHEN** a guard references `${{case_id}}` and neither a seed nor any `requires` names it
- **THEN** assembly and `validate` warn naming the reference and its entry, and the session
  still runs

### Requirement: archmax validate checks the document and what surrounds it

Static validation SHALL make no model calls: `validateWorkflow({ rootDir?, workflow?,
skills? })` and `archmax validate [workflow] [--root <dir>] [--json]` return diagnostics —
`severity` `error` or `warning`, a message, and where known a `file` and dotted `field` — with
`valid` false when any error is present. Beyond the schema and lint (reported in the loader's
words), validation SHALL check: the workflow slug shape; the runtime contract; every state
slug; each hook's referent — a `script` that resolves inside `hooks/`, exists on the authoring
backend and imports only from `@archmax-ai/harness/*`, a custom kind listed under `extensions.hooks`
(a `rubric` has no referent to check: the grader is the hook's own value); every skills list against the
registry; kernel probes of `tools.allow` and `tools.allow_always` entries the runtime would refuse (a write
into a runtime-owned or offload area, the read-only authored zone, a path or tool a `forbid_always` or
`forbid` list denies, an entry naming `task`, an `archmax_run` path outside every skill bundle, a path that names the authoring
backend, a path inside a bundle the state does not enable), each an error; sibling workflows
named by `archmax_workflow_<slug>` entries (missing or unusable spec, no `manual` entry, a
non-slug target, a cycle, a chain past the dispatcher's depth bound — errors; a disabled
target — warning); and each `tests/*.test.yaml` case (schema errors, a `trigger` id no start
state declares, a `from:` fixture missing or escaping `tests/`). It SHALL inspect no grader directory and report no unloadable-grader advisory,
because a grader either resolves in the document or the spec does not load. The CLI SHALL print
diagnostics to stderr, the verdict line (or, with `--json`, `{ workflow, valid, diagnostics }`)
to stdout, and exit 0 when valid, 1 when not, 2 on a usage error; with no workflow argument it
SHALL validate the workspace's only workflow and refuse when there are several or none.

#### Scenario: Missing hook script

- **WHEN** a state declares `{ script: hooks/x.js }` and `workflows/<slug>/hooks/x.js` does
  not exist
- **THEN** `validate` reports an error naming the state, phase and resolved path

#### Scenario: No grader directory is consulted

- **WHEN** `validate` runs against any workspace
- **THEN** it reads no grader definition file and reports no diagnostic about one being absent,
  unparseable or skipped at runtime

#### Scenario: Inert run grant

- **WHEN** a state allows `{ tool: archmax_run, paths: ["scratchpad/**"] }`
- **THEN** `validate` reports an error that `archmax_run` is confined to skill bundles
  (`script.skill-only`), so the entry grants nothing

#### Scenario: Delegation chain checked across siblings

- **WHEN** `a` allows `archmax_workflow_b` and `b` allows `archmax_workflow_a`, or a target
  declares no `manual` entry
- **THEN** `validate` reports an error naming the chain, or the missing `manual` entry, from
  the same sibling-workflow walk

#### Scenario: Case trigger unknown

- **WHEN** a case declares `trigger: { id: does_not_exist }`
- **THEN** `validate` reports an error listing the triggers the workflow declares; a `deliver`
  step's trigger id is not cross-checked, since a park awaits no declared id
