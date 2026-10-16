## Why

A host tool is handed the turn's workspace in `ToolContext`, but not the id of the session the call
is made in. Inside a sub-workflow's dispatch the workspace is already the child's: `sessionBinder`
scopes the session zone to the child, so `read_file`, `ls` and `context.workspace` all resolve in the
child's folder. The id behind that binding sits in `SessionZoneRouter.boundSessionId()`, which no
host can reach.

A host that keeps session files in its own store needs the id to address them. The platform does,
for three things `BackendProtocolV2` cannot do: a ranged read that enforces its size limit without
downloading an oversized file, a recursive listing (`pack_files`), and a presigned URL. With no other
id at hand it keyed them by the session it sent the turn to, which in a child names the parent's
folder. In production a child unpacked a `.docx` into 41 files that landed in the parent's folder.
The child's `read_file`, `ls`, `glob`, `copy_file` and `move_file` found none of them, while the
platform's own `get_markdown` still did, and the agent spent its recursion limit of 400 looking.

This is request 11 of the platform's handoff (`docs/sdk-handoff.md` in the platform repository).

## What Changes

- **`ToolContext.sessionId`.** The id of the session the call is made in: inside a dispatch, the
  child's own id (`<parent>~<n>`), never the session the host sent the turn to. It is bound in
  `sessionBinder`, beside `workspace`, so it holds for a model's tool call and for a script's call
  through the PTC gateway alike, in the governed and the plain composition. Outside a turn, reading
  it throws, as reading `workspace` does, and the property is non-enumerable there.
- **The store address is a contract.** A session's agent-visible files are stored under
  `<sessionId>/` in the session store, beneath a backend store's `prefix`. That is the address
  `SessionZoneRouter` already builds; it is now documented as one a host may rely on.
- **The sub-workflow documentation says whose files a child's host tool touches:** the child's. A
  host keys a session's files by `ToolContext.sessionId`, never by the session it sent the turn to.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `assembly`: a host tool's `ToolContext` carries `sessionId` beside `workspace`.
- `workspace-and-sessions`: a session's files are stored under `<sessionId>/` in the session store,
  as a contract a host may address directly.
- `delegation`: a host tool's file work inside a child belongs to the child.

## Impact

- **Code:** `src/core/tool-context.ts` (the field), `src/assembly/compose.ts` (`sessionBinder` binds
  it), `src/workflow/agent-tools.ts` (the out-of-turn context throws for it too).
- **Public API:** `ToolContext.sessionId` is new and optional to read, so no host breaks.
- **Docs:** `reference/public-api.md` (host tools; session storage), `guides/sub-workflows.md`,
  `reference/changelog.md`, `README.md`.
- **Authoring skill:** `references/backend-integration.md` (host tools; custom backends; the child
  session paragraph).
- **Release:** additive. It could ship alone as 0.5.1; it ships here beside
  `child-session-dispatch-numbers` and `mount-write-needs-own-grant` in 0.6.0.
