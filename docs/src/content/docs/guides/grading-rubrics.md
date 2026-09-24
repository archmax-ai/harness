---
title: Grading rubrics
description: The standard a state's exit is measured against, declared in workflow.yaml, dispatched by the runtime, invisible to the agent it grades.
sidebar:
  order: 5
---

A **grading rubric** is the standard a state's exit is measured against. It is
declared **inline on the hook that applies it**, and the runtime dispatches it.

Three properties come first. Everything else follows from them.

- **A rubric belongs to the state it grades.** It is the value of that state's
  `{ rubric: … }` hook. Reading the state tells you the whole standard its exit
  is held to. Editing it touches that state alone.
- **A rubric has no name.** Its identity is its position, which the runtime uses
  internally. That keeps it below the level of a first-order item in the machine,
  where routing targets, listings and tool arguments all need a name.
- **A rubric is invisible to the session it grades.** `workflow.yaml` is on the
  [authoring plane](/guides/authoring-plane/), served by a backend
  of its own. So the criteria sit beyond every file tool, and dispatching a
  grader is the runtime's own job.

## Declaring one

```yaml
states:
  orders-question:
    after:
      - rubric:
          max_iterations: 2
          instructions: |-
            You are a customer support reply tone judge.

            You receive a JSON payload with `userRequest`, `history` (conversation
            messages), `state`, and `phase`. Judge only the **tone** of the last
            assistant message.

            Return exactly one of:
            - `ok` — friendly and professional.
            - `correct` — understandable but the tone is off; the agent gets
              another attempt.
            - `veto` — rude, hostile, or otherwise unacceptable.

            Always include a concise `reason`.
```

`instructions` is the only required key. It is the same word a state uses for
the prose telling a model what to do. The rest is optional:

| Key | Meaning |
| --- | --- |
| `instructions` | The grading criteria and the verdict to return. |
| `max_iterations` | How many times around the grade-and-retry loop before a `correct` becomes a hard veto. |
| `model` | A model id the grader runs on, overriding the assembly's `rubric`-role model. |
| `metadata` | Free-form host data the runtime carries and ignores (a display label, say). |

The schema is strict, so `title`, `description` and `response_format` are load
errors. A rubric is reached by position and stays out of the prompt, which is why
a display label belongs in `metadata`. And grading is all a rubric does, so every
dispatch requests the verdict schema, whether or not a budget is declared.

## Composing several checks

`before` and `after` take one hook or an ordered list. A list mixes kinds
freely, so a deterministic script and a judgment call sit side by side:

```yaml
states:
  orders-question:
    after:
      - script: hooks/check-order-ids.js     # deterministic: derivable from data
      - rubric:
          max_iterations: 2
          instructions: |-
            Judge only the tone of the last assistant message …
      - rubric:
          instructions: |-
            Check that every matching order id is named explicitly …
```

They run in **declaration order** and short-circuit on the first non-`ok`
verdict. Put the cheap deterministic checks first.

Each hook's retry budget is counted **separately**, keyed by its position. So two
graders on one state hold two budgets, and a grader that passes leaves the tally
of one still asking for corrections exactly where it was.

## When two states need the same grader

Declare it twice. That is the deliberate trade: a state legible on its own is
worth more than a de-duplicated document, and a copy you can see in the file
beats a shared name that something else can change under you.

If the duplication becomes genuinely painful, remember the criteria are ordinary
prose. Keep the canonical wording wherever your team keeps such things, and treat
the spec as the place it is applied.

## Verdicts and the iteration budget

A rubric returns one of three verdicts:

- **`ok`**: the transition proceeds.
- **`correct`**: the work needs another pass. `archmax_advance` is rejected with
  the grader's guidance, and the agent retries.
- **`veto`**: a hard block. The rejection carries the grader's reason.

`max_iterations` bounds how many times a `correct` may send the agent back. It is
declared inside the rubric, so the grader and its budget are one object with one
place to look:

```yaml
after:
  - rubric:
      max_iterations: 1        # one more attempt, then a hard veto
      instructions: |-
        …
```

A `script` hook takes the same budget as a **sidecar** beside its kind key
(`{ script: hooks/review.js, max_iterations: 2 }`). It points at something
defined elsewhere, so its budget rides on the hook itself.

A custom kind's value grammar is string to string, so a numeric sidecar beside
it is a load error and a quoted one is ignored. A custom hook runs at the
default budget of `0` today, which makes its first `correct` a hard veto.

The count is **per hook**, so a state with a schema script and a rubric on
`after` gives each its own tally. A `correct` refused for want of budget bills
nothing, which is why the state starts its next visit with the full allowance.

Hook *errors* fail closed. A dispatch that cannot be made vetoes the transition,
and that includes a `model` id the host cannot serve. Output that parses to no
verdict vetoes too, carrying a snippet of the raw text so you can see what
arrived.

## Choosing the grader's model

`model` names a model id, resolved through the assembly's `modelFactory` seam:

```yaml
after:
  - rubric:
      model: <a stronger model id>
      instructions: |-
        …
```

With no factory, the id is applied over `ARCHMAX_MODEL`, keeping the configured
endpoint and credentials. With a factory, the id arrives as its third argument
(`(role, env, requested)`), and the host may map it, refuse it, or ignore it. A
factory taking just `(role, env)` keeps working, and an unhonoured request passes
silently. See the
[public API reference](/reference/public-api/#modelfactory-pluggable-model-provider).

## No script dispatches a grader

There is no `task()` global in any sandbox context: hook scripts, `archmax_eval`
and `archmax_run` alike. An inline rubric has no name a script could pass, and
inventing one to keep the global alive would make a rubric a first-order item
again.

A script that wants a model verdict gets a rubric hook beside it in the same
list, as above. That keeps every model dispatch visible in the spec.

The agent has no `task` tool either. Every state withholds it, a `tools.allow`
entry naming it is a `validate` error, and the kernel refuses the call.

## What the agent is told

The active state's volatile prompt block records that a phase of *that* state
carries a hook. It records the **kind alone**, and only while that state is in
force:

```
## Current state: orders-question

Hooks: after: rubric
```

Presence is disclosed because it is actionable: a graded exit can come back with
a correction to act on. The `instructions`, the budget, the model and the
positional id appear in no prompt.
