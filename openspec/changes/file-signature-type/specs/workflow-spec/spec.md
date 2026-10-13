## MODIFIED Requirements

### Requirement: A trigger's signature

A trigger declaration's `requires` and `returns` SHALL each be a list of distinct variable
names, declared on the state the trigger enters, where each entry is either a bare variable
name or an object `{ name, type?, description? }` naming one: `name` a variable name, `type`
one of the **signature types** `string`, `integer`, `number`, `boolean`, `date`, `date-time`,
`object`, `array` and `file`, and `description` a non-empty string saying what the variable holds
for whoever supplies or reads it. A bare name and an object with only `name` SHALL mean the same
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

#### Scenario: A file entry is accepted

- **WHEN** a `manual` declaration has `requires: [{ name: invoice, type: file }]` and
  `returns: [{ name: report, type: file, description: "The reconciliation report." }]`
- **THEN** the spec loads and `signatureForTrigger("manual")` carries both entries with type `file`

#### Scenario: An unknown type is refused

- **WHEN** an entry declares `{ name: amount, type: float }`
- **THEN** loading fails naming the trigger, the entry and the accepted types, `file` among them

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
`array` a JSON array; `file` a string naming a path from the workspace root — after at most one
leading `/`, one or more segments with no empty, `.` or `..` segment, no backslash, no NUL and no
trailing `/`. No value SHALL be coerced: the string `"4"` does not conform to `integer`. The rule
judges a `file` value's shape only; whether a file is there, and whether the session may read
it, is checked where the value crosses a boundary (see "A file value names a file the session
may read").

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

#### Scenario: A malformed file path does not conform

- **WHEN** a trigger declares `{ name: invoice, type: file }` and the seed is
  `scratchpad/../checkpoints/cp-1.json`, `scratchpad/`, `scratchpad//invoice.pdf`,
  `scratchpad\invoice.pdf` or the empty string
- **THEN** the session is refused naming `invoice` and `file`

#### Scenario: Any root path conforms

- **WHEN** the seed is `skills/billing/assets/invoice.pdf` or `/scratchpad/attachments/invoice.pdf`
- **THEN** the value conforms; whether the session starts depends on the file being there and
  readable

### Requirement: One mapping from a signature to JSON Schema

The runtime SHALL publish one pure mapping from a list of signature entries to a JSON Schema
object, and every schema the runtime itself produces from a signature — the delegation tool's
input schema — SHALL be built by it, so a host that builds an external schema from the same
signature (an MCP tool, a form, an API) describes exactly what the runtime enforces. The mapping
SHALL produce `{ type: "object", properties, required }`, with one property per entry in
declaration order: `string`, `integer`, `number`, `boolean`, `object` and `array` as the JSON
Schema `type` of the same name; `date` as `{ type: "string", format: "date" }`; `date-time` as
`{ type: "string", format: "date-time" }`; `file` as `{ type: "string", format: "file" }`; an
untyped entry as a schema with no `type`; and an entry's `description` as the property's
`description`. `required` SHALL name every entry of a `requires` list, since each is mandatory.
For a `returns` list it SHALL name every entry, since the completion check guarantees each is
set.

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

#### Scenario: A file entry becomes a string with format file

- **WHEN** the mapping is given `[{ name: invoice, type: file, description: "The invoice." }]`
- **THEN** it yields `invoice: { type: string, format: file, description: "The invoice." }`

#### Scenario: The conformance rule names every problem

- **WHEN** the rule is given `[{ name: quantity, type: integer }, { name: due, type: date }]`
  and `{ quantity: 2.5 }`
- **THEN** it returns an issue naming `quantity` as not an `integer` and one naming `due` as
  missing

#### Scenario: One rule decides everywhere

- **WHEN** a host validates a value map with the published rule and it reports no issue
- **THEN** a session seeded with that map is not refused at the turn boundary for its signature,
  unless a `file` value names no file the session may read

## ADDED Requirements

### Requirement: A file value names a file the session may read

Where a `file` value crosses a boundary, the runtime SHALL refuse it unless it names a file (not
a folder) in that session's workspace that the session may read on runtime authority: the zone
rules and every workflow-wide denial, inherited ones included. The refusal names the variable,
`file` and the cause. The boundaries are the turn boundary, `archmax_set_variables` for a typed
return, the completion check, and a delegation call.

#### Scenario: A host seed naming no file is refused

- **WHEN** a session starts on `requires: [{ name: invoice, type: file }]` seeded with
  `scratchpad/attachments/invoice.pdf` and the session holds no such file
- **THEN** no model call is made and the session is refused naming `invoice`, `file` and that
  nothing is at that path

#### Scenario: A return written before its file is refused at the write

- **WHEN** the current turn's trigger declares `returns: [{ name: report, type: file }]` and the
  agent calls `archmax_set_variables({ variables: { report: "scratchpad/report.pdf" } })`
  before writing that file
- **THEN** the call is refused as a correctable tool refusal naming `report` and `file`, nothing
  is written, and the same call succeeds once the file exists

#### Scenario: A return whose file is gone at completion

- **WHEN** `report` was set while the file existed, the agent removes the file, and the session
  finishes in a terminal state
- **THEN** the session is rejected naming the terminal state, `report` and `file`

#### Scenario: A folder is not a file

- **WHEN** a `file` value names `scratchpad/attachments`, which is a folder in the session
- **THEN** it is refused at whichever boundary it crosses

#### Scenario: An authored file is a file value

- **WHEN** a session starts on `requires: [{ name: template, type: file }]` seeded with
  `skills/billing/assets/template.pdf`, a file the workspace mounts
- **THEN** the session starts and `template` reads that path

#### Scenario: A denied path is refused

- **WHEN** the workflow declares `mounts: { forbid_always: [reference] }` and a `file` value names
  `reference/salaries.pdf`, or a value names `checkpoints/cp-1.json`
- **THEN** it is refused naming the variable, `file` and the rule that denies the read, at
  whichever boundary it crosses
