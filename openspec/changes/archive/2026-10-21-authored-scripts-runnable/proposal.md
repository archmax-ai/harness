## Why

`archmax_run` executes only scripts inside a skill bundle. The non-overridable safety rule
`script.skill-only` refuses every other path, so a script that belongs to one workflow (a tally, a
formatter, a fan-out over that workflow's own data) has to be packaged as a skill bundle, enabled by
slug, and advertised in the prompt of every state that enables it, even though no other workflow
will ever use it. The archmax automation platform, which authors workflows for its users, asked for
workflow scripts to be runnable where they are written, beside the workflow (archmax-ai/pangea#137).

The rule exists for two safety properties, and both can be kept without the skill-bundle confinement:
the agent must never run the hook that vets its own transition, and it must never run code it wrote
itself during the session. Neither depends on the script living in a skill bundle. Both depend on the
script being **authored**: written by the workflow's author, on the authoring backend or in a skill
bundle, and never a hook, a session file or a mount.

## What Changes

- **`archmax_run` runs any authored script.** An authored script is a file inside a skill bundle of
  the resolved registry, as today, or a file under `workflows/` that is none of a workflow's own files:
  not under any workflow's `hooks/`, and not a `workflow.yaml`, `WORKFLOW.md` or anything under a
  workflow's `tests/`. The conventional home for a workflow's scripts is `workflows/<slug>/scripts/`,
  and nothing enforces the name.
- **What stays refused**, whatever a state grants:
  - every lifecycle hook script, the governed workflow's and every other workflow's, in any spelling a
    filesystem resolves to one (`HOOKS/`, `hooks./`), and any path holding a `\`;
  - a workflow's spec, prose addendum and cases, which the runtime governs and grades a session with
    and which are not scripts;
  - every session path (`scratchpad/`, the rest of the run root, the runtime's own areas), every mount
    other than a skill bundle's (data, remote and host mounts alike), and a path escaping the root.
- **A workflow's script is read from the authoring backend**, never from the session. The agent
  workspace has no route to `workflows/`, so the same path there is a session file the agent can
  write; `archmax_run` reads the canonical path from the authoring backend instead. The agent still
  cannot read, list or search the authoring backend.
- **The rule is renamed `script.authored-only`** and stays a non-overridable safety rule, evaluated
  where `script.skill-only` was. A `tools.allow` or `tools.allow_always` entry on `archmax_run` still
  narrows which authored scripts run and cannot widen the set. A broad entry (`paths: ["**"]`) is no
  longer inert: it reaches every authored script.
- **A host tool's `execute` path stays confined to skill bundles.** Only `archmax_run` reads
  `workflows/` from the authoring backend; any other tool resolves that path in the session.
- **`archmax validate`** reports an `archmax_run` entry naming no authored script (a session or mount
  path, hook scripts, a workflow's spec or cases) as inert, in `tools.allow` and now in
  `tools.allow_always` too. An `archmax_run` entry naming a workflow's scripts is valid and no longer
  draws the "names the authoring plane" error, which still applies to every other tool.
- **Not breaking.** Every script that ran before still runs, and every refusal that still applies
  keeps its reason. The rule id changes, and the changelog names it. Released as **0.9.0** (a minor
  release, because the rule widens what runs).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `governance`: the pipeline's script rule is `script.authored-only`; "Two script homes with disjoint
  executors" becomes "Hook scripts and authored scripts run apart", defining an authored script, the
  hook and governance-file exclusions, and the authoring-backend read; validation reports inert
  `archmax_run` entries by the new classification; the path-argument requirement names the new rule.
- `sandbox`: `archmax_run` executes authored scripts only (replacing "executes skill-bundle sources
  only"), and reads a workflow's script through the authoring backend.
- `workflow-spec`: `archmax validate` reports an `archmax_run` path naming no authored script, in
  either list.
- `assembly`: the authoring backend serves `archmax_run` a workflow's authored script; it is still
  never addressable by an agent tool.
- `documentation`: the authoring skill teaches where `archmax_run` scripts may live.

## Impact

- **Code:** `src/kernel/kernel.ts` (`scriptAuthoredOnlyRule`, `unrunnableScript`),
  `src/workflow/paths.ts` (`workflowFileKind`), `src/sandbox/executor.ts` (an `authoring` source for
  `workflows/` paths), `src/assembly/compose.ts` (wires it), `src/validate/validate.ts` (inert
  `archmax_run` patterns, both lists; the plane check skips `archmax_run`).
- **Tests:** `src/core/authoring-plane.test.ts`, `src/kernel/kernel.test.ts`,
  `src/kernel/kernel.pipeline.test.ts`, `src/validate/validate.test.ts`, `src/sandbox/executor.test.ts`,
  `src/workflow/paths.test.ts`, and a behaviour suite in `src/behaviour/sandbox-run.test.ts`.
- **Docs (`docs/`):** `guides/authoring-plane.md` (the two kinds of script, the rule, the examples),
  `guides/code-interpreter.md`, `guides/skills.md`, `guides/workflow-machine.md`,
  `reference/machine-spec.md`, `reference/public-api.md` (`authoring`, `toolPaths`' `execute`),
  `reference/glossary.md`, and a **0.9.0** entry in `reference/changelog.md`.
- **README.md:** the workspace tree shows `workflows/<slug>/scripts/`.
- **Authoring skill (`skills/archmax-harness/`):** `SKILL.md` (placement table and rule),
  `references/workflow-schema.md`, `references/hook-and-test-scripts.md`,
  `references/hooks-and-scripts.md`, `references/workflow-yaml.md`, `references/diagnostics.md` and
  the skill's `README.md`.
- **`AGENTS.md`:** the sandbox paragraph.
- **No public API change.** The platform prompt does not state the rule and is unchanged, as is the
  `archmax_run` tool description ("an authored workspace JavaScript file").
