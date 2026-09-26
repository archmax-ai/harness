## 1. Runtime

- [x] 1.1 Remove the `warn(unsupportedCacheMessage(model))` call from the `strategyOf` memo in `src/assembly/compose.ts`, keeping the mismatched-native-strategy warning; update `src/assembly/assembly.test.ts` so the mixed-model case asserts no prompt-cache warning names `some-other-model` and exactly one names the mismatched state; verify `npm test -- src/assembly/assembly.test.ts` passes
- [x] 1.2 Delete `unsupportedCacheMessage` from `src/workflow/prompt-cache.ts` and its test from `src/workflow/prompt-cache.test.ts`, and drop the import in `compose.ts`; verify `npm run typecheck` and `npm run lint` pass
- [x] 1.3 Add an assembly test for a `ChatOpenAI` model serving `gpt-5` with caching enabled: no system block carries `cache_control`, no `warning` mentions prompt caching, and the `prompt-shaping` event's `cache` is `unsupported`; verify `npm test` passes

## 2. Documentation

- [x] 2.1 In `docs/src/content/docs/guides/token-efficiency.md`, replace "An unrecognized model never fails a session. A `warning` event reports that caching is inactive." with the current rule: an unrecognized model never fails a session, gets no markers and no warning, the `prompt-shaping` event names its strategy, and rising `cacheReadTokens` on usage events confirms the provider's automatic caching; verify `npm run build` in `docs/` succeeds
- [x] 2.2 Add an entry to the unreleased section of `docs/src/content/docs/reference/changelog.md`: assembly no longer warns about a model it places no cache marker for, the `prompt-shaping` event still names the strategy, linking to the token-efficiency guide; verify the docs build still succeeds
- [x] 2.3 Confirm README.md and `skills/archmax-harness/` need no update by grepping both for the warning text and for "inactive"; verify the grep finds nothing to change

## 3. Validation and release

- [x] 3.1 Run `openspec validate drop-unsupported-cache-warning` and the full `npm test`; verify both pass
- [ ] 3.2 Open the PR from a branch cut from `origin/main`, labelled `release` for a patch release; verify the release workflow tags and publishes the new version
