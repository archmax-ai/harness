## Context

See proposal.md for the motivation and the specs for the rule.

- Every outcome is built by `settle(result, sessionId)` in `src/sessions/resume.ts`. It reads
  `reply` as `lastAgentText(messages)` over the session's whole transcript. It has two callers:
  `send`'s fresh-turn path in `src/assembly/index.ts:572`, and `resume()` in
  `src/sessions/resume.ts:534`, which serves `decide`, `reply` and `deliver`, including when they
  arrive through `send`.
- Before the turn runs, both paths already read the session's checkpoint: `send` through
  `resolveSession`, and `resume()` through `validate` → `readParkedSession`, which returns the
  checkpointed values, `messages` included.
- `patchToolCallsMiddleware` (Deep Agents) may rewrite the whole message list in `beforeAgent`
  (`REMOVE_ALL_MESSAGES` plus the patched list) when an earlier turn left a dangling tool call,
  which a cancelled turn can do. It keeps the original message objects and their ids, inserts a
  synthetic `ToolMessage` after each dangling call, and drops orphaned `ToolMessage`s.
  Summarization never edits `messages`; it records a cutoff instead.
- The case driver builds each step's view with `messagesToSessionView(outcome.messages, …)`, so
  `view.reply` is the session's last text. `judgeEvidenceFromView` hands `view.reply` to the
  grader and drops the record's last message when it equals the reply.

## Goals / Non-Goals

**Goals:**

- One reader computes a turn's reply, and every outcome type gets it from the same place.
- The turn's starting point stays correct when the message list is rewritten ahead of it.

**Non-Goals:**

- Scoping the case assertions (`reply`, `calledTool`, `usedNoTools`, the grader's record) to
  one action. That is a separate, breaking change. This change touches only the grader's reply.
- Surfacing a parked child's handoff message on its parent's outcome. While the child is parked,
  the parent is suspended inside its dispatch call, so its `reply` is whatever the parent said
  this turn. `delegation.sessionId` names the child for a host that wants the child's text.
- Taking back text written next to a refused or vetoed call. The transcript records it as said,
  the model believes it said it, and a streaming host has already shown it.
- A per-message list on the outcome. Hosts that want each message separately already have
  `messagesSince(messages, cursor)`.

## Decisions

**1. Mark the turn's start with the id of the last message before it, falling back to the count.**
Before invoking, the caller records `anchor = { id, count }` from the checkpointed messages: the
last message's id and the list's length. After the turn, the turn starts at the index of the
message with that id, plus one. When no message has that id, or there were no messages, it
starts at `count` (clamped). The anchor survives `patchToolCallsMiddleware`, because it keeps
original messages with their ids.

- *Alternative: the count alone* (`sessions.messageCount`, as hosts are told to use). It is
  exact unless the list is rewritten. Dropped orphans shift the slice later and can skip the
  turn's first assistant text. Inserted tool messages shift it earlier, which is harmless here.
  Rejected because a cancelled turn makes a rewrite ordinary, not exotic.
- *Alternative: collect text from the turn runner's message stream.* The runner sees every
  chunk it streams, but a nested model call (a rubric, a child workflow, a hook's `task()`)
  streams through the same run, so the parent's text cannot be told apart reliably. Rejected.
  The parent's `messages` channel holds only the parent's messages.

**2. One reader, `turnReply(messages, start)`, in `src/core/message-readers.ts`, beside
`lastAgentText`.**
It walks `messages` from `start`. Each assistant message that is not a runtime note adds its
trimmed, non-empty text. An `after` note clears what was collected. The result is the texts
joined by `\n\n`. It is not exported from the public barrels; the proposal adds no names.

**3. `settle(result, sessionId, anchor)`.**
`anchor` is required, so no caller can silently fall back to whole-session behaviour. `send`
reads it from the checkpoint before a fresh turn, with the same `getTuple` that
`sessions.messageCount` uses. `validate` returns it beside `value` and `parkedAt`, from the
values it already read.

**4. CLI and case engine read the outcome's `reply`.**
`printResumed` (`src/cli/turn.ts`) prints `outcome.reply`, falling back to the "resumed" line.
The case driver's `viewOf` sets `view.reply = outcome.reply`. `judgeEvidenceFromView` drops the
record's last message only when the reply ends with that message's text, because a joined reply
no longer equals one message.

## Risks / Trade-offs

- [A host relied on `reply` repeating the last thing said] → Breaking. Called out in the
  changelog, and fixed on the host side by keeping its own copy or calling
  `lastAgentText(outcome.messages)`.
- [Several texts joined into one string read awkwardly when a state narrates] → The joined text
  is exactly what the transcript says the person was told. A workflow that narrates too much is
  fixed in its prompt.
- [Existing behaviour tests assume a single-text turn] → 13 assertions on `outcome.reply` in
  `src/behaviour/` and `src/sessions/`. Most script one text per turn and should not change.
  Any that do are corrected individually, never by loosening the rule.

## Migration Plan

Hosts that read `reply` and want the old value use `lastAgentText(outcome.messages)`, which is
still exported. Cases need no change. A `grade` whose reply section was the previous turn's text
can now fail or pass differently, which the changelog notes.
