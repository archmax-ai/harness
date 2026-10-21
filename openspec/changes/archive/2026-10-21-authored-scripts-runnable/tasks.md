# Tasks

## 1. Baseline

- [x] 1.1 Branch `feat/authored-scripts-runnable` from `main` in the fresh clone, `npm ci`, and confirm
  `npm run typecheck`, `npm run lint` and `npm test` are green before any edit.

## 2. The rule

- [x] 2.1 `src/workflow/paths.ts`: add `workflowFileKind(rel)` (`hook` / `governance` / `authored`,
  `null` off the prefix), comparing segments case-insensitively, without trailing dots or spaces, and
  splitting on `\` too (D2–D4). Name the spec, prose and tests files once and use them in
  `workflowPaths`.
- [x] 2.2 `src/kernel/kernel.ts`: replace `scriptSkillOnlyRule` with `scriptAuthoredOnlyRule`
  (`script.authored-only`) in the same `SAFETY_RULES` slot; export `unrunnableScript(tool, path,
  skills)` for the validator, with `workflows/` authored for `archmax_run` alone (D6) and one refusal
  sentence per kind.
- [x] 2.3 `src/sandbox/executor.ts`: an optional `authoring` workspace serving canonical `workflows/`
  paths; `src/assembly/compose.ts` passes it to both executors (D5).

## 3. The validator

- [x] 3.1 `src/validate/validate.ts`: replace the "outside every skill bundle" check with
  `inertRunEntries`/`inertRunPattern` (D8), run it on state `tools.allow` and on `tools.allow_always`,
  and skip `archmax_run` in the "names the authoring plane" check.

## 4. Tests

- [x] 4.1 Rewrite `src/core/authoring-plane.test.ts`'s `archmax_run` block: a workflow script runs; a
  scratchpad, other session, mount and escaping path are refused; every hook spelling is refused;
  spec, prose and cases are refused; no grant or custom rule widens it; a state entry narrows; the
  registry is followed; a host tool's `execute` path stays in bundles.
- [x] 4.2 Update `src/kernel/kernel.test.ts` (no enabled skill still runs a workflow script; a mount
  is refused as `script.authored-only`) and `src/kernel/kernel.pipeline.test.ts` (the id).
- [x] 4.3 `src/validate/validate.test.ts`: inert entries by kind, no plane error for `archmax_run` on
  a workflow's scripts while other tools keep it, broad entries accepted, `allow_always` checked.
  Point the `allow_always` grants fixture at `workflows/p/scripts/**`.
- [x] 4.4 `src/sandbox/executor.test.ts` (routing, canonical spellings, the missing-file message) and
  `src/workflow/paths.test.ts` (`workflowFileKind`).
- [x] 4.5 Behaviour suite in `src/behaviour/sandbox-run.test.ts`, through the public barrel: a
  workflow script runs with no skill; a file the agent writes at a `workflows/` path never runs; a hook
  and a scratchpad script are refused; a mount's script is readable and refused; a state entry
  narrows.

## 5. Docs, README, skill

- [x] 5.1 `docs/`: `guides/authoring-plane.md`, `guides/code-interpreter.md`, `guides/skills.md`,
  `guides/workflow-machine.md`, `reference/machine-spec.md` (including the stale `scripts/**` example
  and "a script the agent wrote into `scratchpad/` could be run"), `reference/public-api.md`,
  `reference/glossary.md`; a `0.9.0` section in `reference/changelog.md`. Verify with
  `npm run docs:build` and a grep for `script.skill-only` and "skill bundle" claims about scripts.
- [x] 5.2 `README.md`: the workspace tree shows `workflows/<slug>/scripts/`.
- [x] 5.3 `skills/archmax-harness/`: `SKILL.md`, `references/workflow-schema.md`,
  `references/hook-and-test-scripts.md`, `references/hooks-and-scripts.md`,
  `references/workflow-yaml.md`, `references/diagnostics.md`, `README.md`.
- [x] 5.4 `AGENTS.md`: the sandbox paragraph.

## 6. Verify and archive

- [x] 6.1 `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run docs:build`;
  `archmax validate` on both example workflows reports 0 errors and 0 warnings.
- [x] 6.2 Archive the change, applying its deltas to `openspec/specs/`, and update the `sandbox`
  spec's Purpose line by hand (an archive leaves a Purpose alone). `openspec validate --specs` passes.
