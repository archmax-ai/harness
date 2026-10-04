## MODIFIED Requirements

### Requirement: Results on stdout, narration on stderr, three exit codes

Every command SHALL write its result to stdout and everything else to stderr: `run`, `decide`,
`reply` and `deliver` write the session's reply (or what it said as it parked); `test` writes
the summary line; `validate` the verdict line; `sessions` the listing; and with `--json`
(`test`, `validate`, `sessions`) a machine-readable document and nothing else. Stderr carries
the session header, the state flow, warnings, park reports and resume hints, and the usage
footer. Exit codes SHALL be 0 when the command did its job — a park counts — 1 on failure, 2 on
usage error. A session that ended with `archmax_raise` SHALL be a failure, and its exit code SHALL
NOT become the process's exit code. `--verbose` SHALL add one raw line per lifecycle event on
stderr.

#### Scenario: Redirecting stdout captures only the answer

- **WHEN** a user runs `archmax run order-lookup "…" > answer.txt`
- **THEN** the file holds only the reply and the state flow went to the terminal

#### Scenario: A park is a success

- **WHEN** a `run` ends with the session parked at a human state
- **THEN** what the session said goes to stdout, the park report and `archmax decide` hint to
  stderr, and the exit code is 0

#### Scenario: A rejected session is a failure

- **WHEN** a `run`, `decide` or `deliver` ends with the session rejected — a start refused for a
  missing or mistyped `requires` input, a completion short of its `returns`, a failed hook
- **THEN** `✖ rejected` and the reason go to stderr, whatever the session last said goes to
  stdout, nothing reports it as an answer, and the exit code is 1

#### Scenario: A session that raised is a failure

- **WHEN** a `run`, `decide` or `deliver` ends with the agent calling
  `archmax_raise({ code: "orders-unavailable", reason: "The orders API is down." })`
- **THEN** `✖ failed`, the state, the code and the reason go to stderr, whatever the session last
  said goes to stdout, nothing reports it as an answer, and the exit code is 1

### Requirement: `archmax sessions`

`archmax sessions [session] [--workflow <slug>] [--json]` SHALL list durable sessions from the
configured session store — id, status, open/finished classification, current state,
`awaiting=<state>` with the wait reason and `due=<instant>` for an `archmax_wait` park or the
decision context for a human state, `exit=<code>` for a `failed` session, and the names (never the
values) of its variables — or, with an id, print that session in full with each variable's value
and lock state and, for a `failed` session, its exit code and reason. `--json` writes the
`SessionSummary` or the array of them. An unusable id is a usage error; an id naming no durable
session exits 1 naming the listing command.

#### Scenario: Parked session in the listing

- **WHEN** a session is parked at a human state
- **THEN** its row shows `awaiting=<state>` and the decision context follows

#### Scenario: Failed session in the listing

- **WHEN** a session's latest turn ended with `archmax_raise({ code: "orders-unavailable", … })`
- **THEN** its row shows status `failed` and `exit=orders-unavailable`, and `archmax sessions <id>`
  prints the code and the reason
