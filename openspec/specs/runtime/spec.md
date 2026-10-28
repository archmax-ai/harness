# runtime Specification

## Purpose

Define how the archmax harness executes a workflow: one Deep Agents graph whose checkpointed state carries the
machine's position, variables, trail and park records, governed by middleware. This spec covers the
turn boundary, the control tools (`archmax_advance`, `archmax_reset`, `archmax_wait`,
`archmax_raise`) and the `message` a control call carries for the person, budgets and
`on_error` routing, human states and parks, the handoff message, runtime notes, the layered system
prompt and its caching, and the typed event stream. Grader and code states are specified by the
`automated-states` capability.

## Requirements

### Requirement: One graph carries the machine

A workflow SHALL execute as exactly one `createDeepAgent` graph whose checkpointed state carries the
machine's channels beside `messages`: `workflowState`, `entryState`, `trigger`, `status`,
`specHash`, `variables`, `auditTrail`, `usage`, the per-state park counter `parkCounts`, the
outstanding delegation failures `failedDelegations`, and the park records
`pendingDecision`, `pendingInput`, `pendingDelegations`, `parkPhase` and `replyOnly`, declared once
in `src/workflow/state.ts`. There SHALL be no `iterations`, `beforeDone`, `turnCalls` or `visits`
channel. Governance middleware SHALL be the only writer; a control tool commits its change through a
`Command` when it succeeds, and an automated state's outcome is committed by `afterModel` (see
"Governance middleware sites"), so the checkpoint is the single source of truth with no in-memory
mirror. The accumulating
channels (`auditTrail`, `variables`, `pendingDelegations`, `failedDelegations`) SHALL have reducers
idempotent on an echo: a middleware callback returning the whole state it read changes nothing.
Calls settling in the same step SHALL each land their update on an accumulating channel.

#### Scenario: Advance commits to the checkpoint

- **WHEN** the agent successfully calls `archmax_advance`
- **THEN** the checkpointed `workflowState` is the new state as soon as the call settles

#### Scenario: Hook echo is a no-op

- **WHEN** a middleware callback (what LangChain calls a middleware hook) returns the whole state it
  read, including the trail it already held
- **THEN** the trail is unchanged and no locked variable is rewritten

#### Scenario: Two delegation calls fail in one step

- **WHEN** one tool batch carries two delegation calls and both children fail
- **THEN** both failures are recorded and the turn goes on, rather than failing on a channel that
  accepts one value per step

#### Scenario: No correction bookkeeping is checkpointed

- **WHEN** a grader state has sent the work back to its agent state twice and the session's
  checkpoint is read
- **THEN** it carries no `iterations` and no `beforeDone` channel, and the two send-backs appear as
  `grader` steps on its trail

### Requirement: The turn boundary opens every turn

The middleware's `beforeAgent` callback SHALL be the turn boundary, run once per invoke and never on
a park resumption (which re-enters at its interrupt through a `Command`). It SHALL resolve the
trigger (the invoke's, else the assembly default, else `manual`) and the position: a first turn
opens at the start state that trigger declares; a later turn continues at the retained position; a
retained position the spec no longer declares reopens at the trigger's start state, and so does a
session that completed in a terminal automated state (see the `automated-states` capability). It SHALL record
`entryState` once. Every turn SHALL emit `advance` from the session origin to the opening state, then
`state-enter`, and append a `trigger` trail step; `workflow-reset` SHALL be emitted only when a turn
opens at a start state. No transcript message SHALL announce a turn. The boundary SHALL reset the
turn's mechanics only — `rejected`, the outstanding delegation failures, the exit record,
`parkCounts`, every park record and phase, `replyOnly`, status to `running` — and
retain the conversation: position, `entryState`, variables, transcript, trail, usage and files. A
session in a terminal state SHALL continue there under that state's governance; `archmax_reset` is
the way out. A session that ended `failed` SHALL take its next turn the same way, continuing at the
state it raised in. When the opening position is an automated state, it SHALL run as the turn's
first step, in place of the first model call of the session's agent (see the `automated-states`
capability).

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

#### Scenario: A completed terminal code state reopens at the start state

- **WHEN** the session completed in a terminal code state and a new turn begins
- **THEN** the turn opens at the trigger's start state, emits `workflow-reset`, and the code
  state's script does not run again

#### Scenario: A failed session takes a new turn

- **WHEN** a session's previous turn ended `failed` in `lookup` and a new message arrives for it
- **THEN** the turn opens in `lookup` with status `running` and no exit record

### Requirement: A turn the machine cannot serve is refused at the boundary

The turn boundary SHALL refuse a turn when the machine is `disabled`, or when the trigger's
`requires` names are not all supplied by the opening variables. A refusal SHALL commit
`status: rejected` with a reason naming the workflow (or the trigger and the missing names), emit a
`warning` event with that reason, and end the turn before any state is entered or run, or any model
is called; it SHALL NOT throw. A decision, reply or delivery SHALL NOT pass through this gate, so
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

#### Scenario: A refused turn runs no code state

- **WHEN** a host invokes a disabled workflow whose trigger enters a code state
- **THEN** the outcome is `rejected` and the code state's script does not run

### Requirement: Governance middleware sites

The workflow middleware SHALL govern the graph at fixed sites: `wrapModelCall` discloses only the
active state's tool surface in registration order and composes the system message as a static block
plus the volatile block; when the position is an automated state and the turn is not reply-only, it
SHALL NOT call the session agent's model but run that one state and return a marker message
carrying the run's outcome (see the `automated-states` capability). `wrapToolCall` resolves the
called name, substitutes `${{name}}` references, applies the kernel's verdict to every call, and
services the control and delegation tools itself; `afterModel` reports text and usage, removes an
automated run's marker and commits its outcome (returning to the model when the session moved, so
the next state is served the same way), routes budget exhaustion and committed rejections through
`on_error`, and settles the turn's status. The outcome SHALL travel on the checkpointed marker
rather than in process memory, so an `afterModel` replayed after a process exit commits what the run
settled. A blocked call SHALL be answered with an error-status tool message and a `tool-blocked`
event, never thrown; a terminal kernel verdict (an unevaluable guard) SHALL be committed as
`rejected` so the run routes through `on_error` once the model finishes.

#### Scenario: A tool outside the state's surface is refused

- **WHEN** the model calls a tool the active state does not allow
- **THEN** the call is answered with an error-status message naming the allowed surface, a
  `tool-blocked` event is emitted, and the run stays in place

#### Scenario: The marker never reaches the transcript

- **WHEN** a code state advances to an agent state and the agent's model is called there
- **THEN** the transcript that call reads holds the `code` runtime note of the move and no marker
  message of the code state's run

### Requirement: Evidence attached to a transition

`archmax_advance` SHALL accept an optional `evidence` list of workspace-relative paths only when `to`
is a human state; on another target a non-empty list SHALL be refused recoverably before the
transition is attempted. Each path SHALL be classified through the kernel's zone table with the
assembly's mounts: readable paths (scratchpad, other session paths, read-only mounts, offload areas)
are accepted; one that escapes the workspace, addresses a runtime-internal area or is empty after
canonicalization is refused naming it; more than 20 paths SHALL be refused. Accepted paths SHALL be
stored canonically, de-duplicated, and carried into the park record after the state's declared
`evidence`.

#### Scenario: Evidence into a human state

- **WHEN** the agent advances into `refund-review` with `evidence: [scratchpad/refund.json]` and the
  state declares `evidence: [scratchpad/policy.md]`
- **THEN** the park record's evidence is `[scratchpad/policy.md, scratchpad/refund.json]`

#### Scenario: Evidence toward another target is refused

- **WHEN** the agent advances into a grader state with `evidence: [scratchpad/reply.md]`
- **THEN** the call is refused, saying the target is not a human state, and the position is unchanged

### Requirement: `archmax_reset` returns the session to its entry state

The runtime SHALL expose `archmax_reset({ reason })` in every agent and human state, requiring a
non-empty `reason`; no automated state offers it. It SHALL move the position to the recorded
`entryState` (else the trigger's start state), clear `rejected`, append a `reset`
trail step with the reason, and re-enter the entry state; an automated entry state SHALL run again
in place of the next model call (see the `automated-states` capability). It SHALL release every
lock set with `archmax_set_variables` (by the agent, a grader or a code state's script), keeping
each value, and SHALL NOT touch any other variable (a host's locks included), messages, files or
the recorded trail. `tools.forbid_always`
MAY ban it.

The platform prompt and the tool's description SHALL tell the model when to reset and when not to.
A reset is for a new message the current state cannot serve (no transition reaches what was asked,
or an earlier turn took a wrong path), and for a follow-up that lands on a terminal state the
session moved into and finished in. When the current state can serve the new message, the model
SHALL be told to answer there, because a new message alone is no reason to reset. While the
session is in the state the conversation began in, the model SHALL be told never to reset, because
a reset leads back to that same state. The platform prompt SHALL name a terminal state the
conversation began in as an exception to its terminal-state rule, alongside a session parked with
`archmax_wait` and a terminal state routed into in the same turn. This matches the volatile block,
which gives the terminal-state reset instruction only for a terminal state other than the entry
state.

#### Scenario: Entry state is stable across deliveries

- **WHEN** a session started by `email_received` was resumed by a delivery of `email_reply` and resets
- **THEN** it returns to the `email_received` start state with its transcript and scratchpad untouched

#### Scenario: A follow-up the state can serve needs no reset

- **WHEN** a top-level session's system prompt and its `archmax_reset` description are rendered
- **THEN** the prompt's "A conversation keeps its position" paragraph tells the model to stay and
  answer when the current state can serve the new message and never to reset from the state the
  conversation began in, and the description says a state that can serve the message needs no reset

#### Scenario: A terminal entry state answers its follow-ups

- **WHEN** the platform prompt lists the cases in which a message on a terminal state is answered
  without a reset
- **THEN** the terminal state the conversation began in is listed, beside a session parked with
  `archmax_wait` and a terminal state routed into this turn

#### Scenario: The restarted run can decide again what the earlier run locked

- **WHEN** the agent set `case_id` with `lock: true` and later calls `archmax_reset`
- **THEN** `case_id` keeps its value, is no longer locked, and the next write of it succeeds

#### Scenario: A reset re-runs a code entry state

- **WHEN** a session whose entry state is the code state `screen-request` calls `archmax_reset` from
  `orders-question`
- **THEN** the trail records a `reset` step into `screen-request`, and its script runs again before
  the next model call of the session's agent

### Requirement: `archmax_wait` parks the session in place

The runtime SHALL expose `archmax_wait({ reason, message?, until? })` in every agent and human state,
terminal states included, rejecting an empty `reason`; no automated state offers it, since an
automated state cannot park. `message` SHALL be what the person reads as the session waits (see "A
control call's message is what the person reads"). A wait SHALL commit a `pendingInput` record (state, `title` when declared,
reason, `parkedAt`, `resumeAt` when declared), set `status: awaiting_input`, increment the state's
park count, emit `parked` with `awaiting: "input"`, the reason and the call's `callId`, and tell the
model to stop; the position SHALL be unchanged and no transition committed. `until` SHALL be a
relative duration (`<integer><ms|s|m|h|d>`) or an ISO-8601 instant, normalized to an absolute
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

#### Scenario: An automated state cannot wait

- **WHEN** a code state's script reads `tools.archmax_wait`
- **THEN** the value is `undefined`, and the session cannot park in the code state

### Requirement: Budgets

A state's budget SHALL bound time and parks, never model calls. In an agent or human state,
`budget.timeoutMs` SHALL race the state's model call against a timer; on expiry the runtime
substitutes a budget-exhausted result, removes it from the transcript and routes the failure through
`on_error`, without aborting the in-flight request. In a grader state, `budget.timeoutMs` SHALL
bound the grader's whole run instead (see the `automated-states` capability). `budget.maxParks`
SHALL cap `archmax_wait` parks per state within a turn, checked before the park is committed; an
exceeded bound refuses the wait and commits `rejected` naming the state and the bound. A delegated
child's park SHALL NOT count.

How many model calls a turn makes, in every state it passes through, SHALL be bounded by its
recursion limit alone (see "A turn runs under LangGraph's recursion limit"): a state's `budget`
declares no turn count (see the `workflow-spec` capability), and there is no workflow-wide budget.
Every exhaustion SHALL route through `on_error` when declared, else end the turn rejected.

#### Scenario: Timeout substitutes a result

- **WHEN** a model call in a state with `timeoutMs: 1000` has not returned after one second
- **THEN** the failure is routed through `on_error` and the request itself is not aborted

#### Scenario: A park budget refuses the wait

- **WHEN** state `clarify` declares `budget: { maxParks: 1 }` and `on_error: escalate`, the agent
  parks with `archmax_wait`, a delivery resumes the session, and the agent calls `archmax_wait`
  again
- **THEN** the second wait is refused and the session does not park, and once the model finishes
  the failure routes to `escalate` with a reason naming `maxParks: 1`

#### Scenario: A state's model calls are not counted

- **WHEN** the agent makes twenty model calls in one agent state before it advances, in a turn
  under the default recursion limit
- **THEN** every call is made and no exhaustion is routed for the state

### Requirement: A turn runs under LangGraph's recursion limit

Every invocation of a governed session (a turn, a decision, a reply or a delivery) SHALL run under
LangGraph's `recursionLimit`: the one the caller's invoke config sets, else
`DEFAULT_RECURSION_LIMIT` (400). Every model call, tool batch and automated state of the
invocation, across every state, is a step against it. A delegated child's run SHALL run under
`DEFAULT_RECURSION_LIMIT` as well, unless the config its caller's tool call carries already sets a
limit, which it keeps. An invocation that reaches its limit SHALL end the session `failed` with
exit code `recursion-limit` (see "A turn that throws ends the session failed"). A grader's own run
SHALL run under `DEFAULT_RECURSION_LIMIT` too; a grader that reaches it fails its grader state,
which routes through `on_error` (see the `automated-states` capability). The runtime SHALL keep no
count of a turn's or a state's model calls, and the prompt SHALL state no number of calls a turn
has left.

#### Scenario: A turn runs under 400 steps by default

- **WHEN** a host calls `send(id, input)` with no `recursionLimit`
- **THEN** the turn runs under a recursion limit of 400

#### Scenario: The caller's limit wins

- **WHEN** a host calls `send(id, input, { recursionLimit: 30 })`
- **THEN** the turn runs under a recursion limit of 30

#### Scenario: A cycle between states ends at the limit

- **WHEN** the agent advances back and forth between two states on every call
- **THEN** the turn stops at its recursion limit, `send` rejects with the `GraphRecursionError`,
  and the session is `failed` with `exit.code: "recursion-limit"`

### Requirement: A turn that throws ends the session failed

When an invocation of a governed session throws (the recursion limit, a model failure, a cancellation, any other error) and the session's checkpointed status is still `running`, the runtime SHALL commit `status: failed` with an exit record before the error leaves `send`, `decide`, `reply` or `deliver`: code `recursion-limit` for a `GraphRecursionError`, `turn-cancelled` for an aborted invocation, and `turn-error` otherwise, with the error's message as the reason. It SHALL then rethrow the original error. A session whose status is not `running` (parked, or never checkpointed) SHALL be left as it is. The next message to a session failed this way SHALL resolve as a fresh turn from its retained position, as for any finished session, and its summary SHALL report the exit.

#### Scenario: A model failure does not strand the session

- **WHEN** the model endpoint fails mid-stream during a turn on session `s1`
- **THEN** `send` rejects with the endpoint's error, `sessions.get("s1")` reports `status: failed` with `exit.code: "turn-error"`, and the next `send("s1", …)` runs a fresh turn instead of throwing `SessionNotResumableError`

#### Scenario: The recursion limit ends the session failed

- **WHEN** a turn reaches its recursion limit
- **THEN** `send` rejects with the `GraphRecursionError`, and the session is `failed` with `exit.code: "recursion-limit"`

#### Scenario: A cancelled turn ends the session failed

- **WHEN** the host aborts a turn mid-run
- **THEN** `send` rejects with the abort, and the session is `failed` with `exit.code: "turn-cancelled"`

#### Scenario: A park is not overwritten

- **WHEN** a turn has committed a park and then throws
- **THEN** the session stays parked

### Requirement: Human states park for a decision

A state declaring `type: human` SHALL be a human state. On entry — by `archmax_advance` (the
agent's, or an automated state's: see the `automated-states` capability), a decision, `on_error`, or
a turn opening on a session already parked there — the runtime SHALL build the pending-decision
record deterministically, with no model call, from the slug, the `title` when declared, the
transitions with `type`/`description`, the declared `evidence` merged with attached evidence, a
1-based `seq` and `createdAt`; commit it as `pendingDecision` with `status: awaiting_decision`; and
emit `parked` with `awaiting: "decision"` and no `callId`. Nothing SHALL be rendered to a file: the
record is the presentation, and a surface reads the state's `instructions` from the spec on demand.
The record's `state` is the routing identity.

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
edge, the comment and the new position, and emitting `decided`, `state-leave` and `state-enter`. A
decision into another human state SHALL present it at once and owe a closing message. A decision
into an automated state SHALL run that state before any model call of the session's agent (see the
`automated-states` capability).

#### Scenario: Invalid target is rejected

- **WHEN** a decision names a target that is not one of the record's transitions
- **THEN** `InvalidDecisionTargetError` lists the valid targets and the session stays parked

### Requirement: Parks are LangGraph interrupts on one mechanism

A park SHALL suspend the session through `interrupt(record)` from the `WorkflowParkMiddleware`, the
one middleware that suspends, positioned so every other hook has committed and emitted first. A park
SHALL progress through `parkPhase` `closing` (a message is owed) to `suspend`, or be committed in
`suspend` when nothing is owed (see "The handoff message"), suspending only once nothing is owed and
no tool calls dangle. Both channels — a human state awaiting a `decision` and
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
  `[event]` runtime note naming `email_reply` and `reply_body`, and `archmax_get_variables` returns
  `trigger: "email_reply"` and the delivered `reply_body`

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

### Requirement: A control call's message is what the person reads

The agent's `archmax_advance`, `archmax_wait` and `archmax_raise` SHALL each take an optional string
`message`: what the person reads as the agent moves on, waits or fails. Each tool's description
SHALL say that what the person should read goes in `message`, and the parameter's description that
it belongs there, not in a separate message, since a message without a tool call ends the turn
where the agent is; the platform prompt SHALL say the same
("say it in the call's `message`"), and SHALL keep plain text for answering or asking the person
while the run stays in its state.

What one assistant message says SHALL be its text, then the `message` of each of those three calls
it made that was not refused, each trimmed, empty ones skipped, joined by a blank line (`\n\n`). A
refused call said nothing, so its `message` SHALL count nowhere: a call answered with an
error-status tool message, or with a tool message the runtime marks refused for the agent to correct
(an `archmax_advance` along an undeclared edge or past an unmet `requires`). Every reader of what the
agent said SHALL read it this way: an outcome's `reply` (see the `assembly` capability),
`lastAgentText` (and so a sub-workflow child's closing message), the session view a case's
assertions read (see the `testing` capability), whether the agent has spoken since the last message
that opened a turn (see "The handoff message"), and the `agent-text` event (see "Text, usage and
variable events"). A runtime note SHALL say nothing.

A grader's and a code state's controls SHALL take no `message`: an automated state has no person to
tell (see the `automated-states` capability).

#### Scenario: An advance's message joins the reply

- **WHEN** in one turn the agent calls `archmax_advance({ to: "work", reason: "more to do", message:
  "Looking into it." })`, then advances into the terminal state `done` and writes "All done."
- **THEN** the outcome is `completed` and its `reply` is "Looking into it.\n\nAll done."

#### Scenario: A refused call said nothing

- **WHEN** the agent calls `archmax_advance` on an undeclared target with `message: "Moving on."`,
  then along a declared edge with `message: "Moving on, for real."`, and finishes with "Finished."
- **THEN** the outcome's `reply` is "Moving on, for real.\n\nFinished."

#### Scenario: The last thing said can be a call's message

- **WHEN** a session's last assistant message carries no text and calls `archmax_wait` with
  `message: "Which order do you mean?"`
- **THEN** `lastAgentText` over its transcript returns "Which order do you mean?"

### Requirement: The handoff message

A parked session SHALL speak before it suspends: the runtime spends exactly one reply-only model
call — handed the parked state's tool list like any other call in that state, text the only
product — when a session parks by `archmax_advance` into a human state, unless the agent's advance
carried a non-blank `message`; by `archmax_wait` (only when the agent has said nothing — no text and
no `message` of a control call that was not refused, the wait's own included — since the last
message that opened a turn); when a decision or
`on_error` routes it into another human state; when a delegated child's decision is presented; and
when a person replies to a parked session. An agent's advance into a human state whose `message` is
non-blank SHALL owe no closing message: that message is the handoff, the park is committed with
`parkPhase: "suspend"`, and the session suspends with no reply-only call. Text the agent writes
beside the advance SHALL NOT stand in for a `message`, and an automated state's advance into a human
state, which carries none, SHALL always owe the reply-only call. The reply SHALL be composed by the
model from the transcript and a runtime directive, never a fixed string or an authored notice; a
human state's `instructions` SHALL be withheld from it. The turn SHALL be one model call: no text
leaves the park unchanged without a retry, and a tool call the model makes is refused by the
kernel's reply-only rule, after which the session suspends without another model call. The handoff —
the reply-only call's text, or the advance's `message` — SHALL reach the park's `reply` on every
surface.

The directive SHALL head the volatile block `## This run is parked` and open with one of four
shapes chosen structurally from the state: answering a person's message while a decision is pending
(the model cannot make, predict or announce it); waiting for something from outside (`pendingInput`,
naming the reason); having been routed to a human state by a runtime note; or having just handed the
run to a person. Each SHALL end with the same instruction — one short message, no tool calls because
every call is refused, the run stays parked until someone else acts — and SHALL label the state by
slug and title.

#### Scenario: Silent handoff into a human state speaks

- **WHEN** the agent records a refund with tool calls only and advances into `refund-review`
- **THEN** one reply-only call runs before the session suspends and its text is the outcome's `reply`

#### Scenario: An advance that carries a message is the handoff

- **WHEN** the agent's first model call of a turn calls `archmax_advance({ to: "refund-review",
  reason, message: "Your refund for ORD-1001 is with a reviewer." })`
- **THEN** no reply-only call runs, the session suspends at `refund-review` after that one model
  call, and the parked outcome's `reply` is "Your refund for ORD-1001 is with a reviewer."

#### Scenario: Text beside the advance does not replace the handoff

- **WHEN** the agent writes "Your refund is eligible" in the message that calls `archmax_advance`
  into `refund-review` with no `message`
- **THEN** one reply-only call runs before the session suspends

#### Scenario: A wait that already spoke spends no extra call

- **WHEN** the agent asks for an order id and then calls `archmax_wait`, or calls
  `archmax_wait({ reason, message: "Which order do you mean?" })`
- **THEN** no reply-only call runs and the park's `reply` is the question already asked

#### Scenario: A runtime note opens the silence window

- **WHEN** a delivered firing resumes a run and it calls `archmax_wait` without writing text after
  the arrival
- **THEN** one reply-only call runs, because the arrival note opened a turn

#### Scenario: Answering while a person decides

- **WHEN** the last transcript message is a person's message on a session parked at a human state
- **THEN** the directive says a person is deciding and the model cannot make, predict or announce
  that decision

#### Scenario: A tool call on the handoff turn is refused and the session suspends

- **WHEN** the agent advances into `refund-review` and the model answers its reply-only call with a
  call to `read_file`
- **THEN** the call is refused with `tool.reply-only` and the tool never runs, no further model call
  is made, and the session is parked at `refund-review` awaiting a decision

#### Scenario: A code state's handoff is spoken by the session's agent

- **WHEN** the code state `check-refund` advances into `refund-review`
- **THEN** one reply-only call of the session's agent runs before the session suspends, and its text
  is the outcome's `reply`

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

### Requirement: Runtime notes are marked tool pairs

A message the runtime writes on its own behalf SHALL be a runtime note: an assistant message
carrying one `archmax_note` tool call with no text, answered in the same append by a tool message
holding the note, both marked on `additional_kwargs.archmax.note` with the kind — `decision`, `event`,
`error`, `grader`, `code`, `sub-workflow` or `opening`. A `grader` or `code` note SHALL carry an
automated state's reason to the next state (see the `automated-states` capability); there SHALL be
no `after` kind. `archmax_note` SHALL be registered as no tool and callable by nothing. A note SHALL
never be a human message or a mid-thread system message; the `[kind]` prefix is readability only.
One constructor (`runtimeNote`) SHALL build every note. A sub-workflow's opening line SHALL stay a
human-role message marked `opening`; a person's message to a parked session SHALL stay a plain human
message with no marker. `opensTurn` SHALL treat a human-role message and a runtime note alike as
something the run was told, so the silence window and a reply-only turn's spend are decided per
message across transcripts mixing both shapes. Derived views SHALL exclude notes from the tool calls
a run made and from the reply it ended on. `isRuntimeNote`, `runtimeNoteKind` and `RuntimeNoteKind`
SHALL be exported from the package root.

#### Scenario: A decision reaches the target as a runtime note

- **WHEN** a person selects an edge and the run routes
- **THEN** the target's transcript carries an `archmax_note` pair marked `decision`, and no human-role
  message was appended for it

#### Scenario: Authorship is readable without content

- **WHEN** a host calls `runtimeNoteKind` on an arrival note
- **THEN** it returns `event`, and a workflow instruction whose text contains `[event]` returns `null`

#### Scenario: An automated state's note names its type

- **WHEN** a host calls `runtimeNoteKind` on the note a code state's advance added, and on the note a
  grader state's advance added
- **THEN** it returns `code` for the first and `grader` for the second

### Requirement: The system prompt is layered

The model SHALL read the system prompt in this order: `AGENTS.md`; the consumer `systemPrompt`; the
platform prompt (compiled into the runtime, or `.platform/system/GRAPH_STATE.md` when the workspace
serves it; absent for a plain agent); the workspace zones section; the workflow graph
section; `WORKFLOW.md` with HTML comments stripped; the middleware's tool guidance (the
`write_todos` section, present only when some state of the workflow is granted `write_todos`, a
`forbid` subtracting as everywhere; Deep Agents 1.13 appends none for its file tools); and the volatile "Current
state" block. Deep Agents' base prompt SHALL be dropped (`systemPrompt: { prefix, base: null }`).
Layers one to six SHALL form the static prefix, identical on every model call of a session. Deep
Agents offers no per-agent opt-out from a harness profile, so a model it keeps a profile for SHALL
also read that profile's suffix after layer six: Deep Agents looks the profile up from the client's
provider and its `model_name` or `modelName`, so a LangChain `ConfigurableModel` is matched and a
`ChatOpenAI` instance, which sets only `model`, is not.
The workspace zones section SHALL be rendered from the resolved `MountPrefixes`: `scratchpad/` as
the working area, readable and writable in every state with the file tools that state is granted, the offload areas as readable only, then **one line per ungoverned
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

#### Scenario: A Codex model reads Deep Agents' suffix

- **WHEN** a governed agent runs on `initChatModel("gpt-5.2-codex", { modelProvider: "openai" })`
- **THEN** its static prompt carries Deep Agents' "Codex-Specific Behavior" suffix after the
  composed layers, while the same id on a `ChatOpenAI` instance carries none

#### Scenario: Governed mounts keep the prefix stable

- **WHEN** the table governs `reference` and two states enable different mount sets
- **THEN** the static prefix is byte-identical for model calls in both states and names `reference`
  in neither

#### Scenario: No write_todos guidance without the tool

- **WHEN** a workflow declares `tools.allow_always: [read_file, ls]` and no state's `tools.allow` names `write_todos`
- **THEN** the system prompt carries no `write_todos` section and `write_todos` is offered on no model call, while a workflow without `tools.allow_always` carries the section as before

### Requirement: The graph section is rendered from the spec

The graph section SHALL be a pure, deterministic function of the spec, in two halves. The
cacheable half is a `# Workflow: <title>` heading and the spec's `instructions` verbatim under
`## Instructions` when declared; it names no state. The volatile half is rendered per model call
for the active state only: the signature of the trigger the session was started by, then that
state's transitions — each as the target's backticked slug, its markers (the edge `type`,
`human decision node`, `grader`, `code`, `terminal`) and its `description` — or, for a terminal
state, the statement that no transition leads out of it. No other state's slug, `title`,
`summary`, `instructions`, budget or transitions SHALL be rendered, and transition lines SHALL name
slugs, never titles.

A grader state's `instructions`, the standard it grades against, SHALL reach no prompt of the
session's agent: the graph section renders no state's `instructions`, and an automated state makes
no model call of that agent, so the agent whose work is graded reads no part of the standard. No
prompt section SHALL render any `metadata` block, at the root or on a state.

#### Scenario: Only the active state's edges are rendered

- **WHEN** the session is in `identify-case`, whose transitions lead to `orders-question` and
  `refund-request`, and `refund-request` declares `title: Evaluate refund request`
- **THEN** the graph section lists `` `orders-question` `` and `` `refund-request` `` with their
  descriptions, and contains neither `refund-request`'s title nor any state `identify-case` has no
  edge to

#### Scenario: A graded state says only that it is graded

- **WHEN** the agent state `enrich-order` has a transition to the grader state
  `review-enrichment`, whose `instructions` hold the enrichments' criteria
- **THEN** the prompt rendered in `enrich-order` discloses the grading only as that transition
  line, `review-enrichment` by slug with the transition's `description`, and contains no part of
  `review-enrichment`'s `instructions`, `model` or `budget`

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

For a `ChatAnthropic` and a `ChatBedrockConverse` model, `createDeepAgent` installs LangChain's
caching middleware itself, whatever the configuration. With caching enabled, the runtime's
same-named middleware SHALL replace Deep Agents', so the configured lifetime holds; with caching
disabled, Deep Agents' remains, and the model SHALL still be cached with a five-minute lifetime. On a
`ChatAnthropic` model, Deep Agents' own breakpoint middleware SHALL mark the last system block — the
volatile block — on every call, enabled or not.

#### Scenario: Claude over an OpenAI-compatible endpoint

- **WHEN** the model id names Claude and the client is `ChatOpenAI`
- **THEN** the static system block carries `cache_control` and the volatile block does not

#### Scenario: A model with no marker mechanism is not warned about

- **WHEN** the model is `ChatOpenAI` serving `gpt-5` with prompt caching enabled
- **THEN** no system block carries `cache_control`
- **AND** assembly emits no `warning` about prompt caching
- **AND** the `prompt-shaping` event names the `unsupported` strategy

#### Scenario: Deep Agents marks a ChatAnthropic agent's volatile block

- **WHEN** a governed agent runs on `ChatAnthropic` with `promptCache: { enabled: true, ttl: "1h" }`
- **THEN** the static block is unmarked, the volatile block carries `{ type: "ephemeral" }`, and the
  `cache_control` model setting carries `ttl: "1h"`

#### Scenario: Turning caching off leaves Deep Agents' caching on

- **WHEN** a governed agent runs on `ChatAnthropic` or `ChatBedrockConverse` with
  `promptCache: { enabled: false }`
- **THEN** the `cache_control` model setting is still `{ type: "ephemeral", ttl: "5m" }`

### Requirement: Typed lifecycle event stream

Every runtime diagnostic SHALL be a `WorkflowLifecycleEvent` (`src/core/events.ts`) on one stream per
assembled agent, carrying `level` (`info`, `warn`, `error`), `ts`, a strictly increasing `seq`,
`sessionId` while a session is bound, and `subWorkflowDispatchId` inside a sub-workflow. With
`onEvent` supplied the runtime SHALL write nothing to the console; otherwise the default subscriber
SHALL render events through `renderEventLine` with the `[workflow]`/`[interpreter]` prefixes,
rendering nothing for `tool-called`, `agent-text`, `agent-text-delta`, `tool-result` and
`model-usage`. Every `state` field SHALL be a slug; the park-family events (`parked`, `decided`,
`park-message`, `delivered`) SHALL carry the parked state as a required `state`. Assembly SHALL emit
a `graph-topology` diagnostic listing each state's declared targets.

Each automated state's run SHALL be bracketed on the stream: a code state's by `code-start` and
`code-result`, with one `code-output` per console line of its script, and a grader state's by
`grader-start` and `grader-result`, each with the payload the `automated-states` capability defines.
These events are operator-facing — the `onEvent` stream and the CLI's state flow — and SHALL reach
no prompt. There SHALL be no `hooks-summary`, `hook-start`, `hook-output`, `hook-passed`,
`hook-verdict`, `hook-rejected`, `rubric-start` or `rubric-result` event.

#### Scenario: Handler receives everything, console stays silent

- **WHEN** `createAgent` is called with `onEvent`
- **THEN** every diagnostic reaches the handler and none is written to the console

#### Scenario: Park event carries its channel

- **WHEN** a session parks by `archmax_wait`
- **THEN** `parked` carries `state`, `awaiting: "input"`, the reason, `resumeAt` when declared and
  the wait call's `callId`; a human-state park carries `awaiting: "decision"` and no `callId`

#### Scenario: A code state's output reaches the console

- **WHEN** `createAgent` is called without `onEvent` and a code state's script logs a line
- **THEN** the console carries a line for that output, between the lines for the run's
  `code-start` and `code-result`

### Requirement: Paired tool events and call attribution

A call that passes governance SHALL emit `tool-called` (state, tool, `callId`, structured `args`) and
exactly one `tool-result` with the same `callId`, `status` `ok`/`error`, `durationMs`, and a capped
`output` preview with `truncated` — including the control and delegation tools the middleware
services itself, with `status: "error"` when the handler refused (for `archmax_advance`, judged by
whether the transition committed). A call governance refuses SHALL emit `tool-blocked` only.
Programmatic calls, from an agent's sandbox script or a code state's script, SHALL emit the same
telemetry with `origin: "script"`; a grader's calls SHALL emit it as a model's calls do, with no
`origin`, under the grader state. Every call an automated state makes, its control tools included,
SHALL emit the pair. `callId` SHALL be the provider's tool-call id when one exists, and every event a
call causes — `advance`, `parked`, `variables-set`, `title-set`, the sub-workflow pair — SHALL carry
it; an automated state's `advance` and `raised`, emitted when its run settles, SHALL carry the
recorded call's `callId`. An event no call caused (the turn's opening `advance`, a human-state park,
seeding) SHALL omit it.

#### Scenario: The advance tool emits the pair like any other call

- **WHEN** the agent calls `archmax_advance` and the transition commits
- **THEN** `tool-called` and `tool-result` (`ok`) share the call's id, and the `advance` event carries
  the same `callId`

#### Scenario: A refused transition settles as an error

- **WHEN** `archmax_advance` names an undeclared edge or the leaving state's `requires` is unmet
- **THEN** its `tool-result` is `error` and no `advance` event is emitted

#### Scenario: A code state's calls are attributed to its script

- **WHEN** a code state's script calls `tools.read_file` and then `tools.archmax_advance`
- **THEN** each call emits `tool-called` and `tool-result` with the code state as `state` and
  `origin: "script"`, and the `advance` event carries the advance call's `callId`

### Requirement: Text, usage and variable events

The turn runner SHALL drive every turn with LangGraph streaming and emit `agent-text-delta` (state,
text, `messageId` when known) for each text chunk, whether the consumer used `invoke` or `stream`.
After each model call the middleware SHALL emit `agent-text` with the message's full text, when it
has any, and its committed `messageId`, and `model-usage` with input, output and cache token counts, the `model` the
call was priced against — the id the response reported, else the id the runtime asked the endpoint
to run — and `costUsd` only when priced, accumulating the session's `usage` channel. `model` SHALL
be omitted only when neither source names one. A turn that
fails mid-stream SHALL emit one `agent-text` flagged `partial: true` per streamed message before the
error propagates. A landed `archmax_set_variables` SHALL emit `variables-set` (names, `locked`,
`callId`, never values) and, for `title`, `title-set` with the trimmed value; a refused write emits
nothing.

When an agent's control call carrying a non-blank `message` lands — an `archmax_advance` that moved
the session, an `archmax_wait` that parked it, an `archmax_raise` that ended it — the runtime SHALL
emit `agent-text` again for the assistant message that made the call, under its `messageId`, with
everything that message says: its text and its control calls' messages (see "A control call's
message is what the person reads"). `agent-text` can therefore arrive twice for one `messageId`, the
later one whole, so a consumer replaces by `messageId` rather than appending. A refused control
call's `message` SHALL be emitted in no `agent-text`.

A sub-workflow child's text SHALL reach the event stream only from the child's own turn runner,
carrying the child's `sessionId` and the dispatch's `subWorkflowDispatchId`. A caller's turn runner
SHALL NOT emit a child's text, neither as an `agent-text-delta` nor as a `partial` `agent-text`. A
child SHALL be invoked without its caller's stream handlers; every other callback the caller hands
down SHALL still observe the child's runs.

A grader's model calls are no model calls of the session's agent: their text SHALL NOT be emitted as
`agent-text-delta`, and their usage SHALL be reported as the `automated-states` capability defines.

#### Scenario: Deltas precede the completed text

- **WHEN** the model generates text in state `S`
- **THEN** `agent-text-delta` events with `state: S` arrive before the `agent-text` for that message,
  sharing its `messageId`

#### Scenario: A landed call's message is announced under its message's id

- **WHEN** one assistant message writes "Checking." and calls `archmax_advance({ to: "work",
  reason, message: "Looking into it." })`, and the advance lands
- **THEN** `agent-text` carries "Checking." after the model call, and again, under the same
  `messageId`, "Checking.\n\nLooking into it."

#### Scenario: A message-only advance into a human state is said once

- **WHEN** the agent's message carries no text and its `archmax_advance` into a human state carries
  `message: "Your refund is with a reviewer."`
- **THEN** the turn emits exactly one `agent-text`, "Your refund is with a reviewer."

#### Scenario: Usage attributes a call that named no model

- **WHEN** a model call in state `S` returns usage without naming a model
- **THEN** its `model-usage` event carries the id the runtime asked the endpoint to run, so the call
  is attributed to a model rather than to nothing

#### Scenario: Concurrent children stream as their own

- **WHEN** state `S` dispatches two children in one tool batch and both stream text at the same time
- **THEN** each child's `agent-text-delta` events carry that child's `sessionId` and its dispatch's
  `subWorkflowDispatchId`
- **AND** the caller's deltas carry only the caller's own text, with `state: S` and the `messageId`
  of the caller's own message

#### Scenario: A failed turn finalizes only its own text

- **WHEN** a caller's turn fails mid-stream after a child it dispatched streamed text
- **THEN** the caller's `partial` `agent-text` holds only the text the caller's own model streamed

#### Scenario: A host's tracer still sees the child

- **WHEN** a host invokes a turn with its own callback handler and the turn dispatches a child
- **THEN** the handler observes every model call the child makes

#### Scenario: A grader's text does not stream as the session's

- **WHEN** a grader writes text on a model call before it decides
- **THEN** no `agent-text-delta` event carries that text

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
- A `script`-origin call, from an agent's sandbox script or a code state's script, still throws to
  the script, which may catch it.
- A grader's call is answered inside the grader's own run (see the `automated-states` capability).

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

#### Scenario: A code state's script receives the throw

- **WHEN** a code state that allows `web_search` runs a script calling `tools.web_search`, and that
  tool throws
- **THEN** the script receives the thrown error and may catch it, and the state fails only if the
  script lets it escape

### Requirement: A return is owed at the finish and seeded unlocked

A trigger's `returns` SHALL be read only by the completion check. `archmax_advance` SHALL check the
state's own `requires:` and never the current trigger's `returns`, so a state is left with them
unset unless that state's `requires:` lists them. A write of a return SHALL replace an earlier
unlocked one. `archmax_set_variables` SHALL lock a return with `lock: true` as it locks any other
name.

A seed of a return of the trigger in force SHALL land unlocked:

- A turn boundary's seed of one (a host's `variables`, a firing's, or a delegation's arguments) SHALL
  land unlocked. When the session already holds a value for that name, the seed SHALL write nothing,
  as a seeded `title` does, and it SHALL still satisfy the trigger's `requires`.
- A delivery's seed of a return of the delivered trigger SHALL land unlocked, replacing the held
  value as every delivered value does.

#### Scenario: A child leaves a state before its returns are set

- **WHEN** a child whose `draft` state has no `requires:` and whose trigger declares
  `returns: [summary]` advances to `finish` with `summary` unset, then sets it and finishes
- **THEN** the advance is not blocked, and the caller gets `summary` as set in `finish`

#### Scenario: A return locks once it is final

- **WHEN** a child whose trigger declares `returns: [summary]` sets `summary` to `"first guess"`,
  advances, then sets it to `"final"` with `lock: true`
- **THEN** both writes succeed, `summary` is held locked, and the caller gets `"final"`

#### Scenario: A seeded return is rewritable

- **WHEN** a child whose trigger declares `requires: [summary]` and `returns: [summary]` is called
  with `summary: "rough draft"` and sets `summary` to `"polished"`
- **THEN** the write succeeds and the caller gets `"polished"`

#### Scenario: A later turn's seed leaves the result in place

- **WHEN** a top-level session seeded `summary: "rough draft"`, whose trigger requires and returns
  `summary`, set it to `"polished"`, and the next turn carries the same seed
- **THEN** that turn starts, and `summary` still holds `"polished"`, unlocked

### Requirement: `archmax_advance` moves the session along a declared edge

The runtime SHALL expose `archmax_advance({ to, reason, message?, evidence? })`, rejecting an empty
`reason`, and on a call SHALL in order: check the leaving state's `requires`; validate the edge
against the declared transitions; then commit the position, an `agent` trail step with the reason,
and a tool message saying the target's tools are now usable. `message` SHALL be what the person
reads as the session moves on (see "A control call's message is what the person reads"); into a
human state it is the handoff (see "The handoff message"). A refusal SHALL answer
`archmax_advance rejected: <reason>` — listing the valid target slugs for an undeclared edge — in a
tool message marked refused, so a `message` the call carried is never said, and leave the position
unchanged; every such refusal is recoverable and leaves the agent to retry. The
`to` parameter SHALL be described as a slug. A target that is an automated state SHALL run in place
of the next model call. An automated state's own `archmax_advance` SHALL be validated the same way
and SHALL commit when its run settles, with a `grader` or `code` trail step in place of the `agent`
step (see the `automated-states` capability).

#### Scenario: Valid transition

- **WHEN** the agent calls `archmax_advance` with a declared target and a reason
- **THEN** the position becomes the target, the trail records an `agent` step with the reason, and
  `advance`, `state-leave` and `state-enter` are emitted

#### Scenario: Requires gate refuses the move

- **WHEN** the current state declares `requires: [order_id]` and `order_id` is unset
- **THEN** the advance is refused naming `order_id` and `archmax_set_variables`, and the position is
  unchanged

#### Scenario: One transition per model step

- **WHEN** one assistant message carries two `archmax_advance` calls
- **THEN** the first is serviced and the rest are refused naming the state it landed in, so one
  position is committed

#### Scenario: A refused attempt leaves the step open

- **WHEN** one assistant message calls `archmax_advance` on an undeclared target and then on a
  declared one
- **THEN** the first is refused and the second moves the session: only a transition that landed
  claims the step

### Requirement: A failed state routes to its `on_error` target

A failed state SHALL route to its declared `on_error` target — failure being an exhausted budget, a
timed-out model call, an automated state's failed run (it threw, timed out, a grader's run reached
its recursion limit, or a non-terminal automated state finished without deciding; see the
`automated-states` capability), a
terminal kernel block or a failed delegation call that no later call recovered (see `delegation`).
Routing SHALL append an `[error]` runtime note marked `error`, commit the new position and an
`on_error` trail step, clear every park record, the committed rejection and every outstanding
delegation failure, emit `state-error-routed`, `state-leave` and `state-enter`, and continue to the
model; an automated `on_error` target SHALL run in place of that model call. A rejection a tool
committed, and a delegation failure still outstanding, SHALL be routed once the model has finished
in the failing state; the committed rejection is the reason when there is one, else every
outstanding failure in the order they failed, each with the arguments of its call. A human `on_error`
target SHALL be presented at once, owing a closing message. Without `on_error`, the turn SHALL end
`rejected` with the reason. A session short of its trigger's `returns` is not a state failure and
SHALL NOT route through `on_error`.

#### Scenario: A code state's error routes to the error state

- **WHEN** a code state declares `on_error: escalate` and its script throws
- **THEN** the run routes to `escalate` with an `[error]` runtime note naming the failure

#### Scenario: A recovered delegation failure does not route

- **WHEN** a state declaring `on_error: failed` calls `archmax_workflow_enrich`, the child fails,
  a later call of `enrich` from that state with the same arguments succeeds, and the model finishes
- **THEN** the session completes in that state and no `state-error-routed` is emitted

#### Scenario: A committed rejection still routes after a successful delegation

- **WHEN** a call is blocked by an unresolvable `${{…}}` guard in a state declaring
  `on_error: failed`, and a delegation call from that state then succeeds
- **THEN** the run routes to `failed` with the guard's reason

### Requirement: Terminal states complete the session

A state with no transitions SHALL be terminal: `archmax_advance` is not disclosed there. The turn
SHALL complete with `status: completed` and a `state-leave` event when the model finishes without
tool calls in a terminal state that is not parked, or when a terminal code state's script returns
without raising (see `automated-states`). Only the trigger's `returns` SHALL gate that completion
(see "A completing session is held to its trigger's returns"), and no runtime note asks for a
revision.

#### Scenario: Finishing in a terminal state completes the session

- **WHEN** the agent finishes in a terminal state with a text reply and no tool calls, and the
  session is not parked
- **THEN** the status is `completed`, `state-leave` is emitted, and no further model call is made

#### Scenario: A terminal code state completes without a model call

- **WHEN** an agent state advances into the terminal code state `archive-case`, whose script
  writes `scratchpad/case.json` and returns
- **THEN** the session completes with `status: completed`, and the session's agent makes no model
  call in `archive-case`

### Requirement: `archmax_raise` ends the session failed from any state

The runtime SHALL expose `archmax_raise({ code, reason, message? })` in every agent and human state,
terminal ones included, and `archmax_raise({ code, reason })`, with no `message`, in every automated
state. `message` SHALL be what the person reads as the session fails (see "A control call's message
is what the person reads"). Calling it SHALL always mean failure; the tool SHALL take no argument that declares
success. A session whose turn ends without `archmax_raise` SHALL be a success. `code` SHALL be a
free-form string of 1 to 64 characters after trimming, holding no line break; `reason` SHALL be
non-empty after trimming. An invalid argument SHALL be refused with an error-status tool message
naming the field, and the session SHALL continue in place.

The call SHALL be refused, and the session continue in place, when the assistant message that
carries it carries any other tool call; the refusal SHALL tell the model to call `archmax_raise`
alone, after the other work has settled. The reply-only turn and every `forbid_always` or
`forbid` entry naming the tool SHALL refuse it as they refuse any other tool.

An accepted call SHALL, in this order: commit the exit record (`code`, `reason`, the state it was
called in) and `status: failed`; clear a pending rejection marker; emit `raised` (`state`,
`sessionId`, `code`, `reason`, and the call's `callId`) and then `state-leave`; answer the call
with a tool message saying the session has ended; and end the turn without another model call.
The position SHALL be unchanged and no trail step SHALL be appended. A raise SHALL NOT consult
`on_error` and SHALL NOT check the trigger's `returns`.

In an automated state, `archmax_raise` SHALL be recorded as the state's decision and take effect
when the run settles, committing the same exit record and `status: failed` and emitting the same
`raised` event; the sibling-call rule above governs the session's agent only, and how the call is
answered and noted is the `automated-states` capability's.

The tool description and the platform prompt SHALL tell the model to call `archmax_raise` only when
the task cannot be completed and recovery has been tried; never to finish work that succeeded; and
never in place of `archmax_wait` (something has to arrive), `archmax_reset` (a wrong branch) or a
human state (a person has to decide). They SHALL tell the model that what the person should read
goes in the call's `message`, and that a reply that only explains the failure ends the session as a
success.

#### Scenario: A raise's message is what the person reads

- **WHEN** the agent calls `archmax_raise({ code: "orders-unavailable", reason: "the store is down",
  message: "I can't reach the order records." })` as the only call in a message with no text
- **THEN** the outcome is `failed` and its `reply` is "I can't reach the order records."

#### Scenario: A raise ends the session failed

- **WHEN** the agent in `lookup` calls `archmax_raise({ code: "orders-unavailable", reason: "The
  orders API failed three times." })` as the only call in its message
- **THEN** the session's status is `failed`, its position is still `lookup`, `raised` is emitted
  with the code, the reason and the call's `callId`, and no further model call is made in the turn

#### Scenario: A session that never raises is a success

- **WHEN** a turn completes in a terminal state without any `archmax_raise` call
- **THEN** its status is `completed`, exactly as before this requirement

#### Scenario: A raise beside another call is refused

- **WHEN** one assistant message calls `read_file` and `archmax_raise`
- **THEN** `archmax_raise` is answered with an error-status message telling the model to call it
  alone, the status stays `running`, and the model is called again

#### Scenario: An invalid code is refused

- **WHEN** the agent calls `archmax_raise({ code: "", reason: "nothing found" })`
- **THEN** the call is refused naming `code`, and the session continues in place

#### Scenario: A raise bypasses on_error and returns

- **WHEN** a state declaring `on_error: escalate` raises, in a session whose trigger declares
  `returns: [summary]` and `summary` is unset
- **THEN** the session ends `failed` in that state: it does not route to `escalate`, and the unset
  return does not reject it

#### Scenario: A raise replaces a pending rejection

- **WHEN** a sub-run failed earlier in the turn, committing a rejection, and the agent then raises
- **THEN** the session ends `failed` with the agent's code and reason, not `rejected`

### Requirement: A completing session is held to its trigger's returns

When the model finishes without tool calls in a state that is not parked, or a terminal code
state's script returns without raising, the runtime SHALL check the `returns` of the trigger that
started the turn, once, and hand nothing back: no runtime note, no further model call.

- A session that set every declared return, each conforming to its type, SHALL complete.
- A **sub-workflow child** that left declared returns unset SHALL complete; its caller gets every
  declared return, the unset ones `null`, plus a `note` naming them (see `delegation`).
- A **top-level session** that left declared returns unset SHALL end with `status: rejected` and a
  reason naming the state, the unset names and the trigger, without consulting `on_error`.
- A session holding a declared return whose value does not conform to its type SHALL be rejected
  the same way, a child included.

The check SHALL NOT run at a park, on a reply-only turn, or after `archmax_raise`. The rendered
trigger signature SHALL tell the agent that the returns are set with `archmax_set_variables` before
it finishes, and what finishing without every one does: for a child, that its caller gets the ones
it set, and any left unset as empty, with a note naming them; otherwise, that the session ends
rejected. It SHALL also tell the agent to set each once its final value is known, that moving to
another state does not need it, and to lock one only when it is final.

#### Scenario: A top-level session short of its returns is rejected at once

- **WHEN** a top-level session started by a trigger declaring `returns: [enrichment_file]` finishes
  with `enrichment_file` unset
- **THEN** it ends `rejected` with "Completed in state '<state>' without setting 'enrichment_file',
  which trigger 'manual' declares in its 'returns'. …", after one model call, with no runtime note,
  and `on_error` is not consulted

#### Scenario: A child short of its returns completes

- **WHEN** a sub-workflow child whose trigger declares `returns: [enrichment_file, delayed]` finishes
  with only `enrichment_file` set
- **THEN** the child ends `completed` with no runtime note and no further model call

#### Scenario: A mistyped return is rejected, a child's included

- **WHEN** a session whose trigger declares `returns: [{ name: total, type: number }]` finishes with
  `total` holding `"twelve"`, as a top-level session and as a child
- **THEN** each ends `rejected` naming `total` and `number`

#### Scenario: A terminal code state is held to the returns

- **WHEN** a top-level session whose trigger declares `returns: [answer_file]` reaches a terminal
  code state whose script returns with `answer_file` unset
- **THEN** it ends `rejected` naming `answer_file`, and `on_error` is not consulted

#### Scenario: A raise owes no returns

- **WHEN** a session whose trigger declares `returns` calls `archmax_raise` before setting them
- **THEN** it ends `failed` with no runtime note and no further model call

#### Scenario: The prompt says what finishing short does

- **WHEN** a run started by trigger `enrich`, which declares `returns: [delayed]`, is in its entry
  state, once as a top-level session and once as a sub-workflow child
- **THEN** the rendered signature says it must set `delayed` with `archmax_set_variables` before it
  finishes, and says the top-level run ends rejected without it, while the child's caller gets what
  it set and the rest empty, with a note naming them
- **AND** both say to set it once its final value is known, that moving to another state does not
  need it, and to lock it only when it is final
