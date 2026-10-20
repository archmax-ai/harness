## MODIFIED Requirements

### Requirement: Per-state graph disclosure

The graph SHALL be disclosed the way the tool surface is: only from where the agent stands. On
every model call the runtime SHALL disclose the active state's **outgoing transitions and nothing
else of the graph** — one line per edge carrying the target's slug, its declared `type` when not
`none`, and its `description`. An **undescribed** edge (no `description`, or a blank one) SHALL
carry the target state's `instructions` in its place, quoted under the line and introduced as the
instructions the agent will follow once it is in that state — given for choosing the edge, not to
be followed now. This is the only attribute of another state that SHALL reach a model call, and
only through an undescribed edge of the active state. Otherwise, no other state's slug, `title`, `summary`, hook presence,
`triggers`, `budget`, `requires` or transitions SHALL reach any model call, and neither SHALL a
count of the states, so a state the agent cannot advance to is a state it cannot name.

An edge's line SHALL mark a target that is a **human decision node** or a **terminal** state,
because each changes what the call itself must carry or what follows it — evidence may be attached
only when advancing to a human state, and both mean the agent stops rather than continues. Nothing
further about the target SHALL be rendered beyond an undescribed edge's instructions: the marker
discloses the consequence of taking the edge, not the state on the other side of it.

The active state's own markers SHALL be disclosed in the same block: that it is terminal, and the
presence of its `before`/`after` hooks by kind (a `rubric` hook as the bare word `rubric`, never
its name or any part of its declaration), because a graded exit can return a correction the agent
must act on. The trigger signature SHALL be disclosed for the **run's own trigger only** — the
`requires` it was started with and the `returns` it must set before it completes — never for the
triggers of states this run did not enter.

A reply-only turn SHALL be disclosed no transitions at all, because it cannot move the session.

#### Scenario: Only the active state's edges are disclosed

- **WHEN** a workflow declares states `triage`, `refund-review`, `escalate` and `closed`, and the
  session is in `triage` with one transition to `refund-review`
- **THEN** the model call names `refund-review` and its description, and the prompt contains
  neither `escalate` nor `closed` anywhere

#### Scenario: A description is what the agent routes on

- **WHEN** the active state declares `- to: refund-review, description: "Refunds over $50."`
- **THEN** the disclosed line carries that description verbatim, and carries nothing of
  `refund-review`'s own `title`, `summary`, `instructions` or hooks

#### Scenario: A human target is marked, and only that

- **WHEN** a described transition's target is a `type: human` state with `instructions`,
  `approvers` and three transitions of its own
- **THEN** the edge is marked as leading to a human decision node, and none of that state's
  `instructions`, `approvers` or transitions appear in the prompt

#### Scenario: A terminal target is marked

- **WHEN** a transition's target declares no transitions of its own
- **THEN** the edge is marked terminal, so the agent finishes the work before advancing rather
  than advancing and expecting another turn

#### Scenario: The active state's terminality is stated, not inferred

- **WHEN** the active state declares no transitions
- **THEN** the block states that the state is terminal and no transition leads out of it, rather
  than leaving the agent to infer it from an absent list, and `archmax_advance` is not disclosed

#### Scenario: A rubric hook is disclosed by kind only

- **WHEN** the active state declares `after: { rubric: { instructions: … } }`
- **THEN** the block records an `after` hook of kind `rubric`, and no model call carries the
  rubric's criteria, budget, model or any name for it

#### Scenario: Only the run's own trigger signature is disclosed

- **WHEN** a workflow declares triggers `manual` and `inbound-email` on two different states and
  the session was started by `manual`
- **THEN** the block carries `manual`'s `requires` and `returns` and never mentions
  `inbound-email` or the state it enters

#### Scenario: A parked session is disclosed no edges

- **WHEN** a session parked at a human state is handed a reply and spends its reply-only model call
- **THEN** no transition is disclosed, because a reply-only turn cannot move the session

#### Scenario: An undescribed edge discloses the target's instructions

- **WHEN** the active state `triage` declares `- to: lookup` with no `description`, and `lookup`
  declares `instructions: "Look up the order by its id and summarise its status."`, a `title`, a
  `summary` and an `after` hook
- **THEN** the edge's line names `lookup` and is followed by those instructions verbatim, quoted and
  introduced as what the agent will do once in `lookup`, and the prompt carries nothing else of
  `lookup`: not its `title`, `summary`, hooks or transitions

#### Scenario: Described and undescribed edges side by side

- **WHEN** the active state declares one described edge to `refund-review` and one undescribed edge
  to `lookup`
- **THEN** the `refund-review` line carries its description and nothing of `refund-review`'s
  `instructions`, and the `lookup` line carries `lookup`'s instructions

#### Scenario: An undescribed edge into a human state

- **WHEN** an undescribed edge leads to a `type: human` state with `instructions` and `approvers`
- **THEN** the edge is marked as leading to a human decision node and carries that state's
  `instructions`, and the prompt carries neither its `approvers` nor its transitions
