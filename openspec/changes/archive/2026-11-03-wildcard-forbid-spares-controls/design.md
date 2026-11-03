## Context

Three places read a forbid entry today. None of them exempts the advance.

- `compileForbidRules` (`src/kernel/kernel.ts`) builds one rule per entry. For `*` it sets
  `anyTool` and matches every `tool-call` action. Control calls reach `decide` before
  `serviceControlTool` services them (`src/workflow/governance.ts`, `governToolCall`). The PTC
  gateway also decides an automated state's controls through `decide`.
- `WorkflowMachine.disclosedTools` (`src/machine/machine.ts`) deletes the name a bare entry
  carries. For `*` it deletes the literal `"*"`, so nothing is withdrawn.
- `lintSpec` (`src/machine/lint-spec.ts`) errors on `forbid_always: [archmax_advance]` only, and not
  on a state's `forbid` or on `*`.

Probe against `main` with `states.work.tools.forbid: ["*"]`: `decide` blocks `archmax_advance`,
`archmax_raise`, `archmax_set_variables` and `read_file`, and `disclosedTools("work")` still lists
all 18 tools. `lintSpec` reports nothing. The same happens with `tools.forbid_always: ["*"]`.

## Goals / Non-Goals

**Goals:** No forbid entry ever blocks `archmax_advance`. A bare `*` and disclosure agree.

**Non-Goals:**

- Exempting any other control tool. They all stay covered by `*` and deniable by name.
- Changing consumer governance rules, safety rules, or the reply-only turn, which refuses every
  call. The exemption is about `forbid` entries only.
- Changing what the allow side may say about `archmax_advance`.

## Decisions

**Naming `archmax_advance` in a forbid list is a load error, not a silent no-op.** An entry the
runtime ignores would still read to an author as a working denial. That is exactly the kind of
document the schema already rejects, as with `*` in an `allow` list. The check goes in `refineSpec`
next to the wildcard-grant message. The message tells the author to restrict movement with
`transitions` and to leave a dead end with no transitions. Alternatives considered:

- A `validate` warning. Rejected: the runtime would still load a document that says something it
  will not do.
- Keep the current lint error for `forbid_always` only. Rejected: it misses a state's `forbid`
  and the guarded form.

**The `*` rule abstains for `ADVANCE_TOOL`.** That is one comparison in the `*` branch of
`compileForbidRules`. A named entry can no longer reach the kernel because loading rejects it,
so the kernel needs no other change. Inherited `forbid_always` rules go through the same
function, so a child's advance is spared too.

**A bare `*` in disclosure deletes every disclosed tool except `ADVANCE_TOOL`.** This follows the
existing rule that a bare denial withdraws its tool and a guarded one does not. Terminal states
already omit the advance, so they end up offered nothing.

**The advance-stranding lint goes.** With both fixes in place, no forbid entry can strand a
graph, so the check could never fire.

## Risks / Trade-offs

- [A workflow uses `{ tool: archmax_advance, args: { to: [x] } }` to block an edge, e.g. in a code
  state] → It now fails loading with a message pointing to `transitions`. The changelog
  notes to drop the edge or gate leaving with `requires`. No example in the repo does
  this. Only `validate.test.ts` names the advance in a denial.
- [A bare `*` now also blocks `archmax_raise`, so a state denied everything cannot fail itself]
  → This is intended: the author asked for nothing but movement. `budget.timeoutMs` and
  `on_error` still bound the state.
