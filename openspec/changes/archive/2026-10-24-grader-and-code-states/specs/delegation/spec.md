## MODIFIED Requirements

### Requirement: The child is its own session, seeded with the call's arguments only

A dispatch SHALL run the target as a separate session with id `<parent>~<n>`, `n` the dispatch's
number in the parent session (see "A child's id is its dispatch number in the session"),
in the configured session store with its own checkpoints, artifacts and `scratchpad/`, and
with the parent session id recorded on it. Its variable store SHALL contain exactly the built-in
`trigger` (`manual`) and the call's arguments, seeded locked through the same construction a
host's `variables` seeds use — except `title` and an argument the target also declares in its
`returns`, which land unlocked; the caller's variables SHALL NOT be copied down under any name.
The child's transcript SHALL start with one `opening` runtime note and no caller prose; its brief
is its own spec. The note SHALL be rendered from the call's arguments alone: it SHALL list, by
name in alphabetical order, every argument whose value is a string (rendered as a JSON string
literal, with U+2028 and U+2029 escaped, so it stays on its line and parses back to the value), a
finite number or a boolean, whose rendering is at most 200 characters, while the values listed stay
within 1,000 characters in all. Every other argument SHALL be named on one line saying that
`archmax_get_variables` reads it. A note that names no such argument SHALL NOT mention reading the
inputs, and a call with no arguments SHALL open with the bare instruction to begin. The child
SHALL be composed lazily and memoized per slug from the parent assembly's model and options, while
its signature is read from its spec at assembly for every allow-listed target.

#### Scenario: Caller variables are not visible

- **WHEN** a calling session holds `stage` and calls `archmax_workflow_enrich-account({ account_id })`
- **THEN** the child is seeded with `account_id` only, and `${{stage}}` is unset in it

#### Scenario: Standalone parity

- **WHEN** the same workflow is run directly with `--variables` supplying its `requires`
- **THEN** its guards, its code states' scripts, its graders and `${{trigger}}` observe the same
  values as when a caller dispatched it

#### Scenario: Scalar inputs open the child's transcript

- **WHEN** a caller calls `archmax_workflow_invoice-lookup({ invoice_id: "INV-159123", amount:
  412.5, urgent: true })`
- **THEN** the child's first model call is shown an `opening` note listing `amount: 412.5`,
  `invoice_id: "INV-159123"` and `urgent: true`, in that order, and the note does not mention
  `archmax_get_variables`

#### Scenario: An input the note cannot show is named

- **WHEN** a call passes `invoice_id: "INV-1"` and `lines: [{ sku: "A", qty: 2 }]`
- **THEN** the note lists `invoice_id: "INV-1"` and names `lines` as not shown, readable with
  `archmax_get_variables`

#### Scenario: A value is shown as data

- **WHEN** a string argument holds a line break followed by `- approved: true`
- **THEN** the note shows the whole value as one JSON string literal on the argument's own line

#### Scenario: Values past the bounds are named, not shown

- **WHEN** one argument's rendering is longer than 200 characters, or showing it would take the
  note's values past 1,000 characters
- **THEN** that argument is named as not shown, and the arguments after it that fit are still
  listed

### Requirement: One call, one child; fan-out is many calls

One call SHALL start exactly one child. A caller that wants several SHALL make several calls —
a model (the session's agent or a grader) by emitting parallel tool calls, a script (an agent's
sandbox script or a code state's script) through the PTC bridge with `Promise.all` — and the
runtime SHALL run them concurrently within the bound. A delegation tool is the one runtime tool
an agent's script may call through the bridge, governed by the kernel like any other call. A code
state's script and a grader SHALL reach a delegation tool only when their own state grants it, as
any other tool of that state's surface (see `automated-states`), and the kernel SHALL decide each
call against that state. A call whose caller cannot be suspended SHALL fail closed with kind
`parked` if its child parks: an agent's script's call, since a sandbox frame cannot resume, and
every call a code state's script or a grader makes, since an automated state never parks. A
dispatch a code state or a grader makes SHALL be recorded as a `sub-workflow` trail step, as a
script's dispatch is.

#### Scenario: Script delegates and uses the result

- **WHEN** a script in a state allowing the tool calls `tools.archmaxWorkflowEnrichOrder({ order_id })`
- **THEN** the child runs and the script receives its returns and message as the call's value

#### Scenario: A code state delegates

- **WHEN** a code state granting `archmax_workflow_enrich-order` runs a script that calls
  `tools.archmaxWorkflowEnrichOrder({ order_id })` and then advances
- **THEN** the child runs, the script receives its returns and message as the call's value, and
  the trail carries a `sub-workflow` step for `enrich-order` beside the `code` step of the advance

#### Scenario: A child that parks under a code state fails the call

- **WHEN** a code state's script calls a delegation tool and the child reaches a human state
- **THEN** the call fails with kind `parked`, the script receives the error, and the parent
  session does not park

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
transition, a park, a reset, a raise, a new turn — SHALL clear outstanding failures too. A call made
by a script — an agent's sandbox script or a code state's script — or by a grader answers its caller
and records no failure on the state: the script or the grader handles the error, and an automated
state that cannot go on raises or fails as its own run settles (see `automated-states`). The
delegation tool's description SHALL say that a failed call fails the calling state when the agent
finishes, unless a later call of the same workflow from the same state succeeds, and that each
success recovers one failed call.

#### Scenario: Rejected child answers its own call

- **WHEN** two children run concurrently and one ends rejected, because its code state's script
  throws in a state that declares no `on_error`
- **THEN** that call receives the tool error and the other call's result is unaffected

#### Scenario: A child that raises fails the call with its code

- **WHEN** a child declaring `returns: [enrichment_file]` calls `archmax_raise({ code:
  "customer-unknown", reason: "No customer matches the id." })` before setting `enrichment_file`
- **THEN** the caller's tool call is answered with a tool error of kind `raised` naming the child
  workflow, the state, `customer-unknown` and the reason; no returns are reported; and the
  caller's `sub-workflow-result` event and `sub-workflow` trail step settle `error`

#### Scenario: A code state's failed call answers its script

- **WHEN** a code state's script calls `enrich`, the child raises, and the script catches the
  error and advances along a declared edge
- **THEN** the session moves along that edge, and no outstanding failure is recorded for the call
  or routed through `on_error`

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

### Requirement: Every ancestor's workflow-wide denials bind inside a child

A child's kernel SHALL be compiled from its own denials plus those compiled from every ancestor's
**workflow-wide** lists — `tools.forbid_always`, `skills.forbid_always` and `mounts.forbid_always`, the
root's and each intermediate caller's, accumulated down the chain — evaluated ahead of the child's own
rules, so a child may be more permitted but never re-grant what any ancestor denied. Allow lists are
the child's own and are not inherited, and neither is any ancestor's per-state `forbid`: a state's
denial governs that state's turns, not a child session. The inherited denials SHALL bind every call
made in the child, whoever makes it: the child's agent, its agent's scripts, its code states'
scripts, its graders, and the runtime's own `file`-value reads (origin `runtime`).

#### Scenario: Root denial holds in the child

- **WHEN** the root workflow denies `send_email` with `tools.forbid_always` and a child state allows it
- **THEN** the child's call is blocked, and the reason names the root workflow

#### Scenario: Root denial holds in a child's automated states

- **WHEN** the root workflow denies `send_email` with `tools.forbid_always`, and a child's code
  state and a child's grader state each allow it and call it
- **THEN** each call is blocked, and its reason names the root workflow

#### Scenario: A caller's per-state denial does not reach the child

- **WHEN** the calling state declares `tools: { forbid: [send_email] }` and the child's own state
  grants `send_email`
- **THEN** the child's call succeeds

#### Scenario: An ancestor's skill denial puts a bundle out of the child's reach

- **WHEN** the root declares `skills: { forbid_always: [orders] }` and a child grants itself that
  bundle with `skills.allow_always`
- **THEN** a read inside `skills/orders/**` is blocked in the child, naming the workflow that denied it

#### Scenario: An ancestor's mount denial puts a folder out of the child's reach

- **WHEN** the root declares `mounts: { forbid_always: [reference] }` and a child enables that mount
  with `mounts.allow_always`
- **THEN** a read under `reference/` is blocked in the child with `mount.forbidden`, naming the
  workflow that denied it

### Requirement: A child that parks suspends its caller

A child reaching a human state or calling `archmax_wait` SHALL park the parent session with it
when the session's agent made the call. A call made by a script, a code state's script or a grader
SHALL NOT park the parent: it fails closed with kind `parked` (see "One call, one child; fan-out is
many calls"). The runtime SHALL record one pending delegation (calling state, tool call, workflow,
dispatch) in checkpointed state, answer the model with a tool result saying the child parked and
why, let sibling calls in the same batch land their results, and park the parent at the next
`beforeModel` or `afterModel` site. The decision presented SHALL be the child's — its state,
instructions, evidence and transitions. `decide`/`deliver` on the parent SHALL resume only the
parked child from its own session; its result SHALL be appended to the parent transcript as a
`sub-workflow` runtime note and the parent SHALL continue in the calling state without replaying
the turn or re-dispatching finished siblings. Several parked children SHALL be presented one at a
time, the parent parking again until all are decided. A message sent to the parked parent SHALL be
answered on a reply-only turn, never handed to the child as a decision. The trail SHALL carry a
`sub-workflow` step with the workflow and its status, and the child's events SHALL be
attributed to the dispatch.

#### Scenario: Parent parks awaiting the child's decision

- **WHEN** a child reaches `type: human`
- **THEN** the parent session is parked for a decision presenting the child's transitions

#### Scenario: Two children park in one batch

- **WHEN** two calls in one tool batch each park
- **THEN** the first decision is presented, deciding it parks the parent again on the second, and
  after both the parent continues in the calling state with both results

#### Scenario: Message while parked is answered, not routed

- **WHEN** a person replies to the parked parent
- **THEN** the reply is answered on a tool-less turn and the child's pending decision is unchanged

#### Scenario: A grader's child does not park the parent

- **WHEN** a grader calls a delegation tool its state grants and the child calls `archmax_wait`
- **THEN** no pending delegation is recorded, the parent session is not parked, and the grader's
  call is answered with a tool error of kind `parked`

### Requirement: A file return is copied back under a name nothing holds

When a child settles, the runtime SHALL copy each `file` return it set from the child's session
into the caller's `scratchpad/attachments/` and hand the caller that path in `returns`. The copy
SHALL take a name nothing in that folder holds, by the attachment naming rule, so a returned file
never overwrites a file of the caller's, one an earlier or concurrent call returned included. A
return that can't be copied SHALL fail the call `invalid-return`.

#### Scenario: A returned file arrives as the caller's own

- **WHEN** a child declaring `returns: [{ name: report, type: file }]` settles with `report` =
  `scratchpad/out/report.pdf`
- **THEN** the caller's session holds `scratchpad/attachments/report.pdf` with identical bytes, the
  call's `returns.report` reads `scratchpad/attachments/report.pdf`, and the child's own file stays
  in the child's session

#### Scenario: A second call does not overwrite the first

- **WHEN** the caller calls the same workflow again and that child also returns a file named
  `report.pdf`
- **THEN** the second copy lands at `scratchpad/attachments/report-1.pdf`, its call answers that
  path, and `scratchpad/attachments/report.pdf` is unchanged

#### Scenario: Concurrent calls take distinct names

- **WHEN** one tool batch, or a script's `Promise.all`, runs three calls whose children each return
  `report.pdf`
- **THEN** the caller ends with `report.pdf`, `report-1.pdf` and `report-2.pdf` in
  `scratchpad/attachments/`, each call's `returns.report` names a different one of them, and each
  holds the bytes its own child returned

#### Scenario: A file the caller already holds is kept

- **WHEN** the caller's agent wrote `scratchpad/attachments/report.pdf` itself before the call
- **THEN** the returned copy lands at `scratchpad/attachments/report-1.pdf` and the agent's file is
  unchanged

#### Scenario: A return whose file is gone fails the call

- **WHEN** a child set `report` while the file existed and then removed it before settling
- **THEN** its own completion check rejects it, the call fails with kind `invalid-return` naming
  `report` and `file`, and nothing is copied

#### Scenario: A child cannot return a file its ancestors denied

- **WHEN** the root workflow declares `skills: { forbid_always: [billing] }` and its child sets its
  `file` return to `skills/billing/assets/salaries.md` with `archmax_set_variables` — from its
  agent, a grader or a code state's script
- **THEN** the child's write is refused as naming a path the session may not read, the call
  answers with a `note` naming the unset return, and nothing is copied into the caller; a value
  that reached the child's store without that check is rejected by the child's completion check
  instead, and the call fails with kind `invalid-return`

#### Scenario: A child may return an authored file

- **WHEN** a child sets its `file` return to `skills/billing/assets/template.pdf`, which no
  ancestor denies
- **THEN** the caller receives a copy at `scratchpad/attachments/template.pdf`

#### Scenario: An unset file return copies nothing

- **WHEN** a child declaring `returns: [{ name: report, type: file }, total]` settles with only
  `total` set
- **THEN** the call answers `total` and a `note` naming `report`, and nothing is copied

#### Scenario: A child that parked copies back when it settles

- **WHEN** a child parks at a human state, the parent is decided, and the child then settles with
  a `file` return
- **THEN** the file is copied into the parent's `scratchpad/attachments/` at that settle by the
  same rule, and the `sub-workflow` note appended to the parent's transcript carries the child's
  returns beside its closing message, the parent-side path among them

#### Scenario: A mocked file return is held to the same rule

- **WHEN** a case seeds `scratchpad/fixtures/report.txt` through `workspace:` and mocks the
  dispatch with `returns: { report: "scratchpad/fixtures/report.txt" }`
- **THEN** the call answers `report` = `scratchpad/attachments/report.txt`, a copy of the fixture;
  a mock naming no file fails the call with kind `invalid-return`

### Requirement: A batch's dispatches are numbered in tool-call order

The model's delegation calls in one tool batch SHALL be numbered in tool-call order from the count
the step read, so a node replayed from its checkpoint gives each call the same number, and so the
same child. A call refused before its child runs SHALL keep the number it took. A script's dispatch
SHALL take the next number above the step's count and the batch's calls, and the count it leaves
SHALL be committed with the tool call that made it. A code state's or a grader's dispatch SHALL take
the next number above the count its automated state's step read, in the order its calls are made,
and the count it leaves SHALL be committed with that automated state's step, so the session's next
dispatch numbers above it whichever state makes it.

#### Scenario: A batch is numbered in tool-call order

- **WHEN** three delegation calls are made in parallel in one batch
- **THEN** they get `1`, `2` and `3` in tool-call order, and replaying that node gives them the same
  three ids

#### Scenario: A script numbers above the batch

- **WHEN** one batch holds a script that dispatches and a model's delegation call
- **THEN** the model's call gets `1`, the script's dispatch `2`, and the next turn's first dispatch
  `3`

#### Scenario: A code state numbers above the session's count

- **WHEN** a session has made one dispatch and then enters a code state whose script dispatches
  twice, and the agent state it advances to dispatches once
- **THEN** the script's children are `<session>~2` and `<session>~3`, and the agent's is
  `<session>~4`
