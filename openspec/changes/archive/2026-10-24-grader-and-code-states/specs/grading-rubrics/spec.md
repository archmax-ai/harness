## REMOVED Requirements

### Requirement: A grading rubric is declared on the hook that applies it

**Reason**: `before`/`after` hooks are removed from the state schema, and the `{ rubric: … }`
hook kind goes with them. Grading is now a `type: grader` state on the graph, run by the runtime
on entry and governed by its own tool surface (see the `automated-states` capability).

**Migration**: Replace `after: { rubric: { instructions } }` with a `type: grader` state between
the graded state and its successors. Point the graded state's transition at the grader, give the
grader the graded state's former successors as its transitions, and add a transition back to the
graded state for a correction. The criteria become the grader's `instructions`. A rubric's
`max_iterations` becomes a sentence in those instructions (for example "after two send-backs,
call `archmax_raise`"), which the grader applies by counting its `grader` steps into the graded
state in the trail `archmax_get_history` returns. A rubric's `model` becomes the grader state's
`model`. A leftover `after:` or `before:` fails to load as an unrecognized key.

### Requirement: A rubric's identity is its position

**Reason**: A grader is a state, so its identity is its slug like every other state's. There is no
positional id, no `rubric#<index>` label and no positional iteration budget to key.

**Migration**: Give each former rubric its own grader state with its own slug. Where a phase held
several rubrics, chain one grader state per rubric (each approving into the next). Nothing is
keyed by position any more, so reordering states re-keys nothing.

### Requirement: A state grades its exit with a rubric hook

**Reason**: A state no longer gates its own exit. The agent moves with `archmax_advance` into a
grader state, and the grader moves the session with `archmax_advance` (approve, or send back
with the correction as its reason) or ends it with `archmax_raise`. The `ok`/`correct`/`veto`
verdict vocabulary and the `max_iterations` budget are gone (see `automated-states`).

**Migration**: Replace `after: { rubric: { instructions } }` with a `type: grader` state between
the graded state and its successors, carrying the criteria as its `instructions` and a transition
back for a correction. A `correct` verdict becomes an `archmax_advance` back to the graded state
whose reason is the correction, which the agent reads as a `grader` runtime note. A `veto`
becomes an `archmax_raise`. A budget becomes a sentence in the instructions and an
`archmax_raise` once the trail shows N send-backs. A `before: { rubric }` check becomes a grader
state in front of the state it guarded, entered in place of it.

### Requirement: A rubric is invisible to the run it grades

**Reason**: Rubrics are removed. A grader's `instructions` live in `workflow.yaml`, which the
authoring backend serves and the agent's workspace does not route. A grader's own context is
isolated from the session's transcript (see `automated-states`).

**Migration**: None needed. A grader state's `instructions` are never rendered into the agent's
prompt, and nothing in the agent's workspace reaches them, as was true of a rubric's.

### Requirement: The rubric registry is built from the loaded spec

**Reason**: Rubrics are no longer registered as Deep Agents subagents, and there is no rubric
registry or verdict schema. A grader is built per run from its state, and its model is resolved
under the `grader` model role, which replaces `rubric` (see `automated-states`).

**Migration**: A host `modelFactory` that switched on the `rubric` role switches on `grader`. A
grader state's `model` reaches the factory as the requested id, as a rubric's `model` did, and the
default factory applies it over the env-configured model. A workflow-level default for graders
comes from the workflow's `settings.model`.

### Requirement: Rubric dispatch is observable to the operator

**Reason**: The `rubric-start` and `rubric-result` events are removed. A grader's run is
bracketed by `grader-start` and `grader-result`, and its model calls are reported as
`model-usage` under its state (see `automated-states`).

**Migration**: Replace a subscriber of `rubric-start { dispatchId, rubric, state }` with
`grader-start { state }`, and of `rubric-result { dispatchId, rubric, status, durationMs }` with
`grader-result { state, status, durationMs, reason? }`. A run is identified by its state's slug,
not by a dispatch id.

### Requirement: No script dispatches a rubric

**Reason**: There is no rubric to dispatch. A model judgement is a grader state on the graph, and
a code state's script is offered only its own state's tools. The sandbox still has no `task()`
global in any context.

**Migration**: Replace `after: [{ script: hooks/check.js }, { rubric: { instructions } }]` with a
code state running `scripts/check.js` that advances to a grader state, which approves into the
former successors. The script's check passes by `tools.archmax_advance` into the grader, and
fails by advancing back with the reason or by `tools.archmax_raise`.
