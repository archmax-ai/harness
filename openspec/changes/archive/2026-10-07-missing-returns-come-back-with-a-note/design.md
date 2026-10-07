## Context

See proposal.md for why. This is how a session finishes today.

- **Completion.** The governance `afterModel` hook (`src/workflow/middleware.ts`) settles a turn
  once the model finishes with no tool calls in a state that is not parked. In order it routes a
  committed `rejected` through `on_error`, runs a terminal state's `after` hooks, checks the
  trigger's `returns`, and commits `status: completed`.
- **The returns check.** `returnsRejection` (`src/workflow/signature-checks.ts`) words what is
  unset or mistyped. `afterModel` commits it straight to `rejected` with `status: rejected`. It does
  not route through `on_error`. The dispatcher (`sub-workflow.ts`) recognises a child rejected by
  that very sentence and reports `missing-return` or `invalid-return` instead of `rejected`.
- **A failed delegation.** `serviceDelegation` (`src/workflow/tool-service.ts`) answers a failed
  child with an error tool message and commits `rejected: <reason>`. `rejected` is a one-value
  channel. A successful advance, a park, a reset, a raise, an `on_error` route and the turn boundary
  clear it. Nothing else does.

## Goals / Non-Goals

**Goals:**

- A child short of its returns costs nothing more: its caller gets what it set and a `note` naming
  the rest, and decides.
- A wrong-typed value never reaches a caller, and a top-level session's outcome is unchanged.
- A caller's successful retry recovers one failed call (the one it retried, or with corrected
  arguments the oldest), never two, and nothing else. N failed calls need N successes.
- No change to the public types or the event stream; the one authoring change is the reserved name.

**Non-Goals:**

- **A second attempt.** See the decision below.
- **Routing unmet returns through `on_error`.** Today they end the turn rejected. Changing that
  would be a separate behaviour change, and an error handler finishing in another state would face
  the same unmet returns there.
- **Changing what a script's delegation does.** A script receives its child's failure as a thrown
  error and decides itself. Nothing was committed on the state before, and nothing is now.
- **A resumed child that fails after a decision.** It already answers with an `[error]` note and no
  rejection. It is not touched.
- **A note for a top-level session.** Its host reads `outcome.returns` as data and has no model to
  act on prose; it keeps today's rejection.

## Decisions

### No second attempt: the partial returns and a `note`

Request 5 proposed handing a session short of its returns back for a bounded correction turn, the
way a terminal `after` hook's `correct` does; it was built that way first. The maintainer chose
otherwise: the child is not run again. It completes on what it set, and its caller's tool result
carries those returns plus `note: "Not all return variables were set by the sub-workflow: … was not
set."`. The caller — a model that can read the note — decides whether the gap matters, which is what
a second child turn would have spent a model call to guess.

*Alternative (rejected):* one correction turn, then the note. It keeps the extra call the handoff
wanted to save, and a model that forgot a value once tends to answer the note by finishing again.

### What still fails, and where

`checkReturns` (`returns-check.ts`) decides once, in `afterModel`, after the terminal `after` hooks:
complete, or reject with `returnsRejectionFor`'s reason. A mistyped return rejects any session, a
child included, and the dispatcher reports it as `invalid-return` — a value of the wrong type is not
"some returns", it is a broken contract. Unset returns reject only a top-level session; a child
completes, and `settledReturns` in the dispatcher builds the caller's `returns` with the unset names
left out (never handed on as `undefined`) and `note` added. A mocked dispatch goes through the same
helper, so a case sees what a real child would produce.

### `note` is reserved in `returns`

The caller must be able to tell the runtime's note from a value the child produced, so `note` cannot
be declared in a trigger's `returns` — a load error, as `title` already is. The schema spells the
name itself (it may not import the runtime); a unit test pins the two spellings together.

### Delegation failures get their own accumulating channel, one record per call

A failed call commits `failedDelegations: [{ id, state, workflow, input, reason }]` and no longer
writes `rejected`. `id` is the failed call's id. `input` is the call's arguments with `${{…}}`
references resolved against the caller's variables, which is what the child was seeded with. The
reducer appends each record under its id, so an echo changes nothing and two failed calls of one
workflow stay two records. It takes `{ recovered: <id> }` to remove exactly one record and `null`
to clear. `pendingFailure(state)` is what `afterModel` routes: `rejected` when set, else every
outstanding failure in the order they failed, each worded as its reason followed by
`(called with <arguments as JSON>)` when the call had arguments, so two failed calls of one
workflow read as two. `NO_PENDING_FAILURE` (`{ rejected: null, failedDelegations: null }`)
replaces `rejected: null` at every site that cleared it, so anything that forgave a failed
delegation before still forgives it.

- *Alternative: keep writing `rejected` and clear it on a successful retry.* `rejected` holds one
  string. After `enrich` fails and then `audit` fails, `rejected` names `audit`. A successful retry
  of `audit` would then clear it, and `enrich`'s failure would vanish unrouted. A non-delegation
  rejection overwritten by a later delegation failure would vanish the same way. Telling these cases
  apart would need provenance beside the string, and that provenance is this channel. A one-value
  channel also cannot take two failing calls in one tool batch, which is the `InvalidUpdateError`
  this fixes.
- *Alternative: one record per (state, workflow), the latest replacing an earlier one.* This was
  the first version of this change. It fails open on parallel calls: two `enrich` calls, for
  `ORD-1` and `ORD-2`, both fail, only `ORD-1` is retried, and the one success recovers the single
  record. The session then completes although `ORD-2`'s work never happened, which `v0.3.1`
  routed. It also collapses two failures of one batch into the later one, so the route names one.
- *Alternative: derive outstanding failures from the trail's `sub-workflow` steps.* Scripts'
  dispatches land on the trail too, and they never failed the state. Routing on the audit record
  would also give it a control role it does not have elsewhere.

### A success recovers at most one failure: the one it repeats, else the oldest

`failureRecoveredBy` picks, among the outstanding records of the same state and workflow, the oldest
whose `input` is structurally equal to the successful call's resolved input. That is `deepEqual`
from `src/core/match.ts`: JSON values compared by structure, object key order ignored, array order
kept, no partial matching. With no such record, it picks the oldest of that state and workflow. The
success commits `{ recovered: <that id> }`, and nothing when there is none.

- Repeating the input first means retrying `ORD-2` recovers `ORD-2`'s failure, not `ORD-1`'s, so
  the failure left to route is the one whose work is still missing.
- Falling back to the oldest means a retry with corrected arguments (`ORD-1` was a typo for
  `ORD-1b`) still recovers. Request 5 asked for that.
- Recovering one at most is the fail-closed half: N failed calls need N successes.
- *Alternative: recover only on an exact input match.* A corrected retry could then never recover,
  and the agent would have no way to fix a wrong argument short of a transition.
- *Alternative: compare the raw arguments.* `"${{order_id}}"` and the literal it names are one call
  to the child. Comparing the resolved input treats them as one.

### "Later" means a later model step, and siblings share out what they recover

`serviceDelegation` recovers only failures present in its own step's snapshot (`request.state`).
Sibling calls in one assistant message read the same snapshot, so a batch that fails and succeeds
the same workflow keeps the failure. This is deterministic, it does not depend on the order in which
the tools node applies sibling updates, and it fails closed: the agent can retry in its next step.

Because siblings share that snapshot, two successes in one step would otherwise both pick the same
oldest record. The tool service keeps, per session, the ids the current step's successes have
already recovered (`recoveredAtStep`, keyed by the step id the duplicate-transition guard uses), and
`failureRecoveredBy` skips them. Each success settles its pick synchronously after its dispatch
resolves, so there is no race between siblings. Two corrected retries in one step therefore recover
two failures, and a third success with nothing left recovers nothing.

## Risks / Trade-offs

- [A caller may ignore the note and use the partial returns as if complete] → the note sits in
  `returns` beside the values, the delegation tool's description says what it means, and the
  calling state's `requires:` still guards whatever the caller records.
- [A workflow already declaring a `note` return fails to load] → the load error names the reserved
  word; renaming the return is the migration.
- [A missed clearing site would leave a stale failure that routes later] → every former
  `rejected: null` now spreads `NO_PENDING_FAILURE`. A grep for `rejected: null` outside it comes
  back empty. The behaviour suite covers the advance, the retry and the turn-boundary cases.
- [The delegation tool description grows by one sentence] → a one-time cache miss on the tool block
  at upgrade, and the sentence is static.
- [The route's reason now carries the failed call's arguments, and so do `outcome.rejected` and
  the `state-error-routed` event] → the arguments are already on the stream in `tool-called.args`
  and in the transcript. A call with no arguments reads as before.
- [An old checkpoint parked or mid-turn with `rejected` set by a failed delegation] → it still
  routes, because `pendingFailure` reads `rejected` first. It just cannot be recovered by a retry.
  This affects only turns in flight at upgrade.

## Migration Plan

Rename any `returns` entry named `note`. No public type and no stored format changes. A checkpoint
without `failedDelegations` reads as having none. Rollback is a revert.
