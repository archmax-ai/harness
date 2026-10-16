## MODIFIED Requirements

### Requirement: `archmax run`

The CLI SHALL send one turn through `agent.workflow.send` for `archmax run <workflow> <prompt...>
[--trigger <id>] [--variables <json>] [--file <variable>=<path>]... [--session <id>]
[--session-path <path>] [--verbose]`. The prompt is the rest of the line. `--trigger` (default
`manual`) names the trigger whose start state the turn enters; an undeclared id fails before any
model call, listing the declared ones (exit 1). `--variables` seeds session variables, locked.
`--file`, repeatable, reads the local file at `<path>` (relative to the working directory) and
hands it to the turn as `TurnInput.files[<variable>]` under the file's base name, so the variable
is seeded with its path in the session's `scratchpad/attachments/`; a `--file` without `=`, with
an invalid variable name, naming a variable twice or also given in `--variables`, or naming a
local file that can't be read SHALL be a usage error (exit 2). `--session` names the session; when
the trigger declares a `session:` path or a session option is given, the CLI resolves the session
first, so one command starts a session or continues the one the firing belongs to — a
`resume` disposition delivers into a session parked for input, a `reply` disposition answers a
session parked at a human state. A workflow declaring `disabled: true` SHALL be refused with one
line and exit 1 before anything starts, while resuming a parked session stays allowed.

#### Scenario: Trigger and variables

- **WHEN** a user runs `archmax run order-lookup "Report requested" --trigger report_requested --variables '{"company":"Acme"}'`
- **THEN** the turn enters the state declaring `report_requested` with `company` seeded locked

#### Scenario: A local file feeds a file input

- **WHEN** a user runs `archmax run reconcile "Reconcile this" --file invoice=./fixtures/invoice.pdf`
  on a workflow whose `manual` trigger declares `requires: [{ name: invoice, type: file }]`
- **THEN** the session holds `scratchpad/attachments/invoice.pdf` with the local file's bytes and
  `invoice` is seeded locked with that path

#### Scenario: A malformed file flag is a usage error

- **WHEN** a user passes `--file invoice`, `--file Invoice=./a.pdf` or `--file invoice=./missing.pdf`
- **THEN** the CLI prints one line naming the flag and the problem, starts nothing, and exits 2

#### Scenario: Disabled workflow refused

- **WHEN** the workflow declares `disabled: true`
- **THEN** `run` prints one line naming the workflow as disabled, starts nothing, and exits 1
