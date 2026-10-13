## Context

The static platform prompt (`src/core/platform-prompt.md`, compiled into
`platform-prompt.generated.ts`) does not know the session's entry state. The volatile "Current
state" block does: `governance.ts` gives its terminal-state reset instruction only when the
position is terminal, is not the entry state, and the turn arrived there in place. The static
text has no such carve-out. It says "A terminal state never serves a follow-up", so the two
layers disagree exactly where a reset is useless. The `title` guidance lives in the "Naming the
run" paragraph, between `<!-- top-level-only -->` markers, and in `TITLE_GUIDANCE`, which a
child's `archmax_set_variables` description leaves out. Both are pinned by tests: `prompt.test.ts`
("the old title no longer describes", "Naming the run") and `control-tools.test.ts`
(`/`title` is reserved .* set it early/`).

## Goals / Non-Goals

**Goals:**

- The static prompt, the volatile block and the `archmax_reset` description give the same answer
  in every case below.
- The title is set once and changed only when the subject of the whole conversation changes.

**Non-Goals:**

- No runtime change. `archmax_reset` stays callable from the entry state, and `title` writes are
  accepted as before. Prompt text cannot be enforced, and the runtime has no way to judge whether
  a change of topic is real.
- The volatile block's text and its condition stay as they are.

## Decisions

**1. One rule for every position.** The prompt has to give the same answer as the volatile block
in each of these cases:

| Where the new message lands                                  | What the model does                      |
| ------------------------------------------------------------ | ---------------------------------------- |
| A non-terminal state that can serve it                       | Stay and answer; no reset                |
| Any state that cannot serve it (no edge reaches it, wrong path) | `archmax_reset` before answering         |
| A terminal state the session moved into and finished in      | `archmax_reset` before answering         |
| A terminal state that is the one the conversation began in    | Stay and answer; a reset leads back here |
| Any state while it is still the one the conversation began in | Never reset                              |
| A terminal state routed into this turn, or an `archmax_wait` resume | Do its work; no reset              |

The static prompt states the rule in terms the model can check from its own transcript (has
anything moved the session since the conversation began?), because the static prompt cannot name
the entry state.

**2. Edit the paragraphs in place, keeping their order and pinned phrases.** The "A conversation
keeps its position" paragraph gets the negative case and the entry-state rule. The terminal
paragraph's heading narrows to "A terminal state you moved into", and the entry state becomes a
third exception beside the two it already lists. In "Naming the run", the sentence "Update it
when …" becomes a stay-unless-the-subject-changes rule judged against the whole conversation. The
phrases "the old title no longer describes" and "Naming the run" stay. The markers stay where they
are, so a child still reads nothing about a title.

Target wording, which the apply step may tighten but not weaken:

> **A conversation keeps its position.** A new message finds you in the state your last turn
> ended in. When that state can serve it, stay and answer there: a new message is not a reason
> to reset. If it cannot — no transition reaches what was asked, or an earlier turn took a wrong
> path — call `archmax_reset(…)` to return to the state the conversation began in. … A reset only
> ever goes back there, so never call it while you are still in that state.

> **A terminal state you moved into never serves a follow-up.** … Three cases take no reset: a run
> you parked with `archmax_wait` …; a terminal state you were routed into *this turn* …; and a
> terminal state the conversation began in, where a reset would leave you exactly where you are.
> Answer there.

> … After that, leave it alone unless the conversation **as a whole** has moved to a subject the
> old title no longer describes. Judge that against the whole conversation, not its latest
> message: a follow-up, a detail, a correction or a side question on the same subject keeps the
> title. When you do rename, name what the whole conversation is about. …

**3. Mirror each rule in its tool description, in one clause.** Descriptions are paid for on every
model call, so each gets one clause. `archmax_reset`: the terminal case becomes "a terminal state
the run moved into and finished in", plus "Not needed when this state can serve the message, and
never from the state the conversation began in." `TITLE_GUIDANCE`: "set it early, rename it only
when the whole conversation has moved to a different subject (a follow-up on the same one keeps
it), and never lock it." The test regex `/`title` is reserved .* set it early/` keeps matching.

*Alternative considered:* make the volatile block say "this is the state the conversation began
in; a reset would not move you" whenever the position is the entry state. That would tell the
model exactly where it is instead of leaving it to infer this from its transcript. It was not
taken: it adds a line to every model call in the entry state, and the user asked for the platform
prompt. If the static rule turns out not to be enough, this is the next step.

*Alternative considered:* refuse `archmax_reset` from the entry state. That was rejected because
a reset there still clears the per-state counters and runs the entry state's `before` hook again,
and that is runtime behaviour, which this change does not touch.

## Risks / Trade-offs

- [The model cannot always tell whether it is still in the entry state] → The rule is phrased in
  terms of the transcript: no advance, decision or reset has moved the session. The volatile
  block's existing condition stays the authority for the terminal case.
- [A stricter rename bar keeps a title that a reviewer would have changed] → A title is a listing
  label. A slightly stale one costs less than one that flips with every follow-up, and the bar
  still allows a rename when the subject really changes.
- [The static prompt grows by a few sentences, in every governed session's cacheable prefix] → The
  growth is small and cached, and the rename text is left out of a child's prompt by the existing
  markers.

## Migration Plan

None. The change is prompt text only, and a workspace that overrides the platform prompt with
`.platform/system/GRAPH_STATE.md` keeps its own text. It ships in the next patch release (0.4.3)
with a changelog entry.
