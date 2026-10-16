## Context

- **Where dispatches come from.** Three callers reach `SubWorkflowDispatcher.dispatch`:
  - the model, through `serviceDelegation` in the tool service, inside `wrapToolCall`, which sees
    the step's state and the assistant message that made the call;
  - a script, through the PTC gateway and `createDelegationTool`, inside the `archmax_eval` or
    `archmax_run` tool call that ran it;
  - a hook, which is handed the unfiltered tool surface and so the delegation tools too. A `before`
    hook runs in `wrapModelCall`, an `after` and the next `before` inside `archmax_advance`'s tool
    call, and a terminal `after` in `afterModel`.
- **Where state can be written.** A tool call's result may be a `Command` carrying an update (the
  dispatch trail steps already ride one). `afterModel` returns an update. `wrapModelCall` cannot.
  Every hook echoes the whole state, so an accumulating channel's reducer must be idempotent on an
  echo.
- **Parks.** A child's park is caught in `serviceDelegation` and recorded as a pending delegation
  with its `identity` and `dispatchId`; resume addresses the child by the recorded identity. A
  script cannot park a child: the PTC gateway turns a park into a `parked` failure. So a script's
  and a hook's children never need to be found again; they need only a number nobody else takes.

## Goals / Non-Goals

**Goals:**

- No two dispatches of one session ever share a child, across turns, agents and workers.
- A node replayed from its checkpoint reaches the same children.
- One name per child across the event stream, the pending delegation and the session id.
- A session parked before the upgrade resumes.

**Non-Goals:**

- Contiguous numbers. A delegation call the kernel refuses takes its number and leaves a gap.
- Numbering grading-rubric dispatches. `rubric-start`/`rubric-result` keep their own ids.
- Migrating stored child sessions to the new shape.

## Decisions

**1. The count lives in a `dispatchCount` channel folded by `max`.** Sibling tool calls of one batch
each write the count they leave, and a hook's echo writes back what it read; `max` makes both
harmless. A last-value channel would let the last writer in a batch win, and an additive one would
double on an echo.

**2. The model's calls are numbered by position, not by arrival.** `wrapToolCall` finds the
assistant message holding the call, lists its delegation calls in order (resolving a namespaced
name the way the call itself is resolved) and gives the call `count + 1 + its index`. The tool node
services sibling calls concurrently and in no fixed order, and a replay may service only some of
them, so arrival order would not be stable; position in the message is.

*Alternative:* allocate in `afterModel`, when the message is first seen. The count is the same, but
the number would then have to travel to the tool call through state, and every reader of the message
can work it out itself.

**3. The dispatcher keeps a floor, not the count.** `reserve(sessionId, upTo)` raises an in-memory
floor; `dispatch` with no number takes the floor plus one. Governance reserves the checkpointed
count, plus the batch's delegation calls in a tool step, before anything can dispatch:

- at the top of `wrapModelCall`, before a `before` hook;
- at the top of every `wrapToolCall`, before a script or an `archmax_advance` hook runs;
- in `afterModel`, before a terminal `after` hook.

So a fresh agent starts from the checkpoint, and a script or hook dispatching in the same step as
the model's calls numbers above all of them. The floor is never the source of truth: it is rebuilt
from the checkpoint by every agent.

**4. The count is committed where state can be written.** Every tool call's result carries
`dispatchCount` when the dispatcher's floor has passed the step's count: a `ToolMessage` becomes a
`Command` with the message and the count, as the trail steps already do. `afterModel` commits it
too, for a `before` hook that dispatched during the model call and for a terminal `after` hook.

**5. `identity` is the number; `dispatchId` is the path.** The pending delegation's `identity` is
`String(n)`, the child's id is `<caller>~<identity>`, and `dispatchId` is the child's id with the
root's id and separator removed (`dispatchIdOf`). With a bare `n`, the root's first child and that
child's first child would both be `1` in one event log.

**6. `~` is reserved, and the 0.5 shape is read but never minted.** `sessionIdRejection` refuses an
id whose `~`-separated tail is not a chain of child segments. A child segment is a number from 1, or
the 0.5 shape `<state>:<workflow>:<ordinal>`, so a park recorded before the upgrade still binds,
lists as a child and is released with its parent.

## Risks / Trade-offs

- **A hook's number can go uncommitted.** A `before` hook dispatches inside `wrapModelCall`, and its
  number is committed in `afterModel`. If the model call itself then fails and the turn ends with no
  state write, a fresh agent next turn could reuse that number. The window is a hook that dispatches
  and a model call that throws in the same step; the child it would reuse completed, since a hook's
  child cannot park. Closing it would need a write path `wrapModelCall` does not have.
- **A crash mid-script re-runs the script with the same numbers.** That reaches the same children,
  as a replayed model call does, which is the intended reading of a re-dispatch.
- **Hosts minting ids with `~`.** They now fail at ingress with a message naming the rule, rather
  than being misread as children.
