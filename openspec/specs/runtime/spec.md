# runtime Specification

## Purpose

Define how the archmax harness executes a workflow: one Deep Agents graph whose checkpointed state carries the
machine's position, variables, trail and park records, governed by middleware. This spec covers the
turn boundary, the control tools (`archmax_advance`, `archmax_reset`, `archmax_wait`), budgets and
`on_error` routing, human states and parks, the handoff message, `before`/`after` hooks and their
verdicts, runtime notes, the layered system prompt and its caching, and the typed event stream.

## Requirements

### Requirement: One graph carries the machine

A workflow SHALL execute as exactly one `createDeepAgent` graph whose checkpointed state carries the
machine's channels beside `messages`: `workflowState`, `entryState`, `trigger`, `status`,
`specHash`, `variables`, `auditTrail`, `usage`, the bookkeeping `iterations` and `beforeDone`,
the per-state counters `stateTurns` and `parkCounts`, and the park records `pendingDecision`,
`pendingInput`, `pendingDelegations`, `parkPhase` and `replyOnly`, declared once in
`src/workflow/state.ts`. Governance middleware SHALL be the only writer; a control tool commits its
change through a `Command` when it succeeds, so the checkpoint is the single source of truth with no
in-memory mirror. The accumulating channels (`auditTrail`, `variables`, `pendingDelegations`) SHALL
have reducers idempotent on an echo: a hook returning the state it read changes nothing.

#### Scenario: Advance commits to the checkpoint

- **WHEN** the agent successfully calls `archmax_advance`
- **THEN** the checkpointed `workflowState` is the new state as soon as the call settles

#### Scenario: Hook echo is a no-op

- **WHEN** a hook returns the whole state it read, including the trail it already held
- **THEN** the trail is unchanged and no locked variable is rewritten

### Requirement: The turn boundary opens every turn

The middleware's `beforeAgent` hook SHALL be the turn boundary, run once per invoke and never on a
park resumption (which re-enters at its interrupt through a `Command`). It SHALL resolve the trigger
(the invoke's, else the assembly default, else `manual`) and the position: a first turn opens at the
start state that trigger declares; a later turn continues at the retained position; a retained
position the spec no longer declares reopens at the trigger's start state. It SHALL record
`entryState` once. Every turn SHALL emit `advance` from the session origin to the opening state, then
`state-enter`, and append a `trigger` trail step; `workflow-reset` SHALL be emitted only when a turn
opens at a start state. No transcript message SHALL announce a turn. The boundary SHALL reset the
turn's mechanics only — `rejected`, `iterations`, `beforeDone`, `parkCounts`, `stateTurns`,
every park record and phase, `replyOnly`, status to `running` — and retain the conversation:
position, `entryState`, variables, transcript, trail, usage and files. A session in a terminal state
SHALL continue there under that state's governance; `archmax_reset` is the way out.

It SHALL seed the host's `variables`, a parent's sub-workflow params and the reserved `trigger`,
locked and marked as a host seeding boundary so they replace a locked value of the same name; a
seeded `title` SHALL lose to one the session holds, and a seeded title emits `title-set` with no
`state` or `callId`. When the session's recorded spec hash differs from the current one, the full
spec SHALL be persisted under `_specs/<hash>` before any model call.

#### Scenario: First turn enters the trigger's start state

- **WHEN** a session with no prior position is invoked with trigger `manual`
- **THEN** the position is the state `manual` enters, and `workflow-reset`, `advance` and
  `state-enter` are emitted

#### Scenario: Later turn continues in place

- **WHEN** a session's previous turn finished in `orders-question` and a new turn begins
- **THEN** the turn opens in `orders-question`, emits `advance` naming it and no `workflow-reset`,
  and no turn-boundary message is appended

#### Scenario: Dropped position reopens at the start state

- **WHEN** the retained position is a state the current spec no longer declares
- **THEN** the turn opens at the trigger's start state, emits `workflow-reset`, and commits that state

### Requirement: A turn the machine cannot serve is refused at the boundary

The turn boundary SHALL refuse a turn when the machine is `disabled`, or when the trigger's
`requires` names are not all supplied by the opening variables. A refusal SHALL commit
`status: rejected` with a reason naming the workflow (or the trigger and the missing names), emit a
`warning` event with that reason, and end the turn before any state is entered, hook runs or model is
called; it SHALL NOT throw. A decision, reply or delivery SHALL NOT pass through this gate, so
disabling a workflow never traps its parked sessions.

#### Scenario: A disabled workflow is refused

- **WHEN** a host invokes a disabled workflow
- **THEN** the outcome is `rejected` naming the workflow as disabled, and no model call is made

#### Scenario: Unmet requires is refused

- **WHEN** a firing on trigger `enrich` supplies no `order_id`, which `enrich` requires
- **THEN** the turn is refused with a reason naming `enrich` and `'order_id'`

#### Scenario: A parked decision still resolves on a disabled workflow

- **WHEN** a workflow is disabled while a session is parked at a human state
- **THEN** deciding that session resumes and completes normally

### Requirement: Governance middleware sites

The workflow middleware SHALL govern the graph at fixed sites: `wrapModelCall` discloses only the
active state's tool surface in registration order, composes the system message as a static block
plus the volatile block, and runs the state's `before` hook; `wrapToolCall` resolves the called name,
substitutes `${{name}}` references, applies the kernel's verdict to every call, and services the
control and delegation tools itself; `afterModel` reports text and usage, routes budget exhaustion
and committed rejections through `on_error`, runs a terminal state's `after` hook and settles the
turn's status. A blocked call SHALL be answered with an error-status tool message and a
`tool-blocked` event, never thrown; a terminal kernel verdict (an unevaluable guard) SHALL be
committed as `rejected` so the run routes through `on_error` once the model finishes.

#### Scenario: A tool outside the state's surface is refused

- **WHEN** the model calls a tool the active state does not allow
- **THEN** the call is answered with an error-status message naming the allowed surface, a
  `tool-blocked` event is emitted, and the run stays in place

### Requirement: `archmax_advance` is the only way to move

The runtime SHALL expose `archmax_advance({ to, reason, evidence? })`, rejecting an empty `reason`,
and on a call SHALL in order: check the leaving state's `requires`; validate the edge against the
declared transitions; run the leaving state's `after` hooks (with `from`, `to` and `reason` in their
input); run the target's `before` hooks; then commit the position, the target's entry gate as done
(`beforeDone`, so its first model call does not run the `before` hooks again), an `agent` trail step
with the reason, and a tool message saying the target's tools are now usable. A refusal SHALL answer
`archmax_advance rejected: <reason>` — listing the valid target slugs for an undeclared edge — and
leave the position unchanged; correction counts SHALL be committed either way. A terminal rejection
(hook error, exhausted corrections) SHALL be committed as `rejected`; a recoverable one (invalid edge,
veto, in-budget correction) leaves the agent to retry. The `to` parameter SHALL be described as a slug.

#### Scenario: Valid transition

- **WHEN** the agent calls `archmax_advance` with a declared target and a reason, and every hook passes
- **THEN** the position becomes the target, the trail records an `agent` step with the reason, and
  `advance`, `state-leave` and `state-enter` are emitted

#### Scenario: Requires gate precedes the hooks

- **WHEN** the current state declares `requires: [order_id]` and `order_id` is unset
- **THEN** the advance is refused naming `order_id` and `archmax_set_variables`, and no `after` hook runs

#### Scenario: One transition per model step

- **WHEN** one assistant message carries two `archmax_advance` calls
- **THEN** the first is serviced and the rest are refused naming the state it landed in, so the
  leaving state's `after` hooks run once and one position is committed

#### Scenario: A refused attempt leaves the step open

- **WHEN** one assistant message calls `archmax_advance` on an undeclared target and then on a
  declared one
- **THEN** the first is refused and the second moves the session: only a transition that landed
  claims the step

### Requirement: Evidence attached to a transition

`archmax_advance` SHALL accept an optional `evidence` list of workspace-relative paths only when `to`
is a human state; on another target a non-empty list SHALL be refused recoverably before any hook
runs. Each path SHALL be classified through the kernel's zone table with the assembly's mounts:
readable paths (scratchpad, other session paths, read-only mounts, offload areas) are accepted; one
that escapes the workspace, addresses a runtime-internal area or is empty after canonicalization is
refused naming it; more than 20 paths SHALL be refused. Accepted paths SHALL be stored canonically,
de-duplicated, and carried into the park record after the state's declared `evidence`.

#### Scenario: Evidence into a human state

- **WHEN** the agent advances into `refund-review` with `evidence: [scratchpad/refund.json]` and the
  state declares `evidence: [scratchpad/policy.md]`
- **THEN** the park record's evidence is `[scratchpad/policy.md, scratchpad/refund.json]`

### Requirement: `archmax_reset` returns the session to its entry state

The runtime SHALL expose `archmax_reset({ reason })` in every state, requiring a non-empty `reason`.
It SHALL move the position to the recorded `entryState` (else the trigger's start state), clear
`iterations`, `beforeDone`, `rejected` and `stateTurns`, append a `reset` trail step with the
reason, and re-enter through the entry state's `before` hook. It SHALL NOT touch messages, variables
(locked seeds included), files or the recorded trail. `tools.forbid_always` MAY ban it.

#### Scenario: Entry state is stable across deliveries

- **WHEN** a session started by `email_received` was resumed by a delivery of `email_reply` and resets
- **THEN** it returns to the `email_received` start state with its transcript and scratchpad untouched

### Requirement: `archmax_wait` parks the session in place

The runtime SHALL expose `archmax_wait({ reason, until? })` in every state, terminal states included,
rejecting an empty `reason`. A wait SHALL commit a `pendingInput` record (state, `title` when
declared, reason, `parkedAt`, `resumeAt` when declared), set `status: awaiting_input`, increment the
state's park count, emit `parked` with `awaiting: "input"`, the reason and the call's `callId`, and
tell the model to stop; the position SHALL be unchanged and no transition committed. `until` SHALL
be a relative duration (`<integer><ms|s|m|h|d>`) or an ISO-8601 instant, normalized to an absolute
`resumeAt` on the runtime's clock; an unparseable `until` SHALL reject the call naming the accepted
forms without parking. `resumeAt` SHALL be a hint for whoever schedules: the runtime holds no timer
and an earlier delivery resumes the park just the same.

#### Scenario: Wait parks the current state

- **WHEN** the agent in `clarify` calls `archmax_wait({ reason: "waiting for an order id", until: "1d" })`
- **THEN** the session parks with `clarify` as its position, no transition is recorded, and the
  record and `parked` event carry a `resumeAt` one day after `parkedAt`

#### Scenario: Unparseable due time refuses the park

- **WHEN** the agent passes `until: "tomorrow morning"`
- **THEN** the call is rejected naming the accepted forms and the session does not park

### Requirement: Budgets

A state's `budget.maxTurns` SHALL be an exact count of model calls made in the state since it was
entered: the call that would exceed it is not made and the exhaustion is routed as a failure; the
count resets on every transition and at each turn boundary. `budget.timeoutMs` SHALL race the
state's model call against a timer; on expiry the runtime substitutes a budget-exhausted result,
removes it from the transcript and routes the failure through `on_error`, without aborting the
in-flight request. `budget.maxParks` SHALL cap `archmax_wait` parks per state within a turn, checked
before the park is committed; an exceeded bound refuses the wait and commits `rejected` naming the
state and the bound. A delegated child's park SHALL NOT count. Every exhaustion SHALL route through
`on_error` when declared, else end the turn rejected.

#### Scenario: Turn budget is exact

- **WHEN** a state declares `maxTurns: 8` and the agent advances on its fifth model call
- **THEN** the state completes normally

#### Scenario: Timeout substitutes a result

- **WHEN** a model call in a state with `timeoutMs: 1000` has not returned after one second
- **THEN** the failure is routed through `on_error` and the request itself is not aborted

### Requirement: `on_error` routing

A failed state SHALL route to its declared `on_error` target — failure being an exhausted budget, a
timed-out model call, a hook execution error, exhausted corrections, a terminal kernel block or a
rejected sub-run. Routing SHALL append an `[error]` runtime note marked `error`, commit the new
position and an `on_error` trail step, clear every park record, emit `state-error-routed`,
`state-leave` and `state-enter`, and continue to the model. A rejection a tool committed SHALL be
routed once the model has finished in the failing state. A human `on_error` target SHALL be presented
at once, owing a closing message. Without `on_error`, the turn SHALL end `rejected` with the reason.

#### Scenario: Hook error routes to the error state

- **WHEN** a state declares `on_error: escalate` and its `after` hook throws
- **THEN** the run routes to `escalate` with an `[error]` runtime note naming the failure

### Requirement: Terminal states and the terminal after hook

A state with no transitions SHALL be terminal: `archmax_advance` is not disclosed there, and the turn
completes with `status: completed` and a `state-leave` event when the model finishes without tool
calls and the session is not parked. A terminal state's `after` hooks SHALL run at that completion:
`ok` completes; `correct` or `veto` appends an `[after]` runtime note asking for a revision and
returns to the model; a terminal failure routes through `on_error`. A completing session whose
trigger declares `returns` SHALL instead be rejected when any declared return is unset, naming them.

#### Scenario: Terminal after hook asks for a revision

- **WHEN** the agent finishes in a terminal state whose `after` hook returns `correct` within budget
- **THEN** an `[after]` runtime note is appended and the model is called again in the same state

### Requirement: Human states park for a decision

A state declaring `type: human` SHALL be a human state. On entry — by `archmax_advance`, a decision,
`on_error`, or a turn opening on a session already parked there — the runtime SHALL build the
pending-decision record deterministically, with no model call, from the slug, the `title` when
declared, the transitions with `type`/`description`, the declared `evidence` merged with attached
evidence, a 1-based `seq` and `createdAt`; commit it as `pendingDecision` with
`status: awaiting_decision`; and emit `parked` with `awaiting: "decision"` and no `callId`. Nothing
SHALL be rendered to a file: the record is the presentation, and a surface reads the state's
`instructions` from the spec on demand. The record's `state` is the routing identity.

#### Scenario: Pending decision committed on entry

- **WHEN** a session advances into `refund-review`
- **THEN** the checkpoint holds a `pendingDecision` with `state: refund-review`, its transitions and
  evidence, status is `awaiting_decision`, and no file is written

### Requirement: A person picks the edge

`decide(sessionId, { target, comment? })` SHALL validate before the graph is touched: the session
must be parked `awaiting_decision` with a live interrupt (`SessionNotParkedError`), and `target` must
be one of the record's transitions other than the parked state (`InvalidDecisionTargetError`,
listing the valid targets); a rejected decision leaves the session parked unchanged. A human state's
transitions MAY declare `type: approve | reject | refine | none` (default `none`), at most one of
each labeled type. On a valid decision the runtime SHALL route deterministically — no model selects
the edge — appending a `human` trail step with the comment and a `[decision]` runtime note naming the
edge, the comment and the new position, and emitting `decided`, `state-leave` and `state-enter`.
Correction counters SHALL be carried across unchanged. A decision into another human state SHALL
present it at once and owe a closing message.

#### Scenario: Invalid target is rejected

- **WHEN** a decision names a target that is not one of the record's transitions
- **THEN** `InvalidDecisionTargetError` lists the valid targets and the session stays parked

### Requirement: Parks are LangGraph interrupts on one mechanism

A park SHALL suspend the session through `interrupt(record)` from the `WorkflowParkMiddleware`, the
one middleware that suspends, positioned so every other hook has committed and emitted first. A park
SHALL progress through `parkPhase` `closing` (a message is owed) to `suspend`, suspending only once
nothing is owed and no tool calls dangle. Both channels — a human state awaiting a `decision` and
`archmax_wait` awaiting `input` — SHALL use this one mechanism and one resume path
(`src/sessions/resume.ts`), differ only in what resolves them and where the run continues, classify
as open, survive process exit, and keep the statuses `awaiting_decision` and `awaiting_input`
distinct. A resume on the wrong channel SHALL be refused with a typed error naming the other.

#### Scenario: Park survives restart

- **WHEN** a session parks, the process exits, and a new process assembles the agent over the same
  workspace and session store
- **THEN** a resume continues the session with position, variables, trail and usage intact

### Requirement: `deliver` resumes the parked state in place

`deliver(sessionId, { trigger: { id }, variables?, message? })` SHALL validate before the graph is touched:
parked `awaiting_input` (`SessionNotAwaitingInputError`), a non-empty trigger id
(`MissingDeliveryTriggerError`), valid variable names (`InvalidVariableNameError`); any trigger id is
accepted. A delivery SHALL NOT select an edge: it clears `pendingInput`, records the delivered id as
the current trigger (checkpoint and `trigger` variable), seeds the variables as locked host seeds
replacing a locked value of the same name (`title` excepted: never locked, skipped with a warning
when malformed), appends a `trigger` trail step, emits `delivered` and — when variables were seeded —
`variables-set` and `title-set`, appends an `[event]` runtime note naming the trigger and its values,
and continues the parked state. `entryState` SHALL NOT change. A non-blank `message` SHALL be
appended as the person's own human message directly after the note, in the same update as the
arrival — emitting `park-message` inbound — so it can neither land on a session whose park is gone
(the delivery is refused first) nor be separated from the arrival by a crash between two writes. A
resume payload carrying a `trigger` SHALL be read as a delivery whether or not it carries a message;
only a payload with a message and no trigger is a reply.

#### Scenario: Delivery re-runs the parked state

- **WHEN** a session parked in `clarify` is delivered `{ trigger: { id: "email_reply" },
  variables: { reply_body: "It's ORD-1001." } }`
- **THEN** `pendingInput` is cleared, the position is still `clarify`, the transcript carries an
  `[event]` runtime note naming `email_reply` and `reply_body`, and a hook reads
  `trigger === "email_reply"` and `variables.reply_body`

#### Scenario: The person's message travels with the firing

- **WHEN** the same session is delivered `{ trigger: { id: "email_reply" }, message: "It's ORD-1001." }`
- **THEN** the transcript carries the `[event]` note and then a human message `It's ORD-1001.` that is
  not a runtime note, `park-message` inbound is emitted, and the resumed state answers it

### Requirement: A delegated child's park parks the caller

When a sub-workflow a state called parks, the runtime SHALL record a pending delegation (calling
state, tool call id, workflow slug, identity, dispatch id and the child's decision record) from the
tool seam, answer the model that the child stopped for a person, let sibling calls settle, and before
the next model call present the child's decision as the session's `pendingDecision` with
`status: awaiting_decision`, owing a closing message. The calling state SHALL remain the position. A
decision SHALL be handed to that child only; its result reaches the caller as a
`[sub-workflow: <slug>]` runtime note and a `sub-workflow` trail step. Several parked children SHALL
be presented one at a time. The `Outcome` (and every resume outcome) of such a park SHALL carry
`delegation` — the head of the pending-delegation queue as a `DelegatedPark`: `workflow`, the
child's `sessionId` (`<parent>~<identity>`), `identity`, `dispatchId`, `toolCallId` and the calling
`state` — and SHALL carry none once the child has been decided.

#### Scenario: The caller parks on the child's decision

- **WHEN** a sub-workflow reaches a human state
- **THEN** the calling session parks presenting the child's state and transitions, and no sibling
  call in the batch is re-executed on resume

### Requirement: The handoff message

A parked session SHALL speak before it suspends: the runtime spends exactly one reply-only model
call — no tools bound, text the only product — when a session parks by `archmax_advance` into a
human state (always), by `archmax_wait` (only when the agent has said nothing since the last message
that opened a turn), when a decision or `on_error` routes it into another human state, when a
delegated child's decision is presented, and when a person replies to a parked session. The reply
SHALL be composed by the model from the transcript and a runtime directive, never a fixed string or
an authored notice; a human state's `instructions` SHALL be withheld from it. The turn SHALL be one
model call: no text leaves the park unchanged without a retry, and a tool call the model invents is
refused by the kernel's reply-only rule. That reply SHALL be the park's `reply` on every surface.

The directive SHALL head the volatile block `## This run is parked` and open with one of four
shapes chosen structurally from the state: answering a person's message while a decision is pending
(the model cannot make, predict or announce it); waiting for something from outside (`pendingInput`,
naming the reason); having been routed to a human state by a runtime note; or having just handed the
run to a person. Each SHALL end with the same instruction — one short message, no tools, the run
stays parked until someone else acts — and SHALL label the state by slug and title.

#### Scenario: Silent handoff into a human state speaks

- **WHEN** the agent records a refund with tool calls only and advances into `refund-review`
- **THEN** one reply-only call runs before the session suspends and its text is the outcome's `reply`

#### Scenario: A wait that already spoke spends no extra call

- **WHEN** the agent asks for an order id and then calls `archmax_wait`
- **THEN** no reply-only call runs and the park's `reply` is the question already asked

#### Scenario: A runtime note opens the silence window

- **WHEN** a delivered firing resumes a run and it calls `archmax_wait` without writing text after
  the arrival
- **THEN** one reply-only call runs, because the arrival note opened a turn

#### Scenario: Answering while a person decides

- **WHEN** the last transcript message is a person's message on a session parked at a human state
- **THEN** the directive says a person is deciding and the model cannot make, predict or announce
  that decision

### Requirement: A parked session takes a message and re-parks unchanged

`reply(sessionId, message)` (the SDK method behind `archmax reply`) SHALL validate that the session is
parked `awaiting_decision` (`SessionNotParkedError`) and the message non-empty (`EmptyMessageError`)
before the graph is touched. It SHALL append the message as a plain human message, emit
`park-message` inbound, run one reply-only call, emit `park-message` outbound with the reply, and
suspend again on the same `pendingDecision` — same `state`, `seq`, `createdAt`, transitions and
evidence — with the trail untouched and status still `awaiting_decision`. The outcome SHALL report
`reparked: true`, `parkedChannel: "decision"`, the state, the reply, messages and trail. The runtime
SHALL impose no limit on messages, and a message SHALL never be read as a decision.

#### Scenario: A message never routes

- **WHEN** a person messages a session parked at `refund-review` with "yes, approve it"
- **THEN** one reply-only call answers it, no edge is selected, and the session is parked again at
  `refund-review` with its record unchanged

### Requirement: Hook declaration shape

A `before` or `after` hook SHALL be a tagged object — `{ script: <path> }`,
`{ rubric: <declaration> }` (the grader itself, inline), or `{ <kind>: <value> }` for a kind
registered through `hookExecutors` — or an ordered list of them, run in declaration order.
The only sidecar SHALL be `max_iterations`, accepted beside a `script` or custom kind and refused
beside a `rubric` (whose budget is inside its declaration): kind detection ignores the sidecar, zero
or two kind keys is malformed (validation error, veto at runtime), and any other key is a schema
error naming it. A
`script` path SHALL be relative to the workflow directory and resolve under `hooks/`; an absolute or
escaping path is refused at load and vetoes at runtime. Registering an executor under a built-in
kind (`script`, `rubric`) SHALL fail assembly; a kind with no executor SHALL veto naming the kind.

`{ subagent: <name> }` SHALL be an unregistered kind, and `max_corrections` an unrecognized key. No
diagnostic SHALL special-case either: a retired key is reported with its path like any other
unrecognized key, and the upgrade is documented rather than suggested in the error.

#### Scenario: Script hook resolved under hooks/

- **WHEN** a state declares `after: { script: hooks/check-refund.js }`
- **THEN** the runtime reads `workflows/<slug>/hooks/check-refund.js` from the authoring backend

#### Scenario: Path outside hooks/ refused

- **WHEN** a hook declares `{ script: skills/refund-policy/scripts/check.js }` or `{ script: ../x.js }`
- **THEN** loading reports the required `hooks/` location and the hook vetoes at runtime

#### Scenario: A retired key is an ordinary schema error

- **WHEN** a hook declares `{ subagent: reviewer }` or carries `max_corrections`
- **THEN** loading fails with the standard unregistered-kind or unrecognized-key diagnostic naming
  the key and its path, with no mapping to a replacement

### Requirement: The hook function contract

A script hook SHALL be a JavaScript module whose default export is a function receiving one object:
`state`, `phase`, `trigger` (the id), `variables` (a read-only name-to-value map), `messages` (the
recent transcript as plain data, runtime notes as `role: "runtime"`), `tools` (the privileged
tool-call bridge), and on an advance `from`, `to`, `reason`. It SHALL return `ok()`, `veto(reason)`,
`correct(reason)` or nothing (ok); throwing SHALL veto. A bare `false` and an `{ ok: false }` object
SHALL NOT be read as verdicts — a hook returns the verdict vocabulary or it has returned no verdict.
`import { ok, veto, correct,
defineHook } from "@archmax-ai/harness/sandbox"` SHALL be stripped in the sandbox and buy types only. Hooks
SHALL run in the same QuickJS sandbox as the sandbox tools, on runtime authority: the active state's
own governance does not bind their `tools.*` calls — neither its allow lists nor its `forbid` lists,
since a hook sits outside that surface in both directions — but the safety rules, the workflow's
`tools.forbid_always` and `skills.forbid_always`, and consumer rules do, and
each call emits tool telemetry with `origin: "lifecycle"`. `task()` SHALL be available to hook
scripts and never to `archmax_eval`/`archmax_run`.

#### Scenario: Hook reads the transcript and vetoes

- **WHEN** a hook reads `scratchpad/refund.json` through `tools.readFile` and returns `veto(reason)`
- **THEN** the phase is rejected with that reason

#### Scenario: Throwing vetoes

- **WHEN** a hook throws
- **THEN** the phase is vetoed with the error as the reason, and the failure is terminal

#### Scenario: A legacy return shape is no verdict

- **WHEN** a hook returns `false` or `{ ok: false, reason }`
- **THEN** the value parses to no verdict and the phase vetoes fail-closed with a snippet of it,
  rather than being read as a veto

#### Scenario: A workflow denial binds a hook, a state's does not

- **WHEN** the active state declares `tools: { forbid: [read_file] }`, the root declares
  `tools: { forbid_always: [write_file] }`, and a hook calls both
- **THEN** the `read_file` call runs and the `write_file` call throws a governance error naming the
  workflow-wide denial

### Requirement: Hook sequencing and phases

Hooks in a list SHALL run in declaration order and short-circuit on the first non-`ok` verdict. A
`before` hook SHALL gate entry and run exactly once per entry: on the `archmax_advance` into the state
(a veto refuses the advance; the commit records the gate as done), or — for an entry no advance made:
a turn opening in the state, an `on_error` route, a human decision — before the state's first model
call of that turn (a veto answers the request with the rejection instead of calling the model). It is
not re-run before later model calls in that state within the turn (`beforeDone`). Its vocabulary SHALL be `ok`/`veto`: `correct` from a `before` hook
is a veto whose reason says before hooks cannot request corrections, consuming no budget. An `after`
hook SHALL run when the state is left by `archmax_advance`, before the transition commits, and at
completion of a terminal state.

#### Scenario: Entered by advance, the gate runs once

- **WHEN** the model advances into a state with a `before` hook and then makes its first model call there
- **THEN** the hook ran once, at the advance, and a later turn opening in that state runs it once more

#### Scenario: First veto short-circuits

- **WHEN** the first hook in an `after` list vetoes
- **THEN** the remaining hooks do not run and the transition is refused with that reason

#### Scenario: Before correct is a veto

- **WHEN** a `before` hook returns `correct`
- **THEN** entry is vetoed with a reason saying before hooks cannot request corrections, and the
  state's iteration budget is untouched

### Requirement: Corrections

An `after` hook's `correct` verdict SHALL reject the transition with guidance and let the agent
retry, bounded by `max_iterations` — a rubric's own declared value, a script or custom hook's
sidecar, else 0 — identically for every hook kind. Counts SHALL live in checkpointed
`iterations` per state, committed on success and refusal alike, cleared by a passing phase, a
reset and the turn boundary, and untouched by a human decision. A `correct` at the bound SHALL be a
terminal rejection, committed `rejected` and routed through `on_error`.

Counts SHALL be keyed **per hook by position** (state, phase, index), so two rubrics in one phase
have independent budgets and a passing sibling cannot clear the count of one still asking for
corrections. The verdict keeps its name (`correct`); what the budget counts is iterations of the
grade-and-retry loop.

#### Scenario: Corrections exhausted

- **WHEN** `correct` is returned with the budget used up
- **THEN** the rejection is terminal and the run routes through `on_error` or ends rejected

#### Scenario: Two graders on one state keep separate budgets

- **WHEN** a state's `after` list declares two rubrics and one consumes an iteration
- **THEN** the other's budget is untouched, and neither can clear the other's count

### Requirement: Hooks fail closed

A hook that errors SHALL veto with the error as the reason, and the failure SHALL be terminal — a
thrown exception, a script that cannot execute, a missing script, an unresolvable path, an
unregistered kind. A rubric hook SHALL be dispatched with the verdict response format — always — and on the model its
`model` names; output that parses to no verdict SHALL veto
with a snippet of it,
never coerce to `ok`; a dispatch that cannot be made — including a model id the host cannot serve —
SHALL error. Hook sources SHALL be read through the
authoring backend, and events and agent-visible messages SHALL carry a hook's verdict and reason,
never its source.

#### Scenario: Unparseable rubric output fails closed

- **WHEN** a rubric hook returns text that is not a verdict
- **THEN** the transition is vetoed with a reason that includes a snippet of that text

#### Scenario: An unusable model id fails closed

- **WHEN** a rubric declares a `model` the host cannot serve and its hook runs
- **THEN** the dispatch errors and the transition is vetoed, rather than being graded by a fallback model

### Requirement: Runtime notes are marked tool pairs

A message the runtime writes on its own behalf SHALL be a runtime note: an assistant message
carrying one `archmax_note` tool call with no text, answered in the same append by a tool message
holding the note, both marked on `additional_kwargs.archmax.note` with the kind — `decision`, `event`,
`error`, `after`, `sub-workflow` or `opening`. `archmax_note` SHALL be registered as no tool and
callable by nothing. A note SHALL never be a human message or a mid-thread system message; the
`[kind]` prefix is readability only. One constructor (`runtimeNote`) SHALL build every note. A
sub-workflow's opening line SHALL stay a human-role message marked `opening`; a person's message to
a parked session SHALL stay a plain human message with no marker. `opensTurn` SHALL treat a
human-role message and a runtime note alike as something the run was told, so the silence window and
a reply-only turn's spend are decided per message across transcripts mixing both shapes. Derived
views SHALL exclude notes from the tool calls a run made and from the reply it ended on.
`isRuntimeNote`, `runtimeNoteKind` and `RuntimeNoteKind` SHALL be exported from the package root.

#### Scenario: A decision reaches the target as a runtime note

- **WHEN** a person selects an edge and the run routes
- **THEN** the target's transcript carries an `archmax_note` pair marked `decision`, and no human-role
  message was appended for it

#### Scenario: Authorship is readable without content

- **WHEN** a host calls `runtimeNoteKind` on an arrival note
- **THEN** it returns `event`, and a workflow instruction whose text contains `[event]` returns `null`

### Requirement: The system prompt is layered

The model SHALL read the system prompt in this order: `AGENTS.md`; the consumer `systemPrompt`; the
platform prompt (compiled into the runtime, or `.platform/system/GRAPH_STATE.md` when the workspace
serves it; absent for a plain agent); the workspace zones section; the workflow graph
section; `WORKFLOW.md` with HTML comments stripped; Deep Agents' tool guidance; and the volatile
"Current state" block. Deep Agents' base prompt SHALL be dropped (`systemPrompt: { prefix, base:
null }`). Layers one to six SHALL form the static prefix, identical on every model call of a session.
The workspace zones section SHALL be rendered from the resolved `MountPrefixes`: `scratchpad/` as
the always-writable working area, the offload areas as readable only, then **one line per ungoverned
mount — its name as the agent addresses it (a directory with a trailing slash, a file by its exact
path) followed by `read-only` or `read/write`** — read-only names before writable ones and
alphabetically within each, any other root path governed by the state's tool rules, and dot-prefixed
mounts omitted. The posture SHALL be stated as permission, not caution: a `read/write` mount is
described as being as open to the agent as `scratchpad/`, and the read/write wording SHALL be absent
when no ungoverned mount is writable. Governed mounts SHALL NOT be named in this
section — their visibility varies by state, and the static prefix does not — but when the table
declares any, the section SHALL say that the mounts available in the current state are listed in
the "Current state" block.

#### Scenario: Prose appended after the graph section

- **WHEN** a workflow has both `workflow.yaml` and `WORKFLOW.md`
- **THEN** the prompt carries the rendered graph section followed by the prose, and a workflow with
  no `WORKFLOW.md` assembles with the graph section alone

#### Scenario: Governed mounts keep the prefix stable

- **WHEN** the table governs `reference` and two states enable different mount sets
- **THEN** the static prefix is byte-identical for model calls in both states and names `reference`
  in neither

### Requirement: The graph section is rendered from the spec

The graph section SHALL be a pure, deterministic function of the spec: a `# Workflow: <title>`
heading; the spec's `instructions` verbatim under `## Instructions` when declared; then `## States`
with each state in declaration order headed by its backticked slug, its `title` as a parenthetical
label, and markers — the start-state marker naming every trigger the state is entered by (singular
`trigger:` or plural `triggers:` in declaration order), a human-state marker, `terminal` — followed
by its one-line `summary`, each signed trigger's `requires`/`returns` labelled with the trigger id,
its hooks by kind, and its transitions as target slugs with `type` and `description`. State
`instructions` bodies SHALL NOT be rendered here, and transition lines SHALL name slugs, never
titles. `validate` SHALL warn when a non-terminal state declares neither a `summary` nor any
transition `description`.

A hook SHALL be rendered by **kind alone** where the kind is `rubric` — never its `instructions`,
its `max_iterations`, its `model` or its positional id — so a graded state discloses that it is
graded without disclosing the standard. No prompt section SHALL render any `metadata` block, at the
root, on a state, or inside a rubric declaration.

#### Scenario: Heading carries slug and title

- **WHEN** state `refund-request` declares `title: Evaluate refund request`
- **THEN** its heading is `` `refund-request` (Evaluate refund request)``

#### Scenario: A graded state says only that it is graded

- **WHEN** a state declares `after: { rubric: { instructions: … } }`
- **THEN** its hooks line records an `after` hook of kind `rubric`, and the whole rendered prompt
  contains no part of the rubric's `instructions`, no `max_iterations` or `model` value, and no
  positional id

#### Scenario: Metadata is never rendered

- **WHEN** a spec carries `metadata` at the root and on states
- **THEN** no part of either block appears anywhere in the rendered prompt

#### Scenario: Signature rendered under its entry state

- **WHEN** trigger `enrich` declares `requires: [order_id]` and `returns: [delayed]` and enters `enrich`
- **THEN** the `enrich` section says a run started by `enrich` arrives with `order_id` and must set
  `delayed` with `archmax_set_variables` before it completes

### Requirement: The volatile "Current state" block

On every model call the middleware SHALL append a block headed `## Current state: <slug>` stating
that it overrides any state movement recorded earlier in the transcript, followed by the state's
`instructions`, the skills section rendered from the state's enabled set (no heading when none), the
mounts section rendered from the state's enabled governed mounts — each as the agent addresses it,
alphabetically, read-only or read/write as this state's grant leaves it, with no heading when the
state enables none — the
names (never values) of the variables set, and any enforced argument constraints. When the position
is a terminal state other than the entry state and the turn arrived there in place, the block SHALL
tell the model to call `archmax_reset` before answering a follow-up. The block SHALL never be part of
the cacheable prefix.

#### Scenario: Follow-up in a terminal state is redirected

- **WHEN** a new turn opens on a session sitting in a terminal state that is not its entry state
- **THEN** the volatile block directs the model to `archmax_reset` before answering

#### Scenario: The state's mounts are disclosed where it stands

- **WHEN** state `triage` enables the governed mount `catalogs/eu` and state `intake` enables none
- **THEN** the block in `triage` names `catalogs/eu/` as readable, and the block in `intake` carries
  no mounts section

#### Scenario: The disclosed posture is this state's, not the table's

- **WHEN** the table mounts `shared` writable and state `review` enables it as
  `{ mount: shared, access: read }`
- **THEN** the block in `review` names `shared/` read-only, while a state enabling it plainly
  names it read/write

### Requirement: Prompt caching

The middleware SHALL write the system message as content blocks — the static prefix, then the
volatile block — through the request's `systemMessage`. The strategy SHALL follow the model: a native
Anthropic model uses LangChain's Anthropic caching middleware; a Bedrock Converse Claude or Nova
model uses LangChain's Bedrock caching middleware; a Claude model over an OpenAI-compatible endpoint
gets `cache_control: { type: "ephemeral", ttl }` on the static block and none on the volatile block;
any other model gets no marker and no `warning`, because the providers that serve it — OpenAI,
Gemini and OpenAI-compatible proxies — cache a stable prefix automatically, which the byte-identical
static block already serves. Precedence SHALL
be the `promptCache` option, then `settings.prompt_cache`, then
`ARCHMAX_PROMPT_CACHE`/`ARCHMAX_PROMPT_CACHE_TTL`, then the default (enabled, `5m`; `1h` accepted).
The static block and the disclosed tool order SHALL be byte-identical across a session's model
calls. Assembly SHALL emit one `prompt-shaping` event naming the cache strategy and the withheld
built-in tools.

#### Scenario: Claude over an OpenAI-compatible endpoint

- **WHEN** the model id names Claude and the client is `ChatOpenAI`
- **THEN** the static system block carries `cache_control` and the volatile block does not

#### Scenario: A model with no marker mechanism is not warned about

- **WHEN** the model is `ChatOpenAI` serving `gpt-5` with prompt caching enabled
- **THEN** no system block carries `cache_control`
- **AND** assembly emits no `warning` about prompt caching
- **AND** the `prompt-shaping` event names the `unsupported` strategy

### Requirement: Typed lifecycle event stream

Every runtime diagnostic SHALL be a `WorkflowLifecycleEvent` (`src/core/events.ts`) on one stream per
assembled agent, carrying `level` (`info`, `warn`, `error`), `ts`, a strictly increasing `seq`,
`sessionId` while a session is bound, and `subWorkflowDispatchId` inside a sub-workflow. With
`onEvent` supplied the runtime SHALL write nothing to the console; otherwise the default subscriber
SHALL render events through `renderEventLine` with the `[workflow]`/`[interpreter]`/`[rubrics]`
prefixes, rendering nothing for `tool-called`, `agent-text`, `agent-text-delta`, `tool-result`,
`rubric-start`, `rubric-result` and `model-usage`. Every `state` field SHALL be a slug; the
park-family events (`parked`, `decided`, `park-message`, `delivered`) SHALL carry the parked state as
a required `state`. Assembly SHALL emit a `graph-topology` diagnostic listing each
state's declared targets, and `hooks-summary` when the workflow declares hooks.

A `rubric-start` / `rubric-result` pair SHALL carry the rubric's name. These events are
operator-facing — the `onEvent` stream and the CLI's state flow — and SHALL reach no prompt, so
naming a rubric there is no path by which the graded agent learns one.

#### Scenario: Handler receives everything, console stays silent

- **WHEN** `createAgent` is called with `onEvent`
- **THEN** every diagnostic reaches the handler and none is written to the console

#### Scenario: Park event carries its channel

- **WHEN** a session parks by `archmax_wait`
- **THEN** `parked` carries `state`, `awaiting: "input"`, the reason, `resumeAt` when declared and
  the wait call's `callId`; a human-state park carries `awaiting: "decision"` and no `callId`

### Requirement: Paired tool events and call attribution

A call that passes governance SHALL emit `tool-called` (state, tool, `callId`, structured `args`) and
exactly one `tool-result` with the same `callId`, `status` `ok`/`error`, `durationMs`, and a capped
`output` preview with `truncated` — including the control and delegation tools the middleware
services itself, with `status: "error"` when the handler refused (for `archmax_advance`, judged by
whether the transition committed). A call governance refuses SHALL emit `tool-blocked` only. Bridge
calls from scripts and hooks SHALL emit the same telemetry with `origin: "script"` or `"lifecycle"`.
`callId` SHALL be the provider's tool-call id when one exists, and every event a call causes —
`advance`, `parked`, `variables-set`, `title-set`, the sub-workflow pair — SHALL carry it; an event
no call caused (the turn's opening `advance`, a human-state park, seeding) SHALL omit it. A rubric
dispatch SHALL additionally emit `rubric-start` and `rubric-result` sharing a `dispatchId`.

#### Scenario: The advance tool emits the pair like any other call

- **WHEN** the agent calls `archmax_advance` and the transition commits
- **THEN** `tool-called` and `tool-result` (`ok`) share the call's id, and the `advance` event carries
  the same `callId`

#### Scenario: A refused transition settles as an error

- **WHEN** `archmax_advance` names an undeclared edge or its `after` hook vetoes
- **THEN** its `tool-result` is `error` and no `advance` event is emitted

### Requirement: Text, usage and variable events

The turn runner SHALL drive every turn with LangGraph streaming and emit `agent-text-delta` (state,
text, `messageId` when known) for each text chunk, whether the consumer used `invoke` or `stream`.
After each model call the middleware SHALL emit `agent-text` with the message's full text and its
committed `messageId`, and `model-usage` with input, output and cache token counts, the `model` the
call was priced against — the id the response reported, else the id the runtime asked the endpoint
to run — and `costUsd` only when priced, accumulating the session's `usage` channel. `model` SHALL
be omitted only when neither source names one. A turn that
fails mid-stream SHALL emit one `agent-text` flagged `partial: true` per streamed message before the
error propagates. A landed `archmax_set_variables` SHALL emit `variables-set` (names, `locked`,
`callId`, never values) and, for `title`, `title-set` with the trimmed value; a refused write emits
nothing.

#### Scenario: Deltas precede the completed text

- **WHEN** the model generates text in state `S`
- **THEN** `agent-text-delta` events with `state: S` arrive before the `agent-text` for that message,
  sharing its `messageId`

#### Scenario: Usage attributes a call that named no model

- **WHEN** a model call in state `S` returns usage without naming a model
- **THEN** its `model-usage` event carries the id the runtime asked the endpoint to run, so the call
  is attributed to a model rather than to nothing

### Requirement: A failed tool call is answered, not thrown

A governed call whose tool throws SHALL be answered with an error-status tool message, never thrown
out of the turn. The message SHALL carry the error's message, answer the call's id and name the
tool, exactly as a blocked call is answered. The session SHALL stay in the active state, and the
next model call SHALL see the failure in its transcript. The call SHALL settle with exactly one
`tool-result` whose `status` is `error` and whose preview is that message. A tool failure SHALL NOT
be a state failure: it does not route through `on_error` and does not end the turn. Answers already
given to other calls of the same model step SHALL be kept.

Two things SHALL still propagate unchanged, with no answer recorded for the call:

- a LangGraph bubble-up signal, which covers an interrupt that parks the session (including a
  delegated child's park) and a parent command;
- any failure raised once the run's abort signal has fired.

This requirement covers calls that reach the tool node. It does not cover these calls:

- The control and delegation tools the runtime services itself keep their own answers.
- A `script`-origin call still throws to the script, which may catch it.
- A `lifecycle`-origin call's failure still fails the hook closed.

#### Scenario: A throwing tool is answered and the turn continues

- **WHEN** a state allows `web_search`, and the model calls it, and the tool throws
  `Error("Connection closed")`
- **THEN** the call is answered with an error-status tool message whose content is
  `Connection closed`
- **AND** exactly one `tool-result` for the call's id is emitted, with `status: "error"`
- **AND** the session stays in the same state, and the next model call receives that message as
  the call's answer

#### Scenario: Sibling calls survive one failure

- **WHEN** one model step issues four tool calls, and one throws while three return
- **THEN** the turn does not fail
- **AND** the next model call sees three results and one error-status answer, each correlated to
  its own call id

#### Scenario: A tool failure does not route through on_error

- **WHEN** a state declares `on_error: escalate`, and a tool it calls throws
- **THEN** no `state-error-routed` event is emitted, and the session stays in the state it was in

#### Scenario: A park still propagates

- **WHEN** a tool call raises a LangGraph interrupt, for example a delegated child that parks at a
  human state
- **THEN** the interrupt propagates and the session parks as it did before this requirement
- **AND** the call is not answered with an error-status message

#### Scenario: A cancelled run is not answered

- **WHEN** the run's abort signal fires while a tool call is in flight, and the tool rejects
- **THEN** the rejection propagates and the turn ends. No error-status answer is recorded for the
  call.

#### Scenario: A script still receives the throw

- **WHEN** code run by `archmax_eval` calls `tools.webSearch`, and that tool throws
- **THEN** the script receives the thrown error and may catch it. The `archmax_eval` call itself
  is answered with whatever the script produced.
