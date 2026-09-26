## 1. Runtime

- [x] 1.1 In `wrapToolCall` (`src/workflow/governance.ts`), make the handler's catch settle `tool-result` with `error` and return an error-status `ToolMessage` (content = the error's message, `tool_call_id`, `name`). Rethrow only when `isGraphBubbleUp(err)` or `request.runtime?.signal?.aborted`. Verify with `npx vitest run src/workflow/middleware.test.ts`.
- [x] 1.2 In `src/workflow/middleware.test.ts`, replace "reports an error result and rethrows when the tool throws" with an "answers" test: the returned message is error-status with the thrown text, and exactly one `tool-result` has `status: "error"`. Add tests that a `GraphInterrupt` and a throw after an aborted signal both still propagate, and that each still settles once. Verify that file passes.
- [x] 1.3 Add a behaviour test under `src/behaviour/`: a scripted model issues two tool calls in one step, and one tool throws. The turn completes, the next model call sees one result and one error-status answer by call id, and no `state-error-routed` is emitted even with `on_error` declared. Verify with `npm test`.

## 2. Docs and authoring skill

- [x] 2.1 `docs/src/content/docs/reference/machine-spec.md` (`on_error`): state that a tool failure is answered to the model and is not a turn failure. Verify with `npm run docs:build`.
- [x] 2.2 `docs/src/content/docs/guides/workflow-machine.md`: in the governed-tool-call description, say that a failing tool is answered with an error-status message. Verify with `npm run docs:build`.
- [x] 2.3 `docs/src/content/docs/reference/public-api.md`: extend the `tool-result` row. A throwing tool settles `error`, and the model reads the failure as the call's answer. Verify with `npm run docs:build`.
- [x] 2.4 `docs/src/content/docs/reference/changelog.md`: add an entry to the next release section describing the behaviour change for hosts. Verify it renders in `npm run docs:build`.
- [x] 2.5 `skills/archmax-harness/references/workflow-yaml.md` (`on_error`) and `references/backend-integration.md`: a failing tool is answered, not routed, and a host sees a `tool-result` with `error` while the turn continues. Verify with a grep: no remaining text says that a tool failure ends a turn.
- [x] 2.6 Confirm README.md needs no change (it does not mention tool failures or `on_error`). Verify with a grep for `on_error` and for "tool" near "fail".

## 3. Verify and release

- [x] 3.1 Run `npm run typecheck`, `npm test` and `npx openspec validate tool-failures-reach-the-model --strict`. All pass.
- [ ] 3.2 Open a PR with the `release` label (patch). Merging it tags and publishes to npm.
- [ ] 3.3 Consumer follow-up in the archmax platform (`../pangea`): upgrade the exact `@archmax-ai/harness` pin in `packages/contracts`, `packages/core` and `apps/worker` together. Verify that `workflows/sdk-compat.test.ts` and `harness/assembly.mounts.test.ts` pass.
