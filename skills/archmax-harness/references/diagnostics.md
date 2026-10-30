# Diagnostics

Load this when `archmax validate` or `archmax test` reports something the message alone
does not fix. Every diagnostic names the file and the field. Fix errors first, then
every warning you can.

## `archmax validate`

| The diagnostic says | Fix |
| --- | --- |
| `Unrecognized key: "<k>"` | A typo, or a removed key: see [Removed keys](workflow-schema.md#removed-keys). `metadata` is the one free slot. |
| `Unrecognized key: "maxTurns"` at `states.<s>.budget` | Delete it. LangGraph's `recursionLimit` bounds a turn; a state's `budget` takes `timeoutMs` and `maxParks`. |
| `Unrecognized key: "budget"` at the root | Delete it: the `recursionLimit` bounds a turn. |
| `Unrecognized key: "before"` or `"after"` on a state, `"extensions"` at the root | Rewrite each check as a state: a `before` check as a code state in front of the state, an `after` check as a code state behind it, a rubric as a grader state behind it. Count rounds on the trail instead of `max_iterations`. Move `hooks/*.js` to `scripts/` and rewrite them to the code-state contract. |
| `Unrecognized key` for root `name`, `description`, `policy` | `title`, `instructions`, `tools.forbid_always`. A root `skills.allow` becomes `skills.allow_always` plus the state lists. |
| `transitions.<i>.description`: must be a non-empty string here: … | Add the condition under which the transition is taken. Say *when* (`The refund is over $50`), not *where*. The message says why this edge needs one: it is one of several, it leaves a human, grader or code state, it hands the session to one, it loops back, or its state has no `instructions`. Only an agent state's lone edge into another agent state may go without. |
| `transitions.<i>.description`: must be a string | A number or a list where the description goes: quote it, or remove it from a lone edge between agent states. |
| workflow slug or state key not kebab-case, or empty | Rename it, and update every `to`, `on_error` and `reachedState`. |
| transitions to, or `on_error` routes to, an undefined state | Fix the slug, or add the state. |
| no start state, or several states declare one trigger | Exactly one state declares each trigger id under `triggers:`. |
| trigger declares an unknown key (warning) | The runtime reads `session`, `message`, `connection`, `description`, `requires` and `returns`; it keeps other keys for the host. |
| code state declares no `script`, or `script` on another type | Add `script: scripts/<x>.js` to the code state; elsewhere, declare `type: code` or drop the key. |
| `script` must be a workflow-relative path inside `scripts/` ending in .js or .mjs | Write `scripts/<x>.js`: no `hooks/`, no `skills/…`, no `..`. |
| code state `<s>` script not found, or imports from `<x>` | Create the file in the workflow's `scripts/`, and import only from `@archmax-ai/harness/*`. |
| Code state declares `instructions` / `model` / `budget` / `evidence` / `approvers` | Drop it: a code state makes no model call and cannot park. Say what the script does in its JSDoc header and `summary`. |
| Grader state must declare `instructions` / at least one transition | Write its criteria, and give it a transition onward and one back to the state it grades. |
| Grader state declares `evidence` / `approvers` / `budget.maxParks` | Drop it: a grader presents nothing to a person and cannot park. |
| `<type>` state is never offered `write_todos` / `archmax_eval` / `archmax_run` / `archmax_wait` / `archmax_reset` | Drop the entry from the state's `tools.allow`. The same tools in `allow_always` are left out of that state without an error. |
| Human state must declare instructions or transitions; a transition to itself; two transitions of one type | Add them; point the transition at the state that does the further work; map each labelled type to one target. |
| `'*'` is not a tool name a grant may use | Move the wildcard into `forbid` or `forbid_always`. |
| allows `task` | Delete the entry: grade with a grader state, delegate with `archmax_workflow_<slug>`. |
| allows `archmax_run` on `skills/<x>/…`, which the state does not enable | Add `x` to the state's `skills.allow` (or `allow_always`), or drop the entry. |
| `tools.forbid_always` denies `archmax_advance` | Remove it: no state could move. |
| not a skill slug (a path or a glob) | Use the bundle's directory name; narrow paths with a `tools.allow` entry. |
| `${{…}}` is not a valid variable reference | Write `${{name}}` or `${{name.path}}`. |
| guards on `${{x}}`, but nothing guarantees it (warning) | Add `x` to an earlier state's or the trigger's `requires`, or seed it. |
| an allow entry on a path in `scratchpad/` (warning) | Drop it, or govern a path outside the reserved zones. |
| `tools.allow_always` grants none of the default tools (warning) | A declared list replaces them: list the ones the workflow needs, or remove the key. |
| a state both allows and forbids, forbids what nothing enables, repeats `allow_always`, or declares `allow: []` (warnings) | Drop the redundant entry. `forbid` is what subtracts. |
| a state declares the workflow's own `model` (warning) | Drop it, or name a different id. |
| no top-level `instructions` (warning) | Add the rules that hold for the whole session. |
| a state has several transitions but no `instructions` (warning) | Say how the agent decides which transition to take. |
| `maxConcurrency` above 1 | Set it to 1, or remove it. |
| `WORKFLOW.md` has frontmatter | Strip it: the machine is `workflow.yaml`. |
| `Unsupported runtime contract 'archmax-harness@1'` (or `@2`) | Rewrite any hooks as states (above), then set `version: "3"` or drop the `runtime` block. |
| case: missing or too long `title` or `description`, unknown key, assertion before an action, an `expect:` block, malformed regex, unknown trigger, missing `from:` file | Fix the field it names. Assertions are steps; regexes are `"/pattern/flags"` strings. |
| the agent cannot read `workflows/**` (an `instructions`, `evidence` or case `workspace` path) | Move the text into a skill bundle, or the path under `scratchpad/`. |

## A failed session

The CLI's state flow, on stderr, shows an automated state's run: `› code scripts/<x>.js`
with each `console.log` line beneath it, `› grader grading`, and `✖ code failed <reason>`
or `✖ grader failed <reason>`. With `--verbose`, or `onEvent` in a host, the events are
`code-start`, `code-output`, `code-result`, `grader-start` and `grader-result`. A failure
then shows as `state-error-routed` (its `on_error`) or as a rejected session.

| The reason says | Fix |
| --- | --- |
| `code state '<s>' finished without calling archmax_advance or archmax_raise` | Every path through a non-terminal state's script must advance or raise; a return value does nothing. |
| `grader state '<s>' finished without calling archmax_advance or archmax_raise` | The grader answered in text. Say in its `instructions` exactly when to take each transition, and when to raise. |
| `exceeded its time budget (timeoutMs: N)` | Raise the state's `budget.timeoutMs`, or narrow what it must read. |
| `cannot advance from '<s>' to '<t>'`, or `cannot leave '<s>' yet: '<v>' …` | The target is not one of the state's transitions, or its `requires` are unmet. Fix the target, or set the variable first. |
| `archmax_advance rejected: this state has decided` | A script or grader decided twice. Only the first advance or raise counts. |
| a tool refused, or `tools.<x>` is `undefined`, in a code state | Grant it on the code state itself (`tools.allow`, `skills.allow`, `mounts.allow`). |
| the session `failed` with `recursion-limit` (`GraphRecursionError`) | The turn passed LangGraph's `recursionLimit` (400 unless the host sets one): states cycle within one turn, automated states advancing to each other or an agent looping. Add a way out, or count rounds on the trail and give up. |
