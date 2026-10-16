## Why

A lifecycle hook runs on runtime authority. The kernel's mount rule skips that origin completely, so a
hook reaches every route in the mount table, whether or not its own workflow grants it:

- One assembly serves one mount table to a session and to every child it dispatches. A host that
  lets a child reach a mount must put that mount in the shared table. The platform's table holds the
  grants of every workflow a session can dispatch.
- So a calling workflow's `before` or `after` script can read a mount only a child grants. Where the
  host serves that mount writable, the hook can also write it. That bypasses 0.6.0's rule that a
  workflow writes a governed mount only where its own grants ask to.
- The same early return means a workflow's **own** `mounts.forbid_always` never binds its own hooks.
  The skill rule has the same gap for `skills.forbid_always`. Both denials reach a hook only when
  they are inherited from a caller. The docs, the authoring skill and the `runtime`, `sandbox` and
  `governance` specs all say a workflow-wide denial binds a hook.

The platform reported this as correction C4 in its handoff (`docs/sdk-handoff.md` in the platform
repository). The second gap was found while confirming it.

## What Changes

- **BREAKING: a hook reaches a governed mount only where its workflow grants it.** On runtime
  authority, a governed mount is readable when some grant of the hook's own workflow names it, in
  `mounts.allow_always` or in any state's `mounts.allow`, and `mounts.forbid_always` does not deny
  it. Otherwise the call is refused with `mount.not-allowed`. The active state's own grant still
  does not matter, so a state that enables nothing can still have a hook that reads.
- **BREAKING: a hook writes a mount only where its workflow asks to write it.** A hook writes a
  governed mount only when the host serves it writable, some grant of the hook's workflow asks
  `access: read_write`, and `mounts.allow_always` does not narrow it to `access: read`. A hook
  writes an ungoverned mount the host serves writable unless `mounts.allow_always` narrows it. A
  state's `access: read` narrowing still does not bind a hook. Otherwise the call is refused with
  `mount.read-only`.
- **A workflow's own workflow-wide denials bind its own hooks.** `mounts.forbid_always` refuses a
  hook's call with `mount.forbidden`, and `skills.forbid_always` with `skill.forbidden`, as
  inherited denials already do. A state's `forbid` lists still do not bind a hook.
- **`file` values follow.** A `file` value is checked against what the session may read on runtime
  authority, at the turn boundary, on a typed return, at completion, and for a delegation argument
  passed from a script or hook. So the check now also refuses a path under a governed mount the
  workflow grants nowhere.
- **Unchanged:** An ungoverned mount still needs no grant to read. A hook still reads any skill
  bundle whatever the enabled set. A hook still sees whole listings. Rubric graders, which are
  dispatched through `task`, are not affected.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `governance`: the mount rule's treatment of the `lifecycle` origin ("Governed mounts are enabled
  per state"), and the list of what still binds a `lifecycle`-origin call ("Sandbox tool calls are
  governed on their origin").
- `runtime`: the hook function contract names the mount grants and `mounts.forbid_always` among
  what binds a hook's `tools.*` calls.
- `sandbox`: "Programmatic tool calls are governed per call" says the same for the PTC bridge, with
  a scenario.
- `workflow-spec`: "A file value names a file the session may read" adds the workflow's mount
  grants to the runtime-authority check.

## Impact

- **Code:**
  - `src/kernel/kernel.ts`: the mount rule and the skill rule decide a `lifecycle`-origin call on
    workflow scope instead of skipping it.
  - `src/machine/machine.ts`: workflow-scope mount resolution, namely the governed mounts any grant
    names and whether the workflow may write a mount.
  - `src/workflow/file-values.ts`: the workflow's own denials no longer need adding as compiled
    rules. Its callers in `src/assembly/compose.ts` and `src/workflow/middleware.ts` change to
    match.
- **Tests:** kernel unit tests for each new verdict, `file-values.test.ts`, and a behaviour test of
  a hook script refused a mount its workflow does not grant.
- **Docs (`docs/`):**
  - `reference/machine-spec.md`, where runtime authority is defined, plus the hook and mount
    sections;
  - `guides/workflow-machine.md`, `guides/sub-workflows.md` and `guides/triggers.md`, where runtime
    authority is described;
  - `reference/changelog.md`.
- **Authoring skill (`skills/archmax-harness/`):** `references/workflow-schema.md` (mount keys,
  `file` values, the hook exemption), `references/hook-and-test-scripts.md` (runtime authority) and
  `references/workflow-yaml.md`.
- **README.md:** no change expected, since it does not describe hook authority over mounts. A task
  checks this.
- **Release:** a behaviour change for any workspace whose hooks read or write a governed mount
  their workflow does not grant, so it goes in a minor release.
