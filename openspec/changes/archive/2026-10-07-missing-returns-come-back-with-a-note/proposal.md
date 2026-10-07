## Why

A child that finishes without setting a declared return fails its caller outright, although its
prompt tells it that it "does not complete until every one is set". In production an
`invoice-lookup` child failed after 31.9 s for two unset returns, and its caller had to dispatch it
again — the whole run repeated for two values. The caller's retry is not reliable either: the failed
dispatch commits `rejected` on the calling state, and nothing clears it when a later dispatch of the
same workflow succeeds, so a caller that recovers and finishes without a transition still routes
through `on_error`. Two failing children in one tool batch crash the turn, because both write the
one-value `rejected` channel in the same step.

## What Changes

- **A child short of its returns comes back with what it set, and a note.** The returns check runs
  once, as a session finishes, and hands nothing back — no extra model call, no repeated run. A
  sub-workflow child that left declared returns unset **completes**, and its caller's tool result
  carries the returns it did set plus
  `note: "Not all return variables were set by the sub-workflow: 'description' was not set."`. The
  calling agent decides what to do about the gap. A mocked dispatch follows the same rule.
- **What still fails.** A typed return holding a value of another type still fails the call
  (`invalid-return`), so a wrong-typed value never reaches a caller. A top-level session — which has
  no calling model to read a note — is still rejected when it finishes short of its returns, as
  today.
- **`note` is reserved.** A trigger's `returns` may not declare it (a load error), so the runtime's
  note can never be confused with a value a workflow produced.
- **The prompt says what happens.** The rendered signature tells a child that its caller gets the
  returns it set with a note naming the rest, and a top-level session that finishing short ends it
  rejected. The delegation tool's description says a run that finished short answers with what it
  set and a `note`.
- **A caller's retry recovers, one call at a time.** Each failed delegation call is recorded as one
  outstanding failure of the calling state, with its call id and its arguments (references
  resolved). A later successful call of the same workflow from the same state recovers **at most
  one** of them: the one whose arguments it repeats, else the oldest. So a corrected retry still
  recovers, but one success never recovers two failed calls. Two parallel calls that both failed need
  two successes, and `v0.3.1`'s routing of that case is kept. When the model finishes, every failure
  still outstanding routes through `on_error` (or ends the turn rejected) as before, and the route
  names each one with its arguments. Another workflow's success, a sibling call in the same batch,
  and a rejection with another cause recover nothing. Everything that already clears a pending
  rejection (an advance, a park, a reset, a new turn, a raise, an `on_error` route) clears
  outstanding failures too. The delegation tool description says so.
- **Fixed:** two delegation calls failing in one tool batch no longer crash the turn with
  `InvalidUpdateError`; both are recorded and the route names both, two calls of one workflow
  included.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `runtime`: a new requirement, "A session short of its returns settles on what it set" (a child
  completes, a top-level session or a mistyped return is rejected, nothing is handed back); the
  terminal-state requirement points at it; `on_error` routing defines when a failed delegation
  routes; the graph's channel list and the turn boundary's reset list gain the outstanding
  delegation failures; the rendered signature says what finishing short does.
- `delegation`: the requirement on the call's answer is replaced — a child short of its returns
  answers with what it set plus a `note`, a mistyped return still fails `invalid-return`, `note` is
  reserved; each failed call is recorded on its own, and a later successful call of the same
  workflow from the same state recovers at most one of them (the one it repeats, else the oldest),
  and nothing else does.

## Impact

- **Code:**
  - `src/workflow/signature-checks.ts`: the shortfall reading, `RETURNS_NOTE_VARIABLE` and
    `missingReturnsNote`.
  - `src/workflow/returns-check.ts` (new): the one completion decision — complete, or reject.
  - `src/workflow/middleware.ts`: `afterModel` completes or rejects on that decision, and routes
    `pendingFailure`; `governance.ts` passes whether the session is a child to the prompt.
  - `src/workflow/sub-workflow.ts`: a child's (and a mock's) returns are handed back with unset ones
    left out and a `note` added; `missing-return` is no longer raised.
  - `src/machine/spec-schema.ts`: `note` is reserved in `returns`.
  - `src/workflow/state.ts`: the `failedDelegations` channel (one record per failed call) and its
    reducer, `failureRecoveredBy`, `describeDelegationFailure`, `NO_PENDING_FAILURE`,
    `pendingFailure`.
  - `src/workflow/tool-service.ts`: a failed call records a failure with its resolved input, and a
    later success recovers at most one, never one a sibling success in the same step took.
  - `src/workflow/control-tools.ts`, `parks.ts`, `on-error.ts`, `turn-boundary.ts`: every site that
    cleared `rejected` clears outstanding failures with it.
  - `src/workflow/render-prompt.ts`, `src/workflow/workflow-tools.ts`: the model-facing text.
- **Public API:** no type changes. A delegation's `returns` may now carry `note`, and a
  `sub-workflow-result` event's `returns` names it. The new channel is checkpoint-internal.
- **docs/:** `guides/sub-workflows.md` (the note, the retry rule as a table),
  `guides/triggers.md` and `reference/machine-spec.md` (what `returns` enforces, `on_error` and a
  failed call), `guides/workflow-machine.md` (the check after the `after` hooks),
  `reference/public-api.md` and `reference/cli.md` (when a session short of its returns is
  rejected), `reference/changelog.md` (the entry under `0.4.0 (unreleased)`).
- **README.md:** the signature paragraph says what finishing short of `total` does.
- **skills/archmax-harness/:** `references/workflow-schema.md` and `references/workflow-yaml.md`:
  the note, the reserved name, the retry rule, and the `after`-hook route for a model that should
  try again.
- **Release:** part of `0.4.0`, labelled `release:minor`. **Breaking:** a workflow whose trigger
  declares a return named `note` fails to load and must rename it; a caller that relied on a failed
  call for a missing return reads `returns.note` instead. A recovered delegation no longer routes.
- **Platform handoff:** request 5 proposed a bounded correction turn; the maintainer chose this
  instead (7 October 2026) — no second attempt, the partial returns plus a `note`.
