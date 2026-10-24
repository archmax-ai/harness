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
| `Unrecognized key: "before"` / `"after"` (on a state) or `"extensions"` (at the root) | Hooks are removed — rewrite each as a state: a `before` check → a **code state in front** of the state (the trigger's entry, or the target of the edge into it); an `after` check → a **code state behind** it (the state's transition points at it, and it advances onward or back with the reason); a `rubric:` → a **grader state** behind it with an edge back. `max_iterations` has no successor: count rounds from the trail. Move `workflows/<slug>/hooks/*.js` to `scripts/` and rewrite them to the code-state contract. Delete `extensions` |
| Code state declares no `script` | Add `script: scripts/<x>.js`, file at `workflows/<slug>/scripts/<x>.js` |
| state declares `script`, which only a code state runs | Declare `type: code`, or drop the key |
| `script` must be a workflow-relative path inside `scripts/` ending in .js or .mjs | `scripts/<x>.js` — no `hooks/`, no `skills/…` path, no `..` |
| Code state `<s>` script not found / imports from `<x>` | Create the file under the workflow's `scripts/`; import only from `@archmax-ai/harness/*` |
| Code state declares `instructions` / `model` / `budget` / `evidence` / `approvers` | Drop them: a code state makes no model call and cannot park. Say what the script does in its JSDoc and `summary`; `settings.timeoutMs` bounds it |
| Grader state must declare `instructions` / at least one transition | Write the criteria in `instructions`; give it an edge onward and, to send work back, one to the graded state |
| Grader state declares `evidence` / `approvers` / `budget.maxParks` | Drop them: a grader presents nothing to a person and cannot park |
| `<type>` state is never offered `write_todos` / `archmax_eval` / `archmax_run` / `archmax_wait` / `archmax_reset` | Drop the entry from the state's `tools.allow`: a script calls tools directly, and an automated state cannot park or reset. The same tools in the workflow's `allow_always` are simply not offered there |
| Human state must declare instructions / transitions / description; self-edge; two transitions of one type | Add them; route out of the state; one target per labelled type |
| `'*'` is not a tool name a grant may use | Move the wildcard to `forbid`/`forbid_always` |
| allows `task` — not grantable | Delete the entry; grade with a grader state, delegate with `archmax_workflow_<slug>` |
| allows `archmax_run` on `skills/<x>/…` which the state does not enable | Add `x` to the state's `skills.allow` (or `allow_always`), or drop the entry |
| `forbid_always` denies `archmax_advance` | Remove it |
| not a skill slug (path/glob given) | Use the bundle directory name; narrow paths with a `tools.allow` entry |
| `${{…}}` not a valid variable reference | `${{name}}` or `${{name.path}}`; snake_case names |
| guards on `${{x}}` but no state requires it (warning) | Add `x` to an earlier state's `requires`, or seed it at assembly |
| `allow` or `allow_always` on a path in `scratchpad/` (warning) | Drop it, or govern a non-reserved run path instead |
| `tools.allow_always` is declared but grants none of the default tools (warning) | A declared list replaces the default tools: list the ones the workflow needs (`ls`, `read_file`, `write_file`, … as in the skeleton), or remove the key to grant them all |
| state both allows and forbids / forbids what nothing enables / enables what allow_always already does / `skills: { allow: [] }` reads like a deny (warnings) | Drop the redundant entry; use `forbid` to subtract |
| no top-level `instructions` (warning) | Add the standing block |
| state has several transitions but no `instructions` (warning) | Add routing guidance so the agent classifies the request before it advances |
| `transitions.<i>.description` must be a non-empty string here: '<target>' declares none (error) | The edge is undescribed and its target has no `instructions` to route on. Add the condition under which the edge is taken (say *when*, not *where*), or give the target instructions |
| `transitions.<i>.description` must be a non-empty string on a human state's transition (error) | It is the decision's button label: say what choosing it means |
| `transitions.<i>.description` must be a non-empty string here: '<target>' is a grader / is a code state (error) | An edge into an automated state cannot route on its target: a grader's instructions are its criteria, never shown to the work it judges, and a code state has none. Say when the work is ready for the check (`The reply is drafted`). A code state's own edges may stay undescribed |
| `transitions.<i>.description` must be a string (error) | Quote it, or omit it to route on the target's instructions |
| trigger declares unknown key (warning) | Keys read: `session`, `message`, `connection`, `requires`, `returns`; others are preserved |
| `maxConcurrency` above 1 | Set to 1 or remove |
| `WORKFLOW.md` has frontmatter | Strip it; the machine is `workflow.yaml` |
| `Unsupported runtime contract 'archmax-harness@1'` (or `@2`). Supported: `archmax-harness@3` | Contracts 1 and 2 (the hook contract) are retired: rewrite any hooks as states (above), then set `runtime: { engine: archmax-harness, version: "3" }` or drop the block (omitted resolves to `3`) |
| case: missing/over-long `title`/`description`; unknown key; assertion before action; `expect:` block; malformed regex; unknown trigger; `from:` missing | Fix the field named; assertions are steps; regexes are `"/p/f"` strings |
| `agent cannot read workflows/**` (instructions/evidence/workspace path) | Move the text to a skill bundle or the path to `scratchpad/` |

**Removed keys** you may meet (all load errors; details and migrations in
`references/workflow-schema.md#removed-keys-you-may-meet-in-an-older-workflow`):
`name:`→`title:`; `description:`→`instructions:`; `policy:`→`forbid_always`;
root `skills.allow`→`skills.allow_always`; state `type: wait`→`archmax_wait`;
`type: trigger`→`triggers:` on the entered state; `type: workflow`,
`workflow:`, `params:`, `for_each:`, `result:`→an agent state allowing
`archmax_workflow_<slug>` + `requires`; `parallel:`/`join:`→sequenced states;
transition `on:`→nothing (the resumed state picks its edge); state
`before:`/`after:` (with `{ script }`, `{ rubric }`, `subagent:`, custom kinds,
`max_iterations`/`max_corrections`)→code and grader states; root
`extensions:`→nothing; single-file `WORKFLOW.md` with
frontmatter→`workflow.yaml` + prose.

## Reading a failed run

`archmax test` and `archmax run` report an automated state's run in the state
flow (stderr): `› code scripts/<x>.js` with each `console.log` line beneath it,
`› grader grading`, and `✖ code failed <reason>` / `✖ grader failed <reason>` when
the run failed. The raw events (`--verbose`, or `onEvent` in a host) are
`code-start { state, script }`, `code-output { state, line }`,
`code-result { state, status, durationMs, reason? }`, `grader-start { state }` and
`grader-result { state, status, durationMs, reason? }`; a failure then shows as
`state-error-routed` (its `on_error`) or a rejected session.

| Reason says | Fix |
| --- | --- |
| `code state '<s>' finished without calling archmax_advance or archmax_raise` | Every path through a non-terminal state's script must advance or raise; returning a value does nothing |
| `grader state '<s>' finished without calling …` | The grader answered in text: say in its `instructions` exactly when to take each transition and when to raise |
| `grader state '<s>' exhausted its turn budget (maxTurns: N)` / `exceeded its time budget` | Raise `budget.maxTurns`/`timeoutMs` (reading the history and deciding is two calls), or narrow what it must read |
| `archmax_advance rejected: cannot advance from '<s>' to '<t>'` / `cannot leave '<s>' yet: '<v>' is not set` | The script's `to` is not one of its state's transitions, or its `requires` are unmet — fix the target, or set the variable first |
| `archmax_advance rejected: this state has decided` | A script or grader decided twice; only the first advance or raise counts |
| a tool refused, or `tools.<x>` is `undefined`, inside a code state | Grant it on the **code state itself** (`tools.allow`, `skills.allow`, `mounts.allow`); another state's grant does not reach it |
| `GraphRecursionError` | Two automated states advance to each other forever; add an edge out, or count rounds from `trail` |
