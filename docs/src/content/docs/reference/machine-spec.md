---
title: Machine spec
description: The workflow.yaml schema, covering states and their types, grader and code states, budgets, on_error, governance, tests, and metadata.
sidebar:
  order: 3
---

`workflows/<name>/workflow.yaml` is the enforced state machine, a pure YAML
mapping with these top-level keys:

`title`, `instructions`, `disabled`, `runtime`, `settings`, `tests`, `tools`,
`skills`, `mounts`, `metadata`, `states`.

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
    skills:
      allow: [order-data]   # capability slugs THIS state adds (see skills.allow_always)
    mounts:
      allow: [catalogs/eu]  # mount names THIS state adds (see mounts.allow_always)
    locks: [case_id]        # variables only THIS state may write (see locks)
    tools:
      allow:                # this state's grants; `forbid:` beside it denies
        - { tool: write_file, args: { file_path: [reports/answer.json] } }   # a governed session path;
                              # scratchpad/** is writable wherever write_file is granted,
                              # so an entry naming a path inside it narrows nothing there
    transitions:
      - to: orders-question
        description: "User is asking about orders."   # when to take it; omit to route on the target's instructions
  review-enrichment:
    type: grader            # an automated state: the runtime runs it (see type)
    instructions: "Check the recorded enrichments against their files; approve them or send them back."
    transitions:
      - { to: enrichments-filed, description: "The enrichments are correct." }
      - { to: enrich-order, description: "The enrichments are wrong; send them back." }
  enrichments-filed:
    type: code              # runs its script and completes, with no model call
    script: scripts/enrichments-filed.js
```

A state with **no `transitions`** is terminal. The turn ends when the agent
finishes there, and the volatile prompt block says so in place of the list.

### `transitions`: the only part of the graph the agent sees

Each entry is `{ to, description?, type? }`:

| Key | Value |
| --- | --- |
| `to` | a declared state's slug |
| `description` | when this edge applies; omit it to route on the target's `instructions` (never on an edge into a grader or code state) |
| `type` | one of `approve`, `reject`, `refine`, `none` |

The agent is disclosed the active state's outgoing edges, so the description is
what it knows about where an edge leads. Write it for a reader standing in the
*source* state, which has no picture of the target:

```yaml
transitions:
  - to: refund-review
    description: The refund is over $50, or the customer has asked twice.   # when
  - to: orders-question
    description: Go to the orders-question state.                           # avoid: where
```

An edge may also go **undescribed**: no `description`, or an empty or blank one.
The agent then routes on the target state's own `instructions`, which the edge's
line carries in place of a description, quoted and introduced as what the agent
will do once there. Use it when the next state's instructions already say when
it applies, rather than paraphrasing them on every edge into it. Nothing else of
the target is disclosed: not its `title`, `summary` or transitions.

```yaml
states:
  triage:
    transitions:
      - to: lookup                # undescribed: routes on lookup's instructions
  lookup:
    instructions: Look the order up by its id and summarise its status.
```

Four cases are **load errors**, each naming
`states.<slug>.transitions.<index>.description`:

- an undescribed edge whose target has no instructions, because there is nothing
  to route on;
- an undescribed edge into a **grader** or a **code** state: a grader's
  instructions are its criteria, never shown to the work it judges, and a code
  state has none;
- an undescribed transition of a **human state**, where the description is the
  label of the decision's button for the person deciding;
- a `description` that is not a string.

A code state's **own** edges may go undescribed: its script routes on them, and
no model reads their descriptions.

An undescribed edge *into* a human state discloses that state's instructions to
the agent, and those are written for the reviewer. Describe the edge to keep them
from the agent.

An edge's rendered line marks a target that is a **human decision node**, a
**grader**, a **code** state or **terminal**, because each changes the call or
what follows it. A grader or a code state runs on its own and may send the work
straight back; a human or terminal target means the agent stops there.
`evidence` may be attached when advancing to a human state, and there alone:

```
Transitions — choose one with `archmax_advance` when this state's work is done:
- to `refund-review` (human decision node) — The refund is over $50, or the customer has asked twice.
- to `refund-closed` (approve, terminal) — The recorded decision is correct; close the case.
```

The line stops there. Everything else the target declares stays out of it:

- its `title` and `summary`, and its `instructions` unless the edge is
  undescribed (never a grader's criteria, since an undescribed edge into a grader
  is refused);
- its `script`, `model` and budget;
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
state it is in, or a target's `instructions` where an edge is undescribed.
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

`title` and `summary` are both labels for people and hosts. The routing text the model reads when
choosing an edge is that edge's own `description`, or, for an undescribed edge,
the target's `instructions`.

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

Tool governance is **closed by default**. Every state has the workflow's
**workflow-wide grant**: the entries of [`tools.allow_always`](#toolsallow_always)
when the workflow declares that key, and otherwise the **default tools**:

`ls`, `read_file`, `write_file`, `edit_file`, `copy_file`, `move_file`,
`remove_file`, `glob`, `grep`, `write_todos`, `archmax_eval`, `archmax_run`.

A declared `tools.allow_always` **replaces** the default tools rather than adding
to them, so a workflow that declares it lists every default tool it wants. A new
workflow lists all twelve and removes only those it must not have.

Every state also has the runtime controls `archmax_reset`, `archmax_wait`,
`archmax_raise`, `archmax_get_variables` and `archmax_set_variables`, plus
`archmax_advance` in non-terminal states, and any tool the host passes as
[`essentialTools`](/reference/public-api/), whatever the workflow declares. A
grader or a code state is the exception: it is never offered `write_todos`,
`archmax_eval`, `archmax_run`, `archmax_wait` or `archmax_reset`, even where the
workflow-wide grant names one, and it adds `archmax_get_history`.
Everything else is declared: consumer-supplied custom tools, sub-workflow
delegation tools, and the rest.

A state with **no `tools` block** therefore gets exactly the workflow-wide grant,
the controls and the host's `essentialTools`. There is no syntax for a fully
open state.

The runtime's file operations, `copy_file({ source, destination, overwrite? })`,
`move_file({ source, destination, overwrite? })` and `remove_file({ file_path })`,
are default tools for the same reason as the code interpreter below: they reach
nothing the path rules do not let them. Every tool **declares its path
arguments** and how a call uses each one: `read`, `list`, `search`, `write`,
`remove` or `execute`. `copy_file` reads `source` and writes `destination`,
`move_file` removes `source` and writes `destination`, and `remove_file` removes
`file_path`. Every path rule reads those declarations, for the built-ins and for
host tools (see [`toolPaths`](/reference/public-api/#tools-toolpaths-host-tools-on-the-governed-workspace)):

- the read-only authored zone, the offload areas, a mount narrowed to
  `access: read` and a governed mount no grant of the workflow asks to write
  refuse a `write` and a `remove` alike;
- the runtime-internal areas, a skill the state does not enable and a mount it
  was not given refuse every access;
- `scratchpad/` is open to `read`, `list`, `write` and `remove` in every state,
  for each default file tool the state is granted (by the workflow-wide grant or
  by its own entry, whatever that entry narrows) and for a host's
  `essentialTools`. A file tool the state is not granted gets nothing from it,
  and any other tool needs its state's grant there as anywhere.

A call naming several paths is refused when any one of them is, and the refusal
names the argument (`'copy_file' on 'skills/x.md' (destination)`). An argument
may hold a list of paths, each governed with the argument's access; a declared
argument holding anything but a path or a list of paths is refused
(`tool.path-argument`).

`archmax_eval`, the code interpreter, is a default tool because evaluated code
reaches what the state already permits and no further. Its `tools.*` calls are
decided against the active state by the same kernel that decides the agent's own
calls. Withhold it by leaving it out of a declared `tools.allow_always`, or close
it workflow-wide with
[`tools.forbid_always`](#toolsforbid_always--toolsforbid-denial). A grader or
code state is never offered it.

`archmax_run`, which executes an authored script **file**, is a default tool for
the same reason: the script is a file the state could already read. Which files a
state may execute is still a governance question, and narrowing the grant per
state answers it (`{ tool: archmax_run, paths: ["scripts/**"] }`).

A state's `tools.allow` list does two things:

- **grants** tools the workflow-wide grant does not include, for that state (a
  default tool a declared `allow_always` leaves out among them), and
- **narrows** a tool the workflow-wide grant includes when an entry names one
  (the narrower entry wins, e.g. constraining `write_file` to a single artifact
  path).

Denial is declared beside the grant, in the same two positions; see
[`tools.forbid_always` / `tools.forbid`](#toolsforbid_always--toolsforbid-denial)
below.

The model **sees** the active state's tool surface, and that alone. On every
model call the middleware filters the presented tool definitions to the
disclosed set: the workflow-wide grant + the host's `essentialTools` + the
state's entries + `archmax_advance`, minus every tool denied here by name. `archmax_advance` is
hidden in terminal states.

Disclosure is name-level, so an arg-constrained tool stays visible while the
kernel enforces the constraint at call time. Every call is governed, disclosed
or not. The tool descriptions the agent sees are derived from exactly what the
kernel enforces, so every restriction the model is told about is one that
exists.

An `allow` entry is either a bare tool name or an object with `tool` plus any of
these keys:

- `args`: per-argument glob guards.
- `paths`: globs every path argument the tool declares must match (`file_path`
  for the file tools, `path` for `ls`, `glob` and `grep`, both `source` and
  `destination` for `copy_file` and `move_file`). A tool that declares none is
  guarded on `file_path`.
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

An `args` glob matches an argument according to what the argument is. An
argument the tool declares as a **path** (`file_path`, `path`, `source`,
`destination`, or a host's declared ones; for a tool that declares none,
`file_path`) is canonicalized before it is matched: a leading `/`, `./`, `//` and
`..` are resolved, so a different spelling cannot dodge a guard. Every **other**
argument is matched **as written**: a grant on
`url: ["https://api.example.com/**"]` admits that API's URLs, and a stored value
matches itself exactly. A denial on such an argument also catches its path form,
so `./secrets/k` cannot dodge `target: ["secrets/**"]`. The glob syntax is the
same for both: `*` stops at `/`, and `**` crosses it. An empty pattern (`""`,
written or resolved from a variable) matches only an empty value. To have a host
tool's argument matched as a path, declare it with
[`toolPaths`](/reference/public-api/#tools-toolpaths-host-tools-on-the-governed-workspace).

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
alone". `archmax_run` is otherwise granted unconstrained wherever the workflow-wide
grant includes it, so a script the agent wrote into `scratchpad/` could be run.

A **grader or a code state is held to its own list** like any other state. A
code state that checks the request against the order records enables
`order-data` itself, so the routing state after it can still enable nothing. No
caller reads a bundle a state did not enable.

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

A grant entry is either a bare name, which asks for no write, or a mapping
naming the access this level gives:

```yaml
mounts:
  allow_always:
    - reference                                  # read; written only if a grant asks
    - { mount: shared, access: read_write }      # writable, where the host allows it

states:
  review:
    mounts:
      allow: [{ mount: shared, access: read }]   # reads it, cannot write it here
```

A governed mount is writable in a state only when all three hold:

- the host serves it writable;
- some grant of **this** workflow asks `access: read_write` for it, in
  `allow_always` or in any state's `allow`;
- no grant applicable in the state says `access: read`.

So a bare grant in one state and a `read_write` grant in another both write. A
mount belongs to the workflow that grants it. One table serves a session and
every child it dispatches, and a route is served writable when any workflow in
that tree asks, but another workflow's `read_write` never lets this one write
through a bare grant. An ungoverned mount takes the host's posture: it has no
grant to ask with, and only an `access: read` narrows it.

The host's `readOnly` is a **ceiling**:

- `access: read_write` on a mount the workspace serves read-only opens nothing,
  and `validate` warns that the entry is inert.
- `access: read` is a restriction. Like every restriction here, whichever level
  asks for it gets it, and **no narrower level widens it back**.
- A `forbid` entry is a name alone. A denial is total, so it has no access to
  qualify.

There are two rule ids, because they are two different edits. A write into a
mount the **host** serves read-only is `zone.read-only`: fix the wiring. A write
into one a **grant** narrowed, or one no grant of the workflow asks to write, is
`mount.read-only`: fix the spec. The refusal says which.

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

A **grader and a code state's script answer to their own state's grants**, as
the agent does in that state: its `allow`, `forbid` and `access: read` bind
them, and so does every `forbid_always`.

One read answers to the **workflow's** grants instead: the runtime's own check
that a `file` value names a file the session may read. That check reads a
governed mount that `allow_always` or **any** state's `allow` grants, and refuses
one no grant of the workflow names with `mount.not-allowed`. One table serves a
session and every child it dispatches, so it can hold a mount only a child
grants, and a caller's `file` value cannot name it.

`mounts.forbid_always` binds the whole workflow, that check included, and every
child session it delegates to, naming the workflow that declared it.

`archmax validate` reports, given the host's table (pass it as
`validateWorkflow({ mounts })`, the way skill sources are passed):

- an **error** for a name the table does not mount, naming the mounts it does;
- a warning for a grant on an ungoverned mount;
- a warning for an `access: read_write` on a read-only one;
- a warning for a name at both levels, unless the state entry narrows it to
  `access: read` or asks `access: read_write` of a mount the root grants bare;
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
| `grader` | The runtime runs a grader, an isolated subagent whose criteria are the state's `instructions`. It decides the edge with `archmax_advance`, or ends the session with `archmax_raise` (see [grader and code states](/guides/automated-states/#grader-states)). |
| `code` | The runtime runs the state's [`script`](#script) in the sandbox, and the script decides the edge (see [grader and code states](/guides/automated-states/#code-states)). |

`grader` and `code` are the **automated states**. The runtime runs one whenever
the session reaches it, in place of the agent's next model call, and a chain of
code states makes no model call at all. An automated state cannot park.

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

These four are the only state types. Delegation is a
[sub-workflow](/guides/sub-workflows/) call, and waiting for an event is
`archmax_wait` inside an agent state.

:::note[Unknown keys are rejected]
`workflow.yaml` is validated against a strict schema. A key the spec does not
define is a **load error naming the key and its path**
(`states.review: Unrecognized key: "transtions"`), so a misspelled
`transtions:` can never silently produce a terminal state.
:::

### `script`

The file a **code state** runs, as a workflow-relative path inside the
workflow's `scripts/` directory:

```yaml
states:
  check-refund:
    type: code
    script: scripts/check-refund.js   # workflows/<slug>/scripts/check-refund.js
    skills:
      allow: [order-data]             # what the script reads, granted like any state's
    transitions:
      - { to: refund-review, description: The decision matches the policy. }
      - { to: refund-request, description: The decision contradicts the policy; send it back. }
```

The path must start with `scripts/`, end in `.js` or `.mjs`, and hold no `..`
segment. A path that breaks any of those rules is a load error naming
`states.<slug>.script`. A code state with no `script` is a load error, and so is
a `script` on any other state type. `archmax validate` also reports a file the
authoring backend does not hold, and an import from anything but
`@archmax-ai/harness/*`.

The file is an ordinary hand-authored JavaScript module. Its default export is
called with `{ state, trigger, variables, tools }`, reads the session with
`tools.archmax_get_history()`, moves it with `tools.archmax_advance({ to, reason })`
or ends it with `tools.archmax_raise({ code, reason })`, and its return value is
not read. See
[the script contract](/guides/automated-states/#the-script-contract).

### Keys each state type reads

A key a state's type never reads is accepted by the loader and reported by
`archmax validate` as an **error**:

| Type | Errors |
| --- | --- |
| `human` | no `instructions`; no transition; a transition to itself; two transitions of the same labelled `type` |
| `grader` | no `instructions` (they are its criteria); no transition (a grader decides by advancing); `evidence`, `approvers` or `budget.maxParks` declared |
| `code` | `instructions`, `model`, `budget`, `evidence` or `approvers` declared (a code state makes no model call; describe the script in its JSDoc header or the state's `summary`) |
| `grader`, `code` | a `tools.allow` entry naming `write_todos`, `archmax_eval`, `archmax_run`, `archmax_wait` or `archmax_reset`, which no automated state is offered |

`before` and `after` are not state keys. A workflow that still declares either
fails to load with the unrecognized-key error naming the key and its path
(`states.orders-question: Unrecognized key: "after"`). A former `before` check
becomes a code state in front of the state, a former `after` check a code state
behind it, and a grading rubric a grader state (see the
[changelog](/reference/changelog/#100)).

### `budget`

A state's execution budget:

```yaml
states:
  research:
    budget:
      maxTurns: 8       # model calls this state may make once entered
      timeoutMs: 30000  # time budget per model call; the failure routes through on_error
      maxParks: 5       # how many times this state may park itself with archmax_wait
```

- `maxTurns` bounds the model calls a state may make, counted from its entry.
- `timeoutMs` races each of the state's model calls against a timer. When the
  timer wins, the runtime stops waiting: the result is discarded, the state is
  treated as failed, and it is routed through `on_error`. The in-flight model request itself is **not aborted**, because Deep
  Agents exposes no per-call abort signal to middleware. It completes, and is
  billed, in the background.
- `maxParks` bounds the "wait, re-check, wait again" loop a polling state forms.
  Parks are counted per state in the checkpoint, so the count survives restarts,
  and the park that would exceed the bound is refused.
- Any exhaustion is treated as a **turn failure**, subject to `on_error`
  routing. A state with no `budget` may make any number of model calls, and may
  park any number of times.

In a **grader state**, `maxTurns` bounds the grader's own model calls and
`timeoutMs` its whole run; exhausting either fails the state. A grader cannot
park, so `maxParks` there is an `archmax validate` error. A **code state**
declares no `budget` at all (an error): it makes no model call, and its script is
bounded by `settings.timeoutMs`.

What bounds a whole turn, across every state, is LangGraph's `recursionLimit`: 400
graph steps unless the caller's invoke config sets its own. Every model call, tool
batch and automated state's run is a step. A state's `maxTurns` starts over on
every entry, so an agent moving back and forth between states never exhausts it;
the recursion limit is what stops that turn. Hitting it does not route through
`on_error`: the turn throws, and the session ends `failed` with the code
`recursion-limit` (see
[a turn that throws](/reference/public-api/#a-turn-that-throws)).

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
  it holds. A grader state's `model` is the id its grader runs on, resolved under
  the `grader` model role (see
  [grader and code states](/guides/automated-states/#budget-and-model)), and
  the case judge keeps `tests.judge.model`. A code state declares none. A
  [sub-workflow](/guides/sub-workflows/) resolves the ids its **own**
  spec declares.
- A state that names the same id as `settings.model` gets an `archmax validate`
  warning: the declaration changes nothing.
- An explicit `model` **instance** handed to `createAgent` outranks every
  declared id: the SDK will not rebuild a host's model under another id. It
  emits one warning naming the ids it made inert. Pass
  [`modelFactory`](/reference/configuration/) instead, which is called
  for the `agent` and `grader` roles with the declared id as `requested`.
- Prompt caching follows the model in force. LangChain's provider-**native**
  caching is graph-level, so it stays wired from the workflow's model. A state
  whose model wants a different native mechanism is named in an assembly
  warning.

### `on_error`

A turn-failure route. A **terminal rejection** commits `rejected` to
checkpointed state, ending the turn. These cause one:

- an automated state's failed run: its script threw or timed out, its grader
  failed or exhausted its budget, or a non-terminal grader or code state finished
  without calling `archmax_advance` or `archmax_raise`;
- an exhausted execution budget (`maxTurns`, `timeoutMs` or `maxParks`);
- a `${{…}}` guard that cannot be evaluated.

An automated state's `on_error` is its own: a code state whose script throws
routes to the target it declares.

A [sub-workflow](/guides/sub-workflows/#failure-is-always-closed) call whose
child fails is the calling state's failure too, but a recoverable one until the
model finishes. Each failed call is recorded on its own, and a later successful
call of the same workflow from the same state recovers one of them: the one
whose arguments it repeats, else the oldest. Every failure still outstanding
when the model finishes routes like a terminal rejection, and the route names
each with its arguments. No success recovers a failure with another cause.

In every terminal case the session routes to the named state. It appends an
explicit `[error]` [runtime
note](/guides/sessions/#delivering-the-event) to the transcript
and emits a `state-error-routed` diagnostic.

**Recoverable** rejections are an invalid edge target and an unmet
`requires`. They keep the caller in place to retry, the agent or an automated
state alike, and leave `on_error` untouched:

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

A **declared failure** never sees `on_error` either. When the agent, a grader
or a code state's script calls `archmax_raise({ code, reason })` because the work
cannot be completed or accepted, the session ends at once with the status
`failed` and that code and reason as its `exit`. No route is taken, no further
state runs, and the trigger's `returns` are not checked. A raise also
replaces a rejection still pending from earlier in the turn. Forbid the tool
(`tools.forbid_always: [archmax_raise]`, or a state's `tools.forbid`) where the
agent must not end the session itself.

A session that finishes **short of its trigger's
[`returns`](/guides/triggers/#a-trigger-may-declare-its-signature)** does not
see `on_error` either. A top-level session ends `rejected`, naming what it left
unset. A sub-workflow child completes instead, and its caller gets the unset
ones empty (`null`) plus a `note` naming them.

### `locks`

The variables this state **owns**. Only the owner may write a variable it owns,
whenever it is entered and in any turn, before or after the variable is set. A
write from any other state is refused, naming the owner:

```yaml
states:
  lookup:
    locks: [order_id]      # decided here, and only here
    transitions:
      - to: act
        description: The order is found.
  act:
    tools:
      allow:
        - { tool: cancel_order, args: { order_id: ["${{order_id}}"] } }
    transitions:
      - to: lookup
        description: The person means a different order.
```

To change `order_id` once the session is in `act`, the agent goes back to
`lookup`. The value is decided again under `lookup`'s tools and
`requires`, and every later state and guard reads the new value on the way
forward. So give an owner an edge back from the states that act on its
variables.

- **Any variable, guarded or not.** `locks` ties a variable to the state that
  decides it.
- **One owner.** Loading fails when two states own the same variable, when
  `locks` names `trigger` or `title`, when it lists a name twice, or when it is on
  a human state, which makes no tool calls.
- **An owned variable stays changeable in its owner.** `archmax_set_variables`
  with `lock: true` is refused for it.
- **The host's value wins.** A variable the host supplies (a seed, a trigger
  input, a delivered variable) stays locked although a state owns its name.
  Assembly and `archmax validate` warn about the overlap.

A lock the agent sets with `lock: true` is different: it is final until
`archmax_reset`, which releases the locks the agent set and keeps their values.
A host's lock is never released.

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
| A host `invoke`, or a trigger firing on a fresh session | the turn is rejected at the turn boundary with `Refusing to start: workflow '<slug>' is disabled.`, before any state runs or any model is called |
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
with `archmax_set_variables` or by a script. The check runs once, as the session
finishes, and hands nothing back:

- a **sub-workflow child** with one of them unset **completes**, and its caller
  gets every declared return, the unset ones `null`, plus `note: "Not all return
  variables were set by the sub-workflow: '<name>' was not set."`;
- a **top-level session** with one of them unset is **rejected**;
- a typed one holding a mistyped value **rejects** the session either way.

A session that *parks* goes unchecked, because it has not finished, and so does
one the agent ended with `archmax_raise`: a failed session owes no returns.
`note` is reserved, so a `returns` list may not name it.

Nothing reads the returns before then. `archmax_advance` checks a state's own
`requires:`, not the trigger's `returns:`, and a later write of a return
replaces an earlier one, until the agent locks it. A seed of one (a name in both
lists) lands **unlocked**, so the session can still write its result. See
[a return is owed when the session finishes](/guides/triggers/#a-return-is-owed-when-the-session-finishes).

Each entry is a bare variable name, or an object `{ name, type?, description?, …rules }`
naming one. The two spellings mix freely in one list. A bare name and an object
with only `name` are the same **untyped** entry, which takes any value, `null`
included. Names are distinct across both spellings, so
`[total, { name: total, type: number }]` is a duplicate. The object is strict: any
other key (a misspelled `type`, say) is a load error naming the entry and the key,
rather than a silent "untyped". The keys it takes are `name`, `type`,
`description` and the [rules](#rules).

`type` is one of nine words. Six are JSON Schema's own types; `date`,
`date-time` and `file` are string formats, promoted because a host renders and
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
| `file` | a string naming a path from the workspace root (`scratchpad/attachments/invoice.pdf`, `skills/billing/assets/template.pdf`): at most one leading `/`, no empty, `.` or `..` segment, no backslash and no trailing `/` | `{ type: string, format: file }` |

A typed entry never takes `null`, because the JSON Schema a host publishes from it
would refuse `null` too. There are no item schemas and no property schemas: what a
value of a type must also look like is said by its rules.

#### Rules

A typed entry may declare **rules** beside its `type`: what its value must look like
beyond its type. Each is spelled as the JSON Schema keyword it maps to, wherever one
exists:

```yaml
requires:
  - { name: customer_email, type: string, format: email }
  - { name: website, type: string, format: url }
  - { name: phone, type: string, format: phone }
  - { name: order_id, type: string, pattern: "^A-[0-9]+$", maxLength: 24 }
  - { name: priority, type: string, enum: [low, normal, high] }
  - { name: note, type: string, maxLength: 2000, content: markdown }
  - { name: quantity, type: integer, minimum: 1, maximum: 100 }
  - { name: due, type: date, minimum: today }
  - { name: tags, type: array, minItems: 1, maxItems: 10 }
  - { name: invoice, type: file, accept: [.pdf], maxSize: 10MB }
returns:
  - { name: contact, type: string, format: email }
```

| Rule | On | Value | Holds when the value |
| --- | --- | --- | --- |
| `format` | `string` | `email`, `url` or `phone` | is an email address (the WHATWG grammar `<input type=email>` uses, with a domain of at least two labels: `ann@localhost` and a quoted local part are refused), an absolute `http://` or `https://` URL with no credentials and no space or control character, or an E.164 phone number (`+4930123456`) |
| `pattern` | `string` | a regular expression, at most 1,000 characters | contains a match: anchor with `^…$` to match the whole value |
| `minLength`, `maxLength` | `string` | a non-negative integer | has at least / at most that many characters, counted in code points |
| `enum` | `string` | a non-empty list of distinct strings | is one of them, exactly and case-sensitively |
| `content` | `string` | `text`, `markdown` or `html` | (a declaration only, see below) |
| `minimum`, `maximum` | `integer`, `number` | a number | is at least / at most it |
| `minimum`, `maximum` | `date` | `YYYY-MM-DD`, or `today` | is not before / not after it; `today` is the current UTC date |
| `minimum`, `maximum` | `date-time` | an RFC 3339 date-time, or `now` | is not before / not after it, offsets applied |
| `minItems`, `maxItems` | `array` | a non-negative integer | holds at least / at most that many entries |
| `accept` | `file` | a non-empty list of extensions, each a dot and a name (`.pdf`) | names a file whose last extension is one of them, case-insensitively |
| `maxSize` | `file` | bytes: an integer, or `<n>KB` / `<n>MB` (1,000-based) | names a file no larger; checked where the value crosses a boundary |

Every bound is inclusive. Nothing is coerced or trimmed: `" a@b.co"` is not an email
address. A rule is checked only on a value of the right type, so a mistyped value
reports its type and no rule. Each entry reports one problem at most: the first rule
its value breaks, in the order `format`/`pattern`, `enum`, `minLength`/`maxLength`,
`minimum`/`maximum`, `minItems`/`maxItems`, `accept`, then `maxSize`. Each refusal
says what the value must do, naming the variable: `'quantity' must be at most 100`,
`'order_id' must match ^A-[0-9]+$`, `'due' must not be before today`.

A rule is held wherever the type is: at the start, at the write, at completion, and at
a delegation call and its settle. A rule declaration that cannot hold is a load error
naming the trigger, the entry and the key, and `validate` reports the same:

- a rule on a type that does not take it, or on an entry with no `type`;
- `format` together with `pattern`: an entry declares one or the other;
- a `pattern` that does not compile, uses a lookaround (`(?=`, `(?!`, `(?<=`, `(?<!`)
  or a backreference (`\1`), or is over 1,000 characters;
- a `min…` above its `max…`, an empty or repeated `enum` or `accept`, a negative or
  fractional length or count, and a malformed bound, extension or size.

The SDK caps no length: a host's own limits on text from outside callers are the
host's policy.

**The regular expression engine.** An author writes a `pattern`, but it runs against
text anyone may send, and a backtracking engine such as JavaScript's `RegExp` takes
exponential time on `(a+)+$` against a long run of `a`s ended by `!`. So a pattern is
never run through `RegExp`: it is matched by RE2, which takes time linear in the value
whatever the pattern. RE2 syntax is ECMA-262's without lookarounds and backreferences.
A pattern must also compile as an ECMA-262 regular expression with the `u` flag, the
way JSON Schema validators read it, so RE2-only syntax such as `(?i)`, `\pL` or
`[[:alpha:]]` is refused too. Where the two engines still read a pattern differently
(`\s` is ASCII whitespace in RE2, and `.` does not match `\n`), RE2's reading decides.

**`content` is a declaration.** It says what kind of text the value holds, and is
carried into the JSON Schema as `contentMediaType`. The runtime never checks or
alters a value for it, and sanitises nothing: what `markdown` or `html` permits is
the host's decision.

Where the types are held:

- **At the start.** A firing whose value for a typed `requires` entry does not
  conform is refused like one that misses a name, before any model call, naming
  the trigger, the variable, the type and what arrived.
- **At the write.** An `archmax_set_variables` call writing a typed return of the
  current turn's trigger with a non-conforming value (of another type, or breaking
  a rule) is refused, atomically, as a correctable tool refusal. The agent writes a conforming value and the session
  goes on. Undeclared and untyped names are written as before.
- **At completion.** A session whose typed return holds a non-conforming value is
  rejected like one that left it unset. The write check covers every
  `archmax_set_variables` call, the agent's and a code state's alike, so this is
  the backstop for a value that reached the session another way.

A `file` value is held to more than its shape. The conformance rule checks the
path alone, so a host can run it anywhere, but at each of those three places, and
at a [delegation call](/guides/sub-workflows/#passing-files), the runtime also
requires the path to name a **file** (not a folder) that the session **may read
on runtime authority**. This check is the one thing the runtime decides on
runtime authority: the state's allow and forbid lists and its skill and mount
grants do not bind it. What does bind it:

- the zone rules (`checkpoints/`, `artifacts/` and `_specs/` are never readable);
- the workflow's mount grants, taken across every state, so a governed mount no
  grant of the workflow names is out of reach;
- every workflow-wide denial, `forbid_always` lists inherited from a caller
  included;
- consumer rules and every safety rule.

A value naming a path with nothing there, a folder, or a path those rules deny is
refused like a non-conforming one, naming the variable and the cause. So is a file
larger than the entry's `maxSize`, or one whose size the store cannot tell:
`'invoice' must be at most 10 MB`.

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
`name (type) — description`, with its rules after the type in the words a refusal
uses (`contact (string; an email address; at most 80 characters) — …`), and an
untyped signature reads as it always has.

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
- a signature entry with an unknown `type`, an unknown key, a name listed twice, or
  a rule that cannot hold;
- an `entry:` or `name:` key.

An event that should always continue an existing session is declared nowhere
here. The host names the session it belongs to
(`agent.workflow.send(sessionId, …)`, `archmax deliver <session> --trigger <id>`),
or supplies a `sessionPath` on the firing. See
[triggers](/guides/triggers/).

## Workflow-level blocks

### `tools.allow_always`

The **workflow-wide grant**: the tools every state has. Declared, it is exactly
what it lists, guards included. Absent, it is the
[default tools](#toolsallow-closed-by-default-governance). A declared list
**replaces** the default tools rather than adding to them, so it names each
default tool the workflow needs beside its own grants:

```yaml
tools:
  allow_always:
    # the default tools: keep the ones this workflow needs
    - ls
    - read_file
    - write_file
    - edit_file
    - glob
    - grep
    - copy_file
    - move_file
    - remove_file
    - write_todos
    - archmax_eval
    - archmax_run
    # workflow-wide grants beyond them
    - { tool: lookup_customer, args: { region: ["eu-*"] } }
```

`allow_always: []` is a declaration too. It grants no tool workflow-wide, so
each state's `tools.allow` grants everything that state uses, which is what
`skills.allow_always: []` means for capabilities.

A per-state `allow` entry for a tool the grant includes takes precedence (the
narrower entry wins), so a state can constrain a tool that is otherwise granted
everywhere. An entry naming a default tool that the declared list leaves out
grants it in that state alone.

A guard on a default tool here is enforced like any other.
`{ tool: write_file, paths: ["reports/**"] }` lets every state write under
`reports/` (and in `scratchpad/`) and nowhere else, unless a state's own entry
says otherwise.

`archmax validate` warns when a declared `allow_always` grants none of the
default tools and no state's `tools.allow` names one either. Such an agent can
read no file, not even an offloaded tool result. List the default tools, or
remove the key to get them back.

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
binds the runtime's own `file`-value check, and binds every child session this
workflow delegates to.

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
  allow_always: [read_file, ls]              # a declared list: replaces the default tools
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
subtracts from the workflow-wide grant, the state's own `allow`, and the host's
`essentialTools` alike, which is how a state opts out of a capability the workflow gives
everywhere. An empty `allow` list leaves the grant standing.

A forbid entry may name the tool `*`, meaning **every** tool. That is vocabulary
the deny side alone has, since a wildcard there can only close the surface
further, and `*` in an `allow` list is a load error.

An entry's argument guards narrow what it denies.
`{ tool: write_file, paths: ["logs/**"] }` denies that tool on those globs and
leaves the rest alone, so the tool stays disclosed and the kernel refuses the
matching call. A bare denial removes the tool from the model's picture entirely.
A `paths:` denial matches a call when **any** of its declared paths matches, so
`{ tool: "*", paths: ["secrets/**"] }` refuses a copy out of `secrets/` and a copy
into it. (A `paths:` grant needs **every** path to match.) An argument holding a
list of paths contributes each element.

`archmax validate` flags three shapes here: a state whose `allow` list would
permit a call a denial blocks, a state that both allows and forbids one tool,
and a denial of `archmax_advance` in a workflow that has anywhere to move, since
no run could leave its start state. The globs cover dotfiles, so a denial of
`secrets/**` blocks a write to `secrets/.env`.

A **grader or a code state** is bound by its own state's `forbid` and by every
workflow-wide denial, like the agent in that state, and a denial can refuse even
one of its control tools. The runtime's own `file`-value check is the one caller
a state's denial leaves free; a workflow-wide denial binds it too.

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

The todo surface is a grant like any other. `write_todos` is one of the default
tools, disclosed and permitted wherever the workflow-wide grant or a state's own
entry includes it. The runtime installs it itself, so the surface stays the same
whatever an upstream default does, and only when some state of the workflow is
granted it. Its guidance sits in the static prompt and its schema is offered
wherever it is granted: together ~13,250 characters per model call, the price of
a planning scratchpad.

To leave it out, omit it from a declared `tools.allow_always` (and from every
state's `tools.allow`), which drops its guidance too. To refuse it outright, list
it in [`tools.forbid_always`](#toolsforbid_always--toolsforbid-denial). `archmax validate`
checks the shape of every field. See
[Token efficiency and cost](/guides/token-efficiency/).

### `metadata`: host data

The one key the runtime never reads, accepted at **two** positions: the spec
root and any state. An authoring UI, such as a workflow builder or
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

This is one named key per position. The spec root and the rest of every state
stay strict, so any *other* unrecognized key is a load error naming
the key and its path.

### `runtime`

A workflow MAY declare the runtime contract it was authored against:

```yaml
runtime:
  engine: archmax-harness
  version: "3"
```

This is a separate version axis from the npm package version. `runtime.version`
names the stable authoring/runtime semantics a workspace expects. Version `"3"`,
the four state types with grader and code states and no `before`/`after` hooks,
is the only one supported, and an omitted `runtime` resolves to it
(`archmax-harness@3`).

A workflow declaring an **unsupported** engine or version fails fast:
`createAgent` throws an `UnsupportedRuntimeContractError` before any model work,
naming the requested and the supported contracts, and `archmax validate` reports
it as an error diagnostic. The retired versions `"1"` and `"2"` are refused the
same way.

The one contract also selects the sandbox script contract (version `3`) and the
case format. A case file carries no version of its own.
