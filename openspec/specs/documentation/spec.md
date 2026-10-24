# documentation Specification

## Purpose

Define the documentation the archmax harness ships as part of the product: the Astro Starlight site under
`docs/`, the `README.md`, and the authoring skill under `skills/archmax-harness/` that teaches a coding
agent to author a workspace and wire the runtime. All three describe the current code, use one
term per concept as the glossary defines it, and change in the same commit as the behaviour they
describe, so none of them drifts.

## Requirements

### Requirement: Astro Starlight documentation site

The project SHALL provide a documentation site built with Astro and the Starlight integration in
a self-contained `docs/` project at the repository root, buildable to static HTML with
`npm run docs:build` (from the root) and previewable with `npm run docs:dev`. The build SHALL
exit zero with every sidebar entry resolving to an existing page.

#### Scenario: Building the site produces static output

- **WHEN** a maintainer runs `npm run docs:build`
- **THEN** Astro compiles the Starlight site to static HTML under `docs/dist/`
- **AND** the build exits zero with no missing sidebar targets

#### Scenario: Previewing the site locally

- **WHEN** a maintainer runs `npm run docs:dev`
- **THEN** a local dev server serves the site with live reload

### Requirement: Documentation information architecture

The Starlight configuration (`docs/astro.config.mjs`) SHALL define a sidebar with Getting
Started, Guides, Reference, and Contributing sections, and SHALL set the site title, description,
a GitHub social link, and an edit link pointing at the `docs/` source on the default branch. The
Reference section SHALL carry the configuration, CLI, machine-spec, glossary, public-API and
changelog pages; the Guides section SHALL cover the workflow machine, the authoring plane,
triggers, skills, grader and code states (`guides/automated-states.md`), sub-workflows, sessions,
the code interpreter, the CLI, testing, and token efficiency.

No page SHALL present a removed concept as current behaviour: a `subagents/` directory, a
`SUBAGENT.md` file, a `before` or `after` hook of any kind (`script`, `rubric`, `subagent` or a
custom kind), a hook verdict (`ok`, `correct`, `veto`), an agent-callable `task` tool, a
`max_iterations` or `max_corrections` key, an `extensions` block, the `hookExecutors` option, the
`rubric` model role, a runtime contract `1` or `2`, or an `editor:` spec block.

#### Scenario: Sidebar exposes the core sections

- **WHEN** a reader opens the site
- **THEN** the sidebar presents Getting Started, Guides, Reference, and Contributing
- **AND** every entry resolves to an existing content page

#### Scenario: The grading guide replaces the subagent guide

- **WHEN** a reader looks for how a session's work is graded or checked before the session moves on
- **THEN** the Guides section offers the grader and code states page (`guides/automated-states.md`),
  and no page documents grading rubrics, hooks or subagents

### Requirement: The glossary is the vocabulary law

The site SHALL carry a glossary (`reference/glossary.md`) naming one term per concept — session,
turn, state, human state, **automated state**, **grader state**, **code state**, case, grade,
mount, zone, authoring backend, park, decide/reply/deliver, runtime note, trail, **history**, state
flow, archmax harness/runtime/kernel/Deep Agents — and every page, README section, skill file, CLI
message and identifier SHALL use those terms. A page that uses a different word for one of those
concepts is a defect. "Subagent" SHALL NOT be one of the terms: what grades a session's work is a
grader state, and what runs a delegated process is a sub-workflow. The glossary SHALL carry no
entry for hook, verdict, grading rubric or iteration budget. It SHALL keep **trail** (the
checkpointed audit trail) distinct from **history** (the full transcript and trail that
`archmax_get_history` returns to a grader and to a code state's script alike).

#### Scenario: A page uses the glossary term

- **WHEN** a page refers to the durable conversation a workflow runs in
- **THEN** it says "session", not "run" or "thread"

#### Scenario: The grader is named consistently

- **WHEN** a page refers to the state that grades a session's work before the session moves on
- **THEN** it says "grader state" (and "grader" for what that state runs), never "grading rubric",
  "hook" or "judge"

#### Scenario: Automated states are named consistently

- **WHEN** a page refers to grader and code states together, or to a deterministic check a
  workflow runs between two states
- **THEN** it says "automated state" for the pair and "code state" for the check, never "hook",
  "gate" or "guard"

#### Scenario: History and trail stay distinct

- **WHEN** a page refers to what `archmax_get_history` returns
- **THEN** it says "history", and it uses "trail" only for the checkpointed audit trail the
  history contains

#### Scenario: The software is named consistently

- **WHEN** a page refers to the package as a whole
- **THEN** it says "archmax harness" (or "the harness" once the full name is established), never
  "the framework" or "the platform"

#### Scenario: The parts of the software are named consistently

- **WHEN** a page refers to what executes a session or decides whether a tool call or a
  transition is allowed
- **THEN** it says "the runtime" or "the kernel", not "the harness"

### Requirement: The public-API page matches the barrel

`reference/public-api.md` SHALL list every export of the root barrel (`src/index.ts`) by name and
nothing that the barrel does not export, and a unit test (`src/index.test.ts`) SHALL check the
two against each other in both directions so they cannot drift. The page SHALL name the three
subpath modules (`@archmax-ai/harness/sandbox`, `@archmax-ai/harness/testing`, `@archmax-ai/harness/cli`) as separate
surfaces.

#### Scenario: An export is added without documentation

- **WHEN** a symbol is exported from the barrel but not listed on the page
- **THEN** the unit test fails, naming the symbol

#### Scenario: A documented name leaves the barrel

- **WHEN** the page lists a backticked name the barrel no longer exports
- **THEN** the unit test fails, naming the stale entry

### Requirement: The changelog records releases

The site SHALL carry a changelog (`reference/changelog.md`) with one section per release, newest
first, each a short summary that links to the guides describing the current behaviour. A release
that removes or renames part of the authoring surface, the CLI or the public API SHALL say so and
what replaces it. Guides SHALL describe present behaviour and SHALL NOT carry
"removed"/"renamed"/"used to" prose; that history belongs to the changelog and the GitHub release
notes.

#### Scenario: A breaking release lands

- **WHEN** a change removes or renames part of the authoring surface, the CLI or the public API
- **THEN** the release's changelog section names what changed and what replaces it, linking to
  the guide

### Requirement: GitHub Pages build and deploy workflow

The repository SHALL include a GitHub Actions workflow (`.github/workflows/docs.yml`) that builds
the site and deploys it to GitHub Pages on push to the default branch and on manual dispatch,
granting only `contents: read`, `pages: write` and `id-token: write`, under a `pages` concurrency
group, and building only the `docs/` project.

#### Scenario: Push to main deploys the site

- **WHEN** a commit lands on the default branch
- **THEN** the workflow installs dependencies, builds the site, uploads it via
  `actions/upload-pages-artifact` and deploys it via `actions/deploy-pages`

#### Scenario: Docs build stays independent of the library build

- **WHEN** the documentation workflow runs
- **THEN** it does not require or alter the published `@archmax-ai/harness` package build

### Requirement: Documentation ships with the behaviour it describes

The project SHALL maintain the convention, stated in `openspec/config.yaml`, that a change to
user-facing behaviour — the CLI, configuration, the authoring surface (`workflow.yaml` schema,
grader and code states, the code-state script contract, governance, human states, cases, sandbox
contracts), or the public API — updates the relevant `docs/` pages, `README.md` and
`skills/archmax-harness/` in the same change. Proposals SHALL name the affected pages in their
Impact section and task lists SHALL carry an explicit task for each.

#### Scenario: A user-facing change includes documentation tasks

- **WHEN** a change modifies user-facing behaviour
- **THEN** its `tasks.md` includes tasks for the corresponding `docs/` pages, for `README.md`
  when the change matters to SDK users, and for `skills/archmax-harness/` when the authoring surface moved

### Requirement: README as product

`README.md` SHALL state what the archmax harness is, how to install it, a quickstart, how to run a
workflow from the CLI, where the authoring skill ships, and where the full documentation lives, and
SHALL NOT duplicate guide content. Its API examples SHALL use `createAgent`, `agent.workflow.send`
and the current export names.

The quickstart SHALL be the SDK example `examples/refund/`, a refund desk in four states: the agent
state `decide` looks the customer up with the host tool `lookup_customer`, records `decision` and
drafts `scratchpad/email.md`; the code state `check-decision` checks the decision against the
policy and sends a wrong one back to `decide`; the grader state `review-email` judges the email;
and the terminal agent state `send` sends it with the host tool `send_email`. The quickstart SHALL
show the example's `workflow.yaml`, its code-state script, its host tools (`tools.js`) and the
program that runs it (`index.js`, `createAgent({ workflow, tools, workspace })` and
`agent.workflow.send(id, { message, variables })`), each code block identical to the example's
file. A behaviour test (`src/behaviour/refund-example.test.ts`) SHALL run the example's workflow,
script and tools with a scripted model, and SHALL fail when a README block differs from the file it
shows.

The README's CLI section SHALL point at `examples/customer-support/`, the reference workspace the
CLI and the end-to-end suite run against: the refund example needs host tools, which the CLI does
not supply, so it runs from the host's code.

#### Scenario: README stays a front door

- **WHEN** a reader opens the README
- **THEN** they find install, the refund quickstart, the CLI section and links into the docs site,
  with the detail left to the guides

#### Scenario: The quickstart is the example's code

- **WHEN** a code block of the README's quickstart differs from the file under `examples/refund/`
  it shows
- **THEN** `src/behaviour/refund-example.test.ts` fails, naming that file

#### Scenario: The quickstart's trail is the one it prints

- **WHEN** the behaviour test runs the refund workflow for `ann@example.com`, whose order is
  delivered, and the agent approves the refund
- **THEN** the session completes with the trail `trigger → decide`, `agent → check-decision`,
  `code → review-email`, `grader → send`, the trail the README shows

#### Scenario: The check sends a wrong decision back before any grading

- **WHEN** the agent approves the refund for `bob@example.com`, whose order has only shipped
- **THEN** `check-decision` sends the session back to `decide` with the reason "Order ORD-1002 is
  shipped, so the refund must be denied.", and the grader runs only on the corrected email

#### Scenario: The CLI section runs the reference workspace

- **WHEN** a reader follows the README's CLI section
- **THEN** it runs `archmax run`, `archmax test` and `archmax validate` against
  `examples/customer-support/`, and says that the refund example runs from code because it needs
  host tools

### Requirement: Distributable authoring skill

The project SHALL provide one Agent Skill under `skills/archmax-harness/` — a `SKILL.md` with frontmatter
(`name`, `description`) and a concise playbook body, plus `references/workflow-schema.md`,
`references/code-states-and-scripts.md`, `references/cases.md`, `references/backend-integration.md` and a
`README.md` with the `npx skills add` command, license and safety notes. The build SHALL copy it to
`dist/authoring-skill/archmax-harness/` and the package SHALL export `BUNDLED_AUTHORING_SKILL_DIR`, the
`dist/authoring-skill` directory holding `archmax-harness/`. The published package SHALL also ship the
source directory as `skills/archmax-harness/`, where the skills CLI discovers it in an installed package.
It SHALL be the repository's only skill the skills CLI lists: contributor skills under `.claude/skills/`
SHALL carry `metadata.internal: true`. The install documentation (README, installation page, the
skill's `README.md`) SHALL present `npx skills add archmax-ai/harness` as the primary path for external
users, the packaged copy as the version-matched path, and a checkout as the development path.

#### Scenario: Skill ships in the published package

- **WHEN** the package is installed from a registry or tarball
- **THEN** `<BUNDLED_AUTHORING_SKILL_DIR>/archmax-harness/SKILL.md` and
  `skills/archmax-harness/SKILL.md` exist in the package and match the repository state it was built from

#### Scenario: Skill is installable from GitHub

- **WHEN** a developer runs `npx skills add archmax-ai/harness`
- **THEN** the skills CLI finds exactly one skill, `archmax-harness`, and installs it into the coding
  agent's skill directory

#### Scenario: Skill is installable from the installed package

- **WHEN** a developer runs `npx skills add ./node_modules/@archmax-ai/harness` or
  `npx skills experimental_sync` in a project that depends on the package
  (or `npx skills add ./skills/archmax-harness` in a checkout)
- **THEN** the skill installs into the coding agent's skill directory at the installed SDK version

### Requirement: The skill covers the whole authoring surface

The skill SHALL teach, from the current code: the two-file workflow (`workflow.yaml` as the strict,
authoritative machine; `WORKFLOW.md` as prose with no frontmatter) and the spec-rendered graph
section; every root and state key of the schema, slugs versus titles, `disabled`, state budgets
(`timeoutMs` and `maxParks`), `on_error`, transitions with the `description` every edge carries
and their types, the four state types (`agent`, `human`, `grader`,
`code`) and the keys each reads, human states, terminal states; the `metadata` slot at the
root and on a state (free-form host data the runtime never reads); triggers (`manual`, several
per state, the state's `triggers` mapping keyed by trigger id with `session`, `message`,
`connection`, `requires`, `returns`, and that a trigger is declared nowhere else); variables (`${{…}}`
guards, agent-side interpolation with the `$${{…}}` escape, `requires`, the reserved `trigger`
and `title`); **tool and skill governance as one symmetric model** — `allow_always` and
`forbid_always` at the root, `allow` and `forbid` on a state, for `tools` and `skills` alike; that a
grant composes additively while a denial beats every grant and no narrower level widens one; that a
forbid entry may name the tool `*`; that a state's `forbid` is how a state opts out of a
workflow-wide grant, an empty `allow` being no denial at all; the default tools and the absent/declared rule for
`tools.allow_always` (absent, the default tools are granted in every state; declared, an empty
list included, exactly what it lists is), the tools no automated state is offered (`write_todos`,
`archmax_eval`, `archmax_run`, `archmax_wait`, `archmax_reset`) even where `allow_always` lists
them, and that `task` is grantable by nothing; that a new workflow's `workflow.yaml` lists every
default tool under `tools.allow_always`, removing only those the workflow must not have; the
authoring backend split (the agent cannot read `workflows/**`; code-state scripts in
`workflows/<slug>/scripts/`, runtime scripts and data in skill bundles; `scratchpad/` as the one
working area); **code states** (`type: code` with `script: scripts/<file>.js`, and the code-state
script contract: a default-export function receiving `{ state, trigger, variables, tools }`,
moving the session with `tools.archmax_advance({ to, reason })` or ending it with
`tools.archmax_raise`, its return value not read, typed imports from `@archmax-ai/harness/sandbox`
such as `defineCodeState` and `CodeStateInput`; that it reads the session with
`JSON.parse(await tools.archmax_get_history())`, the history a grader reads: `{ messages, trail }`,
the session's whole transcript and trail, a tool entry carrying its tool, its call `id` and its
result as `text`; that its `tools.*` reach exactly its own state's tool surface, held
to that state's allow and forbid lists as an `archmax_run` script is, and to every workflow-wide
denial; that a terminal code state completes the session when its script returns, while a
non-terminal one that neither advances nor raises fails through `on_error`); **grader states**
(`type: grader` with `instructions`, an optional `model` and at least one transition; that a
grader reads the session only through `archmax_get_history`, which returns the whole transcript
and the trail, decides with `archmax_advance`, whose reason is what the next state reads, or ends
the session with `archmax_raise`; that it has no iteration budget, so instructions that bound
send-backs count them from the history's trail; that a grader belongs on work the agent hands on
(a report, a recorded decision), not on a live answer, since everything the agent says in a turn
is that turn's reply, a draft sent back included; that approving into a terminal code state ends
the session with no further model call; and that no sandbox context has `task()`); that every
transition, whatever its state's type, carries a non-empty `description` saying when to take it,
the only thing the agent is told about the edge; that a chain of code states makes no model call;
that a turn, a runaway cycle of automated states included, is bounded by LangGraph's recursion
limit (`DEFAULT_RECURSION_LIMIT`, 400, unless the caller sets one), a grader's run by the same
limit and its `budget.timeoutMs`, and that neither a state nor the workflow declares a count of
model calls; sub-workflows, including that a child inherits every ancestor's workflow-wide denials and no per-state list; cases (the strict YAML grammar, `title`/`description`,
`trigger`/`variables`/`workspace` with `from:` fixtures, `mocks`, the flat `steps` list, `grade`,
the `tests:` block); and the verify loop `archmax validate` → fix → `archmax test`. It SHALL teach
sequential execution only (no `parallel`/`join`) and SHALL declare the runtime contract it targets
(`engine: archmax-harness`, `version: "3"`).

It SHALL stay concise: `SKILL.md` holds the procedure and routes each task to one short
reference, and the skill shows one example per idea — one complete code-state script and one
grader-state example — rather than variations of either.

It SHALL teach one form per concept and no superseded one: no `subagents/` directory or
`SUBAGENT.md`, no `before`/`after` hook of any kind (`script`, `rubric`, `subagent` or a custom
kind), no `max_iterations` or `max_corrections`, no `extensions` block, no `hookExecutors` option,
no `editor:` block, no root `triggers:` block or singular state `trigger:`, no root `skills.allow`
ceiling model, no `policy:` block, no root `budget` and no `toolCalls` query in a code state's
input. The state keys `before` and `after`, the `extensions` block, a `runtime.version` of `1` or
`2`, the root `skills.allow` ceiling, the `policy:` block and the root `budget` are load errors,
and the skill SHALL say so where an author might reach for them. For `before`/`after` it
SHALL give the rewrite: a `before` check becomes a code state in front of the state, an `after`
check a code state behind it, and a rubric a grader state. It SHALL carry no migration recipe for
legacy JS cases, and no hook verdict vocabulary (`ok()`, `veto()`, `correct()`, `t.check` and its
kin) or verdict return shape (a bare `false`, `{ ok: false }`).

#### Scenario: Skill produces a schema-valid scaffold

- **WHEN** an agent follows the skill to scaffold a workflow
- **THEN** the produced `workflow.yaml` loads under the strict schema and `archmax validate`
  reports no error, and any produced cases parse under the case schema

#### Scenario: Skill teaches the additive skills grant

- **WHEN** an agent follows the skill to give a workflow a capability every state needs
- **THEN** it declares `skills: { allow_always: [<slug>] }` at the root and names the slug on no
  state, and it reaches for a state's `skills.allow` only for a state-specific capability

#### Scenario: Skill teaches denial in the same two positions

- **WHEN** an agent follows the skill to keep one state away from a capability the workflow grants
  everywhere, or to deny a tool workflow-wide
- **THEN** it writes `skills: { forbid: [<slug>] }` on that state, respectively
  `tools: { forbid_always: [...] }` at the root — and never a `policy:` block (a load error), nor an
  empty `allow` list as a way to deny

#### Scenario: A leftover hook is rewritten as grader and code states

- **WHEN** an agent following the skill meets a `before` or `after` hook, in a workflow
  `archmax validate` rejects for the unrecognized key or in its own plan
- **THEN** the skill offers no hook example and has it rewrite a `before` check as a code state in
  front of the state, an `after` check as a code state behind it, and a rubric as a grader state,
  with `runtime.version` set to `"3"` or omitted

#### Scenario: Code-state example follows the contract

- **WHEN** an agent follows the skill to add a deterministic check to a workflow
- **THEN** it declares a `type: code` state with `script: scripts/<file>.js`, places the file under
  `workflows/<slug>/scripts/`, and the file's default export moves the session with
  `tools.archmax_advance` or ends it with `tools.archmax_raise`, returning no verdict

#### Scenario: One example of each automated state

- **WHEN** the skill is searched for complete code-state scripts and for grader-state declarations
- **THEN** it holds one complete code-state script and one grader-state example, not variations
  of either

#### Scenario: Grading example follows the current model

- **WHEN** an agent follows the skill to have the work a state hands on graded
- **THEN** it declares a `type: grader` state with `instructions`, routes the graded state's
  transition into it, gives it transitions back to the graded state and onward, and declares no
  rubric, no `before`/`after` slot and no grader file, directory or root block

#### Scenario: Trigger example follows the current model

- **WHEN** an agent follows the skill to wire a trigger with a session path and a signature
- **THEN** it declares them under the entering state's `triggers:` mapping, and the skill
  documents no root block and no `entry:` key

#### Scenario: No superseded form is taught

- **WHEN** the skill is searched for a superseded authoring form
- **THEN** it teaches none of them as current, and points at the changelog for what changed

#### Scenario: Skill scaffolds a workflow with the default tools listed

- **WHEN** an agent follows the skill to scaffold a new workflow
- **THEN** the produced `workflow.yaml` declares `tools.allow_always` listing `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `copy_file`, `move_file`, `remove_file`, `write_todos`, `archmax_eval` and `archmax_run` (less any the workflow must not have), and the skill's skeleton declares no empty `tools.allow_always`

### Requirement: The skill teaches the wiring API as it is

`references/backend-integration.md` SHALL teach `createAgent` with Deep Agents' own option names
plus `workflow`, `workspace` (`rootDir`, `mounts`, `sessionStore`) and
`authoring` (the backend serving `workflows/**`, that is specs, `WORKFLOW.md`, code-state scripts
and cases, to the runtime only); `modelFactory` and its roles (`agent`, `judge`, `grader`), a
grader state's model being resolved under `grader`; that `workflow: false` declares a plain Deep
Agent, while an omitted `workflow` looks for the default workflow and is governed by it when found;
the `agent.workflow.*` surface
(`send`, `decide`, `reply`, `deliver`, `resolveSession`, `resolveTrigger`) and the session-level
members on the agent (`sessions`, `emitRunArtifacts`, `getSpecSnapshot`, `dispose`); the
`onEvent` stream, including the `code-*` and `grader-*` events that bracket an automated state's
run; the session artifacts (`graph.json`, `trail.json`, `variables.json`,
`metadata.json`); and token accounting via `model-usage` events (a grader's calls included),
`createUsageTracker` and the `pricing` option. Every code path or export it names SHALL exist in
the current source, so it names no `hookExecutors` option and no `rubric` model role.

#### Scenario: Wiring example is Deep Agents-shaped

- **WHEN** an agent reads the assembly example
- **THEN** it calls `createAgent({ workflow, workspace, onEvent, … })` and reaches session
  handles at `agent.sessions`

#### Scenario: Human-in-the-loop resumption

- **WHEN** a session parks at a human state
- **THEN** the reference shows reading the pending decision from the `Outcome`, listing its
  transitions, and resuming with `agent.workflow.decide(sessionId, { target, comment })`

#### Scenario: Graders on their own model

- **WHEN** an agent reads how to run grader states on a different model from the session's agent
- **THEN** the reference shows a `modelFactory` that answers the `grader` role, and names no
  `rubric` role and no `hookExecutors` option

### Requirement: Mandatory JSDoc header on authored code files

The skill SHALL instruct that every JavaScript file authored in a workspace — code-state scripts
and `archmax_run` sources — opens with a JSDoc block: a one-line title, a blank line, and a prose
description of what the code reads, the sequence it performs, and each outcome (for a code state,
the condition for each transition it advances to and for each raise). Cases, being YAML, SHALL
carry the same depth in their mandatory `description`. The skill SHALL state accurately that
`archmax validate` enforces the case `description` while the JSDoc header is an authoring
standard, and every complete file example the skill ships SHALL model it.

#### Scenario: The rule names the two kinds of workspace JavaScript

- **WHEN** an agent asks the skill how to head a hook script
- **THEN** the skill teaches no hook script, and its JSDoc rule names the two kinds of JavaScript a
  workspace holds: code-state scripts and `archmax_run` sources

#### Scenario: Agent authors a code-state script that satisfies the rule

- **WHEN** an agent follows the skill to write a code state's script
- **THEN** the file opens with a title-plus-description JSDoc block naming the inputs read and
  the condition for each transition it advances to and each raise

### Requirement: The skill reconstructs a case's inputs from previous sessions

The skill SHALL direct an agent writing a case for a variable-driven workflow to read a previous
session (`archmax sessions`, `archmax sessions <id>`, or `sessions/<id>/artifacts/variables.json`)
rather than invent a payload: the recorded `trigger` becomes `trigger: { id }`, every other locked
entry becomes a `variables:` seed, and unlocked entries are asserted, never seeded — because seeds
are locked, so seeding an agent-established name hides a missing `archmax_set_variables` call and
makes the agent's own write fail. With no previous session, the fallback is the host's
`createAgent({ variables })` and `deliver(…)` call sites plus the workflow's `${{…}}` references
and `requires:` lists.

#### Scenario: Agent recovers a trigger payload before writing a case

- **WHEN** an agent writes a case for a trigger-started workflow
- **THEN** the skill has it read a matching session's variables first and map locked entries to
  seeds and unlocked ones to assertions
