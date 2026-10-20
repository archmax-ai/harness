## MODIFIED Requirements

### Requirement: Transitions, terminal states and error routes

A state's `transitions` SHALL be a list of `{ to, description?, type? }` where `to` names a
declared state, `description` is a string, and `type` is one of `approve`, `reject`, `refine`,
`none`. An absent, empty or whitespace-only `description` SHALL mark the edge **undescribed**: the
agent routes on the target state's `instructions` instead (see the `governance` capability). A
non-string `description`, and an undescribed edge whose target has no non-blank `instructions`,
SHALL each be a load error addressed to `states.<slug>.transitions.<index>.description`, which
names the edge, stating that the agent routes on the description or else on the target's
instructions, and what to write instead. A state
with no transitions SHALL be terminal: the session completes when the agent finishes there and
`archmax_advance` is not disclosed in it. `on_error`, when declared, SHALL name a declared
state; a state's failure (an exhausted budget, a terminal hook rejection) routes there, and a
state without one ends the session rejected. Transitions carry no preconditions of their own:
an edge is decided only by its existence, the state's `requires`, and the verdicts of the
`after`/`before` hooks.

#### Scenario: Missing description rejected

- **WHEN** a state declares `transitions: [{ to: review }]`, or a `description` that is empty or
  whitespace-only, and `review` declares no `instructions` (or blank ones) — or a `description`
  that is not a string, whatever the target
- **THEN** loading fails with one error addressed to that transition's `description` field, saying
  what the description is for and what to write instead

#### Scenario: Dangling targets rejected

- **WHEN** a transition's `to` or a state's `on_error` names a state that does not exist
- **THEN** loading fails with an error addressed to that field naming the undefined state

#### Scenario: Advance guard without an edge

- **WHEN** a state's `tools.allow` grants `archmax_advance` with `args: { to: [x] }` and
  declares no transition to `x`
- **THEN** `archmax validate` warns that the runtime will block the transition

#### Scenario: An undescribed edge to an instructed state loads

- **WHEN** an agent state declares `transitions: [{ to: lookup }]` and `lookup` declares non-blank
  `instructions`
- **THEN** the spec loads with no error and no warning about the edge, and `description: ""` on the
  same edge loads the same way

### Requirement: Human-state rules are split between schema and lint

A `type: human` state parks the session for a person's decision, so it SHALL declare
`instructions` describing the decision, at least one transition, at most one transition of each
labeled `type` (`approve`/`reject`/`refine`), no transition to itself, and no `before`/`after`
hook (a human state runs no agent turn in which a hook could fire). These SHALL be **lint
errors**: the runtime tolerates them and the spec still loads, while `archmax validate` fails on
them. The shape rules a human state shares with every state — the `type` enum, the transition
`type` enum, an existing `to` — remain schema errors, and so does a non-empty `description` on
each of a human state's own transitions, which an agent state's edge may omit: there it is the
decision's button label for a person, so a human state's decision button labels are guaranteed by
the schema rather than by lint. The
decision record SHALL be built from the state's `title`, `instructions`, declared `evidence`
(leading, deduplicated with any evidence the advancing call attached) and its transitions'
`to`/`description`/`type`.

#### Scenario: Human state without a button label

- **WHEN** a `type: human` state declares a transition with no `description`
- **THEN** loading fails under the strict schema naming that transition's `description` and saying
  that it is the decision's button label, even though the target declares `instructions`

#### Scenario: Hook on a human state

- **WHEN** a `type: human` state declares `after: { rubric: { instructions: … } }`
- **THEN** `archmax validate` reports an error stating the hook can never run and naming the
  agent state it belongs on
