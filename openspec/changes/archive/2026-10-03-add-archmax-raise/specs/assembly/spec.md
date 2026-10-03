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
  `reply` holding whatever the agent last said

#### Scenario: A decision that leads to a raise

- **WHEN** a person's decision routes a session to a state whose agent then raises
- **THEN** the `send` with `{ decision }` settles an `Outcome` of kind `failed` with the exit record
