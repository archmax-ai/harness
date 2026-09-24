---
title: Using the CLI
description: Run, test, and validate workflows with the archmax CLI, covering arguments, output streams, exit codes, and niceties.
sidebar:
  order: 8
---

The package installs an `archmax` binary with eight commands:

`run`, `test`, `validate`, `sessions`, `decide`, `reply`, `deliver`, `help`.

Arguments are **positional**, and the optional keyed things are flags:

| | |
| --- | --- |
| Positional | `<workflow>`, `<prompt>`, `<filter>`, `<session>`, `<message>`, `<command>` |
| Flags | `--root`, `--workflow`, `--trigger`, `--variables`, `--session`, `--session-path`, `--to`, `--comment`, `--verbose`, `--json` |

Each flag has one spelling, apart from `--help`, which also accepts `-h`.

Help comes from the command table, so it tracks the commands
themselves. `archmax help`, `archmax help <command>` and `archmax <command> --help`
all print it and exit 0. The full list is in the
[CLI reference](/reference/cli/).

A command is always required, so `archmax "<prompt>"` is read as an unknown
command rather than a prompt.

An unknown flag or a missing argument is a **usage error**. It prints one line on
`stderr`, suggests `try archmax <command> --help`, and exits **2**.

## Output and exit codes

Every command follows the same discipline:

- **Results on `stdout`**: the reply (`run`), the summary line (`test`), the
  verdict line (`validate`), the listing (`sessions`), the outcome line
  (`decide`/`reply`/`deliver`). With `--json`, the JSON document instead.
- **Narration on `stderr`**: the session header (workflow, directory, model),
  the [state flow](#the-state-flow), warnings, the token-usage footer.
- **Exit codes**: `0` when the command did its job, *including* when the
  session parked. `1` when something failed: a failed case, an invalid
  workflow, a refused turn. `2` for a usage error.

So `archmax run … > answer.txt` captures only the reply, and
`archmax test … --json > results.json` captures only the results.

## `run`

```bash
archmax run order-lookup "Which orders are delayed for Acme?"
archmax run order-lookup "…" --root ./my-workspace
archmax run "…" --root ./my-workspace        # <workflow> omitted: the workspace has exactly one
```

`run` assembles the workflow, runs one turn on a fresh session and prints the
reply. Both the workflow and the prompt are required. `<workflow>` may be
omitted when `workflows/` holds exactly one. With several, the error names
them. The prompt is the rest of the line, so quoting is the shell's business.

### The state flow

The session header and a live, colorized **state flow** go to `stderr`. State
changes sit at the outer margin. What happened inside each state is indented
beneath it: hook verdicts, tool calls, and the model's own text quoted with
`│`. `--verbose` adds one raw line per lifecycle event.

### Triggers and variables

A CLI run delivers a [trigger](/guides/triggers/), `manual` by
default. `--trigger <id>` enters the state declaring that trigger instead.
`--variables '<json>'` seeds the session's variables, locked:

```bash
archmax run order-lookup "Report requested" --trigger report_requested --variables '{"company":"Acme Corp"}'
```

Both fail before any model call. An unknown trigger id lists the declared ones
and exits 1. Malformed or non-object JSON is a usage error, exit 2.

### Sessions and parks

When the trigger declares a [session](/guides/sessions/) path, or
`--session <id>` is passed, `run` resolves the conversation first. One command
then starts a session *or* continues the one that conversation already has. A
delivery resumes a session parked for input, and a message is answered on a
session parked at a human state.

A park is a successful outcome. What the session *said* as it parked goes to
`stdout`. `stderr` reports the park itself: the state, the reason, and the
command that resumes it (`archmax deliver …` or `archmax decide …`). The exit
code is `0`.

## `test`

Runs the workflow's [cases](/guides/testing/):

```bash
archmax test order-lookup                 # every case
archmax test order-lookup requester       # cases whose path contains "requester"
archmax test order-lookup --json          # machine-readable results on stdout
```

`stderr` carries the header, then one block per case: a dimmed case header, the
state flow of the session under test, a styled verdict line, and per-case token
usage. The verdict line is ✔/✖/○, with failure details and grade scores
indented beneath. The closing summary comes last. `stdout` gets one summary
line (`9 passed, 1 failed, 0 skipped`) or the JSON document.

The exit code is `1` when any case failed. That includes a case whose only miss
is a `grade` below its `atLeast`. A filter that matches no case is an error
too: `no cases matched 'zzz' (12 discovered)`, exit 1. So a typo cannot produce
an empty green run. A disabled workflow's suite is reported as skipped and
exits `0`.

## `validate`

```bash
archmax validate order-lookup --root ./my-workspace
archmax validate order-lookup --json
```

Statically validates the workflow with **no model calls**: `workflow.yaml`, the
files it references, and its cases. Diagnostics render on `stderr`. `stdout`
gets `valid — 0 error(s), 2 warning(s)`, or the JSON `{ workflow, valid,
diagnostics }`. Exit `1` on any error diagnostic.

## Sessions and human decisions

```bash
archmax sessions                                   # listing; parked ones show awaiting=<state>
archmax sessions <session>                         # one session in full, variables with lock state
archmax sessions --json                            # the same, as JSON
archmax decide <session> --to refund-closed --comment "Matches policy."
archmax reply <session> "Any news on my refund?"   # answered, still parked
archmax deliver <session> --trigger email_reply --variables '{"reply_body":"It'"'"'s ORD-1001."}'
```

`decide` picks one of the parked state's transitions, and no model interprets
the choice.

`reply` talks to a session parked at a human state. It answers on a turn with no
tools, stays parked, and leaves the transition to `decide`.

`deliver` is the analogue for a session parked for input. It resumes the state
it parked in with the trigger that arrived.

These four commands need to know which workflow the session belongs to. In a
workspace with one workflow that is inferred. With several, pass
`--workflow <slug>`.

## Niceties

- On an interactive terminal, a small startup banner is printed to `stderr`. It
  is suppressed in CI/piped contexts, or explicitly with `ARCHMAX_CLI_NO_BANNER=1`.
- Output honours [`NO_COLOR`](https://no-color.org) and is plain when the stream
  is not a TTY.
- `--root <dir>` sets the workspace root, defaulting to the current directory.
  `.env` is loaded from that root.
