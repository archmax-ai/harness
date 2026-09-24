---
title: CLI reference
description: Arguments, options, streams and exit codes for archmax run, test, validate, sessions, decide, reply, deliver and help.
sidebar:
  order: 2
---

```
archmax <command> [arguments] [options]
```

Arguments are positional. Options are flags, each with one spelling apart from
`--help`, which also accepts `-h`. Help comes from the command table, so
`archmax help`, `archmax help <command>` and `archmax <command> --help` all print
it and exit 0.

## Conventions

| | |
| --- | --- |
| `stdout` | The command's result: a reply, a verdict or summary line, a listing, or the `--json` document. |
| `stderr` | Narration: the session header, the state flow, warnings, the token-usage footer, `--verbose` event lines. |
| exit `0` | The command did its job; a park counts. |
| exit `1` | A failure: a failed case, an invalid workflow, a refused turn, a runtime error the CLI recognises. |
| exit `2` | A usage error: unknown flag, missing argument, malformed `--variables`, unusable session id. One line plus `try archmax <command> --help`. |

### Global options

| Option | Meaning |
| --- | --- |
| `--root <dir>` | Workspace root (default: current directory); `.env` is loaded from it. |
| `--help`, `-h` | Help for the command. |

### The `<workflow>` argument

`run`, `test` and `validate` take the workflow slug (`workflows/<slug>/`) as
their first argument. It may be omitted when the workspace holds exactly one
workflow, and with several the usage error names them. There is no default
workflow.

The session commands take the session as their argument and name the workflow
with `--workflow <slug>`, with the same inference.

## `archmax run`

```
archmax run <workflow> <prompt...> [--trigger <id>] [--variables <json>] [--session <id>] [--session-path <path>] [--verbose]
```

Runs one turn and prints the reply to `stdout`. Both arguments are required, and
the prompt is the rest of the line.

| Option | Meaning |
| --- | --- |
| `--trigger <id>` | Trigger starting the turn (default `manual`). It enters the state declaring it. An undeclared id fails before any model call, listing the declared triggers (exit 1). |
| `--variables <json>` | Session variables as a JSON object, seeded locked. Malformed or non-object JSON is a usage error (exit 2). |
| `--session <id>` | The conversation this firing belongs to: continues the session that carries it, or starts one under that id. |
| `--session-path <path>` | Dotted path into `--variables` holding the session id, overriding the trigger's declared session path. |
| `--verbose` | One raw line per lifecycle event on `stderr`. |

Session resolution runs when the trigger declares a session path, or when either
session option is given. A `resume` disposition delivers the trigger to a
session parked for input, and a `reply` disposition answers a session parked at
a human state. Otherwise a turn starts.

A park exits `0`. What the session said goes to `stdout`, the park report and
the resuming command to `stderr`.

A workflow declaring `disabled: true` refuses to start a turn: exit 1, nothing
on `stdout`. Resuming a parked session is still allowed.

After the reply, the token-usage footer prints on `stderr` when the provider
reported usage (`tokens     in 20,369 · out 287 · …`).

## `archmax test`

```
archmax test <workflow> [filter] [--json] [--verbose]
```

Runs the workflow's cases (`workflows/<slug>/tests/*.test.yaml`). `filter` keeps
the case files whose path contains it. Suite configuration (`caseTimeoutMs`,
`judge`) comes from the [`tests` block](/reference/machine-spec/#tests).

- `stderr`: the header, then per case a case header, the state flow, a verdict
  line with failure details and grade scores, and per-case token usage. The
  summary and the total usage close it.
- `stdout`: `N passed, N failed, N skipped`. With `--json`, the object
  `{ workflow, results, exitCode, discovered, skipped? }` instead, where
  `results` is the `CaseResult[]` of `@archmax-ai/harness/testing`.
- Exit `1` when any case failed, a `grade` under its `atLeast` included.
  Exit `1` too when the filter matched no case:
  `no cases matched '<filter>' (N discovered)`. A disabled workflow's suite is
  skipped: `suite skipped — disabled`, exit `0`.

## `archmax validate`

```
archmax validate <workflow> [--json]
```

Statically validates the workflow and its cases with no model calls.
Diagnostics render on `stderr`. `stdout` gets `valid — N error(s), N warning(s)`,
or `invalid — …`, and with `--json` the object `{ workflow, valid, diagnostics }`
instead.

Exit `1` on any error diagnostic. A disabled workflow validates, with a warning.

Also a library call: `validateWorkflow({ rootDir, workflow })` from `@archmax-ai/harness`.

## `archmax sessions`

```
archmax sessions [session] [--workflow <slug>] [--json]
```

Without an argument, it lists the durable sessions. Each line carries the id,
the status, open or finished, the current state, `awaiting=<state>` for a parked
session, and the names of its variables.

A parked session also shows the wait reason and `due=<instant>` for a
`archmax_wait` park, or the decision context for a human state.

With a session id, prints that session in full. Each variable comes with its
value and whether it is **locked**. Locked means the host established it: a
seed, a delivery, or the built-in `trigger`. `--json` writes the
`SessionSummary`, or the array of them, to `stdout`.

## `archmax decide`

```
archmax decide <session> --to <state> [--comment <text>] [--workflow <slug>] [--verbose]
```

Resumes a session parked at a human state by taking the named transition. The
routing is deterministic, so no model interprets the choice.

Fails (exit 1) when the session is not parked or `--to` is not a declared
transition of the parked state. The resumed session's reply, or a line saying
where it parked again, goes to `stdout`.

## `archmax reply`

```
archmax reply <session> <message...> [--workflow <slug>] [--verbose]
```

Sends a message to a session parked at a human state. The session answers on a
turn with no tools and stays parked, with the same decision pending. The answer
goes to `stdout`, the still-parked reminder to `stderr`.

Routing stays with `decide`, whatever the message says. Fails (exit 1) when the
session is not awaiting a decision, and an empty message is a usage error.

## `archmax deliver`

```
archmax deliver <session> --trigger <id> [--variables <json>] [--workflow <slug>] [--verbose]
```

Resumes a session parked for input by delivering the trigger that arrived. The
session continues in the state it parked in, the trigger becomes its current
one, and `--variables` seeds what the event carried, locked.

Any trigger id resumes a park: the flag is required, and its value is passed
through without being checked against the workflow. Fails (exit 1) when the
session is not parked for input.

## `archmax help`

```
archmax help [command]
```

The top-level command list, or one command's arguments and options.

## Environment

`ARCHMAX_CLI_NO_BANNER`, `NO_COLOR` and the model variables are listed in the
[configuration reference](/reference/configuration/).
