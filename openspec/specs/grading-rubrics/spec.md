# grading-rubrics Specification

## Purpose

Define how a workflow holds a state's exit to a written standard: a grading rubric declared
**inline on the lifecycle hook that applies it**, with no name, no file and no root block. A rubric
is criteria plus an optional budget and model; the runtime identifies one by its position in a
phase's hook list, builds its registry by walking the loaded spec, dispatches it under the `rubric`
model role against the runtime verdict schema, and applies the returned verdict like any other
hook's. The rubric is invisible to the session it grades and reachable by no script.

## Requirements

### Requirement: A grading rubric is declared on the hook that applies it

A workflow's graders SHALL be declared **inline as the value of a `{ rubric: … }` lifecycle hook**.
There SHALL be no separate file, directory, frontmatter dialect, or root block for a grader, and a
rubric SHALL have no name: it is not a first-order item in the machine — nothing routes to one,
nothing enumerates them, and no tool takes one — so reading a state SHALL tell a reader the whole
standard its exit is held to, with no lookup elsewhere.

Two states requiring the same grader SHALL declare it twice. The duplication is accepted
deliberately: a state legible on its own is worth more than a de-duplicated document.

A rubric declaration SHALL be a strict mapping whose only required key is:

- `instructions` — the grading criteria: what the work is measured against and the verdict to
  return. The key SHALL be named `instructions`, the same word a state uses for the prose telling a
  model what to do, so the document has one word for guidance.

and which further accepts:

- `max_iterations` (optional, non-negative integer) — the bounded number of times the
  grade-and-retry loop may run before a `correct` verdict becomes a hard veto. It is declared
  **inside** the declaration, not as a sidecar beside the kind key: the grader and its budget are
  one object, so there is one place to put it and no precedence to resolve.
- `model` (optional, non-empty string) — a model id the grader runs on, overriding the assembly's
  `rubric`-role model.
- `metadata` (optional) — the loose, runtime-inert host slot the spec accepts at the root, on a
  state and here (see the `workflow-spec` capability).

A rubric SHALL have no `title` and no `description`: nothing routes to a rubric, nothing labels one
in a prompt, and a host display label belongs in `metadata`. It SHALL have no `response_format`
either — a rubric only ever grades, so its output contract is the verdict schema and nothing else.

Any other key SHALL be a load error naming the key and its path, as everywhere else in the spec —
including `title`, `description`, `response_format` and `max_corrections`, each reported as the
unrecognized key it is with no mapping to a replacement. A `max_iterations` sidecar *beside* a
`rubric` key SHALL also be refused: the budget belongs inside the declaration.

#### Scenario: A rubric loads inline

- **WHEN** a state declares `after: { rubric: { instructions: …, max_iterations: 2 } }`
- **THEN** it loads with no error-severity issue, the machine is `usable`, and `archmax validate`
  reports the same spec clean

#### Scenario: Instructions alone are enough

- **WHEN** a rubric declares only `instructions`
- **THEN** it loads clean, and the rubric grades with the assembly's default budget and model

#### Scenario: Several graders on one state

- **WHEN** a state's `after` is a list of two `{ rubric: … }` hooks and a `{ script: … }` hook
- **THEN** it loads clean, and the hooks run in declaration order, short-circuiting on the first
  non-`ok` verdict

#### Scenario: Unknown key in a rubric declaration

- **WHEN** a rubric declares a key that is not `instructions`, `max_iterations`, `model` or
  `metadata` (for example `systemPrompt:`)
- **THEN** loading fails with an unrecognized-key error naming the key and its path, and
  `archmax validate` reports the same diagnostic

#### Scenario: A retired key is an ordinary unrecognized key

- **WHEN** a rubric declares `title:`, `description:`, `response_format:` or `max_corrections:`
- **THEN** loading fails with the standard unrecognized-key error naming the key and its path,
  carrying no suggestion of a replacement

#### Scenario: The budget may not sit beside the kind key

- **WHEN** a state declares `after: { rubric: { instructions: … }, max_iterations: 2 }`
- **THEN** loading fails: for a rubric the budget is declared inside the declaration

#### Scenario: A named rubric is not a rubric

- **WHEN** a state declares `after: { rubric: order-reply-tone }` — a string rather than a
  declaration — or the spec declares a root states' rubric hooks
- **THEN** loading fails, because a rubric is declared where it is applied and has no name

#### Scenario: Missing instructions

- **WHEN** a rubric declares `max_iterations` but no `instructions`
- **THEN** loading fails with an error naming the missing `instructions` key

### Requirement: A rubric's identity is its position

An inline rubric has no name, so the runtime SHALL identify one by **where it is declared**: its
state, its phase, and its index in that phase's hook list. That position SHALL be:

- the id the rubric is registered and dispatched under (`<state>--<phase>--<index>`);
- the label it appears under in operator-facing events (`rubric#<index>`);
- the key its grade-and-retry budget is counted against.

The budget key SHALL be positional rather than label-derived for every hook kind, so two rubrics in
one phase can never share a budget, and a script hook's budget does not move when the file is
renamed.

Reordering a phase's hook list SHALL therefore re-key its budgets. This is accepted: the edit
already changes the spec hash, and a session parked mid-retry across it resumes with a fresh
budget — failing open on a budget rather than closed on a transition.

#### Scenario: Two rubrics on one state are distinguishable

- **WHEN** a state declares two `{ rubric: … }` hooks in its `after` list and both are dispatched
- **THEN** the dispatches carry distinct ids ending `--0` and `--1`, their events carry `rubric#0`
  and `rubric#1`, and neither consumes the other's iteration budget

#### Scenario: A sibling that passes does not clear a sibling's count

- **WHEN** one `after` hook returns `ok` and another has already consumed an iteration
- **THEN** the consumed count survives, because the two are keyed separately

### Requirement: A state grades its exit with a rubric hook

A state SHALL gate its outgoing transition with `after: { rubric: <declaration> }`. The hook SHALL
behave exactly as any other `after` hook: its verdict (`ok`, `correct`, `veto`) controls the
transition, an error vetoes fail-closed, and its `max_iterations` bounds the retry loop.

A `before`/`after` field SHALL accept a rubric hook wherever it accepts any hook — alone, or in an
ordered list beside other rubrics and scripts.

A rubric hook SHALL also be usable as a `before` hook, where — like every `before` hook — its
vocabulary is `ok` and `veto` only.

#### Scenario: Rubric gates a transition

- **WHEN** a state declares `after: { rubric: { instructions: … } }` and the agent calls
  `archmax_advance`
- **THEN** the runtime dispatches that rubric and applies its returned verdict to the transition

#### Scenario: Correction requested

- **WHEN** the rubric returns `correct` and the iterations used for that state is below the
  effective `max_iterations`
- **THEN** the transition is rejected with the correction guidance and the count is incremented

#### Scenario: The declared budget bounds the loop

- **WHEN** a rubric declares `max_iterations: 1` and returns `correct` twice
- **THEN** the first rejection offers another attempt and the second is a hard veto

#### Scenario: Unparseable verdict fails closed

- **WHEN** a dispatched rubric returns output that cannot be parsed into an `ok`/`correct`/`veto`
  verdict
- **THEN** the transition is vetoed with a reason including a snippet of the raw output, never
  coerced to `ok`

### Requirement: A rubric is invisible to the run it grades

The prompt of a rubric SHALL NOT be reachable by the agent it grades. It lives in `workflow.yaml`,
which is served by the authoring backend and is not a route in the agent's workspace composite, so
no file tool, glob, or listing SHALL reach it.

The rendered graph section SHALL name a rubric hook by **kind only** (`rubric`) — never by rubric
name, and never with any part of its `instructions`, its iteration budget, or its `model`. No other
prompt section SHALL render the states' rubric hooks.

The agent SHALL have no tool with which to dispatch, enumerate, or inspect a rubric.

#### Scenario: The rubric block is not readable

- **WHEN** a state is graded by `after: { rubric: { instructions: … } }` and the agent calls
  `read_file`, `glob`, or `ls` on any path that would reach the workflow spec
- **THEN** no rubric content is returned, because the authoring plane is not a route in the agent's
  workspace

#### Scenario: The graph section names the kind, not the rubric

- **WHEN** the system prompt is rendered for a state declaring
  `after: { rubric: { instructions: … } }`
- **THEN** the graph section records that the state has an `after` hook of kind `rubric`, and the
  rendered prompt contains neither the rubric name nor any part of its `instructions`,
  `max_iterations`, or `model`

#### Scenario: No dispatch vocabulary

- **WHEN** any state of any assembly runs a model segment
- **THEN** the model request contains no tool with which a rubric could be dispatched or listed

### Requirement: The rubric registry is built from the loaded spec

The runtime SHALL build its rubric registry from the loaded machine spec at assembly, by **walking
the spec's states**: every `{ rubric: … }` in a `before` or `after` becomes one entry, keyed by its
position (see "A rubric's identity is its position"). It SHALL NOT read any workspace directory to
discover graders.

A workflow's rubrics SHALL be scoped to that workflow: a delegated child builds its registry from
its own spec, so it is graded by its own standards. Two states declaring identical criteria SHALL
produce two entries — "declared on the hook" holds at runtime too.

Every rubric dispatch SHALL request the runtime verdict schema (`{ verdict, reason }` with `verdict`
one of `ok`/`correct`/`veto`), **unconditionally** — not only when the rubric declares a budget.

A rubric only ever grades, so the verdict vocabulary is its whole output contract. Gating the schema
on the budget, as the subagent it replaces did, left a grader needing no retries with no schema at
all: it answered in prose, parsed to no verdict, and vetoed fail-closed on a transition its author
expected it to wave through.

The model a rubric runs on SHALL be supplied by the assembly's `modelFactory` under the `rubric`
role, defaulting to the env-configured model as every other role does. When the rubric declares a
`model`, that id SHALL be passed to the factory as the **requested** model alongside the role, so
one seam resolves every model the runtime uses:

- the **default factory** SHALL apply the requested id over the env-configured model, keeping the
  configured base URL and credentials, so a workspace gets per-rubric model choice with no wiring;
- a **host-supplied factory** SHALL receive the requested id and decide what to do with it — map it,
  refuse it, or ignore it — and a factory that ignores the argument SHALL keep the behaviour it has
  today.

A `model` id SHALL NOT be statically validated: the set of ids a host can serve belongs to its
environment, not to the document. An unusable id SHALL surface as a failed dispatch, which — being
an `after`-hook error — vetoes the transition fail-closed rather than grading with a fallback.

#### Scenario: Registry from the spec's states

- **WHEN** an agent is assembled for a workflow whose states declare two rubric hooks
- **THEN** both are registered for dispatch under their positional ids, and no workspace listing was
  performed to find them

#### Scenario: A workflow with no rubrics

- **WHEN** the loaded spec declares no states' rubric hooks
- **THEN** the registry is empty and no grader is registered

#### Scenario: Verdict schema applied to every dispatch

- **WHEN** a rubric with a declared `max_iterations` and a rubric without one are each dispatched
- **THEN** both dispatches request the runtime verdict schema as the grader's structured output

#### Scenario: Rubric role model

- **WHEN** an assembly supplies a `modelFactory` and no rubric declares a `model`
- **THEN** every rubric dispatch uses the model that factory returns for the `rubric` role, with no
  requested id

#### Scenario: A declared model reaches the factory

- **WHEN** a rubric declares `model: some-model-id` and is dispatched
- **THEN** the factory is called for the `rubric` role with `some-model-id` as the requested model

#### Scenario: The default factory applies the id

- **WHEN** a rubric declares a `model` and the assembly supplies no `modelFactory`
- **THEN** the grader runs on that model id against the env-configured base URL and credentials,
  and the assembly's other roles are unaffected

#### Scenario: A factory may ignore the request

- **WHEN** a host factory ignores the requested-model argument
- **THEN** rubric dispatch uses the model that factory returned, and no error is raised for the
  unhonoured request

#### Scenario: An unusable model id fails closed

- **WHEN** a rubric declares a `model` the host cannot serve and the hook runs
- **THEN** the dispatch errors and the transition is vetoed with the underlying failure as its
  reason, rather than being graded by a fallback model

#### Scenario: A model id is not statically checked

- **WHEN** `archmax validate` runs against a spec whose rubric declares any non-empty `model`
- **THEN** it reports no diagnostic about the id

### Requirement: Rubric dispatch is observable to the operator

The runtime SHALL emit a `rubric-start` event when a rubric is dispatched — carrying a `dispatchId`
unique within the assembled agent, the rubric name, and the governed state — and a matching
`rubric-result` event when the dispatch settles, carrying the same `dispatchId`, the rubric name, a
`status` of `ok` or `error`, and the elapsed `durationMs`.

These events are operator-facing: they reach the `onEvent` stream and the CLI's state-flow view, and
they SHALL NOT be rendered into any prompt.

#### Scenario: Dispatch bracketed

- **WHEN** a rubric is dispatched and completes
- **THEN** a `rubric-start` and a `rubric-result` event with the same `dispatchId` are emitted, in
  that order

#### Scenario: Failed dispatch

- **WHEN** a rubric dispatch fails
- **THEN** the `rubric-result` event carries `status: "error"`

### Requirement: No script dispatches a rubric

The sandbox SHALL provide no `task()` global in any context. An inline rubric has no name a script
could pass, so there is nothing to dispatch by, and no author-facing name SHALL be invented to keep
the global alive.

A hook script that needs a model verdict SHALL get a `rubric` hook declared beside it in the same
phase's list, so every model dispatch stays visible in the spec rather than reachable only by
reading a script.

The runtime's own dispatch is unaffected: a `{ rubric: … }` hook is dispatched through the framework
`task` tool, which exists because rubrics are registered with it and is disclosed to nobody.

#### Scenario: A hook script has no task global

- **WHEN** a lifecycle hook script references `task`
- **THEN** it is undefined, the script throws, and the phase vetoes fail-closed

#### Scenario: The declarative composition replaces it

- **WHEN** a state declares `after: [{ script: hooks/check.js }, { rubric: { instructions: … } }]`
- **THEN** the script runs first, and the rubric grades only if the script allowed the transition
