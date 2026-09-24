# `archmax validate` diagnostics → fix

Load this when `validate` or `test` reports something you cannot fix from the
message alone. Migrations for removed keys in full:
[`workflow-schema.md`](workflow-schema.md#removed-keys-you-may-meet-in-an-older-workflow).

## Diagnostics

`validate` output names file and field. The recurring ones:

| Diagnostic says | Fix |
| --- | --- |
| unknown key `<k>` (anywhere) | Misspelling, or a removed key — see the table below; `metadata` is the only free slot |
| `name:` / `description:` at root | Rename to `title:` / `instructions:` (reread the text as direction, delete narration) |
| `policy:` or root `skills.allow:` | Move to `tools.forbid_always` / `skills.allow_always` + state lists |
| Workflow slug / state key not kebab-case, or empty | Rename the directory or key; update every `to`, `on_error`, `reachedState` |
| transitions to / on_error routes to undefined state | Fix the slug or add the state |
| no start state / multiple states declare trigger | Exactly one state per trigger id declares it under `triggers:` |
| hook must be a `{ script }` or `{ rubric }` entry / single-key tagged object | One kind per hook; the only sidecar is `max_iterations`; `specification:` and `subagent:` do not exist |
| hook script must be inside `hooks/` / not found | `before: { script: hooks/<x>.js }`, file at `workflows/<slug>/hooks/<x>.js` |
| `before` declares `max_iterations` | Remove it; before hooks are ok/veto |
| Human state must declare instructions / transitions / description; self-edge; hook can never run; two transitions of one type | Add them; route out of the state; drop the hook; one target per labelled type |
| `'*'` is not a tool name a grant may use | Move the wildcard to `forbid`/`forbid_always` |
| allows `task` — not grantable | Delete the entry; declare a `rubric:` hook instead |
| allows `archmax_run` on `skills/<x>/…` which the state does not enable | Add `x` to the state's `skills.allow` (or `allow_always`), or drop the entry |
| `forbid_always` denies `archmax_advance` | Remove it |
| not a skill slug (path/glob given) | Use the bundle directory name; narrow paths with a `tools.allow` entry |
| `${{…}}` not a valid variable reference | `${{name}}` or `${{name.path}}`; snake_case names |
| guards on `${{x}}` but no state requires it (warning) | Add `x` to an earlier state's `requires`, or seed it at assembly |
| `allow` on a path in `scratchpad/` (warning) | Drop it, or govern a non-reserved run path instead |
| `tools.allow_always` constrains essential tool (warning) | Narrow per state with `tools.allow` |
| state both allows and forbids / forbids what nothing enables / enables what allow_always already does / `skills: { allow: [] }` reads like a deny (warnings) | Drop the redundant entry; use `forbid` to subtract |
| no top-level `instructions` (warning) | Add the standing block |
| state has several transitions but no `instructions` (warning) | Add routing guidance so the agent classifies the request before it advances |
| `transitions.<i>.description` must be a non-empty string (error) | Add the condition under which that edge is taken — it is the only thing the agent knows about it. Say *when*, not *where* |
| trigger declares unknown key (warning) | Keys read: `session`, `message`, `connection`, `requires`, `returns`; others are preserved |
| `maxConcurrency` above 1 | Set to 1 or remove |
| `WORKFLOW.md` has frontmatter | Strip it; the machine is `workflow.yaml` |
| case: missing/over-long `title`/`description`; unknown key; assertion before action; `expect:` block; malformed regex; unknown trigger; `from:` missing | Fix the field named; assertions are steps; regexes are `"/p/f"` strings |
| `agent cannot read workflows/**` (instructions/evidence/workspace path) | Move the text to a skill bundle or the path to `scratchpad/` |

**Removed keys** you may meet (all load errors; details and migrations in
`references/workflow-schema.md#removed-keys-you-may-meet-in-an-older-workflow`):
`name:`→`title:`; `description:`→`instructions:`; `policy:`→`forbid_always`;
root `skills.allow`→`skills.allow_always`; state `type: wait`→`archmax_wait`;
`type: trigger`→`triggers:` on the entered state; `type: workflow`,
`workflow:`, `params:`, `for_each:`, `result:`→an agent state allowing
`archmax_workflow_<slug>` + `requires`; `parallel:`/`join:`→sequenced states;
transition `on:`→nothing (the resumed state picks its edge); `subagent:` hook
→`rubric:`; `max_corrections`→`max_iterations`; single-file `WORKFLOW.md` with
frontmatter→`workflow.yaml` + prose.
