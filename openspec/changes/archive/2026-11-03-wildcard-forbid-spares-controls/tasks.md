## 1. Schema and lint

- [x] 1.1 In `refineSpec` (`src/machine/spec-schema.ts`), reject any `tools.forbid` or
  `tools.forbid_always` entry naming `archmax_advance`, bare or guarded, with a message that points
  to `transitions` and terminal states. Verify with `spec-schema.test.ts` cases for both
  positions and both forms.
- [x] 1.2 Remove the `forbid_always: [archmax_advance]` check from `lintSpec`
  (`src/machine/lint-spec.ts`), and replace the two `validate.test.ts` cases (around line 2346) with
  a load-error case. Verify `npx vitest run src/validate src/machine` passes.

## 2. Kernel and disclosure

- [x] 2.1 In `compileForbidRules` (`src/kernel/kernel.ts`), have a `*` entry abstain when the tool is
  `archmax_advance`. Verify with `kernel.pipeline.test.ts` cases: a bare `*` in `forbid` and in
  `forbid_always` allows `archmax_advance` and blocks `read_file`, `archmax_eval`, `archmax_raise`,
  `archmax_reset` and `archmax_set_variables`; a guarded `*` with `args.to` does not block an
  advance; a code state's `archmax_get_history` is blocked by `*`.
- [x] 2.2 In `WorkflowMachine.disclosedTools` (`src/machine/machine.ts`), make a bare `*` delete every
  disclosed tool except `archmax_advance`. Verify with a machine test: a non-terminal state with
  `forbid: ["*"]` discloses exactly `archmax_advance`, and a terminal one discloses nothing.
- [x] 2.3 Cover inheritance: in a sub-workflow test, an ancestor's `forbid_always: ["*"]` leaves the
  child's `archmax_advance` callable. Verify `npm test` passes.

## 3. Docs, skill, changelog

- [x] 3.1 Update `docs/src/content/docs/reference/machine-spec.md` (the `*` paragraph, and the
  `validate` sentence about denying `archmax_advance`), `reference/public-api.md` ("A `forbid`
  still blocks a control") and `guides/workflow-machine.md`. Verify `npm run docs:build` succeeds.
- [x] 3.2 Add a fix entry to `docs/src/content/docs/reference/changelog.md` with a one-line note
  for a guarded `archmax_advance` denial: drop the edge or gate leaving with `requires`.
- [x] 3.3 Update `skills/archmax-harness/references/workflow-schema.md` (the `"*" = every tool`
  comment) and `references/diagnostics.md` (the advance row becomes the load error). Verify by grep
  that no forbid wording in `docs/` or `skills/` still implies the advance can be denied.

## 4. Specs

- [x] 4.1 Run `npx openspec validate wildcard-forbid-spares-controls --strict` and
  `npm run typecheck` and confirm both pass.
