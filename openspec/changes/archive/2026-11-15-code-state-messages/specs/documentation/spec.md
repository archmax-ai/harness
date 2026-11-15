## MODIFIED Requirements

### Requirement: The skill covers the whole authoring surface

The skill SHALL teach, from the current code: the two-file workflow (`workflow.yaml` as the strict,
authoritative machine; `WORKFLOW.md` as prose with no frontmatter) and the spec-rendered graph
section; every root and state key of the schema, slugs versus titles, `disabled`, state budgets
(`timeoutMs` and `maxParks`), `on_error`, transitions with their `description` (left out only on
an agent state's lone edge into another agent state) and their types, the four state types (`agent`, `human`, `grader`,
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
result as `text`; that it says something to the person with
`tools.archmax_add_message({ text })`, an assistant message the session speaks, committed when the
run settles and discarded when it fails, and that a grader is never offered it; that its `tools.*`
reach exactly its own state's tool surface, held
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
the session with no further model call; and that no sandbox context has `task()`); that a
transition carries a non-empty `description` saying when to take it, the only thing the agent is
told about the edge, except an agent state's single edge into another agent state out of a state
with `instructions`, which needs none (never a filler like "Proceed") because the agent takes it
as soon as those instructions are done; that a chain of code states makes no model call;
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
