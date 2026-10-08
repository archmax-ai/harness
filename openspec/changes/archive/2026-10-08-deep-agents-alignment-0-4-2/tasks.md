## 1. `grep`'s cap reaches the store (F1)

- [x] 1.1 `mountSubtree`, `SessionZoneRouter` and the workspace router take and forward `maxCount`; the router applies `applyGrepMaxCount` to a search delegated to an unsearchable mount. Verify with `npx vitest run src/behaviour/grep-cap.test.ts` (fails without the change) and `npx vitest run src/core`.

## 2. The prompt pruning is deleted (F2)

- [x] 2.1 Delete `src/workflow/prompt-pruning.ts` and `prompt-sections.test.ts`, the re-export in `middleware.ts`, the memoized `shapeStaticPrompt` in `governance.ts`, and `withheldBuiltins` (`PromptShaping`, `compose.ts`); keep `prompt-shaping`'s `withheld`. Verify that the old code changed no prompt across the suite but its own synthetic test (a probe recording every prompt it changed), and with `npx vitest run src/assembly/assembly.test.ts -t "withheld task"` (fails without the change).

## 3. Deep Agents floor and stale texts (F3)

- [x] 3.1 `deepagents` `^1.13.4` in `package.json`, lockfile refreshed with `npm install`.
- [x] 3.2 The todo-middleware comment (`compose.ts`), prompt layer 7 (`AGENTS.md`, `core/prompt.ts`, the token-efficiency guide, the runtime and assembly specs), and the `DEFAULT_SUB_WORKFLOW_*` docstrings (`machine/delegation.ts`, `index.ts`).

## 4. `generalPurposeAgent: false` is dropped (F4)

- [x] 4.1 `rubricParams` returns `subagents` only, and its comment says what holds. Document the plain agent's `task` on the public API page and pin it in `src/behaviour/plain.test.ts`.

## 5. The profile suffix is pinned (F5)

- [x] 5.1 `src/behaviour/upstream-additions.test.ts`: `it.fails` for the Codex suffix (through `initChatModel`) and for the relocated `write_todos` guidance; an ordinary test that a `ChatOpenAI` instance gets no suffix. Check that both expected failures fail on their target assertions.

## 6. Deep Agents' own caching is pinned (F6)

- [x] 6.1 `src/behaviour/upstream-additions.test.ts`: what a `ChatAnthropic` and a `ChatBedrockConverse` model receive, with caching on and off. Record the finding in `design.md` for the 0.5.0 decision.
- [x] 6.2 Correct the docs that said turning caching off removes every marker: the token-efficiency guide, `reference/configuration.md`, `reference/public-api.md`, the skill's `backend-integration.md`.

## 7. Docs, skill, specs, release

- [x] 7.1 Changelog `0.4.2`; `reference/public-api.md` (the store's `maxCount`, the searchable mount, `promptCache`, the plain agent); the skill's `backend-integration.md`.
- [x] 7.2 `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`, `npm run docs:build`, `npx openspec validate --specs`.
