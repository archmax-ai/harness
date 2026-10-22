## Context

`runContextFromMessages(messages, visitStart)` (`src/core/messages.ts`) builds the rubric payload.
`history` is `messages.slice(visitStart)`. `userRequest` is the text of the first message whose role
reads as `user`. Runtime notes are tool-call pairs, so a note is never a user message. A delivery's
message and a reply to a parked session are user messages, while a decision is a note.

## Decisions

- **The last user message, not the turn's opening message.** `findLast` with the same filter.
  - It needs no turn boundary. A decision resumes the turn the person's last message started, so
    its rubric is judged against that message, which is right.
  - A reply to a parked session is the person's latest words, and a later rubric in the same
    conversation should judge against them.
  - Rejected: the opening message of the current invoke. A decision's invoke has none, so it would
    need a fallback to the same message anyway.
- **No second field.** The session's first message is not kept as `openingRequest`. Nothing needs
  it yet, and a grader that needs more context reads `history`.

## Risks / Trade-offs

- **[A rubric written against the first request]** A grader whose instructions assume the session's
  first message changes meaning in a multi-turn session. → That assumption is exactly the bug; the
  changelog states the change.
