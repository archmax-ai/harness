## MODIFIED Requirements

### Requirement: Structural assertions read the session's trail and park

The engine SHALL evaluate these assertions from the view's audit trail, park state and exit record: `succeeded: true` (the turn neither parked, nor ended with `archmax_raise`, nor recorded a failed tool call; a governance rejection is not a failure); `parked: true` (parked on either channel), `parked: decision` / `parked: input` (pinning the channel) or `parked: { channel?, state? }` (pinning the channel and/or the state the session parked in — which `reachedState` cannot express, since a park commits no transition); `raised: true` (the turn ended with `archmax_raise`), `raised: <code>` (pinning the exit code exactly) or `raised: { code?, reason? }` (pinning the code exactly and/or matching the reason with the one partial-match vocabulary, a `/pattern/flags` string included); `reachedState: <slug>` (a committed trail step of any kind but `trigger` has `to` equal to the slug, so a vetoed entry never "reaches" the state); `noTraversal: true` (every trail step is a trigger arrival); `triggerArrival: <id>` (a `trigger` step carries that id as its `reason`, including one delivered into a park); `trail: { to?, kind?, reason?, count }` (at least one field, and the number of steps matching every given field equals `count`). An `raised` mapping with neither field, or an `raised` value of any other shape, SHALL be a schema error.

#### Scenario: Park pinned to channel and state

- **WHEN** a turn parks via `archmax_wait` in `clarify`
- **THEN** `parked: input` and `parked: { channel: input, state: clarify }` pass, while `parked: decision` and `parked: { state: review }` fail with the pinned fields in their detail

#### Scenario: Vetoed entry commits no transition

- **WHEN** the start state's `before` hook vetoes the turn
- **THEN** `noTraversal: true` passes and `reachedState: <start state>` fails

#### Scenario: Trail counting

- **WHEN** a refine loop entered `refund-review` twice and a step declares `trail: { to: refund-review, count: 2 }`
- **THEN** the assertion passes, and its detail reports the expected and observed counts on a miss

#### Scenario: Raise pinned to its code

- **WHEN** a turn ends with `archmax_raise({ code: "orders-unavailable", reason: "The orders API is down." })`
- **THEN** `raised: true`, `raised: orders-unavailable` and `raised: { reason: "/api is down/i" }`
  pass, while `raised: order-not-found` and `succeeded: true` fail with the observed code in their
  detail

#### Scenario: No raise

- **WHEN** a turn completes without `archmax_raise`
- **THEN** `raised: true` fails, with a detail saying the session did not raise

### Requirement: A failed structural assertion halts the case

A failed `succeeded`, `parked`, `raised`, `reachedState`, `trail`, `noTraversal`, `triggerArrival` or `variables` record SHALL stop the case: no further action is driven, no further assertion is evaluated, and every later assertion step is reported `not-executed`. A failed content assertion (`reply`, `calledTool`, `notCalledTool`, `blockedTool`, `usedNoTools`, `ranWorkflow`, `grade`) does not halt. A halt is a verdict, not a case-level error: the result has no `error` field.

#### Scenario: Halt after a failed state assertion

- **WHEN** `reachedState` fails at step 2 and steps 3–6 hold a `send` and three assertions
- **THEN** no further message is sent, the three assertions are `not-executed` with their own indices, and `error` is unset

#### Scenario: Content failure continues

- **WHEN** a `reply` token is missing at step 1
- **THEN** the remaining steps still drive and evaluate

#### Scenario: A failed raise assertion halts

- **WHEN** `raised: orders-unavailable` fails at step 1 and step 2 is a `send`
- **THEN** the message is not sent and step 2 onward is `not-executed`
