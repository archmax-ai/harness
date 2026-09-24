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
triggers, skills, grading rubrics, sub-workflows, sessions, the code interpreter, the CLI, testing, and
token efficiency.

No page SHALL present a removed concept as current behaviour: a `subagents/` directory, a
`SUBAGENT.md` file, an `after: { subagent: … }` hook, an agent-callable `task` tool, a
`max_corrections` key, or an `editor:` spec block.

#### Scenario: Sidebar exposes the core sections

- **WHEN** a reader opens the site
- **THEN** the sidebar presents Getting Started, Guides, Reference, and Contributing
- **AND** every entry resolves to an existing content page

#### Scenario: The grading guide replaces the subagent guide

- **WHEN** a reader looks for how a state's output is graded
- **THEN** the Guides section offers a grading-rubrics page, and no page documents subagents

### Requirement: The glossary is the vocabulary law

The site SHALL carry a glossary (`reference/glossary.md`) naming one term per concept — session,
turn, state, human state, hook, **grading rubric**, verdict, iteration budget, case, grade, mount,
zone, authoring backend, park,
decide/reply/deliver, runtime note, trail, state flow, archmax harness/runtime/kernel/Deep Agents — and
every page, README section, skill file, CLI message and identifier SHALL use those terms. A page
that uses a different word for one of those concepts is a defect. "Subagent" SHALL NOT be one of
the terms: what grades a state's exit is a grading rubric, and what runs a delegated process is a
sub-workflow.

#### Scenario: A page uses the glossary term

- **WHEN** a page refers to the durable conversation a workflow runs in
- **THEN** it says "session", not "run" or "thread"

#### Scenario: The grader is named consistently

- **WHEN** a page refers to what grades a state's exit
- **THEN** it says "grading rubric", never "subagent" or "judge"

#### Scenario: The software is named consistently

- **WHEN** a page refers to the package as a whole
- **THEN** it says "archmax harness" (or "the harness" once the full name is established), never
  "the framework" or "the platform"

#### Scenario: The parts of the software are named consistently

- **WHEN** a page refers to what executes a session or decides a verdict
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
hooks, governance, human states, cases, sandbox contracts), or the public API — updates the
relevant `docs/` pages, `README.md` and `skills/archmax-harness/` in the same change. Proposals SHALL name
the affected pages in their Impact section and task lists SHALL carry an explicit task for each.

#### Scenario: A user-facing change includes documentation tasks

- **WHEN** a change modifies user-facing behaviour
- **THEN** its `tasks.md` includes tasks for the corresponding `docs/` pages, for `README.md`
  when the change matters to SDK users, and for `skills/archmax-harness/` when the authoring surface moved

### Requirement: README as product

`README.md` SHALL state what the archmax harness is, how to install it, a quickstart for the CLI and the
library, where the authoring skill ships, and where the full documentation lives, and SHALL NOT
duplicate guide content. Its API examples SHALL use `createAgent`, `agent.workflow.send` and the
current export names.

#### Scenario: README stays a front door

- **WHEN** a reader opens the README
- **THEN** they find install, a CLI and a library quickstart, and links into the docs site, with
  the detail left to the guides

### Requirement: Distributable authoring skill

The project SHALL provide one Agent Skill under `skills/archmax-harness/` — a `SKILL.md` with frontmatter
(`name`, `description`) and a concise playbook body, plus `references/workflow-schema.md`,
`references/hook-and-test-scripts.md`, `references/backend-integration.md` and a `README.md` with
the `npx skills add` command, license and safety notes. The build SHALL copy it to
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
section; every root and state key of the schema, slugs versus titles, `disabled`, budgets,
`on_error`, transitions and their types, human states, terminal states; the `metadata` slot at the
root, on a state and on a rubric (free-form host data the runtime never reads); triggers (`manual`, several
per state, the state's `triggers` mapping keyed by trigger id with `session`, `message`,
`connection`, `requires`, `returns`, and that a trigger is declared nowhere else); variables (`${{…}}`
guards, agent-side interpolation with the `$${{…}}` escape, `requires`, the reserved `trigger`
and `title`); **tool and skill governance as one symmetric model** — `allow_always` and
`forbid_always` at the root, `allow` and `forbid` on a state, for `tools` and `skills` alike; that a
grant composes additively while a denial beats every grant and no narrower level widens one; that a
forbid entry may name the tool `*`; that a state's `forbid` is how a state opts out of a
workflow-wide grant, an empty `allow` being no denial at all; always-on tools, and that `task` is
grantable by nothing; the authoring backend split (the agent cannot read
`workflows/**`; hook scripts in `workflows/<slug>/hooks/`, runtime scripts and
data in skill bundles; `scratchpad/` as the one working area); the hook contract (a default-export
function receiving `{ state, phase, trigger, variables, messages, tools }` and returning `ok()`,
`veto()` or `correct()`, throwing vetoes, typed imports from `@archmax-ai/harness/sandbox`), including that a
hook is bound by a workflow-wide denial and not by a state's; **grading
rubrics** (declared inline as a hook's value — `after: { rubric: { instructions, max_iterations?,
model? } }` — composed in a list beside scripts and other rubrics, duplicated rather than named when
two states share one, and never seen by the graded agent; and that no sandbox context has `task()`); sub-workflows, including that a child inherits every ancestor's workflow-wide denials and no per-state list; cases (the strict YAML grammar, `title`/`description`,
`trigger`/`variables`/`workspace` with `from:` fixtures, `mocks`, the flat `steps` list, `grade`,
the `tests:` block); and the verify loop `archmax validate` → fix → `archmax test`. It SHALL teach
sequential execution only (no `parallel`/`join`) and SHALL declare the runtime contract it targets
(`engine: archmax-harness`, `version: "2"`).

It SHALL teach one form per concept and no superseded one: no `subagents/` directory or
`SUBAGENT.md`, no `{ subagent: … }` hook, no `max_corrections`, no `editor:` block, no root
`triggers:` block or singular state `trigger:`, no root `skills.allow` ceiling model and no
`policy:` block — both are load errors, and the skill SHALL say so where an author might reach for
them — no migration
recipe for legacy JS cases, and no legacy hook-verdict vocabulary (`t.check` and its kin) or return
shape (a bare `false`, `{ ok: false }`).

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

#### Scenario: Hook example follows the contract

- **WHEN** an agent follows the skill to write a hook script
- **THEN** the file is under `workflows/<slug>/hooks/`, wired as `{ script: hooks/<file>.js }`,
  and default-exports a function returning a verdict

#### Scenario: Grading example follows the current model

- **WHEN** an agent follows the skill to have a state's reply graded
- **THEN** it declares the rubric inline on that state's `after` hook, and the skill documents no
  grader file, directory or root block

#### Scenario: Trigger example follows the current model

- **WHEN** an agent follows the skill to wire a trigger with a session path and a signature
- **THEN** it declares them under the entering state's `triggers:` mapping, and the skill
  documents no root block and no `entry:` key

#### Scenario: No superseded form is taught

- **WHEN** the skill is searched for a superseded authoring form
- **THEN** it documents none of them, and points at the changelog for what changed

### Requirement: The skill teaches the wiring API as it is

`references/backend-integration.md` SHALL teach `createAgent` with Deep Agents' own option names
plus `workflow`, `workspace` (`rootDir`, `mounts`, `sessionStore`) and
`authoring`; that omitting `workflow` yields a plain Deep Agent; the `agent.workflow.*` surface
(`send`, `decide`, `respond`, `deliver`, `resolveSession`, `resolveTrigger`) and the session-level
members on the agent (`sessions`, `emitRunArtifacts`, `getSpecSnapshot`, `dispose`); the
`onEvent` stream; the session artifacts (`graph.json`, `trail.json`, `variables.json`,
`metadata.json`); and token accounting via `model-usage` events, `createUsageTracker` and the
`pricing` option. Every code path or export it names SHALL exist in the current source.

#### Scenario: Wiring example is Deep Agents-shaped

- **WHEN** an agent reads the assembly example
- **THEN** it calls `createAgent({ workflow, workspace, onEvent, … })` and reaches session
  handles at `agent.sessions`

#### Scenario: Human-in-the-loop resumption

- **WHEN** a session parks at a human state
- **THEN** the reference shows reading the pending decision from the `Outcome`, listing its
  transitions, and resuming with `agent.workflow.decide(sessionId, { target, comment })`

### Requirement: Mandatory JSDoc header on authored code files

The skill SHALL instruct that every JavaScript file authored in a workspace — hook scripts and
`archmax_run` sources — opens with a JSDoc block: a one-line title, a blank line, and a prose
description of what the code reads, the sequence it performs, and each outcome (for a hook, the
condition producing each verdict). Cases, being YAML, SHALL carry the same depth in their mandatory
`description`. The skill SHALL state accurately that `archmax validate` enforces the case
`description` while the JSDoc header is an authoring standard, and every complete file example
the skill ships SHALL model it.

#### Scenario: Agent authors a hook script that satisfies the rule

- **WHEN** an agent follows the skill to write a hook
- **THEN** the file opens with a title-plus-description JSDoc block naming the inputs read and
  the condition for each verdict

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
