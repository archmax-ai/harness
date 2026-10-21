## MODIFIED Requirements

### Requirement: Two sandbox tools, one REPL session per scope

The runtime SHALL expose `archmax_eval`, which evaluates inline code supplied by the model, and
`archmax_run`, which executes an authored script file — read through the agent workspace, or for a
workflow's script through the authoring backend. Both SHALL
evaluate in the same REPL session for a session scope — keyed by the executing session, with a
child session's scope nested beneath its parent's — under the same contract and the same PTC
surface, so the only difference is where the source came from. REPL state and `console.*` output
SHALL persist across calls in one scope, and disposing a session SHALL release its scope and
every child scope beneath it.

#### Scenario: Inline code evaluated

- **WHEN** the agent calls `archmax_eval` with a snippet
- **THEN** the runtime evaluates it in the sandbox and returns the last expression value, with
  captured console output

#### Scenario: State shared between the two tools

- **WHEN** an `archmax_run` file defines a helper and a later `archmax_eval` call in the same scope
  references it
- **THEN** the helper is in scope, because both ran in the same REPL session

#### Scenario: A tool named bare `eval` is refused

- **WHEN** a tool named `eval` is called by the model or a script
- **THEN** the call is blocked by a non-overridable safety rule naming `archmax_eval` instead

## ADDED Requirements

### Requirement: `archmax_run` executes authored scripts only

`archmax_run` SHALL execute only an authored script: a file inside a skill of the assembly's
resolved skill registry, read through the agent workspace, or a file under `workflows/` that is not
under any workflow's `hooks/` and is not a workflow's `workflow.yaml`, `WORKFLOW.md` or `tests/`
content, read through the authoring backend. Any other path SHALL be blocked by the non-overridable
`script.authored-only` rule ahead of the declared denials, consumer and per-state rules: a hook
script, a workflow's spec or case, a session path such as `scratchpad/x.js`, a mount other than a
skill bundle's, and a path escaping the root. A script in a skill the state does not enable SHALL be
refused by `skill.not-allowed`; a workflow's script belongs to no skill, so no skill grant gates it.
Both sandbox tools are default tools: granted in every state of a workflow that does not declare
`tools.allow_always`, and otherwise only where `tools.allow_always` or a state's `tools.allow` names
them. An entry on `archmax_run` SHALL narrow which authored scripts it may execute (or grant it
where the workflow-wide grant omits it), and an entry naming no authored script SHALL be inert and
reported by validation.

#### Scenario: Non-authored source blocked

- **WHEN** the agent calls `archmax_run` on `scratchpad/x.js`, a data mount's file, or `workflows/<slug>/hooks/check.js`
- **THEN** the call is blocked with rule `script.authored-only`, whatever the state declares

#### Scenario: A workflow's script runs without a skill

- **WHEN** a workflow with the default tools and no skills block calls `archmax_run` on `workflows/<slug>/scripts/tally.js`
- **THEN** the script runs, reading `args.variables` like any other `archmax_run` script

#### Scenario: Restricted script path

- **WHEN** a state allows `{ tool: archmax_run, paths: ["skills/order-data/scripts/lookup.js"] }`
- **THEN** only that script may run in that state, and other skill scripts and every workflow script are blocked

#### Scenario: A workflow that omits the sandbox tools

- **WHEN** a workflow declares `tools.allow_always: [read_file, ls]` and the model calls `archmax_eval` in a state that does not name it
- **THEN** `archmax_eval` is not disclosed and the call is blocked with `tool.not-allowed`, while the state's `before` and `after` script hooks still run in the sandbox

## REMOVED Requirements

### Requirement: `archmax_run` executes skill-bundle sources only

**Reason**: Replaced by "`archmax_run` executes authored scripts only": a workflow's own authored
scripts on the authoring backend run too, while hooks, specs, cases, session files and mounts stay
refused under the rule's new id `script.authored-only`.

**Migration**: None for a workflow: every script that ran before still runs. An `archmax_run` entry
that was inert (`paths: ["**"]`) now reaches every authored script, so narrow it if a state should
run fewer.
