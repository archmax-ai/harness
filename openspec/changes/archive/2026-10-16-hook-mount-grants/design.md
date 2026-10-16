## Context

See proposal.md for why. The relevant code today:

- `decide()` (`src/kernel/kernel.ts`) receives `origin: "lifecycle"` for two kinds of caller:
  - a hook script's `tools.*` call, through the PTC gateway that `compose.ts` builds;
  - the runtime's own `file` value check, `runtimeReadDenial` in `src/workflow/file-values.ts`.
- `mountRule` and `skillRule` return `null` for that origin before doing anything. Both resolve the
  workflow's own `forbid_always` lists inside that skipped body (`mountDenial`, `skillDenial`). So
  the own denials never bind a hook.
- Inherited denials reach a hook because they are separate compiled rules
  (`compileForbiddenMountRules`, `compileForbiddenSkillRules`), and those do not exempt the origin.
- `fileGovernance` works around the gap for `file` values. It adds the machine's own
  `workflowDenials(...)` to its rules, and a comment there records that the kernel binds a
  machine's own lists to a hook only through a descendant.
- `WorkflowMachine` resolves grants per state (`enabledMounts`, `mountWritable`,
  `mountNarrowedToRead`). `mountWriteRequested` already works on workflow scope: a `read_write`
  grant anywhere in the spec counts.

## Goals / Non-Goals

**Goals:**

- `decide(machine, { origin: "lifecycle", … })` is correct on its own. It applies the workflow's
  mount grants on workflow scope and the workflow's own `mounts.forbid_always` and
  `skills.forbid_always`, so no caller has to add rules to get this right.
- Model and script calls get exactly the verdicts they get today.

**Non-Goals:**

- **Redacting a hook's listings to its workflow's mounts.** A hook is authored code, not the model.
  A listing shows a name and serves no content, and the read is still refused. This is the same
  trade-off as correction C2, which stays open.
- **Requiring a skill grant for a hook's reads.** Skill bundles are authored, read-only and
  workspace-wide. A routing state's hook that reads a bundle no state enables is a documented
  pattern.
- **Changing rubric graders.** They are dispatched through `task` and are not `lifecycle`-origin
  calls in the kernel.

## Decisions

**1. A workflow-scope verdict branch in the existing rules, not a separate rule.**
`mountRule` keeps one loop over the call's declared paths, and picks a verdict function by origin:

- `mountVerdict` (unchanged) decides on the state;
- a new `runtimeMountVerdict` decides on the workflow.

`skillRule` gets the same shape, with a `runtimeSkillVerdict` that refuses only a slug in
`skills.forbid_always`.

- *Alternative: add the machine's own `workflowDenials` to the hook gateway's rules in
  `compose.ts`.* It fixes the denials but not the grants. It duplicates the script origin's checks,
  because the gateway serves both origins. And a compiled denial's reason says "in every state it
  delegates to", which is wrong for the workflow's own hook.
- *Alternative: a separate safety rule for the lifecycle origin.* That puts the mount logic in two
  places that could drift. A branch keeps it in one rule, after the zone rules, at the same point
  in the order.

**2. Workflow scope means the union of grants, not the current state's.**

- **Reach.** A governed mount is reachable when `mounts.allow_always` or any state's `mounts.allow`
  names it, minus `mounts.forbid_always`.
- **Writes.** A write needs:
  - the host's writable posture, already refused earlier by `zone.read-only`;
  - `mountWriteRequested(name)` for a governed mount;
  - no `access: read` in `mounts.allow_always`.

A state's own `allow`, `forbid` and `access: read` are its surface, and runtime authority sits
outside it, which is the documented reason a routing state that enables nothing can still have a
hook that reads.

- *Alternative: check the active state's grants, as for a model call.* The handoff's phrase "as a
  model's call is" reads this way. It breaks that documented pattern, and it turns a narrow fix
  into a breaking change for every hook that reads outside its state's surface.

**3. The ordering of the runtime verdict.**

1. `mounts.forbid_always` gives `mount.forbidden`.
2. A governed mount no grant names gives `mount.not-allowed`.
3. A mutating access the workflow may not write gives `mount.read-only`.

This mirrors `mountVerdict`, so a refusal names the level an author would fix. The reasons say
"workflow" where `mountVerdict` says "state". For example: "no grant of this workflow names it"
rather than "state 'x' does not have it".

**4. New `WorkflowMachine` methods, named like the existing workflow-level ones.**

- `workflowGrantedMounts(governed)` returns the governed names any grant mentions, minus
  `forbid_always`, in declaration order with `allow_always` first.
- `workflowMountWritable(name, mounts)` applies the rules in decision 2.

They sit beside `workflowAlwaysMounts` and `workflowForbiddenMounts` and reuse
`normalizeMountGrants` and `mountWriteRequested`, so per-state resolution and workflow-scope
resolution stay in one class.

**5. `fileGovernance` drops the machine's own `workflowDenials`.**
With decision 1 the kernel enforces them itself, so adding them again would only duplicate rules
under a misleading reason. The `workflow` option then names nothing and is removed. Its two call
sites, `compose.ts` (`callerFiles`) and `middleware.ts` (`fileGov`), change to match. The child's
`childPolicyRules` in `compose.ts` still compile `workflowDenials(target, …)`. That is how a
caller's denials reach its child, and it is unchanged.

## Risks / Trade-offs

- **A workspace whose hook reads or writes a governed mount its workflow never grants starts
  failing.** The hook throws `PtcGovernanceError`, or vetoes if it does not catch it. → This is the
  intended fix. The changelog entry says how to migrate: add a grant to the workflow, in a state or
  in `allow_always`. It ships in a minor release.
- **A host's `file` seed under a governed mount the workflow grants nowhere is now refused at the
  turn boundary.** → The fix is the same: grant the mount. A seed under the scratchpad or a skill
  bundle is unaffected.
- **A hook that dispatches a child with a `file` argument is checked against the caller's grants
  too.** → The hook could not read that path itself, so passing it on stays consistent.
- **The two verdict functions could drift apart.** → They share `mountNameOf`, the access set and
  the reason helpers. The kernel tests pin each `lifecycle` verdict beside its `agent`
  counterpart.

## Migration Plan

No data migration. A workspace that relies on the old reach adds the missing grant:
`mounts.allow_always: [name]`, or `{ mount: name, access: read_write }` where a hook writes. A
rollback is a revert of the change.
