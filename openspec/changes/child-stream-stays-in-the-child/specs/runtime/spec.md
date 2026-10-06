## MODIFIED Requirements

### Requirement: Text, usage and variable events

The turn runner SHALL drive every turn with LangGraph streaming and emit `agent-text-delta` (state,
text, `messageId` when known) for each text chunk, whether the consumer used `invoke` or `stream`.
After each model call the middleware SHALL emit `agent-text` with the message's full text and its
committed `messageId`, and `model-usage` with input, output and cache token counts, the `model` the
call was priced against — the id the response reported, else the id the runtime asked the endpoint
to run — and `costUsd` only when priced, accumulating the session's `usage` channel. `model` SHALL
be omitted only when neither source names one. A turn that
fails mid-stream SHALL emit one `agent-text` flagged `partial: true` per streamed message before the
error propagates. A landed `archmax_set_variables` SHALL emit `variables-set` (names, `locked`,
`callId`, never values) and, for `title`, `title-set` with the trimmed value; a refused write emits
nothing.

A sub-workflow child's text SHALL reach the event stream only from the child's own turn runner,
carrying the child's `sessionId` and the dispatch's `subWorkflowDispatchId`. A caller's turn runner
SHALL NOT emit a child's text, neither as an `agent-text-delta` nor as a `partial` `agent-text`. A
child SHALL be invoked without its caller's stream handlers; every other callback the caller hands
down SHALL still observe the child's runs.

#### Scenario: Deltas precede the completed text

- **WHEN** the model generates text in state `S`
- **THEN** `agent-text-delta` events with `state: S` arrive before the `agent-text` for that message,
  sharing its `messageId`

#### Scenario: Usage attributes a call that named no model

- **WHEN** a model call in state `S` returns usage without naming a model
- **THEN** its `model-usage` event carries the id the runtime asked the endpoint to run, so the call
  is attributed to a model rather than to nothing

#### Scenario: Concurrent children stream as their own

- **WHEN** state `S` dispatches two children in one tool batch and both stream text at the same time
- **THEN** each child's `agent-text-delta` events carry that child's `sessionId` and its dispatch's
  `subWorkflowDispatchId`
- **AND** the caller's deltas carry only the caller's own text, with `state: S` and the `messageId`
  of the caller's own message

#### Scenario: A failed turn finalizes only its own text

- **WHEN** a caller's turn fails mid-stream after a child it dispatched streamed text
- **THEN** the caller's `partial` `agent-text` holds only the text the caller's own model streamed

#### Scenario: A host's tracer still sees the child

- **WHEN** a host invokes a turn with its own callback handler and the turn dispatches a child
- **THEN** the handler observes every model call the child makes
