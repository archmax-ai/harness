## 1. Runtime

- [x] 1.1 Add `sessionId` to `ToolContext` in `src/core/tool-context.ts`, documented as the session the call is made in (the child's own id inside a dispatch) and as the key of `<sessionId>/` in the session store.
- [x] 1.2 Bind it in `sessionBinder` (`src/assembly/compose.ts`): `runWithToolContext({ workspace: ctx.backend, sessionId }, fn)`.
- [x] 1.3 Make the out-of-turn context in `src/workflow/agent-tools.ts` throw for `sessionId` as it does for `workspace`, both non-enumerable.

## 2. Tests

- [x] 2.1 `src/workflow/agent-tools.test.ts`: a handler reads the bound `sessionId`, reading it out of a turn throws, and the out-of-turn context still compares equal to `{}` with `"sessionId" in context`.
- [x] 2.2 `src/behaviour/child-sessions.test.ts`: a host tool called by the model and by a script reads `s1` in the parent and `childSessionId("s1", 1)` in the child.
- [x] 2.3 `src/behaviour/child-sessions.test.ts`: a host tool in the child writes `<sessionId>/scratchpad/x.txt` through the session store; the child's `read_file scratchpad/x.txt` returns it and the parent holds no such file.

## 3. Docs and authoring skill

- [x] 3.1 `docs/src/content/docs/reference/public-api.md`: `context.sessionId` under host tools, and "A session's files are stored under its id" under session storage.
- [x] 3.2 `docs/src/content/docs/guides/sub-workflows.md`: a host tool's file work inside a child belongs to the child; key by `ToolContext.sessionId`.
- [x] 3.3 `skills/archmax-harness/references/backend-integration.md`: the host tools bullets, the custom backends paragraph and the child session paragraph.
- [x] 3.4 `README.md` and the `0.6.0` section of `reference/changelog.md`.

## 4. Verify

- [x] 4.1 `npm run typecheck`, `npm test` and `npm run docs:build` pass.
- [x] 4.2 `npx openspec validate tool-context-session-id` passes.
