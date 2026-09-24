---
title: The OpenSpec workflow
description: How changes are proposed, designed, implemented, and archived with OpenSpec.
sidebar:
  order: 2
---

Development on @archmax-ai/harness is **spec-driven**. Substantive changes flow
through [OpenSpec](https://github.com/Fission-AI/OpenSpec) artifacts under
`openspec/`, before and during implementation.

## Anatomy of a change

Each active change lives at `openspec/changes/<change-name>/`:

| Artifact | Purpose |
| --- | --- |
| `proposal.md` | Why the change exists, what changes, and its impact |
| `design.md` | Context, goals/non-goals, decisions, risks, migration plan |
| `specs/<capability>/spec.md` | Delta specs: added/modified requirements with scenarios |
| `tasks.md` | The implementation checklist, checked off as work lands |

The main specs under `openspec/specs/` hold the long-lived requirements. A
change's delta specs are synced into them when the change completes.

## Lifecycle

1. **Propose**: describe the change. Generate proposal, design, delta specs,
   and tasks.
2. **Apply**: implement the tasks, checking them off in `tasks.md` as they
   land. Artifacts are updated fluidly if implementation reveals design issues.
3. **Sync**: merge the delta specs into the main specs.
4. **Archive**: move the completed change out of the active set.

The `openspec` CLI drives this, with `openspec list`, `openspec status --change
<name>` and `openspec instructions apply --change <name>`.

For agent-assisted work the repo ships matching slash-command skills:
`/opsx:propose`, `/opsx:apply`, `/opsx:sync` and `/opsx:archive`.

## Conventions

`openspec/config.yaml` sets the schema (`spec-driven`). It also injects project
context and rules into artifact generation. Two rules matter for every
contributor:

- Proposals for user-facing changes must call out the required `docs/` updates
  in their Impact section.
- Task lists for user-facing changes must include an explicit task to update
  the relevant pages under `docs/`, so the site lands with the feature.
