## Context

See proposal.md for why the change is needed. This section describes how a session ends today.

- **Completion.** The governance `afterModel` hook (`src/workflow/middleware.ts`) settles a turn.
  When the model finishes with no tool calls and the session is not parked, the hook routes any
  committed `rejected` marker through `on_error`. Otherwise it runs a terminal state's `after`
  hook, checks the trigger's `returns`, and commits `status: completed`. Nothing the agent can call
  ends a session in any other way.
- **Rejection.** `rejected` is the runtime's failure: a hook error, exhausted corrections, a
  terminal kernel block, an exhausted budget, a failed sub-run, or a missing return.
  `routeFailure` (`src/workflow/on-error.ts`) sends it to `on_error` when the state declares one.
  Otherwise the turn ends `rejected`. A tool commits the marker in `wrapToolCall`, and it is
  routed once the model has finished.
- **Control tools.** These are declarations whose bodies never run. Governance intercepts each
  call in `wrapToolCall` and services it in `src/workflow/tool-service.ts` with a handler from
  `src/workflow/control-tools.ts`. The handler returns a `ToolMessage`, or a `Command` that
  commits state channels. `HARNESS_CONTROL_TOOLS` keeps control tools off the `tools.*` bridge.
  `ALWAYS_ALLOWED_TOOLS` permits them without a grant, and `WorkflowMachine.disclosedTools`
  offers them on every model call.
- **Ending a turn before a model call.** Both `beforeModel` sites can `jumpTo: "end"`.
  `routeFailure` does it from `before-model`, the reply-only guard does it once its call is
  spent, and a park's suspension does it as well.
- **Settling.** `settle` and `outcomeOf` (`src/sessions/resume.ts`) read the final channels into
  an `Outcome`. Its `kind` is `parked`, `rejected` or `completed`. The CLI (`src/cli/turn.ts`)
  exits 1 on `rejected`.
- **A child's failure.** In `sub-workflow.ts`, `settledReturns` throws `SubWorkflowError` for a
  rejected child. The caller's `serviceDelegation` answers with an error-status message and
  commits `rejected` on the caller.

## Goals / Non-Goals

**Goals:**

- The agent can end a session as a failure in one call, from any state, with a code and a reason
  that reach the host without anyone parsing text.
- A raise is final and deterministic. It spends no extra model call, leaves no half-moved
  position, and never races a sibling call.
- No current behaviour changes for a session that never calls the tool.

**Non-Goals:**

- **Author-declared exit codes.** A closed `raises:` vocabulary in `workflow.yaml` would give hosts
  a fixed set of codes, with each code's description telling the model when to use it. The free
  string was chosen for now. Declared codes can be added later as a constraint on the same tool,
  without changing the result shape.
- **A successful early exit.** A run that has nothing to do should simply finish. The tool means
  failure only.
- **Letting hooks gate a raise.** An author who must stop a raise in a state forbids the tool
  there.
- **Raising from scripts or hooks.** Control tools stay off the `tools.*` bridge. A hook's means
  of failing a session remain `veto` and `on_error`.
- **Mocking a child's raise in cases.** A delegation mock's `{ error }` already drives the caller
  down the same path: a tool error plus a rejection. Only the message text differs.
- **Mapping the agent's code to the process exit code.** See the decision below.

## Decisions

### The tool takes no `success`; the result does

The tool is `archmax_raise({ code, reason })`, and calling it always means failure. The result
carries `exit: { success, code?, reason? }`. A completed session gets `{ success: true }` and an
raised one gets `{ success: false, code, reason }`. This matches the request: a session is a
success unless the tool is called. It also makes "only call this on failure" part of the tool's
shape, not only something the prompt asks for.

- *Alternative: a `success` argument on the tool.* The model could then end a session that worked
  through a tool that exists for failures. The prompt would be the only thing preventing it.

### Free-string code, always on

`code` is any string of 1 to 64 characters with no line break. The tool is disclosed in every
state, terminal states included, the same way `archmax_wait` is. `tools.forbid_always` or a
state's `tools.forbid` removes it. The 64-character limit keeps the code a token rather than a
second reason, and a line break would break the CLI's one-line report.

- *Alternative: author-declared codes, with the tool shown only when codes are declared.* This is
  more governed, but it needs a schema addition, `validate` support and a disclosure rule. It is
  deferred (see Non-Goals).
- *Alternative: an integer code.* An integer reads like a process exit code but says less than
  `orders-unavailable`. The CLI could not use it as the process exit code anyway (see below).

### A new `failed` status, separate from `rejected`

A raise commits `status: failed`, and `failed` joins `FINISHED_STATUSES`. `Outcome.kind` gains
`failed`. `rejected` keeps its meaning: the runtime or governance ended the session. `failed`
means the agent declared that the work could not be done. A host can treat both as failure and
still tell them apart.

- *Alternative: reuse `rejected` and attach `exit`.* No new status, but agent-declared failure and
  governance refusal would become indistinguishable to any host that reads only `kind` or
  `status`.
- *Alternative: route the raise through `on_error`.* An error handler such as `notify-ops` could
  run, but if that handler then completes normally the session reads `completed` and the failure
  is lost. Keeping it would need an exit record that outlives routing, plus a rule for when
  `on_error` overrides it. A raise that ends the session at once is simpler to reason about.

### The raise is committed in `wrapToolCall` and the turn ends at the next `beforeModel`

`handleRaise` validates the arguments and returns a `Command`. The command commits the `raised`
channel (`{ code, reason, state }`, beside `rejected`) and `status: failed`, clears `rejected`, and appends the
tool's reply. `tool-service.ts` emits `raised` and `state-leave`. The tool node then routes back to
the model as it always does. The governance `beforeModel` checks for a committed `raised` record with
`status: failed` before anything else and returns `jumpTo: "end"`. `afterModel` never sees the
raise, so `on_error` routing, the terminal `after` hook and the `returns` check cannot run. Ending
before a model call is the pattern `routeFailure` and the reply-only guard already use, so no new
graph edge is needed.

- *Alternative: return `Command({ goto: END })` from the tool.* This depends on how the framework
  routes a tool node's `goto`, and no control tool does it today. It would also put routing into a
  handler that otherwise only commits channels.
- *Alternative: let the model take one more call to close.* That spends a model call on a failure
  path, and it gives the model a chance to keep working after declaring failure.

### `archmax_raise` must be alone in its message

The handler refuses a raise when the assistant message that carries it carries any other tool
call. The message's own `tool_calls` are read from the request state. The model's text in the same
message is not a tool call, so it is allowed, and it is where a closing word to the person goes.
This rule removes every same-step conflict: raise beside advance, wait or reset, two raises, or
writes still running when the turn ends.

- *Alternative: let a raise claim the step the way `archmax_advance` does.* That covers moves but not
  waits or ordinary calls. Siblings run concurrently, so which one claims the step would depend on
  timing.
- *Alternative: run the siblings and raise afterwards.* Then the raise's meaning would depend on
  sibling results the model had not seen when it decided to raise.

### No trail step, no hooks, no returns check

The audit trail records movement, and a raise moves nothing. A step whose `to` is the current
state would make `noTraversal` fail on a session that never moved. It would also let
`reachedState` pass for a state that no move reached. The raise is recorded in its own `raised` channel, in
the `raised` event and on the `Outcome` (as `exit`). An `after` hook checks the work a state finished, so running
one on a raise would check work the agent has just said it could not do. A veto would then trap
an agent that cannot go on. A failed session owes no `returns`.

### `exit` is absent on rejected and parked outcomes

`exit` is the agent's own account of how its turn ended. A rejected session was ended by
governance and already carries `rejected`. A parked session has not ended. Giving a rejected
outcome `{ success: false, code: "rejected" }` would create a reserved value inside a code space
the agent writes freely.

### A child's raise fails the caller's call with kind `raised`

`settledReturns` checks for `status: failed` before it checks returns, and throws
`SubWorkflowError("raised", …)`. The message names the child workflow, the state, the code and the
reason. `raised` is not a refusal kind, so `serviceDelegation` handles it like any child that ran
and did not finish: it answers with an error-status message and commits `rejected` on the
caller. The caller's agent can recover with a successful advance, which clears the marker. It can
also leave the marker to route through `on_error`, or call `archmax_raise` itself to pass the
failure up.

- *Alternative: answer with a plain tool error and no rejection.* An raised child would then be
  the only child that ran and failed without failing the calling state. That breaks "every
  failure fails closed".

### The CLI exits 1, whatever the code

Process exit codes 0, 1 and 2 already have fixed meanings: done, failure, usage error. The agent's
code is a string. `printFailed` in `src/cli/turn.ts` prints `✖ failed`, then the state, the code
and the reason, and returns 1, following `printRejected`.

### Guidance: a short tool description, plus one platform-prompt section

The tool description is sent on every call, so it stays short. It says that the tool ends the
session as a failure, to call it only when the task cannot be completed after recovery was tried,
that a session that ends without it is a success, to call it alone, and where the closing words
go. The platform prompt (`src/core/platform-prompt.md`) gets a short "When the work fails"
subsection that separates raising from wait, reset and human states, in the style of the existing
"wait vs advance" passage. The "Tools" paragraph's list of runtime controls gains "ending a failed
session".

## Risks / Trade-offs

- [The model raises too readily, for example on one failed call that a retry would fix.] → The
  description and the prompt both say to recover first. The tool-failure change already returns
  failures to the model so it can retry. An author can forbid the tool per state. The reference
  workspace gets a case, run against a live model, that pins a raise after repeated tool failure.
- [The model never raises. It says "I couldn't" and stops, and the session reads `completed`.] →
  That is today's behaviour, so nothing gets worse. The prompt names the situation, and an
  `raised` assertion in a case catches it.
- [A workspace that overrides the platform prompt (`.platform/system/GRAPH_STATE.md`) gets none of
  the new guidance.] → The tool description carries the essential rule. The changelog tells
  authors who override the prompt to add the section.
- [A host switching exhaustively on `Outcome.kind` or `WorkflowStatus` stops compiling, and one
  that tests `status !== "rejected"` reads `failed` as a success.] → The release is minor, with a
  changelog entry that names both patterns. `failed` only appears once a model calls the new
  tool.
- [Every model call carries one more tool definition.] → The description is kept to a few
  sentences, and it sits in the request's stable prefix, where prompt caching covers it.

## Migration Plan

Nothing to migrate. A checkpoint written before the upgrade has no `raised` channel, which reads as
absent, and no session can hold `failed` yet.

Rollback has one caveat. A runtime older than this change does not know `failed`, so it would not
classify such a session as finished. Leave sessions that ended `failed` alone, or delete them,
before rolling back.

Hosts should handle `Outcome.kind === "failed"`, and read `exit.code` wherever they need to branch
on why a session failed.
