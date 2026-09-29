## MODIFIED Requirements

### Requirement: The handoff message

A parked session SHALL speak before it suspends: the runtime spends exactly one reply-only model
call — handed the parked state's tool list like any other call in that state, text the only
product — when a session parks by `archmax_advance` into a
human state (always), by `archmax_wait` (only when the agent has said nothing since the last message
that opened a turn), when a decision or `on_error` routes it into another human state, when a
delegated child's decision is presented, and when a person replies to a parked session. The reply
SHALL be composed by the model from the transcript and a runtime directive, never a fixed string or
an authored notice; a human state's `instructions` SHALL be withheld from it. The turn SHALL be one
model call: no text leaves the park unchanged without a retry, and a tool call the model makes is
refused by the kernel's reply-only rule, after which the session suspends without another model
call. That reply SHALL be the park's `reply` on every surface.

The directive SHALL head the volatile block `## This run is parked` and open with one of four
shapes chosen structurally from the state: answering a person's message while a decision is pending
(the model cannot make, predict or announce it); waiting for something from outside (`pendingInput`,
naming the reason); having been routed to a human state by a runtime note; or having just handed the
run to a person. Each SHALL end with the same instruction — one short message, no tool calls because
every call is refused, the run stays parked until someone else acts — and SHALL label the state by
slug and title.

#### Scenario: Silent handoff into a human state speaks

- **WHEN** the agent records a refund with tool calls only and advances into `refund-review`
- **THEN** one reply-only call runs before the session suspends and its text is the outcome's `reply`

#### Scenario: A wait that already spoke spends no extra call

- **WHEN** the agent asks for an order id and then calls `archmax_wait`
- **THEN** no reply-only call runs and the park's `reply` is the question already asked

#### Scenario: A runtime note opens the silence window

- **WHEN** a delivered firing resumes a run and it calls `archmax_wait` without writing text after
  the arrival
- **THEN** one reply-only call runs, because the arrival note opened a turn

#### Scenario: Answering while a person decides

- **WHEN** the last transcript message is a person's message on a session parked at a human state
- **THEN** the directive says a person is deciding and the model cannot make, predict or announce
  that decision

#### Scenario: A tool call on the handoff turn is refused and the session suspends

- **WHEN** the agent advances into `refund-review` and the model answers its reply-only call with a
  call to `read_file`
- **THEN** the call is refused with `tool.reply-only` and the tool never runs, no further model call
  is made, and the session is parked at `refund-review` awaiting a decision
