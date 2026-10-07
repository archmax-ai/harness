## MODIFIED Requirements

### Requirement: Read-only is enforced at the mount and diagnosed by the kernel

A mount SHALL be read-only unless declared `{ readOnly: false }`. A read-only mount SHALL itself refuse `write`, `edit` and `delete` with an error naming the path in workspace form (`data/logo.png`, not the route-relative `logo.png`), and SHALL refuse every file of an `uploadFiles` with `permission_denied` without delegating, so authored content cannot be modified even by a caller that bypasses governance; the kernel SHALL additionally block an agent tool call targeting a read-only mount with rule `zone.read-only`, naming `scratchpad/` as the writable alternative. `archmax validate` SHALL report a state `tools.allow` entry that would permit a write or a removal into a read-only mount, for every argument a tool declares as `write` or `remove`. A mount declared writable SHALL be classified as session state — governed by the active state's `tools.allow` — rather than as authored.

#### Scenario: Mount refuses a write independently of governance

- **WHEN** any component writes to a read-only mount's path directly through the workspace backend
- **THEN** the mount returns an error and no file behind it is created or modified

#### Scenario: Mount refuses an upload and a delete independently of governance

- **WHEN** any component uploads bytes to, or deletes, a read-only mount's path directly through the workspace backend
- **THEN** the upload answers `permission_denied` for that path, the delete answers an error naming
  the path as written, and no file behind it is created, modified or removed

#### Scenario: Agent write blocked by the kernel

- **WHEN** the agent calls `write_file` on `skills/refund-request/SKILL.md`
- **THEN** the call is blocked with rule `zone.read-only` and a message pointing at `scratchpad/`

#### Scenario: Writable mount still governed

- **WHEN** a state's `tools.allow` does not permit a path under a writable mount and the agent writes it
- **THEN** the call is blocked by per-state governance, not by the read-only rule

#### Scenario: Validator flags a contradictory allow entry

- **WHEN** a state's `tools.allow` declares a write whose path falls under a read-only mount
- **THEN** `archmax validate` reports the contradiction

## ADDED Requirements

### Requirement: The workspace carries raw bytes and deletion

The workspace backend SHALL carry `downloadFiles`, `uploadFiles` and `delete` end to end, routing each
path as a read or a write is routed — an exact file mount to its backend, any other path through the
composite — with paths canonicalized first and mapped in and out of every prefix (a mount's route, the
session store's tenancy prefix, the bound session id), so no result names a session id or a
store-internal path. A backend with no raw transfer SHALL make `downloadFiles`/`uploadFiles` throw,
and one without deletion SHALL make `delete` answer an error, as Deep Agents' `CompositeBackend`
does. Text-only callers SHALL be unaffected.

#### Scenario: Bytes round-trip through the session zone

- **WHEN** a caller uploads a PNG to `scratchpad/a.png` during a bound session and downloads it
- **THEN** the bytes are equal, the result paths read `/scratchpad/a.png`, and a `delete` removes it

### Requirement: File operations

Every agent, governed or plain, SHALL have three file tools that act on one file without its content
entering the conversation:

- `copy_file({ source, destination, overwrite? })` SHALL write the source's bytes unchanged at the
  destination, text and binary alike, creating the destination's parent folders and leaving the
  source untouched.
- `move_file({ source, destination, overwrite? })` SHALL do the same and then delete the source,
  writing (and verifying) the destination first, so a failure leaves a duplicate rather than a loss.
  A source the workspace serves read-only SHALL be refused before anything is written, governed or not.
- `remove_file({ file_path })` SHALL delete one file.

An existing destination SHALL be refused unless `overwrite: true`, leaving it unchanged. A source and
destination naming the same file after canonicalization SHALL be refused without touching it. A
missing source, a folder, or a path the backend's read refuses (a symlink) SHALL be refused naming the
path, with nothing written; no operation SHALL read or write through a symlink the backend's `read`
or `write` would refuse. A write to a binary-typed path SHALL go through the backend's `write` as
base64, which the backend decodes (Deep Agents' convention), and valid UTF-8 as the text itself;
other bytes SHALL go through `uploadFiles`. Every write SHALL be read back — through
`downloadFiles`, else `readRaw` — and compared with the source's bytes. When the text channel did
not keep them and the backend has `uploadFiles`, the bytes SHALL be uploaded and read back again.
When the destination still does not hold the source's bytes, or the store serving the source can
hand over a non-UTF-8 file only as decoded text, the operation SHALL fail saying so rather than
report success, and a destination it created SHALL be removed again. Every result
SHALL be one line naming the paths in workspace form — `Copied '<source>' to '<destination>'
(<size>).`, `Moved …`, `Removed '<path>'.` — or `Error: …`, and SHALL NOT carry a store's own error
text, which can name host paths or the session id. A host tool SHALL NOT take one of these names.

#### Scenario: A template is copied without being read

- **WHEN** the model copies `skills/data/assets/template.md` (900 lines) to `scratchpad/report.md`
- **THEN** `scratchpad/report.md` holds all 900 lines byte for byte, the tool result is the one
  `Copied …` line, and no line of the file appears in the conversation

#### Scenario: Binary files copy byte for byte

- **WHEN** the model copies a PNG and a `.docx` from a read-only skill bundle into `scratchpad/`
- **THEN** each copy's bytes equal the source's, and the sources are unchanged

#### Scenario: An existing destination needs overwrite

- **WHEN** `scratchpad/out.md` exists and the model copies another file to it, first without and then with `overwrite: true`
- **THEN** the first call is refused and the file is unchanged, and the second replaces it

#### Scenario: A move writes before it removes

- **WHEN** the model moves `scratchpad/a.docx` to `drafts/b.docx`
- **THEN** `drafts/b.docx` holds the bytes and `scratchpad/a.docx` no longer exists

#### Scenario: A move out of a read-only mount writes nothing

- **WHEN** an ungoverned agent calls `move_file` from `skills/data/assets/logo.png` to `scratchpad/logo.png`
- **THEN** the result is an error saying the source is served by a read-only mount, and `scratchpad/logo.png` does not exist

#### Scenario: A store that keeps base64 as given

- **WHEN** the destination's backend stores what `write` hands it unchanged, has no
  `downloadFiles` and no `uploadFiles`, and the model copies a PNG to it
- **THEN** the copy is refused, saying the store did not keep the file's bytes, and the destination
  it created is removed; with `uploadFiles`, the same copy succeeds byte for byte

#### Scenario: A store that cannot hold the bytes

- **WHEN** the session store keeps text-typed files as decoded text and the model copies a `.docx`
  into `scratchpad/`
- **THEN** the result is an error saying the store did not keep the file's bytes, not a success
