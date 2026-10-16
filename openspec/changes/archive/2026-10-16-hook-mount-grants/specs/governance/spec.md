## MODIFIED Requirements

### Requirement: Governed mounts are enabled per state

A mount the host declares governed (`MountSpec.governed`) SHALL be reachable from a state only when
that state enables it: the union of the state's `mounts.allow` and the root's `mounts.allow_always`,
minus what `mounts.forbid_always` or the state's `mounts.forbid` names. An ungoverned mount SHALL be
reachable in every state unless a `forbid` names it. One resolution
(`WorkflowMachine.enabledMounts(state, governed)`) SHALL be the single answer every governed reader
consults: the kernel's mount rule, the middleware's listing redaction, prompt disclosure and
`validate`.

A grant SHALL also decide **what** the state may do there: a governed mount is writable in a state
only when the host declared it writable, some grant of the machine's own spec asks
`access: read_write` for it, and no applicable grant narrowed it to `access: read`
(`WorkflowMachine.mountWritable(state, name, prefixes)`, the second reader beside the enabled set).
The host's posture is the ceiling: `access: read_write` opens nothing the wiring serves read-only.
A narrowing at either level holds, so no narrower level widens it back. One workflow's `read_write`
never widens another's bare grant of the same route, though one table serves both.

The kernel SHALL block a file tool call — `read_file`, `ls`, `glob`, `grep`, `write_file`, `edit_file`
and every sandbox tool call on the same origins the skill rule governs — whose canonical path falls
under a mount the active state does not enable, in every state whatever it allows, evaluated among the
safety rules after the zone rules so a write into a hidden read-only mount is still refused as
read-only, the more useful reason. A refusal SHALL distinguish its cause — `mount.forbidden` when a
list denies the name (naming the workflow that denied it when the denial is inherited),
`mount.not-allowed` when nothing enabled it, and `mount.read-only` when the state has the mount
but a grant narrowed it to reads or no grant of the workflow asks to write it, saying which — and SHALL name the mount and say the state does not have it,
never that the path is missing. A write into a mount the **host** serves read-only SHALL stay
`zone.read-only`, so a refusal names the level an author would fix: the wiring or the grant. A rubric grader SHALL be bound by
`mounts.forbid_always` and not by a state's `forbid`, as it is for tools.

A `lifecycle`-origin call — a hook script's `tools.*` call, and the runtime's own check of a `file`
value — SHALL be decided against the grants of its **workflow**, not of the active state. A governed
mount SHALL be reachable on runtime authority when some grant of the workflow names it, in
`mounts.allow_always` or in any state's `mounts.allow`, and SHALL otherwise be refused with
`mount.not-allowed`, saying no grant of the workflow names it. A write there SHALL need the host's
writable posture, and for a governed mount a grant of the workflow asking `access: read_write`; an
`access: read` in `mounts.allow_always` SHALL narrow it for a governed and an ungoverned mount alike;
a refused write is `mount.read-only`. The workflow's own `mounts.forbid_always` SHALL refuse the call
with `mount.forbidden`. A state's `mounts.allow`, `mounts.forbid` and `access: read` SHALL NOT bind
it, so a state that enables no mount can still run a hook that reads one its workflow grants
elsewhere. A grant of another workflow in the same tree SHALL never count, though one table serves
both.

Listing results SHALL be redacted to the state's enabled mounts: an `ls`, `glob` or `grep` result
handed to the model SHALL carry no entry under a mount the state does not enable, the workspace root
listing included, so the agent is not shown a directory it then cannot read. Every call SHALL still be
decided by the kernel whether or not the mount was listed.

#### Scenario: A governed mount is hidden where nothing enables it

- **WHEN** the table governs `catalogs/eu`, state `intake` does not enable it and the model calls
  `read_file` on `catalogs/eu/skus.csv`, `ls` on `/`, and `grep` over `/`
- **THEN** the read is blocked with `mount.not-allowed`, the root listing shows no `catalogs/eu`
  entry, and the grep result carries no match under it

#### Scenario: The same mount is served where a state enables it

- **WHEN** state `triage` declares `mounts: { allow: [catalogs/eu] }`
- **THEN** in `triage` the same read succeeds, `ls /` lists `catalogs/eu/`, and a write there is
  refused with `zone.read-only`

#### Scenario: A grant narrows a writable mount to reads

- **WHEN** the table mounts `shared` writable and governed, state `edit` enables it as
  `{ mount: shared, access: read_write }` and state `review` enables it as
  `{ mount: shared, access: read }`
- **THEN** a write in `edit` succeeds, the same write in `review` is blocked with
  `mount.read-only` naming the mount, and `review` still reads and lists it in full

#### Scenario: A forbid says so

- **WHEN** the root declares `mounts: { forbid_always: [reference] }` and the model reads
  `reference/rates.csv`
- **THEN** the call is blocked with `mount.forbidden`, naming `reference` and the denying workflow

#### Scenario: An ungoverned mount needs no grant

- **WHEN** the table mounts `skills/` ungoverned and a state declares no `mounts` block
- **THEN** reads and listings under `skills/` are governed only by the skill rules, as today

#### Scenario: Undisclosed mount still governed

- **WHEN** the model calls `read_file` on a path under a governed mount that was redacted from its
  listing
- **THEN** the kernel blocks it with the mount rule's message, whether or not the listing showed it

#### Scenario: A write no grant of the workflow asks for is refused

- **WHEN** the table mounts `exports` writable and governed, and the workflow grants it only bare
- **THEN** a write under `exports/` is blocked with `mount.read-only`, naming the mount and saying
  no grant of this workflow asks for `access: read_write`

#### Scenario: A hook reads a mount its workflow grants in another state

- **WHEN** the table governs `catalogs/eu`, only state `triage` enables it, and a `before` hook on
  state `intake` reads `catalogs/eu/skus.csv`
- **THEN** the read runs: a hook is decided on the workflow's grants, not the active state's

#### Scenario: A hook cannot reach a mount only another workflow grants

- **WHEN** the table mounts `invoices` writable and governed because a child workflow grants it
  `read_write`, the calling workflow grants it nowhere, and a hook of the calling workflow reads
  and then writes `invoices/a.xml`
- **THEN** both calls are blocked with `mount.not-allowed`, naming `invoices` and saying no grant of
  the workflow names it

#### Scenario: A hook writes only where its workflow asks to write

- **WHEN** the table mounts `exports` writable and governed, the workflow grants it bare in
  `mounts.allow_always`, and a hook writes `exports/out.csv`
- **THEN** the write is blocked with `mount.read-only`, while a hook in a workflow whose state
  `publish` grants `{ mount: exports, access: read_write }` writes there from any state

#### Scenario: A workflow's own mount denial binds its hook

- **WHEN** the root declares `mounts: { forbid_always: [reference] }` and a hook of that workflow
  reads `reference/rates.csv`
- **THEN** the call is blocked with `mount.forbidden`, while a state's `mounts.forbid` naming the
  same mount would not bind the hook

### Requirement: Sandbox tool calls are governed on their origin

Every `tools.*` call a script makes SHALL run through the same `decide` pipeline as a model call, via
one gateway that wraps the PTC tool surface and reads the live state per call. A `script`-origin call
(code from `archmax_eval` or `archmax_run`) SHALL be governed as a model call in the active state. A
`lifecycle`-origin call (a hook script) SHALL skip the per-state allow rule, the per-state denials
(`tools.forbid`, `skills.forbid`, `mounts.forbid`) and the skill enablement check, and SHALL meet the
mount grants on workflow scope rather than the state's: a hook runs on runtime authority, outside the
state's tool surface in both directions, while its workflow's mount grants, the workflow-wide denials
(`tools.forbid_always`, `skills.forbid_always`, `mounts.forbid_always`) — its own workflow's and every
ancestor's — and every safety rule still bind it. A refused call SHALL throw a catchable `PtcGovernanceError` carrying the tool, rule id
and reason, and the tool SHALL never run; declarative mocks SHALL be consulted only after governance
permits. The kernel SHALL own the set of tools excluded from the PTC surface — the control tools, both
sandbox tools, and bare `eval` — consumed by the sandbox tool selection and the lifecycle runner alike,
even for an explicit allow-list; scripts read variables through `args.variables`. A delegation tool
SHALL NOT be excluded: a script reaches `archmax_workflow_<slug>` exactly as any tool the state grants.

#### Scenario: Script bound by the state

- **WHEN** a state does not allow `write_file` and `archmax_eval` code calls `tools.writeFile`
- **THEN** the call is refused with the verdict a model-initiated `write_file` would receive

#### Scenario: Hook keeps the full surface but not the safety rules

- **WHEN** a hook script calls a tool the state's `allow` list omits, and separately calls
  `tools.writeFile` on a read-only mount path
- **THEN** the first call runs and the second is blocked by `zone.read-only`

#### Scenario: A hook is bound by the workflow's denial and not the state's

- **WHEN** state `route` declares `tools: { forbid: [read_file] }`, the root declares
  `tools: { forbid_always: [write_file] }`, and a `before` hook on `route` calls both
- **THEN** the `read_file` call runs — a hook is outside the state's surface — and the `write_file`
  call is refused with a `PtcGovernanceError` naming the workflow-wide denial

#### Scenario: A workflow's own skill denial binds its hook

- **WHEN** the root declares `skills: { forbid_always: [payroll] }` and a hook of that workflow
  reads `skills/payroll/assets/rates.csv`
- **THEN** the call is refused with `skill.forbidden`, while a read inside a bundle no state
  enables and no list denies still runs
