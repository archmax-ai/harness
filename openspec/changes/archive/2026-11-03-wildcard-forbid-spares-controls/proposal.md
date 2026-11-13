## Why

A forbid entry naming the tool `*` is documented as "every tool, which is how a path is denied
across the board", but the kernel matches it against every call name, `archmax_advance` included.
So `tools: { forbid: ["*"] }`, the obvious way to say "this state may call nothing", also removes
the state's only way to leave. The session strands until the recursion limit.

The same is true of naming `archmax_advance` bare. That denial is never needed: `transitions`
already say where a state may move, `requires` gates when it may leave, and a state with no
transitions is the declared dead end. A guarded denial
(`{ tool: archmax_advance, args: { to: ["${{blocked_route}}"] } }`) does something neither can,
blocking one edge depending on a variable, so it stays. Every other control tool (`archmax_raise`, `archmax_reset`,
`archmax_wait`, the variable tools, `archmax_get_history`) has legitimate reasons to be denied and
stays deniable.

The disclosure side also disagrees with the kernel. A bare `*` withdraws only the literal name
`*`, so the model is still offered every tool the kernel will then refuse.

## What Changes

- No `*` entry blocks `archmax_advance`. `*` means every tool except `archmax_advance`, in
  `tools.forbid` and `tools.forbid_always`, bare or guarded, own or inherited by a sub-workflow.
  Every other `archmax_*` tool stays covered by `*` and stays deniable by name.
- A `forbid` or `forbid_always` entry naming `archmax_advance` without argument guards is a load
  error whose message points to `transitions`. This is not breaking in practice: such a denial
  could only strand a state, and `validate` already rejected it at the root. A guarded advance
  denial keeps working.
- The `validate` error for `forbid_always: [archmax_advance]` is removed. The load error
  replaces it.
- A bare `*` withdraws every disclosed tool except `archmax_advance`. A non-terminal state is then
  offered only the advance, and a terminal state is offered nothing.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `governance`: "Workflow and state denials" exempts `archmax_advance` from every denial;
  "Per-state tool disclosure" withdraws a bare `*`'s tools.
- `workflow-spec`: "Allow entries and the tools blocks" adds the load error and restates `*`;
  "Governance diagnostics for denial" drops the advance-stranding error.

## Impact

- Code: `src/kernel/kernel.ts` (`compileForbidRules`), `src/machine/machine.ts`
  (`disclosedTools`), `src/machine/spec-schema.ts` (`refineSpec`, a load error beside the
  wildcard-grant one), `src/machine/lint-spec.ts` (drop the advance check), and the tests in
  `src/validate/validate.test.ts` that cover it.
- `docs/`: `reference/machine-spec.md` (the `*` paragraph and the `validate` sentence about a
  denial of `archmax_advance`), `reference/public-api.md` ("A `forbid` still blocks a control"),
  `guides/workflow-machine.md` where it describes `*`, and a `reference/changelog.md`
  entry.
- `skills/archmax-harness/`: `references/workflow-schema.md` (`"*" = every tool` comment) and
  `references/diagnostics.md` (the `forbid_always denies archmax_advance` row becomes the load
  error).
- README.md: no change. It does not describe denials of control tools.
