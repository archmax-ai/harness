## MODIFIED Requirements

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
workflow-wide grant, an empty `allow` being no denial at all; the default tools and the absent/declared rule for
`tools.allow_always` (absent, the default tools are granted in every state; declared, an empty
list included, exactly what it lists is), and that `task` is grantable by nothing; that a new
workflow's `workflow.yaml` lists every default tool under `tools.allow_always`, removing only those
the workflow must not have; the authoring backend split (the agent cannot read
`workflows/**`; hook scripts in `workflows/<slug>/hooks/`, data in skill bundles, and the scripts
the agent runs with `archmax_run` in a skill bundle or beside their workflow — any authored file
except a hook, a spec or a case, never a session or mount file; `scratchpad/` as the one working area); the hook contract (a default-export
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

#### Scenario: Skill scaffolds a workflow with the default tools listed

- **WHEN** an agent follows the skill to scaffold a new workflow
- **THEN** the produced `workflow.yaml` declares `tools.allow_always` listing `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `copy_file`, `move_file`, `remove_file`, `write_todos`, `archmax_eval` and `archmax_run` (less any the workflow must not have), and the skill's skeleton declares no empty `tools.allow_always`
