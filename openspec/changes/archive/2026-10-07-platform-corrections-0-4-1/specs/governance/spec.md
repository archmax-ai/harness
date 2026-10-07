## MODIFIED Requirements

### Requirement: Session areas

The runtime-internal areas SHALL admit no path of any access (`zone.runtime-internal`). The offload
areas SHALL admit an essential tool's `read` or `list` path without an `allow` entry (`tool.offload-read`) and never a
`write` or `remove` path (`zone.runtime-managed`). `scratchpad/` SHALL admit a `read`, `list`,
`write` or `remove` path in every state without an `allow` entry (`tool.scratchpad`), evaluated ahead
of the per-state default, when every path the call names is so admitted and the tool is essential —
one every state permits: the built-in file tools, the file operations and the host's
`essentialTools`. The open areas SHALL NOT admit a call to any other tool, which the state's grant
decides as anywhere, so declaring a host tool's path arguments only ever narrows what it may do; so an `allow` entry naming a
path inside `scratchpad/` SHALL NOT narrow where inside it a write lands, and a call naming a path
outside the open areas SHALL be decided by the state's entries. Any other session-root path SHALL be
matched against the state's entries unchanged. Every block message SHALL point at `scratchpad/` and
name no second working area.

#### Scenario: Scratchpad open under a narrowing entry

- **WHEN** a state declares `{ tool: write_file, paths: ["output/**"] }` and the model writes `scratchpad/work.md`
- **THEN** the write is permitted with `tool.scratchpad`

#### Scenario: File operations inside the scratchpad need no grant

- **WHEN** the model copies, moves and removes files inside `scratchpad/` in any state
- **THEN** each call is permitted with `tool.scratchpad`

#### Scenario: The scratchpad does not open a tool the state does not grant

- **WHEN** a host tool declaring `{ attachment: "read" }` is granted only in `intake`, and in `reply`
  the model calls it with `attachment: "scratchpad/x.pdf"`
- **THEN** the call is blocked with `tool.not-allowed`, and in `intake` it is allowed

#### Scenario: The scratchpad stays open to an essential host tool

- **WHEN** a host tool named in `essentialTools` and declaring `{ path: "read" }` reads `scratchpad/x.md` in any state
- **THEN** the call is permitted with `tool.scratchpad`

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
narrowed to `access: read` refuses `write` and `remove` (`mount.read-only`); an inherited mount or
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
