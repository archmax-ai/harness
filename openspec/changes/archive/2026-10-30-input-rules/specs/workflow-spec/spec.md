## MODIFIED Requirements

### Requirement: A trigger's signature

A trigger declaration's `requires` and `returns` SHALL each be a list of distinct variable
names, declared on the state the trigger enters, where each entry is either a bare variable
name or an object `{ name, type?, description?, …rules }` naming one: `name` a variable name,
`type` one of the **signature types** `string`, `integer`, `number`, `boolean`, `date`,
`date-time`, `object`, `array` and `file`, `description` a non-empty string saying what the
variable holds for whoever supplies or reads it, and optionally the **rules** its type takes
(see "A signature entry may declare rules"). A bare name and an object with only `name` SHALL
mean the same untyped entry, and one list MAY mix the two spellings. An object entry carrying
any other key SHALL be an error naming the trigger, the entry and the key. Distinctness SHALL be
by name across both spellings. `returns` SHALL NOT name `trigger` (runtime-set and locked) or
`title` (a child's title describes the child; returning it would rename the caller's task).
`requires` MAY name either; a firing supplying `title` seeds it unlocked. A signature declares
the contract a caller relies on — each variable's name, and optionally what kind of value it
holds, what that value must look like and what it is for — and nothing about how a state
produces it, which belongs in the state `instructions` that set it. The machine SHALL expose the
names per trigger (`requiresForTrigger`, `returnsForTrigger`) and the whole normalized signature
per trigger (`signatureForTrigger`: its `description` and both lists as
`{ name, type?, description?, …rules }` objects in declaration order), and every variable a
signature requires SHALL count as declared for the purpose of guard-reference advisories.

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
- **THEN** loading fails naming the trigger, the entry and `default`, and the message lists the
  rule keys among the keys an entry takes

#### Scenario: A ruled entry is read with its rules

- **WHEN** a `manual` declaration has
  `requires: [{ name: invoice, type: file, accept: [.pdf], maxSize: 10MB }]`
- **THEN** `signatureForTrigger("manual").requires` is
  `[{ name: invoice, type: file, accept: [.pdf], maxSize: 10000000 }]`

## ADDED Requirements

### Requirement: A signature entry may declare rules

An object entry SHALL accept, beside its `type`, the rules that type takes, spelled as JSON
Schema keywords: on `string` `format` (`email`, `url`, `phone`), `pattern`, `minLength`,
`maxLength`, `enum` and `content` (`text`, `markdown`, `html`); on `integer` and `number`
`minimum`/`maximum` as numbers; on `date` `minimum`/`maximum` as `YYYY-MM-DD` or `today`; on
`date-time` as an RFC 3339 date-time or `now`; on `array` `minItems`/`maxItems`; on `file`
`accept` and `maxSize`.

#### Scenario: Every rule on a type that takes it loads

- **WHEN** a signature declares `{ name: customer_email, type: string, format: email }`,
  `{ name: order_id, type: string, pattern: "^A-[0-9]+$", maxLength: 24 }`,
  `{ name: priority, type: string, enum: [low, normal, high] }`,
  `{ name: note, type: string, maxLength: 2000, content: markdown }`,
  `{ name: quantity, type: integer, minimum: 1, maximum: 100 }`,
  `{ name: due, type: date, minimum: today }`,
  `{ name: starts_at, type: date-time, maximum: "2027-01-01T00:00:00Z" }`,
  `{ name: tags, type: array, minItems: 1, maxItems: 10 }` and
  `{ name: invoice, type: file, accept: [.pdf], maxSize: 10MB }`
- **THEN** the spec loads with no diagnostic

#### Scenario: maxSize is read as bytes

- **WHEN** an entry declares `maxSize: 10MB`, `maxSize: 512KB` or `maxSize: 2048`
- **THEN** the normalized entry carries `maxSize` `10000000`, `512000` or `2048`

#### Scenario: Symbolic date bounds stay symbolic

- **WHEN** an entry declares `{ name: due, type: date, minimum: today }`
- **THEN** the normalized entry carries `minimum: today`, read against the clock only when a
  value is checked

### Requirement: A rule declaration that cannot hold is refused

Loading SHALL fail, naming the trigger, the entry and the key, and `archmax validate` SHALL report
the same, for: a rule on a type that does not take it or on an untyped entry; `format` together
with `pattern`; a `pattern` that does not compile, uses a lookaround or a backreference, or is
over 1,000 characters; a `min…` above its `max…`; an empty or repeated `enum` or `accept`; a
negative or fractional length or count; and a malformed bound, `format`, `content`, extension or
size.

#### Scenario: A rule on the wrong type

- **WHEN** an entry declares `{ name: quantity, type: integer, format: email }`
- **THEN** loading fails with a message naming `quantity`, `format` and that it applies to
  `string` entries only

#### Scenario: A rule on an untyped entry

- **WHEN** an entry declares `{ name: note, maxLength: 10 }`
- **THEN** loading fails naming `note`, `maxLength` and that the entry needs a `type`

#### Scenario: format and pattern together

- **WHEN** an entry declares `{ name: contact, type: string, format: email, pattern: "@acme\\." }`
- **THEN** loading fails naming `contact` and saying an entry declares `format` or `pattern`,
  not both

#### Scenario: A pattern that does not compile, or is not linear

- **WHEN** an entry declares `pattern` as `"[a-"`, `"(?=a)b"`, `"(?<!a)b"`, `"(a)\\1"` or a
  1,001-character string
- **THEN** loading fails naming the entry and `pattern`, quoting the engine's error for the first
  four and the 1,000-character limit for the last

#### Scenario: Inconsistent bounds

- **WHEN** an entry declares `minLength: 5, maxLength: 3`, `minimum: 10, maximum: 1`,
  `minimum: 2026-12-01, maximum: 2026-11-01`, `minItems: -1`, `enum: []` or `enum: [a, a]`
- **THEN** loading fails naming the entry and the offending key

#### Scenario: No platform policy in the SDK

- **WHEN** an entry declares `{ name: body, type: string, maxLength: 1000000 }`
- **THEN** the spec loads: the SDK caps no length

### Requirement: An authored pattern is matched in linear time

A `pattern` SHALL be matched by a linear-time regular-expression engine with RE2 semantics,
never by a backtracking engine, so a value's check takes time linear in its length whatever the
pattern. A pattern SHALL also compile as an ECMA-262 regular expression with the `u` flag
(compiled, never executed), so a JSON Schema validator reads the same pattern. A pattern
matches when it is found anywhere in the value; an author anchors with `^…$`.

#### Scenario: A catastrophic pattern stays fast

- **WHEN** an entry declares `pattern: "(a+)+$"` and a value of 8,000 `a`s followed by `!` is
  checked
- **THEN** the check reports the value as not matching within milliseconds

#### Scenario: RE2-only syntax is refused

- **WHEN** an entry declares `pattern: "(?i)abc"` or `pattern: "\\pL+"`
- **THEN** loading fails naming the entry and `pattern`, because a JSON Schema validator could not
  read it

#### Scenario: An unanchored pattern matches anywhere

- **WHEN** an entry declares `pattern: "[0-9]"` and the value is `"order 7"`
- **THEN** the value conforms

### Requirement: Rules are checked after the type, one issue per entry

The conformance rule SHALL check an entry's rules only on a value that conforms to its type, and
SHALL report at most one issue per entry: the first rule broken, in the order `format`/`pattern`,
`enum`, `minLength`/`maxLength`, `minimum`/`maximum`, `minItems`/`maxItems`, `accept`. The issue
SHALL be an `invalid` issue carrying the rule's name and a message naming the variable. Nothing
SHALL be coerced or trimmed.

#### Scenario: A mistyped value reports the type only

- **WHEN** an entry declares `{ name: quantity, type: integer, minimum: 1 }` and the value is the
  string `"0"`
- **THEN** one issue reports `quantity` as not an `integer`, with no rule

#### Scenario: The first broken rule is the one reported

- **WHEN** an entry declares `{ name: order_id, type: string, pattern: "^A-[0-9]+$",
  maxLength: 4 }` and the value is `"B-12345"`
- **THEN** exactly one issue is reported, for `pattern`: `'order_id' must match ^A-[0-9]+$`

#### Scenario: Whitespace is not trimmed

- **WHEN** an entry declares `format: email` and the value is `" a@b.co"`
- **THEN** the value does not conform

#### Scenario: An entry without rules checks as before

- **WHEN** an entry declares only `{ name: quantity, type: integer }`
- **THEN** every value is judged and worded exactly as it was before rules existed

### Requirement: Each rule's check

Each rule SHALL be decided as follows: `format: email` by the WHATWG valid-email-address grammar
with a domain of at least two labels; `format: url` as an absolute `http:`/`https:` URL with no
credentials and no whitespace or control character; `format: phone` as E.164; `enum` by exact,
case-sensitive membership; lengths in code points; numeric and date bounds inclusive; item counts
by array length; `accept` by the path's last extension, case-insensitively.

#### Scenario: Email addresses

- **WHEN** an entry declares `format: email`
- **THEN** `ann+orders@example.co` conforms, and `ann@localhost`, `"ann"@example.co`,
  `ann@example..co`, `ann@-example.co` and `annexample.co` do not, each reported as
  `'<name>' must be an email address`

#### Scenario: URLs

- **WHEN** an entry declares `format: url`
- **THEN** `https://example.com/a?b=1` conforms, and `ftp://example.com`, `javascript:alert(1)`,
  `/relative/path`, `https://user:pw@example.com` and `" https://example.com"` do not, each
  reported as `'<name>' must be an http(s) URL`

#### Scenario: Phone numbers

- **WHEN** an entry declares `format: phone`
- **THEN** `+4930123456` conforms, and `030123456`, `+0301234` and `+49 30 123456` do not, each
  reported as `'<name>' must be a phone number in international form, such as +4930123456`

#### Scenario: enum

- **WHEN** an entry declares `enum: [low, normal, high]` and the value is `"High"`
- **THEN** it is reported as `'<name>' must be one of low, normal, high`

#### Scenario: Lengths count code points

- **WHEN** an entry declares `maxLength: 2` and the value is two emoji, each outside the Basic
  Multilingual Plane
- **THEN** the value conforms, and a third emoji is reported as
  `'<name>' must be at most 2 characters`

#### Scenario: Numeric bounds are inclusive

- **WHEN** an entry declares `{ type: integer, minimum: 1, maximum: 100 }`
- **THEN** `1` and `100` conform, and `0` is reported as `'<name>' must be at least 1` and `101`
  as `'<name>' must be at most 100`

#### Scenario: Item counts

- **WHEN** an entry declares `{ type: array, minItems: 1, maxItems: 10 }` and the value is `[]`
- **THEN** it is reported as `'<name>' must hold at least 1 entry`

#### Scenario: accept

- **WHEN** an entry declares `{ type: file, accept: [.pdf] }`
- **THEN** `scratchpad/attachments/Invoice.PDF` conforms, and `scratchpad/attachments/invoice.png`
  is reported as `'<name>' must be a .pdf file`

#### Scenario: Linear in the value's length

- **WHEN** an email, a URL, a length or a pattern check is given a 1 MB string
- **THEN** it completes in time linear in the string's length

### Requirement: Date bounds read a clock the caller may pin

A `date` bound of `today` SHALL be the UTC calendar date of the check's clock, and a `date-time`
bound of `now` SHALL be the clock's instant. The clock SHALL default to the current time, and a
caller of the conformance rule MAY pin it. A literal bound SHALL be compared as a calendar date
(`date`) or an instant (`date-time`, offsets applied). Bounds are inclusive.

#### Scenario: today around a UTC midnight

- **WHEN** an entry declares `{ name: due, type: date, minimum: today }`, the clock is pinned to
  `2026-11-01T00:30:00+02:00`, and the value is `2026-10-31`
- **THEN** the value conforms, since the clock's UTC date is `2026-10-31`; `2026-10-30` is
  reported as `'due' must not be before today`

#### Scenario: A literal date bound

- **WHEN** an entry declares `{ name: due, type: date, minimum: 2026-11-01 }` and the value is
  `2026-10-31`
- **THEN** it is reported as `'due' must not be before 2026-11-01`

#### Scenario: now and offsets

- **WHEN** an entry declares `{ name: starts_at, type: date-time, minimum: now }`, the clock is
  pinned to `2026-11-01T10:00:00Z`, and the value is `2026-11-01T11:30:00+02:00`
- **THEN** it is reported as `'starts_at' must not be before now`, since the value is
  `09:30:00Z`

### Requirement: A file value is held to its maxSize where it crosses a boundary

Where a `file` value crosses a boundary (the turn boundary, `archmax_set_variables` for a typed
return, the completion check and a delegation call), the runtime SHALL refuse a value whose entry
declares `maxSize` when the file it names is larger, or its size cannot be determined, beside
the existence and permission refusals, naming the variable and the limit.

#### Scenario: An oversized file is refused at the start

- **WHEN** a session starts on `requires: [{ name: invoice, type: file, maxSize: 1KB }]` seeded
  with a path naming a 2,000-byte file the session may read
- **THEN** no model call is made and the session is refused with `'invoice' must be at most 1 KB`

#### Scenario: A file within its limit is accepted

- **WHEN** the same file is 1,000 bytes
- **THEN** the session starts

#### Scenario: One issue for the entry

- **WHEN** an entry declares `{ type: file, accept: [.pdf], maxSize: 1KB }` and the value names
  a missing `.png`
- **THEN** the only issue reported for the entry is that it must be a `.pdf` file

### Requirement: content is a declaration, not a check

`content` SHALL be carried by the normalized signature and mapped into the JSON Schema, and
SHALL NOT affect conformance: the runtime SHALL neither refuse nor alter a value for its
`content`. What a declared kind of text permits is a host's decision.

#### Scenario: HTML in a markdown entry is not refused

- **WHEN** an entry declares `{ name: note, type: string, content: markdown }` and the value is
  `"<script>alert(1)</script>"`
- **THEN** the value conforms and reaches the session unchanged

### Requirement: Rules map into the JSON Schema

The mapping from a signature to JSON Schema SHALL carry each rule JSON Schema can express:
`format: email` as `format: email`; `format: url` as `format: uri` with
`pattern: "^https?://"`; `format: phone` as the E.164 `pattern`; `pattern`, `minLength`,
`maxLength`, `enum`, numeric `minimum`/`maximum`, `minItems` and `maxItems` as themselves;
`content` as `contentMediaType` (`text/plain`, `text/markdown`, `text/html`). Date bounds,
`accept` and `maxSize` SHALL be left out.

#### Scenario: A ruled signature becomes a schema

- **WHEN** the mapping is given `[{ name: quantity, type: integer, minimum: 1, maximum: 100 },
  { name: website, type: string, format: url }, { name: due, type: date, minimum: today }]`
- **THEN** it yields `quantity: { type: integer, minimum: 1, maximum: 100 }`,
  `website: { type: string, format: uri, pattern: "^https?://" }` and
  `due: { type: string, format: date }`

#### Scenario: content becomes a media type

- **WHEN** the mapping is given `[{ name: note, type: string, content: markdown }]`
- **THEN** it yields `note: { type: string, contentMediaType: text/markdown }`

### Requirement: Rules hold wherever the signature holds

Every check that decides by the conformance rule SHALL enforce rules, with the rule's message:
the turn boundary over the trigger's `requires`, the completion check over its `returns`,
`archmax_set_variables` writing a typed return (a correctable tool refusal), a delegation's
arguments before the child runs, and a child's or a mock's returns when it settles.

#### Scenario: A firing breaking a rule does not start

- **WHEN** a session starts on `requires: [{ name: quantity, type: integer, maximum: 100 }]`
  seeded with `quantity: 101`
- **THEN** no model call is made and the session is refused naming the trigger and
  `'quantity' must be at most 100`

#### Scenario: A return breaking a rule is refused at the write

- **WHEN** the current turn's trigger declares `returns: [{ name: contact, type: string,
  format: email }]` and the agent writes `contact: "nobody"`
- **THEN** the call is refused naming the trigger and `'contact' must be an email address`,
  nothing is written, and the session continues

#### Scenario: A completion with a return breaking a rule is rejected

- **WHEN** a session finishes in a terminal state with `contact` holding a value that breaks
  its rule, set another way than `archmax_set_variables`
- **THEN** the session is rejected naming the state and the rule's message

#### Scenario: A delegation argument breaking a rule is refused

- **WHEN** a caller invokes `archmax_workflow_<slug>` whose `manual` trigger declares
  `requires: [{ name: priority, type: string, enum: [low, high] }]` with `priority: "urgent"`
- **THEN** the call is refused `invalid-param` before the child runs, naming
  `'priority' must be one of low, high`

#### Scenario: A child's return breaking a rule fails the call

- **WHEN** a child settles with a declared return that breaks its rule
- **THEN** the call fails `invalid-return` with the rule's message

### Requirement: The agent is told an entry's rules

Where the system prompt renders the current trigger's signature, an entry that declares rules
SHALL be rendered with them, after its type, as short phrases (`name (type; rule; rule) —
description`), so the agent is told what a value must look like before a write is refused for
it. An entry without rules SHALL render exactly as before.

#### Scenario: A ruled return is rendered with its rules

- **WHEN** the current trigger declares `returns: [{ name: contact, type: string, format: email,
  maxLength: 80, description: "The contact address." }]`
- **THEN** the prompt renders `- contact (string; an email address; at most 80 characters) — The
  contact address.`

#### Scenario: An entry without rules renders as before

- **WHEN** the current trigger declares `requires: [{ name: due, type: date }]`
- **THEN** the prompt renders `- due (date)`
