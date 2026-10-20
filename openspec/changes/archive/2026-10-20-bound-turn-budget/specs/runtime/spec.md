## MODIFIED Requirements

### Requirement: Budgets

A state's `budget.maxTurns` SHALL be an exact count of model calls made in the state since it was
entered: the call that would exceed it is not made and the exhaustion is routed as a failure; the
count resets on every transition and at each turn boundary. `budget.timeoutMs` SHALL race the
state's model call against a timer; on expiry the runtime substitutes a budget-exhausted result,
removes it from the transcript and routes the failure through `on_error`, without aborting the
in-flight request. `budget.maxParks` SHALL cap `archmax_wait` parks per state within a turn, checked
before the park is committed; an exceeded bound refuses the wait and commits `rejected` naming the
state and the bound. A delegated child's park SHALL NOT count. The workflow's `budget.maxModelCalls` SHALL be an exact count of the model calls one turn makes across every state, where a turn is one invocation (a message, a decision, a reply or a delivery); a park's single reply-only call is not counted, and an invocation the runtime's turn runner did not drive (a host invoking the graph directly) is not bounded by it: the call that would exceed it is not made and the exhaustion is routed as a failure of the current state, naming the bound. A turn SHALL route a turn-budget exhaustion at most once; after it, the error handler's calls are bounded by its own `maxTurns` and the turn's step limit, not by the turn budget again. While a fifth of the turn budget or less remains, every model call's "Current state" block SHALL state how many calls the turn has left and tell the agent to finish its work and answer the person. A delegated child's turn SHALL count against its own workflow's budget, never its caller's. Every exhaustion SHALL route through
`on_error` when declared, else end the turn rejected.

#### Scenario: Turn budget is exact

- **WHEN** a state declares `maxTurns: 8` and the agent advances on its fifth model call
- **THEN** the state completes normally

#### Scenario: Timeout substitutes a result

- **WHEN** a model call in a state with `timeoutMs: 1000` has not returned after one second
- **THEN** the failure is routed through `on_error` and the request itself is not aborted

#### Scenario: A cycle between states exhausts the turn budget

- **WHEN** a workflow declares `budget: { maxModelCalls: 10 }` and the agent advances back and forth between two states on every call
- **THEN** the eleventh call is not made, the failure routes through the current state's `on_error` when declared, else the turn ends rejected naming `maxModelCalls: 10`, and no `GraphRecursionError` is thrown

#### Scenario: The budget is counted per invocation

- **WHEN** a turn makes 30 calls and parks with `archmax_wait`, and a delivery resumes it under `maxModelCalls: 50`
- **THEN** the delivery may make 50 calls of its own

#### Scenario: The agent is warned before the budget runs out

- **WHEN** a turn under `maxModelCalls: 50` is about to make its forty-first call
- **THEN** that call's "Current state" block says the turn has ten model calls left and to finish and answer the person, and its fortieth call carried no such line

#### Scenario: The error handler is not starved by the budget it was routed for

- **WHEN** the turn budget is exhausted in `a`, whose `on_error` is `handle`
- **THEN** `handle` makes its model calls and the turn ends there, and the turn budget does not route a second time

## ADDED Requirements

### Requirement: A turn's step limit follows its budget

When the caller supplies no `recursionLimit`, every invocation of a governed session (a turn, a decision, a reply, a delivery, and a delegated child's run) SHALL run under a step limit derived from its workflow's `budget.maxModelCalls`, large enough that the turn budget and the error handler it routes to are exhausted before the step limit is reached, and never below the 400 steps a turn runs under today. A `recursionLimit` the caller supplies in the invoke config SHALL take precedence.

#### Scenario: A raised budget raises the step limit

- **WHEN** a workflow declares `budget: { maxModelCalls: 200 }` and a turn makes 150 model calls while moving forward through its states
- **THEN** the turn completes without a `GraphRecursionError`

#### Scenario: The caller's limit wins

- **WHEN** a host calls `send(id, input, { recursionLimit: 30 })`
- **THEN** the turn runs under a step limit of 30

### Requirement: A turn that throws ends the session failed

When an invocation of a governed session throws (the step limit, a model failure, a cancellation, any other error) and the session's checkpointed status is still `running`, the runtime SHALL commit `status: failed` with an exit record before the error leaves `send`, `decide`, `reply` or `deliver`: code `recursion-limit` for a `GraphRecursionError`, `turn-cancelled` for an aborted invocation, and `turn-error` otherwise, with the error's message as the reason. It SHALL then rethrow the original error. A session whose status is not `running` (parked, or never checkpointed) SHALL be left as it is. The next message to a session failed this way SHALL resolve as a fresh turn from its retained position, as for any finished session, and its summary SHALL report the exit.

#### Scenario: A model failure does not strand the session

- **WHEN** the model endpoint fails mid-stream during a turn on session `s1`
- **THEN** `send` rejects with the endpoint's error, `sessions.get("s1")` reports `status: failed` with `exit.code: "turn-error"`, and the next `send("s1", …)` runs a fresh turn instead of throwing `SessionNotResumableError`

#### Scenario: The step limit ends the session failed

- **WHEN** a turn reaches its step limit
- **THEN** `send` rejects with the `GraphRecursionError`, and the session is `failed` with `exit.code: "recursion-limit"`

#### Scenario: A cancelled turn ends the session failed

- **WHEN** the host aborts a turn mid-run
- **THEN** `send` rejects with the abort, and the session is `failed` with `exit.code: "turn-cancelled"`

#### Scenario: A park is not overwritten

- **WHEN** a turn has committed a park and then throws
- **THEN** the session stays parked
