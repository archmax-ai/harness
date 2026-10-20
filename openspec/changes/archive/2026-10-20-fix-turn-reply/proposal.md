## Why

An outcome's `reply` is the last assistant text in the session's whole history, not in the turn
that just ran. The platform prompt tells the agent to write person-facing text in the same message
as `archmax_advance`, `archmax_wait` or `archmax_raise`. When the agent then writes more in the
next state, `reply` keeps only that later text. While benchmarking, a proposal written before an
advance was lost: the person saw only "I'll wait for your confirmation", asked what they were
confirming, and the conversation ran out of steps. A turn that says nothing gets the previous
turn's text as its `reply`, so a host repeats it. Every host has to slice `messages` itself to
recover the turn's reply. A case's `grade` has the same defect: the spec gives the grader "the
turn's final reply", but it receives the session's last text.

## What Changes

- **BREAKING** `reply` on `Outcome`, `DecideOutcome` and `ReplyOutcome` is what the agent said
  during this turn: every assistant text the turn added, in order, joined by a blank line. A
  turn that says nothing has `reply: ""`, not the previous turn's text. Hosts that relied on
  `reply` repeating the last thing said must keep their own copy.
- When a terminal state's `after` hook asks for a revision (`correct`), the text before that
  revision request is dropped from `reply`, so the person gets the corrected answer and not the
  rejected draft. No other runtime note takes text back.
- The same rule covers every disposition: a turn, a decision, a reply to a parked session, and a
  delivery.
- `archmax decide` and `archmax deliver` print the outcome's `reply` on stdout, where they printed
  the session's last text. A decision that ends the session without the agent speaking prints
  the "resumed" line instead of repeating the handoff message.
- A case's `grade` is given this action's `reply` as "the final reply to the user". The grader's
  record of messages and tool calls still covers the session so far.
- Unchanged: `lastAgentText` (public, still the last text of any message list), a sub-workflow's
  closing message to its caller, `SessionView.reply` outside the case engine, and the `reply`
  assertion, which still matches every assistant message of the session so far.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `assembly`: a new requirement defines an outcome's `reply` as what the agent said this turn,
  including the reset at an `after` revision request. In "`send` is the one entry into a session",
  the raise scenario's `reply` is "what the agent said this turn" instead of "whatever the agent
  last said".
- `testing`: "The grader and its evidence" gives the grader this action's `reply`, and says the
  record covers the session so far.

## Impact

- **Code**: `src/sessions/resume.ts` (`settle` takes the turn's starting point; `resume` reads it
  before invoking), `src/assembly/index.ts` (`send` reads it before a fresh turn),
  `src/core/message-readers.ts` (one reader for the turn's reply), `src/cli/turn.ts`
  (`printResumed`), `src/testing/driver.ts` (the view carries the outcome's `reply`),
  `src/testing/grade.ts` (the record drops only the reply's closing message, now that `reply` may
  join several). Tests: `src/core/messages.test.ts`, `src/sessions/resume.test.ts`, behaviour
  tests in `src/behaviour/` (a text-plus-advance turn, a silent turn, an `after` correction), and
  `src/testing/grade.test.ts`.
- **Public API**: no new names. What `Outcome.reply`, `DecideOutcome.reply` and
  `ReplyOutcome.reply` hold changes. It is breaking for a host that relied on the old value.
- **docs/**: `reference/public-api.md` (what `outcome.reply` holds, and `JudgeEvidence`),
  `guides/testing.md` ("What the grader sees": the reply is the action's reply, and the record
  covers the session so far, not only the turn as the page says today), and a changelog entry
  marked breaking in `reference/changelog.md`.
- **README.md**: no change. It does not describe `reply`.
- **skills/archmax-harness/**: `references/cases.md` and `references/hook-and-test-scripts.md`
  say the `reply` assertion matches "the turn's whole assistant transcript". It matches the
  session's whole transcript so far, so the wording must be corrected, together with the
  grader's reply wording where those pages describe `grade`.
- **Release**: `release:minor` (a behaviour change for hosts, before 1.0).
