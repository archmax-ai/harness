## 1. A thrown turn ends the session failed

- [x] 1.1 Prove the mechanism first: a test in `src/workflow/turn-runner.test.ts` (or a behaviour test) that makes a turn throw and then writes `{ status: failed, raised }` with `graph.updateState`, finding the `asNode` LangGraph accepts. Verify the next `getState` shows `status: failed`. If no `asNode` works, pause and revisit design decision 5 before continuing.
- [x] 1.2 In `drive()`'s `catch` (`src/workflow/turn-runner.ts`), when the checkpointed status is `running`, commit `failed` with code `recursion-limit` / `turn-cancelled` / `turn-error` and the error's message, then rethrow the original error. A failed update emits a `warning` event and still rethrows the original. Verify with behaviour tests in `src/behaviour/`: a model failing mid-stream (`StreamingScriptedModel` with `STREAM_FAILURE`), the step limit, and a mid-run abort each leave `failed` with the right `exit.code`, and the next `send` runs a fresh turn.
- [x] 1.3 Test that a turn which committed a park and then throws stays parked. Verify the test passes.

## 2. The read race

- [x] 2.1 `BackendCheckpointSaver.getTuple` (`src/workflow/checkpointer.ts`) returns `undefined` when no `checkpoint_id` is asked for and the session's namespace holds no checkpoint. Verify with a unit test in `src/workflow/checkpointer.test.ts` that seeds `storage[t][""] = {}` and reads `t`.

## 3. The turn budget

- [x] 3.1 Add root `budget: { maxModelCalls }` (positive integer, strict) to `src/machine/spec-schema.ts`, with a `DEFAULT_MAX_MODEL_CALLS = 50` the machine exposes. Verify with schema tests: accepted, `0` rejected with "must be a positive number", `budget: { maxTurns }` at the root rejected naming the key.
- [x] 3.2 Stamp each `drive()` invocation with an id in `configurable`, and add `turnCalls: { invocation, count, exhausted? }` to the state channels (`src/workflow/state.ts`). Verify with `npm run typecheck`.
- [x] 3.3 In `beforeModel` (`src/workflow/middleware.ts`), count each call against `turnCalls`, and route the call that would exceed `maxModelCalls` through `routeFailure` once, committing `exhausted`. Verify with behaviour tests: an A↔B cycle under `maxModelCalls: 10` routes to `on_error` (and ends rejected without one) with no `GraphRecursionError`; the handler then runs; a delivery after a park counts from zero; a delegated child counts against its own workflow.
- [x] 3.4 Add the warning line to `volatileSection` (`src/workflow/governance.ts`) while a fifth of the budget or less remains. Verify with a behaviour test that reads the system prompt of the call at 80% (absent) and the next one (present, naming the calls left).

## 4. The derived step limit

- [x] 4.1 Derive the step limit `max(400, (maxModelCalls + 10) × 8)` per assembly. Use it where `AGENT_DEFAULT_CONFIG` is merged for turns and resumes (`src/assembly/index.ts`, `src/assembly/compose.ts`) and in `childConfig` (`src/workflow/sub-workflow.ts`) from the child's machine. Keep the caller's `recursionLimit` winning. Verify with behaviour tests: `maxModelCalls: 200` and a 150-call forward turn completes; `send(…, { recursionLimit: 30 })` throws at 30.
- [x] 4.2 Run `npm test` and `npm run typecheck`. Both pass.

## 5. Docs and skill

- [x] 5.1 Update `docs/src/content/docs/reference/machine-spec.md`: the root `budget` (with default, warning and when to raise it), and the per-state budget section's wrong "default recursion limit (50)". Verify with `npm run docs:build`.
- [x] 5.2 Update the budgets explanation in `docs/src/content/docs/guides/workflow-machine.md`, and in `docs/src/content/docs/reference/public-api.md` what a thrown turn leaves behind (`failed`, the exit codes, the rethrow) and the derived `recursionLimit`. Verify with `npm run docs:build`.
- [x] 5.3 Add 0.9.0 changelog entries in `docs/src/content/docs/reference/changelog.md`: the turn budget (with its behaviour change and migration line), a thrown turn ending failed, and the read race. Verify with `npm run docs:build`.
- [x] 5.4 Update `skills/archmax-harness/references/workflow-schema.md` and `references/workflow-yaml.md` with the root `budget` and when to raise it. Verify by reading the diff.
- [x] 5.5 Check README.md for budget or recursion-limit text (`grep -n -i "budget\|recursion" README.md`) and update it if found. Run `npx openspec validate bound-turn-budget --strict`. It passes.
