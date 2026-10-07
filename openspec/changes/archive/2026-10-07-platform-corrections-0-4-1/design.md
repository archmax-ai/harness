## Context

0.4.0 made the workspace carry `downloadFiles`, `uploadFiles` and `delete` so the file operations and
host tools could move bytes and delete. It did so by defining all three on every wrapper and throwing
(transfer) or erroring (delete) where the store behind a path had none. Deep Agents feature-detects
these methods, so a defined-but-throwing method is worse than an absent one.

## Decisions

**A method is present where it can answer, and never throws for want of support.**

- `downloadFiles` has a faithful fallback, `readRaw`, so it is always present. The fallback must not
  hand over altered bytes: `copy_file` uses `downloadFiles` to get the exact bytes behind text that
  `readRaw` decoded, so re-encoded text holding U+FFFD (where decoding may have replaced bytes) is
  refused with `permission_denied` rather than returned. The protocol's error codes are a closed
  union; `permission_denied` reads as "this store will not hand over these bytes", and every
  consumer treats any code as "not available".
- `uploadFiles` has no faithful fallback, and Deep Agents' history offload chooses between
  `uploadFiles` and `edit` by presence. The workspace therefore has `uploadFiles` exactly when the
  session store (the default route, where Deep Agents writes) has it. A mount without it answers
  that file with `permission_denied`, never a throw for the batch. Rejected: "present when every
  writable store has it" (one mount without uploads would take them from the session zone) and
  "always present, refusing" (breaks the offload's `edit` path).
- `delete` stays always present and answers an error where a store cannot delete — what 0.4.0 and
  `CompositeBackend` already did.

**Deep Agents never sees `delete`.** Its filesystem middleware registers a `delete` tool and hides it
per model call only when the backend has no `delete`. A `Proxy` over the router (`withoutDeletion`)
answers `undefined`/`false` for `delete`, so the tool is neither shown nor able to delete if named;
the file operations, image reads and host tools keep the router itself.

**The scratchpad opens only essential tools.** The open-access rule ran ahead of `stateToolsRule`
for every tool with declared paths. It now applies only to tools `WorkflowMachine.isEssential`
names; every other tool falls through to the state's grant. Its purpose — sparing an always-on tool
a grant it does not need where a state narrows it — is unchanged.

**Lists of paths flatten; malformed values fail closed.** `declaredPathsOf` and `pathValuesOf`
flatten a list into its elements, so every path rule and guard sees each one; an empty list is an
omitted argument. A declared argument holding anything else would hide a path from every rule, so a
new first safety rule, `tool.path-argument`, refuses it. Built-ins are unaffected in practice: their
schemas already require strings.

**The binary table moves to a pure module** (`core/binary-types.ts`, no `node:path`) so the
browser-safe `/spec` subpath can export it; `core/binary-read.ts` re-exports it.

**The out-of-turn workspace getter is non-enumerable** rather than `workspace: undefined`: hosts keep
a non-optional type, and comparison and serialization skip the property.

## Risks

- A host tool that relied on scratchpad access without a grant now needs one (or `essentialTools`).
- A host reading `ToolContext.workspace.downloadFiles` on a store without the raw channel gets
  `permission_denied` for a non-UTF-8 text file instead of a throw.
