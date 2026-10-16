# Tasks

## 1. Workflow-scope mount resolution in the machine

- [x] 1.1 Add `WorkflowMachine.workflowGrantedMounts(governed)` and `workflowMountWritable(name, mounts)` in `src/machine/machine.ts`, beside `workflowAlwaysMounts` and `workflowForbiddenMounts`, reusing `normalizeMountGrants` and `mountWriteRequested`. Verify with unit tests in `src/machine/machine.test.ts` (or the file that already covers `mountWritable`) for: a grant in one state only, `allow_always` with `access: read`, a forbidden name, an ungoverned writable mount, and a host read-only mount.

## 2. Kernel: the lifecycle origin is decided on workflow scope

- [x] 2.1 In `src/kernel/kernel.ts`, have `mountRule` pick `runtimeMountVerdict` for `origin: "lifecycle"` instead of returning `null`. The order is `mount.forbidden` (own `forbid_always`), then `mount.not-allowed` (no grant of the workflow names a governed mount), then `mount.read-only` (`workflowMountWritable` is false). Each reason says "workflow", not "state". Update the doc comments on `mountRule`, `ToolCallOrigin` and `compileForbiddenMountRules`. Verify by replacing `exempts a lifecycle hook from the state's surface` in `src/kernel/kernel.test.ts` with tests for: a mount granted in another state (allowed), a mount granted nowhere (read and write both `mount.not-allowed`), a bare grant with a write (`mount.read-only`), a `read_write` grant in another state with a write (allowed), own `forbid_always` (`mount.forbidden`), a state `forbid` (not binding), and `allow_always` `access: read` on an ungoverned writable mount (`mount.read-only`).
- [x] 2.2 In the same file, have `skillRule` pick `runtimeSkillVerdict` for `origin: "lifecycle"`. It refuses only a slug in the workflow's own `skills.forbid_always` (`skill.forbidden`). Update its doc comment. Verify by keeping `exempts a lifecycle hook, which runs on harness authority` passing, and adding a test where own `skills.forbid_always` blocks a hook and a state's `skills.forbid` does not.
- [x] 2.3 Add a pipeline test in `src/kernel/kernel.pipeline.test.ts` showing a `lifecycle` call bound by its own `mounts.forbid_always` and `skills.forbid_always` with no extra rules passed. Verify with `npx vitest run src/kernel`.

## 3. File values and the hook gateway

- [x] 3.1 Remove the machine's own `workflowDenials` and the now unused `workflow` option from `fileGovernance` in `src/workflow/file-values.ts`, and update its header comment. Update the call sites in `src/assembly/compose.ts` (`callerFiles`) and `src/workflow/middleware.ts` (`fileGov`). Leave `childPolicyRules` as it is. Verify that `src/workflow/file-values.test.ts` passes, extended with a case where a path under a governed mount the workflow grants nowhere is refused with `mount.not-allowed`, and that the own-`forbid_always` case still refuses.
- [x] 3.2 Add a behaviour test in `src/behaviour/` with a `before` hook script whose `tools.readFile` on a governed mount the workflow does not grant is refused with the `mount.not-allowed` reason (the hook catches it as an error), while a read of a mount another state grants succeeds. Verify with `npx vitest run src/behaviour`.

## 4. Docs, authoring skill and README

- [x] 4.1 Update the `docs/` site:
  - `reference/machine-spec.md`: the runtime-authority definition near line 1030, and the hook and mount passages near lines 422 and 1202;
  - `guides/workflow-machine.md` (near line 273), `guides/sub-workflows.md` (near line 350) and `guides/triggers.md` (near line 207);
  - add the 0.7.0 changelog entry in `reference/changelog.md`, with the migration (add the grant).

  Verify that `npm run docs:build` succeeds and that `grep -rn "mount and skill grants do not bind"` over `docs/` finds nothing.
- [x] 4.2 Update `skills/archmax-harness/`:
  - `references/workflow-schema.md`: mount keys near lines 338 and 394, `file` values near 578, the hook exemption near 776, 1017 and 1502;
  - `references/hook-and-test-scripts.md` near line 206;
  - `references/workflow-yaml.md` near line 173.

  Verify that every passage states that a hook is bound by its workflow's mount grants and its own `forbid_always` lists.
- [x] 4.3 Check `README.md` for any statement about hook reach over mounts, and update it if one exists. Verify with `grep -n -i "hook" README.md`.

## 5. Integration

- [x] 5.1 Run `npm run typecheck`, `npm test` and `npx openspec validate hook-mount-grants`, and verify that all three pass.

## Workflow follow-up

- Sync the delta specs into `openspec/specs/` and archive the change once it is reviewed.
- Tell the platform that C4 is resolved, and that its own-denial counterpart is resolved too, in
  its `docs/sdk-handoff.md`.
