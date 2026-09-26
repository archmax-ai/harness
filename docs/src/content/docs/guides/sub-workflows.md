---
title: Sub-workflows
description: Call another governed workflow from a state. Its declared signature is the tool's signature, and its returns are the result.
sidebar:
  order: 6
---

A **sub-workflow** is another workflow in the same workspace, run to completion
from inside a session as a **child session**. It is a whole machine: its own
states, its own per-state `tools.allow`, its own lifecycle hooks. That is what
separates it from a script, which is deterministic work with no model call, and
from a grading rubric, which is a verdict on work already done.

Delegate to one when the work you are handing off is itself a *process*, or when
the same process is reused by more than one workflow.

## Choosing between the three

| Use | When |
| --- | --- |
| **Subagent** | isolated reasoning inside one state; no states, no governance boundary |
| **Script** | deterministic work with no model call, including a delegation that must happen, or a fan-out computed from data |
| **Sub-workflow** | the delegated work has states, governance, or hooks of its own; or it is reused |

## Delegation is a tool call

A state that may run another workflow says so in its `tools.allow`:

```yaml
states:
  triage:
    triggers:
      manual:
    instructions: >-
      Enrich the order the customer asked about by calling
      archmax_workflow_enrich-order with its id, then record what it returned.
    requires:
      - enrichment
    tools:
      allow:
        - archmax_workflow_enrich-order
    transitions:
      - to: report
        description: The order has been enriched.
```

That entry is the whole declaration. The runtime reads `enrich-order`'s
`manual` trigger and binds a tool named for it, using the slug **verbatim**. So
the tool name, the `workflows/<slug>/` directory, the mock key and the
`ranWorkflow` assertion are one string you can grep for.

The signature comes from the target, not from the caller:

```
archmax_workflow_enrich-order({ order_id: "ORD-1003" })
  → { message: "Enriched ORD-1003.",
      returns: { enrichment_file: "scratchpad/enrichment/ORD-1003.json", delayed: true } }
```

Its **parameters** are the target's `requires:`, each marked required, and its
**result** carries the target's `returns:` alongside the child's closing message.
A target that declares no `returns:` answers with the message alone.

### Typed parameters

A target that [types its signature](/guides/triggers/#typing-a-signature) hands
the caller's model a typed tool schema. `{ name: quantity, type: integer }`
becomes `quantity: { type: integer }`, `{ name: due, type: date, description: … }`
becomes `due: { type: string, format: date, description: … }`, and a bare name
stays an untyped parameter. The tool's description leads with the `manual`
trigger's `description`, so the calling model reads what the call does first. The
target's `instructions` never reach the caller.

A call whose argument does not conform is refused with `invalid-param` before any
child is composed, naming the argument, its type and what arrived. A missing
argument is still `missing-param`, which is reported first.

An argument may reference the caller's variables. One that is **exactly one**
reference, such as `"${{count}}"`, is seeded with the referenced value itself, so
a number stays a number and satisfies an `integer` parameter. An argument that
mixes text with references, such as `"order ${{order_id}}"`, is substituted as
text. An unresolvable reference fails the call with `unresolved-param`.

The returns are held to their types too. A child that settles with a typed
return holding another kind of value fails the call with `invalid-return`, naming
the state, the variable and the type. One that leaves a return unset fails with
`missing-return`. No partial result reaches the caller either way.

The tool surface is closed by default, so a state reaches exactly the targets it
names. Delegation needs no rule of its own. `policy.forbid_tools` blocks it like
any other tool.

### Nothing captures the result

The result reaches the caller as a tool result, with no capture variable in
between. An agent that wants it as a session variable sets it with
`archmax_set_variables`. A script writes the value it just received.

What makes that dependable is the calling state's `requires:`. A state that must
produce `enrichment` declares it, and `archmax_advance` out of that state is
refused until the variable is set. That is the rule already governing every other
variable a state must produce.

### One call runs one sub-workflow

Fan-out needs no argument, because both ways of calling already have one:

- an **agent** fans out by emitting parallel tool calls;
- a **script** fans out with `Promise.all`, which genuinely runs the calls
  concurrently across the sandbox bridge.

Both are bounded by the dispatcher's `maxConcurrent`, which queues the excess.
Each call succeeds or fails on its own, so a caller learns *which* child session
failed.

Where the fan-out must be deterministic, write a script:

```js
// scripts/enrich-orders.js
// The bridge camelCases tool names, and a tool result arrives as text.
const orders = args.variables?.orders_to_enrich?.value ?? [];

const enriched = await Promise.all(
  orders.map(async (entry) => {
    const answer = await tools.archmaxWorkflowEnrichOrder({ order_id: entry.order_id });
    const { returns } = JSON.parse(answer);
    return { order_id: entry.order_id, ...returns };
  }),
);

enriched;
```

The list never enters the model's context, and the script decides how many run.

## The target: its `manual` entry is its call signature

A caller enters a machine where a host would, at its
[`manual` trigger](/guides/triggers/#manual-one-entry-for-every-ingress).
That entry is enough on its own:

```yaml
# workflows/enrich-account/workflow.yaml
states:
  plan:
    triggers:
      manual:
        requires: [account_id]                 # what a caller must supply
        returns: [enrichment_file, risk_level] # what this machine guarantees it sets
    transitions:
      - to: write
  write: {}
```

Those two lists are the machine's **signature**, enforced whichever ingress
started the session:

| Half | When it bites |
| --- | --- |
| `requires` | a call short of any declared name, or with a value that does not conform to a typed entry, is refused before this workflow is composed |
| `returns` | a session that reaches a terminal state with any declared name unset, or a typed one mistyped, is rejected |

`archmax validate` checks the caller against the same declaration, offline.

Declaring the signature is optional. A trigger with neither key is callable and
takes no declared parameters, which is what a bare `manual:` says.

Because the entry a caller uses is the entry a host uses, the same machine runs
standalone on the same inputs:

```bash
archmax run enrich-account --variables '{"account_id":"acct-42"}'
```

`${{trigger}}` reads `manual` either way, so a machine cannot branch on having
been delegated.

**Who may call it** is decided entirely on the caller's side. A state calls
`archmax_workflow_<slug>` when it allow-lists that name, and an ancestor's deny
rules still bind inside the child. That is the same check every other tool
capability passes.

A child session carries **no prose instruction**. It works from its own state
`instructions` and the inputs it was seeded with, both of which reach the model
through the system prompt. So a parent has nothing to write or keep in sync.

`session:` and `message:` on the trigger are host-facing keys a delegation
ignores. A child session's id is derived from its caller's, and a delegation has
no message channel to resolve.

## Running a delegated machine standalone

A call's arguments are the child session's **initial variables**, supplied by a
caller instead of a host, built by the same function and validated by the same
name rule.

So a delegated machine runs on its own, given the same inputs:

```bash
archmax run enrich-order --trigger manual \
  --variables '{"order_id":"ORD-1003"}'
```

That is how you develop and debug a child in isolation, one order at a time.

:::note
A standalone run short of an input the `manual` trigger declares is refused at the
turn boundary, before any model call: `Refusing to start: trigger 'manual' requires
'account_id', which this firing does not supply.` The same declaration documents
the inputs and keeps the entry state's guards `validate`-clean.
:::

## What crosses, and what does not

A child session is **the same agent**: same model, backend, host tools. It has its
own grading rubrics, read from its own spec, and it is governed by the **child's**
machine, starting with a fresh transcript.

| Direction | Crosses |
| --- | --- |
| Down | the call's arguments, locked as session variables (except `title`, which stays unlocked) |
| Up | the declared `returns`, the result message, and any files the child wrote |
| Never | the child's other variables, its `title`, its transcript, or its audit trail |

The child is its own **session**, `<parent>~<state>:<workflow>:<n>`, with its own
checkpoints and its own `scratchpad/…`. `archmax sessions` lists it with
`parentSessionId` naming the caller. What the caller reads back is the tool result,
never the child's files.

A child session sees **only** what its caller declared. The delegating session's
own variables stay behind, so anything the child needs must be named as an
argument. That keeps its inputs readable at the call site.

When the child session finishes, the variables named in its trigger's `returns:`
are read out of its settled store, and everything else it set is discarded.

The child's **`title`** is among the things that stay behind. It is refused in
`returns:` so it cannot be smuggled up. A child session's title names the child
session's task, and merging it would rename the caller's.

A caller that wants the child working under a particular label passes one *down*
as an argument. It lands unlocked there, and the child may refine it. See
[Two reserved names](/guides/workflow-machine/#two-reserved-names).

The caller reads the declared returns off the tool result:

```
archmax_workflow_enrich-account({ account_id: "acct-42" })
  → { message: "Enriched acct-42.",
      returns: { enrichment_file: "scratchpad/e/acct-42.json", risk_level: "low" } }
```

The two keep separate channels. The message is prose the model reads, and the
returns are values a guard or a script reads by name.

## Bounds

Bounds are the **dispatcher's** configuration. A workflow cannot know how deeply
someone else will delegate to it:

```ts
createSubWorkflowDispatcher({
  registry,
  machine,
  bounds: { maxDepth: 3, maxConcurrent: 4 }, // the defaults
});
```

Excess concurrent dispatches **queue** rather than fail. Exceeding the depth, or
delegating to a workflow already running in the chain, is refused before
anything is composed.

## Human decisions inside a sub-workflow

A delegated machine may declare a `type: human` state. When a child session reaches
one, **the child suspends and the delegating session suspends with it**. The
session parks exactly as it would at the parent's own human state.

The decision presented is the **child's**: its state, its instructions, its
evidence, its declared transitions. That is the decision the person is actually
being asked to make. Resolve it the usual way:

```bash
archmax decide <sessionId> <target>       # a target from the CHILD's transitions
```

The child continues from that state, finishes, and the delegating session carries on
with its result.

The park does **not** unwind the calling turn. The suspension is recorded and
the turn ends, so if one of five concurrent calls stops for a person:

- the session parks, and the four that answered keep their results;
- resolving the decision resumes just the child that stopped, so each call is
  dispatched once;
- the child's answer then arrives in the transcript as
  `[sub-workflow: <slug>] …`, a [runtime
  note](/guides/sessions/#delivering-the-event), and a fresh
  turn continues in the same state.

Several parked children are presented one at a time. The session parks again while
any remain, so approving five refunds is five decisions on one session.

:::caution
A delegation call made from a **script** cannot park. A sandbox frame is not
durable, so a child that reaches a human state fails that call closed with
`parked`. Call it from the state's agent, or move the decision to a human state in
the calling workflow.
:::

## Failure is always closed

A child session fails when it is rejected, exceeds its budget, cannot be loaded,
or completes short of a `returns` name it declared (`missing-return`) or with a
typed return of the wrong kind (`invalid-return`). The call answers with a **tool
error** naming the workflow and the reason.

The calling agent can then retry with different inputs, route around it, or stop.
Where it cannot recover, the state's `requires:` holds it in place until the work
is genuinely done. The state's `on_error` catches the turn failure as it catches
any other.

Refusals the runtime makes **before** anything runs are blocked calls rather than
tool errors: depth, a cycle, a missing required input (`missing-param`), an input
of the wrong type (`invalid-param`), an unresolvable reference
(`unresolved-param`), a **disabled** target. No child was composed, so the caller
may correct and retry within the turn.

A target that declares
[`disabled: true`](/reference/machine-spec/#disabled-take-a-workflow-out-of-service)
is refused this way. The call is blocked before a child is composed, naming the
flag and how to undo it. The refusal wins over a declared **mock**, so an offline
case can never assert a delegation production would refuse.

A disabled target leaves the caller's assembly valid, and its tool is still bound:
disabling one leaf workflow should leave every caller, and every caller's parked
session, running. Re-enabling it is picked up on the next dispatch, with no
re-assembly.

Concurrent calls fail independently: one failure leaves the others' results
intact.

Denials compose downward and accumulate. Every ancestor's `policy.forbid_tools` /
`forbid_paths` binds inside the child: the root's and each intermediate caller's.
The block reason names the workflow that declared the rule. A child may narrow
what is permitted, and widening it takes a change upstream.

## Validation

`archmax validate` checks delegation statically, before any model call:

- every allow-listed `archmax_workflow_<slug>` names a workflow that exists,
  loads, and declares a `manual` entry. Each problem is reported against the
  state that allowed it, in the wording assembly would use;
- no self-reference, no cycle, no chain deeper than `maxDepth`, computed over
  what each workflow **may** call;
- every allow-listed target that is currently **disabled** draws a *warning*,
  not an error, reported against the state that allows it. The caller's spec is
  valid, and the call would be refused at runtime.

Whether a *call* supplies the target's `requires:`, with values of the declared
types, is not statically knowable, because the arguments are the model's or a
script's. That check is the
dispatch-time refusal, which happens before the child is composed.

## Observability

Each dispatch emits `sub-workflow-start` / `sub-workflow-result`. The result
carries the returned variables' **names**, never their values: the event stream is
a diagnostic channel. It also carries the id of the tool call that started it, so
concurrent child sessions stay individually attributable.

The audit trail records one `sub-workflow` step per child session, naming the
child and whether it succeeded. That step is addressed to the state that made the
call, since a delegation traverses no edge and the session is in the same state
before and after. The child's own trail stays on the child session, readable from
its own summary.
