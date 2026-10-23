## 1. Eviction in the checkpointer

- [x] 1.1 Add a synchronous `evict(sessionId)` to `BackendCheckpointSaver` (`src/workflow/checkpointer.ts`). It drops `storage`, `writes` and `loading` entries for the id and for every `isChildSessionOf` id. Verify with a test in `src/workflow/checkpointer.test.ts`: after `evict`, the saver holds no `storage` or `writes` entry for the id or `<id>~1`, and still holds `<id>-2`.
- [x] 1.2 Test that an evicted session replays from the store: `put` checkpoints, `evict`, then `getTuple` returns the same latest checkpoint. Verify the test passes.
- [x] 1.3 Test that `evict` on an unknown id is a no-op and that calling it twice is safe. Verify the test passes.

## 2. Wire it into `dispose` and `sessions.delete`

- [x] 2.1 In `members()` (`src/assembly/index.ts`), make the `dispose` handed to `AgentMembers` run the composition's `dispose` and then `checkpointer.evict(id)` when the checkpointer is a `BackendCheckpointSaver`. This covers the governed and the plain agent. Verify with `npm run typecheck`.
- [x] 2.2 Reorder `sessions.delete` (`src/sessions/operations.ts`) to: `dispose` → `checkpointer.deleteThread` → `sessionStore.deleteSession`. Update the comment to say why. Verify that the existing "Deleted session is not resurrected" test in `src/workflow/checkpointer.test.ts` / `src/behaviour/sessions.test.ts` still passes.

## 3. Behaviour tests

- [x] 3.1 In `src/behaviour/sessions.test.ts`, run a turn, call `agent.dispose(id)`, then `send` a second turn on the same id. Assert that the second turn continues the transcript, variables and trail. Verify the test passes.
- [x] 3.2 In `src/behaviour/child-sessions.test.ts`, dispose a parent that dispatched a sub-workflow. Assert that the checkpointer holds neither the parent nor `<id>~1`, and that resuming the parent still works. Verify the test passes.
- [x] 3.3 In `src/behaviour/plain.test.ts`, assert that disposing a plain agent's session evicts it and that its next turn continues. Verify the test passes.
- [x] 3.4 Assert that an agent assembled with a host `MemorySaver` still holds the session after `dispose`. Verify the test passes.
- [x] 3.5 Run `npm test` and `npm run typecheck`. Both pass.

## 4. Docs and skill

- [x] 4.1 Update `docs/src/content/docs/reference/public-api.md` (the `dispose` line near `:277` and the "Cancelling a turn" paragraph). Say that `dispose` also frees the session's and its child sessions' checkpoints from memory, that the next use replays them from the session store, and that a host with its own `checkpointer` frees memory through `sessions.delete` or that checkpointer. Verify with `npm run docs:build`.
- [x] 4.2 Add a changelog entry to `docs/src/content/docs/reference/changelog.md` describing the fix and linking to the public-api section. Verify with `npm run docs:build`.
- [x] 4.3 Update `skills/archmax-harness/references/backend-integration.md`, where the `dispose` comment says "cleans up sandbox/PTC state". It also frees the session's checkpoints from memory. Verify by reading the diff.
- [x] 4.4 Confirm README.md needs no change: `grep -n dispose README.md` finds no description to update.
- [x] 4.5 Run `npx openspec validate fix-dispose-eviction --strict`. It passes.
