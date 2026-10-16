## ADDED Requirements

### Requirement: A child's id is its dispatch number in the session

A child session's id SHALL be `<parent session id>~<n>`, where `n` numbers the parent session's
dispatches from 1 across all its turns; a grandchild SHALL be `<parent>~<n>~<m>`. The count SHALL be
part of the parent session's checkpointed state (`dispatchCount`), never process memory. A dispatch
SHALL take its number when it is made and record it as the pending delegation's `identity`, and
resume SHALL read the recorded identity as it is, never re-deriving it.

#### Scenario: Dispatches number across turns on fresh agents

- **WHEN** two turns of one session, each on a fresh `createAgent`, dispatch the same workflow from
  the same state
- **THEN** the children are `<session>~1` and `<session>~2`, each with its own thread and its own
  folder

#### Scenario: A parent resumes on the child it parked on

- **WHEN** a parent parked on child `~2` is decided on a fresh `createAgent`
- **THEN** the decision reaches `~2`, and `~1` is untouched

### Requirement: A batch's dispatches are numbered in tool-call order

The model's delegation calls in one tool batch SHALL be numbered in tool-call order from the count
the step read, so a node replayed from its checkpoint gives each call the same number, and so the
same child. A call refused before its child runs SHALL keep the number it took. A script's or a
hook's dispatch SHALL take the next number above the step's count and the batch's calls, and the
count it leaves SHALL be committed with the tool call or model step that made it.

#### Scenario: A batch is numbered in tool-call order

- **WHEN** three delegation calls are made in parallel in one batch
- **THEN** they get `1`, `2` and `3` in tool-call order, and replaying that node gives them the same
  three ids

#### Scenario: A script numbers above the batch

- **WHEN** one batch holds a script that dispatches and a model's delegation call
- **THEN** the model's call gets `1`, the script's dispatch `2`, and the next turn's first dispatch
  `3`

### Requirement: A dispatch is named by its path below the root

A dispatch's `dispatchId` SHALL be the child's session id with the root session's id and its
separator taken off: `1`, `2`, and `1~1` for the first dispatch made inside `1`. The
`sub-workflow-*` events, a pending delegation and the child's session id SHALL name a child the same
way. `parentSessionIdOf` and `isChildSessionOf` SHALL read `~` and a number from 1 as a child, and
SHALL still read the 0.5 shape (`<state>:<workflow>:<ordinal>`) as one, which nothing mints.

#### Scenario: A grandchild is named by its path

- **WHEN** child `1` makes its first dispatch
- **THEN** the grandchild's session id is `<root>~1~1`, its dispatch id is `1~1`, and its
  `sub-workflow-start` event carries `1` as the dispatch it was emitted inside

#### Scenario: A park from before the upgrade resumes

- **WHEN** a parent parked before the upgrade, its pending delegation recording the identity
  `start:enrich:0`, is decided
- **THEN** the child `<parent>~start:enrich:0` is resumed under that identity and completes

## MODIFIED Requirements

### Requirement: The child is its own session, seeded with the call's arguments only

A dispatch SHALL run the target as a separate session with id `<parent>~<n>`, `n` the dispatch's
number in the parent session (see "A child's id is its dispatch number in the session"),
in the configured session store with its own checkpoints, artifacts and `scratchpad/`, and
with the parent session id recorded on it. Its variable store SHALL contain exactly the built-in
`trigger` (`manual`) and the call's arguments, seeded locked through the same construction a
host's `variables` seeds use; the caller's variables SHALL NOT be copied down under any name.
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
- **THEN** its guards, hooks and `${{trigger}}` observe the same values as when a caller dispatched it

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
