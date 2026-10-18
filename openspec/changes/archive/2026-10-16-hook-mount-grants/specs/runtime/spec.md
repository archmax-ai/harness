## MODIFIED Requirements

### Requirement: The hook function contract

A script hook SHALL be a JavaScript module whose default export is a function receiving one object:
`state`, `phase`, `trigger` (the id), `variables` (a read-only name-to-value map), `messages` (the
recent transcript as plain data, runtime notes as `role: "runtime"`), `tools` (the privileged
tool-call bridge), and on an advance `from`, `to`, `reason`. It SHALL return `ok()`, `veto(reason)`,
`correct(reason)` or nothing (ok); throwing SHALL veto. A bare `false` and an `{ ok: false }` object
SHALL NOT be read as verdicts — a hook returns the verdict vocabulary or it has returned no verdict.
`import { ok, veto, correct,
defineHook } from "@archmax-ai/harness/sandbox"` SHALL be stripped in the sandbox and buy types only. Hooks
SHALL run in the same QuickJS sandbox as the sandbox tools, on runtime authority: the active state's
own governance does not bind their `tools.*` calls — neither its allow lists nor its `forbid` lists,
since a hook sits outside that surface in both directions — but the safety rules, the workflow's
`tools.forbid_always`, `skills.forbid_always` and `mounts.forbid_always`, the workflow's mount grants
(read on workflow scope: a governed mount some state or `allow_always` grants), and consumer rules
do, and each call emits tool telemetry with `origin: "lifecycle"`. `task()` SHALL be available to hook
scripts and never to `archmax_eval`/`archmax_run`.

#### Scenario: Hook reads the transcript and vetoes

- **WHEN** a hook reads `scratchpad/refund.json` through `tools.readFile` and returns `veto(reason)`
- **THEN** the phase is rejected with that reason

#### Scenario: Throwing vetoes

- **WHEN** a hook throws
- **THEN** the phase is vetoed with the error as the reason, and the failure is terminal

#### Scenario: A legacy return shape is no verdict

- **WHEN** a hook returns `false` or `{ ok: false, reason }`
- **THEN** the value parses to no verdict and the phase vetoes fail-closed with a snippet of it,
  rather than being read as a veto

#### Scenario: A workflow denial binds a hook, a state's does not

- **WHEN** the active state declares `tools: { forbid: [read_file] }`, the root declares
  `tools: { forbid_always: [write_file] }`, and a hook calls both
- **THEN** the `read_file` call runs and the `write_file` call throws a governance error naming the
  workflow-wide denial

#### Scenario: A hook reaches only the mounts its workflow grants

- **WHEN** the table governs `ledger`, no grant of the workflow names it, and a hook calls
  `tools.readFile("ledger/2026.csv")`
- **THEN** the call throws a governance error with `mount.not-allowed`, and the hook can catch it
