## Context

- `mountWritable(state, name, mounts)` is the one answer the kernel's mount rule
  (`mount.read-only`) and the prompt's mounts section (`renderMountsSection`) consult.
- A mount table is resolved once per assembly. Child compositions share their caller's context, so
  a caller and its children read one `MountPrefixes`, and `writable` there is the host's posture for
  the route, not any one workflow's.
- Each machine already answers reading for its own spec: `enabledMounts`, `redactHiddenMounts`, and
  `compileForbiddenMountRules` for the only thing that crosses down, a caller's `forbid_always`.

## Goals / Non-Goals

**Goals:**

- One workflow's grants never widen what another workflow may write, even through a shared route.
- Within one workflow, nothing that wrote before stops writing, except a write that rested only on
  the host's posture.

**Non-Goals:**

- Per-workflow mount tables. The table stays one per assembly.
- Changing ungoverned mounts. They take the host's posture, and only an `access: read` narrows them.
- A `validate` warning for a writable governed mount granted only bare. In a delegation tree that is
  the normal case for a workflow that only reads what another writes.

## Decisions

**1. A governed write needs a `read_write` grant of the same spec.** `mountWritable` keeps its two
old conditions (the host's posture; no applicable `access: read`) and adds a third,
`mountWriteRequested(name)`: some grant in `mounts.allow_always` or in any state's `mounts.allow`
says `read_write`. The third is asked of the workflow, not of the state, so a bare grant in `draft`
writes because `publish` asks to.

*Alternative:* require the `read_write` grant to be applicable in the state itself. It is simpler to
explain, but it would break every workflow that names a mount once in `allow_always` and asks for
the write in one state.

**2. Every state's grants count, reachable or not.** The request names "any state's
`mounts.allow`", and a state no start state reaches cannot write anyway. Counting only reachable
states would make the answer depend on the transition graph for no difference a run could observe.

**3. Ungoverned mounts are out of scope.** An ungoverned mount is visible in every state without a
grant, and `validate` warns that a grant naming one grants nothing. Requiring a `read_write` grant
for it would leave a writable ungoverned mount writable by no spec at all.

**4. The refusal names its cause.** `mount.read-only` stays one rule id, since the fix is the same
(the spec). Its reason says either `('access: read')` or that no grant of this workflow asks for
`access: read_write`, so an author knows which grant to edit. The kernel reads the first cause from
`mountNarrowedToRead(state, name)`.

**5. The redundant-grant lint learns the new case.** A state entry naming a mount the root already
grants is warned as granting nothing, unless it does work: narrowing to `read` (as before), or
asking `read_write` of a mount the root grants bare, which is now what lets the workflow write.

## Risks / Trade-offs

- **A silent loss of a write on upgrade.** A spec that wrote through bare grants alone now gets
  `mount.read-only`, and its prompt lists the mount read-only. The refusal names the missing
  `read_write`, and the changelog marks the change breaking.
