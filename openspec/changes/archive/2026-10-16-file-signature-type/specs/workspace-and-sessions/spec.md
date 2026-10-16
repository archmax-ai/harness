## ADDED Requirements

### Requirement: Files handed to a session land in its attachments folder

The runtime SHALL place every file it hands a session in that session's `scratchpad/attachments/`,
under the source's file name: a host's turn file, a copied delegation argument, and a copied
`file` return. The bytes SHALL arrive exactly. A placement the session store can't carry exactly
SHALL fail, naming the path, and write nothing: it is never written as text it is not. This
applies, for example, to a non-text file in a store without raw-byte upload.

#### Scenario: Bytes arrive exactly

- **WHEN** the runtime places a PDF holding non-UTF-8 bytes into a session on the filesystem
  store
- **THEN** downloading `scratchpad/attachments/<name>.pdf` from that session yields the same bytes

#### Scenario: A store that can't carry the bytes refuses the placement

- **WHEN** the session store has no raw-byte upload and the file is not valid UTF-8 text
- **THEN** the placement fails naming the path, and no file is written at it

### Requirement: An attachment takes a name nothing holds

When a placement's name is already taken in `scratchpad/attachments/`, or reserved by a placement
in flight in the same session, the runtime SHALL insert `-1`, `-2`, … before the last extension,
using the lowest free number. A name with no extension, or one whose only dot leads it, takes the
suffix at its end. A placement SHALL never overwrite a file.

#### Scenario: Suffixes count up

- **WHEN** `report.pdf` and `report-1.pdf` are already in `scratchpad/attachments/` and a third
  `report.pdf` is placed
- **THEN** it lands at `scratchpad/attachments/report-2.pdf`

#### Scenario: Names without an extension

- **WHEN** `notes` and `.env` are each placed twice
- **THEN** the second copies land at `notes-1` and `.env-1`

#### Scenario: Only the last extension moves

- **WHEN** `archive.tar.gz` is placed twice
- **THEN** the second copy lands at `archive.tar-1.gz`

#### Scenario: Concurrent placements in one session do not collide

- **WHEN** two placements of `report.pdf` into one session start before either has finished
- **THEN** one lands at `report.pdf` and the other at `report-1.pdf`, and both files are intact

### Requirement: A host can hand a turn files

`TurnInput.files` SHALL map a variable name to `{ name, content }`, where `content` is raw bytes.
Before the turn boundary the runtime SHALL place each file by the attachment rules and seed the
variable, locked, with the placed path, as a `variables` seed would be. A `name` that is not one
plain file name, or a variable also given in `variables`, SHALL be refused before anything is
written.

#### Scenario: A host file satisfies a file input

- **WHEN** a host sends a turn on `requires: [{ name: invoice, type: file }]` with
  `files: { invoice: { name: "invoice.pdf", content } }`
- **THEN** the session holds `scratchpad/attachments/invoice.pdf`, `invoice` is seeded locked with
  that path, and the turn boundary accepts it

#### Scenario: A later turn's file does not overwrite an earlier one

- **WHEN** a second turn of the same session hands another `invoice.pdf`
- **THEN** it lands at `scratchpad/attachments/invoice-1.pdf` and that turn's `invoice` names it

#### Scenario: A name that is not a plain file name is refused

- **WHEN** `files.invoice.name` is `../invoice.pdf`, `a/b.pdf`, `..` or empty
- **THEN** the send is refused naming `invoice` and the name, and nothing is written

#### Scenario: A variable given twice is refused

- **WHEN** a send carries `invoice` in both `files` and `variables`
- **THEN** it is refused naming `invoice`, and nothing is written
