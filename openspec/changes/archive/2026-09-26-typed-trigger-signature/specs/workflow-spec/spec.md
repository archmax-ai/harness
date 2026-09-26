## MODIFIED Requirements

### Requirement: A state's trigger declaration

A state's `triggers:` SHALL be a mapping of trigger id to a **loose** declaration, and SHALL be
the one place a trigger is declared: the key is the id, and the state it is declared on is its
entry state. A state declaring any is a start state for each id, in declaration order, read
through the single interpretation point `stateTriggerIds` — the mapping's keys. A declaration's
value MAY be `null` or empty, which declares the id and nothing more.

A declaration's harness-read keys are: `session` (a dotted path over the firing's variables
yielding the session id — first segment a variable name, no empty segment, never
`${{…}}`-wrapped), `message` (such a path, or `false` when firings carry no message),
`connection` (a non-empty string naming something in the host's environment), `description`
(a non-empty string saying, for a caller, what calling this entry does), `requires` and
`returns`. `message` and `connection` are host-resolved: shape-checked, preserved, exposed on
the machine (`messagePathForTrigger`, `connectionForTrigger`) and never acted on by the
runtime. `description` is caller-facing: it SHALL be exposed on the machine through the
trigger's signature, SHALL lead the delegation tool's description for the `manual` trigger
(see `delegation`), and SHALL NOT reach the model of a session started through the trigger —
it describes the entry to whoever calls it, and the session's own brief is its `instructions`.
Any other key SHALL be preserved and reported as a lint warning naming the trigger and the key,
**except** `entry` and `name`, which SHALL be load errors: the state is the entry and the key is
the id, so each has one spelling and nothing to reconcile. Malformed paths, an empty
`connection` and an empty `description` SHALL be errors.

#### Scenario: A trigger is read from the state it enters

- **WHEN** state `intake` declares
  `triggers: { manual: , slack-message: { session: triggers.-1.threadId, piece: slack } }`
- **THEN** its trigger ids are `[manual, slack-message]`, it is the start state for both,
  `slack-message` resolves sessions by `triggers.-1.threadId`, and `piece` is preserved with a
  lint warning naming the trigger and the key

#### Scenario: Malformed paths

- **WHEN** a declaration has `session: "${{conversation_id}}"`, `message: "triggers..text"` or
  `connection: ""`
- **THEN** loading fails naming the trigger and the key, worded for whoever wrote the path

#### Scenario: entry and name are refused

- **WHEN** a declaration carries `entry: intake` or `name: slack-message`
- **THEN** loading fails naming the key and the trigger, stating that the state a trigger is
  declared on is its entry and that the mapping key is its id

#### Scenario: A description is read and never linted

- **WHEN** a `manual` declaration carries `description: "Refund one order and report the amount."`
- **THEN** the spec loads with no lint warning for the key, and the trigger's signature carries
  that description

#### Scenario: An empty description is an error

- **WHEN** a declaration carries `description: "  "`
- **THEN** loading fails naming the trigger and `description`

#### Scenario: A description does not reach the session's model

- **WHEN** a session is started through a trigger declaring a `description`
- **THEN** no model call of that session carries the description text

### Requirement: A trigger's signature

A trigger declaration's `requires` and `returns` SHALL each be a list of distinct variable
names, declared on the state the trigger enters, where each entry is either a bare variable
name or an object `{ name, type?, description? }` naming one: `name` a variable name, `type`
one of the **signature types** `string`, `integer`, `number`, `boolean`, `date`, `date-time`,
`object` and `array`, and `description` a non-empty string saying what the variable holds for
whoever supplies or reads it. A bare name and an object with only `name` SHALL mean the same
untyped entry, and one list MAY mix the two spellings. An object entry carrying any other key
SHALL be an error naming the trigger, the entry and the key. Distinctness SHALL be by name
across both spellings. `returns` SHALL NOT name `trigger` (runtime-set and locked) or `title`
(a child's title describes the child; returning it would rename the caller's task).
`requires` MAY name either; a firing supplying `title` seeds it unlocked. A signature declares
the contract a caller relies on — each variable's name, and optionally what kind of value it
holds and what it is for — and nothing about how a state produces it, which belongs in the
state `instructions` that set it. The machine SHALL expose the names per trigger
(`requiresForTrigger`, `returnsForTrigger`) and the whole normalized signature per trigger
(`signatureForTrigger`: its `description` and both lists as `{ name, type?, description? }`
objects in declaration order), and every variable a signature requires SHALL count as declared
for the purpose of guard-reference advisories.

#### Scenario: Malformed signature

- **WHEN** a declaration has `requires: "order_id"`, `returns: [risk_level, risk_level]` or
  `returns: [title]`
- **THEN** loading fails naming the trigger and the offending entry, and `archmax validate`
  reports the identical message

#### Scenario: A typed entry is read beside a bare one

- **WHEN** a `manual` declaration has
  `requires: [order_id, { name: due, type: date, description: "The day the refund is due." }]`
- **THEN** the spec loads, `requiresForTrigger("manual")` is `[order_id, due]`, and
  `signatureForTrigger("manual").requires` is `[{ name: order_id }, { name: due, type: date,
  description: "The day the refund is due." }]`

#### Scenario: An unknown type is refused

- **WHEN** an entry declares `{ name: amount, type: float }`
- **THEN** loading fails naming the trigger, the entry and the accepted types

#### Scenario: One name in both spellings is a duplicate

- **WHEN** a declaration has `returns: [total, { name: total, type: number }]`
- **THEN** loading fails naming the trigger and `total` as listed more than once

#### Scenario: An unknown entry key is refused

- **WHEN** an entry declares `{ name: amount, type: number, default: 0 }`
- **THEN** loading fails naming the trigger, the entry and `default`

### Requirement: The signature holds at the session boundary

A session on a trigger declaring `requires` SHALL be refused at the turn boundary — after
this turn's opening variables are built from the host's seeds, the invocation's seeds and
`trigger` — unless every named variable is set and every **typed** named variable holds a value
that conforms to its type, with a message naming the trigger and every missing name, and, for a
non-conforming value, the variable, its declared type and the kind of value that arrived. An
untyped entry SHALL be satisfied by any value, `null` included; a typed entry SHALL NOT be
satisfied by `null`. When a session completes in a terminal state, the runtime SHALL check the
`returns` of the trigger that started the **current turn** and reject the session naming the
state and every unset name, and every typed return whose value does not conform, with its
declared type; a session that parks (a human state, `archmax_wait`) is not checked because it
has not completed. A declared return is an ordinary variable: declaring it creates nothing.

Conformance SHALL be decided by one rule, the same one every other check in this spec and in
`delegation` applies: `string` a JSON string; `integer` a JSON number with no fractional part;
`number` a finite JSON number; `boolean` `true` or `false`; `date` a string that is an RFC 3339
full-date (`YYYY-MM-DD`) naming a real calendar day; `date-time` a string that is an RFC 3339
date-time carrying an offset (`Z` or `±hh:mm`); `object` a JSON object that is not an array;
`array` a JSON array. No value SHALL be coerced: the string `"4"` does not conform to `integer`.

#### Scenario: Missing required input

- **WHEN** a session starts on a trigger declaring `requires: [order_id]` with no `order_id`
  among its seeds
- **THEN** no model call is made and the session is rejected naming the trigger and `order_id`

#### Scenario: Unset return at completion

- **WHEN** a session on a trigger declaring `returns: [enrichment_file, delayed]` finishes
  having set only `enrichment_file`
- **THEN** the session is rejected naming the terminal state and `delayed`

#### Scenario: A required input of the wrong type

- **WHEN** a session starts on a trigger declaring `requires: [{ name: quantity, type: integer }]`
  with `quantity` seeded as the string `"4"`
- **THEN** no model call is made and the session is rejected naming the trigger, `quantity`,
  `integer` and that a string arrived

#### Scenario: A malformed date is refused

- **WHEN** a trigger declares `{ name: due, type: date }` and the seed is `2026-02-30`
- **THEN** the session is refused naming `due` and `date`

#### Scenario: Null does not satisfy a typed input

- **WHEN** a trigger declares `{ name: approved, type: boolean }` and the seed is `null`
- **THEN** the session is refused naming `approved`

#### Scenario: An untyped input still takes any value

- **WHEN** a trigger declares `requires: [note]` and the seed is `null`
- **THEN** the session starts

#### Scenario: A typed return of the wrong type at completion

- **WHEN** a session on a trigger declaring `returns: [{ name: total, type: number }]` finishes
  with `total` holding the string `"12.50"`
- **THEN** the session is rejected naming the terminal state, `total` and `number`

### Requirement: The signature crosses a sub-workflow boundary

The `manual` trigger's signature SHALL also be a workflow's call signature: `requires` names
the arguments an `archmax_workflow_<slug>` call must supply, `returns` what the call's result
carries, and each typed entry's type governs both, one declaration for both ingresses. A child
session's opening variables SHALL be exactly the call's arguments — seeded through the same
construction and name rule a host's `variables` go through, locked (except `title`) — plus the
built-in `trigger`, which reads `manual`; nothing of the caller's store is copied down and no
name is reserved for it. A call missing a required argument, supplying an invalid name, or
supplying a value that does not conform to a typed entry SHALL be refused before the child
runs. A string argument carrying a `${{…}}` reference SHALL be resolved against the
**caller's** variables, verbatim (not glob-escaped), and an unresolvable reference fails the
call closed. An argument that is **exactly one** reference and nothing else SHALL take the
referenced value itself — a number stays a number, a boolean a boolean — while an argument
mixing text with references SHALL be the substituted string. When the child settles, the
runtime SHALL read exactly its declared `returns` out of its settled store into the call's
result and discard the rest; no lock, reseed or value crosses upward otherwise, and nothing
writes a caller variable — an agent that needs the value in one sets it with
`archmax_set_variables`. Dispatch itself — the tool, depth and concurrency bounds, child
sessions — is the `delegation` capability's.

#### Scenario: Only declared returns cross up

- **WHEN** a child finishes with six variables set and its `manual` trigger declares two
  returns
- **THEN** the two reach the caller as the tool result and the caller's own store is unchanged

#### Scenario: Argument reference resolved caller-side

- **WHEN** a script calls the tool with `{ account_id: "${{account_id}}" }` and the caller
  holds `acct-42`
- **THEN** the child is seeded with `account_id: acct-42`; were the reference unset, the call
  would fail naming the argument

#### Scenario: A whole-argument reference keeps its type

- **WHEN** the target declares `requires: [{ name: quantity, type: integer }]` and the call
  passes `{ quantity: "${{count}}" }` while the caller holds `count: 3`
- **THEN** the child is seeded with the number `3` and the call is not refused

#### Scenario: A mixed argument stays a string

- **WHEN** the call passes `{ note: "order ${{order_id}}" }` and the caller holds `order_id: 7`
- **THEN** the child is seeded with the string `order 7`

## ADDED Requirements

### Requirement: A typed return is checked where it is written

When the agent writes a variable with `archmax_set_variables` that the current turn's trigger
declares as a **typed** entry of its `returns`, the runtime SHALL refuse the call — atomically,
nothing written — if the value does not conform to the declared type, naming the variable, its
type, the trigger that declares it and the kind of value that arrived. The refusal SHALL be a
correctable tool refusal, not a governance failure: the session continues and the agent may
write a conforming value. A variable no typed return of the current turn's trigger names SHALL
be written as today, whatever it holds, and a script- or hook-originated write SHALL remain
subject only to the completion check.

#### Scenario: A mistyped return is refused at the write

- **WHEN** the session's trigger declares `returns: [{ name: approved, type: boolean }]` and the
  agent calls `archmax_set_variables({ variables: { approved: "yes" } })`
- **THEN** the call is refused naming `approved`, `boolean` and the trigger, nothing is written,
  and the session continues

#### Scenario: A conforming return is written

- **WHEN** the agent then calls `archmax_set_variables({ variables: { approved: true } })`
- **THEN** `approved` is set to `true`

#### Scenario: An undeclared variable is written freely

- **WHEN** the agent writes `scratch: { a: 1 }` and no typed return names `scratch`
- **THEN** the write succeeds

### Requirement: One mapping from a signature to JSON Schema

The runtime SHALL publish one pure mapping from a list of signature entries to a JSON Schema
object, and every schema the runtime itself produces from a signature — the delegation tool's
input schema — SHALL be built by it, so a host that builds an external schema from the same
signature (an MCP tool, a form, an API) describes exactly what the runtime enforces. The mapping
SHALL produce `{ type: "object", properties, required }`, with one property per entry in
declaration order: `string`, `integer`, `number`, `boolean`, `object` and `array` as the JSON
Schema `type` of the same name; `date` as `{ type: "string", format: "date" }`; `date-time` as
`{ type: "string", format: "date-time" }`; an untyped entry as a schema with no `type`; and an
entry's `description` as the property's `description`. `required` SHALL name every entry of a
`requires` list, since each is mandatory. For a `returns` list it SHALL name every entry, since
the completion check guarantees each is set.

The runtime SHALL also publish the conformance rule as a pure function: given signature entries
and a value map, it returns one issue per missing name and per non-conforming value — the
variable, its declared type and the kind of value found — and nothing for a conforming map. The
turn boundary, the completion check, the write check and the delegation refusal SHALL all decide
by it.

#### Scenario: A typed signature becomes a schema

- **WHEN** the mapping is given `[{ name: order_id, type: string, description: "The order." },
  { name: due, type: date }, { name: note }]`
- **THEN** it yields `properties` `order_id: { type: string, description: "The order." }`,
  `due: { type: string, format: date }` and `note: {}`, with `required: [order_id, due, note]`

#### Scenario: The conformance rule names every problem

- **WHEN** the rule is given `[{ name: quantity, type: integer }, { name: due, type: date }]`
  and `{ quantity: 2.5 }`
- **THEN** it returns an issue naming `quantity` as not an `integer` and one naming `due` as
  missing

#### Scenario: One rule decides everywhere

- **WHEN** a host validates a value map with the published rule and it reports no issue
- **THEN** a session seeded with that map is not refused at the turn boundary for its signature
