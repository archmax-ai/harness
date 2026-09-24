---
title: Skills
description: Capability bundles in the workspace, governed per workflow and per state by slug.
sidebar:
  order: 4
---

A skill is a **governed capability bundle**: a directory under `skills/<slug>/`.
It holds three things:

- a `SKILL.md` that says what the capability is;
- the `assets/` its states read;
- the `scripts/` the agent may run with `archmax_run`.

A bundle is served through the configured backend like every other workspace
file, and shared across workflows. It is **enabled by slug**, per workflow and
per state, so governance can grant or refuse the whole bundle at once.

A state's behavior lives inline in its `instructions`. A bundle is for a
capability with machinery or data to carry.

## Anatomy of a skill

A bundle follows the Agent Skills format. At its root is a `SKILL.md`: YAML
frontmatter and a markdown body, where the frontmatter carries `name` (matching
the directory) and `description` (what the model is told about it). Beside it
sit the files that make the capability real:

```
skills/order-data/
  SKILL.md              # what the capability is, how its data is shaped
  assets/orders.json    # the records states read
skills/order-enrichment/
  SKILL.md
  scripts/enrich-orders.js   # an archmax_run source — run BY THE AGENT
```

```markdown
---
name: order-data
description: >-
  The order records every answer comes from.
---

# Order data

Every order lives in `assets/orders.json` — `skills/order-data/assets/orders.json`
from the workspace root — as a JSON array of `{ id, customer, email, status,
placed, total }`. Quote `status` exactly.
```

## Governing which skills a state may use

Skills are governed by **slug**, the bundle directory name. `workflow.yaml` has
two levels for it, composing exactly as tools do: the root's `allow_always` is
enabled in **every** state, and a state's `allow` **adds** to it:

```yaml
skills:
  allow_always: [order-data]             # every state has this one

states:
  orders-question:                       # no skills block, and it still has order-data
    instructions: Answer from skills/order-data/assets/orders.json.
  refund-review:
    skills:
      allow: [refund-policy]             # this state adds one, and has both
  identify-case:
    skills:
      forbid: [order-data]               # routes only: opts out of the grant
```

Resolution has **one rule**: a skill is enabled only where a list names it.

- an **absent** state block adds nothing, behaving exactly as `allow: []` does,
  and exactly as an absent `tools.allow` grants no tool.
- `allow_always` is a **grant**. A slug named there and nowhere else is enabled
  in every state, so no state repeats it.
- a state's list **adds**: the enabled set is the union of the two. An
  `allow: []` reads like a deny and subtracts nothing, and `archmax validate`
  warns about one.
- **`skills.forbid` is what subtracts.** On a state it removes a slug from that
  state's enabled set, the workflow's `allow_always` included. So one state opts
  out of a capability every other state keeps. At the root,
  `skills.forbid_always` puts a bundle out of reach of the whole workflow.
- a deny beats an allow at both levels, and a refusal says which:
  `skill.forbidden` for a bundle a list denies, `skill.not-allowed` for one
  nothing granted.
- an empty root block (`allow_always: []`) is how a workflow says its
  capabilities are all state-specific. Its states carry the whole grant.

So a workflow declares a capability **once**, at the level where the decision
was made. Use `allow_always` for what every state needs, and a state's `allow`
for what belongs to that state alone. It is the same shape as
`tools.allow_always` and `tools.allow`.

Enabling a slug is a **grant**: `skills/order-data/**` becomes readable and its
scripts runnable, with no `tools.allow` path entries at all. A skill the state
leaves unenabled is:

- **unreachable**: `read_file`, `ls`, `glob`, `grep`, and `archmax_run` on
  anything inside the bundle are refused. The non-overridable
  `skill.not-allowed` rule does it, ahead of consumer rules and the state's own
  `tools.allow`. No wildcard entry and no `allow_always` grant widens it.
- **invisible**: its slug and description stay out of that state's prompt, and
  `ls skills/` in that state omits it.

`archmax_run` executes only scripts that live inside a bundle (the
`script.skill-only` rule). So **a state that enables no skill can run no script
at all**: the tool is still on the surface, and refuses every path it is given.

That is why capability governance belongs here. One declaration covers the whole
bundle, where `tools.allow` path globs take one entry per file tool. A path
entry would also leave the skill *advertised* in every state's prompt while
refusing the read, so the model keeps reaching for something it cannot have.

The two mechanisms **compose** as *enabled AND allowed*, and a `tools.allow`
entry still narrows **within** the enabled set. Put
`{ tool: archmax_run, paths: ["skills/order-enrichment/scripts/**"] }` beside
`skills: { allow: [order-enrichment] }` and execution narrows to that one
bundle's scripts.

On its own, `skills: { allow: [order-enrichment] }` lets `archmax_run` reach the
scripts of every enabled bundle. A script the agent wrote into `scratchpad/`
stays refused either way, by the `script.skill-only` safety rule.

Lifecycle **hooks are exempt**, exactly as they are exempt from a state's
`tools.allow`, because a `before` hook runs on runtime authority. So a routing
state can enable nothing while the hook that enforces tenancy still reads the
order records. That is how the bundled example's `identify-case` state is
written.

`archmax validate` reports these as errors:

- a slug no source provides, listing the known ones;
- a path- or glob-shaped entry;
- a `SKILL.md` whose `name:` disagrees with its directory;
- a `tools.allow` path entry that can only match a skill the state does not
  enable.

It also warns in these cases:

- a state entry names a slug `allow_always` already grants everywhere;
- an `allow: []` beside such a grant subtracts nothing, naming `forbid` as what
  does;
- a `forbid` entry has nothing to subtract;
- `forbid_always` cancels a grant outright;
- a spec declares no root `skills` block at all while the workspace serves
  bundles, naming what the workflow cannot reach. That warning is reported once,
  and any root block silences it, `allow_always: []` included.

## Where a skill's machinery lives

A skill bundle is also where a capability's own machinery lives, in two
directories:

- `skills/<name>/scripts/`, the **runtime scripts** the agent executes with
  `archmax_run`;
- `skills/<name>/assets/`, the data its states read.

That is why the bundled example ships three bundles (`order-data`,
`refund-policy`, `order-enrichment`), while each state's *routing* guidance
stays inline in its `instructions`. Reach for a `SKILL.md` in three cases: a
capability has machinery to carry, a state's guidance outgrows an inline string,
or guidance is shared across workflows.

**Lifecycle hook scripts do not live here.** The runtime runs a hook, so it
belongs on the authoring plane beside the spec that wires it
(`workflows/<slug>/hooks/<check>.js`), out of the agent's reach entirely.
`archmax_run` is confined to skill bundles by a non-overridable kernel rule, so
the two classes cannot meet. See [The authoring plane](/guides/authoring-plane/).

## Where skills fit

| Layer | Role |
| --- | --- |
| `workflow.yaml` | *Enforcement*: what the agent may do |
| State `instructions` (+ optional `skills/<name>/SKILL.md`) | *Guidance*: how the agent should do it |
| `AGENTS.md` | *Persona*: who the agent is |

A skill's *contents* are guidance. A skill can tell the agent to write just
`reports/answer.json`, and a `tools.allow` entry is what
[actually guarantees it](/guides/workflow-machine/#tool-governance).
That guarantee covers paths outside `scratchpad/`, which every state may write.

So pair every skill instruction that matters with a matching governance rule or
an `after` hook. What *is* enforced about a skill is its `skills.allow`
membership: whether a state may reach the bundle at all.

## Where skills come from

The runtime reads skills through the configured backend, never `fs`. It reads
them from the **sources** given by the `skills` assembly option, which defaults
to `["skills/"]` (matching the `skills/` key in `defaultMounts`). A source is
either a parent directory of bundles or a single bundle (`skills/order-data/`),
the two Agent Skills forms.

Disclosure, the decision kernel, and `archmax validate` share that one resolved
registry, so a prompt advertises exactly what governance would allow. A source
that serves nothing is fine: it is a workspace without that kind of capability.
