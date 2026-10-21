## MODIFIED Requirements

### Requirement: archmax validate checks the document and what surrounds it

Static validation SHALL make no model calls: `validateWorkflow({ rootDir?, workflow?,
skills? })` and `archmax validate [workflow] [--root <dir>] [--json]` return diagnostics —
`severity` `error` or `warning`, a message, and where known a `file` and dotted `field` — with
`valid` false when any error is present. Beyond the schema and lint (reported in the loader's
words), validation SHALL check: the workflow slug shape; the runtime contract; every state
slug; each hook's referent — a `script` that resolves inside `hooks/`, exists on the authoring
backend and imports only from `@archmax-ai/harness/*`, a custom kind listed under `extensions.hooks`
(a `rubric` has no referent to check: the grader is the hook's own value); every skills list against the
registry; kernel probes of `tools.allow` and `tools.allow_always` entries the runtime would refuse (a write
into a runtime-owned or offload area, the read-only authored zone, a path or tool a `forbid_always` or
`forbid` list denies, an entry naming `task`, an `archmax_run` path naming no authored script — a session or mount path, hook
scripts, a workflow's spec or cases — in `tools.allow` or `tools.allow_always`, a path of any other tool that names the authoring
backend, a path inside a bundle the state does not enable), each an error; sibling workflows
named by `archmax_workflow_<slug>` entries (missing or unusable spec, no `manual` entry, a
non-slug target, a cycle, a chain past the dispatcher's depth bound — errors; a disabled
target — warning); and each `tests/*.test.yaml` case (schema errors, a `trigger` id no start
state declares, a `from:` fixture missing or escaping `tests/`). It SHALL inspect no grader directory and report no unloadable-grader advisory,
because a grader either resolves in the document or the spec does not load. The CLI SHALL print
diagnostics to stderr, the verdict line (or, with `--json`, `{ workflow, valid, diagnostics }`)
to stdout, and exit 0 when valid, 1 when not, 2 on a usage error; with no workflow argument it
SHALL validate the workspace's only workflow and refuse when there are several or none.

#### Scenario: Missing hook script

- **WHEN** a state declares `{ script: hooks/x.js }` and `workflows/<slug>/hooks/x.js` does
  not exist
- **THEN** `validate` reports an error naming the state, phase and resolved path

#### Scenario: No grader directory is consulted

- **WHEN** `validate` runs against any workspace
- **THEN** it reads no grader definition file and reports no diagnostic about one being absent,
  unparseable or skipped at runtime

#### Scenario: Inert run grant

- **WHEN** a state allows `{ tool: archmax_run, paths: ["scratchpad/**"] }`
- **THEN** `validate` reports an error that `archmax_run` runs only authored scripts
  (`script.authored-only`), so the entry grants nothing

#### Scenario: Delegation chain checked across siblings

- **WHEN** `a` allows `archmax_workflow_b` and `b` allows `archmax_workflow_a`, or a target
  declares no `manual` entry
- **THEN** `validate` reports an error naming the chain, or the missing `manual` entry, from
  the same sibling-workflow walk

#### Scenario: Case trigger unknown

- **WHEN** a case declares `trigger: { id: does_not_exist }`
- **THEN** `validate` reports an error listing the triggers the workflow declares; a `deliver`
  step's trigger id is not cross-checked, since a park awaits no declared id
