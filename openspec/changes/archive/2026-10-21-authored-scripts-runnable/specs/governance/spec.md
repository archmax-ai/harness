## RENAMED Requirements

- FROM: `### Requirement: Two script homes with disjoint executors`
- TO: `### Requirement: Hook scripts and authored scripts run apart`

## MODIFIED Requirements

### Requirement: Tool-call verdicts come from an ordered rule pipeline

The kernel SHALL decide a tool call by folding an ordered pipeline of pure rules, each returning a
verdict or abstaining; the first verdict wins and every rule abstaining means allow. The order SHALL
be: the non-overridable safety rules — the authoring-backend refusal for script and hook calls
(`zone.governance-plane`), the authored-script confinement of every `execute` path (`script.authored-only`), the
reply-only refusal (`tool.reply-only`), the bare-`eval` block (`tool.eval`), the read-only mount write
block (`zone.read-only`), the runtime-internal area block (`zone.runtime-internal`), the offload-area
write block (`zone.runtime-managed`), and the disabled-skill block (`skill.not-allowed`,
`skill.forbidden`) — then the workflow-wide denials (`tool.forbidden`), then the active state's
denials (`tool.forbidden-here`), then the consumer's
`policyRules`, then the always-open session access rules (`tool.scratchpad`, `tool.offload-read`), and
last the per-state allow default (`tool.allowed`, `tool.not-allowed`, `tool.unresolved-variable`).

Every declared denial therefore precedes every grant and every consumer rule: **deny beats allow, and
no narrower level widens a denial.**

#### Scenario: Safety rules cannot be loosened

- **WHEN** a call matches a safety rule and also a permitting rule — a consumer rule, the scratchpad
  rule, an `allow_always` entry or a state `tools.allow` entry
- **THEN** the safety rule's block wins, because it is evaluated first

#### Scenario: A declared denial cannot be loosened either

- **WHEN** a call matches `tools.forbid_always` or the active state's `tools.forbid` and also a
  permitting rule — a consumer rule, the scratchpad rule, an `allow_always` entry or the state's own
  `tools.allow`
- **THEN** the denial wins, because both denial stages are evaluated ahead of every grant

### Requirement: Hook scripts and authored scripts run apart

Hook scripts SHALL live at `workflows/<slug>/hooks/<file>.js|.mjs`, declared workflow-relative
(`{ script: hooks/check.js }`): the schema SHALL reject a path outside `hooks/`, with a `..` segment,
or absolute, and the runtime SHALL resolve the declared path with the same confinement, an
unresolvable hook erroring and therefore vetoing fail-closed. Hook sources SHALL be read through the
authoring backend.

`archmax_run` SHALL execute only an **authored script**, confined by the non-overridable safety rule
`script.authored-only`. An authored script is a file inside a bundle of the resolved skill
registry — classified through the registry's prefixes, not a literal `skills/` — or a file under the
authoring prefix (`workflows/`) that is none of a workflow's own files: not under any workflow's
`hooks/` (every hook script lives there, so the agent never runs a hook, its own workflow's or
another's), and not a workflow's `workflow.yaml`, `WORKFLOW.md` or anything under its `tests/`
(the files the runtime governs and grades a session with, which are not scripts). The rule SHALL
compare those names case-insensitively and ignoring trailing dots and spaces, so no spelling a
filesystem resolves to a hook or a governance file escapes it, and SHALL refuse a path holding a `\`,
which backends disagree on. Every other path SHALL be refused: a session path (`scratchpad/`, the rest
of the run root, the runtime's own areas), a mount other than a skill bundle's (data, remote and host
mounts alike), and a path escaping the root, because the agent could have written any of these during
the session.

The model's scripts SHALL be read through the agent workspace, except a source under the authoring
prefix, which SHALL be read — after canonicalizing the path exactly as the kernel classified it —
from the authoring backend and never from the session, where the agent can write a file of the same
name. A path under the authoring prefix SHALL count as authored for `archmax_run` alone: any other
tool declaring an `execute` path resolves that path in the session, so for it only a skill bundle's
file is authored. A state entry MAY narrow which authored scripts run and SHALL NOT extend the set.
`archmax_eval` SHALL be unaffected by this rule.

#### Scenario: Hook runs from its workflow directory

- **WHEN** a state declares `before: { script: hooks/check-requester.js }`
- **THEN** the runtime reads `workflows/<slug>/hooks/check-requester.js` from the authoring backend and runs it

#### Scenario: A workflow's authored script runs

- **WHEN** the model calls `archmax_run` on `workflows/order-lookup/scripts/tally.js` in a state that enables no skill
- **THEN** the runtime reads the file from the authoring backend and runs it

#### Scenario: Agent cannot run a hook or a scratchpad file

- **WHEN** the model calls `archmax_run` on `workflows/order-lookup/hooks/check-requester.js` or on `scratchpad/x.js`
- **THEN** the call is blocked with `script.authored-only` and the file is never read

#### Scenario: No other hook and no other spelling runs either

- **WHEN** the model calls `archmax_run` on another workflow's hook, or on `workflows/order-lookup/HOOKS/check-requester.js`
- **THEN** the call is blocked with `script.authored-only`

#### Scenario: Agent cannot run another session file or a mount

- **WHEN** the model calls `archmax_run` on `notes/x.js` or on a path under a data mount
- **THEN** the call is blocked with `script.authored-only` and the file is never read

#### Scenario: A file the agent wrote at a workflows/ path never runs

- **WHEN** the agent writes `workflows/order-lookup/scripts/own.js` into its session and calls `archmax_run` on that path
- **THEN** the source is read from the authoring backend, which has no such file, and the session's file is never executed

#### Scenario: A spec or a case is not a script

- **WHEN** the model calls `archmax_run` on `workflows/order-lookup/workflow.yaml` or a file under its `tests/`
- **THEN** the call is blocked with `script.authored-only`

### Requirement: Validation decides through the same kernel

`archmax validate` SHALL probe each state's `tools.allow` through `decide` with the same mount prefixes
and skill registry the runtime uses, and SHALL report as errors: a write entry into a runtime-owned
area or a read-only mount, an entry a `forbid_always` or `forbid` list denies, an entry naming
`task` (not grantable), an `archmax_run`
entry, in `tools.allow` or `tools.allow_always`, naming no authored script (a session or mount path,
hook scripts, a workflow's spec or cases), a path entry that can only match inside a bundle the state
does not enable, an entry of any other tool whose `file_path` glob resolves under `workflows/`, a hook `script`
outside `hooks/` or missing from it, and a hook script importing anything but `@archmax-ai/harness/*`. It SHALL
warn on an `archmax_advance` target with no declared edge. A rule that validates as permitted SHALL NOT
be blocked at runtime for the same inputs.

#### Scenario: Policy contradiction

- **WHEN** a state allows `write_file` on a path the workflow's `tools.forbid_always` denies
- **THEN** `validate` reports the contradiction as an error

#### Scenario: A task grant is an error

- **WHEN** a state's `tools.allow` or the workflow's `tools.allow_always` names `task`
- **THEN** `validate` reports an error, and the kernel blocks the call at runtime regardless

#### Scenario: A former prefix is judged like any path

- **WHEN** a state declares an allow entry whose `file_path` glob resolves under `subagents/`
- **THEN** `validate` reports no authoring-plane error for it

#### Scenario: A workflow's scripts are a valid run grant

- **WHEN** a state allows `{ tool: archmax_run, paths: ["workflows/<slug>/scripts/**"] }`
- **THEN** `validate` reports neither an inert entry nor an authoring-backend error for it

#### Scenario: A run grant naming hooks is inert

- **WHEN** a state allows `{ tool: archmax_run, paths: ["workflows/<slug>/hooks/**"] }`
- **THEN** `validate` reports an error that the entry names lifecycle hook scripts and grants nothing

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
skill denial refuses every access; `script.authored-only` confines `execute` to authored scripts; and the authoring-plane
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
