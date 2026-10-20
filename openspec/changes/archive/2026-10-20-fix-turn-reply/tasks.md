## 1. The turn's reply

- [x] 1.1 Add `turnReply(messages, start)` to `src/core/message-readers.ts`. It walks from `start`, adds trimmed non-empty text of assistant messages that are not runtime notes, clears what it collected at an `after` note, and joins with `\n\n`. Add the anchor resolution (index after the message with the anchor id, else the clamped count). Verify with unit tests in `src/core/messages.test.ts`: text plus advance plus text, a silent turn, an `after` reset, a non-`after` note that keeps text, and an anchor id missing from the list that falls back to the count.
- [x] 1.2 Give `settle` a required `anchor` and compute `reply` with `turnReply` (`src/sessions/resume.ts`). Have `validate` return the anchor from the values it reads, and pass it from `resume()`. Verify with `npm run typecheck` and `src/sessions/resume.test.ts`.
- [x] 1.3 In `send` (`src/assembly/index.ts`), read the anchor from the session's checkpoint before a fresh turn and pass it to `settle`. Verify with `npm run typecheck`.

## 2. Behaviour

- [x] 2.1 Add behaviour tests in `src/behaviour/transitions.test.ts` or `parks.test.ts` for the spec scenarios: text next to an advance, then text in `b`, gives "X\n\nY"; a silent second turn gives ""; a handoff joins the pre-park text and the handoff text; a decision to a terminal with no text gives ""; a reply to a parked session gives only its answer. Verify the tests pass and fail with the old `lastAgentText` reply.
- [x] 2.2 Add a behaviour test in `src/behaviour/hooks.test.ts` where a terminal `after` hook corrects once, so `reply` is the revised answer only. Verify the test passes.
- [x] 2.3 Run the existing assertions on `outcome.reply` (`src/behaviour/*.test.ts`, `src/sessions/resume.test.ts`). Correct any whose scripted turn has several texts, noting each, and never loosen the rule. Verify `npm test` passes.

## 3. CLI and case engine

- [x] 3.1 `printResumed` (`src/cli/turn.ts`) prints `outcome.reply`, else the "Session … resumed" line. Verify with the CLI tests (`src/cli/*.test.ts`) and a test for a decide that ends without text.
- [x] 3.2 In `viewOf` (`src/testing/driver.ts`), set `view.reply` from `outcome.reply`. In `judgeEvidenceFromView` (`src/testing/grade.ts`), drop the record's last message only when the reply ends with its text. Verify with `src/testing/grade.test.ts` and `src/testing/driver.test.ts`, including the two testing-spec scenarios (the grader reads this action's reply; a silent action is graded as silent).
- [x] 3.3 Run `npm test` and `npm run typecheck`. Both pass.

## 4. Docs and skill

- [x] 4.1 Update `docs/src/content/docs/reference/public-api.md`: `outcome.reply` is what the agent said this turn, with the `after` reset and the empty silent turn, and `lastAgentText(outcome.messages)` gives the old value. Also the `JudgeEvidence` paragraph. Verify with `npm run docs:build`.
- [x] 4.2 Update "What the grader sees" in `docs/src/content/docs/guides/testing.md`: the reply is the action's reply, and the record covers the session so far, not only the turn. Verify with `npm run docs:build`.
- [x] 4.3 Add a changelog entry marked **Breaking** to `docs/src/content/docs/reference/changelog.md`, with the migration line. Verify with `npm run docs:build`.
- [x] 4.4 Correct `skills/archmax-harness/references/cases.md` and `references/hook-and-test-scripts.md`: the `reply` assertion matches the session's whole assistant transcript so far, and the grader's reply is the action's reply. Verify by reading the diff.
- [x] 4.5 Confirm README.md needs no change (`grep -n "reply" README.md`). Run `npx openspec validate fix-turn-reply --strict`. It passes.
