## Why

The platform (`archmax-ai/pangea`) registers its own `copy_file`, `move_file` and `remove_file` as
host tools, and they sit outside the SDK on both counts that matter:

- **Routing.** A host tool's handler receives only its input, so the platform rebuilt mount routing
  by hand. The copy has drifted from the table it hands the SDK: a path under a mount missing from it
  falls through to the session zone, so `copy_file x tmp/y` writes a durable session file
  `read_file tmp/y` cannot see, and a copy into the design agent's read-only `skills/` succeeds.
- **Governance.** Every kernel path rule is keyed on a fixed set of tool names and one argument
  (`file_path ?? path`), and `paths:` guards only `file_path`. No rule binds a host tool: a state not
  given a governed mount can still read it through `get_markdown` and copy it out, a state narrowed to
  `access: read` can still be written, a disabled skill is readable, and
  `forbid: [{ tool: "*", paths: [secrets/**] }]` does not stop `copy_file secrets/key.pem …`.

The agent itself has no way to copy, move or delete a file at all: a copy is a `read_file` (500
lines, into the conversation) and a `write_file`, and a binary file cannot be copied.

This change is requests 1–3 of the platform's handoff (7 October 2026): one routing table and one set
of rules, the SDK's.

## What Changes

- **Request 1 — path arguments are declared per tool.** One table names each tool's path arguments
  and how a call uses each (`read`, `list`, `search`, `write`, `remove`, `execute`). Every path rule
  (the zones, the mount and skill rules, the inherited denials, the scratchpad, `script.skill-only`,
  the authoring-plane rule) reads it and evaluates every declared path; a call is refused when any one
  is, naming the argument. `remove` is refused wherever `write` is. `paths:` guards every declared
  path argument: a grant needs all to match, a denial any. Hosts declare their tools' paths with
  `toolPaths` or a descriptor's `paths`; declaring a built-in's throws `ToolPathsError`. The built-ins
  keep their verdicts, including the second spelling they accept (`path` for `file_path`).
- **Request 2 — a host tool gets the turn's workspace.** A `toolsFromMap` handler receives a
  `ToolContext` whose `workspace` is the composite `read_file` resolves through, bound to the session,
  in governed and plain agents. `mountSubtree`, the session zone and the workspace router forward
  `downloadFiles`, `uploadFiles` and `delete`; a read-only mount refuses an upload and a delete as it
  refuses a write, naming the path as the agent wrote it.
- **Request 3 — `copy_file`, `move_file`, `remove_file` become SDK tools,** always on in every agent,
  implemented on the workspace and declared in the table. Byte-exact for any format; an existing
  destination is refused unless `overwrite: true`; a move writes before it removes and refuses a
  read-only source before writing; same-file, missing, folder and symlink sources are refused. A host
  tool may no longer take one of those names (`ReservedToolNameError`).
- **BREAKING (for hosts):** a host tool named `copy_file`, `move_file` or `remove_file` fails
  assembly; a `toolsFromMap` handler is called with a second argument; `{ tool: ls|glob|grep, paths }`
  now guards `path` (it matched no call before).
- **Token cost:** three more always-disclosed schemas, about 2,250 characters per model call.

Requests 4 and 5 of the handoff (child sessions) are separate changes.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `governance`: the always-on list gains the file operations; `paths:` guards every declared path
  argument; path zones, session areas and the mount/skill rules read declared paths with their
  access; new requirement "Tools declare their path arguments".
- `workspace-and-sessions`: read-only mounts refuse uploads and deletes; new requirements "The
  workspace carries raw bytes and deletion" and "File operations".
- `assembly`: assembly refuses a host tool shadowing a file operation and a bad path declaration;
  `toolPaths` joins the extension options; new requirement "A host tool is handed the turn's
  workspace".

## Impact

- **Code:** `src/machine/tool-paths.ts` (new: the table, aliases, `resolveToolPaths`,
  `ToolPathsError`); `src/machine/tool-names.ts` (the three names, `RUNTIME_FILE_TOOLS`, the
  reserved-name check); `src/machine/allow.ts` (`paths:` marker, `pathGuardMatches`);
  `src/machine/machine.ts` (the table, `checkAllowed`, rendering); `src/kernel/kernel.ts` (every path
  rule over declared paths); `src/validate/validate.ts`, `src/machine/lint-spec.ts` (declared
  mutations); `src/core/path-mapping.ts`, `src/core/session-zone.ts`, `src/core/workspace-router.ts`
  (transfer and delete); `src/core/file-operations.ts` (new); `src/core/tool-context.ts` (new);
  `src/workflow/agent-tools.ts` (descriptor `paths`, handler context); `src/assembly/*` (`toolPaths`,
  context binding, tool registration); `src/index.ts`, `src/public/spec.ts` (exports).
- **docs/:** `guides/workflow-machine.md`, `reference/machine-spec.md`, `reference/public-api.md`
  (host tools, stores, reserved names, exports), `guides/code-interpreter.md`,
  `guides/token-efficiency.md`, `reference/changelog.md`.
- **skills/archmax-harness/:** `references/workflow-yaml.md`, `references/workflow-schema.md`,
  `references/hook-and-test-scripts.md`, `references/backend-integration.md`.
- **README.md:** no change; it names neither the file tools nor host tool wiring.
- **Release:** `0.4.0` (`release:minor`), with `child-skips-title-and-input-reads` and
  `missing-returns-come-back-with-a-note`.
