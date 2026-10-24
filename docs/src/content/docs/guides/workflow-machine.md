---
title: The workflow machine
description: "How workflow.yaml defines an enforced state machine: states, transitions, tool governance, and grader and code states."
sidebar:
  order: 1
---

A workflow is a directory, `workflows/<name>/`, with one canonical file:
**`workflow.yaml`**, the declarative, *enforced* state machine, as a pure YAML
mapping. Its root keys:

| Key | What it holds |
| --- | --- |
| `title`, `instructions` | The workflow's label and its standing instructions (see [Where guidance lives](#where-guidance-lives)) |
| `disabled` | Takes the workflow out of service (see [taking a workflow out of service](#taking-a-workflow-out-of-service)) |
| `runtime` | The contract pin, `{ engine: archmax-harness, version: "3" }` |
| `settings` | Runtime knobs |
| `tests` | The suite block |
| `tools`, `skills`, `mounts` | Workflow-wide grants and denials, `tools.allow_always` among them |
| `states` | The machine itself |

Each state carries its own `type`, `tools.allow`/`tools.forbid`, `transitions`
and `triggers`. `type` says who runs the state: the session's agent (the
default), a person (`human`), a grader (`grader`) or a script (`code`). `triggers`
says which state is the start: one id, or a list of the several triggers that all
begin there.

**`WORKFLOW.md`** *(optional)* is a prose addendum with **no frontmatter**. The
runtime renders the workflow header of the system prompt deterministically from
the loaded spec, then appends this prose after it. So what the agent reads always
matches what is enforced. The graph itself is not in that header: see
[What the agent sees of the graph](#what-the-agent-sees-of-the-graph).

`WORKFLOW.md` is never a machine source. A `workflow.yaml` next to a
frontmatter'd `WORKFLOW.md` is an **error**, and a directory without a
`workflow.yaml` has no workflow to load. The full schema is documented in the
[machine spec reference](/reference/machine-spec/).

## Execution model

The workflow runs on the Deep Agent's own graph, and the machine's position is
carried as a channel of that graph's state. The agent runs in a state until it
calls `archmax_advance({ to, reason })`. That call is the one way to move between
states, and it works **once per message**. A second call alongside the first is
refused, naming the state the first one landed in.

The runtime checks the leaving state's `requires` and validates the edge against
its declared `transitions`, then unlocks the next state. A future state's tools
stay locked until that transition succeeds. When the target is a grader or a code
state, it runs at once, in place of the agent's next model call (see
[grader and code states](#grader-and-code-states)). Handing over to a human
decision state takes one more, optional argument:
`archmax_advance({ to, reason, evidence })`. See
[evidence](#evidence-declared-plus-whatever-the-session-attached).

```text
START → identify-case ⇄ orders-question | refund-request | general-question → END
               ↑______________|   (transitions taken by archmax_advance)
```

Sometimes a session takes a wrong branch and no transition from where it stands
can put it right. The agent then calls **`archmax_reset({ reason })`**. The
session returns to the state it began in (the start state its trigger selected),
with its turn budget cleared. When that state is a code state, its script runs
again before the agent's next model call.

The conversation, the files written so far, and the session's variables carry
over. What the agent locked is unlocked, values kept, so the restarted run can
decide it again; a host's lock stays. The audit trail records the move as a
`reset` step. Where a
model-initiated restart is unwanted, ban it with
`tools: { forbid_always: [archmax_reset] }`.

When a state needs something from outside to finish its work (a customer's
reply, a callback, the next chat message), the agent calls
**`archmax_wait({ reason })`**. The session suspends **in that state**. The
transition stays uncommitted, parking spends no model call, the status becomes
`awaiting_input`, and the process may exit.

The host later delivers a firing
(`agent.workflow.deliver(sessionId, { trigger, variables })`). That same state
then runs again, with the arrival in its transcript and the delivered values as
locked session variables, and it chooses its own outgoing transition. Which
conversation a firing belongs to is declared on the trigger, under the
`triggers:` of the state it enters.
See [sessions and parked sessions](/guides/sessions/).

When the session is waiting for a *time*, the call says so:
`archmax_wait({ reason, until: "1d" })`. The runtime records an absolute
`resumeAt` for whoever schedules the wake-up, and it starts no timer itself.

A state that polls can bound its own loop with `budget.maxParks`. Exhausting that
budget is a budget failure, routed by `on_error`. See [sessions and parked
sessions](/guides/sessions/#waiting-for-a-time-not-a-reply).

One turn is bounded as a whole. The workflow's
[`budget.maxModelCalls`](/reference/machine-spec/#budget-the-turn-budget)
(default 50) counts the agent's model calls of a turn across every state, so an
agent that moves back and forth between two states without answering is stopped,
which a state's own `maxTurns` cannot do, since it starts over on every entry. A
grader or code state's run is no model call of the agent's and spends none of it;
the agent's calls after an automated state's move count as any other. The
exhaustion routes through `on_error` like any budget failure, and near the end the
agent is told how many calls it has left. A turn that throws instead (a model
provider failing, the step limit, a cancelled turn) ends the session `failed`
with an exit code, so the next message starts a fresh turn rather than finding
the session stuck.

`archmax_wait` is available in every agent and human state, terminal ones
included; an automated state cannot park. A session that has answered and now
awaits a reply parks where it answered and stays open.
Ban it with `tools: { forbid_always: [archmax_wait] }` to keep sessions from
parking themselves.

A state with **no outgoing transitions is terminal**, so the session ends when
the agent finishes there. A session starts at the state whose `triggers` matched
(`manual` for the CLI). A state may name several triggers as a list, and all of
them begin there. See [triggers](/guides/triggers/).

### Ending a session as a failure

When the work **cannot be completed** (a system it depends on keeps failing,
the thing asked about does not exist), the agent calls
**`archmax_raise({ code, reason })`** to end the session as a failure. The call
has to be the only tool call in its message, and it works from any state. The
session ends at once with the status `failed`, and the host reads the agent's
`code` (a short free-form token such as `orders-unavailable`) and its `reason`
off the outcome as `exit: { success: false, code, reason }`. Nothing runs on the
way out: no `on_error` route, no further state, and no check of the trigger's
`returns`. The position stays where the agent raised, and the trail records no
step. A grader or a code state ends a session the same way, with its own
`archmax_raise` call.

A session that ends without `archmax_raise` is a success
(`exit: { success: true }`), so the tool is only for failure. The agent is told
to recover first (a retry, another tool) and never to use it in place of
`archmax_wait`, `archmax_reset` or a human state. A session that raised takes
its next message as a fresh turn in the state it raised in. Where an
agent-declared failure is unwanted, ban the tool with
`tools: { forbid_always: [archmax_raise] }`, or in one state with its
`tools.forbid`. See [sessions](/guides/sessions/#how-a-session-ended).

### What the agent sees of the graph

The graph is disclosed the way the tool surface is: from where the agent stands.
On every model call it is shown the active state's outgoing edges. Any other
state's slug, title, `summary`, `instructions` and transitions stay out of the
prompt, and so does the count of states:

```
Transitions — choose one with `archmax_advance` when this state's work is done:
- to `refund-review` (human decision node) — The refund is over $50, or the customer has asked twice.
- to `review-reply` (grader) — The reply answering the question has been sent to the customer.
- to `orders-question` — The customer is asking about order status, shipping or tracking.
```

Two consequences for authoring:

- **A transition's `description` is what the agent routes on.** Write it for a
  reader standing in the *source* state, which has no view of the target. Say
  *when* to take the edge: "The refund is over $50" routes, where "go to
  refund-review" leaves the agent guessing.
- **An undescribed edge routes on the target's instructions.** Leave
  `description` out (or empty), and the edge's line carries the target state's
  `instructions` instead, quoted and framed as what the agent will do once there.
  The target's `title` and `summary` stay invisible. The schema refuses an
  undescribed edge whose target has no instructions, an undescribed edge into a
  grader or code state (a grader's instructions are its criteria, and a code
  state has none), and an undescribed transition of a human state, where the
  description is the button label. A code state's own edges may go undescribed:
  its script routes on them.
- **Routing logic belongs upstream.** Put a condition the target's instructions
  do not state on the edge, as its description.

An edge's line marks a target that is a human decision node, a grader, a code
state or terminal. Each marker changes the call or what follows it: `evidence`
may be attached only when advancing into a human state; a grader or a code state
runs on its own and may send the work straight back with a note saying what to
change; and a human or terminal target means the agent stops there. Nothing else
about the target is rendered, so a grader's criteria and a code state's script
stay out of the prompt.

This keeps the cached prefix from growing with the graph (see
[Token efficiency and cost](/guides/token-efficiency/)). It also
closes a disclosure hole: a state the agent cannot advance to is a state it
cannot name, so a prompt injection has no map of the workflow to steer with.

Every host-side surface still sees the whole graph. `archmax validate`, the CLI's
state flow, the trail, events and the decision record all name states.

A state's key in `states` is its **slug**: the state's identity, and the one
token `archmax_advance({ to })`, `on_error`, trigger ids, events and test
assertions resolve by.

An optional per-state `title` carries the human-readable label. It appears in a
human state's decision record and in host surfaces, stays out of every model
call, and routes nothing, so it is safe to reword. Details and the slug shape
are in the
[machine spec reference](/reference/machine-spec/#slugs-and-titles).

Workflow state is checkpointed per session (the LangGraph `thread_id`):

| Field | Purpose |
|---|---|
| `messages` | Conversation history |
| `workflowState` | Current YAML state |
| `stateTurns` | Model calls made in the current state, against `budget.maxTurns` |
| `turnCalls` | Model calls made in the current invocation across every state, against the workflow's `budget.maxModelCalls` |
| `pendingDecision` / `pendingInput` | The park record a suspended session presents |
| `auditTrail` | The trail: every move, decision, reset and delegation |
| `variables` | The session's variables |

## Tool governance

Governance is **closed by default**: a grant has to be declared, and a denial
beats every grant. Three things are present in every state:

- **The workflow-wide grant.** This is what the root's `tools.allow_always`
  lists. A workflow that does not declare the key gets the **default tools**
  instead: `ls`, `read_file`, `write_file`, `edit_file`, `copy_file`,
  `move_file`, `remove_file`, `glob`, `grep`, `write_todos`, `archmax_eval` and
  `archmax_run`. A declared list **replaces** the default tools rather than
  adding to them, so it names each one the workflow wants. A new workflow lists
  all twelve and removes only what it must not have.
- **The runtime's own `archmax_*` controls**: `archmax_advance` in non-terminal
  states, `archmax_raise` and the variable tools everywhere, and `archmax_reset`
  and `archmax_wait` in agent and human states.
- **Any tool the host passes as `essentialTools`**, whatever the workflow
  declares.

A grader or a code state gets the same surface minus `write_todos`,
`archmax_eval`, `archmax_run`, `archmax_wait` and `archmax_reset`, and a grader
adds `archmax_get_history`. See
[what each state is offered](/guides/automated-states/#what-each-state-is-offered).

Every other tool has to be declared. A state with no `tools` block gets exactly
that surface, and no declaration opens a state fully. A state's `tools.allow`
list **grants** additional tools, a default tool that a declared list leaves out
among them, and it **narrows** a tool the workflow-wide grant includes when an
entry names one.

Denial is declared beside the grant, in the same two positions and with the same
entries. `tools.forbid_always` at the root denies in every state. `tools.forbid`
on a state denies while it is active, subtracting from the workflow-wide grant,
the state's own `allow`, and the host's `essentialTools` alike.

One rule covers both: **deny beats allow, and no narrower level widens a
denial.** A forbid entry may name the tool `*`, meaning every tool, which is how
a path is denied across the board. `*` in an `allow` list is a load error. See
[`tools.forbid_always` /
`tools.forbid`](/reference/machine-spec/#toolsforbid_always--toolsforbid-denial).

Entries constrain a tool by its **actual parameter names** using globs:

```yaml
states:
  general-question:
    tools:
      allow:
        - { tool: write_file, args: { file_path: ["reports/answer.json"] } }
        # write_file is granted workflow-wide (usable everywhere), but this
        # state narrows it to reports/answer.json; the other granted tools stay
        # unconstrained. Note the path is NOT under scratchpad/: that area stays
        # open to write_file wherever it is granted, so an entry naming a path
        # inside it would narrow nothing there (validate warns). Govern a result by naming an
        # ordinary session path, as here.
```

`{ tool, paths: [...] }` guards every path argument the tool declares, and a
bare string matches the tool with any arguments. `archmax_advance` is always
permitted.

### File operations and path arguments

`copy_file`, `move_file` and `remove_file` work on one file at a time, text or
binary, without its content entering the conversation:

- `copy_file({ source, destination, overwrite? })` writes the source's bytes at
  the destination, creating its folders. A file already there is refused unless
  `overwrite: true`, and a source and destination naming the same file are
  refused.
- `move_file({ source, destination, overwrite? })` writes the destination before
  removing the source, so a failure leaves a copy rather than a loss.
- `remove_file({ file_path })` deletes one file.

Every path rule reads each tool's **declared path arguments** and how the call
uses each: `copy_file` reads `source` and writes `destination`, `move_file`
removes `source`, `remove_file` removes `file_path`. A removal is refused wherever
a write is, so a move out of a read-only mount is refused before anything is
written. A call naming several paths is refused when any one is, and the refusal
names the argument. A `paths:` grant must match every declared path, and a
`paths:` denial matches when any does: `forbid: [{ tool: "*", paths: [secrets/**] }]`
refuses a copy out of `secrets/` and a copy into it. Host tools declare their
paths too, and are governed by the same rules (see
[`toolPaths`](/reference/public-api/#tools-toolpaths-host-tools-on-the-governed-workspace)).
A host tool's argument may hold a list of paths, each governed like one, and a
`paths:` guard tests every element.

The scratchpad is open in every state to each default file tool the state is
granted, whatever the granting entry narrows, and to a host's `essentialTools`.
A file tool the state is not granted gets nothing from it. Neither does a host
tool the state must grant: declaring its paths narrows what it may do where it
is granted, and it stays refused where it is not.

`allow_always` entries are ordinary **grants**, guards included, so an entry
constraining a default tool (`{ tool: write_file, paths: [reports/**] }`) binds
in every state that does not name the tool itself. A per-state entry for the
same tool takes precedence, as in the example above. `archmax validate` warns
when a declared `allow_always` grants none of the default tools and no state
names one either. The tool descriptions the agent sees are derived from exactly
what is enforced.

The model **sees** exactly that surface. Each model call presents the
workflow-wide grant, the host's `essentialTools`, the state's own entries, and
`archmax_advance` outside terminal states, minus every tool denied there by name.

Disclosure follows the state machine deterministically, and enforcement sits
underneath it: a call to an undisclosed tool is still blocked by the kernel. A
script's `tools.*` bridge offers exactly the same surface, so a tool the state
does not offer is `undefined` there, and every call it makes is governed by the
active state exactly as the model's own calls are. A code state's script and a
grader are held to their own state's surface in the same way. No caller reaches
past a state's surface; the one read made on runtime authority is the runtime's
own check that a `file` value names a file the session may read.

A blocked call is answered with an error-status tool message giving the reason,
so the agent reads the refusal and carries on. A permitted call whose tool
**throws** is answered the same way, with the error's message: a dropped
connection or a failing API reaches the model as that call's answer, and the
session stays in the state. The agent can retry, switch tools or say what it
could not do, and answers to the other calls of the same step are kept. A tool
failure is not a turn failure, so [`on_error`](/reference/machine-spec/#on_error)
does not route it. A script's `tools.*` call is the exception: the error is
thrown to the script, which may catch it.

## Skill governance

The same shape, one level up: which **capabilities** a state may use is declared
by skill slug.

```yaml
skills:
  allow_always: [order-data]             # enabled in every state, named once

states:
  orders-question: {}                    # no block, and it still has order-data
  refund-review:
    skills:
      allow: [refund-policy]             # this state adds one, and has both
  route:
    skills:
      forbid: [order-data]               # opts out of the workflow's grant
```

The composition is the tools one, one level up. The root's `allow_always` is
enabled in every state, and a state's `allow` **adds** to it, so the enabled set
is the union of the two. A skill is enabled where a list names it, which makes an
absent state block behave exactly as `allow: []` does.

Denial sits in the same two positions and beats every grant. `skills.forbid` on a
state removes a slug there, the workflow's grant included. `skills.forbid_always`
at the root puts a bundle out of reach everywhere.

Enabling a slug **grants** reads of `skills/<slug>/**` and execution of its
scripts, with no `tools.allow` entry needed. A bundle no list enables is refused
by the non-overridable `skill.not-allowed` rule, which runs ahead of consumer
rules and of the state's own allow list. It also stays out of that state's prompt
and out of an `ls skills/` there.

Both mechanisms apply (*enabled AND allowed*), so a `tools.allow` entry still
narrows within the enabled set.

The [Skills guide](/guides/skills/) goes further. It covers why
capability governance belongs in a skills list, and why a code state that checks
against a bundle's data enables that bundle itself. It also covers why a state
that enables no skill can run no script, since `archmax_run` is confined to
bundles.

## Mount governance

The same shape again, for the folders the *host* routes into the workspace. A
mount the host declares `governed: true` is reachable from the states a `mounts`
list enables. An ungoverned mount is visible in every state until a `forbid`
takes it away, and every mount of a zero-config workspace is ungoverned.

```yaml
mounts:
  allow_always: [reference]                        # reachable in every state
  forbid_always: [catalogs/uk]                     # nowhere, child sessions included

states:
  intake: {}                                       # no block, and it still has reference/
  triage:
    mounts:
      allow: [catalogs/eu]                         # this state adds one, and has both
  review:
    mounts:
      allow: [{ mount: shared, access: read }]     # reads a writable mount, cannot write it
  route:
    mounts:
      forbid: [reference]                          # opts out of the workflow's grant
```

Entries are **mount names**, which are the host's table keys with their slashes
stripped. Globs are refused there. Composition and denial are the skills ones
exactly.

What is new is the second half of a grant. `access: read | read_write` says what
a state may *do* there, and the host's `readOnly` is a ceiling the spec cannot
lift. So `read_write` opens nothing the wiring serves read-only, and
`access: read` is a restriction that no narrower level widens back.

A bare name asks for no write. A governed mount is written only where some grant
of the same workflow says `access: read_write`, in `allow_always` or in any state's
`allow`, so a bare grant in one state and a `read_write` grant in another both
write. A grant of another workflow never counts. One mount table serves a session
and every child it dispatches, so the host serves a route writable when any
workflow in that tree writes it, and each workflow still writes only what its own
grants ask for.

A governed mount the state does not have is refused, and also **unseen**. The
refusal is `mount.not-allowed`, `mount.forbidden`, or `mount.read-only` for a
write into one a grant narrowed or no grant of the workflow asks to write. Unseen means `ls`, `glob` and `grep` results
lose every entry under it, the workspace root listing included.

A grader and a code state's script answer to their **own** state's grants, as
the agent does there. The runtime's own check of a `file` value is the exception:
it answers to the **workflow's** grants, reading a governed mount any state of its
workflow grants. A mount no grant of the workflow names, such as one only a child
grants, is refused to it like any other.

The prompt names the mounts of *this* state, in the volatile block, so the
cacheable prefix stays identical across states. Full reference:
[`mounts.allow_always` /
`mounts.allow`](/reference/machine-spec/#mountsallow_always--mountsallow-which-states-reach-a-mount).

The agent's workspace root **is the session**. Every session path resolves into
the executing session's own folder in the session store (`sessions/<sessionId>/…`
on the filesystem default). So concurrent sessions never collide, and no session
id appears in a path the agent sees.

The session has one named working area, `scratchpad/`, for intermediate files
and the artifacts a state produces alike. It is readable and writable in
**every** state, independent of `tools.allow`, which is the point of it. The
trade is that an allow entry naming a path inside it cannot narrow where within
the area a write lands. Any *other* session path is matched against the state's
`tools.allow` like any other argument, which is how you govern where a result
lands.

What the agent may do in each session area:

| Area | Agent access |
| --- | --- |
| `scratchpad/` | Read and write in every state, with the file tools that state is granted |
| `large_tool_results/`, `conversation_history/` | Read |
| `checkpoints/`, `artifacts/` | None |

Authored content is mounted read-only as backend routes the wiring code composes:
`skills/` and `AGENTS.md` from the conventional default, plus any mount you add.
The workspace serves exactly what that table lists.

Reads are **text only**, wherever the file lives. `read_file`, and a script's
`tools.readFile`, never return a binary file's content. That covers an image,
audio, video, PDF or PowerPoint file, by its extension or by the type the backend
reports, and any file whose content holds a NUL byte: an archive, an Office
document, a database. XML and JSON are text whatever the backend calls them, so a
file it reports as `application/xml` or as any `+xml` or `+json` type, such as
the `word/document.xml` of an Office document unpacked into the scratchpad, is
read as text. A binary read is answered with a notice instead:

```text
Error: 'scratchpad/chart.png' is a binary file (image/png, 24.1 KB) and was not read; read_file returns text files only.
```

The notice is the workspace's answer, not a governance refusal: no rule fires, no
`on_error` route is taken, and the agent carries on. The `read_file` description
the model is handed says so. A route's own error, such as a missing file, comes
back as before, and the runtime's own reads of specs, code-state scripts and
skills are unaffected.

A host whose model has vision turns on
[`images`](/reference/public-api/#images-showing-the-model-the-images-it-reads).
The model's own `read_file` of a PNG, JPEG, GIF or WebP then answers
`Image '<path>' (<type>, <size>) is shown below.`, and the image reaches the
model in a `user` message right after that batch of tool results, read from the
workspace for each request. The bytes stay out of the history, the checkpoints,
the events and scripts. Every other binary file, and a script's `tools.readFile`
of an image, still gets the notice.

The system prompt's account of all this is **rendered from the resolved mount
table**, so it names exactly the directories the workspace serves. A mount the
host governs is named only where the state actually has it (see
[Mount governance](#mount-governance) above).

`workflows/` is deliberately absent from that list, and cannot be added. The
machine spec (a grader state's criteria included), its code-state scripts and its
test cases are read by the runtime through a separate authoring backend, and they
have no route in the agent's workspace.

So a session cannot read the workflow that governs it, or the criteria a grader
holds its work to. See [The authoring plane](/guides/authoring-plane/).

## Session variables

A guard like `paths: ["reports/**"]` is fixed at authoring time. Session
variables let governance bind to what *this session* established. They are a
flat, checkpointed key/value store: the host seeds it, the agent writes it, and
the kernel reads it when resolving a `${{name}}` reference in a tool argument
guard.

There is **no declaration block**. A variable exists once something sets it:

```ts
// the host, at assembly — every seed is locked
await createAgent({
  workflow: "support",
  variables: { from_email: "a@b.com", account: { region: "eu" } },
});
```

```yaml
# the agent, mid-session
archmax_set_variables({ variables: { case_id: "K-9" }, lock: true })
```

Values may be scalars, objects, or arrays. A reference addresses exactly one
value by dotted path. Arrays are indexed by position, and a negative index counts
from the end:

```yaml
states:
  triage:
    requires: [case_id]        # cannot leave until the agent records it
    tools:
      allow:
        - tool: gmail__send
          args: { to: ["${{from_email}}"] }              # a host-seeded fact
        - tool: crm__lookup
          args: { region: ["${{account.region}}"] }      # a path into a value
        - tool: write_file
          paths: ["reports/${{case_id}}/**"]              # inside a larger glob
```

A value belongs to the **session**. What one state records is readable by every
state after it, and by every later turn of the conversation, without the host
re-supplying it. That is what lets a guard in a downstream state bind to a fact
an upstream state established.

Four rules make this safe to rely on:

- **Substituted values are matched literally.** A variable holding `*` matches
  the literal `*`, so a value can never widen the guard it lands in.
- **An unresolvable reference fails the session.** An unset name, a path that
  does not resolve, or a non-scalar result ends the turn. The reason names the
  reference, and `on_error` routes it when declared. The guard never degrades to
  a wildcard, and the agent gets no retry, because the runtime could not evaluate
  the guard at all.
- **Locking is monotonic.** A locked variable refuses every later write, loudly,
  and host seeds are locked automatically. Lock anything else a guard depends
  on: that is what settles the fact. The one release is `archmax_reset`, which
  unlocks what the agent locked (never a host's lock), keeping the values. A seed of one of the trigger's
  [returns](/guides/triggers/#a-return-is-owed-when-the-session-finishes) is
  the exception: it lands unlocked, so a guard should not rest on one until the
  agent locks it. Without a lock, any later state can
  overwrite it, and the later value simply wins, since execution is sequential
  and a rewrite is one writer twice.
- **Paths read data.** Traversal is own-properties-only, so `${{tags.length}}`
  and `${{v.constructor}}` do not resolve.

`requires` is how you make a reference *guaranteed*. With neither a `requires`
nor a seed, assembly warns that the guard rests on the agent having called
`archmax_set_variables` first. The turn then fails at the guarded call when it
has not.

A lock makes a value final. When a value has to stay correctable but must be
decided in one place (an order the person may still change their mind about),
let a state **own** it with
[`locks: [order_id]`](/reference/machine-spec/#locks). Only that state may write
it, so changing it means going back there: the value is decided again under that
state's rules, and every later guard checks the new value on the way forward.
`requires: [order_id]` beside it makes the owner set it before the session moves
on.

The agent reads the store with `archmax_get_variables({ name?, path? })` and
writes it with `archmax_set_variables({ variables, lock? })`. Both are runtime
controls, always permitted and always disclosed, like `archmax_advance` and the
other `archmax_*` controls. So a host's seeds are readable even by a workflow
whose spec references no variable.

A code state's script reads them as its `variables` input and writes them only
through `tools.archmax_set_variables`, held to the same locks and rules as the
agent's writes. An `archmax_eval` or `archmax_run` script reads them from
`args.variables` and has no write path at all.

### Two reserved names

Two variable names mean something to the runtime. They are opposites, and the
contrast is worth holding onto:

| | `trigger` | `title` |
|---|---|---|
| Who sets it | the runtime, at every arrival | the **agent**, prompted (a sub-workflow child is not) |
| Locked | always | **never**, by any route |
| Guaranteed set | yes, from the first turn | no; absent until written |
| In a trigger's `requires` | accepted | accepted (seeded unlocked) |
| In a trigger's `returns` | refused | refused |

**`trigger`** holds the id that started the current turn. See
[Triggers](/guides/triggers/).

**`title`** is a short one-line label naming the task the session is doing. The
agent is the one party that knows what a session is about, so it writes the
title itself. The platform system prompt asks it to set one as its first
activity. After that, the agent renames the session only when the conversation as
a whole has moved to a subject the old title no longer describes. It judges this
against the whole conversation, not the latest message, so a follow-up, a
correction or a side question on the same subject keeps the title.

A [sub-workflow's child session](/guides/sub-workflows/#what-the-childs-model-reads)
is not asked. Its title would describe a session nothing lists, and it is never
returned to the caller, so the child's prompt leaves the step out and the child
goes straight to its work.

A host reads the title back off the session like any other variable. That is what
puts a session's name in a listing alongside its session id and state slug.

Because it has to stay correctable for the whole session, `title` is never
locked, and the refusals are loud:

```yaml
archmax_set_variables({ variables: { title: "Refund for order A-1042" } })   # ok
archmax_set_variables({ variables: { title: "Refund" }, lock: true })        # refused
archmax_set_variables({ variables: { title: { text: "Refund" } } })          # refused
```

A write must be a non-empty **single-line string** of at most 200 characters, and
it is stored trimmed. Anything else refuses the whole call, atomically, like
every other `set_variables` rejection. The reason is one the agent can act on,
because a title is presentation metadata and a mangled one is worse than none.

A host may seed one at assembly (`variables: { title: "Inbound refund request" }`).
It lands **unlocked**, an exception to "every seed is locked". The other is a
seed of one of the trigger's `returns`.

The seed is an *opening* label the agent may refine, and it leaves a title an
earlier turn already established in place. A delivery carrying a `title` replaces
the stored one, because it is an explicit act at that moment.

A host learns the title from the **`title-set` event**, which carries the value
whenever it changes. It is the one event that carries a variable's value at all,
and the way to index a session's title without reading the checkpoint. See
[`title-set`](/reference/public-api/#title-set-the-one-event-carrying-a-variables-value).

:::caution[Three different `title`s]
The spec root and each state also take a `title:`. Those are static human labels
for the *workflow* and the *state*, rendered beside the slug in the prompt. The
session variable named `title` is a different thing entirely. It names the
**session**, and it lives in checkpointed session state.
:::

Because the runtime never guarantees `title` is set, a guard binding to
`${{title}}` still draws the assembly-time warning below, correctly. It rests on
the agent having written one.

### Referencing a variable in a tool argument

`${{…}}` is an agent-facing syntax as well as an authoring one. Anywhere a tool
argument is text, the agent may write a reference and the runtime substitutes
it. A reference may sit **inside** a longer string, and repeat:

```
send_reply({
  to: "${{from_email}}",
  body: "Thanks — your refund is on its way.

--- Original message ---

${{inbound.text}}"
})
```

The quoted text stays out of the agent's context, which is the point. A reference
is **exact**, where a copy the model retypes can truncate, paraphrase, or drift.
The transcript keeps the reference, so the value's tokens stay out of every later
model call. The resolved arguments reach the tool and the `tool-called` event the
[state flow](/guides/cli/) renders, and stop there.

Substitution is the **first** stage of the call boundary (ahead of path
canonicalization and every governance rule), so:

- **A guard and an argument naming the same variable agree by construction.**
  `args: { to: ["${{from_email}}"] }` and an argument of `"${{from_email}}"`
  resolve independently to the same string.
- **What is checked is what the tool receives.** One resolved structure
  serves the verdict, the event stream, and the tool.
- **A resolved value stays data.** A variable holding `*` cannot widen the guard
  it is matched against. A value containing `..` is canonicalized like any other
  path, so interpolation cannot dodge a zone rule.

Substitution walks nested arguments (objects and arrays), leaving non-string
values untouched.

An unresolvable reference here is **recoverable**, where an unresolvable *guard*
is terminal. The call is refused before it runs, naming the reference and why,
and the agent retries. A broken guard is an authoring defect the agent cannot
fix. A broken reference is one the agent wrote itself.

To write the characters literally (authoring a `workflow.yaml` guard through
`write_file`, or explaining the syntax), double the dollar: `$${{name}}`.

**Authoring consequence.** When a state's job is to emit a large stored value, its
`instructions` should name the variable to interpolate: "quote the customer's
message with `${{inbound.text}}`". Asking for a copy invites a transcription
error.

Scripts are the exception. An `archmax_run` or code-state script already holds
the values in its variables and composes strings in JavaScript. So `${{…}}` in a
script's `tools.*` call is ordinary text.

## Grader and code states

Checking the agent's work is a state on the graph, not a slot inside one. Two
state types are run by the **runtime** itself (together, the **automated
states**):

- A **grader state** (`type: grader`) runs a grader, an isolated subagent whose
  criteria are the state's `instructions`. It reads the session with
  `archmax_get_history` and decides with `archmax_advance`: onward when the work
  passes, back to the state that produced it, with what to change, when it does
  not.
- A **code state** (`type: code`) runs the JavaScript file its `script` names,
  `workflows/<slug>/scripts/<file>.js`, in the QuickJS sandbox. The script moves
  the session itself with `tools.archmax_advance({ to, reason })`.

```yaml
states:
  screen-request:                                     # runs on entry, before any model call
    type: code
    script: scripts/screen-request.js
    triggers:
      manual:
    transitions:
      - { to: orders-question, description: The requester is known. }
      - { to: decline, description: The request names no known requester. }
  orders-question:
    transitions:
      - { to: review-reply, description: The reply has been sent to the customer. }
  review-reply:                                       # grades the reply, approves or sends it back
    type: grader
    instructions: |-
      Judge the tone of the last reply. Friendly: advance to answered. Curt:
      advance back to orders-question saying what to change. Already sent back
      twice (count the trail): raise reply-tone.
    transitions:
      - { to: answered, description: The reply is friendly and professional. }
      - { to: orders-question, description: The tone is off; send it back. }
  answered:                                           # terminal: completes with no model call
    type: code
    script: scripts/answered.js
  decline:
    instructions: Tell the person why the request was declined; the note above says why.
```

An automated state runs whenever the session reaches it, in place of the agent's
next model call, so the agent's model is never called there. Consecutive code
states run one after the other with no model call at all. Each is offered exactly
its own state's tools, never `write_todos`, `archmax_eval`, `archmax_run`,
`archmax_wait` or `archmax_reset`, and every call is governed against that state.
No automated state can park.

Each run settles one way. It **advances**, and the next state reads why from a
`grader` or `code` runtime note. It **raises**, which ends the session `failed`.
A terminal code state **completes** the session, held to the trigger's
[`returns`](/guides/triggers/#a-return-is-owed-when-the-session-finishes). Or it
**fails**: a thrown error, a timeout, a spent budget, or a non-terminal state that
finished without deciding. A failure routes through the state's `on_error`, else
the session ends rejected, so an automated state never approves by saying
nothing.

There is no retry budget. A grader that gives up after N send-backs says so in
its `instructions` and counts the rounds from the history's trail.

Argument-shape restrictions belong in `tools.allow`, or in a `forbid` entry's own
guards. *Semantic* validation of what a state produced belongs in a code state
behind it, which reads what was actually written and advances onward or back.
The script input, the grader's prompt and model, the events and the patterns are
in [grader and code states](/guides/automated-states/).

### What an automated state reads: the session and its records

An automated state reads the **whole session**: every message of the transcript
and every step of the trail, earlier turns included, taken from the checkpointed
session rather than from the request a summary shortened for the model. A code
state receives them as `messages` and `trail`, and a grader reads them with
`archmax_get_history`.

Beside the transcript, it reads the session's **records**: `variables`, the files,
and the session's tool calls with their results, which a code state queries with
`toolCalls(filter?)` and a grader finds in its history. The runtime keeps those
results as the tools returned them, each marked with the state and the **visit**
that made the call.

A visit is the span of a session from its entry into a state until it next enters
one. An advance (an automated state's included), a person's decision, an
`on_error` route and `archmax_reset` each start one, and so does a turn that opens
a state (the session's first turn). A turn that continues in the state the
session is in continues its visit, and so do a delivery after `archmax_wait` and a
sub-workflow's return. So a visit can span turns, and a state entered again starts
a new one. Visits are numbered from 1 across the session.

```text
 … | entered S (visit 3) ───────────────────────── advance → check (visit 4)
     │ user "cancel 42"                             │ check's script reads
     │ get_order(42) → pending                      │ toolCalls({ state: "S" })
     │ (the turn ends; the person answers)          │ and finds both calls,
     │ user "yes, do it"                            │ each with visit: 3
     │ cancel_order(42) → ok                        │
     └──────────────────────────────────────────────┘
```

So the rule for authoring is:

- **The conversation is the model's memory, not evidence.** A check reads the
  records, never what an earlier state said about them.
- **What a later state or turn depends on is stored**: in a variable, in a file,
  or in a tool result the runtime already keeps. A check compares against the
  result itself, not a copy the model made.

The fields are listed under
[the script contract](/guides/automated-states/#the-script-contract) and
[the history](/guides/automated-states/#the-history).

## Human-in-the-loop states

A state with `type: human` parks the session with a checkpointed pending-decision
record. The record is built from its title, its evidence file paths, and its
transitions with their `type`s (approve/reject/refine/none). A **human** picks
the outgoing edge, and the checkpoint is the sole record.

The CLI presents the instructions/approvers/evidence/transitions on demand,
computed from the workflow spec each time it's asked:

```yaml
refund-review:
  type: human
  evidence: [scratchpad/refund.json]      # referenced by path, not inlined
  instructions: Confirm the recorded refund decision matches the order status.
  transitions:
    - { to: refund-closed,  type: approve, description: "Approve: the decision is correct." }
    - { to: refund-request, type: refine,  description: "Send back: the decision needs changes." }
```

When a person decides, the session is routed. The target state is told so by a
`[decision]` [runtime note](/guides/sessions/#delivering-the-event),
naming the edge taken, any comment, and the state the session is now in. A
decision into a grader or code state runs it in that turn, before any model call
of the agent.

It arrives as a note on purpose. A model reads authorship from a message's
channel, so a routing event dressed as a person's request would be answered in
place, routed onward, or waited on. As a note, it reads as the cue to do the
target state's work.

### Evidence: declared, plus whatever the session attached

`evidence:` is what the *author* guarantees every reviewer sees. What a given
session produced is only known while it runs. So the agent handing the decision
over can attach paths of its own, with `archmax_advance`'s optional `evidence`
argument:

```jsonc
// the agent's tool call, in the state that advances into `refund-review`
{ "to": "refund-review",
  "reason": "refund recorded; the carrier confirms the delay",
  "evidence": ["scratchpad/carrier-report.md"] }
```

The pending decision presents the declared paths first and the attached ones
after, de-duplicated. Reading the spec therefore still tells you the minimum a
reviewer gets, and the session adds to it. The attachment belongs to that one
decision. It is cleared when the session parks, so a later decision presents what
*its* transition attached.

Attachments are checked before the transition is attempted, and a bad one refuses
the call: the session stays where it is, and the agent can call again.

A path must be one the agent can read: `scratchpad/…`, another session path, or a
read-only authored mount like `skills/order-data/assets/orders.json`. Paths
outside the workspace or in runtime-internal areas are refused, and so is
attaching evidence to anything other than a `type: human` target, where nothing
would present it. At most 20 paths per call.

Resume a parked session from the CLI:

```bash
archmax sessions                                   # parked ones show awaiting=<state> plus full context
archmax decide <session> --to refund-closed --comment "Matches policy."
```

### A parked session can still talk

The conversation with whoever the session is talking to stays open while a
reviewer holds the decision. **A parked session may speak, never act:**

- **On the handoff.** Advancing into a human state earns one *reply-only* turn:
  one model call whose only product is text. So the park carries a message
  saying what was done and that a person now has it. That turn runs whether or
  not the state already said something, because anything the agent wrote before
  the transition committed was about its own work. The handoff itself still
  needs saying.
- **While parked.** A message delivered to the parked session gets the same kind
  of turn. The session parks again on the *same* record: same state, same `seq`,
  same park timestamp, same audit trail. The reported human wait is still
  measured from the original park, however long the conversation runs.

```bash
archmax reply <session> "Any news on my refund?"   # answered; the decision stays pending
```

```ts
const { reply, state } = await agent.workflow.reply(sessionId, "Any news on my refund?");
```

Nothing said in either direction routes the session. The reply turn is handed
the parked state's tool list, like any other model call in that state, because
its transcript holds tool calls and some providers refuse tool history sent
without tool definitions. It is disclosed no transitions, and the kernel refuses
every tool call made during it. That is rule `tool.reply-only`, evaluated ahead
of `tools.allow`, `allow_always`, the `archmax_*` controls and the scratchpad. A
model that calls a tool instead of writing its message gets the refusal, and the
session parks without a second model call.

So a customer writing "just approve it" gets an answer, and the reviewer still
owns the edge. `archmax_wait` parks work the same way, except that the handoff
turn runs only when the turn was silent. There the agent's own question is
already the message.

## Sub-workflows

A state may **call** another workflow in the workspace by naming it in
`tools.allow`:

```yaml
enrich:
  tools:
    allow:
      - archmax_workflow_enrich-account
  requires:
    - enrichment
  transitions:
    - to: report
      description: The account has been enriched.
```

The tool's parameters are the target's declared `requires:`, and its result
carries the target's `returns:`. One call runs one child session, so an agent
fans out with parallel calls and a script with `Promise.all`. See
[sub-workflows](/guides/sub-workflows/).

## Taking a workflow out of service

`disabled: true` at the spec root means **this workflow starts no new turns**:

```yaml
disabled: true
states:
  # …unchanged; the machine is still fully authored and still validates
```

It bounds *starting*, and that boundary decides what disabling is good for:

- **Nothing new begins.** `archmax run` refuses and exits non-zero. A host
  `invoke`, a trigger firing on a fresh session, and even a follow-up message to
  a settled session are all rejected. That rejection happens at the turn
  boundary, before any state runs or any model is called. It reads
  `Refusing to start: workflow '<slug>' is disabled.` A caller's
  `archmax_workflow_<slug>` call is refused as a blocked call.
- **What is underway still finishes.** `archmax decide`, `archmax reply` and
  `archmax deliver` all resume an unfinished turn, so a session parked at a human
  state can still be approved. Disabling a refund workflow does not trap the
  refunds waiting for a person.
- **Authoring keeps working.** `archmax validate` runs in full and adds a warning
  that the workflow is disabled. `archmax test` **skips** the suite and exits
  **0**, so a disabled workflow keeps CI green.
- **Callers stay up.** A state may keep allowing a disabled target. The tool is
  still bound, so disabling one leaf leaves its callers running. `validate`
  warns on each state that allows one.

The flag is read **fail-closed**. Anything but an absent key, `null`, or boolean
`false` disables the workflow, so a typo stops sessions. `validate` reports a
non-boolean value as an error.

Stopping work *already* in flight takes a second step. Disable the workflow and
leave its sessions unresumed, or forbid the capability with
[`tools.forbid_always`](/reference/machine-spec/#toolsforbid_always--toolsforbid-denial).

## Which model a state runs on

A workflow may run each state on its own model. `settings.model` names the id for
the whole workflow, and a state's `model` names its own. Both override
`ARCHMAX_MODEL`:

```yaml
settings:
  model: gpt-5-mini             # the mechanical states are the majority

states:
  classify:                     # gpt-5-mini
    triggers: { manual: }
    transitions: [{ to: draft-reply, description: The request is classified. }]
  draft-reply:
    model: claude-opus-5        # the one state whose output a person reads
    transitions: [{ to: done, description: The reply is written. }]
```

Reach for it where the work genuinely differs in kind. Classification,
extraction, field lookup and other mechanical states are cheap to run on a small
model. Running the whole workflow on the model the *hardest* state needs is what
makes a workflow expensive.

Leave drafting, judgement, and any state with a large tool surface or several
outgoing transitions on the capable default. A small model that routes badly
costs more in retries and wrong turns than it saves per token.

It is one knob: a model **id**, resolved over the endpoint you already
configured. Sampling stays environment configuration. A grader state's `model`
is the id its grader runs on, resolved under the `grader` model role, and a
sub-workflow runs on what its own spec declares.

`archmax validate` warns when a state repeats the workflow's id, since the state
already runs on that id. See
[`model`](/reference/machine-spec/#model) for the full precedence
chain and how it interacts with prompt caching and per-model pricing.

## Where guidance lives

Guidance has three scopes, and each has exactly one home. Authoring it in the
wrong one is how instructions get duplicated (and then drift):

| Scope | Home | Sent to the model |
| --- | --- | --- |
| Every workflow in the workspace | `AGENTS.md` | Always |
| One whole session | the workflow's top-level `instructions` | Always, in the static prompt prefix |
| One state | that state's `instructions` | Only while that state is active |

```yaml
title: Order lookup
instructions: |-              # literal block: blank lines must survive as paragraphs
  Order records live in skills/order-data/assets/orders.json; write every artifact under scratchpad/.

  Tenancy is absolute: only ever disclose or act on the requester's own
  company's orders, never another company's.

states:
  orders-question:
    instructions: >-
      Find the orders matching the request by customer name, order id, or
      status, then answer with every matching order id and its fields.
```

The tenancy rule holds in every state, so it is authored once at the top. How to
match and shape *this* answer holds only here, so it stays on the state.

If you find yourself pasting the same paragraph into a third state, it belongs in
the workflow's `instructions`. If you find yourself pasting it into a second
workflow, it belongs in `AGENTS.md`.

`archmax validate` warns when a workflow declares no `instructions` at all. There
is no top-level `description:` key, so direction goes in `instructions:`.

## Authoring source of truth

Keep each concern in its layer:

| Layer | File | Role |
| --- | --- | --- |
| Enforcement | `workflow.yaml` | Authoritative: states and their types, allowed tools, transitions |
| Standing direction | Top-level `instructions` | Workflow-wide conventions and house rules, in the static prompt |
| Overview | `WORKFLOW.md` (optional) | Prose addendum appended after the rendered graph; not enforced |
| State behavior | State `instructions` (+ optional skill) | Per-state guidance surfaced to the agent |
| Persona | `AGENTS.md` | Who the agent is |
| Platform | Ships in the package (a workspace may override it with `.platform/system/GRAPH_STATE.md`) | Runtime-generic execution model |

Put workflow-specific routing, domain policy, and artifact rules in
`workflow.yaml` and [skills](/guides/skills/). The platform prompt
is for the runtime-generic execution model. An override keeps the bundled
prompt's `<!-- top-level-only -->` markers around what a sub-workflow's child
should not read; see
[what the child's model reads](/guides/sub-workflows/#what-the-childs-model-reads).
