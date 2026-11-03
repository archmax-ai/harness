## Context

Two places read a forbid entry. Neither treats `*` as the docs describe it.

- `compileForbidRules` (`src/kernel/kernel.ts`) builds one rule per entry. For `*` it sets
  `anyTool` and matches every `tool-call` action. Control calls reach `decide` before
  `serviceControlTool` services them (`src/workflow/governance.ts`, `governToolCall`). The PTC
  gateway also decides an automated state's controls through `decide`. As a result, `forbid: ["*"]`
  blocks `archmax_advance` with `tool.forbidden-here`.
- `WorkflowMachine.disclosedTools` (`src/machine/machine.ts`) deletes the name a bare entry
  carries. For `*` it deletes the literal `"*"`, so nothing is withdrawn.

Probe against `main` with `states.work.tools.forbid: ["*"]`: `decide` blocks `archmax_advance`,
`archmax_raise`, `archmax_set_variables` and `read_file`, and `disclosedTools("work")` still lists
all 18 tools. `lintSpec` reports nothing. The same happens with `tools.forbid_always: ["*"]`.

## Goals / Non-Goals

**Goals:** `*` spares the state type's controls in the kernel. A bare `*` and disclosure agree.

**Non-Goals:** Changing how a control is denied by name. Changing `*` on the allow side, which
stays a load error. Adding a lint for `*`. After this change a bare `*` cannot strand a run, so
there is nothing to lint.

## Decisions

**The exempt set is `machine.controlTools(state)`.** This is the type's controls plus
`archmax_advance`, the set the disclosure side already adds back. Using it keeps the exemption
correct per type: a grader keeps `archmax_get_history`, and an agent keeps `archmax_wait`.
Alternatives considered:
- Exempt `HARNESS_CONTROL_TOOLS`. Rejected: it includes `archmax_eval` and `archmax_run`, which are
  grantable default tools that "deny everything" should cover.
- Exempt only `archmax_advance` and `archmax_raise`. Rejected: the variable tools are how a state
  satisfies `requires` before it advances, so denying them still strands the state.

**Exempt in the rule, not in the pipeline.** The `*` rule abstains when
`api.machine.controlTools(action.state).has(action.tool)`. An entry that names a control still
matches, so explicit denials and guarded control denials keep working. Inherited `forbid_always`
rules go through the same function, so the check uses the child machine (`api.machine`) and the
child's state type.

**A bare `*` in disclosure deletes every disclosed tool outside `controlTools(state)`.** This
follows the existing rule that a bare denial withdraws its tool and a guarded one does not.

## Risks / Trade-offs

- [A workflow used `{ tool: "*", args: { to: [...] } }` to block an advance] → The proposal marks
  this as breaking, and the changelog tells authors to name `archmax_advance`. No example or test in
  the repo does this.
- [An author expects `*` to block `archmax_reset`/`archmax_wait`] → The docs state the exception,
  and `forbid: ["*", archmax_reset]` still blocks it.
