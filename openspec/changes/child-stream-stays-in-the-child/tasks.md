## 1. Runtime

- [x] 1.1 In `src/workflow/sub-workflow.ts`, add `callbacksForChild()`: read the ambient callbacks (`AsyncLocalStorageProviderSingleton.getRunnableConfig()`), copy a `CallbackManager` or filter an array, and remove every handler named `StreamMessagesHandler`, `StreamProtocolMessagesHandler` or `StreamToolsHandler`. Return `undefined` when nothing is inherited. Verify with the behaviour tests in 2.2.
- [x] 1.2 In `childConfig`, set `callbacks` from `callbacksForChild()`, so dispatch and resume both invoke a child without its caller's stream handlers. Move the orphaned doc comment above `caller` onto `childConfig`. Verify that the probe that reproduced the report (two children in one batch) shows each child's text once, tagged, and the caller's text alone untagged.

## 2. Tests

- [x] 2.1 In `src/behaviour/support.ts`, add `StreamingScriptedModel`, which streams a reply word by word (`handleLLMNewToken`) and a tool-call turn as one chunk, and `STREAM_FAILURE`, a reply word on which it throws after streaming the words before it.
- [x] 2.2 In `src/behaviour/delegation.test.ts`, add "a child's streamed text": two concurrent children with a streaming and with a non-streaming model (the caller's deltas are its own text, state and `messageId`; each child's text streams once under its own dispatch and session); a host's callback handler observes all four model calls; a caller turn that fails after a child streamed finalizes only `checking the totals ` as partial. Verify that the three leak tests fail without 1.2 and pass with it.

## 3. Docs and authoring skill

- [x] 3.1 `docs/src/content/docs/reference/public-api.md`, the `agent-text-delta` row: a child's chunks carry the child's `sessionId` and `subWorkflowDispatchId` and never reach the caller as its text.
- [x] 3.2 `docs/src/content/docs/guides/sub-workflows.md`, "Observability": everything a child emits, its streamed text included, is the child's.
- [x] 3.3 `docs/src/content/docs/reference/changelog.md`: a `0.3.1 (unreleased)` section with the fix and the note for hosts.
- [x] 3.4 `skills/archmax-harness/references/backend-integration.md`, the `agent-text-delta` row.
- [x] 3.5 Confirm that README.md needs no change. Verify with a grep for `agent-text-delta`.

## 4. Verify and release

- [x] 4.1 Run `npm run typecheck`, `npm test`, `npm run docs:build` and `npx openspec validate child-stream-stays-in-the-child --strict`. All pass.
- [ ] 4.2 Run a delegating case against a live streaming model and confirm that a child's deltas arrive tagged with its dispatch and none arrive as the caller's.
- [ ] 4.3 Open a PR with the `release` label (patch). Merging it tags and publishes to npm.
- [ ] 4.4 Consumer follow-up in the archmax platform (`../pangea`): upgrade the exact `@archmax-ai/harness` pin in `packages/contracts`, `packages/core` and `apps/worker` together; delete the workaround in `packages/core/src/streaming/agui-events.ts` (`openDispatches` and the early return under `agent-text-delta`); rewrite its test "drops the untagged deltas a running dispatch leaks into the turn's own stream" to assert the stream carries no child text as the caller's. Verify that `workflows/sdk-compat.test.ts` and `harness/assembly.mounts.test.ts` pass.
