## ADDED Requirements

### Requirement: A session short of its returns settles on what it set

When the model finishes without tool calls in a state that is not parked, and after a terminal
state's `after` hooks have passed, the runtime SHALL check the `returns` of the trigger that started
the turn, once, and hand nothing back: no runtime note, no further model call.

- A session that set every declared return, each conforming to its type, SHALL complete.
- A **sub-workflow child** that left declared returns unset SHALL complete; its caller gets the
  returns it set plus a `note` naming the rest (see `delegation`).
- A **top-level session** that left declared returns unset SHALL end with `status: rejected` and a
  reason naming the state, the unset names and the trigger, without consulting `on_error`.
- A session holding a declared return whose value does not conform to its type SHALL be rejected
  the same way, a child included.

The check SHALL NOT run at a park, on a reply-only turn, or after `archmax_raise`. The rendered
trigger signature SHALL tell the agent that the returns are set with `archmax_set_variables` before
it finishes, and what finishing without every one does: for a child, that its caller gets the ones
it set with a note naming the rest; otherwise, that the session ends rejected.

#### Scenario: A top-level session short of its returns is rejected at once

- **WHEN** a top-level session started by a trigger declaring `returns: [enrichment_file]` finishes
  with `enrichment_file` unset
- **THEN** it ends `rejected` with "Completed in state '<state>' without setting 'enrichment_file',
  which trigger 'manual' declares in its 'returns'. …", after one model call, with no `[after]` note,
  and `on_error` is not consulted

#### Scenario: A child short of its returns completes

- **WHEN** a sub-workflow child whose trigger declares `returns: [enrichment_file, delayed]` finishes
  with only `enrichment_file` set
- **THEN** the child ends `completed` with no `[after]` note and no further model call

#### Scenario: A mistyped return is rejected, a child's included

- **WHEN** a session whose trigger declares `returns: [{ name: total, type: number }]` finishes with
  `total` holding `"twelve"`, as a top-level session and as a child
- **THEN** each ends `rejected` naming `total` and `number`

#### Scenario: A terminal after hook runs first

- **WHEN** a terminal state's `after` hook vetoes the first finish and passes the second, and the
  second finish leaves a declared return unset in a top-level session
- **THEN** the hook's note is appended once and the session is then rejected for the return, without
  a second note

#### Scenario: A raise owes no returns

- **WHEN** a session whose trigger declares `returns` calls `archmax_raise` before setting them
- **THEN** it ends `failed` with no `[after]` note and no further model call

#### Scenario: The prompt says what finishing short does

- **WHEN** a run started by trigger `enrich`, which declares `returns: [delayed]`, is in its entry
  state, once as a top-level session and once as a sub-workflow child
- **THEN** the rendered signature says it must set `delayed` with `archmax_set_variables` before it
  finishes, and says the top-level run ends rejected without it, while the child's caller gets what
  it set with a note naming the rest

## MODIFIED Requirements

### Requirement: One graph carries the machine

A workflow SHALL execute as exactly one `createDeepAgent` graph whose checkpointed state carries the
machine's channels beside `messages`: `workflowState`, `entryState`, `trigger`, `status`,
`specHash`, `variables`, `auditTrail`, `usage`, the bookkeeping `iterations` and `beforeDone`,
the per-state counters `stateTurns` and `parkCounts`, the outstanding delegation failures
`failedDelegations`, and the park records `pendingDecision`, `pendingInput`, `pendingDelegations`,
`parkPhase` and `replyOnly`, declared once in `src/workflow/state.ts`. Governance middleware SHALL be
the only writer; a control tool commits its change through a `Command` when it succeeds, so the
checkpoint is the single source of truth with no in-memory mirror. The accumulating channels
(`auditTrail`, `variables`, `pendingDelegations`, `failedDelegations`) SHALL have reducers
idempotent on an echo: a hook returning the state it read changes nothing. Calls settling in the
same step SHALL each land their update on an accumulating channel.

#### Scenario: Advance commits to the checkpoint

- **WHEN** the agent successfully calls `archmax_advance`
- **THEN** the checkpointed `workflowState` is the new state as soon as the call settles

#### Scenario: Hook echo is a no-op

- **WHEN** a hook returns the whole state it read, including the trail it already held
- **THEN** the trail is unchanged and no locked variable is rewritten

#### Scenario: Two delegation calls fail in one step

- **WHEN** one tool batch carries two delegation calls and both children fail
- **THEN** both failures are recorded and the turn goes on, rather than failing on a channel that
  accepts one value per step

### Requirement: The turn boundary opens every turn

The middleware's `beforeAgent` hook SHALL be the turn boundary, run once per invoke and never on a
park resumption (which re-enters at its interrupt through a `Command`). It SHALL resolve the trigger
(the invoke's, else the assembly default, else `manual`) and the position: a first turn opens at the
start state that trigger declares; a later turn continues at the retained position; a retained
position the spec no longer declares reopens at the trigger's start state. It SHALL record
`entryState` once. Every turn SHALL emit `advance` from the session origin to the opening state, then
`state-enter`, and append a `trigger` trail step; `workflow-reset` SHALL be emitted only when a turn
opens at a start state. No transcript message SHALL announce a turn. The boundary SHALL reset the
turn's mechanics only — `rejected`, the outstanding delegation failures, the exit record,
`iterations`, `beforeDone`, `parkCounts`, `stateTurns`, every park record and phase, `replyOnly`,
status to `running` — and retain the conversation: position, `entryState`, variables, transcript,
trail, usage and files. A session in a terminal state SHALL continue there under that state's
governance; `archmax_reset` is the way out. A session that ended `failed` SHALL take its next turn
the same way, continuing at the state it raised in.

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

#### Scenario: A failed session takes a new turn

- **WHEN** a session's previous turn ended `failed` in `lookup` and a new message arrives for it
- **THEN** the turn opens in `lookup` with status `running` and no exit record

### Requirement: `on_error` routing

A failed state SHALL route to its declared `on_error` target — failure being an exhausted budget, a
timed-out model call, a hook execution error, exhausted corrections, a terminal kernel block or a
failed delegation call that no later call recovered (see `delegation`). Routing SHALL append an
`[error]` runtime note marked `error`, commit the new position and an `on_error` trail step, clear
every park record, the committed rejection and every outstanding delegation failure, emit
`state-error-routed`, `state-leave` and `state-enter`, and continue to the model. A rejection a tool
committed, and a delegation failure still outstanding, SHALL be routed once the model has finished
in the failing state; the committed rejection is the reason when there is one, else every
outstanding failure in the order they failed, each with the arguments of its call. A human `on_error` target SHALL be presented at once,
owing a closing message. Without `on_error`, the turn SHALL end `rejected` with the reason. A
session short of its trigger's `returns` is not a state failure and SHALL NOT route through
`on_error`.

#### Scenario: Hook error routes to the error state

- **WHEN** a state declares `on_error: escalate` and its `after` hook throws
- **THEN** the run routes to `escalate` with an `[error]` runtime note naming the failure

#### Scenario: A recovered delegation failure does not route

- **WHEN** a state declaring `on_error: failed` calls `archmax_workflow_enrich`, the child fails,
  a later call of `enrich` from that state with the same arguments succeeds, and the model finishes
- **THEN** the session completes in that state and no `state-error-routed` is emitted

#### Scenario: A committed rejection still routes after a successful delegation

- **WHEN** a call is blocked by an unresolvable `${{…}}` guard in a state declaring
  `on_error: failed`, and a delegation call from that state then succeeds
- **THEN** the run routes to `failed` with the guard's reason

### Requirement: Terminal states and the terminal after hook

A state with no transitions SHALL be terminal: `archmax_advance` is not disclosed there, and the turn
completes with `status: completed` and a `state-leave` event when the model finishes without tool
calls and the session is not parked. A terminal state's `after` hooks SHALL run at that completion:
`ok` completes; `correct` or `veto` appends an `[after]` runtime note asking for a revision and
returns to the model; a terminal failure routes through `on_error`. Once the `after` hooks pass, a
completing session whose trigger declares `returns` SHALL be held to them as "A session short of its
returns settles on what it set" states.

#### Scenario: Terminal after hook asks for a revision

- **WHEN** the agent finishes in a terminal state whose `after` hook returns `correct` within budget
- **THEN** an `[after]` runtime note is appended and the model is called again in the same state
