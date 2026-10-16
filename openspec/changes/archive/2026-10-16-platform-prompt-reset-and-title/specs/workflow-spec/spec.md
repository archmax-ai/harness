## MODIFIED Requirements

### Requirement: Variable names and the two reserved variables

A session's variables SHALL form one flat, undeclared namespace: a variable exists when
something sets it, and there is no `variables:` block in the spec. A name SHALL match
`^[a-z][a-z0-9_]*$` (never dotted), checked wherever a name enters — a host seed, a delivery,
a call argument, `requires`/`returns`, and `archmax_set_variables`. Two names are reserved.
`trigger` holds the id of the current turn's arrival, set by the runtime and locked, re-stamped
at every arrival boundary (turn start and delivery), refused to every write, and available
before the start state's `before` hook runs, so a guard may reference `${{trigger}}` without
a seed. `title` is a short label for the session's task, agent-owned: never locked by any
route (a seed stores it unlocked; `archmax_set_variables` refuses `lock: true` with it),
shape-checked on write (non-empty, single-line, at most 200 characters after trimming, stored
trimmed; a bad seed throws `InvalidTitleError` at the seeding boundary), treated as an opening
label when seeded (it does not overwrite a title the session already holds), and replaced by
a delivery that carries one.

The platform prompt SHALL ask a top-level session to set `title` in its first turn. After that,
it SHALL ask for a rename only when the conversation as a whole has moved to a subject the title
no longer describes. The model SHALL be told to judge this against the whole conversation, not
its latest message: a follow-up, a detail, a correction or a side question on the same subject
keeps the title, and a rename names what the whole conversation is about. The `title` sentence
in a top-level session's `archmax_set_variables` description SHALL set the same bar. A
sub-workflow's child SHALL read neither.

#### Scenario: Invalid name refused at the door

- **WHEN** a seed, a delivery, or a write uses the name `Customer.Id`
- **THEN** it is refused naming the required shape, and a dotted name is told there is no
  sub-path write

#### Scenario: Seeded title yields to an established one

- **WHEN** a host seeds `title: "Inbound refund request"`, the first turn sets `title` to
  `"Refund for order A-1042"`, and a second turn starts with the same seed
- **THEN** `title` still reads `Refund for order A-1042`

#### Scenario: A follow-up keeps the title

- **WHEN** a top-level session's platform prompt and `archmax_set_variables` description are
  rendered
- **THEN** both ask for a rename only when the subject of the whole conversation has changed, and
  the prompt says to judge that against the whole conversation rather than the latest message and
  that a follow-up on the same subject keeps the title
