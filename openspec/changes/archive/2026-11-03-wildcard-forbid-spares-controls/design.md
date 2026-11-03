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

**Goals:** No `*` entry and no bare entry blocks `archmax_advance`; a guarded advance denial still
works. A bare `*` and disclosure agree.

**Non-Goals:**

- Exempting any other control tool. They all stay covered by `*` and deniable by name.
- Changing consumer governance rules, safety rules, or the reply-only turn, which refuses every
  call. The exemption is about `forbid` entries only.
- Changing what the allow side may say about `archmax_advance`.

## Decisions

**A bare entry naming `archmax_advance` is a load error; a guarded one is kept.** A bare
denial can only strand a state, which is what a state without transitions already declares.
A guarded denial (`{ tool: archmax_advance, args: { to: ["${{blocked_route}}"] } }`) blocks one
edge depending on a variable, which neither `transitions` nor the per-state `requires` can say,
so it stays. The check goes in `refineSpec` next to the wildcard-grant message, and the message
points to `transitions`. Alternatives considered:

- Reject the guarded form too. Rejected: it removes the only per-edge, variable-dependent gate.
- A `validate` warning for the bare form. Rejected: the runtime would still load a document that
  can only strand its state.

**The `*` rule abstains for `ADVANCE_TOOL`.** That is one comparison in the `*` branch of
`compileForbidRules`. A guarded entry naming the advance goes through the named-tool branch as
before. Inherited `forbid_always` rules use the same function, so a child's advance is spared too.

**A bare `*` in disclosure deletes every disclosed tool except `ADVANCE_TOOL`.** This follows the
existing rule that a bare denial withdraws its tool and a guarded one does not. Terminal states
already omit the advance, so they end up offered nothing.

**The advance-stranding lint goes.** The bare form it caught is now a load error.

## Risks / Trade-offs

- [A guarded advance denial whose glob matches every target, `args: { to: ["*"] }`, still
  strands the state] → Not checked. It is an explicit, unusual choice, unlike `forbid: ["*"]`.
- [A bare `*` now also blocks `archmax_raise`, so a state denied everything cannot fail itself]
  → This is intended: the author asked for nothing but movement. `budget.timeoutMs` and
  `on_error` still bound the state.
