## ADDED Requirements

### Requirement: A leftover before or after key fails loading

`before` and `after` SHALL NOT be state keys. A state that still declares either SHALL fail to
load with the standard unrecognized-key error naming the key and its dotted path
(`states.<slug>.after`), and `archmax validate` SHALL report the identical diagnostic. There
SHALL be no special-cased message and no migration shim: the key's value is not read, converted
or rewritten, whatever it holds.

#### Scenario: A leftover after key fails loading

- **WHEN** state `draft` declares `after: { script: hooks/check.js }`
- **THEN** loading fails with the unrecognized-key diagnostic naming `after` at
  `states.draft.after`, `createAgent` throws `WorkflowLoadError`, and `archmax validate` reports
  the identical diagnostic

#### Scenario: The value is never read

- **WHEN** a state declares `before: [{ rubric: { instructions: "Check the tone." } }]` or
  `before: { script: hooks/x.js, max_iterations: 2 }`
- **THEN** the diagnostic names only the unrecognized key and its path, says nothing about the
  value's shape, and suggests no replacement

#### Scenario: Every state type refuses the keys alike

- **WHEN** an `agent`, `human`, `grader` or `code` state declares `before:` or `after:`
- **THEN** loading fails with the same unrecognized-key diagnostic, because the keys exist on no
  state type

### Requirement: A code state declares its script

A `type: code` state SHALL declare `script`: a workflow-relative path inside `scripts/`, ending
in `.js` or `.mjs`, with no `..` segment, confined segment by segment (`scripts/check.js`
resolves to `workflows/<slug>/scripts/check.js`). A malformed path SHALL be a schema error at
`states.<slug>.script`. A code state without `script`, and a state of any other type that
declares one, SHALL each be a document-level (`refineSpec`) error, because the runtime cannot
run either.

#### Scenario: A code state names its script

- **WHEN** state `check-refund` declares `type: code` and `script: scripts/check-refund.js`
- **THEN** the spec loads and the script resolves to `workflows/<slug>/scripts/check-refund.js`
  on the authoring backend

#### Scenario: Confined script path

- **WHEN** a code state declares `script: skills/x/scripts/check.js`, `script: /abs/check.js`,
  `script: scripts/../escape.js`, `script: hooks/check.js` or `script: scripts/check.ts`
- **THEN** loading fails addressed to `states.<slug>.script`, naming the required location
  inside `scripts/` and the accepted extensions

#### Scenario: A code state without a script

- **WHEN** a state declares `type: code` and no `script`
- **THEN** loading fails naming the state and stating that a code state must declare `script`,
  and `archmax validate` reports the identical message

#### Scenario: A script on another state type

- **WHEN** an `agent` state (declared or by default), a `human` state or a `grader` state
  declares `script: scripts/check.js`
- **THEN** loading fails naming the state and stating that only a code state runs a script

### Requirement: A grader state declares instructions and at least one transition

A `type: grader` state SHALL declare non-empty `instructions`, which the grader judges by, and
at least one transition. Each SHALL be a **lint error**: the spec loads and the runtime
tolerates it, while `archmax validate` fails. A grader decides, as a person at a human state
does, and a grader with nowhere to send the session could only approve by finishing silently,
which would fail open.

#### Scenario: A grader without instructions

- **WHEN** a `type: grader` state declares no `instructions`, or whitespace-only ones
- **THEN** the spec loads, and `archmax validate` reports an error naming the state and stating
  that a grader needs instructions to judge by

#### Scenario: A grader with no transitions

- **WHEN** a `type: grader` state declares no `transitions`
- **THEN** the spec loads, and `archmax validate` reports an error naming the state and stating
  that a grader must declare at least one transition to decide between

#### Scenario: A well-formed grader validates clean

- **WHEN** grader state `review-reply` declares `instructions` and transitions to `answered` and
  back to `orders-question`
- **THEN** `archmax validate` reports no diagnostic about the state

### Requirement: Keys a state type never reads are lint errors

`archmax validate` SHALL report an **error** for a key the state's type never reads, while the
spec still loads and runs: on a `code` state, `instructions`, `model`, `budget`, `evidence` and
`approvers`; on a `grader` state, `evidence`, `approvers` and `budget.maxParks`. Each diagnostic
SHALL name the state, the key and the state's type.

#### Scenario: Instructions on a code state

- **WHEN** a `type: code` state declares `instructions:`
- **THEN** the spec loads, and `archmax validate` reports an error naming the state and
  `instructions`, because a code state makes no model call

#### Scenario: A model or a budget on a code state

- **WHEN** a `type: code` state declares `model: small-model` or `budget: { timeoutMs: 5000 }`
- **THEN** `archmax validate` reports an error naming the state and the key

#### Scenario: Evidence and approvers on an automated state

- **WHEN** a code or grader state declares `evidence: [scratchpad/answer.json]` or
  `approvers: [support-lead]`
- **THEN** `archmax validate` reports an error naming the state and the key: both belong to a
  human state's decision record

#### Scenario: A park budget on a grader

- **WHEN** a `type: grader` state declares `budget: { maxParks: 1 }`
- **THEN** `archmax validate` reports an error naming `budget.maxParks`, while
  `budget: { maxTurns: 4, timeoutMs: 60000 }` on the same grader draws no diagnostic

### Requirement: An automated state's allow list names no tool it is never offered

In a `grader` or `code` state, a `tools.allow` entry naming `write_todos`, `archmax_eval`,
`archmax_run`, `archmax_wait` or `archmax_reset` SHALL be a **lint error** naming the state and
the tool. No automated state is offered those tools, so the entry grants nothing: the spec still
loads, and the runtime leaves the tool off the state's surface.

#### Scenario: A sandbox grant on a code state

- **WHEN** a `type: code` state declares
  `tools: { allow: [{ tool: archmax_run, paths: ["skills/x/scripts/**"] }] }`
- **THEN** the spec loads, `archmax validate` reports an error naming the state and
  `archmax_run`, and the state's script is not offered `archmax_run`

#### Scenario: A park tool on a grader

- **WHEN** a `type: grader` state declares `tools: { allow: [archmax_wait] }`
- **THEN** `archmax validate` reports an error naming the state and `archmax_wait`, because an
  automated state never parks

## MODIFIED Requirements

### Requirement: One strict schema defines the spec

`workflow.yaml` SHALL be defined by a single Zod schema (`src/machine/spec-schema.ts`) from
which the exported TypeScript types are inferred. Every object in it SHALL be strict except
the documented loose slots (a `states.<slug>.triggers.<id>` declaration, and `metadata` at the
root and on a state): an unrecognized key at any level is a load error naming the key and its
dotted path (`states.review.transtions`). Document-level rules (`refineSpec`) SHALL run only
once the shape holds, and the same `parseMachineSpec` SHALL back loading and `archmax validate`,
so a spec that validates cleanly loads and a spec that fails to load fails `validate` with the
same message. When the shape holds but a document-level rule fails, the typed spec SHALL still
be handed to the lint so one dangling target does not hide every advisory behind it. The machine
SHALL expose a stable content hash of the governing spec — every key except `metadata` at the
root and on a state, serialized with sorted object keys and ordered arrays — written into a
session's first checkpoint and its `_specs/<hash>.json` snapshot; any governing edit changes it,
including an edit to a grader state's `instructions` or to a code state's `script`, and a
cosmetic one (key order, whitespace, `metadata`) does not.

A retired key SHALL be diagnosed as exactly what it is — an unrecognized key at its path — with
no mapping to its replacement. The schema carries no memory of a former spelling, so `editor`,
a root `name`, a root `triggers`, a root `extensions`, a state's `trigger`, and a state's
`before` and `after` are reported the way a typo is.

#### Scenario: A misspelled key is caught with its path

- **WHEN** a state declares `transtions:` or a spec declares `tools: { allows: [] }`
- **THEN** loading fails with an error naming the unrecognized key and its path, and
  `archmax validate` reports the identical diagnostic

#### Scenario: A retired key is caught the same way

- **WHEN** a spec declares `editor:`, a root `name:`, a root `triggers:`, a root `extensions:`, a
  state's `trigger:`, or a state's `before:` or `after:`
- **THEN** loading fails with the same unrecognized-key diagnostic naming the key and its path,
  carrying no suggestion of a replacement

#### Scenario: Structural checks are not hand-written

- **WHEN** a value has the wrong type, a required field is missing, or an enum member is unknown
- **THEN** the diagnostic comes from the schema, addressed by key path, in `validate` and at
  load alike

#### Scenario: An automated state's definition is part of the hash

- **WHEN** two specs differ only in a grader state's `instructions`, or only in a code state's
  `script`
- **THEN** their spec hashes differ, while two specs differing only in a state's `metadata` hash
  equal

### Requirement: Root keys

The spec root SHALL accept exactly: `title` (string, a human label — the workflow's identity
is its directory slug), `instructions` (non-empty string of standing guidance rendered into
the system prompt for the whole session), `disabled` (boolean), `runtime`,
`settings`, `tools` (`allow_always`, `forbid_always`), `skills` (`allow_always`, `forbid_always`),
`mounts` (`allow_always`, `forbid_always`), `tests`, `metadata`, and `states` — a mapping of
state slug to state, which SHALL be present and non-empty. A spec with no `instructions` SHALL
load with a lint warning that the workflow ships no standing guidance. There SHALL be no root
`triggers`: a trigger is declared on the state it enters. There SHALL be no root `extensions`
block: it held only the custom hook kinds, which no longer exist.

#### Scenario: Empty states rejected

- **WHEN** a spec declares no `states`, or `states: {}`
- **THEN** loading fails with "Machine spec is missing or has empty 'states'"

#### Scenario: metadata is a recognized root key, rubrics and triggers are not

- **WHEN** a spec declares `metadata:` at the root
- **THEN** it is accepted, and a misspelling (`metadatas:`) is a load error naming the key and its
  path

- **WHEN** a spec declares `rubrics:`, `triggers:` or `extensions: { hooks: [audit] }` at the root
- **THEN** loading fails naming the unrecognized key: grading is a grader state on the graph, a
  trigger is declared on the state it enters, and there is no extensions block

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

Each state SHALL accept exactly: `type` (`agent`, the default, `human`, `grader` or `code`),
`title` (non-empty string), `instructions`, `summary` (a one-line authoring and host label,
rendered into no part of the prompt), `evidence` (list of paths),
`approvers` (list of strings, presented to a reviewer and otherwise uninterpreted),
`triggers`, `script` (a code state's script path), `budget`, `model` (a non-empty model id the
state's model calls run on — the agent's turns, or a grader's calls), `on_error` (a state slug),
`tools` (`allow`, `forbid`), `skills` (`allow`, `forbid`), `mounts` (`allow`, `forbid`),
`requires` (list of variable names), `metadata` (the loose, runtime-inert host slot), and
`transitions`. `grader` and `code` states are **automated states**: the runtime runs one on
entry with no model call of the session's agent (see `automated-states`). Which of these keys
each type reads is held by lint (see "Keys a state type never reads are lint errors"). A bare
`done:` (YAML `null`) SHALL be read as an empty state — terminal, `agent`, always-on tools only.

#### Scenario: Unknown state type

- **WHEN** a state declares `type: wait`, `type: workflow` or `type: hook`
- **THEN** loading fails naming the type and the four accepted kinds, `agent`, `human`, `grader`
  and `code`

#### Scenario: Every state type loads

- **WHEN** a spec declares an `agent` state, a `human` state, a `grader` state with
  `instructions` and a transition, and a `code` state with `script: scripts/check.js`
- **THEN** it loads clean and each state's type survives on the parsed spec

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

- **WHEN** an `agent` state with several transitions declares no `instructions`
- **THEN** the lint warns, because the agent has nothing telling it how to classify the request
  before it routes; a human or grader state without instructions is a lint error instead, and a
  code state routes by its script

#### Scenario: Singular trigger is not a state key

- **WHEN** a state declares `trigger: chat`
- **THEN** loading fails naming the unrecognized key `states.<slug>.trigger` and its path

### Requirement: Slugs are identity, titles are labels

A state's key in `states` SHALL be its slug — the only token that resolves it, in `to`,
`on_error`, the `to` passed to `archmax_advance` (by the agent, a grader or a code state's
script), events, artifacts and case assertions. A workflow's slug SHALL be its
`workflows/<slug>/` directory name and the CLI argument. A trigger id SHALL be the key of a
`states.<slug>.triggers` entry, and a trigger SHALL have no key of its own anywhere else in the
document. State and workflow slugs SHALL take the shape `^[a-z0-9]+(-[a-z0-9]+)*$`
(`SLUG_PATTERN`), enforced by `archmax validate` as an error (empty key reported as a missing
identity, nonconforming key as a shape error); the loader and the runtime SHALL treat a slug as
opaque so a nonconforming slug still runs. A `title` on the root or a state SHALL be
presentational only: never unique, never a routing target, rendered beside the slug in the graph
section and carried in a human state's decision record.

Per-node host data SHALL live on the node — a state's own `metadata` — rather than in a
root-level table keyed by state slug, so a renamed state carries its host data with it and no
second reference to the former slug is left behind.

#### Scenario: Title is not a target

- **WHEN** the agent passes a state's `title` as `archmax_advance`'s `to`
- **THEN** the transition is refused as an undeclared target (`transition.no-edge`)

#### Scenario: Nonconforming slugs reported statically

- **WHEN** a spec declares states keyed `Identify Case`, `snake_case` or `double--hyphen`, or
  the workflow directory is `order_lookup`
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
`reject`, `refine`, `none`. The `description` is the only thing the agent or a grader is told
about where an edge leads — no attribute of the target state is disclosed — so a missing, blank
or mistyped one SHALL be a load error addressed to
`states.<slug>.transitions.<index>.description`, which names the edge, stating that the
description is what the agent routes on and what to write instead. A state with no transitions
SHALL be terminal: the session completes when the state's work finishes there — the agent's
last turn in an agent state, the script's return in a code state — and `archmax_advance` is not
disclosed or offered in it. `on_error`, when declared, SHALL name a declared state; a state's
failure (an exhausted budget, or an automated state that errors, times out or finishes without
deciding) routes there, and a state without one ends the session rejected. Transitions carry no
preconditions of their own: an edge is decided only by its existence and the state's
`requires`, whoever takes it.

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

#### Scenario: An automated state's failure takes the error route

- **WHEN** a code state declaring `on_error: escalate` has a script that throws
- **THEN** the session moves to `escalate`; with no `on_error`, the session ends rejected

### Requirement: Human-state rules are split between schema and lint

A `type: human` state parks the session for a person's decision, so it SHALL declare
`instructions` describing the decision, at least one transition, at most one transition of each
labeled `type` (`approve`/`reject`/`refine`), and no transition to itself. These SHALL be
**lint errors**: the runtime tolerates them and the spec still loads, while `archmax validate`
fails on them. The shape rules a human state shares with every state — the `type` enum, the
transition `type` enum, an existing `to`, a non-empty transition `description` — remain schema
errors, so a human state's decision button labels are now guaranteed by the schema rather than
by lint. The decision record SHALL be built from the state's `title`, `instructions`, declared
`evidence` (leading, deduplicated with any evidence the advancing call attached) and its
transitions' `to`/`description`/`type`.

#### Scenario: Human state without a button label

- **WHEN** a `type: human` state declares a transition with no `description`
- **THEN** loading fails under the strict schema naming that transition's `description`, the same
  way it does for an agent state

#### Scenario: Hook on a human state

- **WHEN** a `type: human` state declares `after: { rubric: { instructions: … } }`
- **THEN** loading fails with the standard unrecognized-key diagnostic naming `after` and its
  path, as it does on every state type, and no human-state lint is reported for it

#### Scenario: Human state with nowhere to route

- **WHEN** a `type: human` state declares no transitions
- **THEN** the spec loads, and `archmax validate` reports an error that the state must declare at
  least one outgoing transition the person can route to

### Requirement: Budgets

A state's `budget` SHALL accept `maxTurns`, `timeoutMs` and `maxParks`, each a positive
integer when present and unbounded when absent. In an agent state, `maxTurns` counts the state's
model turns, `timeoutMs` bounds a model call in the state, and `maxParks` counts the state's
`archmax_wait` parks. In a grader state, `maxTurns` bounds the grader's own model calls and
`timeoutMs` bounds the grader's run; the session agent's turn budget is not spent there. A
`budget.maxParks` on a grader and any `budget` on a code state are lint errors (see "Keys a
state type never reads are lint errors"). Exhausting any budget fails the state, which routes
through `on_error` when declared and otherwise rejects the session.

#### Scenario: Non-positive budget rejected

- **WHEN** a state declares `budget: { maxParks: 0 }` or a non-integer value
- **THEN** loading fails with "must be a positive number" addressed to that field

#### Scenario: A grader's turn budget bounds the grader

- **WHEN** a grader state declares `budget: { maxTurns: 3 }` and its grader has made three model
  calls without calling `archmax_advance` or `archmax_raise`
- **THEN** the grader's run fails, and the failure routes through the state's `on_error` when
  declared and otherwise rejects the session

#### Scenario: A grader's timeout bounds the run

- **WHEN** a grader state declares `budget: { timeoutMs: 30000 }` and its grader has not decided
  30 seconds after it started
- **THEN** the grader's run fails the same way

### Requirement: Settings, tests, runtime and metadata

`settings` SHALL accept `model` (a non-empty model id every state of this workflow runs on),
`timeoutMs` (default 15000 ms for sandbox execution),
`memoryLimitBytes`, `maxPtcCalls` (integer at least 0, or `null`), `maxResultChars`, and
`prompt_cache: { enabled?, ttl? }`; omitted fields take the runtime default. `tests` SHALL
accept `maxConcurrency` (positive integer; a value above 1 is a document-level error because
cases run sequentially), `caseTimeoutMs`, and, under the key `judge: { model?, modelOptions? }`,
the model a case's `grade` assertion scores with, which `settings.model` SHALL NOT change and
which no grader state runs on. `runtime` SHALL accept `engine` and `version` (string or
number), preserved verbatim; omitted, the contract is `archmax-harness@3`, and a contract
outside the supported set (`archmax-harness@3` only) is a `validate` error and an assembly
failure. `metadata` SHALL be a loose mapping of host data, accepted at the spec root and on
every state: preserved on the parsed spec, never read by the runtime, never rendered into the
prompt, taking no part in governance, routing or validation, and excluded from the spec hash,
so a canvas edit mints no new spec version. Everywhere else the root stays strict, and there is
no `extensions` block.

#### Scenario: Unsupported runtime contract

- **WHEN** a spec declares `runtime: { engine: other-engine, version: "1" }`
- **THEN** `archmax validate` reports an unsupported contract naming the supported set, and
  assembly fails closed

#### Scenario: A retired contract version is refused

- **WHEN** a spec declares `runtime: { engine: archmax-harness, version: 2 }` or `version: 1`
- **THEN** `archmax validate` reports an unsupported contract naming `archmax-harness@3` as the
  supported set, and assembly fails closed; a spec with no `runtime` block resolves to
  `archmax-harness@3`

#### Scenario: No governance key hides in settings

- **WHEN** a spec declares `settings: { forbid_tools: [...] }`
- **THEN** loading fails naming the unrecognized key: tool and skill governance is declared only in
  the `tools` and `skills` blocks

#### Scenario: The workflow model and the grader's model are separate

- **WHEN** a spec declares `settings: { model: small-model }` and `tests: { judge: { model: judge-model } }`
- **THEN** the workflow's turns and its grader states run on `small-model`, and every case
  `grade` assertion is scored on `judge-model`

#### Scenario: Metadata is inert at every position

- **WHEN** a spec carries `metadata` at the root and on two states
- **THEN** it loads clean, every block survives on the parsed spec, the prompt carries none of
  them, and the spec hash equals that of the same spec without them

#### Scenario: Arbitrary contents accepted

- **WHEN** a `metadata` block carries nested mappings, arrays, numbers, booleans and strings
- **THEN** none of it is shape-checked and no diagnostic is produced

### Requirement: A workflow and a state may name the model they run on

A spec SHALL be able to name the model its model calls run on at two positions: `settings.model`
at the root, applying to every state of that workflow, and `model` on a state, applying to that
state's model calls — the agent's turns in an agent or human state, the grader's calls in a
grader state. Each SHALL be a non-empty string naming a **model id only** — never an object,
never an endpoint, never credentials, and never sampling knobs — so that a declared model is
resolved over the endpoint and credentials already configured for the assembly. Precedence
SHALL be, most specific first: the state's `model`, the spec's `settings.model`, then whatever
the assembly resolved with no id (an explicit `model`, a `modelFactory`, or `ARCHMAX_MODEL`). A
spec naming neither SHALL behave exactly as before. A code state makes no model call, so a
`model` on one is a lint error (see "Keys a state type never reads are lint errors").

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

#### Scenario: A grader state's model

- **WHEN** a spec declares `settings: { model: small-model }`, grader state `review-reply`
  declares `model: careful-model`, and grader state `check-tone` declares none
- **THEN** the `review-reply` grader's model calls run on `careful-model` and the `check-tone`
  grader's on `small-model`

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

### Requirement: Variable names and the two reserved variables

A session's variables SHALL form one flat, undeclared namespace: a variable exists when
something sets it, and there is no `variables:` block in the spec. A name SHALL match
`^[a-z][a-z0-9_]*$` (never dotted), checked wherever a name enters — a host seed, a delivery,
a call argument, `requires`/`returns`, and `archmax_set_variables`. Two names are reserved.
`trigger` holds the id of the current turn's arrival, set by the runtime and locked, re-stamped
at every arrival boundary (turn start and delivery), refused to every write, and available
from the turn boundary on, before the start state does anything — a code start state's script
included — so a guard may reference `${{trigger}}` without a seed. `title` is a short label for
the session's task, agent-owned: never locked by any
route (a seed stores it unlocked; `archmax_set_variables` refuses `lock: true` with it),
shape-checked on write (non-empty, single-line, at most 200 characters after trimming, stored
trimmed; a bad seed throws `InvalidTitleError` at the seeding boundary), treated as an opening
label when seeded (it does not overwrite a title the session already holds), and replaced by
a delivery that carries one.

The platform prompt SHALL ask a top-level session to set `title` in its first turn. After that,
it SHALL ask for a rename only when the conversation as a whole has moved to a subject the title
no longer describes. The model SHALL be told to judge this against the whole conversation, not
its latest message: a follow-up, a detail, a correction or a side question on the same subject
keeps the title, and a rename names what the whole conversation is about. The `title` sentence
in a top-level session's `archmax_set_variables` description SHALL set the same bar. A
sub-workflow's child SHALL read neither.

#### Scenario: Invalid name refused at the door

- **WHEN** a seed, a delivery, or a write uses the name `Customer.Id`
- **THEN** it is refused naming the required shape, and a dotted name is told there is no
  sub-path write

#### Scenario: Seeded title yields to an established one

- **WHEN** a host seeds `title: "Inbound refund request"`, the first turn sets `title` to
  `"Refund for order A-1042"`, and a second turn starts with the same seed
- **THEN** `title` still reads `Refund for order A-1042`

#### Scenario: A follow-up keeps the title

- **WHEN** a top-level session's platform prompt and `archmax_set_variables` description are
  rendered
- **THEN** both ask for a rename only when the subject of the whole conversation has changed, and
  the prompt says to judge that against the whole conversation rather than the latest message and
  that a follow-up on the same subject keeps the title

#### Scenario: A code start state reads the trigger

- **WHEN** a code state declaring `triggers: { manual: , email_reply: }` runs as the first step of
  a session started through `email_reply`
- **THEN** its script reads `trigger` as `email_reply`, and a guard in that state referencing
  `${{trigger}}` resolves without a seed

### Requirement: Seeds are locked; locking is monotonic

Every host-supplied variable SHALL be seeded locked (`title` excepted) through one
construction, `buildSeededVariables`, whether it arrives as `createAgent`'s `variables`, a
delivery's variables or a call's arguments, so a guard bound to a seed cannot be invalidated
by the agent. A locked variable SHALL NOT be unlocked, deleted or rewritten by any tool, script
or grader; only a host seeding boundary (a turn start or a delivery) replaces a locked entry,
re-establishing the session's facts. Variables SHALL be checkpointed with the session and survive transitions,
parks and turn boundaries; successive writes in one state accumulate.

#### Scenario: Delivery re-seeds a locked name

- **WHEN** a delivery into a parked session carries `reply_body` again
- **THEN** the new value replaces the old, stays locked, and the agent still cannot rewrite it

#### Scenario: An automated state cannot rewrite a seed

- **WHEN** a code state's script or a grader calls `archmax_set_variables` for a locked seed
- **THEN** the call is refused naming the variable, and nothing is written

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
substitution delivered. A grader's tool arguments SHALL be substituted as the agent's are. Calls
a script makes — an agent's `archmax_eval` or `archmax_run` script, or a code state's script —
are not substituted.

#### Scenario: Negative index and prototype guard

- **WHEN** `order.items` holds two entries and references are `${{order.items.-1.sku}}`,
  `${{order.items.-3.sku}}` and `${{tags.length}}`
- **THEN** the first resolves to the last item's `sku` and the other two are unresolved

#### Scenario: Non-scalar in an argument

- **WHEN** `order` holds an object and the agent passes `"${{order}}"`
- **THEN** the call is refused naming the non-scalar result and the session continues

#### Scenario: A code state's script argument is not substituted

- **WHEN** a code state's script calls `tools.read_file({ file_path: "scratchpad/${{case_id}}.json" })`
- **THEN** the argument reaches governance verbatim, with no lookup

### Requirement: The variable tools

`archmax_get_variables` SHALL take optional `name` and `path`; a blank or whitespace-only
argument counts as absent. With no `name` it returns every variable with its value and locked
flag; an unknown `name` is an error naming the set variables; a `path` that does not resolve
is an error rather than the whole value. `archmax_set_variables` SHALL take `variables` (name
to whole value; any JSON value, no sub-path write) and optional `lock`; it creates or replaces
each variable and locks them all when `lock` is true. A call SHALL be refused atomically —
nothing written — when it names no variables, uses an invalid name, targets a locked variable,
locks `title`, or writes a malformed `title`. Both tools SHALL be offered in every state of
every type, terminal states included — to the agent, to a grader and to a code state's script —
with the same arguments and refusals.

#### Scenario: Blank name reads everything

- **WHEN** the agent calls `archmax_get_variables({ name: "" })`
- **THEN** it receives every variable, not an unknown-variable error

#### Scenario: One bad key refuses the call

- **WHEN** one call writes `{ case_id: "K-9", title: "Refund" }` with `lock: true`
- **THEN** neither is written and the reason names `title`

#### Scenario: A code state's script reads what it wrote

- **WHEN** a code state's script calls `tools.archmax_set_variables({ variables: { case_id: "K-9" } })`
  and then `tools.archmax_get_variables({ name: "case_id" })`
- **THEN** the read returns `K-9`

### Requirement: A state's requires must be met before it is left

A state's `requires` SHALL list variable names that must be set before the state may be left.
The kernel SHALL block `archmax_advance` out of the state while any is unset (rule
`transition.requires`, evaluated before the edge), naming the unset variables, whoever calls it:
the agent, a grader or a code state's script. The block is recoverable — the caller sets them
and retries — and itself neither rejects the session nor routes `on_error`; an automated state
that then finishes without deciding fails as any undecided run does (see `automated-states`). A
seeded variable satisfies it without any action. The lint SHALL warn on a duplicated entry, and
SHALL NOT diagnose a required name nothing references. A
`${{…}}` guard reference that no seed, no `requires` (state or trigger) and not the built-in
`trigger` guarantees SHALL be a warning — at assembly, where the seeds are known, and in
`validate` without them — stating that the guard then rests on the agent having set it; an
`allow_always` reference adds that it binds in states reached before anything sets it.

#### Scenario: Exit blocked then permitted

- **WHEN** the active state declares `requires: [case_id]`, nothing set it, and the agent
  advances
- **THEN** the transition is refused naming `case_id`; once the agent sets it, the advance
  proceeds

#### Scenario: A code state's advance is held to requires

- **WHEN** a code state declares `requires: [case_id]` and its script calls
  `tools.archmax_advance({ to: "review", reason: "…" })` while `case_id` is unset
- **THEN** the call is refused naming `case_id` and nothing moves; once the script sets
  `case_id` and advances again, the transition is taken

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
slug; each code state's `script` — that it resolves inside the workflow's `scripts/`, exists on
the authoring backend and imports only from `@archmax-ai/harness/*`; every skills list against
the registry; kernel probes of `tools.allow` and `tools.allow_always` entries the runtime would
refuse (a write into a runtime-owned or offload area, the read-only authored zone, a path or
tool a `forbid_always` or `forbid` list denies, an entry naming `task`, an `archmax_run` path
outside every skill bundle, a path that names the authoring backend, a path inside a bundle the
state does not enable), each an error; sibling workflows named by `archmax_workflow_<slug>`
entries (missing or unusable spec, no `manual` entry, a non-slug target, a cycle, a chain past
the dispatcher's depth bound — errors; a disabled target — warning); and each
`tests/*.test.yaml` case (schema errors, a `trigger` id no start state declares, a `from:`
fixture missing or escaping `tests/`). It SHALL read no grader definition outside the spec and
report no unloadable-grader advisory, because a grader state is declared whole in the document.
The CLI SHALL print diagnostics to stderr, the verdict line (or, with `--json`,
`{ workflow, valid, diagnostics }`) to stdout, and exit 0 when valid, 1 when not, 2 on a usage
error; with no workflow argument it SHALL validate the workspace's only workflow and refuse when
there are several or none.

#### Scenario: Missing hook script

- **WHEN** a state declares `before: { script: hooks/x.js }` and `workflows/<slug>/hooks/x.js`
  does not exist
- **THEN** `validate` reports the unrecognized-key error for `before` and nothing about the
  file: no hook referent is resolved or checked

#### Scenario: Missing code-state script

- **WHEN** a code state declares `script: scripts/x.js` and `workflows/<slug>/scripts/x.js` does
  not exist
- **THEN** `validate` reports an error naming the state and the resolved path

#### Scenario: A code-state script with a foreign import

- **WHEN** a code state's script imports from `node:fs`
- **THEN** `validate` reports an error naming the state, the script and the import

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

### Requirement: A typed return is checked where it is written

When an `archmax_set_variables` call — the agent's, a grader's or a code state's script's —
writes a variable that the current turn's trigger declares as a **typed** entry of its
`returns`, the runtime SHALL refuse the call — atomically, nothing written — if the value does
not conform to the declared type, naming the variable, its type, the trigger that declares it
and the kind of value that arrived. The refusal SHALL be a correctable tool refusal, not a
governance failure: the session continues and the caller may write a conforming value. A
variable no typed return of the current turn's trigger names SHALL be written as today, whatever
it holds.

#### Scenario: A mistyped return is refused at the write

- **WHEN** the session's trigger declares `returns: [{ name: approved, type: boolean }]` and the
  agent calls `archmax_set_variables({ variables: { approved: "yes" } })`
- **THEN** the call is refused naming `approved`, `boolean` and the trigger, nothing is written,
  and the session continues

#### Scenario: A conforming return is written

- **WHEN** the agent then calls `archmax_set_variables({ variables: { approved: true } })`
- **THEN** `approved` is set to `true`

#### Scenario: An undeclared variable is written freely

- **WHEN** the agent writes `scratch: { a: 1 }` and no typed return names `scratch`
- **THEN** the write succeeds

#### Scenario: A code state's mistyped return is refused the same way

- **WHEN** under the same trigger a code state's script calls
  `tools.archmax_set_variables({ variables: { approved: "yes" } })`
- **THEN** the call is refused naming `approved`, `boolean` and the trigger, and nothing is
  written

## REMOVED Requirements

### Requirement: Hook shape

**Reason**: `before` and `after` are removed from the state schema. Grading and deterministic
checks are states on the graph (`grader` and `code`), so the hook union (`{ script }`,
`{ rubric }`, custom kinds), the `max_iterations` sidecar, the inline rubric declaration and the
`hooks/` path grammar have nothing left to describe. A leftover key fails loading as an
unrecognized key (see "A leftover before or after key fails loading").

**Migration**: Rewrite each `before` check as a code state in front of the state, and each
`after` check as a code state behind it, moving the script from `workflows/<slug>/hooks/` to
`workflows/<slug>/scripts/` and naming it with `script:` (see "A code state declares its
script"). Rewrite each `{ rubric: … }` as a grader state whose `instructions` are the rubric's
and whose transitions lead on and send back. A grader that gives up after N rounds says so in
its instructions and counts the rounds in the trail. A custom hook kind becomes a host tool that
a code state's script calls.

## RENAMED Requirements

- FROM: `### Requirement: Settings, tests, runtime, extensions and metadata`
- TO: `### Requirement: Settings, tests, runtime and metadata`
