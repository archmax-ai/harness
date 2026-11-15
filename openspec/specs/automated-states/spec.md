# automated-states Specification

## Purpose
Define the two state types the runtime runs itself, `grader` and `code`. Each runs on entry
without a model call of the session's agent, uses only its own state's tools, and leaves the way
every state does: by `archmax_advance`, or by ending the session with `archmax_raise`.

## Requirements

### Requirement: An automated state runs on entry without the agent's model

A state of type `grader` or `code` (an **automated state**) SHALL be run by the runtime whenever
the session's position reaches it: on a turn's opening, an `archmax_advance`, a human decision,
an `on_error` route or a reset. The runtime SHALL make no model call of the session's agent in an
automated state. A reply-only turn SHALL never run in one, since an automated state cannot park.

#### Scenario: Advancing into a code state runs its script

- **WHEN** the agent in an agent state calls `archmax_advance` into a code state
- **THEN** the code state's script runs before the agent's model is called again, and the agent's
  model is not called while the session is in the code state

#### Scenario: A decision routes into a grader state

- **WHEN** a person decides at a human state on a transition into a grader state
- **THEN** the grader runs in that turn, before any model call of the session's agent

#### Scenario: A turn opening at an automated state

- **WHEN** a trigger's entry state is a code state and a turn opens there
- **THEN** the script runs as the turn's first step, and the history it reads with
  `tools.archmax_get_history()` ends with the turn's message

### Requirement: Chained code states make no model call

The runtime SHALL run consecutive automated states, one after the other, with no model call of
the session's agent between them, and SHALL commit each one as its own checkpointed step. A
chain of code states SHALL make no model call at all. A chain that never reaches an agent state,
a human state or a completion SHALL be stopped by the session's recursion limit.

#### Scenario: Three code states in a row

- **WHEN** code state `a` advances to code state `b`, which advances to code state `c`, which
  advances to an agent state
- **THEN** all three scripts run in order, the trail holds a `code` step into `b`, `c` and the
  agent state, and the first model call of the session's agent is made in the agent state

#### Scenario: A chain ending in a terminal code state

- **WHEN** a chain of code states ends in a terminal code state whose script returns
- **THEN** the session completes, and no model was called during the chain

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

### Requirement: An automated state settles into exactly one outcome

An automated run SHALL settle as exactly one of:

- **advanced**: it called `archmax_advance` and finished without error;
- **raised**: it called `archmax_raise`;
- **completed**: a terminal state finished without either call;
- **failed**: it threw, its run timed out or reached its recursion limit, or a non-terminal state
  finished without either call.

A recorded advance SHALL take effect only when the run finishes without error, and a raise
SHALL win over an error. An advance SHALL commit as a move whose trail step kind is the state's
type, and a human target SHALL be parked with its handoff message owed. A raise SHALL end the
session `failed` with its code and reason. A completion SHALL be checked against the trigger's
`returns`. A failure SHALL route through `on_error`, or else end the session rejected.

#### Scenario: Finishing undecided fails closed

- **WHEN** a non-terminal code state's script returns without calling `archmax_advance` or
  `archmax_raise`
- **THEN** the state fails with "code state '<slug>' finished without calling archmax_advance or
  archmax_raise", routed through the state's `on_error`

#### Scenario: An error after an advance

- **WHEN** a script calls `archmax_advance` and then throws
- **THEN** the session does not move, and the state fails with the thrown message

#### Scenario: A raise ends the session

- **WHEN** a grader calls `archmax_raise({ code: "enrichment-incorrect", reason })`
- **THEN** the session ends `failed` with that code and reason in its outcome, and no further
  state runs in the turn

#### Scenario: Advancing into a human state

- **WHEN** a code state advances into a human state
- **THEN** the session parks there for a decision, after the one reply-only handoff message the
  park owes

### Requirement: A completed terminal automated state does not take a new message

A session that completed in a terminal automated state SHALL start its next turn at the entry
state of that turn's trigger, as a session whose retained position the definition no longer
declares does: no agent stands in an automated state to take up a new message, and running the
state again would complete the turn without answering it. A session that failed or was rejected
in an automated state SHALL start its next turn there, running the state again.

#### Scenario: A follow-up after an approved answer

- **WHEN** a session completed in a terminal code state and the person sends another message
- **THEN** the turn opens at the trigger's entry state, the agent answers it there, and the code
  state's script does not run

### Requirement: An automated move is recorded on the trail and in the transcript

Every automated move SHALL commit a trail step `{ to, kind: "grader" | "code", reason }`. It
SHALL also add a runtime note of kind `grader` or `code` that names the state, the target and the
reason. That note is how the next state reads why it was entered. A raise SHALL add a note
naming the code and reason. A grader's own messages SHALL NOT enter the session's transcript.

#### Scenario: A send-back reaches the agent as a note

- **WHEN** a grader advances back to the agent state it grades with
  `reason: "the enrichments miss ORD-1003"`
- **THEN** the agent's next model call reads a `grader` runtime note carrying that reason, and
  the trail records a `grader` step into the agent state

### Requirement: A code state runs its script in the sandbox

A code state SHALL run its `script` (`workflows/<slug>/scripts/<file>`, read from the authoring
backend) in the sandbox, in a fresh REPL per run. The script's default export SHALL be called
with `{ state, trigger, variables, tools }`, `trigger` absent when the turn has none; the script
reads the session through `tools.archmax_get_history()` (see "The session's history"). A script
without a default export SHALL simply run, its return value SHALL NOT be read, and its console
lines SHALL be reported. A script that cannot be read, imports a module other than
`@archmax-ai/harness/*`, or throws SHALL fail the state.

#### Scenario: The script reads its input and moves the session

- **WHEN** a code state's script reads `variables.order_id` and the `messages` of
  `JSON.parse(await tools.archmax_get_history())`, then calls
  `tools.archmax_advance({ to: "answer", reason: "order found" })`
- **THEN** the session moves to `answer` with a `code` trail step carrying that reason

#### Scenario: A missing script

- **WHEN** a code state's `script` names a file the authoring backend does not hold
- **THEN** the state fails with a reason naming the path, and `archmax validate` reports the
  missing file

#### Scenario: Each run starts clean

- **WHEN** a code state is entered twice in one session
- **THEN** the second run sees none of the first run's globals

### Requirement: A grader runs as an isolated subagent

A grader state SHALL run a subagent whose system prompt is the runtime's grader preamble followed
by the state's `instructions`, and whose task names the state and lists its transitions the way
the session's agent is shown an edge: the target's slug, its markers and the edge's
`description`. Its context SHALL be isolated: it SHALL read the session only through its tools,
its tokens SHALL NOT stream as the session's text, and it SHALL write nothing into the session's
checkpoint. The run SHALL end as soon as it decides. It SHALL be bounded by LangGraph's recursion
limit (`DEFAULT_RECURSION_LIMIT`, 400) and by the state's `budget.timeoutMs`, and reaching either
fails the state; no budget counts its model calls. There SHALL be no iteration budget: a grader
that gives up after a number of rounds says so in its instructions and counts them from the
history's trail.

#### Scenario: The grader reads the history and sends the work back

- **WHEN** a grader calls `archmax_get_history`, finds the enrichments incomplete, and calls
  `archmax_advance` back to the agent state
- **THEN** the session moves back with that reason, and the grader made no further model call

#### Scenario: Rounds are counted from the trail

- **WHEN** a grader's instructions say to raise after two send-backs, and the history's trail
  holds two `grader` steps back into the graded state
- **THEN** the grader can count them from `archmax_get_history` and raise on its third run

#### Scenario: A grader that only answers in text

- **WHEN** a non-terminal grader ends its run with a text reply and no tool call
- **THEN** the state fails closed and routes through `on_error`

#### Scenario: A grader's timeout ends its run

- **WHEN** a grader state declares `budget: { timeoutMs: 30000 }` and its subagent has not decided
  30 seconds after it started
- **THEN** the run is aborted, and the state fails with a reason naming `timeoutMs: 30000`, routed
  through the state's `on_error`

#### Scenario: A grader's task lists its edges with their descriptions

- **WHEN** grader state `review-email` declares a transition to `send` described "The email is
  ready to send." and one back to `decide` described "The email needs changes."
- **THEN** the grader's task lists both targets by slug, each with its description, and nothing of
  `send`'s or `decide`'s own `instructions`

### Requirement: The session's history

An automated state SHALL read the whole session, never a window of it, through one tool,
`archmax_get_history`: a grader by calling it, a code state's script by
`tools.archmax_get_history()`. The tool SHALL return JSON `{ messages, trail }`: the session's whole
transcript and its whole trail, oldest first. Both SHALL be built from the session's checkpointed
state as it stood when the automated state was entered, never from the request the runtime
prepared for a model call, so a summary made for the model never reads as the person speaking.

Each message SHALL be `{ role, text, toolCalls?, tool?, id?, note? }`, where `role` is `user`,
`assistant`, `tool`, `system` or `runtime`. An assistant message's calls SHALL be carried as
`toolCalls`, each `{ id?, name, args }`. A tool result SHALL carry its result inline as `text`, the
tool that answered as `tool` and the id of the call it answers as `id`; a result too large for the
transcript SHALL be the transcript's pointer to its offloaded file, as the agent saw it. A runtime
note SHALL be one `runtime` entry naming its kind as `note`. Control calls and runtime notes SHALL
stay in `messages` and take nothing else out of it. Calls a script makes through `tools.*` and a
grader's own calls are not calls of the session's transcript and SHALL NOT appear.

#### Scenario: A code state reads the history through the tool

- **WHEN** a code state's script calls
  `const { messages, trail } = JSON.parse(await tools.archmax_get_history())`
- **THEN** `messages` holds the session's transcript, oldest first, and `trail` its trail ending
  with the step into the code state, the same history a grader at that point reads

#### Scenario: A tool result is read inline

- **WHEN** the agent calls `write_file` on `scratchpad/note.txt` and then advances into a code state
  that reads the history
- **THEN** `messages` holds the assistant entry listing the call with its `id`, `name` and `args`,
  and a `tool` entry with `tool: "write_file"`, the same `id`, and the tool's result as its `text`

#### Scenario: A runtime note in the history

- **WHEN** a decision note precedes the grader's run
- **THEN** the history holds it as one entry with `role: "runtime"` and `note: "decision"`

#### Scenario: Control calls do not hide a tool result

- **WHEN** in one turn the agent calls `lookup`, makes twelve `archmax_get_variables` calls and then
  advances into a code state
- **THEN** the script finds the `lookup` call and its result in the history's `messages`, beside
  the control calls

#### Scenario: The history spans turns

- **WHEN** a session's first turn opens `confirm`, where the agent calls `lookup` and the turn ends,
  and in the next turn the person writes "yes, go ahead" and the agent advances into a code state
- **THEN** the history's `messages` holds both turns, the `lookup` call and its result and the
  person's message included

#### Scenario: A summary is never the person speaking

- **WHEN** the session's transcript has been summarized for the model and an automated state then
  runs
- **THEN** the history it reads, a code state's and a grader's alike, holds the session's
  checkpointed messages and no summary entry

### Requirement: A grader's model is resolved under the grader role

A grader state's model SHALL be resolved once per composition through the assembly's
`modelFactory` under the `grader` role. The requested id SHALL be the state's `model`, else the
workflow's `settings.model`. Without a factory, the default SHALL be the env-configured model at
that id, or the workflow's model when no id is declared. A grader's model calls SHALL be
reported as `model-usage` events under the grader state, and SHALL be added to the session's usage.

#### Scenario: A host routes graders to their own model

- **WHEN** a host's `modelFactory` returns a different model for the `grader` role
- **THEN** every grader state runs on that model, and the session's agent keeps the `agent` role's

#### Scenario: A grader's usage is counted

- **WHEN** a grader makes two model calls reporting usage
- **THEN** two `model-usage` events name the grader state, and the session's usage includes them

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
