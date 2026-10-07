## ADDED Requirements

### Requirement: The call answers with the returns the child set and the closing message

A completed child SHALL answer its tool call with `{ message, returns }` when the target declares
`returns`, and with the closing message alone otherwise. `returns` SHALL carry every declared return
the child set, each conforming to its declared type. A child that finished with some declared returns
unset SHALL still complete the call — it is not handed back for another attempt — and `returns` SHALL
then also carry `note`, reading `Not all return variables were set by the sub-workflow: '<name>', … was
not set.` / `were not set.`, naming every unset one; an unset name SHALL be left out rather than
passed as `undefined`. A declared return holding a value that does not conform to its type SHALL fail
the call with kind `invalid-return` naming the state, the variable and the type, and no partial result
SHALL reach the caller then. `note` SHALL be reserved: a trigger's `returns` may not declare it. A
mocked dispatch SHALL be held to the same rule. Nothing else SHALL cross back: the child's transcript,
trail and every other variable are discarded when it settles. Nothing captures the answer into a
caller variable; an agent that needs one sets it with `archmax_set_variables`, a script writes the
value it received, and the calling state's `requires:` is the guarantee. The delegation tool's
description SHALL say that a run finishing without some returns answers with the ones it set and a
`note` naming the rest.

#### Scenario: Returns delivered by name

- **WHEN** a target declaring `returns: [enrichment_file, delayed]` completes with both set
- **THEN** the caller's tool result carries both under `returns` beside the closing `message`, and no `note`

#### Scenario: A child short of its returns answers with what it set and a note

- **WHEN** a target declaring `returns: [enrichment_file, delayed]` finishes with only
  `enrichment_file` set
- **THEN** the call succeeds at once, with no further model call in the child, and `returns` is
  `{ enrichment_file, note: "Not all return variables were set by the sub-workflow: 'delayed' was not set." }`

#### Scenario: A child that set none answers with the note alone

- **WHEN** a target declaring `returns: [enrichment_file]` finishes without setting it
- **THEN** `returns` is `{ note: "Not all return variables were set by the sub-workflow: 'enrichment_file' was not set." }`
  and the caller's state is not failed

#### Scenario: A child whose typed return does not conform fails closed

- **WHEN** a target declares `returns: [{ name: delayed, type: boolean }]` and its child finishes
  with `delayed` holding `"no"`
- **THEN** it settles rejected with kind `invalid-return` naming the state, `delayed` and
  `boolean`, and no partial result reaches the caller

#### Scenario: note cannot be declared

- **WHEN** a trigger declares `returns: [note]`
- **THEN** the spec fails to load, saying `note` is reserved in `returns`

## MODIFIED Requirements

### Requirement: Every failure fails closed

A child that is rejected, raises with `archmax_raise`, exhausts a budget, errors, or settles with a
mistyped return SHALL answer the call with a tool error (`SubWorkflowError` with its kind) naming the
workflow and the reason, writing no variable and returning no partial result; the calling agent may
retry, route around it, or stop. A child that raises SHALL fail with kind `raised`, and the tool
error SHALL name the state it raised from, its `code` and its `reason`, so the calling agent can act
on the code or end its own session with `archmax_raise`. A child that raises SHALL NOT have its
returns checked. Refusals (`depth-exceeded`, `cycle`, `missing-param`,
`unresolved-param`, `unknown-workflow`, `not-delegatable`, `disabled`) SHALL be blocked calls the
caller may correct within the turn. Concurrent children SHALL fail independently.

Each failed call made by the calling agent SHALL be recorded on its own as an outstanding failure of
the calling state, with the call's arguments as the child was seeded with them (`${{…}}` references
resolved). A call of the **same workflow from the same state**, made in a later model step, that
succeeds SHALL recover **at most one** outstanding failure: the oldest whose arguments it repeats —
compared structurally, object key order ignored — else the oldest of that workflow from that state.
Two successes in one model step SHALL NOT recover the same failure. A failure still outstanding when
the model finishes SHALL be routed through the calling state's `on_error`, or end the turn rejected
without one, and the route SHALL name every outstanding failure with the arguments of its call. A
success of another workflow, a sibling call in the same tool batch, and a rejection with another
cause SHALL NOT recover any failure; whatever clears a committed rejection — a successful
transition, a park, a reset, a raise, a new turn — SHALL clear outstanding failures too. A script's
call answers its script and records no failure on the state. The delegation tool's description
SHALL say that a failed call fails the calling state when the agent finishes, unless a later call of
the same workflow from the same state succeeds, and that each success recovers one failed call.

#### Scenario: Rejected child answers its own call

- **WHEN** two children run concurrently and one is vetoed by its hook
- **THEN** that call receives the tool error and the other call's result is unaffected

#### Scenario: A child that raises fails the call with its code

- **WHEN** a child declaring `returns: [enrichment_file]` calls `archmax_raise({ code:
  "customer-unknown", reason: "No customer matches the id." })` before setting `enrichment_file`
- **THEN** the caller's tool call is answered with a tool error of kind `raised` naming the child
  workflow, the state, `customer-unknown` and the reason; no returns are reported; and the
  caller's `sub-workflow-result` event and `sub-workflow` trail step settle `error`

#### Scenario: A retry that succeeds recovers the failure

- **WHEN** a terminal calling state declaring `on_error: failed` calls `enrich`, the child raises,
  the agent calls `enrich` again from the same state, that child completes, and the agent finishes
- **THEN** the session completes in the calling state, no `state-error-routed` is emitted, and the
  trail records both `sub-workflow` steps, `error` then `ok`

#### Scenario: Another workflow's success recovers nothing

- **WHEN** the call to `enrich` fails and a later call to `audit` from the same state succeeds
- **THEN** the failure of `enrich` routes through `on_error` when the agent finishes

#### Scenario: One retry of two parallel failures still routes the other

- **WHEN** one tool batch calls `enrich` for `ORD-1` and for `ORD-2`, both children fail, and a later
  call of `enrich` for `ORD-1` succeeds
- **THEN** `ORD-1`'s failure is recovered, and when the agent finishes the session routes through
  `on_error` with a reason naming `ORD-2`'s call and not `ORD-1`'s

#### Scenario: Retrying both parallel failures completes

- **WHEN** both of those calls are retried in a later step, for `ORD-1` and `ORD-2`, and both
  succeed
- **THEN** both failures are recovered and the session completes without routing

#### Scenario: A corrected retry recovers one failure, never two

- **WHEN** the failed call was for `ORD-1` and a later call for `ORD-1b` succeeds
- **THEN** the failure is recovered and the session completes; but when two calls had failed, that
  one success recovers only the oldest, and the other still routes

#### Scenario: Two children failing in one batch both route

- **WHEN** one tool batch calls `enrich` for `ORD-1` and for `ORD-2` and both children fail
- **THEN** the turn does not crash, both failures are recorded, and the one `on_error` route names
  both calls

## REMOVED Requirements

### Requirement: The call answers with the declared returns and the closing message

**Reason**: A child that finished without setting every declared return no longer fails the call
with `missing-return`; it completes, and its caller gets the returns it set plus a `note`.

**Migration**: See "The call answers with the returns the child set and the closing message". A
caller that relied on a failed call for a missing return reads `returns.note` instead; a workflow
that declared a return named `note` renames it.
