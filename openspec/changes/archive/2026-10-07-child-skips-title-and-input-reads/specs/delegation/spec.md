## MODIFIED Requirements

### Requirement: The child is its own session, seeded with the call's arguments only

A dispatch SHALL run the target as a separate session with id `<parent>~<state>:<workflow>:<ordinal>`,
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

## ADDED Requirements

### Requirement: A child session is not asked to name itself

A child session's prompt SHALL NOT ask it to set the reserved `title`: its title would describe a
session nothing lists, and `returns` cannot carry it. The platform layer of a child's system
prompt SHALL leave out every passage between a line `<!-- top-level-only -->` and a line
`<!-- /top-level-only -->` (surrounding whitespace ignored); the bundled platform prompt SHALL mark
its "Name the run first" step and its "Naming the run" paragraph that way. Where a left-out
passage held items of an ordered list, the items after it in that list SHALL be renumbered. A
top-level session SHALL read the passages with only the marker lines removed, so its system
prompt and its cacheable prefix are what they were before the markers existed; the marker lines
SHALL reach no model. A workspace's platform-prompt override SHALL be read by the same rule, and
an override without markers SHALL read the same in both sessions. An opening marker with no
closing marker SHALL leave the text after it in place for both. A child's
`archmax_set_variables` description SHALL leave out the sentence asking for a title; a top-level
session's description SHALL be unchanged. A child's `title` SHALL NOT be seeded by the runtime; a
caller that passes `title` as an argument seeds it unlocked, as before.

#### Scenario: The child goes straight to its work

- **WHEN** a caller dispatches a one-state child whose inputs are scalars
- **THEN** the child's first model call is handed a system prompt whose movement list begins
  `1. Do the current state's work.` and which never mentions `title`, and an
  `archmax_set_variables` description that does not mention `title`

#### Scenario: The caller's prompt is unchanged

- **WHEN** the same caller's model calls run before and after the child's
- **THEN** each carries the step `1. **Name the run first.**`, the "Naming the run" paragraph and
  the `title` sentence in `archmax_set_variables`' description, no marker line, and a platform
  layer byte-identical across both calls

#### Scenario: An override keeps its markers' meaning

- **WHEN** a workspace's override marks one item of a numbered list `top-level-only`
- **THEN** a child's prompt leaves the item out and renumbers the items after it, and a top-level
  session's prompt keeps it with the marker lines removed

#### Scenario: An override without markers reads the same

- **WHEN** a workspace's override carries no marker
- **THEN** a child session and a top-level session read it identically

#### Scenario: A child emits no title of its own

- **WHEN** a child completes without its caller passing `title`
- **THEN** the child session holds no `title` variable and no `title-set` event carries its
  dispatch id
