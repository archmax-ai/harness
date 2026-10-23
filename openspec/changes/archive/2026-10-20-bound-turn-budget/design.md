## Context

See proposal.md for the motivation and the specs for the rules.

- **Per-state counting today.** `stateTurns: { state, count }` (`src/workflow/state.ts`) is
  checked in `beforeModel` (`src/workflow/middleware.ts:300`). A call that would exceed
  `maxTurns` goes to `routeFailure` (`src/workflow/on-error.ts`), which routes to `on_error` or
  commits `rejected` and jumps to the end. The handler's first call is then counted against its
  own state.
- **Where a turn starts.** A turn opens in `beforeAgent` (`src/workflow/turn-boundary.ts`). A
  decision, reply or delivery is a `Command` resume through the same turn runner
  (`createTurnRunner`, `src/workflow/turn-runner.ts`) and does not pass the turn boundary.
  `parkCounts` keeps counting across a resume. The step limit does not: each invoke gets a fresh
  `recursionLimit`.
- **Measured.** An A↔B cycle uses about 7 graph steps per model call: 57 calls in 400 steps
  before `GraphRecursionError`. Afterwards the checkpoint stays at `status: running`, and
  `resolveSession` refuses the session for good. A model failing mid-stream does the same.
- **The step limit.** `AGENT_DEFAULT_CONFIG.recursionLimit` is 400 (`src/agent.ts:39`), merged
  under the caller's config in `send` and the resumes. A delegated child gets
  `DEFAULT_RECURSION_LIMIT` in `childConfig` (`src/workflow/sub-workflow.ts:718`).
- **The race.** `MemorySaver.put` creates `storage[thread][ns] = {}`, awaits serialization, then
  stores the checkpoint. A `getTuple` that runs in that window takes `Object.keys({})[0]` as the
  checkpoint id and throws on the destructuring.

## Goals / Non-Goals

**Goals:**

- One count, one place: model calls per invocation, enforced beside `maxTurns`.
- No turn ever leaves a session at `running` when it stops.

**Non-Goals:**

- Telling loops apart from intended cycles. A plain count with a generous default, which an
  author can raise, replaces any judgement about progress.
- Rolling a crashed turn back. Following LangGraph, a thread that errored stays usable from its
  last checkpoint. Here the session is marked `failed` and the next message starts a fresh turn.
- Unsticking a delegated child whose own invocation threw. Each dispatch gets a new child id, so
  a stuck child is never entered again except to resume a park, which never reaches `running`.
- Fixing the late write itself. Only its effect on readers is fixed; the write belongs to
  LangGraph's run after an abort.

## Decisions

**1. Count per invocation with a stamp, not with resets at every entry point.**
The turn runner stamps each invoke with an invocation id in `configurable` (a UUID per
`drive()`). The counter is `turnCalls: { invocation, count, exhausted? }`, read the way
`stateTurns` is read: a different invocation id counts from zero. This covers turns, decisions,
replies and deliveries from one place, with no edits to the three resume paths in `parks.ts`.
A delegated child's invocation gets its own stamp, so it counts against its own workflow.
- *Alternative: reset at the turn boundary and in each resume path.* It is four sites, and a
  future resume path that forgets the reset would silently share a budget. Rejected.

**2. The cap sits in `beforeModel`, before the `maxTurns` check, and routes once.**
When `count + 1 > maxModelCalls` and the counter is not yet `exhausted`, the call goes to
`routeFailure` with the reason "the turn exhausted its budget (maxModelCalls: N)", and
`exhausted: true` is committed. Once `exhausted`, the turn budget is not checked again. The
handler is bounded by its own `maxTurns` and by the step limit (decision 4). Without the
once-only rule, the handler's first call would trip the cap again.

**3. The warning is a line in the volatile block.**
`volatileSection` (`src/workflow/governance.ts`) adds one line when `maxModelCalls - count` is a
fifth of the budget or less: "This turn has N model calls left. Finish what you are doing and
answer the person." It lives in the volatile block, so the cacheable prefix is untouched. A
refused advance would miss a loop that stays in one state, and would refuse legitimate moves.

**4. The step limit is derived: `(maxModelCalls + 10) × 8`, never below 400.**
8 steps per call is one above the measured 7, and 10 calls of headroom let the error handler
run. The default budget of 50 gives 480. The limit is computed once per assembly from the
machine and used where `AGENT_DEFAULT_CONFIG` is merged (turns and resumes) and in
`childConfig` from the child's machine. The caller's config is still merged last, so a host's
`recursionLimit` wins.
- *Alternative: watch `langgraph_step` and stop a margin before the real limit.* The step count
  is cumulative across a thread and resumes start new invokes, so the turn's starting step would
  have to be recorded too. Rejected: the derived limit gets the same guarantee without that
  bookkeeping.

**5. A thrown invocation is marked failed in the turn runner, then rethrown.**
`drive()`'s existing `catch` (`src/workflow/turn-runner.ts:105`) reads the session's checkpoint.
When its status is `running`, it writes `{ status: failed, raised: { code, reason } }` with
`graph.updateState`, then rethrows the original error. The code is `recursion-limit` for
`GraphRecursionError`, `turn-cancelled` for an abort, and `turn-error` otherwise. The `raised`
channel is the one `archmax_raise` writes, so `exitOf`, `SessionSummary.exit` and
`resolveSession` (finished → `turn`) need no change. If the update itself fails, the original
error is still the one thrown, and the failure is reported as a `warning` event.
- *Risk to prove first:* `updateState` after a throw needs an `asNode` that LangGraph accepts
  for these channels. The first task is a test that proves it before anything is built on it.

**6. `getTuple` treats an empty namespace as absent.**
`BackendCheckpointSaver.getTuple` returns `undefined` when no `checkpoint_id` is asked for and
the session's namespace holds no checkpoint. That is the only read that destructures the
newest entry. `list` already tolerates an empty map.

## Risks / Trade-offs

- [A long, legitimate turn now ends at 50 calls] → It is a behaviour change, called out in the
  changelog. The fix is one line in `workflow.yaml`, and the step limit follows it.
- [8 steps per call underestimates a call that runs hooks, sub-workflows or large tool batches]
  → The handler headroom absorbs some of it. Whatever still reaches the step limit is caught by
  decision 5, so the session is never stranded.
- [The warning line changes the volatile block near the end of long turns] → It is volatile by
  design. Cases that pin the prompt text only see it after 80% of the budget.
- [`updateState` after a crash could fail on some backends] → The original error is still
  thrown, and the session stays as stuck as it is today, never worse. The `warning` event names
  it.

## Migration Plan

Workflows whose turns need more than 50 model calls add `budget: { maxModelCalls: N }` at the
root. Nothing else migrates. A session already stuck at `running` from an earlier version
remains stuck until `sessions.delete`; this change prevents new ones.
