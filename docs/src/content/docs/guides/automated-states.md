---
title: Grader and code states
description: The two state types the runtime runs itself. A grader state judges the session's work, a code state runs the workflow's own checks, and both move the session with archmax_advance like every other state.
sidebar:
  order: 5
---

Most states are run by the session's agent: it reads the state's `instructions`, does the work and
calls `archmax_advance`. Two state types are run by the runtime instead. Together they are the
**automated states**:

- A **code state** (`type: code`) runs a script the workflow ships: a deterministic check, a
  lookup, a record written at the end. The script decides where the session goes.
- A **grader state** (`type: grader`) runs a grader, an isolated subagent whose criteria are the
  state's `instructions`. It approves the work onward or sends it back with what to change.

Both are ordinary states on the graph. They are entered by a transition, leave with
`archmax_advance` along one of their own transitions, can end the session with `archmax_raise`,
and are held to their own tool surface. A check is a box on the graph, with edges in and out.

The refund workflow from the [quickstart](/getting-started/quickstart/) has one of each. The agent
decides the refund in `decide`, the `check-decision` code state checks the decision against the
policy, the `review-email` grader state checks the email, and the agent sends it in `send`. A wrong
decision or a weak email goes back to `decide` with what to fix.

## How an automated state runs

The runtime runs an automated state whenever the session's position reaches it: an agent's or
another automated state's advance, a person's decision, an `on_error` route, a trigger that enters
there, or an `archmax_reset` back to it.

It runs **in place of the agent's next model call**, so the agent's model is not called while the
session stands there. When it moves the session into another automated state, that one runs next.
A chain of code states makes no model call at all: a session can be screened, enriched and
recorded before any model is asked anything. The chain stops at the first agent state, a human
state (which parks), the session's completion or a failure. Each run is its own checkpointed step.

A chain that never stops, such as two code states advancing to each other, ends like any runaway
turn, at LangGraph's recursion limit: 400 graph steps unless the caller's invoke config sets its
own. The session ends `failed` with the code `recursion-limit`, and no `on_error` route is taken
(see [a turn that throws](/reference/public-api/#a-turn-that-throws)). A loop you bound yourself,
with a counter in a variable or a count read from the trail, works as written.

An automated state **cannot park**. A script frame is not durable, and a grader judges rather than
waits. To hand work to a person, advance into a human state.

## What each state is offered

An automated state is offered exactly its own state's tool surface:

- its own `tools.allow` grants;
- the workflow-wide grant: what `tools.allow_always` lists, or the
  [default tools](/reference/machine-spec/#toolsallow-closed-by-default-governance) when the
  workflow declares none;
- the host's `essentialTools`;
- its state type's controls.

| State type | Controls | Never offered |
| --- | --- | --- |
| agent, human | `archmax_advance`, `archmax_reset`, `archmax_wait`, `archmax_raise`, `archmax_get_variables`, `archmax_set_variables` | none |
| grader, code | `archmax_advance`, `archmax_raise`, `archmax_get_variables`, `archmax_set_variables`, `archmax_get_history` | `write_todos`, `archmax_eval`, `archmax_run`, `archmax_wait`, `archmax_reset` |

`archmax_advance` is left out in a terminal state, whatever its type. On a grader or code state, a
grant naming a withheld tool offers nothing, and a `tools.allow` entry naming one is an
`archmax validate` error. A host reads the same table as `STATE_TYPE_TOOLS` from
[`@archmax-ai/harness/spec`](/reference/public-api/#archmax-aiharnessspec).

Every call an automated state makes is decided by the kernel against **that state**, as the
agent's calls are. Its `tools.forbid`, the workflow's `forbid_always`, its skill and mount grants,
consumer rules and every safety rule bind it, and a forbid can deny even a control. A tool another
state grants is out of reach: `check-decision` calls `lookup_customer` because its own
`tools.allow` names it. Likewise, a code state that reads a skill bundle's data enables that bundle
in its own `skills.allow`.

## Code states

```yaml
check-decision:
  type: code
  script: scripts/check-decision.js
  tools:
    allow: [lookup_customer]
  transitions:
    - to: review-email
      description: The decision matches the refund policy.
    - to: decide
      description: The decision contradicts the refund policy.
```

`script` is required on a code state and refused on every other type. It is a path inside the
workflow's `scripts/` directory, ending in `.js` or `.mjs`, with no `..` segment; this one is
`workflows/refund/scripts/check-decision.js`. The runtime reads it through the
[authoring backend](/guides/authoring-plane/), so the agent can neither read it nor run it.

A code state makes no model call, so `instructions`, `model`, `budget`, `evidence` and `approvers`
on one are `archmax validate` errors. Say what the script does in its
[description block](/guides/code-interpreter/#description-frontmatter) and in the state's
`summary`. Its transitions need a `description` like every other state's; here they record the
script's choices for whoever reads the spec.

### The script contract

```js
// workflows/refund/scripts/check-decision.js
export default async function ({ variables, tools }) {
  const customer = JSON.parse(await tools.lookup_customer({ email: variables.email }));
  const order = customer?.order;
  const due = order?.status === "delivered" ? "approved" : "denied";

  if (variables.decision === due) {
    await tools.archmax_advance({
      to: "review-email",
      reason: `The refund is ${due}, as the policy requires.`,
    });
  } else {
    await tools.archmax_advance({
      to: "decide",
      reason: `Order ${order?.id ?? "(none)"} is ${order?.status ?? "unknown"}, so the refund must be ${due}.`,
    });
  }
}
```

The default export is called once per entry, with the state's input (`CodeStateInput` in
`@archmax-ai/harness/sandbox`):

| Field | Meaning |
| --- | --- |
| `state` | The code state's own slug. |
| `trigger` | The id of the trigger the turn carries. |
| `variables` | The session's variables as a flat `name → value` map, the built-in `trigger` included. Assigning to it changes nothing: write with `tools.archmax_set_variables`. |
| `tools` | The code state's tools, as async functions. |

The rules:

- **`tools` is the state's surface.** A tool answers to its own name (`tools.lookup_customer`,
  `tools["archmax_workflow_enrich-order"]`) and to its camelCased key (`tools.lookupCustomer`).
  `Object.keys(tools)` lists the camelCased keys. A name outside the surface is `undefined`. A call
  with no argument is made with `{}`.
- **The script moves the session.** `tools.archmax_advance({ to, reason })` takes one of the
  state's transitions, and the next state reads the `reason`. `tools.archmax_raise({ code, reason })`
  ends the session as failed. The return value is not read.
- **One decision, applied at the end.** The first accepted `archmax_advance` or `archmax_raise` is
  the decision, and every later one is refused. It takes effect when the script finishes, so a
  script that advances and then throws fails, and the session does not move.
- **A refused call rejects.** A blocked tool call rejects with the rule and its reason. So does an
  advance to an undeclared target, or one made while the state's `requires` are unmet. The script
  can catch the rejection and decide otherwise. A write with `archmax_set_variables` is visible to
  the script's later calls, so a script can set what `requires` asks for and then advance.
- **Each run starts clean.** The script evaluates in a fresh REPL every time the state is entered,
  shared with neither the agent's `archmax_eval` nor another code state.
- **The sandbox bounds it.** `settings.timeoutMs` (15,000 ms by default), `memoryLimitBytes`,
  `maxPtcCalls` and `maxResultChars` bound the whole run. A cancelled turn stops it at once.
- **Console lines are reported.** Each `console.log` line is a `code-output` event, which the CLI's
  state flow prints under the state.
- **Imports are type carriers.** `@archmax-ai/harness/*` imports, such as `defineCodeState` from
  `@archmax-ai/harness/sandbox`, are stripped before evaluation. Any other import fails the state
  and `archmax validate`. There is no `task()` global and no `tools.task`.

A file with no default export runs as a plain script. It reads the same input from the global
`args`, and calls the global `tools`.

The session's transcript and trail are not in the input. A script reads them with
`tools.archmax_get_history()` (see [the history](#the-history)).

## Grader states

```yaml
review-email:
  type: grader
  instructions: >-
    Read scratchpad/email.md and the `decision` variable. Approve the email
    when it is polite, states the decision plainly and names the order.
    Otherwise send it back, saying exactly what to change.
  transitions:
    - to: send
      description: The email is ready to send.
    - to: decide
      description: The email needs changes.
```

`review-email` judges with its own state's tools: `read_file`, from the workflow-wide grant, for
the email, and `archmax_get_variables` for the decision. It reads the email itself rather than
trusting the agent's account of it.

A grader state must declare non-empty `instructions`, which are its criteria, and at least one
transition: a grader decides by advancing, and one with nowhere to send the session could only
approve by saying nothing. `evidence`, `approvers` and `budget.maxParks` are refused on a grader,
since it presents nothing to a person and cannot park. All of these are `archmax validate` errors.

### How a grader runs

On entry the runtime builds a grader for the state, with its own model, prompt and messages:

- **Its system prompt** is a compiled-in preamble followed by the state's `instructions`. The
  preamble tells the grader that it grades one state and talks to no one, that it reads the session
  with `archmax_get_history`, and that it makes exactly one decision: `archmax_advance`, whose
  reason the next state reads, or `archmax_raise` when the work cannot be accepted and must not be
  retried.
- **Its task message** names the grader state and lists its transitions, in the line format of the
  agent's graph section.
- **Its tools** are the grader state's surface, and each call is governed against that state.
  `${{…}}` references in its arguments resolve against the session's variables. A refused or
  failed call comes back as an error answer, and the grader carries on.

The grader's context is **isolated**. It reads the session only through its tools. Its messages
never enter the session's transcript, its tokens never stream as the session's text, and it writes
nothing into the session's checkpoint. Its decision reaches the session as a trail step and a
runtime note.

The run ends the moment the grader decides, with no further model call. A grader that finishes
without deciding, such as one that answers in text alone, fails closed.

### Budget and model

A grader's own loop runs under LangGraph's recursion limit of 400 steps, as a turn does, and its
`budget.timeoutMs` bounds its running time. Hitting either fails the state. Neither counts the
session agent's calls.

`model` names the model id the grader runs on. It resolves under the **`grader` model role**, as
`modelFactory("grader", env, id)`, where `id` is the state's `model`, else the workflow's
`settings.model`. With no factory, the grader runs on the env-configured model at that id, and on
the workflow's model when neither declares one. An explicit `model` instance passed to
`createAgent` outranks every declared id, as it does for the agent. See
[`modelFactory`](/reference/public-api/#modelfactory-pluggable-model-provider).

A grader's model calls are reported as `model-usage` events under the grader state, and they count
toward the session's usage.

### Counting rounds

A send-back loop between an agent state and its grader has no round limit of its own. It runs until
the grader approves or raises, or the turn's recursion limit stops it. A grader that should give up
says so in its `instructions` and counts the rounds from the trail `archmax_get_history` returns,
where each earlier send-back is a step `{ kind: "grader", to: "<the graded state>" }`. For
`review-email`, one more sentence does it:

> Before sending the email back, call `archmax_get_history` and count the trail steps with
> `kind: "grader"` and `to: "decide"`. If there are already two, raise `email-rejected` instead.

A code state counts the same way, from steps of `kind: "code"`. The reference workspace's
`check-refund` escalates after two send-backs.

## The history

`archmax_get_history` takes no arguments and is offered in grader and code states only. It returns
the session's **history** as JSON, `{ messages, trail }` (`SessionHistory` in
`@archmax-ai/harness/sandbox`): the whole transcript and the whole trail, oldest first. A grader
calls it as a tool. A script calls `tools.archmax_get_history()` and parses the answer. Both read
the same view, so a grader and a script counting the same rounds count the same steps.

What `check-decision` reads on its second run, after Bob's wrongly approved refund was sent back:

```jsonc
{
  "messages": [
    { "role": "user", "text": "Hi, I'd like a refund for my last order." },
    { "role": "assistant", "text": "", "toolCalls": [{ "id": "call_1", "name": "lookup_customer", "args": { "email": "bob@example.com" } }] },
    { "role": "tool", "text": "{\"name\":\"Bob\",\"order\":{\"id\":\"ORD-1002\",\"status\":\"shipped\"}}", "tool": "lookup_customer", "id": "call_1" },
    // … the decision recorded, the email drafted, the advance into check-decision
    { "role": "runtime", "text": "[code] 'check-decision' moved the run to 'decide': Order ORD-1002 is shipped, so the refund must be denied. …", "note": "code" }
    // … the decision and the email fixed, and the advance into check-decision again
  ],
  "trail": [
    { "to": "decide", "kind": "trigger", "reason": "manual", "ts": 1761300000000 },
    { "to": "check-decision", "kind": "agent", "reason": "…", "ts": 1761300004120 },
    { "to": "decide", "kind": "code", "reason": "Order ORD-1002 is shipped, so the refund must be denied.", "ts": 1761300004180 },
    { "to": "check-decision", "kind": "agent", "reason": "…", "ts": 1761300009870 }
  ]
}
```

Each message is `{ role, text, toolCalls?, tool?, id?, note? }` (`HistoryMessage`), and `role` is
`user`, `assistant`, `tool`, `system` or `runtime`:

- An `assistant` message lists the calls it made in `toolCalls`, each `{ id?, name, args }`.
- A `tool` message carries the call's result as its `text`, with the tool that answered (`tool`)
  and the id of the call it answers (`id`).
- A runtime note (an arrival, a decision, an error route, an automated state's move) is one
  `runtime` entry, and `note` names its kind.

Each trail step is a `TrailStep`, `{ to, kind, reason?, ts }`, plus `workflow` and `status` on a
sub-workflow step.

A check compares against what a tool returned, never a copy the model made of it. The result is
text, exactly as the agent saw it, so a script parses a JSON result itself, inside a `try` when the
call may have failed: a refused or failed call's answer is its error text. The call's arguments are
on the assistant message before it, in the `toolCalls` entry with the same `id`. A result too large
for the transcript is the pointer to its file under `large_tool_results/`.

The transcript holds the calls of the session's agent, its control calls included. A script's or a
grader's own calls are not in it: only the move they decide reaches the session, as a trail step
and a runtime note.

The history is read from the checkpointed session as it stood when the automated state was
entered, earlier turns included, never from the request a summary shortened for the model. Nothing
is windowed: a grader asked to give up after N send-backs has to see all N. What bounds it is the
grader model's context and, for a script, the sandbox's `maxResultChars` and `memoryLimitBytes`.

## How a run settles

Every automated run settles as exactly one of four outcomes:

| Outcome | When | What follows |
| --- | --- | --- |
| **advanced** | It called `archmax_advance` and finished cleanly. | The session moves. The trail records a step of kind `grader` or `code` with the reason, and a runtime note carries the reason to the next state. Into a human state, the session parks after the one handoff message a park owes. |
| **raised** | It called `archmax_raise`. | The session ends `failed`, its outcome's `exit` carrying the code and reason. No `on_error` route is taken, the trigger's `returns` are not checked, and no further state runs in the turn. |
| **completed** | A terminal code state's script returned without raising. | The session completes, held to the trigger's [`returns`](/guides/triggers/#a-return-is-owed-when-the-session-finishes). |
| **failed** | It threw or ran out of time, or a non-terminal state finished without deciding. | The failure routes through the state's [`on_error`](/reference/machine-spec/#on_error), else the session ends rejected. |

A raise wins over a later error, and an error discards a recorded advance. A non-terminal state
that finishes undecided fails with the reason
`code state '<slug>' finished without calling archmax_advance or archmax_raise` (or
`grader state '<slug>' …`). Finishing undecided is never read as approval.

A session that **completed** in a terminal code state takes its next message at the entry state of
that turn's trigger: no agent stands in an automated state to answer a follow-up. A session that
failed or was rejected in an automated state starts its next turn there, and the state runs again.

## What the session reads

The agent in the next state learns why it is there from a runtime note:

```text
[grader] The 'review-email' grader moved the run to 'decide': The email does not name the order; add ORD-1002. You are now in 'decide'.
```

A code state's note reads `[code] '<state>' moved the run to '<target>': <reason>`, and a raise
leaves `[code] '<state>' ended the session as failed ('<code>'): <reason>`. The note kinds are
`grader` and `code` (see [`runtimeNoteKind`](/reference/public-api/#reading-a-transcript)).

From the state before, the agent sees only the transition line, marked with the target's type:

```text
- to `check-decision` (code) — The decision is recorded and the email is drafted.
```

Nothing of a grader's `instructions`, `model` or `budget`, and nothing of a code state's script,
reaches any prompt of the session's agent. The platform prompt tells the agent that grader and code
states run on their own and may send the work back with a note saying what to change, and that it
should then fix the work and advance again.

### The turn's reply

A turn's [`reply`](/reference/public-api/#agent-in-detail) is every text the agent wrote during the
turn, in order, joined by a blank line, and `""` when it said nothing. A draft the agent wrote
before a grader or a code state sent it back stays in the reply, beside the corrected one. A
grader's own text never enters the transcript, so it is never part of a reply.

So put a send-back loop where the work is handed on rather than said, in front of no live answer.
The refund workflow drafts its email into a file and sends it with a tool, so a rejected draft
never reaches the customer.

## Events

Each run is bracketed on the [event stream](/reference/public-api/#lifecycle-event-stream):

| Event | Payload |
| --- | --- |
| `code-start` | `{ state, script }` |
| `code-output` | `{ state, line }`, one per console line |
| `code-result` | `{ state, status, durationMs, reason? }` |
| `grader-start` | `{ state }` |
| `grader-result` | `{ state, status, durationMs, reason? }` |

`status` is `ok` when the run settled on a decision or a completion, and `error` when it failed,
with `reason` saying why. Every tool call inside the run emits the paired
`tool-called`/`tool-result` events: a code state's carry `origin: "script"`, and a grader's carry
no origin, as a model's call does.

The narrative events follow once the run has settled, so nothing announces a move that a later
error discarded. A code state that logs one line and advances emits `code-start`, the advance
call's `tool-called` and `tool-result`, the `code-output` line, `code-result`, and then `advance`,
`state-leave` and `state-enter`. A raise emits `raised` and `state-leave` instead.

The CLI's [state flow](/guides/cli/#the-state-flow) prints a code state's run as
`› code scripts/check-refund.js` with its output beneath it, and a grader's as `› grader grading`.
A failed run adds a line naming the reason.

## Patterns

### A check in front of a state

To screen every request before any model call, make the trigger's entry state a code state that
advances to where the work starts, or to somewhere that declines it. The reference workspace's
`screen-request` does this:

```yaml
screen-request:
  type: code
  script: scripts/screen-request.js
  triggers:
    manual:
  skills:
    allow: [order-data]
  on_error: escalation
  transitions:
    - to: identify-case
      description: The requester is known and asks only about their own company's orders.
    - to: decline
      description: The request names no known requester, or reaches for another company's orders.
```

`decline` is an agent state that reads the script's reason from the `code` note and tells the
person. To end the session as a failure instead, with no reply, the script calls
`tools.archmax_raise({ code, reason })`.

### A check behind a state

To check the agent's work before the session moves on, route the agent's transition into a code
state with an edge onward and an edge back, as `check-decision` does. In the reference workspace,
`check-refund` sits between `refund-request` and the human `refund-review`, so a decision the
policy forbids never reaches the reviewer.

### Approve, then end

A grader that approves into a terminal agent state costs one more model call, because that state's
agent has to finish. The refund workflow's `send` is worth it: sending the email is the point. When
nothing more needs saying, approve into a **terminal code state** instead. Its script files a
record, or does nothing, and returns; the session completes with no further model call:

```yaml
emails-filed:
  type: code
  script: scripts/emails-filed.js
```

## Testing automated states

A case asserts an automated state by what it committed: `reachedState`, a `trail` step with
`kind: code` or `kind: grader` and its `reason`, `raised` for its raise, `variables` for what it
set, `ranWorkflow` for its dispatches. A code state's and a grader's own tool calls are not in the
transcript, so `calledTool`, `notCalledTool` and `usedNoTools` see only the agent's. Mocks answer
their calls as they answer the agent's, but a control tool is never mocked: an automated state's
`archmax_advance` and `archmax_get_history` are always the runtime's. See
[testing workflows](/guides/testing/#assertions).

```yaml
# workflows/order-lookup/tests/enrichment-fan-out.test.yaml (excerpt)
trigger:
  id: enrichment_requested
variables:
  orders_to_enrich:
    - order_id: "ORD-1002"
    - order_id: "ORD-1003"
steps:
  - send: "Enrich the requested orders."
  - ranWorkflow: { workflow: enrich-order, count: 2 }
  - reachedState: enrichment-reported
  - trail: { kind: grader, to: enrichment-reported, count: 1 }
```
