## Why

Nothing bounds the work of one turn across states. `budget.maxTurns` counts a state's model
calls per visit and starts again on every entry, so an agent that moves back and forth between
two states never exhausts it. While benchmarking, an agent cycled between two states, repeating
their lookups, until LangGraph's recursion limit (400 graph steps, about 57 model calls) threw a
`GraphRecursionError`. That is an exception, not a governed ending: `on_error` never saw it.

Worse, every turn that throws leaves the session unusable. A turn marks the session
`status: running` when it opens, and nothing resets it when the turn throws, so every later
`send` is refused with `SessionNotResumableError`. A recursion limit and a model endpoint failing
mid-stream both do it. A brief provider failure ends a conversation for good.

A related race showed up while investigating: a turn cancelled before it starts can finish one
checkpoint write after `send` rejects, and a concurrent `getTuple` then crashes inside
`MemorySaver` with a `TypeError`.

## What Changes

- **A turn budget.** A new root `budget: { maxModelCalls }` (default 50) bounds the model calls
  of one turn across every state. A turn here is one invocation: a message, a decision, a reply
  or a delivery. The call that would exceed it is not made. The exhaustion routes through the
  current state's `on_error` when declared, else the turn ends rejected, as `maxTurns` does
  today. A turn routes for this at most once; the error handler then runs under its own
  `maxTurns` and the step limit.
- **A warning before the budget runs out.** When a fifth or less of the budget is left, each
  model call's "Current state" block says how many calls remain and tells the agent to finish
  and answer the person.
- **The step limit follows the budget.** Without a caller-supplied `recursionLimit`, a turn runs
  under a limit derived from its workflow's `maxModelCalls`, so the governed budget always runs
  out before the step limit is reached. The default budget keeps the limit at about today's 400.
- **A turn that throws ends the session failed.** When a turn throws (the step limit, a model
  failure, a cancellation) while the session is still `running`, the runtime commits
  `status: failed` with an exit record (`recursion-limit`, `turn-cancelled` or `turn-error`, and
  the error's message), then rethrows the original error. The next message starts a fresh turn
  from where the session stood, as after any failed session.
- **The checkpointer reads a half-written session as absent.** A namespace that holds no
  checkpoint yet reads as no checkpoint instead of crashing.
- **BREAKING (behaviour):** a turn that makes more than 50 model calls is now routed or rejected.
  A workflow whose turns legitimately run longer raises `budget.maxModelCalls`.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `workflow-spec`: "Root keys" accepts `budget`; "Budgets" adds the root `budget.maxModelCalls`.
- `runtime`: "Budgets" adds the turn budget, its warning and its once-only routing. New
  requirements: a turn's step limit follows its budget; a turn that throws ends the session
  failed.
- `workspace-and-sessions`: "Durable checkpointer" reads a namespace with no checkpoint as
  absent.

## Impact

- **Code**: `src/machine/spec-schema.ts` (root `budget`), `src/workflow/state.ts` (a per-turn
  call counter), `src/workflow/middleware.ts` (the cap beside `maxTurns`),
  `src/workflow/governance.ts` (the warning line in the volatile block),
  `src/workflow/turn-runner.ts` (stamps each invocation, marks a thrown turn failed, rethrows),
  `src/agent.ts` / `src/assembly/index.ts` / `src/workflow/sub-workflow.ts` (the derived
  `recursionLimit`), `src/workflow/checkpointer.ts` (the empty-namespace read), and their tests,
  plus behaviour tests for an A↔B cycle, a model failure and a cancelled turn.
- **Public API**: no new names. A new root key in `workflow.yaml`. `send` still rejects with
  the original error when a turn throws, and the session is then `failed` instead of stuck.
- **docs/**: `reference/machine-spec.md` (root `budget`; the per-state budget section, which
  wrongly says the default recursion limit is 50), `guides/workflow-machine.md` where budgets are
  explained, `reference/public-api.md` (what a thrown turn leaves behind, and the derived
  `recursionLimit`), and a 0.8.0 changelog entry.
- **README.md**: no change unless it describes budgets (checked in tasks).
- **skills/archmax-harness/**: the workflow schema references (`references/workflow-schema.md`,
  `references/workflow-yaml.md`) document the root `budget` and when to raise it.
