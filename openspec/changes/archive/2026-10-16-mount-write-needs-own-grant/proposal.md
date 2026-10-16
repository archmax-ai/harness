## Why

`WorkflowMachine.mountWritable` allowed a write when the host served the mount writable and no grant
applicable in the state said `access: read`. A bare grant therefore took the posture the route was
served with. That is right while one workflow owns the table, and wrong once a table serves more
than one:

- One assembly serves one mount table to a session and to every child it dispatches:
  `createDelegationRegistry` composes each child with its caller's context, so the child shares the
  caller's `mountPrefixes`.
- A host must therefore put a child's grants in that table, or a mount only the child grants has no
  route. The platform does: its table is the union of the grants of every workflow a session can
  dispatch.
- A route has one posture, so it is served writable when any workflow in the tree asks for
  `read_write`. A bare grant in any other workflow then reached it writable: a child's `read_write`
  let its caller write through a bare grant, and a caller's did the same for a child.

The harness already keeps reading per workflow: each machine resolves its own enabled set, listings
are redacted to it, and only a caller's `forbid_always` travels down. Writing was the one place a
shared route let one spec reach into another.

This is request 13 of the platform's handoff (`docs/sdk-handoff.md` in the platform repository).

## What Changes

- **BREAKING: a bare grant asks for no write.** A governed mount is writable in a state only when
  all three hold:
  - the host serves it writable;
  - some grant of the machine's **own** spec asks `access: read_write` for it, in
    `mounts.allow_always` or in any state's `mounts.allow`;
  - no grant applicable in the state says `access: read`.

  Within one workflow, a bare grant in one state and a `read_write` grant in another still both
  write. An ungoverned mount keeps the host's posture: it carries no grant to ask with.
- **The kernel's `mount.read-only` refusal and the prompt's mounts section follow it**, as they
  already follow `mountWritable`. The refusal says which cause applies: an `access: read`, or no
  grant of the workflow asking `read_write`.
- **The redundant-grant lint stops warning** about a state's `read_write` entry for a mount the root
  grants bare, since that entry is what lets the workflow write there.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `workflow-spec`: a governed mount is written only where a grant of the same workflow asks
  `read_write`; the lint's exception.
- `governance`: `mountWritable` and the `mount.read-only` refusal, for file tools and declared host
  tool paths.
- `workspace-and-sessions`: the `readOnly` ceiling sentence and its scenario.

## Impact

- **Code:** `src/machine/machine.ts` (`mountWritable`, `mountNarrowedToRead`,
  `mountWriteRequested`), `src/kernel/kernel.ts` (the refusal's reason), `src/machine/lint-spec.ts`,
  and comments in `src/core/mount-prompt.ts` and `src/machine/mount-grants.ts`.
- **Docs:** `guides/workflow-machine.md`, `reference/machine-spec.md`, `reference/public-api.md`,
  `reference/changelog.md`, `README.md`.
- **Authoring skill:** `references/workflow-schema.md`, `references/backend-integration.md`.
- **Hosts and authors:** a spec that wrote a writable governed mount through bare grants alone loses
  the write, and adds `access: read_write` to one of its grants. The platform derives every posture
  from grants, so nothing it serves changes. The reference workspace grants no mounts.
- **Release:** breaking, so 0.6.0.
