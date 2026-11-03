## 1. Kernel and disclosure

- [ ] 1.1 In `compileForbidRules` (`src/kernel/kernel.ts`), have a `*` entry abstain when
  `api.machine.controlTools(action.state)` has the tool. Verify with new `kernel.pipeline.test.ts`
  cases: a bare `*` in `forbid` and in `forbid_always` allows `archmax_advance`, `archmax_raise` and
  `archmax_set_variables` and blocks `read_file`/`archmax_eval`; a guarded `*` with `args.to` does
  not block an advance; `forbid: ["*", archmax_reset]` blocks `archmax_reset`.
- [ ] 1.2 In `WorkflowMachine.disclosedTools` (`src/machine/machine.ts`), make a bare `*` delete
  every disclosed tool outside `controlTools(state)`. Verify with a machine test: an agent state
  with a transition and `forbid: ["*"]` discloses exactly its six controls, and a code state keeps
  `archmax_get_history`.
- [ ] 1.3 Cover inheritance: in a sub-workflow test, an ancestor's `forbid_always: ["*"]` leaves the
  child's controls callable. Verify `npm test` passes.

## 2. Docs, skill, changelog

- [ ] 2.1 Update `docs/src/content/docs/reference/machine-spec.md` (the `*` paragraph) and
  `docs/src/content/docs/guides/workflow-machine.md` to say that `*` excepts the state type's
  controls and that a control is denied by name. Verify `npm run docs:build` succeeds.
- [ ] 2.2 Add a **breaking** entry to `docs/src/content/docs/reference/changelog.md` with the
  migration (name `archmax_advance` instead of guarding `*`).
- [ ] 2.3 Update `skills/archmax-harness/references/workflow-schema.md` (the `"*" = every tool`
  comment and the forbid-entry example) to match. Verify by grep that no `every tool` wording is
  left without the exception.

## 3. Specs

- [ ] 3.1 Run `npx openspec validate wildcard-forbid-spares-controls --strict` and
  `npm run typecheck` and confirm both pass.
