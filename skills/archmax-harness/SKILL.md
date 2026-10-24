---
name: archmax-harness
description: >-
  Build with the @archmax-ai/harness runtime for LangChain Deep Agents. Use this
  whenever you are designing, editing or fixing a workflow state machine (a
  workflow.yaml with states, transitions, grader and code states, tool and skill
  governance, scripts, cases, or skill bundles), OR wiring the
  @archmax-ai/harness npm package into a backend service — assembling an agent with
  createAgent, sending turns, resuming human-in-the-loop states, or
  streaming the event stream / session artifacts so a frontend can visualize a
  session. Trigger this skill for phrases like "design a workflow", "author a
  workflow.yaml", "add a state/transition/check", "archmax validate fails", "run
  an agent workflow from my worker", or "integrate @archmax-ai/harness" even when the
  runtime is not named explicitly.
---

# Building with @archmax-ai/harness

The archmax harness is a thin, governed layer over
[LangChain Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview).
Each workflow runs as one Deep Agent, moved through a state machine you declare in
`workflow.yaml`. The harness holds no use-case logic: a **workspace** supplies it.
Every spec targets runtime contract `3` (`runtime: { engine: archmax-harness, version: "3" }`,
or omit the block).

## Load one reference per task

This file is the procedure, the workspace layout and the commands. Before you write
a file, load the one reference it needs:

| You are about to… | Load |
| --- | --- |
| write or edit `workflow.yaml` | [`references/workflow-schema.md`](references/workflow-schema.md) |
| write a code state's script, a grader state, or a skill bundle's `archmax_run` script | [`references/code-states-and-scripts.md`](references/code-states-and-scripts.md) |
| write or fix a case (`tests/*.test.yaml`) | [`references/cases.md`](references/cases.md) |
| fix what `archmax validate` or `archmax test` reported | [`references/diagnostics.md`](references/diagnostics.md) |
| embed the harness in a service | [`references/backend-integration.md`](references/backend-integration.md) |

Read a long reference by section. Do not read the SDK source, do not list a workspace
to learn its layout (it is fixed, below), and do not reread a file already in context.

Two workspaces in the [archmax harness repository](https://github.com/archmax-ai/harness)
show the result:

- [`examples/refund/`](https://github.com/archmax-ai/harness/tree/main/examples/refund) is
  the minimal SDK example: four states (an agent, a code state, a grader, a terminal
  agent), two host tools, and a short program that runs it with `createAgent`.
- [`examples/customer-support/`](https://github.com/archmax-ai/harness/tree/main/examples/customer-support)
  is the full reference workspace for the CLI: triggers, a human state, a
  sub-workflow, skill bundles and a suite of cases.

## Build a workflow

Design the whole file set first, write each file once, then verify.

1. **Sketch the graph.** Name the states (kebab-case slugs). Give the entry state
   `triggers: { manual: }`, plus any host trigger that enters there. A state with
   no transitions is terminal. For every transition, write the condition under which
   it is taken: that is its `description`, which every transition must have. It is
   all the agent learns about the transition, so say *when* to take it, never *where*
   it goes.
2. **Put each check on the graph.** A deterministic check is a code state; a
   judgment (tone, completeness) is a grader state. Give each one a transition
   onward, one back to the work it checks, and an `on_error`. The patterns are in
   *Checks are states* below.
3. **Decide how the work fails.** The agent ends a session it cannot complete with
   `archmax_raise({ code, reason })`. Where a host branches on the reason, name the
   codes in the `instructions` of the states that can hit them. Where a person must
   always be reached instead, forbid the tool in that state.
4. **Sign the entry if something calls it.** When another workflow, an MCP tool or a
   form starts the workflow, give its trigger a `description` for the caller and a
   `requires`/`returns` signature. Type an entry where the caller must build or read
   the value.
5. **Decide the file set.** Always `workflow.yaml`. One `scripts/<check>.js` per code
   state (a grader needs no file: its criteria are its `instructions`). Cases: one
   per branch, one per path a check declines or sends back, one `decide:` per human
   state, one `raised:` per failure a host branches on. A `skills/<slug>/` bundle
   only for data, an `archmax_run` script, or guidance several states share.
   `AGENTS.md` only for a workspace-wide persona.
6. **Write `workflow.yaml`** from the skeleton in the schema reference. Keep its
   `tools.allow_always` list of the twelve default tools: a declared list replaces
   them, so drop only what this workflow must not have. Put each state's behaviour
   in its own `instructions`, rules for the whole session in the top-level
   `instructions`, and nothing about the machine itself: the platform prompt and the
   rendered transitions already say it, and every word is billed on every call.
7. **Write scripts, grader criteria and cases**, description first: a script's JSDoc
   header, a grader's give-up rule, a case's `title` and `description`. Then the
   body. Keep the two in agreement.
8. **Verify.** Run `archmax validate <slug>`, fix every error and every warning you
   can, then `archmax test <slug>`. A workflow is not done without a clean
   `validate`.

Two rules authors get wrong:

- **Never describe another state.** The agent sees the active state and its
  transitions, nothing else of the graph. A routing condition written into the
  target's `instructions` or `summary` never reaches the state that routes on it.
- **Shapes come from tools, not guesses.** Before naming a field of a tool's result
  or a trigger's payload (in `instructions`, a `${{…}}` guard or a script), ask the
  host for it: a platform embedding the harness typically offers describe tools and a
  way to sample a call. Without them, read a recorded session's variables with
  `archmax sessions <id>`.

## Fix a workflow

Diagnose from the tools, not by reading everything.

1. Run `archmax validate <slug>`. It runs offline, and every diagnostic names the
   file, the field and the fix; [`references/diagnostics.md`](references/diagnostics.md)
   maps each one.
2. Read only the files the diagnostics name. Edit once. Validate again.
3. When it is clean, run `archmax test <slug> [filter]` and read the failing case's
   verdict line:
   - A **structural** miss (`reachedState`, `parked`, `raised`, `succeeded`, `trail`)
     is a routing or governance defect: fix the routing state's `instructions`, the
     transition `description`s, or the `tools`/`skills` grants.
   - A **content** miss (`reply`, `calledTool`, `grade`) is an `instructions` defect
     in the state that answered.
   - A decline the reply quotes, or a send-back the agent keeps failing, is a code or
     grader state speaking: fix what it names, or the check when it is wrong.
   - Change the case only when it asserts something the spec never promised.
4. `grade` is the one non-deterministic assertion: run a failing case once more
   before you call it a regression. Add `--verbose` for raw events only when the
   verdict line is not enough.

Budget one validate, one edit pass, one validate and one test. On your fourth read of
a file you are guessing: reread the reference instead.

## Checks are states

A check is a state on the graph, never a slot inside one. A grader or code state runs
on entry with no call of the agent's model, reaches only its own state's tools, and
leaves like every state: with `archmax_advance({ to, reason })`, whose `reason` is the
note the next state reads, or with `archmax_raise`. Finishing without either fails
through `on_error`.

| You want | Shape |
| --- | --- |
| A deterministic check **in front of** a state | The trigger's entry (or the transition's target) is a code state that advances to the work, or to a state that declines it |
| A check **behind** a state | The state's transition points at a code state with a transition onward and one **back**; a send-back's `reason` names the fix |
| **Approve, then end** | Approve into a terminal code state: its script records the result and the session completes with no further model call |
| Judgment, with a bounded loop | A grader behind the state it grades, with transitions onward and back; its `instructions` say "raise after two send-backs", counted on the trail |

Grade work the agent hands on (a report, a recorded decision), not a live answer:
everything the agent says in a turn is that turn's reply, a draft sent back included.
The graded state's `instructions` say that advancing into the check hands the work in,
and to fix the work when a note sends it back.

## Workspace layout

This is the whole layout. Nothing else is read.

```
<workspace>/
  AGENTS.md                      # optional persona, the first prompt layer
  workflows/<slug>/              # read by the runtime only; the agent cannot read it
    workflow.yaml                #   the machine (required)
    WORKFLOW.md                  #   optional Markdown appended to the prompt, no frontmatter
    scripts/<check>.js           #   code-state scripts
    tests/<case>.test.yaml       #   one case per file; fixtures beside them
  skills/<slug>/                 # a skill bundle, mounted read-only, enabled by slug
    SKILL.md                     #   frontmatter (name = directory slug, description) and body
    scripts/<script>.js          #   archmax_run scripts, run by the agent
    assets/<file>                #   read-only data
  .env                           # ARCHMAX_* model configuration (never mounted)
  sessions/<id>/                 # one session; the agent's workspace root (never authored)
    scratchpad/                  #   the one zone every state may write
```

- **The agent cannot read `workflows/**`.** Its spec, scripts, grader criteria and
  cases are out of reach, so never point `instructions`, `evidence` or a case's
  `workspace:` at them. Text the agent needs goes in a skill bundle.
- **Two kinds of script, two places.** A code-state script lives in
  `workflows/<slug>/scripts/` and the runtime runs it when its state is entered. An
  `archmax_run` script lives in `skills/<slug>/scripts/` and the agent runs it. They
  never share a file.
- **Paths have no leading slash**: `skills/order-data/assets/orders.json`,
  `scratchpad/refund.json`. Write session files under `scratchpad/`.
- **Guidance has three homes.** Every workflow: `AGENTS.md`. The whole session: the
  top-level `instructions`, as a literal block (`|-`). One state: its
  `instructions`. A paragraph pasted into a second state belongs one level up. Never
  write one skill bundle per state.
- **Every `.js` file opens with a JSDoc block**: a title line, a blank line, then what
  it reads, what it checks or computes, and each outcome (for a code state, every
  `archmax_advance` target and why, and every raise). Admin UIs show this block
  instead of the code.

## Commands

```bash
archmax validate [workflow] [--json]            # offline; run after every structural edit
archmax test [workflow] [filter] [--json]       # cases; filter = case-id substring
archmax run <workflow> "<prompt>" [--session <id>] [--trigger <id>] [--variables '<json>'] [--file <var>=<path>]...
archmax sessions [session] [--json]             # list sessions, or one session's variables
archmax decide <session> --to <state> [--comment "…"]   # decide a human state
archmax reply <session> "<message>"             # message a parked session; it stays parked
archmax deliver <session> --trigger <id> [--variables '<json>']   # deliver to an archmax_wait park
```

`<workflow>` may be omitted when the workspace has one. `--root <dir>` sets the
workspace (default: the current directory; `.env` loads from it), and `--verbose`
prints raw events. Results go to stdout and narration to stderr. Exit codes: 0 done
or parked, 1 failure (a raise prints `✖ failed` with its code), 2 usage error. The CLI
runs workflows that need no host tools; one that needs host tools, like
`examples/refund/`, runs from code.

## Done when

- Authoring: `archmax validate` is clean, `archmax test` passes, every `.js` file opens
  with its JSDoc block, and every case has a `title` and a `description`.
- Wiring: the program compiles against the installed package's exports.
