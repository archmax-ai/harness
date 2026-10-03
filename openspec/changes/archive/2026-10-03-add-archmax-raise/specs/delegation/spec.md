## MODIFIED Requirements

### Requirement: Every failure fails closed

A child that is rejected, raises with `archmax_raise`, exhausts a budget, errors, or settles without
its returns SHALL answer the call with a tool error (`SubWorkflowError` with its kind) naming the
workflow and the reason, writing no variable and returning no partial result; the calling agent may
retry, route around it, or stop, and the calling state's `on_error` catches an unrecovered failure.
A child that raises SHALL fail with kind `raised`, and the tool error SHALL name the state it raised
from, its `code` and its `reason`, so the calling agent can act on the code or end its own session
with `archmax_raise`. A child that raises SHALL NOT have its returns checked. Refusals
(`depth-exceeded`, `cycle`, `missing-param`, `unresolved-param`, `unknown-workflow`,
`not-delegatable`, `disabled`) SHALL be blocked calls the caller may correct within the turn.
Concurrent children SHALL fail independently.

#### Scenario: Rejected child answers its own call

- **WHEN** two children run concurrently and one is vetoed by its hook
- **THEN** that call receives the tool error and the other call's result is unaffected

#### Scenario: A child that raises fails the call with its code

- **WHEN** a child declaring `returns: [enrichment_file]` calls `archmax_raise({ code:
  "customer-unknown", reason: "No customer matches the id." })` before setting `enrichment_file`
- **THEN** the caller's tool call is answered with a tool error of kind `raised` naming the child
  workflow, the state, `customer-unknown` and the reason; no `missing-return` failure is reported;
  and the caller's `sub-workflow-result` event and `sub-workflow` trail step settle `error`
