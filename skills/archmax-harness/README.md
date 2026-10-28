# @archmax-ai/harness skill

An [Agent Skill](https://skills.sh) that teaches a coding agent (Claude Code,
Cursor, Codex, …) how to **build with** the
[`@archmax-ai/harness`](https://www.npmjs.com/package/@archmax-ai/harness) runtime:

1. **Author a workflow** — a `workflow.yaml` state machine plus its skills,
   grader and code states, scripts, tool governance, and cases.
2. **Wire the runtime into a backend** — assemble an agent with
   `createAgent`, run a workflow, resume human-in-the-loop states, and
   stream the event stream / session artifacts so a frontend can visualize session state.

## Install

**Via the skills CLI (primary)** — from the public GitHub repository:

```bash
npx skills add archmax-ai/harness
```

Add `-g` to install globally, or `-a <agent>` to target a specific coding agent.

**From the installed `@archmax-ai/harness` package** — the skill ships inside the
npm package, so this copy always matches the installed SDK version. After
`npm install`:

```bash
npx skills add ./node_modules/@archmax-ai/harness
```

`npx skills experimental_sync` picks it up too, along with any other skill in
`node_modules`. The package ships this directory as `skills/archmax-harness/`
(for installers) and as `dist/authoring-skill/archmax-harness/` (for
`BUNDLED_AUTHORING_SKILL_DIR`).

For skills middleware, the package exports `BUNDLED_AUTHORING_SKILL_DIR`: the
`dist/authoring-skill` directory, with the skill at `archmax-harness/SKILL.md` beneath it.

**From a checkout of this repository**: `npx skills add ./skills/archmax-harness`.

Skills appear on skills.sh automatically via install telemetry — there is no
separate submission step.

## What's inside

| File | Purpose |
| --- | --- |
| `SKILL.md` | The entry point, loaded when the skill triggers: the procedure, the workspace layout, the CLI, and which reference to load for which task |
| `references/workflow-schema.md` | Every `workflow.yaml` key as a skeleton that validates, the machine's rules, and governance |
| `references/code-states-and-scripts.md` | Grader and code states at run time, the code-state script contract, and `archmax_run` scripts |
| `references/cases.md` | The case grammar: keys, actions, assertions, mocks, and seeding from a real session |
| `references/diagnostics.md` | Each `validate` diagnostic, failed-session reason and `archmax test` verdict, with its fix |
| `references/backend-integration.md` | `createAgent`, outcomes and parked sessions, events, storage, artifacts, and `runTests` |

Each reference owns one topic, so none repeats another. Two workspaces in the repository
show the result: `examples/refund/` (the minimal SDK example) and
`examples/customer-support/` (the full CLI reference workspace).

The skill is **self-contained** — no external docs are required to use it. It
targets **runtime contract version `"3"`**.

## Naming note

This **authoring skill** is distinct from a workspace's **skill bundles** —
`skills/<slug>/` directories holding a `SKILL.md`, the bundle's `assets/`
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
