---
title: The workflow machine
description: "How workflow.yaml defines an enforced state machine: states, transitions, tool governance, and lifecycle hooks."
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
| `runtime` | The contract pin, `{ engine: archmax-harness, version: "2" }`; `"1"` is still accepted |
| `settings` | Runtime knobs |
| `tests` | The suite block |
| `tools`, `skills`, `mounts` | Workflow-wide grants and denials, `tools.allow_always` among them |
| `states` | The machine itself |

Each state carries its own `tools.allow`/`tools.forbid`, `transitions`,
lifecycle `before`/`after` hooks, and `triggers`. `triggers` says which state is
the start: one id, or a list of the several triggers that all begin there.

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

The runtime validates the edge against the state's declared `transitions`, runs
the leaving state's `after` hook, then unlocks the next state. A future state's
tools stay locked until that transition succeeds. Handing over to a human
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
with correction budgets cleared and that state's `before` hook re-run.

The conversation, the files written so far, and the session's variables carry
over untouched. The audit trail records the move as a `reset` step. Where a
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

`archmax_wait` is available in every state, terminal ones included. A session
that has answered and now awaits a reply parks where it answered and stays open.
Ban it with `tools: { forbid_always: [archmax_wait] }` to keep sessions from
parking themselves.

A state with **no outgoing transitions is terminal**, so the session ends when
the agent finishes there. A session starts at the state whose `triggers` matched
(`manual` for the CLI). A state may name several triggers as a list, and all of
them begin there. See [triggers](/guides/triggers/).

### What the agent sees of the graph

The graph is disclosed the way the tool surface is: from where the agent stands.
On every model call it is shown the active state's outgoing edges. Any other
state's slug, title, `summary`, hooks and transitions stay out of the prompt, and
so does the count of states:

```
Transitions — choose one with `archmax_advance` when this state's work is done:
- to `refund-review` (human decision node) — The refund is over $50, or the customer has asked twice.
- to `orders-question` — The customer is asking about order status, shipping or tracking.
```

Two consequences for authoring:

- **Every transition needs a `description`, and the schema enforces it.** It is
  the whole of what the agent knows about where an edge leads. Write it for a
  reader standing in the *source* state, which has no view of the target. Say
  *when* to take the edge: "The refund is over $50" routes, where "go to
  refund-review" leaves the agent guessing.
- **Routing logic belongs upstream.** The target state's `summary` and
  `instructions` stay invisible from the source, so the condition goes on the
  edge.

An edge's line marks a target that is a human decision node or terminal. Each
marker changes the call or what follows it: `evidence` may be attached only when
advancing into a human state, and both markers mean the agent stops there.
Nothing else about the target is rendered.

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
| `pendingDecision` / `pendingInput` | The park record a suspended session presents |
| `beforeDone` | Lifecycle `before` hooks already executed |
| `iterations` | Grade-and-retry attempts per state |

## Tool governance

Governance is **closed by default**: a grant has to be declared, and a denial
beats every grant. Three things are present in every state without being asked
for:

- **The always-on tools**: `ls`, `read_file`, `write_file`, `edit_file`, `glob`,
  `grep`, `write_todos`, `archmax_eval` and `archmax_run`.
- **The runtime's own `archmax_*` controls**: `archmax_advance` in non-terminal
  states; `archmax_reset`, `archmax_wait` and the variable tools everywhere.
- **The workflow's `tools.allow_always` grants**, declared once at the root.

Every other tool has to be declared. A state with no `tools` block gets exactly
that surface, and no declaration opens a state fully. A state's `tools.allow`
list **grants** additional tools, and it **narrows** an always-on tool when an
entry names one.

Denial is declared beside the grant, in the same two positions and with the same
entries. `tools.forbid_always` at the root denies in every state. `tools.forbid`
on a state denies while it is active, subtracting from the workflow's grant, the
state's own `allow`, and the always-on surface alike.

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
        # write_file is always on (usable everywhere), but this state narrows
        # it to reports/answer.json; the other always-on tools stay unconstrained.
        # Note the path is NOT under scratchpad/: that area is permitted in
        # every state, so an entry naming a path inside it would narrow
        # nothing there (validate warns). Govern a result by naming an
        # ordinary session path, as here.
```

`{ tool, paths: [...] }` is a shorthand for `args: { file_path: [...] }`, and a
bare string matches the tool with any arguments. `archmax_advance` is always
permitted.

`allow_always` entries are **grants** for tools that are not always on. A
per-state entry for the same tool takes precedence, as in the example above.
Listing an always-on tool in `allow_always` is inert, and `archmax validate` warns
about it. The tool descriptions the agent sees are derived from exactly what is
enforced.

The model **sees** exactly that surface. Each model call presents the always-on
tools, the `allow_always` grants, the state's own entries, and `archmax_advance`
outside terminal states, minus every tool denied there by name.

Disclosure follows the state machine deterministically, and enforcement sits
underneath it: a call to an undisclosed tool is still blocked by the kernel. A
script's `tools.*` bridge reaches past that per-state disclosure, but its calls
are governed by the active state exactly as the model's own calls are. Lifecycle
hooks are the exception, because they run on runtime authority, which waives the
state's allow list and nothing else.

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
capability governance belongs in a skills list, and the hook exemption: a state
may enable nothing while a `before` hook still reads the data it checks against.
It also covers why a state that enables no skill can run no script, since
`archmax_run` is confined to bundles.

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

A governed mount the state does not have is refused, and also **unseen**. The
refusal is `mount.not-allowed`, `mount.forbidden`, or `mount.read-only` for a
write into one a grant narrowed. Unseen means `ls`, `glob` and `grep` results
lose every entry under it, the workspace root listing included.

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
| `scratchpad/` | Read and write, in every state |
| `large_tool_results/`, `conversation_history/` | Read |
| `checkpoints/`, `artifacts/` | None |

Authored content is mounted read-only as backend routes the wiring code composes:
`skills/` and `AGENTS.md` from the conventional default, plus any mount you add.
The workspace serves exactly what that table lists.

The system prompt's account of all this is **rendered from the resolved mount
table**, so it names exactly the directories the workspace serves. A mount the
host governs is named only where the state actually has it (see
[Mount governance](#mount-governance) above).

`workflows/` is deliberately absent from that list, and cannot be added. The
machine spec (its grading rubrics included), its hook scripts and its test cases
are read by the runtime through a separate authoring backend, and they have no
route in the agent's workspace.

So a session cannot read the workflow that governs it, or the rubric that vetoes
it. See [The authoring plane](/guides/authoring-plane/).

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
  on: that is what settles the fact. Without a lock, any later state can
  overwrite it, and the later value simply wins, since execution is sequential
  and a rewrite is one writer twice.
- **Paths read data.** Traversal is own-properties-only, so `${{tags.length}}`
  and `${{v.constructor}}` do not resolve.

`requires` is how you make a reference *guaranteed*. With neither a `requires`
nor a seed, assembly warns that the guard rests on the agent having called
`archmax_set_variables` first. The turn then fails at the guarded call when it
has not.

The agent reads the store with `archmax_get_variables({ name?, path? })` and
writes it with `archmax_set_variables({ variables, lock? })`. Both are standard
equipment, always permitted and always disclosed, like the other always-on
tools. So a host's seeds are readable even by a workflow whose spec references no
variable.

Lifecycle scripts get a read-only `args.variables` snapshot. They have no write
path, so a hook cannot edit the governance inputs of the state it is judging.

### Two reserved names

Two variable names mean something to the runtime. They are opposites, and the
contrast is worth holding onto:

| | `trigger` | `title` |
|---|---|---|
| Who sets it | the runtime, at every arrival | the **agent**, prompted |
| Locked | always | **never**, by any route |
| Guaranteed set | yes, from the first turn | no; absent until written |
| In a trigger's `requires` | accepted | accepted (seeded unlocked) |
| In a trigger's `returns` | refused | refused |

**`trigger`** holds the id that started the current turn. See
[Triggers](/guides/triggers/).

**`title`** is a short one-line label naming the task the session is doing. The
agent is the one party that knows what a session is about, so it writes the
title itself. The platform system prompt asks it to set one as its first
activity, and to update it when the task turns into something the old title no
longer describes.

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
It lands **unlocked**, the single exception to "every seed is locked".

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

Scripts are the exception. An `archmax_eval` or hook script already holds the
values in `args.variables` and composes strings in JavaScript. So `${{…}}` in a
script's `tools.*` call is ordinary text.

## Lifecycle hooks (`before` / `after`)

Each state may declare a `before` and/or `after` hook that the **runtime** runs
deterministically. A hook is either a `script:` (a JS file run in the QuickJS
sandbox) or a `rubric:` (a
[grading rubric](/guides/grading-rubrics/) declared in the same
spec, returning a verdict).

A hook field may also be an ordered list. The list runs in sequence,
short-circuiting on the first non-`ok` verdict.

```yaml
states:
  identify-case:
    triggers:
      manual:
    before:                                           # runs before the agent acts; may veto
      script: hooks/check-requester.js              # hand-authored, self-contained JS file
  orders-question:                                    # terminal (no transitions)
    after:
      rubric:                                         # the grader, inline
        max_iterations: 2                             # bounded grade-and-retry loop
        instructions: |-
          Judge the tone of the reply. Return ok, correct or veto with a reason.
```

Hooks return a verdict:

- **`ok`**: proceed.
- **`correct`**: the reply is incomplete. `archmax_advance` is rejected with
  guidance, and the agent gets another attempt. Any `after` hook, script or
  rubric, may return `correct` and gets the same bounded flow. The budget is
  `max_iterations`: inside the declaration for a rubric, a sidecar for a script
  or custom hook, else 0. It is counted per hook, so two graders on one state
  each get their own.
- **`veto`**: hard block.

`before` hooks are **ok/veto only**. A before `correct` is treated as a veto
with an explanatory reason, and never consumes the budget. `archmax validate`
errors if a before hook declares `max_iterations`.

Hooks are **fail-closed**. A hook that *errors* vetoes the transition, and a
grader whose output cannot be parsed into a verdict vetoes with a snippet of the
raw output.

A script returns the verdict vocabulary: `ok()`, `veto(reason)`,
`correct(reason)`, a bare `false` (shorthand for a veto), or nothing at all. The
return value *is* the verdict, so any **other object** vetoes too, with its keys
named in the reason. A misspelled `verdict`, or a shape like
`{ ok: false, reason }`, would otherwise read as `ok` and permit exactly what the
hook meant to block.

The two phases gate different things. A `before` hook decides entry, and a start
state's can veto the whole session before any model work. An `after` hook decides
the `archmax_advance` out of a state, or runs at completion for a terminal state.

A refused entry is a **rejection**. The veto's reason is the turn's reply. The
session routes through the state's `on_error` if it declares one, else settles
`status: rejected`. That is the same shape a terminal `after` rejection takes, so
a caller can tell a governed refusal from a finished run.

Argument-shape restrictions belong in `tools.allow`, or in a `forbid` entry's own
guards. *Semantic* validation of a permitted call belongs in the state's `after`
hook, which can veto the transition after inspecting what was actually written.

### Script hooks are hand-authored

The yaml only *wires* a script hook (`before: { script: hooks/x.js }`). The
script itself is a hand-authored, self-contained JS file.

It opens with a leading JSDoc block: a title line, a blank line, then prose. That
prose states what the check reads, the sequence it performs, and the condition
producing each verdict. See
[Description frontmatter](/guides/code-interpreter/#description-frontmatter);
there are no special tags. A missing script file at run time fails closed exactly
as any hook error does, and the workflow's cases are the behavioral check.

A `specification` sidecar on a hook is not part of the schema. A hook must be a
single-key tagged object: `script:` or `rubric:`, plus the recognized sidecar. So
declaring one makes the hook malformed, and it is rejected.

### No prose sidecar

A hook carries no `instructions` sidecar and no `model`. A rubric's criteria and
its model are inside its own inline declaration, and a script's contract is the
script file itself. So declaring either on the hook is a schema error naming the
key. The only sidecar any hook kind accepts is `max_iterations`.

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
naming the edge taken, any comment, and the state the session is now in.

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
  one model call with no tools bound at all. So the park carries a message
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

Nothing said in either direction routes the session. The reply turn is disclosed
no tools, and the kernel refuses every call made during one. That is rule
`tool.reply-only`, evaluated ahead of `tools.allow`, `allow_always`, the
`archmax_*` controls and the scratchpad.

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
  boundary, before any state, hook or model call. It reads
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
configured. Sampling stays environment configuration. A grading rubric keeps its
own `model`, and a sub-workflow runs on what its own spec declares.

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
| Enforcement | `workflow.yaml` | Authoritative: states, allowed tools, transitions, hooks |
| Standing direction | Top-level `instructions` | Workflow-wide conventions and house rules, in the static prompt |
| Overview | `WORKFLOW.md` (optional) | Prose addendum appended after the rendered graph; not enforced |
| State behavior | State `instructions` (+ optional skill) | Per-state guidance surfaced to the agent |
| Persona | `AGENTS.md` | Who the agent is |
| Platform | Ships in the package (a workspace may override it with `.platform/system/GRAPH_STATE.md`) | Runtime-generic execution model |

Put workflow-specific routing, domain policy, and artifact rules in
`workflow.yaml` and [skills](/guides/skills/). The platform prompt
is for the runtime-generic execution model.
