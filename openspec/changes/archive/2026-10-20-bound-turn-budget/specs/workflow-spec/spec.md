## MODIFIED Requirements

### Requirement: Root keys

The spec root SHALL accept exactly: `title` (string, a human label — the workflow's identity
is its directory slug), `instructions` (non-empty string of standing guidance rendered into
the system prompt for the whole session), `disabled` (boolean), `runtime`, `budget`,
`settings`, `tools` (`allow_always`, `forbid_always`), `skills` (`allow_always`, `forbid_always`),
`mounts` (`allow_always`, `forbid_always`), `tests`, `extensions`,
`metadata`, and `states` — a mapping of state slug to state, which SHALL be present and
non-empty. A spec with no `instructions` SHALL load with a lint warning that the workflow
ships no standing guidance. There SHALL be no root `triggers`: a trigger is declared on the
state it enters.

#### Scenario: Empty states rejected

- **WHEN** a spec declares no `states`, or `states: {}`
- **THEN** loading fails with "Machine spec is missing or has empty 'states'"

#### Scenario: metadata is a recognized root key, rubrics and triggers are not

- **WHEN** a spec declares `metadata:` at the root
- **THEN** it is accepted, and a misspelling (`metadatas:`) is a load error naming the key and its
  path

- **WHEN** a spec declares `rubrics:` or `triggers:` at the root
- **THEN** loading fails naming the unrecognized key: a rubric is declared on the hook that applies
  it and a trigger on the state it enters, neither as a first-order item

#### Scenario: The root governance blocks accept their own keys and no others

- **WHEN** a spec declares `tools: { allow_always: [...], forbid_always: [...] }`,
  `skills: { allow_always: [...], forbid_always: [...] }` and
  `mounts: { allow_always: [...], forbid_always: [...] }`
- **THEN** each loads under the strict schema, while a state-level key at the root
  (`tools: { allow: [...] }`, `skills: { forbid: [...] }`, `mounts: { allow: [...] }`) is a load
  error naming the key and its path

#### Scenario: The retired governance spellings are load errors

- **WHEN** a spec declares a root `policy:` block, or a root `skills: { allow: [...] }`
- **THEN** loading fails naming the unrecognized key and its path, as every retired spelling in this
  schema does — denial is declared beside the grant it overrides (`tools.forbid_always`,
  `skills.forbid_always`), and there is one skills model rather than a ceiling and a grant

#### Scenario: A root budget is a recognized root key

- **WHEN** a spec declares `budget: { maxModelCalls: 80 }` at the root
- **THEN** it is accepted, and a state-only budget key at the root (`budget: { maxTurns: 8 }`) is a load error naming the key and its path

### Requirement: Budgets

A state's `budget` SHALL accept `maxTurns`, `timeoutMs` and `maxParks`, each a positive
integer when present and unbounded when absent. `maxTurns` counts the state's model turns,
`timeoutMs` bounds a model call in the state, `maxParks` counts the state's `archmax_wait`
parks; exhausting any of them fails the state, which routes through `on_error` when declared
and otherwise rejects the session. The root `budget` SHALL accept only `maxModelCalls`, a
positive integer bounding the model calls of one turn across every state, `50` when absent.

#### Scenario: Non-positive budget rejected

- **WHEN** a state declares `budget: { maxParks: 0 }` or a non-integer value
- **THEN** loading fails with "must be a positive number" addressed to that field

#### Scenario: Non-positive root budget rejected

- **WHEN** a spec declares `budget: { maxModelCalls: 0 }` at the root
- **THEN** loading fails with "must be a positive number" addressed to that field
