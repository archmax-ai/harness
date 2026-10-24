---
title: Grader and code states
description: The two state types the runtime runs itself. A grader state judges the session's work, a code state runs the workflow's own checks, and both move the session with archmax_advance like every other state.
sidebar:
  order: 5
---

Most states are run by the session's agent: it reads the state's `instructions`,
does the work, and calls `archmax_advance`. Two state types are run by the
runtime itself, and together they are called **automated states**:

- A **grader state** (`type: grader`) judges the work so far. The runtime runs a
  grader, an isolated subagent whose criteria are the state's `instructions`. The
  grader approves the work onward or sends it back with what has to change.
- A **code state** (`type: code`) runs a script the workflow ships. That might be a
  deterministic check, a lookup, or a record written at the end. The script decides
  where the session goes.

Both are ordinary states on the graph. They are entered by a transition, leave by
`archmax_advance` along one of their own transitions, end the session as a
failure with `archmax_raise`, and are governed by their own tool surface. Nothing
about them is hidden inside another state. A check is a box on the graph, with
edges in and out.

## How an automated state runs

The runtime runs an automated state whenever the session's position reaches it:

- the agent's `archmax_advance` into it;
- another automated state's advance;
- a person's decision at a human state;
- an `on_error` route;
- a turn that opens there, because a trigger enters it;
- an `archmax_reset` back to it.

It runs **in place of the next model call** of the session's agent. The agent's
model is not called while the session stands in an automated state. A grader's
own model calls are bounded by its `budget.maxTurns`.

When an automated state moves the session into another automated state, that one
runs next, again with no model call. A **chain of code states makes no model call
at all**: a session can be screened, enriched and recorded before any model is
asked anything. Each run is committed as its own checkpointed step. The chain
stops at the first agent state (whose model call is made for real), human state
(which parks), completion or failure.

A chain that never reaches any of those, such as two code states advancing to
each other, is stopped like any runaway turn by LangGraph's `recursionLimit`
(400 steps a turn, unless the caller's config sets its own). The turn throws
LangGraph's `GraphRecursionError` and ends the session `failed` with the code
`recursion-limit` (see
[a turn that throws](/reference/public-api/#a-turn-that-throws)); it does not
route through `on_error`. An intentional bounded loop (a counter in a variable, a
round count read from the trail) works as you would expect.

An automated state **cannot park**. It has no `archmax_wait`, and a reply-only
turn never runs in one. A script frame is not durable, and a grader judges rather
than waits. To hand work to a person, advance into a human state.

## What each state is offered

An automated state is offered exactly its own state's tool surface, and nothing
of the assembly beyond it:

- the state's own `tools.allow` grants;
- the workflow-wide grant: what `tools.allow_always` lists, or the
  [default tools](/reference/machine-spec/#toolsallow-closed-by-default-governance)
  (the file tools among them) when the workflow declares none;
- the host's `essentialTools`;
- its control tools.

| State type | Control tools |
| --- | --- |
| agent, human | `archmax_advance`, `archmax_reset`, `archmax_wait`, `archmax_raise`, `archmax_get_variables`, `archmax_set_variables` |
| grader, code | `archmax_advance`, `archmax_raise`, `archmax_get_variables`, `archmax_set_variables`, `archmax_get_history` |

Both automated types get the same controls, and only they get
[`archmax_get_history`](#the-history), which reads the session they check.
`archmax_advance` is left out in a terminal state, as it is for the agent. No
automated state is ever offered `write_todos`, `archmax_eval`, `archmax_run`,
`archmax_wait` or `archmax_reset`, even where the workflow-wide grant names one.
A `tools.allow` entry naming one of them on an automated state is an
`archmax validate` error, and the tool is not offered.

Every call an automated state makes is decided by the kernel against **that
state**, as the agent's own calls are. Its `tools.forbid`, the workflow's
`forbid_always`, its skill and mount grants, consumer rules and every safety rule
bind it. A code state that reads `skills/order-data/assets/orders.json` has to
enable `order-data` in its own `skills.allow`. A tool another state grants is not
reachable, and a forbid can deny even a control.

## Code states

```yaml
states:
  check-refund:
    type: code
    script: scripts/check-refund.js
    skills:
      allow: [order-data]
    on_error: escalation
    transitions:
      - to: refund-review
        description: The recorded decision matches the refund policy.
      - to: refund-request
        description: The recorded decision contradicts the policy; send it back with the fix.
```

`script` is required on a code state and refused on every other type. It is a
workflow-relative path inside `scripts/`, ending in `.js` or `.mjs`, with no `..`
segment, so the file lives at `workflows/<slug>/scripts/check-refund.js`. The
runtime reads it through the [authoring backend](/guides/authoring-plane/), so the
agent can neither read it nor run it with `archmax_run`.

A code state makes no model call, so the keys a model reads mean nothing on it.
`instructions`, `model`, `budget`, `evidence` and `approvers` on a code state are
`archmax validate` errors. Say what the script does in its JSDoc header, and in
the state's `summary` for the graph section. Its own transitions may go
undescribed, since its script routes on them and no model reads them, but every
edge *into* it needs a `description` (see
[what the session reads](#what-the-session-reads)).

### The script contract

The script's default export is called once with the state's input, and it moves
the session itself:

```js
/**
 * Refund policy check — the agent may not hand a refund the policy forbids to
 * the reviewer.
 *
 * Reads the recorded decision from scratchpad/refund.json and the order from
 * skills/order-data/assets/orders.json. A refund is "approved" only for a
 * delivered or delayed order. Advances to refund-review when the recorded
 * decision matches the policy; otherwise sends the session back to
 * refund-request naming the fix. An unreadable order database throws, and the
 * state fails through its on_error.
 */
import { defineCodeState } from "@archmax-ai/harness/sandbox";

export default defineCodeState(async ({ tools }) => {
  const refund = JSON.parse(await tools.read_file({ file_path: "scratchpad/refund.json" }));
  const orders = JSON.parse(await tools.read_file({ file_path: "skills/order-data/assets/orders.json" }));
  const order = orders.find((o) => o.id === refund.orderId);
  const policy = order && ["delivered", "delayed"].includes(order.status) ? "approved" : "denied";

  if (refund.decision === policy) {
    await tools.archmax_advance({ to: "refund-review", reason: `"${policy}" matches the refund policy` });
  } else {
    await tools.archmax_advance({
      to: "refund-request",
      reason: `the policy requires "${policy}" for ${refund.orderId}; update scratchpad/refund.json and advance again`,
    });
  }
});
```

The input (`CodeStateInput` in `@archmax-ai/harness/sandbox`):

| Field | Meaning |
| --- | --- |
| `state` | The code state's own slug. |
| `trigger` | The id of the trigger the turn carries. The session's input is in `variables`. |
| `variables` | The session's variables as a flat `name → value` map, the built-in `trigger` included. Assigning to it changes nothing: write with `tools.archmax_set_variables`. |
| `tools` | The code state's tools, as async functions. |

The session itself is not in the input. The script reads it the way a grader
does, through a tool:

```js
const { messages, trail } = JSON.parse(await tools.archmax_get_history());
```

That is the session's whole transcript and whole trail, oldest first (see
[the history](#the-history)).

What the contract says:

- **`tools` is the state's surface.** A tool answers to its own name
  (`tools.read_file`, `tools["archmax_workflow_enrich-order"]`) and to its
  camelCased key (`tools.readFile`). `Object.keys(tools)` lists the camelCased keys.
  A name outside the surface is `undefined`. A call with no argument is made with
  `{}`, so `tools.archmax_get_history()` needs none.
- **The script moves the session.** `tools.archmax_advance({ to, reason })` takes
  one of the state's transitions, and the `reason` is what the next state reads.
  `tools.archmax_raise({ code, reason })` ends the session as failed.
- **The return value is not read.** Returning `false`, a string or an object does
  nothing. There is no verdict to return.
- **A refused call rejects, and can be caught.** A blocked tool call rejects with
  the rule and its reason. So does an `archmax_advance` to an undeclared target, or
  one made while the state's `requires` are unmet. The script can catch the
  rejection and decide otherwise. A write with `archmax_set_variables` is visible to
  the script's later calls, so a script can set what `requires` asks for and then
  advance.
- **One decision per run.** The first accepted `archmax_advance` or `archmax_raise`
  is the state's decision, and every later one is refused.
- **The decision takes effect when the script finishes.** A script that advances
  and then throws fails, and the session does not move.
- **Each run starts clean.** The script evaluates in a fresh REPL every time the
  state is entered. That REPL is shared with neither the agent's `archmax_eval` nor
  another code state, and nothing a run leaves on `globalThis` survives it.
- **Console lines are reported.** Each `console.log` line is a `code-output` event,
  which the CLI's state flow prints under the state.
- **The sandbox bounds it.** The script is one evaluation, so `settings.timeoutMs`
  (15,000 ms by default), `memoryLimitBytes`, `maxPtcCalls` and `maxResultChars`
  bound it whole. A cancelled turn stops it at once, as it stops every script of
  the turn.
- **Imports are type carriers.** `@archmax-ai/harness/*` imports are stripped
  before evaluation, and any other import fails the state and `archmax validate`.
  There is no `task()` global and no `tools.task`.

A file with no default export simply runs. It reads the same input from the
global `args`, without `tools` there, and calls the global `tools`.

### Checking a tool's result

A check compares against what a tool returned, not against what the agent said
about it. In the history, a tool message carries the call's result inline, as its
`text`, with the tool's name and the id of the call it answers:

```js
import { defineCodeState } from "@archmax-ai/harness/sandbox";

export default defineCodeState(async ({ tools }) => {
  const { messages } = JSON.parse(await tools.archmax_get_history());
  const answer = messages.filter((m) => m.role === "tool" && m.tool === "get_order").at(-1);
  if (!answer) {
    await tools.archmax_advance({ to: "cancel-order", reason: "Look the order up with get_order before cancelling it." });
    return;
  }
  const order = JSON.parse(answer.text);
  if (order.status !== "pending") {
    await tools.archmax_advance({ to: "cancel-order", reason: `Order ${order.id} is ${order.status}.` });
  } else {
    await tools.archmax_advance({ to: "confirm-cancel", reason: `order ${order.id} is pending` });
  }
});
```

The result is text, exactly as the agent saw it, so a script parses a JSON result
itself. The arguments the call was made with are on the assistant message before
it: the entry in its `toolCalls` whose `id` is the tool message's `id`. A refused
or failed call's answer is its error text, so parse inside a `try` when the
call may not have succeeded.

## Grader states

```yaml
states:
  review-enrichment:
    type: grader
    budget:
      maxTurns: 8
    on_error: escalation
    instructions: |-
      You check the enrichments recorded for this run before they are reported.

      1. Read `orders_to_enrich` and `enrichments` with `archmax_get_variables`.
      2. The enrichments are correct when `enrichments` holds exactly one entry
         per requested `order_id` — none missing, none extra — and each entry
         has an `enrichment_file` and a boolean `delayed`.
      3. Read each `enrichment_file` with `read_file`: its `delayed` must match
         the entry's.

      - Correct: advance to `enrichment-reported`.
      - Wrong: advance back to `enrich-order`, naming exactly what is missing or
        does not match.
      - Before sending it back, call `archmax_get_history` and count the steps
        in `trail` with `kind: "grader"` and `to: "enrich-order"`: if there are
        already two, raise `enrichment-incorrect` instead.
    transitions:
      - to: enrichment-reported
        description: Every requested order has exactly one enrichment, and each matches its file.
      - to: enrich-order
        description: The enrichments are incomplete or do not match their files; send them back naming exactly what to fix.
```

The grader judges with its own state's tools: `read_file` comes from the
workflow-wide grant, so it reads each file the sub-runs returned itself rather
than trusting the `delayed` the agent recorded.

A grader state must declare non-empty `instructions`, which are its criteria. It
must also declare at least one transition: a grader decides by advancing, and one
with nowhere to send the session could only approve by saying nothing. Both are
`archmax validate` errors. `evidence`, `approvers` and `budget.maxParks` are
errors on a grader too, since it presents nothing to a person and cannot park.

### How a grader runs

On entry the runtime builds a grader for the state, with its own model, its own
prompt and its own messages:

- **Its system prompt** is a compiled-in preamble followed by the state's
  `instructions`. The preamble tells it what it is: the grader of one state, which
  talks to no one. It tells the grader to read the session with
  `archmax_get_history`, to decide with `archmax_advance` (whose reason is what the
  next state reads), or with `archmax_raise` when the work cannot be accepted and
  must not be retried, to make exactly one of those calls and then stop.
- **Its task message** names the grader state and lists its transitions, in the
  same line format the agent's graph section uses.
- **Its tools** are the grader state's surface. Each call is governed against the
  grader state. `${{…}}` references in its arguments resolve against the session's
  variables, as the agent's do. A refused or failed call comes back as an error
  answer, and the grader can carry on.

The grader's context is **isolated**. It reads the session only through its tools.
Its own messages never enter the session's transcript, its tokens never stream as
the session's text, and it writes nothing into the session's checkpoint. What it
decided reaches the session as a trail step and a runtime note.

The run ends the moment the grader decides, with no further model call. A grader
that finishes without deciding, such as one that answers in text alone, fails
closed.

### Counting rounds

There is **no iteration budget**. A send-back loop between an agent state and its
grader runs until the grader approves, raises, or the turn's recursion limit
stops it. A grader that should give up after N rounds says so in its
`instructions` and counts the rounds itself, from the trail that
`archmax_get_history` returns. Each earlier send-back is a step
`{ kind: "grader", to: "<the graded state>" }`. The example above raises once it
has sent the enrichments back twice.

A code state counts the same way, from the same trail. The reference workspace's
`check-refund` escalates after two send-backs:

```js
const { trail } = JSON.parse(await tools.archmax_get_history());
const sentBack = trail.filter((step) => step.kind === "code" && step.to === "refund-request").length;
```

### Budget and model

`budget.maxTurns` bounds the grader's own model calls, and `budget.timeoutMs` its
running time. Exhausting either fails the state. Neither counts the session
agent's calls, and the agent's calls never count against them.

`model` names the model id the grader runs on. It is resolved once per
composition under the **`grader` model role**, as
`modelFactory("grader", env, id)`, where `id` is the state's `model`, else the
workflow's `settings.model`. With no factory, the grader runs on the
env-configured model at that id, or on the workflow's model when neither position
declares one. An explicit `model` instance passed to `createAgent` outranks every
declared id here, as it does for the agent. See
[`modelFactory`](/reference/public-api/#modelfactory-pluggable-model-provider).

A grader's model calls are reported as `model-usage` events under the grader state,
and they are added to the session's usage.

## The history

`archmax_get_history` takes no arguments and is offered in grader and code states
only. It returns the session's **history** as JSON, `{ messages, trail }`
(`SessionHistory` in `@archmax-ai/harness/sandbox`): its whole transcript and its
whole trail, oldest first. A grader calls it as a tool; a code state's script
calls `tools.archmax_get_history()` and parses the answer. Both read the same
view, so a grader and a script counting the same rounds read the same thing.

What `review-enrichment` reads on its second round:

```jsonc
{
  "messages": [
    { "role": "user", "text": "Enrich the requested orders." },
    { "role": "assistant", "text": "", "toolCalls": [{ "id": "call_1", "name": "archmax_run", "args": { "file_path": "skills/order-enrichment/scripts/enrich-orders.js" } }] },
    { "role": "tool", "text": "[{\"order_id\":\"ORD-1002\",\"enrichment_file\":\"scratchpad/attachments/ORD-1002.json\",\"delayed\":false}, …]", "tool": "archmax_run", "id": "call_1" },
    // … the enrichments recorded, and the agent's archmax_advance into review-enrichment
    { "role": "runtime", "text": "[grader] The 'review-enrichment' grader moved the run to 'enrich-order': ORD-1003 has no entry in enrichments. …", "note": "grader" }
    // … the enrichments fixed, and the advance into review-enrichment again
  ],
  "trail": [
    { "to": "enrich-order", "kind": "trigger", "reason": "enrichment_requested", "ts": 1761300000000 },
    { "to": "enrich-order", "kind": "sub-workflow", "workflow": "enrich-order", "status": "ok", "ts": 1761300002480 },
    // … one sub-workflow step per enriched order
    { "to": "review-enrichment", "kind": "agent", "reason": "…", "ts": 1761300004120 },
    { "to": "enrich-order", "kind": "grader", "reason": "ORD-1003 has no entry in enrichments. …", "ts": 1761300009870 },
    { "to": "review-enrichment", "kind": "agent", "reason": "…", "ts": 1761300013450 }
  ]
}
```

Each message is `{ role, text, toolCalls?, tool?, id?, note? }` (`HistoryMessage`).
`role` is `user`, `assistant`, `tool`, `system` or `runtime`:

- An `assistant` message lists the calls it made in `toolCalls`, each
  `{ id?, name, args }`.
- A `tool` message carries the call's result inline, as its `text`, with the tool
  that answered (`tool`) and the id of the call it answers (`id`). The result is
  what the tool returned, as the agent saw it, so a check reads the result itself,
  never a copy the model made. A result too large for the transcript is the
  pointer to its file under `large_tool_results/`.
- A runtime note (an arrival, a decision, an error route, an automated state's
  move) is one `runtime` entry, and `note` names its kind.

Each trail step is a `TrailStep`, `{ to, kind, reason?, ts }`, plus `workflow` and
`status` on a sub-workflow step.

The transcript holds the calls of the session's agent, its control calls included.
The calls a code state's script or a grader makes are not in it: they are not
messages of the session, and only the move they decide reaches it, as a trail
step and a runtime note.

The history is read from the checkpointed session as it stood when the automated
state was entered, earlier turns included, not from the request a summary
shortened for the model. Nothing is windowed: a grader asked to give up after N
send-backs has to see all N. What bounds it is the grader model's context and, for
a script, the sandbox's `maxResultChars` and `memoryLimitBytes`.

## How a run settles

Every automated run settles as exactly one of four outcomes:

| Outcome | When | What follows |
| --- | --- | --- |
| **advanced** | It called `archmax_advance` and finished cleanly. | The session moves. The trail records a step of kind `grader` or `code` with the reason, and a runtime note carries the reason to the next state. Into a human state, the session parks after the one reply-only handoff message a park owes. |
| **raised** | It called `archmax_raise`. | The session ends `failed`, its outcome's `exit` carrying the code and reason. No `on_error` route is taken, the trigger's `returns` are not checked, and no further state runs in the turn. |
| **completed** | A terminal code state's script returned without raising. | The session completes, held to the trigger's [`returns`](/guides/triggers/#a-return-is-owed-when-the-session-finishes). |
| **failed** | It threw, timed out or exhausted its budget, or a non-terminal state finished without deciding. | The failure routes through the state's [`on_error`](/reference/machine-spec/#on_error), else the session ends rejected. |

A raise wins over a later error, and an error discards a recorded advance. A
non-terminal state that finishes undecided fails with the reason
`code state '<slug>' finished without calling archmax_advance or archmax_raise`
(or `grader state '<slug>' …`). Finishing undecided is never read as approval.

A session that **completed** in a terminal code state takes its next message at
the entry state of that turn's trigger. No agent stands in an automated state to
answer a follow-up, and running the script again would complete the turn without
answering it. A session that failed or was rejected in an automated state starts
its next turn there instead, and the state runs again.

## What the session reads

The agent standing in the next state learns why it was entered from a runtime
note:

```text
[grader] The 'review-enrichment' grader moved the run to 'enrich-order': ORD-1003 has no entry in enrichments; record every order the script returned. You are now in 'enrich-order'.
[code] 'check-refund' moved the run to 'refund-review': "denied" matches the refund policy. You are now in 'refund-review'.
```

A raise leaves one too:
`[code] 'check-refund' ended the session as failed ('<code>'): <reason>`. The note
kinds are `grader` and `code` (see
[`runtimeNoteKind`](/reference/public-api/#reading-a-transcript)).

From the state before, the agent sees only the transition line, marked with the
target's type:

```text
- to `review-enrichment` (grader) — Every order has been enriched and `enrichments` is recorded.
```

So an edge **into** a grader or a code state must carry a `description`. An
undescribed edge routes on its target's instructions, which the agent is then
shown, but a grader's instructions are its criteria, never shown to the work it
judges, and a code state has none. The schema refuses an undescribed edge into
either, naming `states.<slug>.transitions.<index>.description`. A code state's
**own** edges may go undescribed: its script routes on them, and no model reads
them.

No part of a grader's `instructions`, `model` or `budget`, and no part of a code
state's script, reaches any prompt of the session's agent. The platform prompt
tells the agent that grader and code states run on their own and may send the
work back with a note saying what to change, and that it should then fix the
work and advance again.

### The turn's reply

A turn's [`reply`](/reference/public-api/#agent-in-detail) is every text the
agent wrote during the turn, in order, joined by a blank line, and `""` when it
said nothing. An automated state changes nothing about that: a draft the agent
wrote before a grader or a code state sent it back stays in the reply, beside
the corrected one. A grader's own text never enters the transcript, so it is
never part of a reply.

So put a send-back loop where the work is handed on and no person is waiting on
the turn's text, such as a triggered enrichment, rather than in front of a live
answer.

## Events

Each run is bracketed on the [event stream](/reference/public-api/#lifecycle-event-stream):

| Event | Payload |
| --- | --- |
| `code-start` | `{ state, script }` |
| `code-output` | `{ state, line }`, one per console line |
| `code-result` | `{ state, status, durationMs, reason? }` |
| `grader-start` | `{ state }` |
| `grader-result` | `{ state, status, durationMs, reason? }` |

`status` is `ok` when the run settled on a decision or a completion, and `error`
when it failed, with `reason` saying why. Every tool call inside the run emits
the paired `tool-called`/`tool-result` events: a code state's carry
`origin: "script"`, and a grader's carry no origin, as a model's call does. A
move then emits `advance`, `state-leave` and `state-enter`. A raise emits
`raised` and `state-leave`.

For a code state that logs one line and advances, the stream holds `code-start`,
then the advance call's `tool-called` and `tool-result`, then the `code-output`
line (console lines are reported once the script settles), then `code-result`,
`advance`, `state-leave` and `state-enter`. The
narrative events come after the run has settled, so nothing announces a move that
a later error discarded.

The CLI's [state flow](/guides/cli/#the-state-flow) prints a code state's run as
`› code scripts/check-refund.js` with its output beneath it, and a grader's as
`› grader grading`. A failed run adds a line naming the reason.

## Patterns

### A check in front of a state

To screen every request before any model call, make the trigger's entry state a
code state that advances to where the work starts, or somewhere that declines it:

```yaml
states:
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
  decline:
    instructions: >-
      The request was declined before any order was looked up; the note above
      says why. Tell the person, in one or two sentences, using that reason.
```

The `decline` agent state reads the script's reason from the `code` note and
tells the person. To end the session as a failure instead, with no reply,
`tools.archmax_raise({ code, reason })`.

### A check behind a state

To check the agent's work before the session moves on, route the agent's
transition into a code state, and give that state an edge onward and an edge
back. `check-refund` above sits between `refund-request` and the human
`refund-review`, so a decision the policy forbids never reaches the reviewer. The
agent reads the send-back reason as a note and fixes the work.

### Approve, then end

A grader that approves into a terminal agent state costs one more model call:
that state's agent has to finish. The reference workspace's `enrichment-reported`
does, because its summary is the point. When nothing more needs saying, approve
into a **terminal code state** instead. Its script runs and the session completes,
with no further model call:

```yaml
  enrichments-filed:
    type: code
    script: scripts/enrichments-filed.js
```

```js
/**
 * Enrichment filing.
 *
 * Writes the approved `enrichments` to scratchpad/enrichments.json, with the
 * number of rounds the review took, then returns: the session completes.
 */
import { defineCodeState } from "@archmax-ai/harness/sandbox";

export default defineCodeState(async ({ variables, tools }) => {
  const { trail } = JSON.parse(await tools.archmax_get_history());
  const rounds = trail.filter((step) => step.to === "review-enrichment").length;
  await tools.write_file({
    file_path: "scratchpad/enrichments.json",
    content: JSON.stringify({ enrichments: variables.enrichments, rounds }),
  });
});
```

### A send-back loop that gives up

Put a grader behind the state it grades, with an edge back to it. The grader's
`instructions` say how many rounds to allow and to raise after that, counting the
trail. `review-enrichment` above approves to `enrichment-reported`, sends the
enrichments back to `enrich-order` with the correction, and raises
`enrichment-incorrect` once it has sent them back twice. The graded state's
`instructions` tell the agent to advance to the grader once the work is recorded,
and to fix what the note names when it is sent back. Every draft the agent writes
stays in the turn's [reply](#the-turns-reply), so the loop suits work no person is
waiting on.

## Testing automated states

A case asserts an automated state by what it committed: `reachedState`, a `trail`
step with `kind: code` or `kind: grader` and its `reason`, `raised` for its raise,
`variables` for what it set, `ranWorkflow` for its dispatches. A code state's and a
grader's own tool calls are not in the transcript, so `calledTool`,
`notCalledTool` and `usedNoTools` see only the agent's. A `grade` scores the
action's turn reply. Mocks answer their calls as they answer the agent's, and a
control tool is never mocked: an automated state's `archmax_advance` and
`archmax_get_history` are always the runtime's. See
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
