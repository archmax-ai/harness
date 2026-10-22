## Why

A rubric's grader judges a reply against `userRequest`, which is the **first** user message of the
whole session. In a conversation that is the wrong question: in turn 2 the person asks "Can I get a
refund for ORD-4?", but the grader still reads turn 1's "Which of my orders are delayed?". A rubric
that checks whether the reply answers the request then returns `correct` (the agent loops) or `veto`
(a correct move is blocked).

Since `scope-hooks-to-visit`, `history` holds only the graded state's visit. When the person's
latest message arrived in an earlier state and the session then advanced, the current question
is in neither field, so the grader has no way to find it.

## What Changes

- **`userRequest` is the person's latest message**: the last user message in the session, which
  is what the reply answers. A turn that opened with a message, a reply and a delivery that
  carried one all move it forward. A decision or a delivery without a message leaves it at the
  person's last words.
- `history` is unchanged (the visit), and so is the rest of the payload. Script hooks are
  unaffected: they receive no `userRequest`.
- **Behaviour change** for rubrics in multi-turn sessions only. In a one-turn session the first and
  the latest user message are the same.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `grading-rubrics`: "A rubric is shown the visit" shows the person's latest message as
  `userRequest`.

## Impact

- **Code**: `runContextFromMessages` in `src/core/messages.ts` (`find` → the last user message),
  and its tests.
- **docs/**: `guides/grading-rubrics.md` (what `userRequest` holds), and a 0.9.0 changelog entry.
- **skills/archmax-harness/**: `references/hook-and-test-scripts.md` and
  `references/backend-integration.md`, where they say what `userRequest` is.
- **README.md**: no change.
