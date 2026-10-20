## MODIFIED Requirements

### Requirement: `archmax_run` executes skill-bundle sources only

`archmax_run` SHALL execute only sources that resolve inside a skill of the assembly's resolved
skill registry, read through the backend; any other path SHALL be blocked by the non-overridable
`script.skill-only` rule ahead of the declared denials, consumer and per-state rules, and a script in a skill
the state does not enable SHALL be refused by `skill.not-allowed`. Both sandbox tools are
default tools: granted in every state of a workflow that does not declare `tools.allow_always`,
and otherwise only where `tools.allow_always` or a state's `tools.allow` names them. A state's own
`tools.allow` entry on `archmax_run` SHALL narrow which files it may execute there (or grant it
there, when the workflow-wide grant omits it), and an entry naming paths outside `skills/` SHALL be inert and reported by
validation.

#### Scenario: Non-skill source blocked

- **WHEN** the agent calls `archmax_run` on `scratchpad/x.js` or a `workflows/**` path
- **THEN** the call is blocked with rule `script.skill-only`, whatever the state declares

#### Scenario: Restricted script path

- **WHEN** a state allows `{ tool: archmax_run, paths: ["skills/order-data/scripts/lookup.js"] }`
- **THEN** only that script may run in that state and other skill scripts are blocked

#### Scenario: A workflow that omits the sandbox tools

- **WHEN** a workflow declares `tools.allow_always: [read_file, ls]` and the model calls `archmax_eval` in a state that does not name it
- **THEN** `archmax_eval` is not disclosed and the call is blocked with `tool.not-allowed`, while the state's `before` and `after` script hooks still run in the sandbox
