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
  missing or mistyped `requires` input, a completion short of its `returns`, a code or grader
  state that failed with no `on_error` to route to
- **THEN** `✖ rejected` and the reason go to stderr, whatever the session last said goes to
  stdout, nothing reports it as an answer, and the exit code is 1

#### Scenario: A session that raised is a failure

- **WHEN** a `run`, `decide` or `deliver` ends with the agent calling
  `archmax_raise({ code: "orders-unavailable", reason: "The orders API is down." })`
- **THEN** `✖ failed`, the state, the code and the reason go to stderr, whatever the session last
  said goes to stdout, nothing reports it as an answer, and the exit code is 1

#### Scenario: An automated state that raised is a failure

- **WHEN** a `run` ends with a code state's script or a grader calling `archmax_raise`
- **THEN** `✖ failed`, the automated state, the code and the reason go to stderr, and the exit
  code is 1

### Requirement: The live state flow

While a governed session runs, `run` SHALL render a live, append-only **state flow** to stderr
from the event stream: state changes at the outer margin, an automated state's like any other
state's, and beneath each state, indented, its tool calls, the model's own text quoted, and each
code or grader run. A code run SHALL render from its events: a line naming the script as it
starts (`code-start`), each console line nested beneath it (`code-output`), and a result line
(`code-result`), a check with the run's duration when its `status` is `ok` and a cross with the
reason when it is `error`. A grader run SHALL render the same way from `grader-start` and
`grader-result`, naming the grader state. A grader's run SHALL appear there although it reaches
no prompt, since the state flow is operator-facing. A call a script makes through `tools.*`,
an agent's or a code state's, SHALL be marked as coming from a script. Each transition SHALL be
reported once (the state lines and the advance reason, never the `archmax_advance` call itself),
whether the agent, a grader or a code state's script made it. A sub-workflow dispatch SHALL
render as indented activity under the calling state, nested depth named beyond one level, and a
child's own state events SHALL NOT appear as top-level states. Assembly-time and high-frequency
telemetry events SHALL be dropped from the state flow.

#### Scenario: Transition rendered once

- **WHEN** the agent calls `archmax_advance`
- **THEN** the state flow shows the leaving state finalised, the reason, and the entered state —
  and no separate tool-call line for the advance

#### Scenario: A code run is visible to the operator

- **WHEN** a session enters a code state whose script logs one line and calls
  `tools.archmax_advance({ to: "refund-review", reason: "matches the policy" })`
- **THEN** the state flow shows the code state, beneath it the run naming its script, the logged
  line nested deeper, a check with the run's duration and the reason, then `refund-review`
  entered — and no separate tool-call line for the advance

#### Scenario: A grading dispatch is visible to the operator

- **WHEN** a grader calls `archmax_get_history` and sends the session back to the agent state
  with a correction
- **THEN** the state flow shows the grader state, beneath it the grader's run, its
  `archmax_get_history` call, a check with the run's duration and the correction, then the agent
  state entered again

#### Scenario: A failed automated run

- **WHEN** a code state's script throws
- **THEN** the run's result line is a cross carrying the reason, followed by the `on_error` route
  when the state declares one

### Requirement: `archmax validate`

`archmax validate [workflow] [--json]` SHALL statically validate the workflow and its cases with
no model calls, render diagnostics on stderr and write `valid — N error(s), N warning(s)` (or
`invalid — …`) to stdout, or with `--json` `{ workflow, valid, diagnostics }`; exit 1 on any
error diagnostic. It SHALL validate a disabled workflow in full, adding the disabled warning.
Runtime-contract failures SHALL be surfaced as diagnostics naming the declared and supported
contracts, a declared contract `1` or `2` included. The load errors of grader and code states
SHALL be reported the same way: a state that still declares `before` or `after` as the
unrecognized key it is, naming the key and its path, and every error the workflow spec defines
for an automated state (see `workflow-spec`).

#### Scenario: Invalid workflow

- **WHEN** the spec has an unknown key
- **THEN** the diagnostic naming the key prints to stderr, stdout gets the `invalid` line, exit 1

#### Scenario: A leftover before or after key

- **WHEN** a state still declares `after: { script: hooks/check.js }`
- **THEN** an error diagnostic names the unrecognized key `after` at `states.<state>.after`,
  stdout gets the `invalid` line, and the exit code is 1

#### Scenario: A retired runtime contract

- **WHEN** the spec declares `runtime: { engine: archmax-harness, version: "2" }`
- **THEN** an error diagnostic names `archmax-harness@2` and the supported `archmax-harness@3`,
  stdout gets the `invalid` line, and the exit code is 1

#### Scenario: A code state without a script

- **WHEN** a state declares `type: code` and no `script`
- **THEN** an error diagnostic names the state and the missing `script`, stdout gets the
  `invalid` line, and the exit code is 1
