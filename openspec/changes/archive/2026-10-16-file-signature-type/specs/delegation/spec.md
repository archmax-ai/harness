## ADDED Requirements

### Requirement: A child's file space is its own

A child session's workspace SHALL be its own session zone. The child SHALL read and write only
its own `scratchpad/`, never its caller's, and nothing the child writes SHALL appear in the
caller's workspace. The only files that reach a caller SHALL be copies of the child's declared
`file` returns, made by the runtime when the child settles. Every other file the child wrote
stays in the child's session.

#### Scenario: A child's write stays in the child

- **WHEN** a child writes `scratchpad/notes.md` and `scratchpad/out/summary.txt` and completes
- **THEN** both files are in the child's session, and the caller's workspace holds neither

#### Scenario: A child cannot reach its caller's files

- **WHEN** the caller holds `scratchpad/secret.txt` and the child reads `scratchpad/secret.txt`
- **THEN** the child's read resolves against its own session and finds nothing there

#### Scenario: A child cannot overwrite its caller's files

- **WHEN** the caller and its child each write `scratchpad/result.json`
- **THEN** each session holds its own `scratchpad/result.json`, and the caller's is unchanged by
  the child's write

### Requirement: A file argument is copied into the child

Before a child starts, the runtime SHALL copy each `file` argument's exact bytes from the
caller's workspace into the child's `scratchpad/attachments/`, keeping the file name, and seed
the child with the child-side path. Two arguments sharing a file name SHALL be kept apart by the
attachment naming rule (see `workspace-and-sessions`). An argument naming no file SHALL be
refused `invalid-param` before any child runs.

#### Scenario: The child is seeded with its own copy

- **WHEN** the caller holds `scratchpad/inbox/invoice.pdf` and calls
  `archmax_workflow_reconcile({ invoice: "scratchpad/inbox/invoice.pdf" })`
- **THEN** the child's session holds `scratchpad/attachments/invoice.pdf` with identical bytes,
  the child's `invoice` variable reads `scratchpad/attachments/invoice.pdf`, and its `opening`
  note shows that path

#### Scenario: The child's copy is independent

- **WHEN** the child edits or removes `scratchpad/attachments/invoice.pdf`
- **THEN** the caller's `scratchpad/inbox/invoice.pdf` is unchanged

#### Scenario: Two arguments with one file name

- **WHEN** a target declares `requires: [{ name: current, type: file }, { name: previous, type:
  file }]` and the call passes `scratchpad/2026/statement.pdf` and `scratchpad/2025/statement.pdf`
- **THEN** the child is seeded with `current` = `scratchpad/attachments/statement.pdf` and
  `previous` = `scratchpad/attachments/statement-1.pdf`, in declaration order

#### Scenario: An argument naming no file is refused

- **WHEN** the call passes `invoice: "scratchpad/inbox/missing.pdf"` and the caller holds no such
  file
- **THEN** the call is refused as a blocked call with kind `invalid-param` naming `invoice`, `file`
  and the path, and no child session is created

#### Scenario: An authored file is copied like a session file

- **WHEN** the call passes `template: "skills/billing/assets/template.pdf"`, a mounted file the
  calling state may read
- **THEN** the child's session holds `scratchpad/attachments/template.pdf` with identical bytes
  and the child is seeded with that path

#### Scenario: A reference resolves before the copy

- **WHEN** a script calls `tools.archmaxWorkflowReconcile({ invoice: "${{invoice_path}}" })` and
  the caller holds `invoice_path: "scratchpad/inbox/invoice.pdf"`
- **THEN** that file is copied into the child exactly as for a literal path

### Requirement: A file argument is read with the calling state's governance

A `file` argument SHALL be a `read` path argument of its delegation tool, so the kernel rules for
reading a path, and a `paths:` guard on an allow or forbid entry naming that tool, bind it as
they bind any declared path argument. A call the kernel blocks for its path SHALL copy nothing
and start no child.

#### Scenario: A paths guard narrows what may be passed

- **WHEN** a state allows `{ tool: archmax_workflow_reconcile, paths: ["scratchpad/inbox/**"] }`
  and the agent calls it with `invoice: "scratchpad/private/payroll.pdf"`
- **THEN** the call is blocked naming the rule, nothing is copied, and no child runs

### Requirement: A file return is copied back under a name nothing holds

When a child settles, the runtime SHALL copy each `file` return it set from the child's session
into the caller's `scratchpad/attachments/` and hand the caller that path in `returns`. The copy
SHALL take a name nothing in that folder holds, by the attachment naming rule, so a returned file
never overwrites a file of the caller's, one an earlier or concurrent call returned included. A
return that can't be copied SHALL fail the call `invalid-return`.

#### Scenario: A returned file arrives as the caller's own

- **WHEN** a child declaring `returns: [{ name: report, type: file }]` settles with `report` =
  `scratchpad/out/report.pdf`
- **THEN** the caller's session holds `scratchpad/attachments/report.pdf` with identical bytes, the
  call's `returns.report` reads `scratchpad/attachments/report.pdf`, and the child's own file stays
  in the child's session

#### Scenario: A second call does not overwrite the first

- **WHEN** the caller calls the same workflow again and that child also returns a file named
  `report.pdf`
- **THEN** the second copy lands at `scratchpad/attachments/report-1.pdf`, its call answers that
  path, and `scratchpad/attachments/report.pdf` is unchanged

#### Scenario: Concurrent calls take distinct names

- **WHEN** one tool batch, or a script's `Promise.all`, runs three calls whose children each return
  `report.pdf`
- **THEN** the caller ends with `report.pdf`, `report-1.pdf` and `report-2.pdf` in
  `scratchpad/attachments/`, each call's `returns.report` names a different one of them, and each
  holds the bytes its own child returned

#### Scenario: A file the caller already holds is kept

- **WHEN** the caller's agent wrote `scratchpad/attachments/report.pdf` itself before the call
- **THEN** the returned copy lands at `scratchpad/attachments/report-1.pdf` and the agent's file is
  unchanged

#### Scenario: A return whose file is gone fails the call

- **WHEN** a child set `report` while the file existed and then removed it before settling
- **THEN** its own completion check rejects it, the call fails with kind `invalid-return` naming
  `report` and `file`, and nothing is copied

#### Scenario: A child cannot return a file its ancestors denied

- **WHEN** the root workflow declares `skills: { forbid_always: [billing] }` and its child's agent
  sets its `file` return to `skills/billing/assets/salaries.md`
- **THEN** the child's write is refused as naming a path the session may not read, the call
  answers with a `note` naming the unset return, and nothing is copied into the caller; a value
  written by a script or hook instead is rejected by the child's completion check, and the call
  fails with kind `invalid-return`

#### Scenario: A child may return an authored file

- **WHEN** a child sets its `file` return to `skills/billing/assets/template.pdf`, which no
  ancestor denies
- **THEN** the caller receives a copy at `scratchpad/attachments/template.pdf`

#### Scenario: An unset file return copies nothing

- **WHEN** a child declaring `returns: [{ name: report, type: file }, total]` settles with only
  `total` set
- **THEN** the call answers `total` and a `note` naming `report`, and nothing is copied

#### Scenario: A child that parked copies back when it settles

- **WHEN** a child parks at a human state, the parent is decided, and the child then settles with
  a `file` return
- **THEN** the file is copied into the parent's `scratchpad/attachments/` at that settle by the
  same rule, and the `sub-workflow` note appended to the parent's transcript carries the child's
  returns beside its closing message, the parent-side path among them

#### Scenario: A mocked file return is held to the same rule

- **WHEN** a case seeds `scratchpad/fixtures/report.txt` through `workspace:` and mocks the
  dispatch with `returns: { report: "scratchpad/fixtures/report.txt" }`
- **THEN** the call answers `report` = `scratchpad/attachments/report.txt`, a copy of the fixture;
  a mock naming no file fails the call with kind `invalid-return`

### Requirement: The delegation tool says how files cross

When a target's `manual` signature declares a `file` entry, its delegation tool's description
SHALL say that a `file` argument is a path in the caller's workspace that the child receives as
its own copy, and that a `file` return arrives as a copy in the caller's
`scratchpad/attachments/` whose path the result names. A target with no `file` entry SHALL have
its description unchanged.

#### Scenario: The description names the file convention

- **WHEN** the target declares `requires: [{ name: invoice, type: file }]`
- **THEN** the tool's description says the child receives its own copy of the file `invoice`
  names, and the input schema describes `invoice` as `{ type: string, format: file }`

#### Scenario: A target without files reads as before

- **WHEN** the target declares only `string` and `date` entries
- **THEN** the tool's description is byte-identical to what it was before `file` existed

### Requirement: A failed call names the caller's file paths

A failed call SHALL be recorded, and named in its `on_error` route, with each `file` argument as
the caller passed it (references resolved), not as the child-side path the child was seeded with.
Recovering a failure SHALL compare the caller's paths.

#### Scenario: The route names the path the caller passed

- **WHEN** a call passing `invoice: "scratchpad/inbox/invoice.pdf"` fails and the agent finishes
- **THEN** the `on_error` route names the call with `invoice: "scratchpad/inbox/invoice.pdf"`,
  not `scratchpad/attachments/invoice.pdf`
