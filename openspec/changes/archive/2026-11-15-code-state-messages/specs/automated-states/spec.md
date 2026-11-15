## ADDED Requirements

### Requirement: A code state adds messages to the session

A code state's script SHALL add a message to the session with `archmax_add_message({ text })`.
Each accepted call SHALL record one message, before or after the state's decision; a `text` that
is empty or only whitespace SHALL be refused with a rejection the script can catch. Every message
the run recorded SHALL join the session's transcript as an assistant message when the run
settles, in the order the calls were made, ahead of the runtime note of the state's move or raise.

#### Scenario: A terminal code state answers without a model call

- **WHEN** a turn opens at the terminal code state `status`, whose script reads `variables.order_id`
  and calls `tools.archmax_add_message({ text: "Order ORD-1001 shipped on 3 May." })`
- **THEN** the session completes, the transcript ends with an assistant message holding that text,
  the outcome's `reply` is "Order ORD-1001 shipped on 3 May.", and no model was called

#### Scenario: Messages precede the move's note

- **WHEN** a code state's script adds "Checking your order." and then "It shipped.", and advances
  to the agent state `answer`
- **THEN** the transcript holds the two assistant messages in that order followed by the `code`
  runtime note, and the agent's first model call in `answer` reads both before the note

#### Scenario: A blank message is refused

- **WHEN** a code state's script calls `tools.archmax_add_message({ text: "   " })`, catches the
  rejection, and advances
- **THEN** the session moves, and no assistant message was added

### Requirement: A code state's messages stand only when its run does not fail

The messages a code state's run recorded SHALL be committed when the run settles as advanced,
raised or completed. When the run fails — the script throws or times out, or a non-terminal state
finishes undecided — they SHALL be discarded with its move: a discarded message SHALL never reach
the transcript, the turn's `reply` or the event stream, so a retry through `on_error` does not
repeat what a failed run said.

#### Scenario: A raise keeps what was said

- **WHEN** a code state's script adds "We cannot refund an order older than 30 days." and then
  calls `tools.archmax_raise({ code: "refund-window", reason: "the order is 41 days old" })`
- **THEN** the session ends `failed` with the code `refund-window`, and the outcome's `reply` is
  "We cannot refund an order older than 30 days."

#### Scenario: A failed run says nothing

- **WHEN** a code state's script adds "Your refund is on its way." and then throws
- **THEN** the state fails through its `on_error`, no transcript message holds that text, and no
  `agent-text` event carries it

### Requirement: A code state's message is read as the session's own

A committed message SHALL read as the session speaking, on every reader: it is part of the turn's
`reply`; it is reported as an `agent-text` event naming the code state, whose `messageId` is the
id the transcript message carries; the session's agent reads it on its next model call; and the
history a later grader or code state reads holds it as an `assistant` message. The history the
run that added it reads SHALL NOT hold it.

#### Scenario: The event names the transcript's message

- **WHEN** a terminal code state adds "Done." and finishes
- **THEN** one `agent-text` event with the code state's slug and the text "Done." is emitted, and
  its `messageId` is the id of the transcript message holding "Done."

#### Scenario: A later state reads it in the history

- **WHEN** code state `look-up` adds "Looked it up." and advances to code state `check`, whose
  script reads `JSON.parse(await tools.archmax_get_history()).messages`
- **THEN** `check` reads `{ role: "assistant", text: "Looked it up." }` ahead of the `code` runtime
  note, and the history `look-up` read in its own run holds no such message

## MODIFIED Requirements

### Requirement: An automated state is offered exactly its state's tools

An automated state SHALL be offered exactly its own state's tool surface:

- the state's own `tools.allow` grants;
- the workflow-wide grant: the workflow's declared `tools.allow_always`, or the default tools when
  it declares none;
- the host's `essentialTools`;
- the automated state's control tools (`STATE_TYPE_TOOLS[type].controls`, see "An automated
  state's controls").

It SHALL NOT be offered a tool its type withholds (`STATE_TYPE_TOOLS[type].withheld`:
`write_todos`, `archmax_eval`, `archmax_run`, `archmax_wait` and `archmax_reset`, and for a grader
state also `archmax_add_message`), whether it arrives as a default tool, through a declared
`tools.allow_always` that lists it, or through the state's own `tools.allow` (see the `governance`
capability). Every call SHALL be decided by the kernel against that state, as the agent's own
calls are, so the state's `forbid`, the workflow's `forbid_always`, its skill and mount grants and
every safety rule bind it. No tool of the assembly outside the surface SHALL be reachable.

#### Scenario: A code state lists only its state's tools

- **WHEN** a workflow without `tools.allow_always` has a code state that grants no host tool, and
  its script lists `Object.keys(tools)`
- **THEN** the listing holds the file tools and the code state's control tools,
  `archmax_get_history` and `archmax_add_message` among them, and no host tool the assembly
  registered, `write_todos`, `archmax_eval` or `archmax_run`

#### Scenario: A workflow-wide grant of a withheld tool stays with the agent

- **WHEN** the root declares `tools: { allow_always: [read_file, write_todos, archmax_eval] }` and
  the session enters a grader state with no `tools` block
- **THEN** the grader is offered `read_file` and its controls, and neither `write_todos` nor
  `archmax_eval`, while the workflow's agent states are offered all three

#### Scenario: A tool outside the surface is absent

- **WHEN** a code state's script reads `tools.query_orders`, a host tool another state grants
- **THEN** the value is `undefined`, and no call to the tool is possible from the script

#### Scenario: A forbid binds a grader's call

- **WHEN** a grader state forbids `read_file` on `skills/**` and the grader calls it on such a path
- **THEN** the call is refused with the forbid's reason, and the grader may continue

#### Scenario: A grant names a tool an automated state never offers

- **WHEN** a code state's `tools.allow` names `archmax_eval`
- **THEN** `archmax validate` reports an error, and the tool is not offered to the script

#### Scenario: A grader is never offered the message control

- **WHEN** a grader state's `tools.allow` names `archmax_add_message`
- **THEN** `archmax validate` reports an error naming the grader state, and the grader is not
  offered the tool

### Requirement: An automated state's controls

A grader state SHALL be offered `STATE_TYPE_TOOLS.grader.controls`: `archmax_advance` (omitted in
a terminal state), `archmax_raise`, `archmax_get_variables`, `archmax_set_variables` and
`archmax_get_history`. A code state SHALL be offered `STATE_TYPE_TOOLS.code.controls`: the same
controls and `archmax_add_message`.

- `archmax_advance` SHALL be validated when called: the edge must be declared and the state's
  `requires` met by the variables at that moment, and evidence is accepted only into a human state.
  A refusal SHALL reject the call with its reason, leaving the state free to try again.
- The first accepted `archmax_advance` or `archmax_raise` SHALL be the state's decision. Every
  later one SHALL be refused.
- The variable tools SHALL behave as the agent's own (locks, `title`, typed and `file` returns).
  A write SHALL be visible to the state's later calls.
- `archmax_get_history` SHALL answer with the session's history (see "The session's history").
- `archmax_add_message` SHALL add a message to the session (see "A code state adds messages to the
  session").
- A control SHALL never be served from a case's mock, as on the agent's own path.

#### Scenario: A grader and a code state share one control set

- **WHEN** a workflow has a non-terminal grader state and a non-terminal code state
- **THEN** each is offered `archmax_advance`, `archmax_raise`, `archmax_get_variables`,
  `archmax_set_variables` and `archmax_get_history`, the code state alone also
  `archmax_add_message`, and neither is offered `archmax_wait` or `archmax_reset`

#### Scenario: An invalid edge is refused and can be retried

- **WHEN** a code state's script calls `archmax_advance` with a `to` its state does not declare, catches
  the rejection, and then advances along a declared edge
- **THEN** the first call rejects naming the valid targets, and the session moves along the second

#### Scenario: A second decision is refused

- **WHEN** a grader calls `archmax_advance` and then `archmax_raise`
- **THEN** the raise is refused because the state already decided, and the session advances

#### Scenario: A control is never mocked

- **WHEN** a case declares a mock for `archmax_advance` and a code state's script calls it
- **THEN** the mock is not served, and the advance is validated and recorded as the state's
  decision

#### Scenario: A write satisfies the state's requires

- **WHEN** a code state that `requires: [verdict]` sets `verdict` with `archmax_set_variables` and then
  advances
- **THEN** the advance is accepted and the variable is committed with the move

### Requirement: Automated runs are observable

A code state's run SHALL be bracketed by `code-start { state, script }` and
`code-result { state, status, durationMs, reason? }`, with `code-output { state, line }` per
console line, reported when the script settles, and one `agent-text { state, text, messageId }`
per message the run committed, after its console lines and before `code-result`. A grader's run
SHALL be bracketed by `grader-start { state }` and
`grader-result { state, status, durationMs, reason? }`. `status` SHALL be `ok` when the run
settled on a decision or a completion and `error` when it failed. Every tool call SHALL emit the
paired tool events, and a move SHALL emit `advance`, `state-leave` and `state-enter`.

#### Scenario: A code state's events

- **WHEN** a code state logs one line and advances
- **THEN** the stream holds `code-start`, the advance call's `tool-called` and `tool-result`, the
  script's `code-output` (console lines are reported once the script settles), then
  `code-result` with `status: "ok"`, `advance`, `state-leave` and `state-enter`, in that order

#### Scenario: A code state's message is reported before its result

- **WHEN** a code state logs one line, adds one message and advances
- **THEN** the stream holds `code-start`, the two calls' `tool-called` and `tool-result` pairs, the
  script's `code-output`, the message's `agent-text`, then `code-result` with `status: "ok"`,
  `advance`, `state-leave` and `state-enter`, in that order
