## Why

Two pieces of the platform prompt make the model spend calls it does not need. It calls
`archmax_reset` on follow-ups that the state it is in can serve. The worst case is a workflow
whose entry state is terminal, such as a one-state chat: there the prompt says "a terminal state
never serves a follow-up", so every new message starts with a reset back to the state the session
is already in. The volatile block already leaves that case out; the static prompt does not. The
model also renames the session too readily. "Update it when the task turns into something the old
title no longer describes" is read against the latest message, so a follow-up or a side question
replaces a title that still describes the conversation as a whole.

## What Changes

- **Staying needs no reset.** The platform prompt's "A conversation keeps its position" paragraph
  says the other half: when the state the session is in can serve the new message, the model
  answers there, and a reset is not a ritual for a new turn. A reset only ever returns to the
  state the conversation began in, so it never helps while the session is still there.
- **A terminal entry state serves its follow-ups.** The terminal-state paragraph gets a third
  exception beside the `archmax_wait` park and the state routed into this turn: a terminal state
  that is the one the conversation began in. That matches the volatile block, which already stays
  silent there.
- **`archmax_reset`'s description** gains one clause saying a state that can serve the message
  needs no reset.
- **The title changes only on a real change of topic.** The "Naming the run" paragraph asks for a
  rename only when the conversation as a whole has moved to a subject the title no longer
  describes. The model judges that against the whole conversation, not the latest message: a
  follow-up, a detail, a correction or a side question on the same subject keeps the title. A
  rename describes the whole conversation. The `title` sentence in `archmax_set_variables`'
  description is held to the same bar.
- Nothing changes in the runtime's behaviour: `archmax_reset` and `archmax_set_variables` accept
  and refuse exactly what they did. The changes are prompt and description text only. A
  sub-workflow's child still reads no title guidance.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `runtime`: "`archmax_reset` returns the session to its entry state" says what the platform prompt
  and the tool description tell the model about when to reset and when not to.
- `workflow-spec`: "Variable names and the two reserved variables" says when the platform prompt
  asks the model to rename the session.

## Impact

`src/core/platform-prompt.md` and its generated `platform-prompt.generated.ts`;
`src/workflow/control-tools.ts` (`archmax_reset` description, `TITLE_GUIDANCE`); tests in
`src/core/prompt.test.ts` and `src/workflow/control-tools.test.ts`. Docs: `guides/sessions.md`
(the reset paragraph), `guides/workflow-machine.md` (the `title` paragraph), and a `0.4.3` section
in `reference/changelog.md`. The authoring skill: `references/workflow-schema.md`, where the
`title` paragraph restates the update rule. README.md mentions `archmax_reset` only as a
`forbid_always` example and needs no change. No public API, schema or CLI change.
