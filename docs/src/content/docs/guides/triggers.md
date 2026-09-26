---
title: Triggers
description: Declare multiple start states and select one per invoke, with manual for the CLI plus named tool and event triggers.
sidebar:
  order: 2
---

A workflow may declare multiple **start states**, and one state may be the entry
for several triggers. A firing can also *resume* a live session; see
[sessions and parked runs](/guides/sessions/).

`manual` designates the CLI/Deep-Agent entry, and the user's prompt travels
beside it as the turn's message. Any other value names a tool or event whose
invocation starts the workflow there.

## Declaring a start state

A trigger is declared under a state's `triggers:` mapping, and the key is the
trigger id. The state that mapping sits on is the trigger's **entry state**.

A firing enters that state directly, as a normal turn: the agent's model turn
for an `agent` state (the default), or the decision for a `human` one.

```yaml
states:
  triage:
    triggers:
      manual:
    transitions: [{ to: answer }]
  on-email:
    triggers:
      email_received:
    transitions: [{ to: answer }]
  answer: {}
```

An empty key (`manual:` above) declares just the id. A trigger is declared in
exactly one place, so reading one state tells you everything about what starts
it.

A workflow may declare as many start states as it likes. The trigger id is
recorded in checkpointed state, and lifecycle hooks and scripts read it as
`args.trigger`.

A state that declares a trigger can also be the target of another state's
transition. It runs its turn like any other state.

## One state, several triggers

Give the mapping several keys when the same state is where a session begins,
however it was started:

```yaml
states:
  triage:
    triggers:
      manual:
      email_received:
        session: conversation_id
    transitions: [{ to: answer }]
  answer: {}
```

`triage` is the entry state for both ids, and each key carries its own
declaration. A shared entry state has **one** behavior: one set of
`instructions`, one tool allowlist, one set of transitions.

Which trigger fired stays readable per session, as `${{trigger}}` in a guard and
`args.trigger` in a hook. Branch on it where the paths genuinely differ, and
declare separate states once they differ enough to be two states.

Two rules the loader enforces, each failing the workflow closed with the state
and the id named:

- A **trigger has at most one entry state.** Two states declaring one id is an
  error naming both. A mapping with several keys is several triggers entering
  one state.
- **At least one state declares a trigger**, or the workflow has no start state
  and nothing can begin it.

A repeated id on one state needs no rule: a YAML mapping cannot repeat a key.

## Hosts may decorate a declaration

A declaration says how a trigger's firings map to a session (`session:`). A host
embedding the SDK often needs to record something else about a trigger: where a
firing's words live, or which access connection guards the endpoint it is
exposed on. The declaration is where those go:

```yaml
states:
  intake:
    triggers:
      chat:
        session: triggers.-1.threadId
        message: triggers.-1.text     # host-resolved
        connection: acme-oidc         # host-resolved
        piece: slack                  # the host's own, preserved and ignored
```

The SDK **preserves what it does not interpret**, in three degrees:

- `message:` and `connection:` are shape-checked, so a malformed `message` path
  gets the same diagnostic a malformed `session` path gets. Both read back off
  the loaded machine, via `messagePathForTrigger(id)` and
  `connectionForTrigger(id)`. The runtime itself leaves them alone.
- A key the SDK defines nowhere is kept, reported as a warning, and otherwise
  ignored. A host can add its own without a coordinated release.
- A *structural* problem in the declaration fails workflow load.

Two keys are refused, because each would be *wiring* the SDK reads somewhere
else:

- **`entry:`** is settled by placement: the state the declaration sits on is the
  entry state.
- **`name:`** is settled by the key: the key the declaration sits under is the
  trigger id. To rename the trigger, rename the key.

Both fail workflow load, naming the key and the trigger. Kept as host
decoration, either one would start the session somewhere the author did not say.

## A trigger may declare its signature

Two keys say what a session started through the trigger needs and what it produces:

```yaml
states:
  intake:
    triggers:
      chat:
        requires: [customer_id]        # a firing must supply this to start
        returns: [ticket_ref]          # the session guarantees this when it completes
```

The SDK **acts** on both, where the host keys above are inert.

`requires` is checked at the boundary. A firing that leaves one of its names
unsupplied is refused before the session starts, and the refusal names the
trigger and the missing variables. The old failure mode started the session and
died later at an unresolvable guard.

`returns` is checked where a session completes. One that reaches a terminal
state with a `returns` name unset is rejected. A session that *parks* is exempt,
since it has not finished.

Both are lists of run-variable names. The names ride in the prompt's
current-state block, so the agent is told what it must produce in every state,
before it can be failed for omitting it.

What the agent should *do* to produce a variable is said by that state's
`instructions`, which is where every other variable's meaning already lives.

### Typing a signature

An entry may be an object instead of a bare name, saying what kind of value the
variable holds and what it is for:

```yaml
states:
  intake:
    triggers:
      manual:
        description: Refund one order and report what was refunded.
        requires:
          - order_id
          - { name: quantity, type: integer }
          - { name: due, type: date, description: The day the refund is due. }
        returns:
          - { name: total, type: number, description: Refunded amount in EUR. }
          - approved
```

`type` is one of `string`, `integer`, `number`, `boolean`, `date`, `date-time`,
`object` or `array`, with the conformance rules in the
[reference](/reference/machine-spec/#the-signature-requires-and-returns). A bare
name stays untyped and takes any value, `null` included. A typed entry takes
neither `null` nor a value of another kind, and nothing is coerced, so the string
`"4"` is not an `integer`.

The types are held in three places:

- **At the boundary.** `quantity: "4"` is refused before any model call. The
  refusal names the trigger, `quantity`, `integer` and that a string arrived.
- **At the write.** `archmax_set_variables({ variables: { total: "12.50" } })`
  is refused as a correctable tool refusal: nothing is written, the agent is told
  the variable, the type and the trigger, and it can write `12.5` instead.
- **At completion.** A session that still holds a mistyped return is rejected,
  naming the terminal state, the variable and the type. The write check already
  covers the agent's own writes, so this catches a script or hook that wrote one.

The agent sees each typed entry with its type and description beside its name,
as `total (number) — Refunded amount in EUR.`. The declaration's own
`description` it never sees: that sentence is for a **caller** (a delegating
workflow, an MCP client, the reader of a start form), and the session's brief is
its `instructions`.

Type an entry when something outside the session reads the contract, for
example a caller that must build the value or a host that publishes a schema.
Leave it bare when any value will do.

A trigger's `requires:` also **guarantees** the variable for the purposes of
`${{…}}` guards. A guard bound to one is backed by the boundary, so `validate`
stops warning about it.

Both [reserved names](/guides/workflow-machine/#two-reserved-names)
are refused as a **return**, for opposite reasons:

- `trigger`, because the runtime always sets it, which makes the contract
  vacuous.
- `title`, because a sub-session's returns are copied up into its caller's
  store. A title crossing upward would rename the *caller's* task to whatever
  the sub-session called its own.

Both are fine in `requires:`. A supplied `title` is seeded **unlocked**, as
every route to that variable is.

The signature is what makes delegation checkable; see
[sub-workflows](/guides/sub-workflows/).

## `manual`: one entry for every ingress

`manual` is the one reserved trigger id. It names the entry at which a machine
is **started**, whichever ingress starts it:

- `archmax run <workflow>` from the CLI;
- an SDK invocation supplying no trigger id;
- a host firing that names `manual`;
- a **delegation** from another workflow calling `archmax_workflow_<slug>`.

They all use the same trigger, and they differ in what a firing *carries*. A CLI
or SDK invocation has a message, the prompt.

A delegation has no message, so the child works from its own state
`instructions` and the variables it was seeded with. The declaration reads the
same either way.

So one declaration makes a workflow both runnable and callable:

```yaml
states:
  plan:
    triggers:
      manual:
        requires: [account_id]
        returns: [enrichment_file, risk_level]
    transitions:
      - to: write
  write: {}
```

That signature is read at both boundaries. A caller sees `requires:` as the
delegation tool's parameters, typed where the entries are typed, and `returns:`
as its result, checked offline by `archmax validate`.

A host firing that leaves out `account_id` is refused, and a session that
finishes with either return unset is rejected. So a workflow's call signature is
declared in exactly one place.

It also means you can develop a delegated machine on its own, on the same terms
a caller will hold it to:

```bash
archmax run enrich-order --variables '{"account_id":"acct-42"}'
```

A machine **cannot tell** it was delegated: `${{trigger}}` reads `manual` in a
sub-session exactly as in a CLI one. The same inputs produce the same session
either way, so developing a machine standalone reproduces how it behaves when a
caller delegates to it. A caller that needs the child to know passes an ordinary
variable.

`session:` and `message:` are ordinary host-facing keys on `manual`, and a
delegation ignores both. Its session derives from the caller's, and it carries
no message.

:::caution[A delegated workflow needs a `manual` entry]
A sub-workflow is entered through `manual`, like `archmax run`. A workflow with
no `manual` entry has no state for a delegating caller to start in. The missing
entry shows up in the *calling* workflow's `archmax validate`.
:::

## An event that must not start a run

Every declared trigger is a **start** trigger: it sits on a state, and that
state is where its firings open a session.

So an event that belongs to a *live* session (a ticket being closed, a payment
settling) stays out of the spec. The host names the session it is delivered
into:

```ts
await agent.workflow.send(sessionId, { delivery: { trigger: { id: "ticket_closed" }, variables } });
```

```bash
archmax deliver <session> --trigger ticket_closed --variables '{"closed_by":"agent-7"}'
```

A firing may also carry a `sessionPath`, the same dotted path grammar
`session:` uses. Use it when the host would rather hand over the path than
resolve the id itself:

```ts
await agent.workflow.resolveSession({
  trigger: { id: "ticket_closed" },
  sessionPath: "conversation_id",
  variables,
});
```

A firing that names a trigger no state declares, with no session to deliver
into, is refused with `UnknownSessionTriggerError`.

## Every trigger firing is a manual invocation

A trigger is an **identifier** the caller supplies at invocation time. The SDK
runs no event listeners, pollers, or webhook servers, so the external system
that observed the event is the one that invokes the SDK with the id. Three
places carry it in:

- `createAgent`'s `trigger` option, the assembly-time default;
- `agent.workflow.send`'s `trigger`, per turn;
- the CLI's `--trigger` flag.

A trigger carries **no payload**. Whatever the event contained arrives as
[session variables](/guides/workflow-machine/#session-variables):
`variables` at assembly, or `--variables` on the CLI. A session's facts
therefore have one home, which is also the one thing a tool guard can bind to.

## One assembled agent serves every trigger

The turn boundary enters whichever declared start state the turn's trigger
selects. A single assembled agent therefore serves every trigger, with no
reassembly per trigger.

The trigger is supplied **per invoke** as invoke input, falling back to the
assembly-time default (`createAgent`'s `trigger` option), then to `manual`:

```ts
const agent = await createAgent({ workflow: "support" });
if (!agent.workflow) throw new Error("expected a workflow");

// Validate before invoking — fails closed on an unknown trigger id.
const manual = agent.workflow.resolveTrigger({ id: "manual" });
await agent.invoke(
  { messages: [{ role: "user", content: "…" }], trigger: { id: manual.id } },
  { configurable: { thread_id: "t1" } },
);

const email = agent.workflow.resolveTrigger({ id: "email_received" });
await agent.invoke(
  { messages: [], trigger: { id: email.id } },
  { configurable: { thread_id: "t2" } },
);
```

The event's payload rides `variables`, mapped field by field. An explicit
mapping keeps the session's variable set intentional. It also lets a guard bind
to a name you chose:

```ts
const agent = await createAgent({
  workflow: "support",
  trigger: { id: "email_received" },
  variables: {
    from_email: payload.from_email,
    account: { region: "eu", plan: "enterprise" },   // structured values are fine
  },
});
```

Every seed except `title` is **locked**: a host-supplied fact stays as the host
set it, which is what makes a guard bound to one trustworthy. A value the agent
should be able to change is left unseeded, and the agent sets it with
`archmax_set_variables`.

The id itself follows four rules:

- An **omitted** trigger uses the assembly-time default, or `manual` when none
  was configured.
- An **unknown** trigger id is refused before any model-driven work. Resolve it
  via `resolveTrigger`, which throws `UnknownTriggerError` listing the declared
  ids.
- The trigger is written once at the turn boundary into checkpointed state.
  Lifecycle `before`/`after` scripts read it as `args.trigger` (the **id
  string**), and the session's input as `args.variables`. Both survive resume.
- The id is also exposed as the built-in `trigger` variable. A guard can bind to
  how the session started (`${{trigger}}`) without any seeding. It is one of
  two reserved names. The other, `title`, names the *task* and is written by the
  agent; see
  [Two reserved names](/guides/workflow-machine/#two-reserved-names).

The CLI `run` command delivers the `manual` trigger by default. Pass
`--trigger <id>` to enter any declared start state, and `--variables '<json>'`
to seed the session's input (see the [CLI guide](/guides/cli/)).

A case declares its own start on the case document: a top-level
`trigger: { id }` key, with a sibling `variables:` block for the input. See
[start conditions](/guides/testing/#start-conditions-trigger-variables-and-workspace).
