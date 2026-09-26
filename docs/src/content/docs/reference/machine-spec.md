---
title: Machine spec
description: The workflow.yaml schema, covering states, rubrics, budget, on_error, governance, tests, extensions, and metadata.
sidebar:
  order: 3
---

`workflows/<name>/workflow.yaml` is the enforced state machine, a pure YAML
mapping with these top-level keys:

`title`, `instructions`, `disabled`, `runtime`, `settings`, `tests`, `tools`,
`skills`, `mounts`, `extensions`, `metadata`, `states`.

This page documents the schema fields, focusing on those added by the core
refactor. For the conceptual model, see
[the workflow machine](/guides/workflow-machine/).

An **optional** `WORKFLOW.md` beside the spec is a prose addendum with **no
frontmatter**. It is appended to the system prompt after a workflow header. The
runtime renders that header deterministically from the loaded spec, as the
workflow's `title` and `instructions` (exported as `renderWorkflowPrompt(spec)`).

The graph itself is disclosed per model call, for the active state alone
(`renderStateGraph`). So what the model reads always matches what the kernel
enforces, and the states it sees are the ones it can advance to. See
[Token efficiency and cost](/guides/token-efficiency/).

`WORKFLOW.md` stays prose. A frontmatter block there alongside `workflow.yaml`
is a load **error** ("competing machines"). A directory without a
`workflow.yaml` does not load as a workflow.

## `instructions`: the workflow's standing instructions

```yaml
title: Order lookup
instructions: |-              # literal block, not folded — see the note below
  Order records live in skills/order-data/assets/orders.json; write every artifact under scratchpad/.

  Tenancy is absolute: only ever disclose or act on the requester's own
  company's orders.
```

Optional free-form markdown carrying direction that holds for the **whole
session**: conventions, house rules, what "done" means. It is rendered verbatim
as an `## Instructions` block at the top of the workflow section of the system
prompt, immediately after the workflow heading and before the graph.

Standing direction applies to every turn, so this block is sent on every model
call, whichever state is active. That puts it in the static, cacheable prompt
prefix. A state's `instructions` travel with the state instead.

Three scopes, three homes; keep guidance in exactly one:

| Guidance scope | Where it goes |
| --- | --- |
| Every workflow in the workspace | `AGENTS.md` |
| One workflow, for the whole session | the workflow's top-level `instructions` |
| One state's turn | that state's `instructions` |

Use a **literal** block scalar (`|-`) for multi-paragraph instructions. The text
is rendered into the prompt as markdown, and a folded scalar (`>-`) collapses
your blank lines into single newlines, which markdown then reads as one run-on
paragraph. Folded style suits the single-paragraph state `instructions`
elsewhere in the spec.

`archmax validate` **warns** when a spec declares no `instructions`: the workflow
ships no standing guidance, so conventions get repeated in every state. A value
that is present but is not a non-empty string is an **error**.

Leave the graph itself out. The states, transitions, and `archmax_advance`
mechanics are already rendered from the spec and covered by the platform prompt.

A top-level `description:` is a load/validate **error**: the root's text is
`instructions:`, written as direction. Transition, human-state and case
`description` fields are unaffected.

## States

```yaml
states:
  identify-case:            # the state's SLUG — its identity (see Slugs and titles)
    title: "Identify case"  # human-readable label; never a routing target
    instructions: "…"       # behavior guidance, surfaced while this state is active
    summary: "Route the request to exactly one path."  # label for people and hosts; not in the prompt
    triggers:               # marks this as a start state; several keys name several (see Triggers)
      manual:
    before: { script: hooks/check.js }  # tagged hook (see Lifecycle hooks)
    after:  { rubric: { instructions: "Judge the reply's tone." } }
    skills:
      allow: [order-data]   # capability slugs THIS state adds (see skills.allow_always)
    mounts:
      allow: [catalogs/eu]  # mount names THIS state adds (see mounts.allow_always)
    tools:
      allow:                # this state's grants; `forbid:` beside it denies
        - { tool: write_file, args: { file_path: [reports/answer.json] } }   # a governed session path;
                              # scratchpad/** is writable in every state, so an entry
                              # naming a path inside it narrows nothing there
    transitions:
      - to: orders-question
        description: "User is asking about orders."   # REQUIRED, non-empty
```

A state with **no `transitions`** is terminal. The turn ends when the agent
finishes there, and the volatile prompt block says so in place of the list.

### `transitions`: the only part of the graph the agent sees

Each entry is `{ to, description, type? }`:

| Key | Value |
| --- | --- |
| `to` | a declared state's slug |
| `description` | required, non-empty: when this edge applies |
| `type` | one of `approve`, `reject`, `refine`, `none` |

The agent is disclosed the active state's outgoing edges, so the description is
the whole of what it knows about where an edge leads. Write it for a reader
standing in the *source* state, which has no picture of the target:

```yaml
transitions:
  - to: refund-review
    description: The refund is over $50, or the customer has asked twice.   # when
  - to: orders-question
    description: Go to the orders-question state.                           # avoid: where
```

A missing, empty or mistyped `description` is a **load error** naming
`states.<slug>.transitions.<index>.description`. There is no fallback to the
target's `summary` or `instructions`.

An edge's rendered line marks a target that is a **human decision node** or
**terminal**, because each changes the call or what follows it. Both marks mean
the agent stops there. `evidence` may be attached when advancing to a human
state, and there alone:

```
Transitions — choose one with `archmax_advance` when this state's work is done:
- to `refund-review` (human decision node) — The refund is over $50, or the customer has asked twice.
- to `refund-closed` (approve, terminal) — The recorded decision is correct; close the case.
```

The line stops there. Everything else the target declares stays out of it:

- its `title`, `summary` and `instructions`;
- its hooks and its budget;
- its own transitions;
- and every state no edge from here reaches.

`triggers:` is a **mapping of trigger id to its declaration**: the one place a
trigger is declared. Each key makes the state the entry for that id, in the
order written. Each value is that trigger's declaration (see
[A trigger's declaration](#a-triggers-declaration)). A `null` value declares the
id and nothing more:

```yaml
states:
  triage:
    triggers:                                      # ids: manual, email_received
      manual:
      email_received:
        session: conversation_id
  intake:
    triggers:                                      # ids: outlook-mail, slack-message
      outlook-mail: { type: ap, piece: microsoft-outlook }
      slack-message: { type: ap, piece: slack }
```

An id is authored, so adding, reordering or deleting a declaration leaves every
other id as written.

A trigger has **at most one entry state**, so two states declaring one id is an
error naming both. Load additionally fails, naming the state and the id, on:

- a `triggers:` that is not a mapping;
- an empty trigger id;
- a value that is neither a mapping nor empty;
- an `entry:` or `name:` key inside a declaration.

The state a declaration sits on is its entry state, and the key it sits under is
its id. A repeated id on one state is ruled out by YAML itself: a mapping cannot
repeat a key. A spec where no state declares a trigger has no start state, and
fails load.

`instructions` are sent to the model **while that state is active**. When
deciding where to advance, the model reads the transition `description`s of the
state it is in, which is why a `description` is required and non-empty.
`archmax validate` warns when a state with several transitions has no
`instructions` to classify the request with.

`summary` is an authoring and host label: an editor's node caption, a line in a
generated diagram. It stays out of the prompt. See
[Token efficiency and cost](/guides/token-efficiency/).

Authored paths are workspace-relative with **no leading slash**
(`skills/order-data/assets/orders.json`, `scratchpad/refund.json`).

### Slugs and titles

A state's key in `states` is its **slug**: the state's identity, and the one
thing that resolves it. Every reference is a slug:

- `transitions[].to` and `on_error`;
- the `to` the agent passes to `archmax_advance`;
- emitted events and session artifacts;
- a case's `reachedState` assertions.

A slug is lowercase alphanumeric segments joined by single hyphens
(`^[a-z0-9]+(-[a-z0-9]+)*$`, kebab-case, e.g. `identify-case`,
`report-requested`). `archmax validate` reports a nonconforming slug as an error,
and does the same for a state declared under an empty key, which has no identity
at all. The runtime itself treats a slug as an opaque identifier.

`title` is the state's optional human-readable label: free text, repeatable,
and **never a routing target**. It is carried in a human state's
pending-decision record and exposed to hosts as `machine.stateTitle(slug)`. It
reaches no model call.

Governance, transitions, events, session artifacts, and the CLI state-flow trail
all use the slug, so retitling a state changes no behavior. Reword a title
freely. Rename a slug deliberately, since it is a reference target.

`title` and `summary` are both labels for people and hosts. The one-line routing
text the model reads when choosing an edge is that edge's own `description`,
which the schema requires.

At the top level, `title:` is the workflow's human-readable name, metadata only.
[`instructions`](#instructions-the-workflows-standing-instructions) is the
top-level field that carries prompt text.

The workflow's identity is its **workflow slug**, the `workflows/<slug>/`
directory name (also the CLI argument and the value of `DEFAULT_WORKFLOW`,
`order-lookup`). A workflow slug follows the same kebab-case convention as a
state slug, so "slug" means one thing at both levels. `archmax validate` enforces
it at the same severity: a missing or non-kebab workflow slug is an **error**.

A top-level `name:` or `description:` is a load/validate **error**; the root
keys are `title:` and `instructions:`.

### `tools.allow`: closed-by-default governance

Tool governance is **closed by default**. Every state always has the
**always-on tools**:

`ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `write_todos`,
`archmax_eval`, `archmax_run`.

It also has the runtime controls `archmax_reset`, `archmax_wait`,
`archmax_get_variables` and `archmax_set_variables`, plus `archmax_advance` in
non-terminal states. Workflow-level
[`tools.allow_always`](#toolsallowalways) grants extend every state as well.
Everything else is declared: consumer-supplied custom tools, sub-workflow
delegation tools, and the rest.

A state with **no `tools` block** therefore gets exactly the always-on surface.
There is no syntax for a fully open state.

`archmax_eval`, the code interpreter, is always on because evaluated code reaches
what the state already permits and no further. Its `tools.*` calls are decided
against the active state by the same kernel that decides the agent's own calls.
Close it workflow-wide with
[`tools.forbid_always`](#toolsforbid_always--toolsforbid-denial).

`archmax_run`, which executes an authored script **file**, is always on for the
same reason: the script is a file the state could already read. Which files a
state may execute is still a governance question, and narrowing the grant per
state answers it (`{ tool: archmax_run, paths: ["scripts/**"] }`).

A state's `tools.allow` list does two things:

- **grants** tools that are not always on for that state, and
- **narrows** an always-on tool when an entry names one (the narrower entry
  wins, e.g. constraining `write_file` to a single artifact path).

Denial is declared beside the grant, in the same two positions; see
[`tools.forbid_always` / `tools.forbid`](#toolsforbid_always--toolsforbid-denial)
below.

The model **sees** the active state's tool surface, and that alone. On every
model call the middleware filters the presented tool definitions to the
disclosed set: always-on tools + `allow_always` + the state's entries +
`archmax_advance`, minus every tool denied here by name. `archmax_advance` is
hidden in terminal states.

Disclosure is name-level, so an arg-constrained tool stays visible while the
kernel enforces the constraint at call time. Every call is governed, disclosed
or not. The tool descriptions the agent sees are derived from exactly what the
kernel enforces, so every restriction the model is told about is one that
exists.

An `allow` entry is either a bare tool name or an object with `tool` plus any of
these keys:

- `args`: per-argument glob guards.
- `paths`: a shorthand for a `file_path` guard.
- `connection`: the connection slug this tool resolves through, when its
  collection has more than one connection. It is consumer-defined, and the
  runtime enforces governance without resolving connections.
- `source`: a free-form label naming where the tool came from, for the host that
  authored the entry. Governance matches on `tool` alone, and the runtime
  preserves the label without reading it.

```yaml
tools:
  allow:
    - { tool: microsoft-outlook__reply-email, connection: outlook-support }
```

Globs match **dot-prefixed segments** like any other: `scratchpad/**` covers
`scratchpad/.cache/x`, and a denial of `secrets/**` covers `secrets/.env`. A
workspace path is a path, not a shell word, and a wildcard that skipped dotfiles
would make a denial bypassable and an allowance incomplete.

An `args`/`paths` glob may reference a **variable** (`${{name}}` or
`${{name.dotted.path}}`). It is resolved against the session's variables at call
time and matched literally, so a value can never widen the guard it lands in.

The **agent** may write the same references into the arguments of its *own*
calls, embedded anywhere in a string and repeated. The runtime substitutes them
before the call is governed or executed, and `$${{name}}` writes the characters
literally. Guard and argument therefore resolve to the same value by
construction. See [session
variables](/guides/workflow-machine/#referencing-a-variable-in-a-tool-argument).

### `skills.allow_always` / `skills.allow`: capability governance by slug

Which **skills** a state may use is declared by slug, in exactly the shape tools
use. `skills.allow_always` at the spec root is enabled in **every** state. A
state's `skills.allow` **adds** to it. `forbid_always` / `forbid` deny in the
same two positions.

```yaml
skills:
  allow_always: [order-data]             # enabled in every state, named once
  forbid_always: [payroll]               # out of reach of every state

states:
  orders-question:
    skills:
      allow: [refund-policy]             # this state adds one, and has both
  general-question: {}                   # no block: has order-data, nothing more
  route:
    skills:
      forbid: [order-data]               # opts out of the workflow's grant
```

Entries are **skill slugs**, the bundle directory names under the skill source.
The unit being governed is the capability, so a path or a glob is refused here.
Resolution:

| Declaration | Enabled in a state |
| --- | --- |
| no root block at all | nothing, anywhere |
| root `allow_always` only | that list, in every state |
| root `allow_always: []` + state list | the state's list, in that state |
| root `allow_always` + state list | the **union** of the two |
| state `allow: []` beside a root grant | the root grant (an empty list subtracts nothing) |
| state `forbid` | the union **minus** those slugs, in that state |
| root `forbid_always` | never enabled, in any state, whatever grants it |

A skill is enabled where a list names it, and there alone. An absent state block
adds nothing, exactly as an absent `tools.allow` grants no tool. So declare a
capability every state needs once under `allow_always`, and declare a
state-specific one on the states that need it.

A state's `allow` adds. An empty list leaves the grant standing, and
`archmax validate` warns about an `allow: []` that reads like a denial.
**`skills.forbid` is what subtracts.** It removes a slug from that state's
enabled set, the workflow's `allow_always` included, so one state can opt out of
a capability every other state keeps.

`skills.forbid_always` puts a bundle out of reach of the whole workflow, beating
every grant. A refusal says which rule applied: a bundle a list denies reports
`skill.forbidden`, one nothing granted reports `skill.not-allowed`.

Enabling a slug is a **grant**: `skills/<slug>/**` becomes readable and its
scripts runnable, with no `tools.allow` entry needed. A skill left out of every
list is **unreachable**. `read_file`, `ls`, `glob`, `grep` and `archmax_run` on
the bundle are refused by the non-overridable `skill.not-allowed` rule.

That rule is evaluated ahead of consumer rules and the state's own
`tools.allow`, so no wildcard entry or `allow_always` grant widens it. The
bundle is **invisible** too: its slug and description stay out of that state's
prompt, and `ls skills/` there leaves it off the listing.

The two mechanisms compose as *enabled AND allowed*. A `tools.allow` entry
narrows **within** the enabled set, which is the right tool for a different
question. `{ tool: archmax_run, paths: ["skills/<slug>/scripts/**"] }` beside
`skills: { allow: [<slug>] }` says "this capability, and authored scripts
alone". `archmax_run` is otherwise always on, so a script the agent wrote into
`scratchpad/` could be run.

Lifecycle **hooks are exempt**, as they are from a state's `tools.allow`,
because a hook runs on runtime authority. So a routing state can enable nothing
while the `before` hook that enforces tenancy still reads the order records.

[`archmax_run`](#toolsallow-closed-by-default-governance) executes scripts inside
a bundle and nowhere else (`script.skill-only`). A state that enables no skill
therefore runs **no script at all**: the tool stays on the surface and refuses
every path.

See the [Skills guide](/guides/skills/) for the full rationale.
`archmax validate` supplies the static diagnostics:

- an unknown slug;
- a path-shaped entry;
- a `SKILL.md` `name:` that disagrees with its directory;
- a `tools.allow` entry that can only match a skill the state does not enable;
- a state entry the root already grants everywhere;
- an `allow: []` that subtracts nothing;
- and a spec that declares no root `skills` block while the workspace serves
  bundles.

### `mounts.allow_always` / `mounts.allow`: which states reach a mount

A **mount** is a folder (or one file) the *host* routes into the agent's
workspace: `skills/`, `AGENTS.md`, and whatever else the wiring composes. Which
**states** reach it is declared here, in exactly the shape `skills` uses.

`mounts.allow_always` at the spec root is reachable in **every** state, and a
state's `mounts.allow` **adds** to it. `forbid_always` / `forbid` deny in the
same two positions.

A grant is needed for a mount the host declared **governed**
(`{ backend, governed: true }`). Such a mount is closed by default, like a skill
bundle. An **ungoverned** mount is visible in every state, and a `forbid` is
what takes it away.

That second case covers every mount of a zero-config workspace, and every mount
of a host that marks nothing. So a spec with no `mounts` block loads and runs
unchanged over any table.

```yaml
mounts:
  allow_always: [reference]              # reachable in every state, named once
  forbid_always: [catalogs/uk]           # out of reach everywhere, child sessions too

states:
  intake: {}                             # no block: has reference/, nothing more
  triage:
    mounts:
      allow: [catalogs/eu]               # this state adds one, and has both
  route:
    mounts:
      forbid: [reference]                # opts out of the workflow's grant
```

Entries are **mount names**: the keys of the host's table with their slashes
stripped (`reference`, `catalogs/eu`, `AGENTS.md`). A glob is refused here. To
scope paths *within* a reachable mount, use a `tools.allow` entry. Resolution is
the skills table exactly:

| Declaration | Reachable in a state |
| --- | --- |
| no root block at all | no governed mount, anywhere |
| root `allow_always` only | that list, in every state |
| root `allow_always: []` + state list | the state's list, in that state |
| root `allow_always` + state list | the **union** of the two |
| state `allow: []` beside a root grant | the root grant (an empty list subtracts nothing) |
| state `forbid` | the union **minus** those names, in that state |
| root `forbid_always` | never reachable, in any state, whatever grants it |
| a mount the host did not govern | every state, named or not; `forbid` is what removes it |

A refusal says which cause applies: a mount a list denies reports
`mount.forbidden`, one nothing enabled reports `mount.not-allowed`. Both name
the mount and say this state does not have it, which is a different report from
a missing path.

#### Read or read/write

A grant entry is either a bare name, taking the posture the host wired, or a
mapping naming the access this level gives:

```yaml
mounts:
  allow_always:
    - reference                                  # the host's posture
    - { mount: shared, access: read_write }      # writable, where the host allows it

states:
  review:
    mounts:
      allow: [{ mount: shared, access: read }]   # reads it, cannot write it here
```

The host's `readOnly` is a **ceiling**:

- `access: read_write` on a mount the workspace serves read-only opens nothing,
  and `validate` warns that the entry is inert.
- `access: read` is a restriction. Like every restriction here, whichever level
  asks for it gets it, and **no narrower level widens it back**.
- A `forbid` entry is a name alone. A denial is total, so it has no access to
  qualify.

There are two rule ids, because they are two different edits. A write into a
mount the **host** serves read-only is `zone.read-only`: fix the wiring. A write
into one a **grant** narrowed is `mount.read-only`: fix the spec.

#### Unreachable also means unseen

A governed mount the state does not have is refused and hidden:

- `ls`, `glob` and `grep` results lose every entry under it (the **workspace root
  listing included**), so every directory the agent is shown is one it can
  read.
- The static "Workspace zones" prompt section lists the ungoverned mounts, one
  line each with a `read-only` or `read/write` marker. The governed mounts of
  *this* state are listed the same way in the volatile "Current state" block,
  read-only or read/write per the state's own grant. That is what keeps the
  cacheable prompt prefix byte-identical across states.
- Every call is decided by the kernel whether or not a listing showed the path.

A mount key may be several segments deep (`catalogs/eu`). A path is matched to a
mount by **longest prefix**. So a nested key is a read-only authored zone
exactly as a single-segment one is, and a sibling under the same first segment
(`catalogs/uk`) matches neither. A file mount matches its exact path, so
`AGENTS.md.bak` falls outside `AGENTS.md`.

Lifecycle **hooks and rubric graders are exempt** from a state's `forbid` and
its reachable set, as they are from `tools.allow`, because they run on runtime
authority. `mounts.forbid_always` **binds them too**, along with the whole
workflow and every child session it delegates to, naming the workflow that
declared it.

`archmax validate` reports, given the host's table (pass it as
`validateWorkflow({ mounts })`, the way skill sources are passed):

- an **error** for a name the table does not mount, naming the mounts it does;
- a warning for a grant on an ungoverned mount;
- a warning for an `access: read_write` on a read-only one;
- a warning for a name at both levels;
- a warning for a state `allow: []` beside a non-empty `allow_always`;
- a warning for a `forbid` governing nothing;
- a warning for a `forbid_always` name some list also grants;
- a warning for a `tools.allow` path entry that can only match inside a mount
  the state does not enable;
- and, once, a warning for a spec with no root `mounts` block at all in a
  workspace that governs mounts.

Any root block silences that last one. Write `mounts: { allow_always: [] }` to
say a workflow reaches none.

### `type`

The state type:

| Value | Meaning |
| --- | --- |
| `agent` (default) | The model runs a turn and moves with `archmax_advance`. |
| `human` | A person picks the outgoing edge (see [the workflow machine](/guides/workflow-machine/)). |

A state that may run another workflow declares no state type for it. It names
the target in `tools.allow` as `archmax_workflow_<slug>`, and calls it (see
[sub-workflows](/guides/sub-workflows/)).

The tool's required parameters are the target's `manual` trigger `requires:`,
typed where the target types them. Its result is `{ message, returns }`, or the closing message alone for a target
declaring no `returns:`. Capturing that result is the caller's job, and the
calling state's `requires:` is what makes recording it mandatory.

A `human` state's `evidence:` list is the **baseline**: the paths declared here
are always presented. The agent advancing into the state may attach more for
that one decision, with `archmax_advance`'s optional `evidence` argument (see
[evidence](/guides/workflow-machine/#evidence-declared-plus-whatever-the-session-attached)).

`agent` and `human` are the only state types. Delegation is a
[sub-workflow](/guides/sub-workflows/) call, and waiting for an event is
`archmax_wait` inside an agent state.

:::note[Unknown keys are rejected]
`workflow.yaml` is validated against a strict schema. A key the spec does not
define is a **load error naming the key and its path**
(`states.review: Unrecognized key: "transtions"`), so a misspelled
`transtions:` can never silently produce a terminal state.
:::

### `before` / `after` (lifecycle hooks)

Tagged hooks the runtime runs deterministically (see
[the workflow machine](/guides/workflow-machine/#lifecycle-hooks-before--after)):
`{ script: <path> }`, `{ rubric: { instructions: … } }`, or a custom kind
declared under `extensions.hooks`. A field may be a single hook or an ordered
list.

A hook may additionally carry the one reserved sidecar key, `max_iterations`.
Kind detection ignores it: the hook's kind is its single other key. A hook with
only the sidecar, or with two non-sidecar keys, is malformed.

A **`script`** hook is a pure reference: `{ script: <path> }` and nothing more.
The script is an **ordinary hand-authored `.js` file**. Its default export is
called with the hook input:

```
{ state, phase, trigger, variables, messages, tools, from?, to?, reason? }
```

It returns `ok()`, `correct(reason)` or `veto(reason)`; see
[the code interpreter](/guides/code-interpreter/#lifecycle-hooks).

The yaml wires the reference, and the hook's logic lives in the file. A yaml
`specification:` key on a hook is **not a recognized key**, so
`{ script: x.js, specification: … }` is a malformed two-key tagged object. It
fails loading and `archmax validate` with a "single-key tagged object" error.

```yaml
states:
  refund-request:
    after:
      script: hooks/check-refund.js
```

```js
// workflows/order-lookup/hooks/check-refund.js
/**
 * Veto unless the decision recorded in scratchpad/refund.json matches the
 * refund policy derived from skills/order-data/assets/orders.json.
 */
import { ok, veto } from "@archmax-ai/harness/sandbox";

export default async function hook({ tools }) {
  const orders = JSON.parse(await tools.readFile({ file_path: "skills/order-data/assets/orders.json" }));
  const refund = JSON.parse(await tools.readFile({ file_path: "scratchpad/refund.json" }));
  return matchesPolicy(refund, orders) ? ok() : veto("refund violates policy");
}
```

The `@archmax-ai/harness/sandbox` import carries types and nothing else. The prelude
provides the globals, and the import line is stripped before evaluation, so a
file that omits it is equally valid. A hook that throws vetoes.

A `before` hook runs **exactly once per entry** into its state. It runs at the
`archmax_advance` that enters it: a veto refuses the advance, and the commit
records the gate as passed for that visit.

An entry by another route runs it before the state's first model call of that
turn. Those routes are a turn opening in the state, an `on_error` route, and a
human decision. Later model calls in the same visit skip it.

A **`rubric`** hook's value is a
[rubric declaration](#grading-rubrics-declared-on-the-hook): the grader itself,
written inline. Its `max_iterations` and `model` live inside that declaration.
So the `max_iterations` sidecar is refused beside a `rubric` key. A `script`
hook accepts it.

```yaml
states:
  respond:
    after:
      rubric:
        instructions: |-
          Judge the reply. Return ok, correct or veto with a reason.
```

A **`max_iterations`** budget bounds an **`after`** hook's `correct` verdicts:
how many times that hook may send the agent back before its rejection becomes a
hard veto. A `script` hook carries the sidecar. A rubric hook declares the same
budget inside its declaration. A custom kind takes string values, so it carries
no sidecar and stays at the default. That default is `0`, so the first `correct`
from an unbudgeted hook is a hard veto.

The budget is counted **per hook**:

- Two `after` hooks on one state retry independently, and a hook that passes
  hands a sibling still asking for corrections no fresh budget.
- A `correct` refused because the budget is spent grants no retry, so it
  consumes nothing.
- A state that exhausted its budget once enters its next visit with the full
  allowance.

`before` hooks are **ok/veto only**. A `correct` verdict from a before hook is
treated as a veto with an explanatory reason and consumes no budget.
`archmax validate` errors when a before hook declares `max_iterations`.

```yaml
states:
  refund-request:
    after:
      script: hooks/check-refund.js
      max_iterations: 2     # this script's `correct` verdicts get 2 retries
```

### `budget`

Per-state execution budget bounding the turn:

```yaml
states:
  research:
    budget:
      maxTurns: 8       # overrides the default recursion limit (50) for this state
      timeoutMs: 30000  # time budget per model call; the failure routes through on_error
      maxParks: 5       # how many times this state may park itself with archmax_wait
```

- `maxTurns` bounds the model calls a state may make per visit.
- `timeoutMs` races each of the state's model calls against a timer. When the
  timer wins, the runtime stops waiting: the result is discarded, the state is
  treated as failed, and it is routed through `on_error` at the next hook
  boundary. The in-flight model request itself is **not aborted**, because Deep
  Agents exposes no per-call abort signal to middleware. It completes, and is
  billed, in the background.
- `maxParks` bounds the "wait, re-check, wait again" loop a polling state forms.
  Parks are counted per state in the checkpoint, so the count survives restarts,
  and the park that would exceed the bound is refused.
- Any exhaustion is treated as a **turn failure**, subject to `on_error`
  routing. A state with no `budget` runs under the default recursion limit (50)
  and may park any number of times.

`archmax validate` checks that `maxTurns`, `timeoutMs` and `maxParks` are
positive numbers.

### `model`

The model id this state's turns run on. An **id only**: the endpoint,
credentials and sampling (temperature, max tokens) belong to the assembly's
configuration:

```yaml
settings:
  model: gpt-5-mini         # every state of this workflow, unless it names its own

states:
  triage:                   # runs on gpt-5-mini
    triggers: { manual: }
    transitions: [{ to: draft, description: The case is classified. }]
  draft:
    model: claude-opus-5    # this state only
    transitions: [{ to: done, description: The reply is written. }]
```

Precedence runs most specific first:

1. the state's own `model`;
2. `settings.model`;
3. whatever the assembly resolved with no id, which is an explicit `model`
   passed to `createAgent`, a `modelFactory`, or `ARCHMAX_MODEL`.

A declared id is resolved over the endpoint and credentials already configured,
so naming one costs no extra setup.

- The id is **opaque**: nothing validates it against a list, so a new model needs
  no SDK release. The endpoint is what refuses an id it does not serve.
- A state's model applies to its own turns and to the handoff message of a park
  it holds. Grading rubrics keep their own [`model`](#grading-rubrics-declared-on-the-hook),
  and the case grader keeps `tests.judge.model`. A
  [sub-workflow](/guides/sub-workflows/) resolves the ids its **own**
  spec declares.
- A state that names the same id as `settings.model` gets an `archmax validate`
  warning: the declaration changes nothing.
- An explicit `model` **instance** handed to `createAgent` outranks every
  declared id: the SDK will not rebuild a host's model under another id. It
  emits one warning naming the ids it made inert. Pass
  [`modelFactory`](/reference/configuration/) instead, which is called
  for the `agent` role with the declared id as `requested`.
- Prompt caching follows the model in force. LangChain's provider-**native**
  caching is graph-level, so it stays wired from the workflow's model. A state
  whose model wants a different native mechanism is named in an assembly
  warning.

### `on_error`

A turn-failure route. A **terminal rejection** commits `rejected` to
checkpointed state, ending the turn. Three things cause one: a lifecycle hook
execution error, an exhausted correction budget, and an exhausted execution
budget (`maxTurns`, `timeoutMs` or `maxParks`).

In every terminal case the session routes to the named state. It appends an
explicit `[error]` [runtime
note](/guides/sessions/#delivering-the-event) to the transcript
and emits a `state-error-routed` diagnostic.

**Recoverable** rejections are an invalid edge target, a deliberate veto, and an
in-budget `correct`. They keep the agent in place to retry, and leave
`on_error` untouched:

```yaml
states:
  draft:
    on_error: escalate      # a declared state; may be a human state
    transitions:
      - to: review
  escalate:
    type: human
    transitions:
      - to: done
        type: approve
```

A state with no `on_error` keeps the prior fail-closed semantics: the session
ends `rejected`. `archmax validate` checks that `on_error` names a declared
state.

A **tool failure is not a turn failure**, and `on_error` never sees it. When a
tool the agent calls throws, for example a remote tool whose connection drops,
the call is answered with an error-status tool message carrying the error's
message. The session stays in the state, and the next model call reads the
failure as that call's answer, so the agent can retry, switch tools or say what
it could not do. Answers to the other calls of the same step are kept. A park
raised inside a call still parks the session, and a cancelled run still ends
the turn.

## `disabled`: take a workflow out of service

```yaml
disabled: true                # this machine starts no new turns
```

`disabled: true` means exactly one thing: **this workflow starts no new turns.**
It bounds *starting*, the sense the word carries in a scheduler or a queue.
Turns already underway finish.

What refuses:

| Ingress | Behavior |
| --- | --- |
| `archmax run` | refuses with one line, exits non-zero, starts nothing |
| A host `invoke`, or a trigger firing on a fresh session | the turn is rejected at the turn boundary with `Refusing to start: workflow '<slug>' is disabled.`, before any state, hook, or model call |
| A caller's `archmax_workflow_<slug>` call | refused as a blocked call (sub-workflow refusal kind `disabled`) before a child is composed |
| A follow-up message to a settled session | refused; a new turn is new work |
| `archmax test` | **skips** the suite and exits **0**; retiring a workflow must not turn CI red |

What still works:

- **Assembly.** `createAgent` succeeds, which is what makes the rest of
  this list possible.
- **Draining.** `archmax decide`, `archmax reply`, and `archmax deliver` all resume
  an unfinished turn, so the human decisions a disabled workflow's sessions are
  parked on stay resumable.
- **`archmax validate`.** It validates in full and adds a warning that the
  workflow is disabled. It is the surface that stays useful while a workflow is
  out of service.
- **A caller's assembly.** A state may keep allowing a disabled target: the tool
  is still bound, so disabling one leaf does not take its callers (or their
  parked sessions) offline. `validate` warns on each state that allows one.

The value is read **fail-closed**. An absent key, `null` and boolean `false`
leave the workflow running; every other value disables it, so a mis-authored
`disabled: "no"` stops new turns. `archmax validate` reports a non-boolean value
as an **error**.

The switch is workflow-wide, and it acts on new turns. To stop an underway
session, disable the workflow and leave its sessions unresumed. To forbid
particular capabilities, use
[`tools.forbid_always`](#toolsforbid_always--toolsforbid-denial).

## A trigger's declaration

A trigger is declared under the `triggers:` of the state it enters, keyed by its
id. Every key of the declaration is optional, and so is the declaration itself:
a `null` value declares the id and nothing more.

```yaml
states:
  intake:
    triggers:
      email_received:
        session: conversation_id             # where this firing's session id lives
      email_reply:
        session: triggers.-1.conversationId  # dotted path, negative index allowed
        message: triggers.-1.body.content    # host-resolved: where the firing's words are
      ticket_reopened:
        message: false                       # host-resolved: firings carry no message
        connection: acme-oidc                # host-resolved: opaque to the SDK
  enrich:
    triggers:
      manual:                                # the one entry: CLI, host firing, or a caller
        description: Enrich one order and say whether it is late.  # for a caller, never the agent
        requires:                            # a firing must supply these to start
          - order_id                         # a bare name: untyped
          - { name: due, type: date, description: The day the order is due. }
        returns:                             # the session guarantees these when it completes
          - enrichment_file
          - { name: delayed, type: boolean }
```

| Key | Read by | Meaning |
| --- | --- | --- |
| `session` | the machine | Dotted path to a firing's session id |
| `message` | the **host** | Dotted path to a firing's words, or `false` for none |
| `connection` | the **host** | Slug of the access connection governing the trigger's endpoint |
| `description` | a **caller** | What calling this entry does, for whoever calls it |
| `requires` | the machine | Variables a firing must supply for the session to start |
| `returns` | the machine | Variables the session guarantees are set when it completes |

The state a declaration sits on is the trigger's entry state, so a trigger has
exactly one, written once. There is no `entry:` key and no root `triggers:`
block.

`entry:` and `name:` inside a declaration are load **errors** naming the key.
Each would be wiring the SDK reads elsewhere, and a loose declaration that
swallowed one would start the run somewhere the author did not say.

### The signature: `requires` and `returns`

Together these two are the contract for a session started through the trigger,
and both are enforced.

`requires:` is the entry-boundary counterpart of a state's `requires:`: the same
word, the same grammar, the same fail-closed intent, applied at the session's
boundary. A firing that does not supply every name does not start. A delegating
parent that does not is refused **before** the child is composed.

`returns:` is the exit half. The named variables are ordinary variables, set
with `archmax_set_variables` or by a script. A session that reaches a terminal
state with any one of them unset is **rejected**. A session that *parks* goes
unchecked, because it has not finished.

Each entry is a bare variable name, or an object `{ name, type?, description? }`
naming one. The two spellings mix freely in one list. A bare name and an object
with only `name` are the same **untyped** entry, which takes any value, `null`
included. Names are distinct across both spellings, so
`[total, { name: total, type: number }]` is a duplicate. The object is strict: any
other key (a misspelled `type`, say) is a load error naming the entry and the key,
rather than a silent "untyped".

`type` is one of eight words. Six are JSON Schema's own types; `date` and
`date-time` are JSON Schema string formats, promoted because a host renders and
validates them differently from free text. One conformance rule decides every
check, and nothing is coerced:

| `type` | Conforms when the value is | JSON Schema |
| --- | --- | --- |
| `string` | a string | `{ type: string }` |
| `integer` | a number with no fractional part (`"4"` does not conform) | `{ type: integer }` |
| `number` | a finite number | `{ type: number }` |
| `boolean` | `true` or `false` | `{ type: boolean }` |
| `date` | a string that is an RFC 3339 full-date, `YYYY-MM-DD`, naming a real calendar day (`2026-02-30` does not conform) | `{ type: string, format: date }` |
| `date-time` | a string that is an RFC 3339 date-time with an offset, `Z` or `±hh:mm` | `{ type: string, format: date-time }` |
| `object` | an object that is not an array | `{ type: object }` |
| `array` | an array | `{ type: array }` |

A typed entry never takes `null`, because the JSON Schema a host publishes from it
would refuse `null` too. Typing stops at this level: there are no item schemas, no
property schemas, no enums and no ranges.

Where the types are held:

- **At the start.** A firing whose value for a typed `requires` entry does not
  conform is refused like one that misses a name, before any model call, naming
  the trigger, the variable, the type and what arrived.
- **At the write.** An `archmax_set_variables` call writing a typed return of the
  current turn's trigger with a non-conforming value is refused, atomically, as a
  correctable tool refusal. The agent writes a conforming value and the session
  goes on. Undeclared and untyped names are written as before.
- **At completion.** A session whose typed return holds a non-conforming value is
  rejected like one that left it unset. In practice this catches script and hook
  writes, which the write check does not see.

An entry's `description` says what the variable holds, for whoever supplies or
reads it. What the agent should *do* to produce a return still belongs in the
state `instructions` that tell it to set the variable.

`description` on the declaration itself is for a **caller**: a delegating model,
a host's MCP client, the reader of a start form. It leads the delegation tool's
description. It is never shown to the model of the session the trigger starts,
whose brief is its `instructions`. A second, caller-facing brief there could
contradict the first. An empty `description` is a load error naming the trigger.

The two reserved variable names (`trigger` and `title`) are accepted in
`requires:` and **refused** in `returns:`, each for its own reason. The runtime
always sets `trigger`. A `title` returned from a child session would rename the
task of whoever called it.

Load fails, and `validate` reports the same in the same words. See
[Two reserved names](/guides/workflow-machine/#two-reserved-names).
The names are rendered into the system prompt under the trigger's entry state,
so the agent is told what it must produce before it is failed for omitting it.
A typed or described entry is rendered on its own line as
`name (type) — description`, and an untyped signature reads as it always has.

On the `manual` trigger, this signature is also the workflow's **call
signature**. `requires:` becomes the typed parameters of the
`archmax_workflow_<slug>` tool a calling workflow binds, and `returns:` becomes
its result. One declaration, read at both boundaries. A host building an MCP tool
or a form from the same signature uses `signatureJsonSchema` and
`signatureValueIssues` from `@archmax-ai/harness/spec`: the mapping and rule the
runtime itself applies (see [Public API](/reference/public-api/#building-a-host-schema-from-a-signature)).

`session:` is a dotted path over the session's variables (the same syntax
`${{…}}` guards use), naming where a firing's [session
id](/guides/sessions/) comes from. A dotted path is its one form,
with no script option and no callback. A `${{…}}`-wrapped value is rejected, so
there is one spelling.

`message:` and `connection:` are **host-resolved**. The SDK shape-checks them,
preserves them, and exposes them (`machine.messagePathForTrigger(id)`,
`machine.connectionForTrigger(id)`). Routing, session resolution and the prompt
are all untouched by either.

`message:` shares `session:`'s dotted grammar and gets the same diagnostics. It
also takes the literal `false`, for a trigger whose firings carry no message,
which is a distinct declaration from an absent key. `connection:` is any
non-empty string naming something in the host's own configuration, which the SDK
cannot see and leaves unchecked.

A declaration key the SDK does not define is reported as a **warning** and
ignored. The machine is fully determined without it, so a host's decoration
leaves an otherwise runnable workflow runnable. Every *structural* problem here
is an error that fails load:

- a `triggers:` that is not a mapping;
- a declaration that is neither a mapping nor empty;
- a trigger declared by two states;
- a malformed `session` or `message` path;
- a `connection` or `description` that is not a non-empty string;
- a signature entry with an unknown `type`, an unknown key, or a name listed twice;
- an `entry:` or `name:` key.

An event that should always continue an existing session is declared nowhere
here. The host names the session it belongs to
(`agent.workflow.send(sessionId, …)`, `archmax deliver <session> --trigger <id>`),
or supplies a `sessionPath` on the firing. See
[triggers](/guides/triggers/).

## Workflow-level blocks

### `tools.allow_always`

Workflow-wide **grants** for tools beyond the always-on set, extending every
state's allowlist:

```yaml
tools:
  allow_always:
    - { tool: lookup_customer, args: { region: ["eu-*"] } }
```

A per-state `allow` entry for the same tool takes precedence over the grant
(narrower wins), so a state can constrain a tool that is otherwise granted
everywhere.

Listing an **always-on** tool here is inert: always-on tools are always
permitted, and a per-state entry is what narrows them. `archmax validate` warns
about such entries, redundant when bare and unenforced when constrained.

### `skills.allow_always` / `skills.forbid_always` (root)

The capabilities the workflow grants in **every** state, and the ones it denies
there: the skills half of `tools.allow_always` / `tools.forbid_always`. A
state's `skills.allow` adds to the grant, and its `skills.forbid` subtracts from
it. `forbid_always` beats every grant anywhere.

An absent block grants nothing workflow-wide. `allow_always: []` says so
deliberately, and is what a workflow whose capabilities are all state-specific
declares. Both keys are covered in full under
[`skills.allow_always` /
`skills.allow`](#skillsallow_always--skillsallow-capability-governance-by-slug)
above.

### `mounts.allow_always` / `mounts.forbid_always` (root)

The governed mounts the workflow reaches in **every** state, and the ones it
reaches nowhere: the mounts half of `tools.allow_always` /
`tools.forbid_always`. A state's `mounts.allow` adds to the grant, and its
`mounts.forbid` subtracts from it. `forbid_always` beats every grant anywhere,
and binds every child session this workflow delegates to.

An absent block leaves the workflow reaching no governed mount, and `validate`
says so once, naming them. `allow_always: []` says so deliberately. Both keys
are covered in full under
[`mounts.allow_always` /
`mounts.allow`](#mountsallow_always--mountsallow-which-states-reach-a-mount)
above.

### `tools.forbid_always` / `tools.forbid`: denial

Denial is declared in the same two positions as the grant, and takes the same
entries. `tools.forbid_always` at the root denies in **every** state.
`tools.forbid` on a state denies while that state is active.

```yaml
tools:
  allow_always: [read_file]
  forbid_always:
    - execute                                  # blocked in every state
    - { tool: "*", paths: ["logs/**"] }        # every tool, on those globs

states:
  route:
    tools:
      forbid: [write_file]                     # denied here, granted elsewhere
```

One rule covers both levels and both capabilities:

> **Deny beats allow, and no narrower level widens a denial.**

Nothing reaches past `forbid_always`: no state grant, `allow_always` entry,
argument guard or consumer rule. Inside a state, its `forbid` is final too. It
subtracts from the workflow's grant, the state's own `allow`, and the always-on
surface alike, which is how a state opts out of a capability the workflow gives
everywhere. An empty `allow` list leaves the grant standing.

A forbid entry may name the tool `*`, meaning **every** tool. That is vocabulary
the deny side alone has, since a wildcard there can only close the surface
further, and `*` in an `allow` list is a load error.

An entry's argument guards narrow what it denies.
`{ tool: write_file, paths: ["logs/**"] }` denies that tool on those globs and
leaves the rest alone, so the tool stays disclosed and the kernel refuses the
matching call. A bare denial removes the tool from the model's picture entirely.

`archmax validate` flags three shapes here: a state whose `allow` list would
permit a call a denial blocks, a state that both allows and forbids one tool,
and a denial of `archmax_advance` in a workflow that has anywhere to move, since
no run could leave its start state. The globs cover dotfiles, so a denial of
`secrets/**` blocks a write to `secrets/.env`.

**Hooks** are bound by a workflow-wide denial, and a state's denial leaves them
free. A hook runs on runtime authority, outside the state's tool surface in both
directions. That is the same exemption it already has from the state's `allow`
list.

Workflow-wide denials **accumulate down a delegation chain**. A
[sub-workflow](/guides/sub-workflows/) is bound by its own
`forbid_always` lists and by every ancestor's: the root's and each intermediate
caller's. A block from an inherited rule names the workflow that declared it.

A child can narrow what is permitted, and re-granting is closed to it. The
per-state `allow` and `forbid` lists stay local, inherited in neither
direction.

### `tests`

Declarative configuration for the workflow's
[cases](/reference/cli/#archmax-test). It replaces the removed
`tests/tests.config.js` file. Discovery reads `*.test.yaml` and `*.test.yml`
documents, so a leftover config file is ignored without a diagnostic. Delete it.

The cases themselves are declarative YAML documents
(`workflows/<name>/tests/*.test.yaml`), interpreted host-side; see the
[testing guide](/guides/testing/):

```yaml
tests:
  maxConcurrency: 1       # only 1 (or absent) is accepted — see below
  caseTimeoutMs: 120000   # host-side per-case wall clock (default 120000)
  judge:
    model: gpt-4o-mini    # grader model override
    modelOptions:         # grader model construction options
      temperature: 0
      maxTokens: 256
```

All fields are optional. `judge.model` and `judge.modelOptions` are applied over
the environment's model configuration and handed to the model factory's `judge`
role, so the default factory builds exactly the grader named here.
`modelOptions` takes `temperature` and `maxTokens`; any other key is a load
error. A [`modelFactory`](/reference/public-api/) that brings its
own model ignores them with the rest of the environment.

`caseTimeoutMs` is the wall-clock budget the host enforces around each whole
case, covering every step and assertion. The name keeps it distinct from
`settings.timeoutMs`, the sandbox *script* budget.

Case concurrency is not implemented. Cases run sequentially, and a
`maxConcurrency` above 1 is rejected: an error diagnostic from
`archmax validate`, and a loud failure from `archmax test` before any case runs.
Set it to 1 or omit it.

### `settings`: payload and caching knobs

Alongside the sandbox knobs (`timeoutMs`, `memoryLimitBytes`, `maxPtcCalls`,
`maxResultChars`), `settings` carries what a workflow declares about its
model-facing payload:

```yaml
settings:
  model: gpt-5-mini         # the model every state runs on, unless it names its own
  prompt_cache:
    enabled: true           # default true
    ttl: 5m                 # 5m (default) | 1h
```

`settings.model` overrides `ARCHMAX_MODEL` for this workflow, and a state's own
[`model`](#model) overrides it in turn. It is a model id, and that alone. The
case grader keeps its own (`tests.judge.model`).

`settings.sub_workflows` and `settings.prompt` are **removed**: the strict
schema rejects both by name. Delegation bounds are the dispatcher's
configuration (see [sub-workflows](/guides/sub-workflows/)), and
there is one prompt rendering.

The todo surface has no knob. `write_todos` is always disclosed and always
permitted, like the filesystem tools. The runtime installs it itself, so the
surface stays the same whatever an upstream default does. Its schema plus
guidance costs ~13,250 characters on every model call: the price of the agent
always having a planning scratchpad.

To refuse it outright, list it in
[`tools.forbid_always`](#toolsforbid_always--toolsforbid-denial). `archmax validate`
checks the shape of every field. See
[Token efficiency and cost](/guides/token-efficiency/).

### `extensions.hooks`

Declares custom lifecycle-hook kinds the runtime is expected to register
executors for (see
[`hookExecutors`](/reference/public-api/#hookexecutors-custom-lifecycle-hook-kinds)),
so `archmax validate` accepts them statically:

```yaml
extensions:
  hooks: [webhook]
states:
  approve:
    after: { webhook: approvals/refund }
```

An undeclared hook kind is flagged by `archmax validate` as an error.

### Grading rubrics: declared on the hook

The standard a state's exit is measured against is declared **inline as the
value of its `{ rubric: … }` hook**. There is no root block and no rubric name,
so reading the state tells you the whole standard.

A rubric is dispatched by the runtime and stays invisible to the session it
grades; see the
[grading rubrics guide](/guides/grading-rubrics/) for the whole
story.

```yaml
states:
  orders-question:
    after:
      - rubric:
          max_iterations: 2                # optional: grade-and-retry budget
          model: <a stronger model id>     # optional: the id the grader runs on
          instructions: |-                 # required: criteria and the verdict
            Judge only the tone of the last assistant message. Return `ok`,
            `correct` or `veto`, always with a concise `reason`.
      - script: hooks/check-facts.js       # a list mixes kinds freely
```

`instructions` is the only required key, and a rubric also accepts
[`metadata`](#metadata-host-data). Three keys are deliberately absent:

| Absent key | Why |
| --- | --- |
| `title` | nothing routes to a rubric |
| `description` | a display label goes in `metadata` |
| `response_format` | a rubric grades, so every dispatch requests the verdict schema |

Two states wanting the same grader declare it twice. That is the accepted cost of
a state being legible on its own.

A rubric's identity is its **position**: state, phase, index in that phase's
list. That is what the runtime dispatches it under, and what an operator event
calls it (`rubric#0`). Its retry budget is keyed against the same position, so
two graders on one state hold separate budgets.

### `metadata`: host data

The one key the runtime never reads, accepted at **three** positions: the spec
root, any state, and any rubric. An authoring UI, such as a workflow builder or
a graph editor, keeps its own state here. Per-node data lives on the node
itself, so renaming a state carries its position along:

```yaml
metadata:
  canvas: { zoom: 1, pan: { x: 0, y: 0 } }

states:
  identify-case:
    metadata: { x: 0, y: 40 }
  orders-question:
    metadata: { x: 280, y: 40 }
```

The contents are shape-checked as a mapping and no further: they belong to
whoever wrote them. What the SDK guarantees is threefold:

- **It loads.** A spec carrying the block is a usable machine, and
  `archmax validate` reports it clean.
- **It survives.** The block is preserved on the parsed `MachineSpec`, so a tool
  that loads a spec and re-serializes it keeps what it authored.
- **It is inert.** The block stays out of the system prompt, out of governance
  and out of routing, so it costs no tokens per model call. It is also
  **excluded from the spec hash**: moving a state on a canvas mints no new spec
  version and leaves a durable session pinned to the old one valid. The
  persisted [spec snapshot](/reference/public-api/) is the hashed
  document, so it omits the block too.

This is one named key per position. The spec root, `extensions`, and the rest of
every state stay strict, so any *other* unrecognized key is a load error naming
the key and its path.

### `runtime`

A workflow MAY declare the runtime contract it was authored against:

```yaml
runtime:
  engine: archmax-harness
  version: "2"
```

This is a separate version axis from the npm package version. `runtime.version`
names the stable authoring/runtime semantics a workspace expects. Versions `"1"`
and `"2"` are supported, and an omitted `runtime` resolves to the default
contract (`archmax-harness@1`).

A workflow declaring an **unsupported** engine or version fails fast:
`createAgent` throws an `UnsupportedRuntimeContractError` before any model work,
and `archmax validate` reports it as an error diagnostic.

Case files carry their own, independent version axis, with the same resolution
shape: a per-file
[`version` key](/guides/testing/#suite-configuration) naming the
test spec schema version. An omitted key resolves to `"1"`. An unsupported one
fails the test run before any case executes.
