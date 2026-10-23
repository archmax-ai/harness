## 1. The payload

- [x] 1.1 Make `runContextFromMessages` (`src/core/messages.ts`) take the last user message as `userRequest`, and update its doc comment. Update the unit tests in `src/core/messages.test.ts`: the test reading "the first user message, not the latest one" becomes the latest one, and the issue #61 case still finds a request that sits before the visit. Verify with `npx vitest run src/core/messages.test.ts`.
- [x] 1.2 Add a behaviour test in `src/behaviour/hook-visit.test.ts`: turn 1 and turn 2 ask different questions, turn 2 advances into a state with an `after` rubric, and the grader's prompt contains turn 2's question and not turn 1's. Verify it fails before 1.1 and passes after.
- [x] 1.3 Run `npm run typecheck`, `npm test` and `npm run lint`. Verify all pass.

## 2. Docs and skill

- [x] 2.1 Update what `userRequest` holds in `docs/src/content/docs/guides/grading-rubrics.md`, `skills/archmax-harness/references/hook-and-test-scripts.md` and `references/backend-integration.md`, and add a 0.9.0 changelog entry. Run `npm run docs:build` and `npx openspec validate rubric-current-request --strict`, and verify both pass.
