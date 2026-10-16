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
`zone.read-only`, so a refusal names the level an author would fix: the wiring or the grant. A rubric grader and a lifecycle hook SHALL be bound by
`mounts.forbid_always` and not by a state's `forbid`, as they are for tools.

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

### Requirement: Tools declare their path arguments

The runtime SHALL keep one table naming, per tool, the arguments that name workspace paths and how a
call uses each — `read`, `list`, `search`, `write`, `remove` or `execute`. The built-in entries SHALL
be `read_file`, `write_file`, `edit_file` (`file_path`: read, write, write), `ls` (`path`: list),
`glob`, `grep` (`path`: search), `archmax_run` (`file_path`: execute), `copy_file` (`source`: read,
`destination`: write), `move_file` (`source`: remove, `destination`: write) and `remove_file`
(`file_path`: remove). For the single-path built-ins the kernel SHALL read the declared argument and,
when it is absent, the second spelling the tool itself accepts (`path` for `file_path` and the
reverse), so a call cannot pass a path ungoverned by spelling it the other way.

A host SHALL declare its own tools' path arguments through `createAgent`'s `toolPaths` or a
`toolsFromMap` descriptor's `paths`, the option winning for a tool declared both ways. A declaration
for a built-in tool, an unknown access, or an empty declaration SHALL fail assembly with
`ToolPathsError`. A tool with no declaration SHALL be subject to no path rule. Every machine of an
assembly, root and delegated, SHALL govern by the same table.

A declared argument SHALL hold one path or a list of paths; each path of a list SHALL be governed
with the argument's access, and an omitted argument or an empty list SHALL name no path. A declared
argument holding anything else — a number, an object, a list containing a non-string — SHALL be
refused before every other rule (`tool.path-argument`), so no path inside it passes ungoverned.

Every path rule SHALL evaluate every declared path a call names, with its access: the read-only zone
and the runtime-managed areas refuse `write` and `remove`; the runtime-internal areas, a skill bundle
the state does not enable, and a governed mount the state was not given refuse every access; a mount
narrowed to `access: read`, or a governed one no grant of the workflow asks to write, refuses `write`
and `remove` (`mount.read-only`); an inherited mount or
skill denial refuses every access; `script.skill-only` confines `execute`; and the authoring-plane
rule reads them for scripts and hooks. A call SHALL be refused when any one of its paths is, and for a
tool declaring several, the refusal SHALL name the argument (`'copy_file' on 'x' (destination)`). A
`paths:` guard SHALL test every path of every declared argument, each element of a list on its own:
a grant SHALL need every one to match, and an omitted argument or an empty list SHALL match no glob.
A `paths:` guard in a forbid entry SHALL match a call when **any** declared path it names matches, so
`{ tool: "*", paths: [secrets/**] }` refuses a copy out of `secrets/` and a copy into it. The kernel,
`validate`'s probes and the sandbox's governed tool bridge SHALL read the same table, so a script's
call is governed by its declared paths exactly as the model's is.

#### Scenario: A host tool's read is refused a mount the state was not given

- **WHEN** a workflow grants the governed mount `contracts` only in `intake`, and in `reply` the model
  calls a host tool declaring `{ path: "read" }` with `path: "contracts/x"`
- **THEN** the call is blocked with `mount.not-allowed` and the tool's handler never runs

#### Scenario: A host tool's write is refused a read-only grant

- **WHEN** a state narrows a writable mount `shared` to `access: read`, and a host tool declaring
  `{ source: "remove", destination: "write" }` names `shared/a.md` as either argument
- **THEN** the call is blocked with `mount.read-only`, while a `read` argument under `shared/` is allowed

#### Scenario: A host tool's read is refused a disabled skill

- **WHEN** a state does not enable the skill `billing` and a host tool declaring `{ path: "read" }`
  names `skills/billing/SKILL.md`
- **THEN** the call is blocked with `skill.not-allowed`

#### Scenario: A path denial covers both sides of a copy

- **WHEN** `tools.forbid_always` declares `{ tool: "*", paths: ["secrets/**"] }`
- **THEN** `copy_file` from `secrets/key.pem` and `copy_file` to `secrets/key.pem` are both blocked with `tool.forbidden`

#### Scenario: The alias spelling is governed

- **WHEN** the model calls `read_file` with `path: "checkpoints/cp-1.json"` and no `file_path`
- **THEN** the call is blocked with `zone.runtime-internal`

#### Scenario: A built-in's paths cannot be redeclared

- **WHEN** a host passes `toolPaths: { read_file: { file_path: "read" } }`
- **THEN** assembly throws `ToolPathsError`

#### Scenario: Each path of a list is governed

- **WHEN** a host tool declares `{ files: "read" }` and, in a state not given the governed mount
  `contracts`, the model calls it with `files: ["attachments/a.txt", "contracts/b.docx"]`
- **THEN** the call is blocked with `mount.not-allowed`

#### Scenario: A paths grant tests each element

- **WHEN** a state grants `{ tool: attach, paths: ["attachments/**"] }` and the model calls `attach`
  with `files: ["attachments/a.txt", "contracts/b.docx"]`
- **THEN** the call is not granted, though the two joined into one string would match the glob

#### Scenario: A path argument of another shape is refused

- **WHEN** a tool declaring `{ files: "read" }` is called with `files: ["a.txt", 3]` or `files: { path: "b.txt" }`
- **THEN** the call is blocked with `tool.path-argument`
