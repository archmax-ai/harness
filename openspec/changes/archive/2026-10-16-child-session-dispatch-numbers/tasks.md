## 1. Ids

- [x] 1.1 `src/core/session-id.ts`: export `CHILD_SESSION_SEPARATOR` and `isChildSegment` (a number from 1, or the 0.5 `<state>:<workflow>:<ordinal>` shape); `sessionIdRejection` refuses `~` in any other shape.
- [x] 1.2 `src/sessions/scope.ts`: `childSessionId(parent, n)`, `rootSessionIdOf`, `dispatchIdOf`; `parentSessionIdOf` and `isChildSessionOf` read child segments; remove `subRunIdentity`.
- [x] 1.3 `src/public/spec.ts`: export `dispatchIdOf` and `rootSessionIdOf` in place of `subRunIdentity`.

## 2. Numbering

- [x] 2.1 `src/workflow/state.ts`: a `dispatchCount` channel folded by `max`; document `identity` as the dispatch's number.
- [x] 2.2 `src/workflow/sub-workflow.ts`: remove `ordinal` and `dispatchSeq`; add `reserve` and `dispatchCount`; a dispatch takes its caller's `number` or the floor plus one; `identity` is the number and `dispatchId` is `dispatchIdOf` the child's id, for refusals too.
- [x] 2.3 `src/workflow/governance.ts`: reserve the checkpointed count in `wrapModelCall`; in `wrapToolCall`, number the batch's delegation calls in tool-call order, reserve the count plus the batch, and write the count left into the call's result.
- [x] 2.4 `src/workflow/tool-service.ts`: pass the call's number into the dispatch.
- [x] 2.5 `src/workflow/middleware.ts`: commit the count in `afterModel`, again after a terminal `after` hook.

## 3. Tests

- [x] 3.1 `src/sessions/scope.test.ts` and `src/core/session-store.test.ts`: the id grammar, the `~` rule, the 0.5 shape still read.
- [x] 3.2 `src/workflow/sub-workflow.test.ts`: numbering above a reservation and by an explicit number; a grandchild's dispatch id; resume under a 0.5 identity.
- [x] 3.3 `src/workflow/middleware.test.ts`: a batch serviced out of order, then replayed on a fresh agent, gets the same numbers, and each result carries the count left.
- [x] 3.4 `src/behaviour/child-sessions.test.ts`: two turns on fresh agents give `~1` and `~2`; a parked `~2` is decided on a fresh agent; a batch of three is numbered in tool-call order; a script numbers above the batch and the next turn continues; a grandchild is `~1~1` with dispatch id `1~1`; a park rewritten into the 0.5 shape resumes; a host id with `~` is refused.
- [x] 3.5 Move the remaining fixtures off the old shapes (`delegation.test.ts`, `checkpointer.test.ts`, `attachments.test.ts`, `tools.test.ts`, `ptc-governance.integration.test.ts`).

## 4. Docs and authoring skill

- [x] 4.1 `guides/sub-workflows.md` (the child's id and its count; dispatch ids under observability) and `guides/triggers.md`.
- [x] 4.2 `reference/public-api.md`: the spec subpath's names, the session id paragraph, `DelegatedPark.identity`.
- [x] 4.3 `skills/archmax-harness/references/workflow-schema.md` and `references/backend-integration.md`.
- [x] 4.4 `README.md` and the `0.6.0` section of `reference/changelog.md`, marked breaking.

## 5. Verify

- [x] 5.1 `npm run typecheck`, `npm test` and `npm run docs:build` pass.
- [x] 5.2 `npx openspec validate child-session-dispatch-numbers` passes.
