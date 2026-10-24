---
name: archmax-harness
description: >-
  Build with the @archmax-ai/harness runtime for LangChain Deep Agents. Use this
  whenever you are designing, editing or fixing a workflow state machine (a
  workflow.yaml with states, transitions, grader and code states, tool and skill
  governance, scripts, cases, or skill bundles), OR wiring the
  @archmax-ai/harness npm package into a backend service — assembling an agent with
  createAgent, running a workflow, resuming human-in-the-loop states, or
  streaming the event stream / session artifacts so a frontend can visualize a
  run. Trigger this skill for phrases like "design a workflow", "author a
  workflow.yaml", "add a state/transition/check", "archmax validate fails", "run
  an agent workflow from my worker", or "integrate @archmax-ai/harness" even when the
  runtime is not named explicitly.
---

# Building with @archmax-ai/harness

The archmax harness is a thin, governed runtime over
[LangChain Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview):
one Deep Agent per workflow, moved by a declarative state machine
(`workflow.yaml`). It holds no use-case logic — a **workspace** supplies it.
Runtime contract: `runtime: { engine: archmax-harness, version: "3" }` in every spec
(omitted resolves to `3`; `1` and `2` are refused).

**Read by task, not by curiosity.** This file holds the procedure, the
workspace layout and the commands. Load exactly the short reference your next
file needs, once, and nothing else:

| You are about to… | Load |
| --- | --- |
| write or edit `workflow.yaml` | [`references/workflow-yaml.md`](references/workflow-yaml.md) — every key, machine rules, governance |
| write a script — a code state's `workflows/<slug>/scripts/*.js` or a skill's `scripts/*.js` (`archmax_run`) | [`references/code-states-and-scripts.md`](references/code-states-and-scripts.md); sequence the skill case with the *Script playbook* below |
| write or fix a case (`tests/*.test.yaml`) | [`references/cases.md`](references/cases.md) |
| fix what `archmax validate` / `archmax test` reported | [`references/diagnostics.md`](references/diagnostics.md) |
| embed the package in a service | [`references/wiring.md`](references/wiring.md) |

The long references — `workflow-schema.md`, `code-state-and-test-scripts.md`,
`backend-integration.md` — are exhaustive; open a **section** of one only when
the short reference says so or a field's exact semantics are in doubt. Do
**not** read the SDK source, do not `ls`/`glob` a workspace to discover its
layout (it is fixed, below), and do not re-read a file already in context.
Naming note: this authoring skill is not a workspace's `skills/<slug>/` bundle;
they share a file format and nothing else.

---

## Authoring

### Procedure

**Build a workflow.** Design the whole file set first, write each file once,
then verify. Do not write a file, validate, and discover the next file.

1. **Sketch the graph**: states (kebab-case slugs), the start state carrying
   `triggers: { manual: }` (plus any host trigger ids that enter there),
   terminal states (no `transitions`), the edges between them — and for each
   edge, the *condition* under which it is taken. That condition is the edge's
   `description`, which is what the agent knows about where the edge leads. Leave
   an edge undescribed only when the target's `instructions` already say when it
   applies: the agent is then shown them instead (never on a human state's
   transitions, whose description is the button label, and never on an edge
   into a grader, whose instructions are criteria the work is never shown, or
   into a code state, which has none; a code state's own edges may go
   undescribed, since its script routes). **Checks are states too**: sketch
   each deterministic check as a code state and each judgment (tone,
   completeness) as a grader state, with its edges — onward, back to the work
   it checks, and where it gives up (see *Checks are states* below). If something outside the session calls the workflow (another
   workflow, a host's MCP tool or form), give its trigger a
   `description` for the caller and a `requires`/`returns` signature, typing an
   entry (`{ name, type, description }`; `string` `integer` `number` `boolean`
   `date` `date-time` `object` `array` `file`) where the caller must build or read the
   value. The runtime holds typed entries at start, at `archmax_set_variables`
   and at completion ([`references/workflow-schema.md`](references/workflow-schema.md)).
   Decide how the work can **fail**, too: the agent ends a session it cannot
   complete with `archmax_raise({ code, reason })`, always on and only for
   failure (a session that never raises is a success). Where a host branches
   on why, name the codes in the `instructions` of the states that can hit
   them; where a person must always be reached instead, forbid the tool in
   that state.
2. **Decide the file set** from the sketch: `workflow.yaml` always; one
   `scripts/<check>.js` per code state (a grader needs no file: its criteria
   are its `instructions`); cases — one happy path per branch, one per path a
   check declines or sends back, one `decide:` per human state, one `raised:`
   per failure a host branches on; a
   `skills/<capability>/` bundle only for data, an `archmax_run` script, or
   guidance two or more states share identically; `AGENTS.md` only for a
   workspace-wide persona.
3. **Write `workflow.yaml`** from the skeleton in [`references/workflow-yaml.md`](references/workflow-yaml.md),
   keeping its `tools.allow_always` list of the twelve default tools: a declared
   list replaces them, so drop only a tool this workflow must not have. Each state's behaviour
   goes inline in its `instructions`; run-wide rules once in the top-level
   `instructions`; nothing about the machine itself (the platform prompt and
   the disclosed edges already say it, and prose is billed on every call), and
   nothing about the date: every model call opens with the current date and time
   in UTC (rounded down to ten minutes, with the host's zone named), so date
   arithmetic ("due in 30 days") needs no authored `today`.
   Never describe another state in a state's `instructions` or in an edge's
   `description`: the agent is shown the active state's edges and nothing else
   of the graph, so a routing condition parked in the *target's* `summary` or
   `instructions` is invisible to the state that has to route on it. Name
   a model (`settings.model`, or `model:` on one state) only where the work
   differs in kind — a small model on mechanical states, the default on
   drafting, judgement and heavy-routing ones.
4. **Write code-state scripts, grader criteria, cases** — description first (a
   script's JSDoc, a grader's give-up rule, a case's `title` + `description`),
   then the body, and never leave the two disagreeing. Before writing a case, settle what to mock ([`references/cases.md`](references/cases.md)).
5. **Verify**: `archmax validate <slug>` → fix every error (and every warning
   you can) → `archmax test <slug>`. Never call a workflow done without a clean
   `validate`.

**Fix a workflow.** Diagnose from the tool, not by reading everything.

1. Run `archmax validate <slug>` (offline, instant). Every diagnostic names
   the file, the field path and the fix; map it with the
   [`references/diagnostics.md`](references/diagnostics.md).
2. Read **only** the files the diagnostics name. Edit once. Re-validate.
3. When clean, `archmax test <slug> [filter]`. Read the failing case's verdict
   line: a **structural** miss (`reachedState`, `parked`, `raised`,
   `succeeded`, `trail`) is a routing or governance defect — fix the routing state's
   `instructions`, the transition `description`s, or the `tools`/`skills`
   grants; a **content** miss (`reply`, `calledTool`, `grade`) is an
   `instructions` defect in the state that answered; a decline the reply
   quotes, or a send-back the agent keeps failing, is a code or grader state
   speaking — fix what it names (or the check, when it is wrong). Change the
   case only when it asserts something the spec never promised.
4. A `grade` miss is the one non-deterministic assertion: re-run that case
   once before calling it a regression. Re-run with `--verbose` for raw
   events only when the verdict line is not enough.

Budget: one validate, one edit pass, one validate, one test. If you are on
your fourth read of a file, you are guessing — reread the relevant reference
instead.

**Shapes come from tools, not from research.** Before naming any field of a
tool's result or a trigger's payload — in `instructions`, a `${{…}}` guard, a
code-state script — ask the host: a platform embedding this runtime typically exposes
describe-style tools (a tool's input and output schema, a trigger's payload
schema and sample) and a way to sample or invoke once with a narrow input. Call
those first; fall back to a recorded session's variables (`archmax sessions <id>`)
only when no such tool exists. Reading more files never reveals what a live
system returns.

### Script playbook (a skill's `scripts/<x>.js`)

Deterministic work the model triggers with `archmax_run`. In order:

1. **Shapes first.** Trigger payload and tool I/O from the host's describe/sample
   tools; the variables a run actually carries from `archmax sessions <id>`.
   Guessing a field name here costs a whole run (above).
2. **Write it.** `skills/<cap>/scripts/<x>.js`: JSDoc, then the body. Input is the
   global `args` — `args.<param>` from the model plus `args.variables`, a read-only
   snapshot — and the **last expression** is the result. Contract:
   [`references/code-states-and-scripts.md`](references/code-states-and-scripts.md).
3. **Land the result in a variable.** Return structured data, and name the variable
   in the calling state's `requires:`. A script may not call
   `archmax_set_variables`, so `requires` is what makes the model record the return;
   unrecorded, the result lives in one tool message and is gone.
4. **Announce it in the skill.** The `SKILL.md` `description` says *when* to run it;
   the body says the script's path, its arguments, and the variable its result
   lands in. A script nothing points at is never reached.
5. **Grant it.** The calling state allows `{ tool: archmax_run, paths:
   ["skills/<cap>/scripts/**"] }` plus every tool the script itself calls. Then
   `archmax validate`.

### Reference a variable, never retype it

`${{name}}` / `${{a.b.-1.c}}` resolves against the run's variables in a
`tools.allow` glob **and inside any text argument the model writes** — mid-string,
repeatable, matched literally. The transcript keeps the reference and only the tool
sees the value, so a stored value costs its tokens once instead of on every later
model call. Step 3 is what puts a value there to reference.

A state that must emit something already stored is told to interpolate it:

```yaml
instructions: >-
  Send the reply with gmail__send. Quote the customer's message by writing
  ${{inbound.text}} in the body rather than retyping it.
```

Exact — a retyped copy truncates and drifts, a reference cannot — and it agrees by
construction with a guard on the same variable. Not available in scripts, which
read `args.variables` (a code state's script: `variables`); a grader's own tool
arguments get it like the agent's. To write the characters literally: `$${{name}}`.

### Checks are states (grader and code states)

A check is a state on the graph, never a slot inside one. A `type: code` state
runs `script: scripts/<x>.js` and a `type: grader` state runs an isolated grader
whose criteria are its `instructions`; both run on entry with **no call of the
agent's model**, are offered only **their own state's** tools (grant there what
the check reads; never `write_todos`, `archmax_eval`, `archmax_run`, `archmax_wait`
or `archmax_reset`, even when `tools.allow_always` lists them), and leave like every state:
`archmax_advance({ to, reason })` — the `reason` is the note the next state
reads — or `archmax_raise({ code, reason })`. Finishing without either fails
closed through `on_error`, so give every automated state an `on_error`. Both
read the **whole session** the same way, with `archmax_get_history` →
`{ messages, trail }` (a script: `JSON.parse(await tools.archmax_get_history())`);
a tool result is inline in its tool message's `text`. Every edge into one needs
a `description`. Put a grader on work the agent hands on (a report, a record),
not on a live answer: everything the agent says in a turn is that turn's reply,
a draft sent back included. Contract:
[`references/code-states-and-scripts.md`](references/code-states-and-scripts.md).

| Want | Shape |
| --- | --- |
| A deterministic check **in front of** a state | The trigger's entry (or the edge's target) is a code state that advances to the work, or to a state that declines it |
| A check **behind** a state | The state's edge points at a code state with an edge onward and one **back**; a send-back's `reason` names the fix |
| **Approve, then end** | Approve into a **terminal code state**: its script records the result and the session completes, no model call; the session's next message opens at its trigger's entry state |
| Judgment with a bounded loop | A grader behind the graded state, edges onward and back; its `instructions` say "raise after N send-backs", counted as trail steps `{ kind: grader, to: <graded state> }` |

The checked state's `instructions` say that advancing into the check is what
hands the work in, and to fix the work when a note sends it back. There is
no `before:`/`after:`, no `rubric:`, no `max_iterations`: a leftover key fails to
load.

### Workspace layout (complete — nothing else exists)

```
<workspace root>/
  AGENTS.md                          # optional persona; prompt layer 1
  workflows/<slug>/                  # AUTHORING PLANE — runtime reads it, the agent CANNOT
    workflow.yaml                    #   the machine (required, canonical)
    WORKFLOW.md                      #   optional plain-markdown addendum, NO frontmatter
    scripts/<check>.js               #   code-state scripts (`type: code`), run by the runtime
    tests/<case>.test.yaml           #   one case per file; fixtures beside them (`from:`)
  skills/<capability>/               # AGENT PLANE — mounted read-only, enabled per state by slug
    SKILL.md                         #   frontmatter (name = directory slug, description) + body
    scripts/<script>.js              #   archmax_run sources, run by the agent
    assets/<file>                    #   read-only inputs
    references/<topic>.md            #   optional deeper material
  .env                               # ARCHMAX_* model config (never mounted)
  sessions/<sessionId>/              # the run; the agent's workspace ROOT (never authored)
    scratchpad/                      #   agent-visible `scratchpad/…`: the session's always-writable
                                     #   area (a host-wired writable mount is another place to write)
    large_tool_results/ conversation_history/   # runtime offload, agent reads only
    checkpoints/ artifacts/          #   runtime-internal
```

Rules that follow:

- **The agent cannot read `workflows/**`** — its spec, code-state scripts,
  grader criteria and cases have no route in its workspace. Never point `instructions`,
  `evidence` or a case `workspace:` at one (`validate` errors). Text the agent
  needs goes in a skill bundle.
- **Placement**: a code-state script is the check, a runtime script is the
  tool; they never share a file. Both directories are named `scripts/`, on
  different planes.

  | Script | Runs on | Lives at | Wired as |
  | --- | --- | --- | --- |
  | Code-state script | the runtime, when its `type: code` state is entered; governed by **that state's** grants | `workflows/<slug>/scripts/<x>.js` | `type: code` + `script: scripts/<x>.js` (workflow-relative, confined to `scripts/`) |
  | Runtime script | the model's authority, via `archmax_run` | `skills/<cap>/scripts/<x>.js` | enabling the skill; narrow with `{ tool: archmax_run, paths: ["skills/<cap>/scripts/**"] }` |

  `archmax_run` is confined to skill bundles by a non-overridable rule
  (`script.skill-only`): a script in `scratchpad/` or `workflows/` is unrunnable.
- **Paths have no leading slash** (`skills/order-data/assets/orders.json`,
  `scratchpad/refund.json`); never author a `run/` prefix. `scratchpad/` is
  writable in every state that is granted `write_file`, whatever its entry
  narrows, so an allow entry inside it narrows nothing (warning); to govern *where* a result lands, name
  a non-reserved run path (`reports/*.json`) and allow it.
- **Guidance has three homes, one per rule**: every workflow → `AGENTS.md`;
  the whole run → top-level `instructions` (`|-` literal block, since `>-`
  folds paragraphs together); one state's turn → that state's `instructions`
  (`>-` is fine). Pasting a paragraph into a second state means hoist it.
  Never one `skills/<state>/` per state.
- **Every `.js` you author opens with a JSDoc block**: title line, blank
  line, then what it reads, the sequence of checks, and where it sends the
  session in each case (code state: each `archmax_advance` target and why, each
  raise) or what it computes and returns (`archmax_run` script). Admin UIs show this
  instead of the code. No `@specification` tag, no sidecar key.

### Verify (CLI)

```bash
archmax validate [workflow] [--json]            # offline; run after every structural edit
archmax test [workflow] [filter] [--json]       # cases; filter = case-id substring
archmax run <workflow> "<prompt>" [--session <id>] [--trigger <id>] [--variables '<json>'] [--file <var>=<path>]...
archmax sessions [session] [--json]             # list, or one session's variables (value + locked)
archmax decide <session> --to <state> [--comment "…"]   # resume a human state
archmax reply <session> "<message>"             # message a parked run; it stays parked
archmax deliver <session> --trigger <id> [--variables '<json>']   # resume an archmax_wait
```

`<workflow>` may be omitted when the workspace has one. Global `--root <dir>`
(cwd default; `.env` loads from it), `--verbose` for raw events. Results on
stdout, narration on stderr. Exit 0 done/parked, 1 failure (a raise included:
`✖ failed` with the agent's code), 2 usage. Dev from
the SDK checkout: `npm run dev -- <command…>`.

---


---

## Done when

- Authoring: `archmax validate` clean, `archmax test` passing, every `.js`
  opens with its JSDoc, every case has `title` + `description`.
- Wiring: the snippet compiles against the installed package's exports.
