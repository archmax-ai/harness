## Why

The platform adopted 0.4.0 and found four corrections it needs in one release (its handoff of
7 October 2026, C6–C10). One of them breaks every host whose stores lack an optional method: the
workspace wrappers define `downloadFiles`, `uploadFiles` and `delete` unconditionally and throw where
the store behind a path has none, so Deep Agents' skills loader — which reads every `SKILL.md`
through `downloadFiles` when the backend has one — finds no skill in a plain agent. Reviewing that
turned up a second 0.4.0 regression: because the router now always has `delete`, Deep Agents
registers its own **recursive** `delete` tool, which a plain agent is shown beside `remove_file`.

The other corrections close governance gaps that stop the platform from declaring its granted
tools' file inputs: the always-open scratchpad allowed *any* tool with declared paths in every
state, ahead of the state's grant (C6), and a path argument could not hold a list (C8) — worse, a
`paths:` guard read a list as one comma-joined string, so `attachments/**` admitted
`["attachments/a.txt", "contracts/b.docx"]`.

## What Changes

- **C6 — the scratchpad opens only essential tools.** `tool.scratchpad` and `tool.offload-read`
  apply to a tool every state already permits (the built-in file tools, the file operations, the
  host's `essentialTools`). Any other tool is left to the state's grant, so declaring paths only
  ever narrows.
- **C7 — optional backend methods stay optional.** `downloadFiles` is always present and reads a
  store without the raw channel through `readRaw` (exact bytes, or `permission_denied` for text
  holding U+FFFD). `uploadFiles` is present exactly when the session store has it; a route without
  it refuses that file. `delete` answers an error. Nothing throws for want of support.
- **Deep Agents' `delete` tool is gone.** Deep Agents is handed the workspace without `delete`;
  `remove_file` is the one way to delete a file.
- **C8 — a path argument may hold a list of paths.** Each element is governed with the argument's
  access and tested by `paths:` guards (a grant needs every element, a denial any). A declared
  argument of any other shape is refused (`tool.path-argument`).
- **C9 — the binary type table is exported** from `@archmax-ai/harness/spec` (`BINARY_MIME_TYPES`,
  `binaryMimeTypeOf`), moved into a module without `node:*`.
- **C10 — an out-of-turn `ToolContext` can be compared and serialized:** its throwing `workspace`
  getter is non-enumerable. The changelog's 0.4.0 heading loses "(unreleased)".
- **For hosts:** a host tool that is not essential no longer runs on scratchpad paths in a state
  that does not grant it; a declared path argument holding a non-path value is refused by the
  kernel instead of by the tool's schema.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `governance`: "Session areas" (open areas admit essential tools only); "Tools declare their path
  arguments" (lists of paths, `tool.path-argument`, guards per element).
- `workspace-and-sessions`: "Session areas and their kernel rules" (the same, from the workspace
  side); "The workspace carries raw bytes and deletion" (optional methods degrade; no Deep Agents
  `delete` tool).
- `assembly`: "A host tool is handed the turn's workspace" (conditional `uploadFiles`,
  non-enumerable out-of-turn workspace); "Subpath entry points" (binary types on `/spec`).

## Impact

`src/core/{path-mapping,session-zone,workspace-router,workspace-context,raw-download,binary-types,binary-read,tool-context}.ts`,
`src/assembly/{compose,plain}.ts`, `src/kernel/kernel.ts`, `src/machine/{tool-paths,machine}.ts`,
`src/workflow/agent-tools.ts`, `src/public/spec.ts`; docs (`reference/public-api.md`,
`reference/machine-spec.md`, `guides/workflow-machine.md`, changelog) and the authoring skill
(`references/backend-integration.md`, `references/workflow-schema.md`). Released as 0.4.1.
