## Why

The agent has no way to say "this session failed". A session ends `completed` whenever the model
stops, so a run that found nothing to work on, or could not reach a system it depends on, looks to
the host exactly like a run that did its job. The only failure a host sees today is `rejected`,
which governance commits: a failed hook, a blocked call, a missing return. A headless workflow
fired by a webhook or a schedule has nobody reading its reply. Its host needs a machine-readable
answer to "did it work, and if not, why", given by the agent that knows.

## What Changes

- A new always-on control tool, `archmax_raise({ code, reason })`, ends the session as a failure
  from any state. `code` is a short free-form string (for example `order-not-found`). `reason` is
  one or two sentences saying what failed. Calling the tool always means failure: there is no
  `success` argument, so the tool cannot be used to end a session that worked.
- A session that ends without `archmax_raise` is a success. The tool description and the platform
  prompt tell the model to call it only when the work cannot be completed and recovery has been
  tried. They also say it is not a way to finish, to wait (`archmax_wait`), to go back
  (`archmax_reset`) or to ask a person (a human state).
- `archmax_raise` must be the only tool call in its message. A raise sent alongside other calls is
  refused, and the model can call it again on its own. Any message for the person goes in the
  text of that same assistant message.
- A new session status, `failed`, which counts as **finished**. A raise commits it at once and ends
  the turn without another model call. A raise does not consult `on_error`, runs no hook, skips the
  trigger's `returns` check, and replaces a rejection marker that is still pending.
- **Outcome:** a new kind, `failed`, and an `exit` record (`SessionExit`) on every finished
  outcome. A completed session carries `{ success: true }`. A failed one carries
  `{ success: false, code, reason }`. A rejected session carries no `exit`, because governance
  ended it, not the agent. `SessionSummary` carries the exit record of a failed session.
- A new lifecycle event, `raised` (`state`, `sessionId`, `code`, `reason`, `callId`).
- **Delegation:** a child that raises fails its caller's call with a new `SubWorkflowError` kind,
  `raised`. The tool error names the code and the reason. Like any other child failure, it is
  committed as the caller's rejection, which the caller can recover from or route through
  `on_error`. The caller's agent can also call `archmax_raise` itself to pass the failure up.
- **CLI:** `run`, `decide` and `deliver` report a failed session as `✖ failed` on stderr,
  with its code and reason, and exit 1. `archmax sessions` shows a failed session's status and
  its `exit=<code>`.
- **Cases:** a new structural assertion, `raised`, written as `true`, `<code>` or
  `{ code?, reason? }`. `succeeded: true` fails for a session that raised.
- Governance treats the tool like `archmax_wait`. It is never listed, it is disclosed in every
  state including terminal states, and `tools.forbid_always` or a state's `tools.forbid` can ban
  it. Scripts and hooks cannot call it, because control tools are absent from `tools.*`, and the
  reply-only turn refuses it like every other tool.
- **BREAKING (types):** `Outcome["kind"]` and `WorkflowStatus` each gain one member. A host that
  switches exhaustively on either must handle `failed`.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `runtime`: a new requirement for `archmax_raise`, covering its arguments, the refusals, how the
  session ends, and the `raised` event. The turn boundary clears the exit record.
- `governance`: `archmax_raise` joins the always-permitted control tools and the surface disclosed
  in every state.
- `assembly`: `send` settles a failed session to an `Outcome` of kind `failed`. Every finished
  outcome carries `exit`.
- `workspace-and-sessions`: `failed` joins the checkpointed statuses as a finished status, and
  `SessionSummary` carries the exit record.
- `delegation`: a child that raises fails the call with kind `raised`.
- `sandbox`: `archmax_raise` is absent from the `tools.*` bridge.
- `testing`: the `raised` assertion. `succeeded` fails on a session that raised.
- `cli`: failed sessions are reported and exit 1. The sessions listing shows the exit code.

## Impact

- **Code:**
  - `src/machine/tool-names.ts`: `RAISE_TOOL`, added to `HARNESS_CONTROL_TOOLS` and
    `ALWAYS_ALLOWED_TOOLS`.
  - `src/machine/machine.ts`: disclosure.
  - `src/workflow/control-tools.ts`: schema, declaration and `handleRaise`.
  - `src/workflow/tool-service.ts`: servicing.
  - `src/workflow/state.ts`: the `failed` status and the `exit` channel.
  - `src/workflow/turn-boundary.ts`: reset.
  - `src/workflow/middleware.ts` and `src/workflow/parks.ts`: the before-model end.
  - `src/core/events.ts`: `raised`.
  - `src/sessions/resume.ts`: `Outcome`, `settle` and `outcomeOf`.
  - `src/sessions/summary.ts`.
  - `src/workflow/sub-workflow.ts`: kind `raised`.
  - `src/testing/`: the `raised` assertion and `succeeded`.
  - `src/cli/turn.ts`, the sessions rendering and `src/cli/state-flow.ts`.
  - `src/core/platform-prompt.md`, and the generated module from it.
  - `src/index.ts`: export `SessionExit`.
- **Public API:** `SessionExit`, `Outcome.exit`, `DecideOutcome.exit`, `SessionSummary.exit`,
  `Outcome["kind"]` `failed`, `WorkflowStatus` `failed`, and the `raised` event.
  `docs/src/content/docs/reference/public-api.md` must list them, because the barrel is tested
  against that page in both directions.
- **docs/:**
  - `guides/workflow-machine.md`: the control tools, and ending a session as a failure.
  - `reference/machine-spec.md`: the control tool list, and the note that a raise bypasses
    `on_error`.
  - `guides/sessions.md`: statuses, the `failed` outcome and the `exit` record.
  - `guides/sub-workflows.md`: a child that raises.
  - `guides/testing.md`: `raised`, and the new meaning of `succeeded`.
  - `guides/cli.md` and `reference/cli.md`: `✖ failed`, exit 1, and the `exit=` column.
  - `reference/public-api.md`.
  - `reference/glossary.md`: **raise**, and how `failed` differs from `rejected`.
  - `reference/changelog.md`.
- **README.md:** a short mention of the agent signalling failure with `archmax_raise`, and of the
  `failed` outcome hosts now receive, in the part that introduces the control tools and outcomes.
- **skills/archmax-harness/:**
  - `references/workflow-schema.md` and `references/workflow-yaml.md`: the always-on control
    tools, and forbidding `archmax_raise`.
  - `references/hook-and-test-scripts.md` and `references/cases.md`: the `raised` assertion.
  - `references/wiring.md` and `references/backend-integration.md`: `Outcome` kind `failed`,
    `exit`, and the `raised` event.
  - `SKILL.md`: when an author should expect or forbid a raise.
- **Reference workspace:** a case in `examples/customer-support/` exercising a raise against a
  mocked failing tool.
- **Release:** `release:minor`. The change adds a feature, and its only break is at the type level.
