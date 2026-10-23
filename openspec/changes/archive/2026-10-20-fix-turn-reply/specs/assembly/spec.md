## MODIFIED Requirements

### Requirement: `send` is the one entry into a session

`agent.workflow.send(sessionId, input, config?)` SHALL accept a turn (`{ message, trigger?, variables?, sessionPath? }`) or a resume payload (`{ decision }` or `{ delivery }`) and settle to one `Outcome` whose `disposition` is `turn`, `decide`, `reply` or `deliver`. A turn SHALL be resolved through `resolveSession` first: a new or finished session takes it as its next turn; a session parked at a human state has it answered as a reply (`reply`); a session parked with `archmax_wait` has its trigger, variables **and message** delivered (`deliver`) — the message travels with the firing rather than being dropped. A session that ends rejected SHALL settle an `Outcome` of kind `rejected` carrying `rejected`, the reason the runtime committed, and every resume outcome (`DecideOutcome`) SHALL carry it the same way. A session that ends with `archmax_raise` SHALL settle an `Outcome` of kind `failed`. Every finished `Outcome` and `DecideOutcome` that the agent ended SHALL carry `exit` (`SessionExit`): `{ success: true }` for kind `completed`, and `{ success: false, code, reason }` for kind `failed`. A parked or rejected outcome SHALL carry no `exit`. When a parked session's pending decision belongs to a delegated child, the `Outcome` SHALL carry `delegation` (`DelegatedPark`: `workflow`, the child's `sessionId`, `identity`, `dispatchId`, `toolCallId`, calling `state`). A fresh turn on a workflow declaring `disabled: true` SHALL throw `WorkflowDisabledError`; an empty message SHALL throw `EmptyMessageError`. `config` SHALL merge into the invoke config.

#### Scenario: A turn on a new session

- **WHEN** `send("s1", { message: "Which orders are delayed?" })` is called on a fresh session id
- **THEN** one turn runs under `thread_id: "s1"` and one `Outcome` with `disposition: "turn"` is returned

#### Scenario: A decision for a session nobody holds

- **WHEN** `send(id, { decision })` names a session that is not parked at a human state
- **THEN** `SessionNotParkedError` is thrown and the graph is not invoked

#### Scenario: A completed session carries a successful exit

- **WHEN** a turn completes without `archmax_raise`
- **THEN** the `Outcome` has kind `completed` and `exit: { success: true }`

#### Scenario: A session that raised settles failed

- **WHEN** the agent calls `archmax_raise({ code: "orders-unavailable", reason: "The orders API is down." })`
- **THEN** the `Outcome` has kind `failed`, status `failed`, the state it raised in as `state`,
  `exit: { success: false, code: "orders-unavailable", reason: "The orders API is down." }`, and
  `reply` holding what the agent said this turn

#### Scenario: A decision that leads to a raise

- **WHEN** a person's decision routes a session to a state whose agent then raises
- **THEN** the `send` with `{ decision }` settles an `Outcome` of kind `failed` with the exit record

## ADDED Requirements

### Requirement: An outcome's reply is what the agent said this turn

Every outcome `send` settles (`Outcome`, and the `DecideOutcome` and `ReplyOutcome` that `decide`, `reply` and `deliver` return) SHALL carry `reply`: the text of every assistant message the turn added to the session's transcript, in order, each trimmed, empty ones skipped, joined by a blank line (`\n\n`). Runtime notes SHALL never contribute text. A runtime note of kind `after` (a terminal state's completion check asking for a revision) SHALL discard the text collected before it in the same turn, so `reply` holds only what came after the last such note. No other note kind SHALL discard text. A turn that added no assistant text SHALL have `reply: ""`, whatever earlier turns said. A turn's messages are those after the transcript's length as it stood before the turn began; messages the runtime rewrites ahead of that point SHALL NOT bring earlier assistant text into `reply`.

#### Scenario: Text next to an advance reaches the person

- **WHEN** in one turn the agent writes "X" in the message that calls `archmax_advance` from `a` to `b`, and then writes "Y" in `b`
- **THEN** the outcome's `reply` is "X\n\nY"

#### Scenario: A silent turn says nothing

- **WHEN** a turn ended with the agent saying "Y", and the next turn on the same session adds no assistant text
- **THEN** the second outcome's `reply` is ""

#### Scenario: A revision replaces the rejected draft

- **WHEN** the agent answers "draft" in a terminal state, its `after` hook returns `correct`, and the agent then answers "final"
- **THEN** the outcome's `reply` is "final"

#### Scenario: A park's handoff is part of the turn

- **WHEN** the agent writes "Your refund is eligible" next to an advance into a human state, and the reply-only handoff call writes "A reviewer will confirm it"
- **THEN** the parked outcome's `reply` is "Your refund is eligible\n\nA reviewer will confirm it"

#### Scenario: A decision that ends the session without the agent speaking

- **WHEN** a decision routes a parked session to a terminal state and the agent adds no text
- **THEN** the `DecideOutcome`'s `reply` is "", not the park's handoff message

#### Scenario: A reply to a parked session

- **WHEN** a person sends "Any news?" to a session parked at a human state and the reply-only call answers "Still with a reviewer"
- **THEN** the `ReplyOutcome`'s `reply` is "Still with a reviewer"
