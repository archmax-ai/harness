## MODIFIED Requirements

### Requirement: `archmax_reset` returns the session to its entry state

The runtime SHALL expose `archmax_reset({ reason })` in every state, requiring a non-empty `reason`.
It SHALL move the position to the recorded `entryState` (else the trigger's start state), clear
`iterations`, `beforeDone`, `rejected` and `stateTurns`, append a `reset` trail step with the
reason, and re-enter through the entry state's `before` hook. It SHALL NOT touch messages, variables
(locked seeds included), files or the recorded trail. `tools.forbid_always` MAY ban it.

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
