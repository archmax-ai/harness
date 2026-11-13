## Purpose

Define what the runtime reports as OpenTelemetry spans and metrics, so a host that registers an
SDK sees each turn, state visit, model call and tool call in the trace it is already in, with
metadata only and the same ids the event stream carries.

## ADDED Requirements

### Requirement: The API is the only dependency

The package SHALL declare `@opentelemetry/api` (`^1.9.0`) as a peer dependency and report through
it alone: it SHALL register no SDK, exporter, context manager or instrumentation. Its tracer and
meter SHALL be named `@archmax-ai/harness`, versioned `PACKAGE_VERSION`. Without a provider the
host registered, a turn's result, events and messages SHALL be exactly what they are without
telemetry.

#### Scenario: No SDK, no spans, no change

- **WHEN** a host that registered no OpenTelemetry provider runs a turn
- **THEN** no span or metric is recorded anywhere
- **AND** the turn's result and its events are identical to the same turn with a provider registered

#### Scenario: The host's SDK receives the harness's spans

- **WHEN** a host registers a tracer provider and runs a turn
- **THEN** the provider receives the turn's spans under the instrumentation scope
  `@archmax-ai/harness` with the package's version

### Requirement: A turn is one span

Every turn on a session — a message, a decision, a reply, a delivery, a sub-workflow child's turn
— SHALL be one span named `invoke_agent <workflow>` (a plain agent's: `invoke_agent`), kind
`INTERNAL`, started in the context active where the turn is invoked and active for the whole turn,
carrying `gen_ai.operation.name`, `gen_ai.agent.name` (governed only), `gen_ai.conversation.id`
and `archmax.turn.resume`.

#### Scenario: The turn span's attributes

- **WHEN** a governed agent for the workflow `support` runs a turn on the session `s-1`
- **THEN** the turn's span carries `gen_ai.operation.name` `invoke_agent`, `gen_ai.agent.name`
  `support`, `gen_ai.conversation.id` `s-1` and `archmax.turn.resume` `false`

#### Scenario: A turn invoked inside a host span is its child

- **WHEN** a host calls `agent.workflow.send(id, { message })` inside its own active span
- **THEN** the turn's `invoke_agent <workflow>` span is a child of the host's span, in its trace

#### Scenario: A decision is a turn

- **WHEN** a host decides a parked session with `agent.workflow.decide`
- **THEN** that resumption is one `invoke_agent` span with `archmax.turn.resume` `true`

#### Scenario: A plain agent's turn

- **WHEN** a plain agent (`workflow: false`) runs a turn
- **THEN** the turn is one `invoke_agent` span with no `gen_ai.agent.name` and no state spans

### Requirement: A turn's span says how it ended

When a turn settles its span SHALL carry `archmax.session.status` (the session's status after it),
`archmax.state` (the state it ended in) and the token totals and cost of the turn's own model calls
under the `gen_ai.usage.*` names. A turn that throws SHALL end with status `ERROR` and an
`error.type`; a session the turn leaves `failed` or `rejected` SHALL too (`session_failed`,
`session_rejected`). A parked turn is not an error.

#### Scenario: A completed turn

- **WHEN** a turn completes in a terminal state after two priced model calls
- **THEN** its span carries `archmax.session.status` `completed`, the terminal state as
  `archmax.state`, the summed input and output tokens and the summed cost

#### Scenario: A raise fails the turn's span

- **WHEN** the agent calls `archmax_raise`
- **THEN** the turn's span ends with status `ERROR`, `error.type` `session_failed` and
  `archmax.session.status` `failed`

#### Scenario: A park is not an error

- **WHEN** a turn parks at a human state
- **THEN** the turn's span carries `archmax.session.status` `awaiting_decision` and its status is
  not `ERROR`

#### Scenario: A thrown turn

- **WHEN** the model endpoint fails and the turn throws
- **THEN** the turn's span ends with status `ERROR` and an `error.type`, and the error reaches the
  caller as before

### Requirement: A state visit is one span

Within a governed turn each visit to a state SHALL be one span named `state <slug>`, kind
`INTERNAL`, child of the turn's span. It SHALL open when the session enters the state, or at the
turn's first work in the state the session is already in (then with `archmax.state.resumed`
`true`), and end when the session leaves the state or the turn ends. It SHALL carry
`archmax.state`, `archmax.state.type` and, when the session leaves it for another state,
`archmax.state.next`.

#### Scenario: An advance closes one state and opens the next

- **WHEN** the agent advances from `triage` to `resolve` in one turn
- **THEN** the turn's span has a `state triage` child with `archmax.state.next` `resolve`, followed
  by a `state resolve` child

#### Scenario: An automated state is a state span

- **WHEN** a code state runs and advances the session
- **THEN** it is one `state <slug>` span with `archmax.state.type` `code`, holding the spans of the
  tool calls its script made

#### Scenario: A session that completes names no next state

- **WHEN** a session completes in its terminal state
- **THEN** that state's span ends with the turn and carries no `archmax.state.next`

#### Scenario: A resumed turn continues in its state

- **WHEN** a reply to a session parked at a human state is answered in that state, which the turn
  does not enter again
- **THEN** the reply's model call opens a `state <slug>` span with `archmax.state.resumed` `true`

#### Scenario: A park

- **WHEN** a session parks at a human state
- **THEN** that state's span carries `archmax.state.parked` (`decision` or `input`) and ends with
  the turn

### Requirement: A failed state visit is an error

A state visit SHALL end with status `ERROR` and an `error.type` when its automated run fails
(`automated_state_failed`), when the runtime routes it through `on_error` (`routed_on_error`, with
`archmax.state.next` the route's target) or when it raises (`raised`, with `archmax.raise.code` when
the raise's code is a short token of letters, digits, `.`, `:`, `_` and `-`).

#### Scenario: A timed-out state routes on error

- **WHEN** a state's model call exceeds its `budget.timeoutMs` and the runtime routes to its
  `on_error` target
- **THEN** that state's span ends with `error.type` `routed_on_error` and the target as
  `archmax.state.next`

#### Scenario: A raise names its code

- **WHEN** a code state raises with the code `invalid-order`
- **THEN** its state span ends with `error.type` `raised` and `archmax.raise.code` `invalid-order`

### Requirement: A model call is one span

Every model call — an agent's or human state's, a park's handoff, a grader's, a plain agent's —
SHALL be one span named `chat <model>` (`chat` when the model has no id), kind `CLIENT`, child of
its state's span (a plain agent's: of the turn's) and active while the call runs. It SHALL carry
`gen_ai.operation.name` (`chat`), `gen_ai.provider.name`, `gen_ai.request.model`,
`gen_ai.conversation.id`, `archmax.state` and `archmax.model.role` (`agent` or `grader`).

#### Scenario: The provider's request nests under the call

- **WHEN** the host has HTTP instrumentation registered and the agent's model call sends a request
- **THEN** the HTTP client span is a child of the `chat <model>` span

#### Scenario: A grader's calls are the grader state's

- **WHEN** a grader state runs
- **THEN** each of its grader's model calls is a `chat <model>` span with `archmax.model.role`
  `grader`, under the grader state's span

### Requirement: A model call's span carries its usage

A model call's span SHALL carry the provider-reported tokens as `gen_ai.usage.input_tokens`,
`gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens` and
`gen_ai.usage.cache_creation.input_tokens`, `gen_ai.response.model` when the response names a
model, `gen_ai.response.finish_reasons` when it gives one, `archmax.response.tool_calls` (how many
tool calls it asked for), and `gen_ai.usage.cost` (USD) only when the model is priced — never
guessed, as usage accounting reports it.

#### Scenario: A priced call

- **WHEN** a model call reports 1,000 input and 200 output tokens on a model the pricing table
  prices
- **THEN** its span carries those token counts and the same cost the call's `model-usage` event
  carries as `costUsd`

#### Scenario: An unpriced call

- **WHEN** a model call reports tokens on a model no price applies to
- **THEN** its span carries the tokens and no `gen_ai.usage.cost`

### Requirement: A failed model call is an error

A model call that throws SHALL end its span with status `ERROR` and `error.type` — the HTTP status
code when the error carries one, else the error's class name — before the error propagates. A call
whose state's `budget.timeoutMs` expires SHALL end its span at the expiry with `error.type`
`timeout`; the late answer SHALL not change the ended span.

#### Scenario: A rate-limited call

- **WHEN** the endpoint answers a model call with HTTP 429 and the call throws
- **THEN** the `chat` span ends with status `ERROR` and `error.type` `429`

#### Scenario: A call over its time budget

- **WHEN** a state's model call outlives its `budget.timeoutMs`
- **THEN** its `chat` span ends when the budget expires, with `error.type` `timeout`

### Requirement: A tool call is one span

Every tool call a model or a script makes SHALL be one span named `execute_tool <tool>`, kind
`INTERNAL`, child of the tool call's span it was made inside, else of its state's span (a plain
agent's: the turn's), active while it runs, carrying `gen_ai.operation.name`, `gen_ai.tool.name`,
`gen_ai.tool.call.id`, `gen_ai.tool.type`, `gen_ai.conversation.id`, `archmax.state` and
`archmax.tool.origin` (`agent`, `grader` or `script`).

#### Scenario: Who made the call

- **WHEN** the agent, a grader, and a script (`archmax_eval`, `archmax_run`, a code state's) each
  call a tool
- **THEN** each call is an `execute_tool <tool>` span with `gen_ai.tool.type` `function` and
  `archmax.tool.origin` `agent`, `grader` and `script` respectively

#### Scenario: A script's calls nest under the script's call

- **WHEN** the agent calls `archmax_eval` and its code calls `tools.read_file`
- **THEN** the `execute_tool read_file` span, `archmax.tool.origin` `script`, is a child of the
  `execute_tool archmax_eval` span

#### Scenario: A control tool is a tool call

- **WHEN** the agent calls `archmax_advance`
- **THEN** that call is an `execute_tool archmax_advance` span under the state it advanced from

### Requirement: A tool call's span says how it ended

A tool call's span SHALL carry `archmax.tool.outcome`: `ok`, `parked` (the call parked the
session, or a sub-workflow's child it dispatched stopped for a person), or one of the failures `error`, `blocked`, `unknown`
and `cancelled`, which end the span with status `ERROR` and the `error.type` `tool_error`,
`blocked`, `unknown_tool` and `cancelled`. A call the kernel blocked SHALL carry the kernel's rule
id as `archmax.tool.rule`, and a call blocked for an unresolved `${{name}}` argument the rule
`unresolved-argument`.

#### Scenario: A call the kernel blocks

- **WHEN** the agent calls a tool its state does not grant
- **THEN** the call's span carries `archmax.tool.outcome` `blocked`, `archmax.tool.rule`
  `tool.not-allowed` and `error.type` `blocked`

#### Scenario: A script's blocked call

- **WHEN** a code state's script calls a tool its state does not grant
- **THEN** the call's span, `archmax.tool.origin` `script`, carries `archmax.tool.outcome`
  `blocked` and the kernel's rule id

#### Scenario: A wait parks

- **WHEN** the agent calls `archmax_wait` and the session parks for input
- **THEN** the call's span carries `archmax.tool.outcome` `parked` and is not an error

#### Scenario: An argument that names no set variable

- **WHEN** the agent or a grader calls a tool with `${{name}}` in an argument and `name` is not set
- **THEN** the call's span carries `archmax.tool.outcome` `blocked` and `archmax.tool.rule`
  `unresolved-argument`

#### Scenario: A tool that fails

- **WHEN** a host tool throws
- **THEN** its span carries `archmax.tool.outcome` `error` and `error.type` `tool_error`, and the
  model reads the error as before

### Requirement: A sub-workflow's child session nests under its call

A sub-workflow's child turn SHALL be an `invoke_agent <workflow>` span — its workflow's slug, the
child session's id — child of the `execute_tool archmax_workflow_<slug>` span that dispatched it,
carrying `archmax.dispatch.id`. A turn's token totals and cost SHALL count its own session's model
calls only, never a child's.

#### Scenario: A child that parks

- **WHEN** the agent calls `archmax_workflow_refund` and the child session parks at a human state
- **THEN** the child's `invoke_agent refund` span ends with `archmax.session.status`
  `awaiting_decision` and not as an error, and the delegation's span ends with
  `archmax.tool.outcome` `parked`

#### Scenario: A delegation

- **WHEN** the agent calls `archmax_workflow_refund` and the child session completes
- **THEN** the child's `invoke_agent refund` span, with the child's states and calls beneath it, is
  a child of the `execute_tool archmax_workflow_refund` span
- **AND** the parent turn's totals leave out the child's tokens

### Requirement: Spans share the event stream's ids

A span's `gen_ai.conversation.id` SHALL be the session id the events of the same work carry in
their envelope, `gen_ai.tool.call.id` the `callId` of the call's `tool-called`, `tool-result` and
`tool-blocked` events, and `archmax.state` their `state`, so a host can join spans to events and
transcripts.

#### Scenario: Joining a tool span to its events

- **WHEN** a host reads a governed call's `tool-called` event and the span with the same
  `gen_ai.tool.call.id`
- **THEN** both name the same tool, state and session

### Requirement: Spans carry metadata only

No span name, attribute, event or status message, and no metric attribute, SHALL carry message
text, a prompt, a completion, tool arguments or results, a variable's value, an error's message or
a blocked call's reason. Exceptions SHALL not be recorded. A tool name that is not a plain tool
identifier, and the name of a call no tool answers to, SHALL be reported as `unknown`.

#### Scenario: Nothing the session said leaves in a span

- **WHEN** a turn's message, the model's replies, tool arguments, tool results, variable values and
  a tool's error message each carry a distinct marker string
- **THEN** no recorded span name, attribute value, span event or status message, and no metric
  attribute, contains any marker

#### Scenario: A model calls a tool that does not exist

- **WHEN** the model calls a tool no tool answers to, by free text or by an identifier
- **THEN** the call's span is named `execute_tool unknown` and carries `archmax.tool.outcome`
  `unknown`, whatever name the model used

### Requirement: Model calls are measured

Every model call SHALL record `gen_ai.client.operation.duration` (seconds) and, for each of
`input` and `output` it reports, `gen_ai.client.token.usage` (`gen_ai.token.type`), with the bucket
boundaries the GenAI conventions advise. Their attributes SHALL be `gen_ai.operation.name`,
`gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model` and, on a failed call,
`error.type` — no session, state or user.

#### Scenario: One call, three measurements

- **WHEN** a model call reports 500 input and 40 output tokens
- **THEN** one duration and two token-usage measurements are recorded, typed `input` and `output`,
  with the call's provider and model and no session id
