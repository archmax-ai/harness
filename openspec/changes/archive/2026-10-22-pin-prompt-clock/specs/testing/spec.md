## MODIFIED Requirements

### Requirement: A case is one YAML document

A case SHALL be a YAML mapping with a mandatory `title` (a single line of at most `CASE_TITLE_MAX_LENGTH` = 60 characters) and a mandatory `description` (at most `CASE_DESCRIPTION_MAX_LENGTH` = 200 characters), both measured and stored on whitespace-collapsed text so folded and literal blocks of the same prose score alike, and MAY carry `skip` (a non-empty reason string), `trigger`, `variables`, `workspace`, `mocks`, `clock` and `steps`. A case carries no version of its own. Unknown top-level keys SHALL be rejected with a message naming the unknown key and listing the known ones; every rejection names the file and the offending location.

#### Scenario: Missing or over-long prose rejected

- **WHEN** a case omits `title` or `description`, gives a multi-line `title`, or exceeds either budget
- **THEN** parsing fails with a message naming the field, its budget and the measured length where applicable

#### Scenario: Unknown top-level key rejected

- **WHEN** a case declares `version: "2"` or `bogus: true`
- **THEN** parsing fails naming the key and the known top-level keys

#### Scenario: Skipped case

- **WHEN** a case declares `skip: "pending fixture"`
- **THEN** its result is `skipped` with `skipReason` set, no records, no `sessionId`, and no turn is driven

## ADDED Requirements

### Requirement: Case-level clock

A case MAY declare `clock:` as a string in the forms the `clock` option accepts, or empty. Any other value SHALL fail parsing naming `clock` and the accepted forms. A non-empty `clock` SHALL be carried in the run configuration of every action of the case (`send`, `decide` and `deliver`), so it outranks the target's `clock` option for that case alone. A case with no `clock`, or an empty one, SHALL run under the target's option.

#### Scenario: A case runs on a pinned date

- **WHEN** a case declares `clock: 2026-03-20` against a target assembled without `clock`
- **THEN** every model call of every one of its turns shows `Current date and time: 2026-03-20 00:00 UTC (Friday)`

#### Scenario: Every action carries it

- **WHEN** a case declares `clock: 2026-03-20`, and its `send` parks at a human state that a later `decide` resumes
- **THEN** the park's handoff call and every model call after the `decide` show the pinned date

#### Scenario: Other cases keep the target's clock

- **WHEN** one case declares `clock: 2026-03-20` and the next case on the same target declares nothing
- **THEN** the next case's model calls show the real time

#### Scenario: An empty clock is no clock

- **WHEN** a case declares `clock: ""`
- **THEN** it parses, and runs under the target's option

#### Scenario: An invalid value is rejected

- **WHEN** a case declares `clock: "2026-03-20T10:00"`, `clock: "next tuesday"` or `clock: true`
- **THEN** parsing fails naming `clock` and the accepted forms
