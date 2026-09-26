## MODIFIED Requirements

### Requirement: The call signature is the target's declared requires

A delegation tool's input schema SHALL be derived from the target's `manual` trigger by the
runtime's one signature-to-JSON-Schema mapping (see `workflow-spec`): one required parameter
per entry of `requires`, carrying the entry's type and description where it declares them and
described as a locked variable, and nothing else — no prose argument, no fan-out argument. The
tool description SHALL be built from the target's own spec — the `manual` trigger's
`description` first when it declares one, then the title, requires and returns — never its
`instructions`. A dispatch missing a required name SHALL be refused with kind `missing-param`,
and a dispatch whose argument does not conform to a typed entry SHALL be refused with kind
`invalid-param` naming the argument, its declared type and what arrived, both before any child
is composed; an argument carrying a `${{…}}` reference SHALL be resolved against the caller's
variables verbatim (not glob-escaped) before dispatch, an argument that is exactly one
reference SHALL take the referenced value's own type, and an unresolvable reference SHALL
refuse the call with kind `unresolved-param`.

#### Scenario: Missing input refused

- **WHEN** a target declares `requires: [order_id]` and the caller omits `order_id`
- **THEN** the call is refused as a blocked call naming the target and `order_id`, and no child runs

#### Scenario: Referencing argument substituted

- **WHEN** a script calls the tool with `{ account_id: "${{account_id}}" }` and `account_id` is `acct-42`
- **THEN** the child is seeded with `account_id` = `acct-42`

#### Scenario: A typed parameter reaches the tool schema

- **WHEN** a target's `manual` trigger declares
  `requires: [{ name: due, type: date, description: "The day the refund is due." }]`
- **THEN** the tool's input schema describes `due` as `{ type: string, format: date }` with that
  description, and lists it as required

#### Scenario: A mistyped argument is refused

- **WHEN** the target declares `{ name: quantity, type: integer }` and the caller passes
  `quantity: "three"`
- **THEN** the call is refused with kind `invalid-param` naming `quantity` and `integer`, and no
  child runs

#### Scenario: The entry's description leads the tool description

- **WHEN** the target's `manual` trigger declares `description: "Refund one order."`
- **THEN** the tool description begins with that sentence and still carries nothing of the
  target's `instructions`

### Requirement: The call answers with the declared returns and the closing message

A completed child SHALL answer its tool call with `{ message, returns }` when the target
declares `returns` — the values of those variables read from the child's settled store, each
conforming to its declared type because the child's completion check held them to it — and
with the closing message alone otherwise. Nothing else SHALL cross back: the child's transcript,
trail and every other variable are discarded when it settles. Nothing captures the answer into a
caller variable; an agent that needs one sets it with `archmax_set_variables`, a script writes
the value it received, and the calling state's `requires:` is the guarantee.

#### Scenario: Returns delivered by name

- **WHEN** a target declaring `returns: [enrichment_file, delayed]` completes
- **THEN** the caller's tool result carries both under `returns` beside the closing `message`

#### Scenario: Child that settles without its returns fails closed

- **WHEN** a child finishes with a declared return unset
- **THEN** it settles rejected with kind `missing-return` naming the state and the unset names, and
  no partial result reaches the caller

#### Scenario: A child whose typed return does not conform fails closed

- **WHEN** a target declares `returns: [{ name: delayed, type: boolean }]` and its child finishes
  with `delayed` holding `"no"`
- **THEN** it settles rejected with kind `invalid-return` naming the state, `delayed` and
  `boolean`, and no partial result reaches the caller
