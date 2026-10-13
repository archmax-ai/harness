## 1. Platform prompt

- [x] 1.1 In `src/core/platform-prompt.md`, extend "A conversation keeps its position" with the negative case (a state that can serve the message is answered in place; a new message is no reason to reset) and the entry-state rule (never reset while still in the state the conversation began in), per design decision 2. Verify by reading the paragraph against the table in design decision 1.
- [x] 1.2 Narrow the terminal paragraph's heading to a terminal state you moved into, and add the terminal state the conversation began in as a third case that takes no reset, beside the `archmax_wait` resume and the state routed into this turn. Verify that "Never reset out of a state you just arrived in" and the `archmax_wait` warning are still there.
- [x] 1.3 In "Naming the run", replace "Update it when …" with the stay-unless-the-subject-changes rule, judged against the whole conversation rather than its latest message, and say that a rename names what the whole conversation is about. Keep "the old title no longer describes" and keep the paragraph inside its `top-level-only` markers. Verify with `npx vitest run src/core/prompt.test.ts -t "title"`.
- [x] 1.4 Run `npm run generate:prompt` and verify `npx vitest run src/core/prompt.test.ts -t "ships exactly"` passes.

## 2. Tool descriptions

- [x] 2.1 In `src/workflow/control-tools.ts`, narrow `archmax_reset`'s terminal case to "a terminal state the run moved into and finished in" and add the one clause: not needed when this state can serve the message, never from the state the conversation began in. Verify with `npx vitest run src/workflow/control-tools.test.ts`.
- [x] 2.2 Rewrite `TITLE_GUIDANCE` to rename only when the whole conversation has moved to a different subject (a follow-up on the same one keeps it), keeping "set it early" and "never lock it". Verify that the `title` regex in `control-tools.test.ts` still matches and that a child's description still leaves the sentence out.

## 3. Tests

- [x] 3.1 In `src/core/prompt.test.ts`, pin the new prompt text in the existing style: the stay-and-answer case and the never-reset-from-the-entry-state rule in "keeps its position"; the terminal entry state among the cases that take no reset; the whole-conversation judgement and the follow-up-keeps-the-title case in "Naming the run". Check that each new assertion fails against the old prompt text (temporarily revert, or reason from the old text) and passes now.
- [x] 3.2 In `src/workflow/control-tools.test.ts`, pin the reset description's new clause and the title guidance's whole-conversation bar. Verify with `npx vitest run src/workflow/control-tools.test.ts`.
- [x] 3.3 Verify that a child session still reads no title guidance with `npx vitest run src/core/prompt.test.ts -t "leaves the naming step"` and the delegation suite (`npx vitest run src/behaviour -t "child"`).

## 4. Docs and skill

- [x] 4.1 `docs/src/content/docs/guides/sessions.md`: in the reset paragraph, say that a follow-up the current state can serve is answered in place, and that a terminal state the conversation began in answers its follow-ups without a reset. Verify that the paragraph matches the design's table.
- [x] 4.2 `docs/src/content/docs/guides/workflow-machine.md`: in the `title` paragraph, describe the rename bar as a change in the subject of the whole conversation, judged against the whole conversation and not its latest message.
- [x] 4.3 `docs/src/content/docs/reference/changelog.md`: add a `0.4.3` section covering both prompt changes and the two description changes, linking to the sessions and workflow-machine guides.
- [x] 4.4 `skills/archmax-harness/references/workflow-schema.md`: bring the `title` paragraph's "update it when the task changes significantly" into line with the new bar. Grep the skill for other restatements of the reset rule and align any you find.
- [x] 4.5 Confirm that `README.md` needs no change: it mentions `archmax_reset` only as a `forbid_always` example, and grep shows no restatement of either rule.

## 5. Verification

- [x] 5.1 Run `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`, `npm run docs:build`, `npx openspec validate platform-prompt-reset-and-title` and `npx openspec validate --specs`. All pass.
