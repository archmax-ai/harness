# Diagnostics

Load this when `archmax validate` or `archmax test` reports something the message alone
does not fix. Every diagnostic names the file and the field. Fix errors first, then
every warning you can.

## `archmax validate`

| The diagnostic says | Fix |
| --- | --- |
| `Unrecognized key: "<k>"`, or `Unsupported runtime contract 'archmax-harness@1'` (or `@2`) | A typo, or a removed key or contract: [Removed keys](workflow-schema.md#removed-keys) says what replaces it (`maxTurns`, root `budget`, `before`/`after` hooks, root `name`/`policy`, …). `metadata` is the one free slot. |
| `transitions.<i>.description`: must be a non-empty string: it is the only thing the agent is told about this edge … | Add the condition under which the transition is taken. Say *when* (`The refund is over $50`), not *where*. Every transition needs one, whatever the state's type. |
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
| allows `archmax_run` on a path outside every skill bundle (`script.skill-only`) | `archmax_run` runs only skill-bundle scripts. A check the graph runs is a code state, its script in the workflow's `scripts/`. |
| allows `archmax_run` on `skills/<x>/…`, which the state does not enable | Add `x` to the state's `skills.allow` (or `allow_always`), or drop the entry. |
| names skill `<x>`, which no source provides; a mount the host does not mount | Fix the name, or create the bundle (`skills/<x>/SKILL.md`) or ask the host for the mount. |
| declares no root `skills` block (warning) | Write `skills: { allow_always: [] }` when every bundle is state-specific. |
| `tools.forbid_always` denies `archmax_advance` | Remove it: no state could move. |
| not a skill slug (a path or a glob) | Use the bundle's directory name; narrow paths with a `tools.allow` entry. |
| `${{…}}` is not a valid variable reference | Write `${{name}}` or `${{name.path}}`. |
| guards `<tool>` on `${{x}}`, but no state requires `x` (warning) | Add `x` to an earlier state's or the trigger's `requires`, or seed it. |
| an allow entry on a path in `scratchpad/` (warning) | Drop it, or govern a path outside the reserved zones. |
| `tools.allow_always` grants none of the default tools (warning) | A declared list replaces them: list the ones the workflow needs, or remove the key. |
| allows `<tool>` and forbids it in the same state, or allows what `tools.forbid_always` denies | Drop one: a denial beats every grant. |
| a state forbids what nothing enables, repeats `allow_always`, or declares `allow: []` (warnings) | Drop the redundant entry. `forbid` is what subtracts. |
| a state declares the workflow's own `model` (warning) | Drop it, or name a different id. |
| no top-level `instructions` (warning) | Add the rules that hold for the whole session. |
| a state has several transitions but no `instructions` (warning) | Say how the agent decides which transition to take. |
| `maxConcurrency` above 1 | Set it to 1, or remove it. |
| `WORKFLOW.md` has frontmatter | Strip it: the machine is `workflow.yaml`. |
| case: missing or too long `title` or `description`, unknown key, assertion before an action, an `expect:` block, malformed regex, unknown trigger, missing `from:` file | Fix the field it names. Assertions are steps; regexes are `"/pattern/flags"` strings. |
| allows `<tool>` on `workflows/…`, which names the authoring plane | No state reaches `workflows/**`. Move text the agent needs into a skill bundle and session files under `scratchpad/`. Nothing checks an `instructions` or `evidence` path into it: that fails at run time. |
| `archmax_workflow_<slug>` names a workflow with no spec or no `manual` trigger, a cycle, or a chain past the depth bound (3) | Fix the slug, give the child a `manual` trigger, or flatten the chain. |

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
| `exceeded its time budget (timeoutMs: N)` | An agent model call or a grader's run: raise the state's `budget.timeoutMs`, or narrow what it must read. |
| `Promise timed out — execution interrupted`, in a code state | `settings.timeoutMs` (default 15000) bounds the whole script, every tool and sub-workflow call it awaits included. Raise it, or move the slow work into an agent state. |
| `cannot advance from '<s>' to '<t>'`, or `cannot leave '<s>' yet: '<v>' …` | The target is not one of the state's transitions, or its `requires` are unmet. Fix the target, or set the variable first. |
| `archmax_advance rejected: this state has decided` | A script or grader decided twice. Only the first advance or raise counts. |
| a tool refused, or `tools.<x>` is `undefined`, in a code state | Grant it on the code state itself (`tools.allow`, `skills.allow`, `mounts.allow`). |
| the session `failed` with `recursion-limit` (`GraphRecursionError`) | The turn passed LangGraph's `recursionLimit` (400 unless the host sets one): states cycle within one turn, automated states advancing to each other or an agent looping. Add a way out, or count rounds on the trail and give up. |

## `archmax test`

A missed structural assertion reports the later steps `not-executed`; fix the first miss.

| The verdict says | Fix |
| --- | --- |
| `timed out after Nms (tests.caseTimeoutMs)` | Raise `tests.caseTimeoutMs`, or find the loop the session is stuck in. |
| `grading model unavailable: declare 'tests: { judge: ... }'` | Add `tests: { judge: {} }` to `workflow.yaml`. |
| `Cannot seed "<p>": it resolves to the '<zone>' zone` | A case's `workspace` writes session paths only: a root file or `scratchpad/…`. |
| `declares N tool mock(s), but the target agent cannot intercept …` | `runTests` with your own target: wire `createToolMockMiddleware()` into its `middleware`. |
