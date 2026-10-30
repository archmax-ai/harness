# `workflow.yaml` reference

Load this when you write or edit a `workflow.yaml`. It holds every key, the rules the
machine enforces, and governance. How grader and code states run, and how to write
scripts, is in [`code-states-and-scripts.md`](code-states-and-scripts.md). Cases are in
[`cases.md`](cases.md).

The schema is strict: an unknown key anywhere is a load error that names the key. The
one free slot is `metadata`. A trigger declaration also keeps a host's own keys, with a
warning.

## Contents

- [The skeleton](#the-skeleton)
- [Files](#files)
- [Root keys](#root-keys)
- [State keys](#state-keys)
- [Transitions and what the agent sees](#transitions-and-what-the-agent-sees)
- [Triggers and signatures](#triggers-and-signatures)
- [Variables](#variables)
- [Tool governance](#tool-governance)
- [Skill governance](#skill-governance)
- [Mount governance](#mount-governance)
- [Moving, parking and failing](#moving-parking-and-failing)
- [Budgets and `on_error`](#budgets-and-on_error)
- [Sub-workflows](#sub-workflows)
- [Models](#models)
- [Prompt economy](#prompt-economy)
- [Removed keys](#removed-keys)
- [Paths and zones](#paths-and-zones)

## The skeleton

Every key, in a workflow that validates clean. Start a new workflow from it and delete
what you do not need.

```yaml
title: Refund desk                 # a label; the directory name is the workflow's slug
instructions: |-                   # rules for the whole session (a warning when absent)
  Decide only from records you have read; never guess an order.

  Write every file under scratchpad/.
runtime: { engine: archmax-harness, version: "3" }   # "3" is the only contract; omit the block for it
disabled: false                    # true: no new turns start; parked sessions still finish
settings:
  model: gpt-5-mini                # the model id every state runs on; overrides ARCHMAX_MODEL
  timeoutMs: 15000                 # per sandbox evaluation: one archmax_run call, one code-state script
  memoryLimitBytes: 67108864       # sandbox memory
  maxPtcCalls: 200                 # tools.* calls per evaluation
  maxResultChars: 20000            # characters of an evaluation's result
  prompt_cache: { enabled: true, ttl: 5m }   # provider prompt caching; ttl 5m or 1h
tests:                             # the case suite
  maxConcurrency: 1                # only 1 is accepted
  caseTimeoutMs: 120000            # wall clock per case
  judge: {}                        # required by grade: ({} = the env model, or { model, modelOptions })
metadata: { canvas: { zoom: 1 } }  # host data the runtime never reads; keep it as you find it

tools:
  allow_always:                    # the workflow-wide grant. Declared, it REPLACES the twelve
    - ls                           #   default tools, so list them all and drop only what this
    - read_file                    #   workflow must not have. A host tool every state needs
    - write_file                   #   goes here too.
    - edit_file
    - glob
    - grep
    - copy_file
    - move_file
    - remove_file
    - write_todos
    - archmax_eval
    - archmax_run
  forbid_always: [archmax_reset]   # denied in every state, whatever grants it; "*" = every tool
skills:
  allow_always: [order-data]       # skill bundles enabled in every state, by slug
  forbid_always: []                # skill bundles no state may reach

states:
  decide:                          # the key is the state's slug
    title: Decide the refund       # a label for people; no model reads it
    summary: Record the decision and draft the email.   # a label for editors; no model reads it
    triggers:
      manual:                      # the entry the CLI, a host and a calling workflow use
        description: Decide one refund request.   # for callers; never shown to this session
        requires:                  # what a start must supply
          - email                  #   a bare name takes any value
          - { name: order_id, type: string, description: The order to refund. }
          - { name: contact, type: string, format: email }   # a rule beside the type
        returns: [decision]        # what the session guarantees when it completes
      email_reply:                 # a host trigger; its payload arrives as locked variables
        session: conversation_id   #   a dotted path over the variables: the session it joins
        message: false             #   host-resolved: where the message is, or false for none
        connection: mail           #   host-resolved: an access connection
    instructions: >-
      Look the customer up with lookup_customer. Record the decision with
      archmax_set_variables as `decision` (approved or denied), draft the email
      in scratchpad/email.md, then advance to check-decision. If a note sends
      you back, fix what it names and advance again.
    tools:
      allow:                       # adds to allow_always; naming a granted tool narrows it here
        - lookup_customer
        - { tool: write_file, paths: ["reports/${{order_id}}/*.md"] }
        - { tool: archmax_run, paths: ["skills/refund-policy/scripts/**"] }
        - archmax_workflow_enrich-order   # calls workflows/enrich-order/ as a sub-workflow
      forbid:                      # denied while this state is active; beats every grant
        - { tool: read_file, paths: ["skills/order-data/assets/archive/**"] }
    skills:
      allow: [refund-policy]       # adds to skills.allow_always
    requires: [decision]           # must be set before the session may leave this state
    locks: [decision]              # only this state may write it
    model: gpt-5                   # this state's model id; beats settings.model
    budget: { timeoutMs: 60000, maxParks: 3 }   # per model call; archmax_wait parks here
    on_error: escalate             # where a failure of this state routes
    transitions:                   # none: a terminal state
      - to: check-decision
        description: The decision is recorded and the email is drafted.   # required; say WHEN

  check-decision:                  # a code state: runs its script, no model call
    type: code
    script: scripts/check-decision.js   # workflows/<slug>/scripts/check-decision.js
    tools: { allow: [lookup_customer] }  # what the script calls is granted HERE
    on_error: escalate
    transitions:
      - { to: review, description: The decision matches the refund policy. }
      - { to: decide, description: The decision contradicts the refund policy. }

  review:                          # a human state: a person picks the transition
    type: human
    instructions: Confirm the decision before the email goes out.   # required: the decision
    evidence: [scratchpad/email.md]   # always shown to the person
    approvers: [finance@example.com]  # informational; not enforced
    transitions:                   # one per labelled type; never to itself
      - { to: review-email, type: approve, description: Approve the decision. }
      - { to: decide, type: refine, description: Send it back with a comment. }

  review-email:                    # a grader state: an isolated subagent decides
    type: grader
    instructions: |-               # required: its criteria
      Read scratchpad/email.md and the `decision` variable.
      - Polite, states the decision plainly and names the order: advance to `send`.
      - Otherwise advance back to `decide`, saying exactly what to change. If the
        trail already holds two steps with kind "grader" and to "decide", raise
        `email-rejected` instead.
    model: gpt-5                   # resolved under the grader model role
    budget: { timeoutMs: 60000 }   # bounds its whole run
    on_error: escalate
    transitions:
      - { to: send, description: The email is ready to send. }
      - { to: decide, description: The email needs changes. }

  send:                            # terminal: no transitions
    tools: { allow: [send_email] }
    instructions: Send scratchpad/email.md to `email` with send_email.

  escalate:
    instructions: Tell the customer that a person will follow up.
```

## Files

- `workflows/<slug>/workflow.yaml` is the machine: a plain YAML mapping with no
  frontmatter. The directory name is the workflow's slug, kebab-case
  (`^[a-z0-9]+(-[a-z0-9]+)*$`). `title` is only a label.
- `WORKFLOW.md` beside it is optional Markdown, appended to the prompt after the
  graph section. Frontmatter in it is a load error. Put a diagram for human readers
  inside an HTML comment: comments are stripped from the prompt.
- `scripts/` holds the code-state scripts and `tests/` the cases.

## Root keys

| Key | What it does |
| --- | --- |
| `title` | A label for people. |
| `instructions` | Rules for the whole session, rendered once at the top of the cacheable prompt prefix. Write a literal block (`\|-`): a folded block (`>-`) joins paragraphs. A warning when absent. |
| `runtime` | `{ engine: archmax-harness, version: "3" }`. `3` is the only contract and the default. `1` and `2` are refused. |
| `disabled` | `true` starts no new turns: `archmax run`, a host's turn, a follow-up message and a calling workflow's `archmax_workflow_<slug>` call are refused. `decide`, `reply` and `deliver` still work, so parked sessions finish. `archmax test` skips the suite and exits 0. Any value but absent, `null` or `false` disables, and a non-boolean is a validate error. |
| `settings.model` | The model id every state runs on, over the endpoint the host configured. It overrides `ARCHMAX_MODEL`. An id only: a mapping with `temperature` is a load error. |
| `settings.timeoutMs` | Bounds one sandbox evaluation (default 15000): an `archmax_eval` or `archmax_run` call, or a code state's whole script. `memoryLimitBytes`, `maxPtcCalls` and `maxResultChars` bound it too. |
| `settings.prompt_cache` | `{ enabled, ttl: 5m \| 1h }`: provider prompt caching, on by default. |
| `tests` | The case suite: `maxConcurrency` (only `1`), `caseTimeoutMs` (default 120000, per case) and `judge`, which `grade:` requires (`{}` is the env model; or `{ model, modelOptions: { temperature, maxTokens } }`). |
| `tools` | `allow_always` and `forbid_always`: [Tool governance](#tool-governance). |
| `skills` | `allow_always` and `forbid_always`, by slug: [Skill governance](#skill-governance). |
| `mounts` | `allow_always` and `forbid_always`, by mount name: [Mount governance](#mount-governance). |
| `metadata` | Host data, such as an editor's canvas. Never read or checked. Keep it verbatim when you rewrite a spec. |
| `states` | Required: at least one state, and at least one with a trigger. |

## State keys

The key under `states` is the state's slug, kebab-case. It is the only token that `to`,
`on_error`, `archmax_advance`, events and `reachedState` resolve, so rename a state only
together with every reference to it.

| Key | On | What it does |
| --- | --- | --- |
| `type` | — | `agent` (the default), `human`, `grader` or `code`. |
| `title`, `summary` | all | Labels for people and editors. No model reads them, so they cannot carry routing. |
| `triggers` | all | Marks an entry state: [Triggers and signatures](#triggers-and-signatures). |
| `instructions` | agent, human, grader | An agent state's behaviour, shown while it is active. Required on a human state (the decision to present) and on a grader (its criteria). |
| `script` | code | Required on a code state and refused elsewhere: `scripts/<file>.js` or `.mjs`, no `..`, resolving to `workflows/<slug>/scripts/<file>`. |
| `tools`, `skills`, `mounts` | all | This state's `allow` and `forbid` lists. A grader's and a code state's calls are held to their own state's lists. |
| `requires` | all | Variables that must be set before the session may leave the state. |
| `locks` | agent, grader, code | Variables only this state may write. One owner per variable, and never `trigger` or `title`. |
| `model` | agent, human, grader | This state's model id; it beats `settings.model`. Naming the workflow's own id is a warning. |
| `budget` | agent, grader | `timeoutMs` and `maxParks`: [Budgets and `on_error`](#budgets-and-on_error). |
| `on_error` | all | The state a failure of this state routes to. |
| `transitions` | all | `[{ to, description, type? }]`. A state with none is terminal. |
| `evidence`, `approvers` | human | Paths always shown in the decision record; who decides (informational). |
| `metadata` | all | Host data, never read. |

What each type needs and refuses:

| Type | Who runs it | Requires | A validate error |
| --- | --- | --- | --- |
| `agent` | the session's agent | — | — |
| `human` | a person picks the transition | `instructions`, at least one transition | a transition to itself, two transitions of one labelled `type` |
| `grader` | an isolated subagent | `instructions`, at least one transition | `evidence`, `approvers`, `budget.maxParks` |
| `code` | its script, in the sandbox | `script` | `instructions`, `model`, `budget`, `evidence`, `approvers` |

Grader and code states are **automated states**: the runtime runs them on entry, with no
call of the agent's model. [`code-states-and-scripts.md`](code-states-and-scripts.md)
says how they run, what they are offered and how they settle.

## Transitions and what the agent sees

The agent is shown the active state and nothing else of the graph. Each model call carries
that state's transitions:

```
Transitions — choose one with `archmax_advance` when this state's work is done:
- to `check-decision` (code) — The decision is recorded and the email is drafted.
- to `review` (human decision node) — The decision needs a person's approval.
- to `review-email` (grader) — The email is drafted.
- to `escalate` (terminal) — The order does not exist.
```

The marker says what taking the transition leads to: a person decides next, a grader or
code state runs at once and may send the session straight back, or the session ends. A
transition's `type`, other than `none`, is shown too. Nothing else of the target is
disclosed: not its title, summary, instructions, script or transitions.

So every transition needs a `description`, a non-empty string, whatever the state's
type. It is all the agent learns about the transition. Write it for a reader standing in
the source state:

- Say **when** to take it: `The refund is over $50, or the customer has asked twice.`
- Never say **where** it goes: `Go to refund-review.` tells this reader nothing.
- Keep routing conditions out of the target. A target's `summary` and `instructions`
  never reach the state that routes into it.

At a human state the description is also the button's label, and `type` (`approve`,
`reject`, `refine`, `none`) labels the choice. Each labelled type maps to one target. A
`refine` transition carries the person's comment back as a correction. On other states
`type` is metadata the marker shows.

A session is in one state at a time: there is no fan-out. Sequence what would be
branches; concurrency belongs to sub-workflow calls.

## Triggers and signatures

A trigger is declared under the `triggers:` of the state it enters, keyed by its id. That
state is its entry. There is no root `triggers:` block, and `entry:` or `name:` inside a
declaration is a load error. Several keys on one state make it the entry for each; where
their paths differ, branch on `${{trigger}}` (a script reads `trigger`). Each trigger id
belongs to one state.

- **`manual`** is the entry the CLI, a host's plain turn and a calling workflow use.
- **Any other id** is a host trigger. Its payload arrives as locked variables.
- **`session:`** is a dotted path over the variables that names the session the trigger
  joins (`conversation_id`, or `triggers.-1.conversationId`, where `-1` is the last
  element). Write the bare path, not `${{…}}`. Without one, or when it does not resolve,
  the trigger starts a session of its own.
- **`message:`** (a dotted path, or `false`) and **`connection:`** (a slug) are read by
  the host, not by the runtime.
- **A key the harness does not define** is kept, with a warning. A host's own keys go
  there.
- **Every declared trigger starts a session.** An event that must only reach a live
  session is declared nowhere: the host delivers it to that session by id.

**The signature.** `requires` and `returns` are the session's contract with its caller,
and both are enforced.

- An entry is a bare variable name, which takes any value (`null` included), or
  `{ name, type?, description?, …rules }`. The two forms mix in one list.
- `type` is one of `string`, `integer`, `number`, `boolean`, `date` (`YYYY-MM-DD`),
  `date-time` (RFC 3339 with an offset), `object`, `array` or `file`. Nothing is coerced
  (`"4"` is not an `integer`), and a typed entry never takes `null`. A typed entry is
  held at the start, at each `archmax_set_variables` of a typed return, and at
  completion.
- **Rules** say what a typed value must look like beyond its type, as JSON Schema
  keywords, and are held wherever the type is. Each entry reports the first rule it
  breaks (`'quantity' must be at most 100`).

  | Rule | On | Value |
  | --- | --- | --- |
  | `format` | `string` | `email`, `url` (absolute `http(s)://`) or `phone` (E.164) |
  | `pattern` | `string` | a regex found anywhere in the value (anchor it with `^…$`) |
  | `minLength`, `maxLength` | `string` | counts of code points |
  | `enum` | `string` | a list of distinct strings, matched exactly |
  | `content` | `string` | `text`, `markdown` or `html`: for the host, never checked |
  | `minimum`, `maximum` | `integer`, `number`, `date`, `date-time` | inclusive; `today` and `now` for the dates |
  | `minItems`, `maxItems` | `array` | counts of items |
  | `accept`, `maxSize` | `file` | extensions like `.pdf`; bytes, or `<n>KB` / `<n>MB` |

  A rule on a type that does not take it or on an untyped entry, `format` with
  `pattern`, a pattern with a lookaround or a backreference, and inconsistent bounds are
  load errors. A `pattern` runs in RE2, so no input can make it slow.
- A start that omits a `requires` name, or supplies a mistyped one, is refused before
  any model call.
- `returns` is checked when the session completes. A top-level session with a return
  unset is rejected. A sub-workflow child completes anyway, and its caller gets the unset
  ones as `null` plus a `note`. A mistyped return is rejected either way. A parked session
  is not checked.
- A return is owed only at the finish: no state needs it to leave, and a later write
  replaces an earlier unlocked one. Lock a return only once it is final. `note` is
  reserved and may not be declared.
- A `file` value is a workspace path to a file the session may read. Tell the agent to
  write the file before it sets the variable: `archmax_set_variables` refuses a path with
  nothing there.
- The trigger's `description` is for callers: a calling model, an MCP client. The session
  it starts never sees it. An entry's own `description` is shown to the agent beside the
  name.
- Type an entry when something outside the session builds or reads the value. Leave it
  bare when any value will do.

## Variables

A session has one flat store of variables, `name → value`, never declared. A variable
exists once something sets it:

- **The host** seeds it: `--variables`, `createAgent({ variables })`, a turn's
  `variables`, a delivery. Every seed is **locked**, so `archmax_set_variables` refuses
  to change it.
- **The agent** sets it with `archmax_set_variables`; `lock: true` freezes it until
  `archmax_reset`. A misspelled name creates a new variable, and a state's `requires` is
  what surfaces the mistake.
- **A state owns it** with `locks: [name]`: only that state writes it, so changing it
  means going back there. Give the owner a transition back from the states that use it,
  and pair `locks` with `requires`.

Two names are reserved. `trigger` holds the current trigger id and is always locked.
`title` is the session's one-line task label: the agent sets it (a sub-workflow child is
not asked to), it is never locked, and a host's seed of it lands unlocked.

**References.** `${{name}}` or `${{a.b.-1.c}}` resolves against the variables in two
places:

- **In a `tools.allow` glob**, as a guard:
  `{ tool: gmail__send, args: { to: ["${{from_email}}"] } }`. Lock what a guard reads,
  and guarantee it: name it in an earlier state's or the trigger's `requires`, or seed
  it. A guard that cannot resolve fails the session.
- **Inside any text argument the model writes**, mid-string and as often as needed. The
  tool receives the value, while the transcript keeps the reference, so a stored value
  costs its tokens once. Tell a state that must emit a stored value to write the
  reference (`Quote the customer's message by writing ${{inbound.text}}`): a reference is
  exact where a retyped copy drifts. A reference that cannot resolve is refused, and the
  agent retries.

A value is matched literally, so a variable never widens a guard. A path reads own
properties and must end at a scalar. Write `$${{name}}` for the literal characters.
Scripts get no references: they read `variables` (a code state) or `args.variables`
(`archmax_run`).

## Tool governance

Governance is closed by default. **A denial beats every grant, and no narrower level
widens a denial.**

**The workflow-wide grant** is `tools.allow_always`, granted in every state. When the
key is absent, it is the twelve **default tools**: `ls`, `read_file`, `write_file`,
`edit_file`, `glob`, `grep`, `copy_file`, `move_file`, `remove_file`, `write_todos`,
`archmax_eval` and `archmax_run`. When it is declared, an empty list included, it is
exactly what it lists: it *replaces* the default tools. So a new workflow lists all
twelve and drops only what it must not have.

**A state's `tools.allow`** adds to that grant. An entry naming a tool the workflow-wide
grant includes **narrows** it in that state; an entry naming a default tool that a
declared `allow_always` leaves out grants it there. Every other tool, a host tool or a
delegation tool, needs an entry.

**Denials** sit beside the grants. `tools.forbid_always` at the root denies in every
state, and in every sub-workflow the session calls. A state's `tools.forbid` denies
while it is active. Both beat the workflow-wide grant, the state's `allow` and a host's
`essentialTools`.

**Each state type's own tools** come from one table, `STATE_TYPE_TOOLS` on
`@archmax-ai/harness/spec`. A type's controls need no grant, though a `forbid` can still
block one. What a type withholds, no grant can give.

| State type | Controls it always has | Never offered |
| --- | --- | --- |
| `agent`, `human` | `archmax_advance`, `archmax_reset`, `archmax_wait`, `archmax_raise`, `archmax_get_variables`, `archmax_set_variables` | — |
| `grader`, `code` | `archmax_advance`, `archmax_raise`, `archmax_get_variables`, `archmax_set_variables`, `archmax_get_history` | `write_todos`, `archmax_eval`, `archmax_run`, `archmax_wait`, `archmax_reset` |

- `archmax_advance` is absent in a terminal state.
- A withheld tool listed in `allow_always` is left out of a grader or code state. One
  named in that state's own `tools.allow` is a validate error.
- Deep Agents' `task` is callable in no state, and naming it in any allow list is a
  validate error: grading is a grader state, and delegating is a sub-workflow.
- A host's `essentialTools` are on in every state.

**Entries.**

```yaml
- read_file                                                     # a bare name: any arguments
- { tool: write_file, args: { file_path: ["reports/*.json"] } } # matches when any glob matches
- { tool: copy_file, paths: ["skills/**", "reports/**"] }       # every path argument must match
- { tool: "*", paths: ["secrets/**"] }                          # forbid lists only: every tool
```

- A path argument (a tool's declared paths, else `file_path`) is canonicalized before it
  is matched. Any other argument, such as a URL or an address, is matched as written.
- `*` never crosses `/`; `**` does. Globs match dot-files, so `secrets/**` covers
  `secrets/.env`. `""` matches only an empty value.
- In an allow entry, `paths:` needs every path argument to match. In a forbid entry, one
  match denies.
- `"*"` as the tool is legal only in a forbid list.
- An entry may also carry `connection` (the connection a platform tool resolves through)
  and `source` (a host's label). The runtime matches by `tool` alone.

**Path arguments.** Each tool declares how it uses each path argument: `read`, `list`,
`search`, `write`, `remove` or `execute`. `copy_file` and `move_file` take
`{ source, destination, overwrite? }`, and `move_file` removes its source. `remove_file`
takes `{ file_path }`. A removal is refused wherever a write is, a call naming several
paths is refused when any one is, and an existing destination is refused without
`overwrite: true`.

**The scratchpad.** `scratchpad/` is open in every state to each default file tool the
state is granted, whatever the granting entry narrows. So an allow entry inside
`scratchpad/` narrows nothing, and validate warns. To govern *where* a result lands,
allow a path outside the reserved zones, such as `reports/*.json`.

**The order of decision.** The first rule that applies wins:

1. Skill and mount governance. A path in a skill bundle or a governed mount the state
   does not have is refused first (`skill.not-allowed`, `mount.not-allowed`,
   `mount.forbidden`, `mount.read-only`).
2. Declared denials: `forbid_always`, then the state's `forbid`.
3. The state type's controls.
4. The state's `tools.allow`. A narrowing entry wins over the broader grant.
5. The workflow-wide grant, its guards included.
6. The host's `essentialTools`, where no state entry narrows them.
7. Everything else is refused.

The model is shown only the active state's tools, by name. The kernel still checks every
argument at call time.

## Skill governance

A skill bundle is governed by its slug, never by path. The lists compose like the tool
lists:

```yaml
skills:
  allow_always: [order-data]            # enabled in every state; name it on no state
states:
  answer: {}                            # has order-data
  refund:
    skills: { allow: [refund-policy] }  # adds one, and has both
  route:
    skills: { forbid: [order-data] }    # opts out of the workflow-wide grant
```

- Enabling a slug makes `skills/<slug>/**` readable and its scripts runnable, with no
  `tools.allow` entry. A bundle a state does not enable is unreachable and undisclosed:
  its slug is not in the prompt, and a listing of `skills/` does not show it.
- `allow` only adds, so `allow: []` denies nothing (a warning). `forbid` subtracts, the
  workflow-wide grant included. `forbid_always` puts a bundle out of reach everywhere.
- A workspace that serves bundles warns once when a spec has no root `skills` block.
  Write `skills: { allow_always: [] }` when every bundle is state-specific.
- A `tools.allow` entry still narrows inside an enabled bundle:
  `{ tool: archmax_run, paths: ["skills/<slug>/scripts/**"] }` confines execution to that
  bundle's scripts.
- `archmax_run` runs only skill-bundle scripts (rule `script.skill-only`). A script in
  `scratchpad/` or `workflows/` cannot run, so a state that enables no bundle runs no
  script.
- A grader or code state enables what it reads in its own `skills.allow`. To let a check
  read a bundle the agent must not use, enable it on the check's state only.

## Mount governance

A mount is a folder or a file the host routes into the agent's workspace: `skills/`,
`AGENTS.md`, a `reference/` folder. The host decides its backend, whether it is writable,
and whether the spec governs it. Naming a folder in a spec does not create it: ask the
host to mount it.

- An **ungoverned** mount, the default, is visible in every state. Only a `forbid` takes
  it away.
- A **governed** mount (`governed: true` in the host's table) is reachable only where a
  `mounts` list grants it, exactly like a skill bundle: `allow_always` at the root,
  `allow` on a state, `forbid` and `forbid_always` to subtract. A name is the mount's key
  without its slashes (`reference`, `catalogs/eu`), never a glob.
- An entry is a name, which reads, or `{ mount: <name>, access: read | read_write }`. A
  governed mount is writable in a state only when the host serves it writable, some grant
  of this workflow asks `read_write`, and no grant that applies in the state says `read`.
  The host's read-only is a ceiling no grant lifts.
- A mount the state does not have is hidden from listings and searches, the workspace
  root's listing included.
- A write the host's wiring refuses is `zone.read-only`. One the spec refuses is
  `mount.read-only`.
- Validate errors on a name the host's table does not mount. It warns on a grant to an
  ungoverned mount, on `read_write` for a read-only mount, and, once, on a missing root
  `mounts` block in a workspace that governs mounts.

## Moving, parking and failing

- **Advance.** The agent moves only with `archmax_advance({ to, reason, evidence? })`, one
  per message. The transition and the state's `requires` are checked, and a refusal leaves
  the agent in the state to try again. Then the target's tools unlock, or a grader or code
  target runs at once. Human decisions, `on_error` routes and automated states' own
  advances are the other ways a session moves.
- **Reset.** `archmax_reset({ reason })` returns the session to the entry state it began
  in and releases the agent's locks. Forbid it with `forbid_always` when a session must
  never restart.
- **Wait.** A state that needs an outside event calls `archmax_wait({ reason, until? })`
  in the same message as its question. Any agent state may, terminal ones included.
  `until` (`30m`, `2h`, `1d` or an ISO instant) becomes a `resumeAt` for the host's
  scheduler; the runtime keeps no timer. Any delivered trigger continues the **same
  state**, with its payload as locked variables and an `[event]` runtime note, and the
  state then picks its own transition. Bound a polling loop with `budget.maxParks` and an
  `on_error`.
- **Human states.** Entering one parks the session with a decision record: the state's
  `instructions`, its `evidence` plus any paths the advancing agent attached with
  `archmax_advance({ evidence })`, and its transitions. A person picks the transition,
  and the target state reads the choice and the comment as a `[decision]` runtime note.
  Entering the state spends one reply-only model call, so the park carries a handoff
  message. Do not tell the agent to announce the handoff, or it says it twice. While the
  session is parked, a `reply` is answered on a reply-only turn (every tool call is
  refused) and the session stays parked. Use a human state when a person picks the
  transition, and `archmax_wait` when an event or a time continues the work.
- **Raise.** When the work cannot be completed, `archmax_raise({ code, reason })`, alone
  in its message, ends the session `failed` at once: no `on_error` route, no `returns`
  check. `code` is a free-form token of up to 64 characters, so name the codes a host
  branches on in the state's `instructions`. Raise is for failure only: a session that
  never raises succeeds. A child that raises fails its caller's call with kind `raised`.
- **The next turn.** A finished session given a new message takes its next turn in the
  state it ended in, not at the entry. A session that completed in a terminal automated
  state opens at its trigger's entry. Give a state transitions onward when a conversation
  must move on from it, or park instead of finishing.

## Budgets and `on_error`

- `budget.timeoutMs` bounds each model call of an agent state, and a grader's whole run.
  `budget.maxParks` bounds how often an agent state parks with `archmax_wait`. A code
  state takes no `budget`: `settings.timeoutMs` bounds its script.
- A **turn** is bounded by LangGraph's `recursionLimit`: 400 graph steps unless the
  host's invoke config sets one. Every model call, tool batch and automated state is a
  step. A turn that hits the limit, a cycle of automated states included, ends the
  session `failed` with `recursion-limit`. It does not route through `on_error`.
- **Failures route to `on_error`**: an exceeded `timeoutMs` or `maxParks`, a failed
  sub-workflow call nothing recovered, and a grader or code state that fails (it threw,
  timed out, or finished without advancing or raising). The target state reads the
  reason as an `[error]` runtime note. Without an `on_error`, the failure ends the
  session rejected.
- **Refusals leave the agent in place**: an undeclared transition, unmet `requires`, an
  ordinary governance refusal. A tool that throws is answered with its error, and the
  agent may retry or change course; `on_error` never sees it.
- Declare `on_error` on every grader and code state, and on every bounded loop.

## Sub-workflows

A state calls another workflow of the workspace by allowing `archmax_workflow_<slug>`,
with the slug verbatim. That entry is the whole declaration.

```yaml
enrich:
  instructions: >-
    Call archmax_workflow_enrich-order with the order id, then record what it
    returns as `enrichment` with archmax_set_variables.
  requires: [enrichment]                # nothing records the result for you
  tools:
    allow: [archmax_workflow_enrich-order]
  on_error: enrichment-failed
  transitions:
    - { to: reply, description: The order is enriched. }
```

- **The child's `manual` trigger is the call's signature.** Its `requires` are the
  parameters (typed where the entries are typed), its `returns` the result, and its
  `description` leads the tool's description. Its `instructions` never reach the caller.
- **The call answers** `{ message, returns: { … } }`, or the closing message alone when
  the child declares no `returns`. Nothing records the answer: the caller's agent sets
  what it needs, and the calling state's `requires` makes that mandatory.
- **The child is a separate session** (`<parent>~<n>`) with a fresh transcript, its own
  `scratchpad/`, and its own grader and code states. It receives only its arguments, as
  locked variables. A `file` argument or return is copied into the receiving session's
  `scratchpad/attachments/`, so type file entries `file`: a bare path names a file the
  other session cannot read.
- **One call runs one child.** Fan out with parallel tool calls, or with `Promise.all` in
  a script. Depth is bounded at 3 and concurrency at 4.
- **A refused call ran nothing**: a missing, mistyped or unresolvable argument, a
  disabled target, a cycle, a chain too deep. Correct it and retry.
- **A failed call is the calling state's failure**: the child failed or raised, or
  returned a mistyped value. It routes through `on_error` when the agent finishes, unless
  a later successful call of the same workflow from the same state recovers it. One
  success recovers one failure: the one with the same arguments, else the oldest.
- **A whole-argument reference keeps its type**: `{ quantity: "${{count}}" }` passes the
  number.
- **A child's human state parks the child and its caller.** Deciding it finishes the
  child, and the caller carries on. A script's call cannot park: a child that reaches a
  human state fails it.
- **`forbid_always` binds every child**, naming the workflow that declared it. A child
  inherits no per-state list.
- **Develop a child on its own**, on the same contract:
  `archmax run <child> --variables '{"order_id":"ORD-1003"}'`.

## Models

- `settings.model` is the id every state runs on, and a state's `model` overrides it.
  Each is an id over the endpoint the host configured. The order is the state's, then the
  workflow's, then `ARCHMAX_MODEL`.
- Name one only where the work differs in kind: a small model for classification and
  extraction, the default for drafting, judgment, and states with many tools or
  transitions. A small model that routes badly costs more in retries than it saves.
- A grader state's model is resolved under the `grader` model role. A sub-workflow uses
  its own spec's ids. A host that passes an explicit `model` instance to `createAgent`
  outranks every declared id.

## Prompt economy

The static prompt and the tool schemas are sent on every model call, and the static part
is cached. It carries the workflow's `title` and top-level `instructions`, and no state.
A state's `instructions` and transitions are sent only while it is active.

- Put rules that hold everywhere in the top-level `instructions`, once. Put everything
  else in the state that needs it: splitting a broad state into narrow ones costs nothing
  in the prefix.
- `title` and `summary` cost nothing: no model reads them.
- `WORKFLOW.md` carries only what the spec cannot say.
- Every model call states the current date and time in UTC, rounded down to ten minutes,
  so date arithmetic needs no authored "today".

## Removed keys

Each key below is a load error that names it. The
[changelog](https://harness.archmax.ai/reference/changelog/) says what changed and when.

| Key | Write instead |
| --- | --- |
| root `name:` / `description:` | `title:` / `instructions:`, reread as direction |
| root `policy:` | `tools.forbid_always` and `skills.forbid_always` |
| root `skills.allow` (a ceiling) | `skills.allow_always` plus the state lists |
| root `budget` | Nothing: the `recursionLimit` bounds a turn |
| state `budget.maxTurns` | Nothing: the `recursionLimit` bounds a turn |
| state `before:` / `after:` (any kind, `rubric:` included), `max_iterations`, `max_corrections`, root `extensions:` | A code state in front of the state for a `before` check, a code state behind it for an `after` check, a grader state behind it for a rubric. Count send-backs on the trail. Scripts move from `hooks/` to `scripts/` and call `tools.archmax_advance` or `tools.archmax_raise`. |
| state `type: wait`, transition `on:` | `archmax_wait` in the state that needs the answer |
| state `type: trigger` | `triggers:` on the state it entered |
| state `type: workflow`, `workflow:`, `params:`, `for_each:`, `result:` | An agent state allowing `archmax_workflow_<slug>`, with `requires` |
| state `parallel:` / `join:` | Sequenced states |
| `runtime.version` `1` or `2` | `"3"`, or no `runtime` block |
| a single-file `WORKFLOW.md` with frontmatter | `workflow.yaml` plus a plain `WORKFLOW.md` |
| `tests.config.js` | The `tests:` block |

## Paths and zones

- The agent's workspace root is the session. `scratchpad/` is its working zone, writable
  in every state that is granted a file tool. `large_tool_results/` and
  `conversation_history/` are offload zones the agent only reads. `checkpoints/` and
  `artifacts/` belong to the runtime.
- Mounts are read-only unless the host serves them writable. A write into a read-only
  mount is refused (`zone.read-only`).
- `workflows/**` is served by the authoring backend: no state may read it, an allow entry
  naming it is a validate error, and a host cannot mount it.
- Write paths without a leading slash, and never author a `run/` prefix.
