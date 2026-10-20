## Why

Every state of every workflow is granted twelve built-in tools that the workflow never declares:
the file tools, the three file operations, `write_todos`, `archmax_eval` and `archmax_run`. An author
can narrow one per state or close it with a `forbid`, but cannot leave it out. Listing one under
`tools.allow_always` does nothing, and `archmax validate` warns that the entry is inert. So a
`workflow.yaml` does not show what its agent may do: the most-used tools are invisible, and a
workflow that should only read (or never run code) has to enumerate denials instead of granting what
it needs. The grant should be explicit. A workflow that declares its workflow-wide tools gets exactly
those, and a workflow that does not keeps today's set, so workspaces without the key run unchanged.

## What Changes

- **The default tools.** The twelve built-ins (`ls`, `read_file`, `write_file`, `edit_file`, `glob`,
  `grep`, `copy_file`, `move_file`, `remove_file`, `write_todos`, `archmax_eval`, `archmax_run`)
  become the *default tools*: the workflow-wide grant a workflow gets when it does not declare its
  own. Code calls this set `ESSENTIAL_TOOLS` today.
- **`tools.allow_always` absent → the default tools.** A workflow without the key grants the default
  tools in every state, unconstrained, exactly as today.
- **`tools.allow_always` declared → exactly what it lists.** A declared list (`[]` included) replaces
  the default tools rather than adding to them. A built-in is then granted in a state only when
  `allow_always` or that state's `tools.allow` names it. `allow_always: []` means every tool is
  state-specific, the same meaning `skills.allow_always: []` already has. **BREAKING** for a workflow
  that declares `allow_always` without listing the built-ins it relies on. That includes every
  workflow written from the authoring skill's current skeleton, which declares `allow_always: []`.
- **A built-in listed in `allow_always` is a real grant.** A constraint on it
  (`{ tool: write_file, paths: [...] }`) is enforced in every state that does not name the tool
  itself. A state's own entry still takes precedence over the workflow-wide one. The two `validate`
  warnings that called such entries redundant or unenforced are removed.
- **A new `validate` warning** for a workflow that declares `tools.allow_always` but grants none of
  the default tools in any state. That agent could not read a file, even an offloaded tool result,
  and this is how a workflow written from the old skeleton shows up.
- **The scratchpad and the offload areas follow the grant.** They stay open whatever a state's
  narrowing entry says, but only to a default tool (or a host `essentialTools` tool) that the active
  state is actually granted. They no longer make an ungranted file tool callable.
- **Unchanged:** the control tools (`archmax_advance`, `archmax_wait`, `archmax_reset`,
  `archmax_raise`, `archmax_get_variables`, `archmax_set_variables`) stay always allowed. A host's
  `createAgent({ essentialTools })` stays always-on whatever the workflow declares, because the host,
  not the workflow, opted those tools in. Hooks keep running in the sandbox on runtime authority,
  whether or not the agent is granted `archmax_eval`. A workflow without `tools.allow_always` behaves
  exactly as before.
- **The system prompt stops promising tools a workflow does not grant.** The `write_todos` guidance
  layer is installed only when some state of the workflow is granted `write_todos`. The platform
  prompt no longer says `archmax_eval` is available "in every state" or that `scratchpad/` is
  "always writable".
- **Public API:** the `ESSENTIAL_TOOLS` export is renamed `DEFAULT_TOOLS`. **BREAKING** for importers.
- **The example workflows** (`order-lookup`, `enrich-order`) list all twelve default tools under
  `tools.allow_always`, so their behaviour and their cases are unchanged.
- **New workflows list the default tools.** The authoring skill's `workflow.yaml` skeleton declares
  the twelve default tools under `tools.allow_always`. The playbook tells the coding agent to start
  every new workflow from that list and remove only what the workflow must not have.
- The runtime contract version is not bumped. The behaviour follows from the document (key absent
  or declared), not from the declared version, consistent with load behaviour being layout-driven.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `governance`: the closed-by-default tool surface and effective-entry precedence take the
  workflow-wide tier from `tools.allow_always` when it is declared, and from the default tools only
  when it is absent. The session-area rule opens the scratchpad and offload areas only to a granted
  default tool or a host `essentialTools` tool.
- `workflow-spec`: `tools.allow_always` absent vs declared. Built-ins listed there are enforced
  grants. The "essential tool in `allow_always`" lint warnings are replaced by the
  "no default tool granted anywhere" warning.
- `workspace-and-sessions`: the scratchpad is open in every state to the file tools that state is
  granted, not to a fixed set.
- `sandbox`: `archmax_eval` and `archmax_run` are default tools, not unconditionally always-on.
- `runtime`: the `write_todos` guidance layer is present only when the workflow grants
  `write_todos` somewhere.
- `documentation`: the authoring skill's new-workflow skeleton declares the default tools under
  `tools.allow_always`, and the skill teaches the absent/declared rule.

## Impact

- **Code:** `src/machine/tool-names.ts` (rename to `DEFAULT_TOOLS`), `src/machine/machine.ts`
  (workflow-wide tier, granted-tool query for the open areas), `src/kernel/kernel.ts`
  (`runOpenAccessRule`), `src/machine/lint-spec.ts` (warnings removed and added, scratchpad-narrowing
  message), `src/assembly/compose.ts` (conditional `write_todos` middleware),
  `src/core/platform-prompt.md` and its generated twin, `src/public/spec.ts`, and doc comments in
  `src/machine/types.ts`, `spec-schema.ts`, `tool-paths.ts`, `src/assembly/index.ts`. Unit and
  behaviour tests that assert the built-ins are always present get counterparts for the declared
  case.
- **Public API:** `ESSENTIAL_TOOLS` → `DEFAULT_TOOLS` (`src/index.ts` barrel / `@archmax-ai/harness`
  spec exports). `docs/.../reference/public-api.md` must change in step, since a test checks it
  against the barrel in both directions.
- **Workspaces:** both `examples/customer-support/workflows/*/workflow.yaml` gain an explicit
  `tools.allow_always` listing the default tools, and their comments about "essential" tools are
  rewritten.
- **Docs (`docs/`):** `reference/machine-spec.md` (tool governance, `tools.allow_always`,
  `write_todos`), `guides/workflow-machine.md`, `guides/code-interpreter.md`,
  `guides/token-efficiency.md`, `guides/skills.md`, `reference/glossary.md` (new **default tools**
  term; **always-on tools** redefined), `reference/public-api.md`, and a **Breaking** entry in
  `reference/changelog.md` that names the migration: list the default tools in `allow_always`, or
  remove the key.
- **README.md:** the `workflow.yaml` excerpt shows the explicit `tools.allow_always`, plus one line on
  the absent/declared rule.
- **Authoring skill (`skills/archmax-harness/`):** the skeleton in `references/workflow-yaml.md`, its
  governance section, `references/workflow-schema.md` (the always-on paragraph, the precedence list,
  the no-`tools`-block note), `references/diagnostics.md` (warning rows), `references/backend-integration.md`
  and `references/hook-and-test-scripts.md` (always-on wording), and `SKILL.md` (scratchpad line,
  "write `workflow.yaml` from the skeleton" step).
- **`AGENTS.md`:** the sandbox and scratchpad lines that call these tools always-on.
