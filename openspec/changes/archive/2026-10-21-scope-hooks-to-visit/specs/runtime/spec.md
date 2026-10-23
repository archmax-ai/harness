## MODIFIED Requirements

### Requirement: The hook function contract

A script hook SHALL be a JavaScript module whose default export is a function receiving one object:
`state`, `phase`, `trigger` (the id), `variables` (a read-only name-to-value map), `messages` (the
transcript of the current visit as plain data, runtime notes as `role: "runtime"`, a tool result as
the tool's name and the call's `id` without its text), `toolCalls` (the query over the session's
tool results), `tools` (the privileged tool-call bridge), and on an advance `from`, `to`, `reason`.
It SHALL return `ok()`, `veto(reason)`,
`correct(reason)` or nothing (ok); throwing SHALL veto. A bare `false` and an `{ ok: false }` object
SHALL NOT be read as verdicts — a hook returns the verdict vocabulary or it has returned no verdict.
`import { ok, veto, correct,
defineHook } from "@archmax-ai/harness/sandbox"` SHALL be stripped in the sandbox and buy types only. Hooks
SHALL run in the same QuickJS sandbox as the sandbox tools, on runtime authority: the active state's
own governance does not bind their `tools.*` calls — neither its allow lists nor its `forbid` lists,
since a hook sits outside that surface in both directions — but the safety rules, the workflow's
`tools.forbid_always`, `skills.forbid_always` and `mounts.forbid_always`, the workflow's mount grants
(read on workflow scope: a governed mount some state or `allow_always` grants), and consumer rules
do, and each call emits tool telemetry with `origin: "lifecycle"`. No sandbox context, a hook
script's included, SHALL have `task()`: a model's verdict on a state is a `rubric` hook declared
beside the script.

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

#### Scenario: A tool result is read through toolCalls, not messages

- **WHEN** the agent calls `lookup` and then advances, and the leaving state's `after` hook reads
  both inputs
- **THEN** `messages` holds a `tool` entry naming `lookup` with the call's `id` and no result text,
  and `await toolCalls({ name: "lookup" })` returns that call with its arguments and its result

## ADDED Requirements

### Requirement: A hook sees its visit

A **visit** SHALL be the span of a session from its entry into a state until it next enters one.
Entering a state by an advance, a person's decision, an `on_error` route or `archmax_reset` SHALL
start a new visit, also when the state entered is the one the session was in. A turn that opens a
state its session was not in, the session's first turn included, SHALL start a new visit that
begins with the turn's opening message. A turn, a reply, a delivery or a sub-workflow's return
that continues in the state the session is in SHALL continue its visit, so a visit can span turns.
Visits SHALL be numbered from 1 in the order they start.

A hook SHALL see the visit of the state the session is in when the hook runs: on an advance from
`S`, `S`'s `after` hook and the target's `before` hook both see `S`'s visit; a terminal state's
`after` hook sees that state's visit; a `before` hook run at the start of a turn sees the visit that
turn opened, or the one it continues. `messages` SHALL be that visit's whole transcript, with no other bound: control calls
and runtime notes stay in it and take nothing else out of it. `messages` SHALL be read from the
session's own transcript in every phase, never from a summarized request prepared for the model.

`toolCalls(filter?)` SHALL resolve to the session's domain tool calls in the order they were made,
across every visit, each as `{ id, name, args, result, status, state, visit }`: `result` the tool's
result (parsed when it is JSON text), `status` one of `completed`, `failed`, `rejected` (refused by
governance) or `pending` (no result yet), `state` and `visit` where the call was made. The runtime's
control tools (`archmax_advance`, `archmax_reset`, `archmax_wait`, `archmax_raise`,
`archmax_get_variables`, `archmax_set_variables`) and runtime notes SHALL NOT appear in it. The
filter SHALL accept `name`, `state`, `visit` (a number or `"current"`), `status` and `last` (only
the last _n_ matches), every given key narrowing the result; only the matching calls SHALL be
copied into the sandbox. A result too large for the transcript is the transcript's pointer to its
offloaded file, as the agent saw it. Calls a script makes through `tools.*` are not tool calls of
the session's transcript and SHALL NOT appear.

#### Scenario: Control calls do not hide a tool result

- **WHEN** in one turn the agent calls `lookup`, makes twelve `archmax_get_variables` calls and then
  advances, and the leaving state's `after` hook vetoes unless it finds the `lookup` call
- **THEN** the hook finds it in `messages` and in `toolCalls`, and the advance commits

#### Scenario: A visit spans turns

- **WHEN** the agent calls `lookup` in state `confirm`, the turn ends there, and in the next turn the
  person writes "yes, go ahead" and the agent advances
- **THEN** `confirm`'s `after` hook sees the person's message and the `lookup` entry in `messages`,
  and `toolCalls({ visit: "current" })` returns the `lookup` call

#### Scenario: Re-entering a state starts a new visit

- **WHEN** the session moves `a` → `b` → `a`, calling `lookup` in each visit of `a`, and then
  advances out of `a`
- **THEN** `a`'s `after` hook sees in `messages` only the second visit of `a`, and
  `toolCalls({ name: "lookup" })` returns both calls with `state: "a"` and different `visit` numbers

#### Scenario: Both hooks of an advance see the visit being left

- **WHEN** the agent advances from `S` to `T` and both `S`'s `after` hook and `T`'s `before` hook
  read `messages`
- **THEN** both see the same transcript: `S`'s visit up to the advance

#### Scenario: A before hook at the start of a turn sees the person's message

- **WHEN** a session's first turn opens `identify-case`, whose `before` hook reads the first `user`
  entry of `messages`
- **THEN** that entry is the turn's opening message

#### Scenario: A summary is never the person speaking

- **WHEN** the session's transcript has been summarized for the model and a `before` hook runs
- **THEN** `messages` holds the visit's messages from the session's transcript, and no summary
  entry

#### Scenario: Control tools are not tool calls

- **WHEN** a visit made `archmax_set_variables`, `archmax_advance` and `lookup` calls
- **THEN** `toolCalls()` returns the `lookup` call and neither control call
