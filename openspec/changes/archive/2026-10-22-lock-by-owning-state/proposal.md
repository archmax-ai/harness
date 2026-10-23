## Why

A lock today is final: once a variable is locked, nothing in the session can change it. That suits
a host's input, but not a value the workflow decides along the way. While benchmarking, an agent
looked an order up and locked `order_id`, so a guard in a later state could rely on it. Then the
person said "actually, cancel order #2 instead", and the session could not follow: every write was
refused, and the conversation looped or acted on the wrong order. The only alternative is to leave
the value unlocked, and then any state can rewrite it and a guard that reads it means nothing.

What an author needs is a value that only one state decides. To change it, the session goes back
to that state, so the state's tools, hooks and `requires` apply to the new value, and every later
state and guard sees it again on the way forward. The agent's own locks also pile up across a
session: after `archmax_reset` starts it over, the values the earlier run locked still cannot be
decided again.

## What Changes

- **A state may own variables: `locks: [order_id, …]`.** Only that state may write a variable it
  owns, on any visit, before or after the variable is set. A write from any other state is refused
  naming the owner, so the agent knows to go back there. This works for any variable, guarded or
  not: it is the general way for an author to tie a variable to the state that decides it.
- **Ownership never moves.** Two states may not own the same variable. Neither `trigger` nor
  `title` may be owned, and neither may a variable on a human state, which makes no tool calls.
- **The agent cannot make an owned variable final.** `archmax_set_variables` with `lock: true`
  naming an owned variable is refused, as `lock` on `title` is today.
- **A host's value still wins.** A host seed, a trigger input or a delivered variable stays locked
  and final, even when a state owns its name.
- **`archmax_reset` frees the locks the run set.** The agent's `lock: true` locks are released, so
  the restarted run can decide those values again. Host locks stay. The values themselves are kept.
- **Unchanged:** guarded variables do not lock themselves, `archmax_set_variables` keeps its
  description and its `lock` flag, and a lock the agent sets is final until a reset. A lock
  recorded before this change counts as a host lock, so a reset leaves it alone.
- **BREAKING (behaviour):** `archmax_reset` no longer leaves agent locks in place.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `workflow-spec`: "State keys" accepts `locks`; "Seeds are locked; locking is monotonic" lets a
  reset release the agent's locks; "The variable tools" refuses a write to another state's
  variable and `lock` on an owned one. A new requirement, "A state may own variables", defines
  ownership and its validation.
- `runtime`: "`archmax_reset` returns the session to its entry state" releases the locks the run
  set.

## Impact

- **Code**: `src/machine/spec-schema.ts` (the `locks` state key, refined: reserved names, human
  states, one owner per variable), `src/machine/machine.ts` (which state owns a variable),
  `src/machine/variables.ts` and `src/workflow/state.ts` (an entry records that the agent locked
  it), `src/workflow/control-tools.ts` (the ownership check and the `lock` refusal in
  `archmax_set_variables`; `archmax_reset` releasing agent locks), and assembly or lint (a warning
  when a host seed or a trigger's required input names an owned variable). Tests: schema, the
  variable tool, reset, and a behaviour test of the order-correction loop.
- **Public API**: no new names; a new state key in `workflow.yaml`.
- **docs/**: `reference/machine-spec.md` (the `locks` key), `guides/workflow-machine.md` (session
  variables: ownership, going back, what a reset frees), and a 0.9.0 changelog entry.
- **README.md**: no change unless it describes locking (checked in tasks).
- **skills/archmax-harness/**: `references/workflow-schema.md` and `references/workflow-yaml.md`
  (the `locks` key, when to use it, the way back), and the variable guidance in the skill.
