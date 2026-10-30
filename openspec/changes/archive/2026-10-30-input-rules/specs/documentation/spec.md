## MODIFIED Requirements

### Requirement: The glossary is the vocabulary law

The site SHALL carry a glossary (`reference/glossary.md`) naming one term per concept — session,
turn, state, human state, **automated state**, **grader state**, **code state**, case, grade,
mount, zone, authoring backend, park, decide/reply/deliver, runtime note, trail, **history**, state
flow, **rule**, archmax harness/runtime/kernel/Deep Agents — and every page, README section, skill file, CLI
message and identifier SHALL use those terms. A page that uses a different word for one of those
concepts is a defect. "Subagent" SHALL NOT be one of the terms: what grades a session's work is a
grader state, and what runs a delegated process is a sub-workflow. The glossary SHALL carry no
entry for hook, verdict, grading rubric or iteration budget. It SHALL keep **trail** (the
checkpointed audit trail) distinct from **history** (the full transcript and trail that
`archmax_get_history` returns to a grader and to a code state's script alike). It SHALL define
**rule** as a constraint a signature entry declares on its value beyond its type (a format, a
pattern, a length, a range, a set of values), never "validator", "constraint" or "check" for the
same concept.

#### Scenario: A page uses the glossary term

- **WHEN** a page refers to the durable conversation a workflow runs in
- **THEN** it says "session", not "run" or "thread"

#### Scenario: The grader is named consistently

- **WHEN** a page refers to the state that grades a session's work before the session moves on
- **THEN** it says "grader state" (and "grader" for what that state runs), never "grading rubric",
  "hook" or "judge"

#### Scenario: Automated states are named consistently

- **WHEN** a page refers to grader and code states together, or to a deterministic check a
  workflow runs between two states
- **THEN** it says "automated state" for the pair and "code state" for the check, never "hook",
  "gate" or "guard"

#### Scenario: History and trail stay distinct

- **WHEN** a page refers to what `archmax_get_history` returns
- **THEN** it says "history", and it uses "trail" only for the checkpointed audit trail the
  history contains

#### Scenario: The software is named consistently

- **WHEN** a page refers to the package as a whole
- **THEN** it says "archmax harness" (or "the harness" once the full name is established), never
  "the framework" or "the platform"

#### Scenario: The parts of the software are named consistently

- **WHEN** a page refers to what executes a session or decides whether a tool call or a
  transition is allowed
- **THEN** it says "the runtime" or "the kernel", not "the harness"

#### Scenario: A signature's rules are named consistently

- **WHEN** a page refers to `format`, `pattern`, `maxLength` or `minimum` on a signature entry
- **THEN** it calls each a "rule", not a "validator" or a "constraint"
