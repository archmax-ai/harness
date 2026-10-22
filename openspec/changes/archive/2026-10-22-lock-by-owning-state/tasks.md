## 1. The `locks` key

- [x] 1.1 Add `locks` (a list of variable names) to the state schema in `src/machine/spec-schema.ts`. In `refineSpec`, fail loading for a variable owned by two states (naming both), for `trigger` or `title` in `locks`, for a duplicate in one list, and for `locks` on a human state. Verify with schema tests for each failure, and that a valid `locks` loads.
- [x] 1.2 Give `WorkflowMachine` (`src/machine/machine.ts`) an `ownerOf(name)` built from the states' `locks` at load. Verify with a machine unit test.
- [x] 1.3 Warn when a trigger's `requires` names an owned variable (`src/machine/lint-spec.ts`), and when a `createAgent` seed names one (beside `unguaranteedReferenceWarnings` in `src/assembly/compose.ts`). Verify with a lint test and an assembly test.

## 2. Writing an owned variable

- [x] 2.1 In `handleSetVariables` (`src/workflow/control-tools.ts`), refuse a write to a variable owned by another state, naming the owner and saying to go back there, and refuse `lock: true` on an owned variable. Both refusals are atomic. Verify with unit tests in `control-tools.test.ts`: a write in the owner, a write elsewhere, `lock` on an owned name, and a host seed of an owned name still refused as locked.
- [x] 2.2 Add `lockedBy: "agent"` to the variable entry (`src/machine/variables.ts`, `variableEntrySchema` in `src/workflow/state.ts`). Set it when `handleSetVariables` locks, and carry it in `mergeVariables`. Verify with reducer tests: an agent lock keeps the marker, and a `reseed` write drops it.

## 3. Reset frees the agent's locks

- [x] 3.1 In `handleReset`, release every entry locked with `lockedBy: "agent"`: keep its value, unlock it, and mark the write `reseed` so the merge accepts it. Leave every other variable alone. Verify with a unit test: an agent-locked variable is unlocked with its value kept, a host seed stays locked, and a lock without the marker (a session from before) stays locked.

## 4. Behaviour

- [x] 4.1 Add `src/behaviour/owned-variables.test.ts` with the order-correction loop: `lookup` owns `order_id` and sets it, the session advances to `act`, whose guard reads `${{order_id}}`. A write in `act` is refused naming `lookup`. The agent advances back to `lookup`, rewrites `order_id`, returns to `act`, and the guard admits the new order. Add a reset test: an agent lock is released by `archmax_reset` and the value is written again. Verify with `npx vitest run src/behaviour/owned-variables.test.ts`.
- [x] 4.2 Run `npm run typecheck`, `npm test` and `npm run lint`. Verify all pass.

## 5. Docs and skill

- [x] 5.1 Document the `locks` key in `docs/src/content/docs/reference/machine-spec.md`, and in the session-variables section of `docs/src/content/docs/guides/workflow-machine.md`: ownership, going back to change a value, giving the owner a back-edge, and what a reset frees. Add `lockedBy` where `docs/src/content/docs/reference/public-api.md` describes a variable's `{ value, locked }`. Verify with `npm run docs:build`.
- [x] 5.2 Add a 0.9.0 changelog entry in `docs/src/content/docs/reference/changelog.md`, marked breaking for the reset. Verify with `npm run docs:build`.
- [x] 5.3 Document the `locks` key and when to use it in `skills/archmax-harness/references/workflow-schema.md` and `references/workflow-yaml.md`, and update the skill's variable guidance where it describes locks (`grep -rn "lock" skills/archmax-harness`). Check README.md with `grep -n -i "lock" README.md`. Run `npx openspec validate lock-by-owning-state --strict` and verify it passes.
