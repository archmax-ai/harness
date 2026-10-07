## 1. Optional backend methods stay optional (C7)

- [x] 1.1 Add `src/core/raw-download.ts` (`downloadViaReadRaw`: exact bytes or an error code). `mountSubtree` always has `downloadFiles` (falling back to it), `uploadFiles` only when the wrapped store has it or the mount is read-only, `delete` as before. Verify with `npx vitest run src/core/path-mapping.test.ts`.
- [x] 1.2 `SessionZoneRouter` has `uploadFiles` exactly when its store does; `createWorkspaceRouter` takes `defaultRoute`, downloads through `readRaw` where a route has no raw channel, has `uploadFiles` exactly when the session zone does and refuses a route without it per file. Verify with `npx vitest run src/core/workspace-router.test.ts` ("over stores without the optional methods").
- [x] 1.3 Hand Deep Agents `withoutDeletion(ctx.backend)` in the governed and plain compositions. Verify with `npx vitest run src/behaviour/bare-stores.test.ts`: skills found, a text copy and a refused removal over bare stores; no `delete` tool in either agent.

## 2. The scratchpad opens only essential tools (C6)

- [x] 2.1 `WorkflowMachine.isEssential`; `runOpenAccessRule` abstains for any other tool. Verify with `npx vitest run src/kernel/kernel.paths.test.ts` ("a host tool a state must grant").

## 3. Lists of paths (C8)

- [x] 3.1 `declaredPathsOf` and `pathValuesOf` flatten lists; `malformedPathArgs` and the first safety rule `tool.path-argument`. Verify with `npx vitest run src/kernel/kernel.paths.test.ts` ("an argument holding a list of paths").

## 4. The binary type table (C9)

- [x] 4.1 Move `BINARY_MIME_TYPES`/`binaryMimeTypeOf` to `src/core/binary-types.ts` (no `node:*`), export from `src/public/spec.ts`, document on the public API page. Verify with `npx vitest run src/core/binary-types.test.ts src/public`.

## 5. Smaller items (C10)

- [x] 5.1 The out-of-turn `ToolContext`'s `workspace` is non-enumerable. Verify with `npx vitest run src/workflow/agent-tools.test.ts`.
- [x] 5.2 Changelog: "0.4.0" without "(unreleased)", and a 0.4.1 section.

## 6. Docs, skill, specs

- [x] 6.1 `reference/public-api.md`, `reference/machine-spec.md`, `guides/workflow-machine.md`, the skill's `backend-integration.md` and `workflow-schema.md`.
- [x] 6.2 `npm run typecheck`, `npm test`, `npm run build`, `npm run docs:build`, `npx openspec validate --specs`.
