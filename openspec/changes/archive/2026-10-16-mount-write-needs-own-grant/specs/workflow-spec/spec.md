## MODIFIED Requirements

### Requirement: Mounts blocks

Every mounts list SHALL name mounts only — the keys of the host's mount table with their
slashes stripped (`reference`, `catalogs/eu`, `AGENTS.md`), never globs. A **grant** entry
(`mounts.allow_always`, `mounts.allow`) SHALL accept either a bare name or
`{ mount: <name>, access: read | read_write }`; a **denial** entry (`mounts.forbid_always`,
`mounts.forbid`) SHALL accept a name only, since a denial is total and has no access to
qualify. The lists are `mounts.allow_always` and `mounts.forbid_always` at the root, and
`mounts.allow` and `mounts.forbid` on a state. There SHALL be exactly one mounts model, the
model `skills` uses: a root `mounts.allow` is an unrecognized-key load error, and no list is a
ceiling over another.

A mount SHALL be **governed** when the host declares it so (`MountSpec.governed`, see
`workspace-and-sessions`), and ungoverned otherwise. `mounts.allow_always` SHALL enable its
governed mounts in **every** state, and a state's `mounts.allow` SHALL **add to** it — the
enabled set of a state is the union of the state's own list and the root's always-on list, in
that order. A governed mount no list names SHALL be enabled nowhere. An ungoverned mount SHALL
be enabled in every state without being named, exactly as today, so a spec with no `mounts`
block loads and runs unchanged over any table.

A mount SHALL be readable wherever it is enabled. A governed mount SHALL be writable there
only when all three hold: the host declared it writable, some grant of the workflow's **own**
spec asks `access: read_write` for it (in `mounts.allow_always` or in any state's
`mounts.allow`), and no grant applicable in the state narrowed it to `access: read`. A grant
naming no access SHALL ask for no write: it reaches a write only where a grant of the same
workflow asks for one, so a bare grant in one state and a `read_write` grant in another both
write. A mount belongs to the workflow that grants it. One assembly serves one table to a
session and every child it dispatches, and a route is served writable when any workflow in
that tree asks, so another workflow's `read_write` SHALL NOT widen this one's bare grant. The host's `readOnly` posture SHALL be a **ceiling**:
`access: read_write` on a mount the workspace serves read-only SHALL open nothing and SHALL be
a `validate` warning. `access: read` SHALL be a restriction like every other in this schema —
whichever level asks for it gets it, and no narrower level SHALL widen it back — so a state
cannot re-open a mount the workflow narrowed. An ungoverned mount SHALL take the host's posture
in every state, carrying no grant to ask for a write; only an `access: read` narrows it.

Denial mirrors the grant, and beats it. `mounts.forbid_always` SHALL put its names out of reach
of the whole workflow, governed or not. A state's `mounts.forbid` SHALL remove its names from
that state's enabled set, subtracting from the workflow's `allow_always`, from the state's own
`allow`, and from an ungoverned mount's standing visibility alike. Both SHALL resolve through
the one enabled-set resolution the runtime uses, so the kernel's mount rule, listing redaction,
prompt disclosure and `validate` follow without a second answer; a refusal caused by a forbid
SHALL say so rather than report the mount as merely not enabled.

`archmax validate` SHALL report a name no mount of the table carries (error, naming the mounts
the table declares) under every key, and:

- a name in a grant list that is not governed SHALL be a warning that the entry grants nothing
  (an ungoverned mount is visible everywhere already);
- a name both in the root's `allow_always` and in a state's `allow` SHALL be a warning that the
  state entry grants nothing the workflow had not already given, unless the state entry narrows
  the root's grant to `access: read` or asks `access: read_write` of a mount the root grants
  bare;
- a state's `allow: []` beside a non-empty `allow_always` SHALL be a warning that an empty state
  list subtracts nothing and that `mounts.forbid` is what subtracts;
- a `forbid` entry for a name nothing would have enabled where it applies SHALL be a warning
  that the entry governs nothing;
- a `forbid_always` name that some list also grants SHALL be a warning that the grant reaches
  nothing;
- an `access: read_write` on a mount the table serves read-only SHALL be a warning that the
  entry opens nothing, the host's write posture being the ceiling;
- a state `tools.allow` path entry under a governed mount the state does not enable SHALL be a
  warning that the grant reaches nothing;
- for a spec with no root `mounts` block at all in a workspace whose table declares governed
  mounts: one warning that the workflow can reach none of them (naming them), pointing at
  `mounts.allow_always` as the key to add; any root `mounts` block SHALL silence it —
  `allow_always: []` included.

#### Scenario: Glob-shaped entry rejected

- **WHEN** a state declares `mounts: { allow: ["reference/**"] }`
- **THEN** loading fails stating that entries are mount names, not globs

#### Scenario: An access on a denial entry is a load error

- **WHEN** a state declares `mounts: { forbid: [{ mount: reference, access: read }] }`
- **THEN** loading fails naming the entry, because a denial is total; and
  `mounts: { allow: [{ mount: reference, access: write }] }` fails naming the two accepted
  values, `read` and `read_write`

#### Scenario: The ceiling spelling is a load error

- **WHEN** a spec declares a root `mounts: { allow: [reference] }`
- **THEN** loading fails naming the unrecognized key

#### Scenario: An always-on grant reaches a state that names nothing

- **WHEN** the table governs `reference`, the root declares `mounts: { allow_always: [reference] }`
  and state `lookup` declares no `mounts` block
- **THEN** `reference` is enabled in `lookup`, and `validate` reports no warning about either

#### Scenario: A state adds to the always-on grant

- **WHEN** the table governs `reference` and `catalogs/eu`, the root declares
  `mounts: { allow_always: [reference] }` and state `triage` declares
  `mounts: { allow: [catalogs/eu] }`
- **THEN** `triage` enables both, and no other state enables `catalogs/eu`

#### Scenario: A governed mount no list names is enabled nowhere

- **WHEN** the table governs `catalogs/eu` and no list names it
- **THEN** no state enables it: reads under it are refused, it is absent from every listing and
  every prompt

#### Scenario: An ungoverned mount stays visible without a block

- **WHEN** the table mounts `skills/` and `AGENTS.md` ungoverned and the spec declares no `mounts`
  block
- **THEN** every state reads both, exactly as before the block existed

#### Scenario: A state may read a mount it may not write

- **WHEN** the table mounts `shared` writable and governed, the root declares
  `mounts: { allow_always: [{ mount: shared, access: read_write }] }` and state `review` declares
  `mounts: { allow: [{ mount: shared, access: read }] }`
- **THEN** `review` reads `shared/**` and its listing there is complete, a write there is
  refused naming the mount and the access, and every other state still writes it

#### Scenario: A narrowing at the root binds every state

- **WHEN** the root declares `mounts: { allow_always: [{ mount: shared, access: read }] }` and
  state `edit` declares `mounts: { allow: [{ mount: shared, access: read_write }] }`
- **THEN** no state writes `shared/**`: read-only is a restriction, and the narrower level does
  not widen it back

#### Scenario: The host's posture is the ceiling

- **WHEN** the table mounts `reference` read-only and a grant declares
  `{ mount: reference, access: read_write }`
- **THEN** writes there are still refused, and `validate` warns that the entry opens nothing
  because the host serves the mount read-only

#### Scenario: A state's forbid subtracts an ungoverned mount

- **WHEN** the table mounts `reference` ungoverned and state `route` declares
  `mounts: { forbid: [reference] }`
- **THEN** `route` cannot read `reference/**`, its listing there is empty, and every other state
  still reads it

#### Scenario: A workflow-wide mount denial binds every state

- **WHEN** the root declares `mounts: { allow_always: [reference], forbid_always: [reference] }`,
  or a state names a mount the root forbids
- **THEN** no state enables it, and `validate` warns that the grant reaches nothing

#### Scenario: Naming a mount at both levels is inert

- **WHEN** the root declares `mounts: { allow_always: [reference] }` and a state declares
  `mounts: { allow: [reference] }`
- **THEN** the state enables `reference` once and `validate` warns that the state entry grants
  nothing the workflow had not already given

#### Scenario: A grant on an ungoverned mount is inert

- **WHEN** the table mounts `skills/` ungoverned and a state declares
  `mounts: { allow: [skills] }`
- **THEN** the spec loads and `validate` warns that the entry grants nothing, since the mount is
  visible everywhere already

#### Scenario: A name the table does not carry is an error

- **WHEN** a list names `refrence`
- **THEN** `validate` reports an error naming the mounts the table declares

#### Scenario: A path grant under an unenabled mount is inert

- **WHEN** the table governs `reference`, state `route` does not enable it, and `route` declares
  `tools: { allow: [{ tool: read_file, paths: ["reference/**"] }] }`
- **THEN** `validate` warns that the grant reaches nothing in that state

#### Scenario: A workflow that can reach no governed mount is told once

- **WHEN** the table governs `reference` and `catalogs/eu` and the spec declares no root `mounts`
  block
- **THEN** `archmax validate` reports one warning naming both as unreachable from this workflow and
  naming `mounts.allow_always` as the key to add — and reports none at all when the spec declares
  any root `mounts` block, `allow_always: []` included

#### Scenario: A bare grant reads a mount no grant of the workflow asks to write

- **WHEN** the table mounts `exports` writable and governed, and the workflow grants it only as a
  bare name
- **THEN** every state reads `exports/**`, a write there is refused `mount.read-only` saying no
  grant of this workflow asks for `access: read_write`, and the prompt lists `exports/` as
  read-only

#### Scenario: A caller and its child each answer for their own grants

- **WHEN** workflow A grants `exports` as `{ mount: exports, access: read_write }`, and workflow B,
  which A dispatches, grants it bare
- **THEN** A writes `exports/**` and B is refused `mount.read-only`, its prompt listing `exports/`
  as read-only; and with the grants swapped, B writes and A is refused

#### Scenario: One workflow's grants write together

- **WHEN** state `draft` grants `exports` bare and state `publish` grants it
  `{ mount: exports, access: read_write }`
- **THEN** both states write `exports/**`
