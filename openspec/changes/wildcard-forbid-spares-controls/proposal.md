## Why

A forbid entry naming the tool `*` is documented as "every tool, which is how a path is denied
across the board", but the kernel matches it against every call name, the state type's control
tools included. So `tools: { forbid: ["*"] }` — the obvious way to say "this state may call
nothing" — also refuses `archmax_advance`, `archmax_raise` and the variable tools: the state can
never leave, fail or record anything, and the session strands until the recursion limit. Nothing
documents this as intended. Every example and test of `*` carries a `paths:` guard, `validate`
says nothing about it (its stranding check only looks for a literal `archmax_advance`), and the
disclosure side contradicts it. Because the bare `*` takes away only the literal name `*`, the
model is still offered every tool the kernel will then refuse.

## What Changes

- A forbid entry naming `*` covers every tool **except the control tools of the active state's
  type** (agent/human: `archmax_advance`, `archmax_reset`, `archmax_wait`, `archmax_raise`,
  `archmax_get_variables`, `archmax_set_variables`; grader/code: `archmax_advance`, `archmax_raise`,
  `archmax_get_variables`, `archmax_set_variables`, `archmax_get_history`). This holds in
  `tools.forbid` and `tools.forbid_always`, bare or guarded, and for denials a sub-workflow inherits.
  `archmax_eval` and `archmax_run` are grantable tools, not controls, so `*` still covers them.
- Naming a control tool explicitly still denies it, as today (`forbid_always: [archmax_reset]`,
  `{ tool: archmax_advance, args: { to: [x] } }`).
- A bare `*` withdraws every tool it denies from disclosure, as any bare denial does. The state is
  then offered only its controls.
- **BREAKING** (narrow): a workflow that relied on `*` to refuse a control call, for example
  `{ tool: "*", args: { to: [review] } }` to block an advance, must name the control instead.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `governance`: "Workflow and state denials" defines `*` as every tool except the state type's
  controls; "Per-state tool disclosure" withdraws a bare `*`'s tools.
- `workflow-spec`: "Allow entries and the tools blocks" restates what `*` covers in a forbid entry.

## Impact

- Code: `src/kernel/kernel.ts` (`compileForbidRules`), `src/machine/machine.ts`
  (`disclosedTools`), and their unit tests.
- `docs/`: `reference/machine-spec.md` (the `*` paragraph under `tools.forbid_always /
  tools.forbid`), `guides/workflow-machine.md` where it describes `*`, and a
  `reference/changelog.md` entry marked breaking.
- `skills/archmax-harness/`: `references/workflow-schema.md`, whose comment `"*" = every tool`
  should say controls are excepted.
- README.md: no change. It does not describe the wildcard.
