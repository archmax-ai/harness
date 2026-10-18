## MODIFIED Requirements

### Requirement: A file value names a file the session may read

Where a `file` value crosses a boundary, the runtime SHALL refuse it unless it names a file (not
a folder) in that session's workspace that the session may read on runtime authority: the zone
rules, the workflow's mount grants on workflow scope (a governed mount no grant of the workflow
names is out of reach), and every workflow-wide denial, its own and inherited ones. The refusal names the variable,
`file` and the cause. The boundaries are the turn boundary, `archmax_set_variables` for a typed
return, the completion check, and a delegation call.

#### Scenario: A host seed naming no file is refused

- **WHEN** a session starts on `requires: [{ name: invoice, type: file }]` seeded with
  `scratchpad/attachments/invoice.pdf` and the session holds no such file
- **THEN** no model call is made and the session is refused naming `invoice`, `file` and that
  nothing is at that path

#### Scenario: A return written before its file is refused at the write

- **WHEN** the current turn's trigger declares `returns: [{ name: report, type: file }]` and the
  agent calls `archmax_set_variables({ variables: { report: "scratchpad/report.pdf" } })`
  before writing that file
- **THEN** the call is refused as a correctable tool refusal naming `report` and `file`, nothing
  is written, and the same call succeeds once the file exists

#### Scenario: A return whose file is gone at completion

- **WHEN** `report` was set while the file existed, the agent removes the file, and the session
  finishes in a terminal state
- **THEN** the session is rejected naming the terminal state, `report` and `file`

#### Scenario: A folder is not a file

- **WHEN** a `file` value names `scratchpad/attachments`, which is a folder in the session
- **THEN** it is refused at whichever boundary it crosses

#### Scenario: An authored file is a file value

- **WHEN** a session starts on `requires: [{ name: template, type: file }]` seeded with
  `skills/billing/assets/template.pdf`, a file the workspace mounts
- **THEN** the session starts and `template` reads that path

#### Scenario: A denied path is refused

- **WHEN** the workflow declares `mounts: { forbid_always: [reference] }` and a `file` value names
  `reference/salaries.pdf`, or a value names `checkpoints/cp-1.json`
- **THEN** it is refused naming the variable, `file` and the rule that denies the read, at
  whichever boundary it crosses

#### Scenario: A path under a mount the workflow grants nowhere is refused

- **WHEN** the table governs `invoices` because another workflow in the tree grants it, the
  session's workflow grants it in no state, and a `file` value names `invoices/a.xml`
- **THEN** it is refused naming the variable, `file` and `mount.not-allowed`, at whichever boundary
  it crosses
