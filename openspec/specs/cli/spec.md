# cli Specification

## Purpose

Define the `archmax` command-line interface: eight commands over one declarative command table,
positional arguments with one spelling per option, results on `stdout` and narration on
`stderr`, three exit codes, and the shared visual language — the session header, the live state
flow, verdict lines and the usage footer — that `run`, `test`, `decide`, `reply` and `deliver`
all render from the typed event stream. The renderer ships as `@archmax-ai/harness/cli` so a host can
draw sessions the way the CLI does.

## Requirements

### Requirement: One command table drives parsing, help and dispatch

The CLI SHALL be a declarative command table (`src/cli.ts`, shapes in `src/cli/command.ts`)
over Node's `util.parseArgs` in strict mode. Each command declares its positionals (the last
may absorb the rest of the line), its options (one spelling each, `string` or `boolean`) and its
body. Help SHALL be generated from the table: `archmax help`, `archmax help <command>` and
`archmax <command> --help`/`-h` print it and exit 0. A command is required: a bare prompt is an
unknown command. Global options are `--root <dir>` (the workspace root, default the current
directory, from which `.env` is loaded) and `--help`.

#### Scenario: Help generated from the table

- **WHEN** a user runs `archmax help decide`
- **THEN** the usage line, arguments and options of `decide` plus the global options print to
  stdout and the process exits 0

#### Scenario: No command given

- **WHEN** a user runs `archmax "Which orders are delayed?"`
- **THEN** the CLI treats the text as an unknown command, prints one line naming the hint, and
  exits 2 without running anything

### Requirement: Usage errors exit 2 with one line

The CLI SHALL treat an unknown flag, a missing required argument, an unexpected extra argument,
malformed or non-object `--variables` JSON, an empty message, or an unusable session id as a usage
error: one line on stderr plus `try archmax <command> --help`, exit code 2, never a usage dump.
A failure the command establishes after parsing — a failed case, an invalid workflow, a refused
turn, a session that is not parked — SHALL exit 1 with one line.

#### Scenario: Unknown flag

- **WHEN** a user passes `--directory ./ws` to `run`
- **THEN** the CLI prints one line naming the flag and the `--help` hint and exits 2

### Requirement: The workflow argument and its inference

`run`, `test` and `validate` SHALL take the workflow slug as their first positional; the
session commands (`sessions`, `decide`, `reply`, `deliver`) SHALL take it as `--workflow <slug>`
because their argument is the session. In every command the workflow MAY be omitted when the
workspace's `workflows/` holds exactly one directory with a `workflow.yaml`; with several, the
usage error names them. There SHALL be no default workflow.

#### Scenario: Inferred in a single-workflow workspace

- **WHEN** a workspace has one workflow and the user runs `archmax run "hello"`
- **THEN** that workflow is used and the text is the prompt

#### Scenario: Ambiguous workspace

- **WHEN** a workspace has two workflows and the user omits the slug
- **THEN** the CLI exits 2 naming both slugs

### Requirement: Results on stdout, narration on stderr, three exit codes

Every command SHALL write its result to stdout and everything else to stderr: `run`, `decide`,
`reply` and `deliver` write the session's reply (or what it said as it parked); `test` writes
the summary line; `validate` the verdict line; `sessions` the listing; and with `--json`
(`test`, `validate`, `sessions`) a machine-readable document and nothing else. Stderr carries
the session header, the state flow, warnings, park reports and resume hints, and the usage
footer. Exit codes SHALL be 0 when the command did its job — a park counts — 1 on failure, 2 on
usage error. `--verbose` SHALL add one raw line per lifecycle event on stderr.

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

### Requirement: Session header and banner

Every command SHALL print a session header to stderr after loading `.env` from the root: the
workflow slug, the resolved workspace directory and the configured model (`ARCHMAX_MODEL`, or a
note that it is unset). On an interactive stderr the CLI SHALL first print the ASCII archmax harness
wordmark banner, to stderr only; the banner SHALL be suppressed when `ARCHMAX_CLI_NO_BANNER` is
set to a non-empty value or stderr is not a TTY.

#### Scenario: Banner never reaches stdout

- **WHEN** the banner is rendered
- **THEN** it is written to stderr only

#### Scenario: Piped stderr suppresses the banner

- **WHEN** stderr is redirected to a file
- **THEN** no banner prints

### Requirement: Shared styling honours NO_COLOR

All CLI-rendered output (banner, header, state flow, verdicts, footer) SHALL use one styling
helper (`createStyle`, `icons`) whose colour is suppressed — icons intact — when `NO_COLOR` is
set or the target stream is not a TTY.

#### Scenario: NO_COLOR set

- **WHEN** `NO_COLOR` is in the environment
- **THEN** output carries no ANSI codes and the check/cross/marker icons remain

### Requirement: The live state flow

While a governed session runs, `run` SHALL render a live, append-only **state flow** to stderr
from the event stream: state changes at the outer margin, and beneath each state, indented, the
hook verdicts (phases colour-coded), tool calls, and the model's own text quoted. A grading
rubric's dispatch SHALL appear there by name, since the trail is operator-facing and reaches no
prompt. Each transition SHALL be reported once (the state lines and the advance reason, never the
`archmax_advance` call itself). A sub-workflow dispatch SHALL render as indented activity under
the calling state, nested depth named beyond one level, and a child's own state events SHALL
NOT appear as top-level states. Assembly-time and high-frequency telemetry events SHALL be
dropped from the trail.

#### Scenario: Transition rendered once

- **WHEN** the agent calls `archmax_advance`
- **THEN** the trail shows the leaving state finalised, the reason, and the entered state — and
  no separate tool-call line for the advance

#### Scenario: A grading dispatch is visible to the operator

- **WHEN** an `after` rubric is dispatched and returns a verdict
- **THEN** the trail shows the dispatch under its state with the rubric's name and the verdict

### Requirement: Usage footer

After `run`, `decide`, `reply` or `deliver`, and per case and in total for `test`, the CLI SHALL
print a token footer to stderr (`tokens     in N · out N · cache r N/w N · $cost`) from the
session's usage, with cost only when priced; when no usage was reported the footer SHALL be
omitted rather than printing zeros.

#### Scenario: No usage metadata

- **WHEN** the model returned no usage metadata
- **THEN** no footer prints

### Requirement: `archmax run`

The CLI SHALL send one turn through `agent.workflow.send` for `archmax run <workflow> <prompt...>
[--trigger <id>] [--variables <json>] [--session <id>] [--session-path <path>] [--verbose]`. The
prompt is the rest of the line. `--trigger` (default `manual`) names the trigger whose start
state the turn enters; an undeclared id fails before any model call, listing the declared ones
(exit 1). `--variables` seeds session variables, locked. `--session` names the session; when the
trigger declares a `session:` path or a session option is given, the CLI resolves the session
first, so one command starts a session or continues the one the firing belongs to — a
`resume` disposition delivers into a session parked for input, a `reply` disposition answers a
session parked at a human state. A workflow declaring `disabled: true` SHALL be refused with one
line and exit 1 before anything starts, while resuming a parked session stays allowed.

#### Scenario: Trigger and variables

- **WHEN** a user runs `archmax run order-lookup "Report requested" --trigger report_requested --variables '{"company":"Acme"}'`
- **THEN** the turn enters the state declaring `report_requested` with `company` seeded locked

#### Scenario: Disabled workflow refused

- **WHEN** the workflow declares `disabled: true`
- **THEN** `run` prints one line naming the workflow as disabled, starts nothing, and exits 1

### Requirement: `archmax test`

`archmax test [workflow] [filter] [--json] [--verbose]` SHALL run the workflow's cases, keeping
only case files whose path contains `filter`. Stderr SHALL carry the header, then per case a
dimmed case header, the state flow of the session under test, a styled verdict line (check for
passed, cross for failed, a distinct marker for skipped, with the case id and title), failure
details, each `grade` outcome with its score and threshold, the count of assertions not
executed, per-case usage; then a summary naming passed, failed and skipped cases and the total
usage. Stdout SHALL be one line `N passed, N failed, N skipped`, or with `--json` the object
`{ workflow, results, exitCode, discovered, skipped? }` where `results` is the `CaseResult[]`
of `@archmax-ai/harness/testing`. Exit 1 when any case failed or the filter matched no case
(`no cases matched '<filter>' (N discovered)`); a disabled workflow's suite is reported skipped
(`suite skipped — disabled`) and exits 0.

#### Scenario: Filter matches nothing

- **WHEN** the filter matches no case file
- **THEN** the CLI reports the no-match line with the discovered count and exits 1

#### Scenario: Disabled suite skipped

- **WHEN** the workflow is disabled
- **THEN** one skipped line prints in the verdict style and the process exits 0

### Requirement: `archmax validate`

`archmax validate [workflow] [--json]` SHALL statically validate the workflow and its cases with
no model calls, render diagnostics on stderr and write `valid — N error(s), N warning(s)` (or
`invalid — …`) to stdout, or with `--json` `{ workflow, valid, diagnostics }`; exit 1 on any
error diagnostic. It SHALL validate a disabled workflow in full, adding the disabled warning.
Runtime-contract failures SHALL be surfaced as diagnostics naming the declared and supported
contracts.

#### Scenario: Invalid workflow

- **WHEN** the spec has an unknown key
- **THEN** the diagnostic naming the key prints to stderr, stdout gets the `invalid` line, exit 1

### Requirement: `archmax sessions`

`archmax sessions [session] [--workflow <slug>] [--json]` SHALL list durable sessions from the
configured session store — id, status, open/finished classification, current state,
`awaiting=<state>` with the wait reason and `due=<instant>` for an `archmax_wait` park or the
decision context for a human state, and the names (never the values) of its variables — or,
with an id, print that session in full with each variable's value and lock state. `--json`
writes the `SessionSummary` or the array of them. An unusable id is a usage error; an id naming
no durable session exits 1 naming the listing command.

#### Scenario: Parked session in the listing

- **WHEN** a session is parked at a human state
- **THEN** its row shows `awaiting=<state>` and the decision context follows

### Requirement: `archmax decide`

The CLI SHALL resume a session parked at a human state on `archmax decide <session> --to <state>
[--comment <text>] [--workflow <slug>] [--verbose]` by taking the named transition — deterministically, no
model interprets the choice. It SHALL fail with exit 1 and leave the session unchanged when the
session is not parked or `--to` is not a declared transition of the parked state. The resumed
session's reply, or a line saying where it parked again, goes to stdout.

#### Scenario: Undeclared target

- **WHEN** `--to` names a state the parked state has no transition to
- **THEN** the command fails with an actionable error and the session is not modified

### Requirement: `archmax reply`

`archmax reply <session> <message...> [--workflow <slug>] [--verbose]` SHALL send a message to a
session parked at a human state; the session answers on a turn with no tools and stays parked
with the same decision pending. The answer goes to stdout, the still-parked reminder to stderr.
An empty message is a usage error; a session not awaiting a decision exits 1. The command SHALL
accept no transition target.

#### Scenario: Reply does not route

- **WHEN** the message says "just approve it"
- **THEN** the session answers and remains parked on the same record

### Requirement: `archmax deliver`

The CLI SHALL resume a session parked for input on `archmax deliver <session> --trigger <id>
[--variables <json>] [--workflow <slug>] [--verbose]` by delivering the trigger that arrived: the session
continues in the state it parked in, the trigger becomes its current one, and `--variables`
seeds what the event carried, locked. The trigger id is required but not validated against the
workflow. A session not parked for input exits 1 and is left unchanged.

#### Scenario: Delivery resumes the parked state

- **WHEN** a session parked with `archmax_wait` receives `archmax deliver <id> --trigger email_reply`
- **THEN** the same state runs again with the arrival in its transcript and the reply prints

### Requirement: Parks are presented from the spec

When a session parks, the CLI SHALL report it on stderr in the same visual language as a
finished turn — `awaiting human decision` or `awaiting input`, the state (and title), the wait
reason and due time when declared, the session id — and print the follow-up command in
`archmax` subcommand form (`archmax decide <id> --to <state> [--comment "why"]` or
`archmax deliver <id> --trigger <id> [--variables …]`). The decision context (instructions,
approvers, evidence paths, transitions with their types) SHALL be computed from the workflow
spec and the park record on demand; nothing is rendered to a file.

#### Scenario: Human park report

- **WHEN** `run` ends parked at `refund-review`
- **THEN** stderr shows the awaiting line, the transitions with types, and the decide hint

### Requirement: The renderer is a public subpath

`@archmax-ai/harness/cli` SHALL export `renderEventLine`, `createStyle`, `icons`,
`createStateFlowRenderer`, `createTestView` and `caseVerdictLine` so a host can render sessions
and suites from the typed event stream the way the CLI does, without importing the CLI itself.

#### Scenario: Host renders a session

- **WHEN** a host passes `createStateFlowRenderer(...)` its `onEvent` events
- **THEN** it obtains the same trail lines `archmax run` writes
