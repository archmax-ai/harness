## ADDED Requirements

### Requirement: `archmax_raise` ends the session as a failure

The runtime SHALL expose `archmax_raise({ code, reason })` in every state, terminal states
included. Calling it SHALL always mean failure; the tool SHALL take no argument that declares
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
`on_error`, SHALL run no `before` or `after` hook (the terminal `after` hook included), and SHALL
NOT check the trigger's `returns`.

The tool description and the platform prompt SHALL tell the model to call `archmax_raise` only when
the task cannot be completed and recovery has been tried; never to finish work that succeeded; and
never in place of `archmax_wait` (something has to arrive), `archmax_reset` (a wrong branch) or a
human state (a person has to decide). They SHALL tell the model that any message for the person
belongs in the text of the same assistant message.

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

#### Scenario: A raise bypasses on_error, hooks and returns

- **WHEN** a state declaring `on_error: escalate` and an `after` hook raises, in a session whose
  trigger declares `returns: [summary]` and `summary` is unset
- **THEN** the session ends `failed` in that state: it does not route to `escalate`, the `after`
  hook does not run, and the unset return does not reject it

#### Scenario: A raise replaces a pending rejection

- **WHEN** a sub-run failed earlier in the turn, committing a rejection, and the agent then raises
- **THEN** the session ends `failed` with the agent's code and reason, not `rejected`

## MODIFIED Requirements

### Requirement: The turn boundary opens every turn

The middleware's `beforeAgent` hook SHALL be the turn boundary, run once per invoke and never on a
park resumption (which re-enters at its interrupt through a `Command`). It SHALL resolve the trigger
(the invoke's, else the assembly default, else `manual`) and the position: a first turn opens at the
start state that trigger declares; a later turn continues at the retained position; a retained
position the spec no longer declares reopens at the trigger's start state. It SHALL record
`entryState` once. Every turn SHALL emit `advance` from the session origin to the opening state, then
`state-enter`, and append a `trigger` trail step; `workflow-reset` SHALL be emitted only when a turn
opens at a start state. No transcript message SHALL announce a turn. The boundary SHALL reset the
turn's mechanics only — `rejected`, the exit record, `iterations`, `beforeDone`, `parkCounts`,
`stateTurns`, every park record and phase, `replyOnly`, status to `running` — and retain the
conversation: position, `entryState`, variables, transcript, trail, usage and files. A session in a
terminal state SHALL continue there under that state's governance; `archmax_reset` is the way out.
A session that ended `failed` SHALL take its next turn the same way, continuing at the state it
raised in.

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
