# @archmax-ai/harness skill

An [Agent Skill](https://skills.sh) that teaches a coding agent (Claude Code,
Cursor, Codex, …) how to **build with** the
[`@archmax-ai/harness`](https://www.npmjs.com/package/@archmax-ai/harness) runtime:

1. **Author a workflow** — a `workflow.yaml` state machine plus its skills,
   grading rubrics, scripts, lifecycle hooks, tool governance, and cases.
2. **Wire the runtime into a backend** — assemble an agent with
   `createAgent`, run a workflow, resume human-in-the-loop states, and
   stream lifecycle events / run artifacts so a frontend can visualize run state.

## Install

**From the installed `@archmax-ai/harness` package (primary for runtime consumers)** —
the skill ships inside the npm package, so it always matches the installed SDK
version instead of a synced copy:

```ts
import { BUNDLED_AUTHORING_SKILL_DIR } from "@archmax-ai/harness";
// <BUNDLED_AUTHORING_SKILL_DIR>/archmax-harness/SKILL.md (+ references/) — the constant
// is the dist/authoring-skill directory holding archmax-harness/. Point an install CLI at
// the skill itself:
// npx skills add ./node_modules/@archmax-ai/harness/dist/authoring-skill/archmax-harness
```

**Via the skills CLI from a checkout (coding-agent / development use)**:

```bash
npx skills add <owner>/<repo>            # once this repo is public, from its root
# or point at the subfolder directly:
npx skills add ./skills/archmax-harness
```

Replace `<owner>/<repo>` with this repository's GitHub slug. Skills appear on
skills.sh automatically via install telemetry — there is no separate submission
step.

## What's inside

| File | Purpose |
| --- | --- |
| `SKILL.md` | The entry point, loaded when the skill triggers: procedure, workspace layout, CLI, and a table saying which short reference to load for which task |
| `references/workflow-yaml.md` | Short: every `workflow.yaml` key as an annotated skeleton, machine rules, governance |
| `references/hooks-and-scripts.md` | Short: the hook-script and `archmax_run` contracts |
| `references/cases.md` | Short: the case grammar (keys, actions, assertions, mocking rule) |
| `references/diagnostics.md` | Short: every `validate` diagnostic → its fix; removed keys |
| `references/wiring.md` | Short: `createAgent`, human states, events, artifacts |
| `references/workflow-schema.md` | Exhaustive `workflow.yaml` field reference + annotated example |
| `references/hook-and-test-scripts.md` | Full lifecycle hook-script + cases contracts with worked code examples |
| `references/backend-integration.md` | Full `createAgent` / events / run-artifact integration reference |

The skill is **self-contained** — no external docs are required to use it. It
targets **runtime contract version `"2"`**.

## Naming note

This **authoring skill** is distinct from a workspace's **skill bundles** —
`skills/<slug>/` directories holding a `SKILL.md`, the capability's `assets/`
and its `archmax_run` `scripts/`, enabled per workflow and per state by slug.
They share the Agent Skills file format and nothing else: this skill is a
playbook for *building* such workspaces and wiring the runtime, which is why
it ships under `dist/authoring-skill/` rather than beside any workspace's
`skills/`.

## Safety

Instruction-only: this skill bundles **no executable scripts**. It directs the
agent to run the runtime's own `archmax validate` / `archmax test` CLI commands to
verify authored workflows.

## License

MIT (same as the `@archmax-ai/harness` package).
