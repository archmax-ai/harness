## Context

See proposal.md — Why. Three facts about the code shape the approach:

- The kernel's path rules each tested membership in one of four name sets (`PATH_TOOLS`,
  `WRITE_TOOLS`, `READ_TOOLS`, `SESSION_OPEN_TOOLS`) and read one argument, `file_path ?? path`.
  Deep Agents' `read_file`, `write_file` and `edit_file` really do accept `path` for `file_path`
  (`normalizeFilePathInput`), so that fallback is load-bearing.
- `paths:` is normalized to `args: { file_path }` early, and a dozen consumers (validate, lint,
  disclosure, rendering) read `argMatchers.file_path`.
- Deep Agents' backend protocol has two channels: `readRaw`/`write` (text; a binary-typed path's
  `write` content is base64; both refuse a symlink) and the optional `downloadFiles`/`uploadFiles`
  (raw bytes; both follow a symlink). `readRaw` decodes a text-typed file as UTF-8, and
  `StoreBackend.uploadFiles` stores a text-typed path as decoded text.

## Goals / Non-Goals

**Goals:** one table every path rule reads, for built-ins and host tools; built-in verdicts unchanged;
file operations that are byte-exact or say why not, and never a way around a read's or a write's
refusals; host tools on the same workspace with no second routing table.

**Non-Goals:** folder operations; a size cap (an operation holds one file in memory, as `readRaw`
does); making `StoreBackend` hold non-UTF-8 bytes under a text extension; a `capabilities` flag on
`SessionStore` for transfer and deletion (method presence is the capability, and the tools refuse
in a sentence when it is absent).

## Decisions

### A declared path table, not projections

Each tool maps argument → access. Each path rule walks a call's declared paths (`pathsOf`) and
returns the first refusal; the refusal names the argument when the tool declares several. The access
decides which rules apply: `write`/`remove` for the read-only, runtime-managed and `mount.read-only`
rules; any access for runtime-internal, skill, mount and inherited denials; `execute` for
`script.skill-only`; `read`/`list`/`write`/`remove` (all paths) for `tool.scratchpad`.

*Alternative, tried first and dropped:* decide `copy_file` as a `read_file` of its source plus a
`write_file` of its destination. It reused every rule, but it cannot express `remove` (no built-in
removes), does nothing for host tools, and makes `write_file`'s grants bind a different tool, which no
other tool does (`edit_file` is not bound by a `write_file` guard either).

### Built-in aliases live in the table module

For the seven single-path built-ins, the value of a declared argument is that argument, else its
second spelling — the tool's own precedence. This keeps every existing kernel verdict, including
calls in tests that pass `ls` a `file_path`. Host tools have no aliases.

### `paths:` keeps its normalized form, plus a marker

`normalizeAllowEntry` still stores `paths:` under `file_path` and marks the entry `fromPaths`.
Consumers that only care about single-path tools keep reading `argMatchers.file_path`; the matchers
(`checkAllowed`, forbid rules) and the renderers re-key it to the tool's declared arguments, read
through the aliases. A grant needs every declared path to match (an omitted one matches nothing); a
denial needs any. An unresolvable `${{…}}` grants nothing and denies.

*Alternative:* a separate `paths` field on the normalized entry — cleaner, but every consumer would
change in the same commit for no behavioural gain.

### The tool context is bound with the session

An `AsyncLocalStorage` holding `{ workspace }` is entered in `sessionBinder`, inside the session
zone's own binding, so every turn of every composition (governed, plain, a delegated child) and every
call inside it — a script's bridged call included — sees the same workspace. `toolsFromMap` reads it
per call. Outside a turn the handler still runs and only `context.workspace` throws, so a host
calling a tool directly keeps working.

*Alternative:* thread the backend through LangGraph's `configurable`. It would reach only tools that
read their config, and would put a backend object into a config that tracing serializes.

### File operations: gate on the text channel, carry bytes on the raw one

1. `readRaw` the source: its refusals (missing, a folder, a symlink) are the operation's; a folder
   reported as missing is re-classified from `downloadFiles`' `is_directory`.
2. Take exact bytes: binary content as is; for text, `downloadFiles` of the now-vetted path; without
   transfer, the decoded text — refused if it holds U+FFFD, the mark of lost bytes.
3. Write through `write` when it can carry the bytes (base64 for a binary-typed destination, the text
   when valid UTF-8, BOM kept); otherwise claim the destination with an empty `write` (so a symlink
   or a read-only mount refuses it) and `uploadFiles` the bytes.
4. Read the destination back (`downloadFiles`, else `readRaw`) and compare. When the text channel
   did not keep the bytes — a backend that stores the base64 string as given, as the platform's
   `tree-backend.ts` does today — upload them if the backend can, and compare again. A remaining
   mismatch is an error, not a success, and a destination the operation created is removed.

   *Alternative:* verify only through `downloadFiles`. A backend without it was then reported as
   copied while holding base64 text (platform review, C3).

`move_file` refuses a source the workspace classifies as authored before step 1 — the kernel refuses
it too, but an ungoverned agent has only this — and deletes the source last. `remove_file` gates on
`readRaw` so it never deletes a folder (both stores delete recursively). Every message is written
here, never relayed: `FilesystemBackend` errors carry the host path and the session id.

### Overwrite is opt-in

An existing destination is refused unless `overwrite: true`, as the platform ships it. (Deep Agents'
`write_file` in this version replaces silently; the handoff's premise that it refuses is not true
here, but refusing is the safer default for a tool that can clobber a file it never read.)

### Shadowing is refused

A host tool named like a file operation fails assembly with `ReservedToolNameError` (a second
`reservation` kind). Two tools sharing a name would leave the model calling whichever the framework
kept, and the platform has to drop its own registrations in the same upgrade.

## Risks / Trade-offs

- [`{ tool: ls|glob|grep, paths }` changes meaning — it now guards `path`] → it matched no call
  before, so an entry that "worked" was a denial or grant of nothing; the changelog says so.
- [Multi-path refusals read differently (`(destination)`)] → single-path tools' messages are
  byte-identical, so existing diagnostics and tests are unaffected.
- [A claim-then-fill copy that fails verification leaves an altered or empty destination] → the error
  says the store did not keep the bytes; only non-UTF-8 bytes under a text extension take this path.
- [Three more schemas on every call] → ~2,250 characters; measured in the token guide.
