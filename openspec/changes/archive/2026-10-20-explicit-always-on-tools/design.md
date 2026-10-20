## Context

See proposal.md for the motivation. Today the tool surface comes from one derivation,
`WorkflowMachine.effectiveEntries(state)` (`src/machine/machine.ts`), which enforcement
(`checkAllowed`), disclosure (`disclosedTools`, and through it the per-call tool filter in
`src/workflow/governance.ts` and the script `tools.*` surface in `src/sandbox/ptc-gateway.ts`) and
the model-facing descriptions (`describeAllowed`, `describeArgConstraints`) all read. It has three
tiers:

1. the state's own `tools.allow` entries;
2. every essential tool the state does not mention (the built-in `ESSENTIAL_TOOLS` plus the host's
   `essentialTools`), unconstrained;
3. `tools.allow_always` entries for tools the state does not mention **and that are not essential**.

Two other places treat "essential" as a fixed set independent of the spec:

- the kernel's `runOpenAccessRule` (`src/kernel/kernel.ts`), which opens `scratchpad/` and the
  offload areas to any essential tool in every state (`tool.scratchpad`, `tool.offload-read`);
- the lint in `src/machine/lint-spec.ts` that warns about essential tools listed in `allow_always`.

The schema already distinguishes an absent `tools.allow_always` from `[]` (`.optional()` in
`spec-schema.ts`), but the machine collapses both with `?? []`. The `todoListMiddleware` that supplies
`write_todos` and its prompt guidance is installed unconditionally in `src/assembly/compose.ts`.

This branch is stacked on `fix/hook-mount-grants` (PR #43), which changes the same governance code.

## Goals / Non-Goals

**Goals:**

- One place decides the workflow-wide grant (declared list, or the default tools), and every reader
  of `effectiveEntries` follows from it without its own special case.
- A workflow without `tools.allow_always` behaves byte-for-byte as today: same disclosure, same
  verdicts and rule ids, same prompt.
- A workflow written from the old skeleton (`allow_always: []`) shows up in `archmax validate` rather
  than silently losing its file tools.

**Non-Goals:**

- Changing the control tools (`ALWAYS_ALLOWED_TOOLS`) or the host's `essentialTools`.
- Gating the behaviour on the runtime contract version.
- Renaming the `createAgent({ essentialTools })` option.
- Changing what hooks can do: hook scripts keep running in the sandbox, on runtime authority, whether
  or not the agent is granted `archmax_eval`.
- Making the scratchpad open to tools other than the default file tools and the host's
  `essentialTools`.

## Decisions

### D1. Key presence decides; a declared `[]` is a declaration

`tools.allow_always` absent → the workflow-wide grant is `DEFAULT_TOOLS`, unconstrained. Declared,
`[]` included → the grant is exactly its entries. This matches what `skills.allow_always: []`
already means ("every capability is state-specific"), uses a distinction the schema already
makes, and gives an author a way to say "no workflow-wide tools".

*Alternatives considered:*

- **Empty list means the defaults.** This would spare workspaces written from the old skeleton. But
  `[]` could then not mean "nothing workflow-wide", which breaks the symmetry with `skills`. It would
  also add a cliff: adding the first tool to the list removes twelve.
- **Keep the defaults additive, with an opt-out key** (for example `default_tools: false`). The
  defaults would stay invisible in the document, which is the problem the change addresses. It would
  also add a second root key for one concept.
- **Gate on `runtime.version`.** `src/runtime/contract.ts` defines load behaviour as layout-driven
  and the version as declarative metadata. Nothing in governance reads it, and this change should not
  set that precedent.

### D2. One workflow-wide tier in the machine

`WorkflowMachine` gains a private `workflowGrant(): NormalizedAllowEntry[]`. It returns the
normalized `allow_always` entries when the key is declared, and `DEFAULT_TOOLS` as bare entries
otherwise. `effectiveEntries` becomes:

1. the state's own entries;
2. `workflowGrant()` entries for tools the state does not mention and that are not host
   `essentialTools`;
3. the host's `essentialTools` the state does not mention, unconstrained.

Tiers 2 and 3 never name the same tool, so their order only sets the order in which a block
message lists them. This order keeps those messages byte-identical to today's for a workflow
without `allow_always`. Tier 2 carries guards, so an `allow_always` constraint on a built-in is enforced, as the spec
requires. A built-in the declared list omits appears in no tier unless the state names it, so it is
neither disclosed nor permitted. `checkAllowed`, `disclosedTools`, `describeAllowed`,
`describeArgConstraints`, the governance tool filter and the script `tools.*` surface all follow
without edits.

`allowAlwaysEntries()` (also read by `delegationTargets`) keeps returning the declared entries or
`[]`. Only the grant changes. `validate` builds machines from specs whose schema may have failed, so
a non-list value under `allow_always` is treated as absent, the same way `forbidEntries` already
treats a non-list.

`isEssential(tool)` is removed. Its one caller is the kernel (D3).

### D3. Open areas ask "granted here", not "essential"

The kernel's `runOpenAccessRule` replaces `machine.isEssential(tool)` with
`machine.opensWorkingAreas(state, tool)`. That is true when the tool is a host `essentialTools` tool,
or when it is a `DEFAULT_TOOLS` member that some effective entry of `state` names, whatever that
entry's guards. Guards are ignored because the rule exists to keep `scratchpad/` open under a
narrowing entry (`{ tool: write_file, paths: [output/**] }`). Requiring the grant is what stops the
open areas from making an ungranted `write_file` callable. When no machine is present, the fallback
becomes `DEFAULT_TOOLS.has(tool)`, the same shape as today. Rule order is unchanged: forbids and
safety rules still run first.

For a workflow without `allow_always`, every default tool is named in every state's effective
entries. The rule therefore admits exactly what it admits today, which keeps the existing
`tool.scratchpad` and `tool.offload-read` tests valid.

*Alternative:* open the areas to every default tool unconditionally, as today. Rejected: a workflow
that withholds `write_file` would still have it callable on `scratchpad/**`, which defeats the grant.

### D4. Lint: remove two warnings, add one, widen one

All of these live in `lint-spec.ts`, so the loader's `warning` events and `archmax validate` report
them alike.

- **Removed:** "`tools.allow_always` lists/constrains essential tool …". Such entries are now real
  grants. The stale comment about `task` beside it goes too.
- **Added:** when `tools.allow_always` is declared and no default tool is named there or in any
  state's `tools.allow`, one warning at `tools.allow_always`. It names the default tools, says a
  declared list replaces them, and says the agent cannot read offloaded tool results without
  `read_file`. It is a warning, not an error: a workflow with no file tools is legitimate, if rare.
- **Widened:** the scratchpad-only narrowing warning also inspects `allow_always` entries, now that
  their guards bind. Its text changes from "permitted in every state" to "permitted wherever the
  tool is granted".

### D5. Prompt follows the grant

- `compose.ts` installs `todoMiddleware()` only when `write_todos` is in `disclosedTools(state)` for
  some declared state. This is a new `machine.grantsAnywhere(tool)`, which counts forbids. It is
  decided once per composition, so the static prefix stays identical across the session's calls. A
  child composition decides for its own spec. A workflow without `allow_always` always installs it,
  so its prompt is unchanged.
- `platform-prompt.md`: "`scratchpad/`, always writable, is only the default" and
  "`archmax_eval(…)`, in every state, runs …" are reworded so they make no promise about which
  tools a state has. `platform-prompt.generated.ts` is regenerated, and the existing equality test
  keeps them in step.
- `workspace-prompt.ts`: the `scratchpad/` bullet changes from "Always readable and writable,
  whatever state you are in" to readable and writable in every state with the file tools that state
  is granted. This is one static sentence and does not depend on the spec, so the prefix stays
  cacheable.

### D6. `ESSENTIAL_TOOLS` → `DEFAULT_TOOLS`, without an alias

The set is no longer essential: a workflow can leave any of its members out. The glossary rule (one
term per concept, "essential tools" listed under *Not called*) argues against keeping the old name
next to the new one. The package is pre-1.0 and records breaking changes in the changelog. The
public barrel (`src/public/spec.ts`) and `reference/public-api.md` change together, because the
barrel test compares them in both directions. `createAgent({ essentialTools })` keeps its name: it
still means "always on, whatever the workflow declares".

### D7. Examples and the skill state the defaults in full

Both example workflows list all twelve default tools under `tools.allow_always`, in the canonical
order (file tools, file operations, `write_todos`, sandbox tools), so their surface and their cases
are unchanged. `order-lookup`'s `enrich-order` state keeps its `archmax_run` narrowing as a state
entry. Its comment changes from "essential" to "narrows the workflow-wide grant here". The skill's
skeleton replaces `allow_always: []` with the same list and a comment on how to trim it. The
governance section and the precedence list in `workflow-schema.md` are rewritten around the
absent/declared rule.

### D8. Tests

- Existing tests whose specs have no `allow_always` stay as they are. They now pin the
  "absent → defaults" path.
- Tests whose inline spec declares `allow_always` and still expects the built-ins are fixed one by
  one. Some prove the new rule: `ptc-gateway.test.ts` `SURFACE_SPEC`, `behaviour/governance.test.ts`
  "grants a tool in every state through allow_always", and the `machine.test.ts` allow_always block,
  where "treats an allow_always constraint on an essential tool as inert" becomes "enforces …".
  The others gain the default list so they keep testing what they were written for (for example
  `kernel.pipeline.test.ts` specs).
- The `validate.test.ts` "warns when tools.allow_always names an essential tool" case is replaced by
  tests of the new warning: it fires for `[]`, stays silent once any state names a default tool, and
  stays silent when the key is absent.
- New behaviour tests drive the public barrel with the scripted fake model. One workflow uses
  `allow_always: [read_file, ls]` and asserts on disclosure, `tool.not-allowed` for `write_file` and
  `archmax_eval`, scratchpad closed to `write_file`, and no `write_todos` in the prompt. A second
  grants `write_file` on one state only, with scratchpad open there.

## Risks / Trade-offs

- **[Workspaces written from the old skeleton lose their file tools on upgrade]** → The new lint
  warning fires on exactly that shape: `[]`, or a list of host tools only, with no default tool in
  any state. The loader also emits it as a `warning` event at assembly. The changelog's **Breaking**
  entry gives the two-line fix: paste the default list, or delete the key.
- **[A deliberately file-less workflow gets a warning it cannot silence without listing a default
  tool]** → This is accepted. Such a workflow cannot read offloaded large tool results either, and
  the warning says so. If hosts report it as noise, a later change can add a silencing form without
  changing these semantics.
- **[Sessions parked before the upgrade resume under the new surface]** → The machine is built from
  the spec at assembly, so a parked session of an affected workflow resumes with the declared
  surface only. That is correct by the new rule, and the same lint warning flags it beforehand.
- **[Rename breaks importers of `ESSENTIAL_TOOLS`]** → A compile-time break, named in the changelog
  with its replacement. No runtime behaviour depends on the import.
- **[Stacked on an unmerged PR]** → Rebase onto `main` once PR #43 lands. The overlap is in
  `kernel.ts` and `lint-spec.ts`, and the changelog section is decided then (see Open Questions).

## Migration Plan

1. Workspace authors: for each `workflow.yaml` that declares `tools.allow_always`, either add the
   default tools it needs (the skill's list) or remove the key to keep the defaults. Then run
   `archmax validate`: the new warning lists any workflow that still grants no default tool.
2. Hosts importing `ESSENTIAL_TOOLS`: switch to `DEFAULT_TOOLS`.
3. Rollback: revert the change. No persisted session data depends on it, because sessions store no
   tool surface.

## Open Questions

- ~~Which changelog section gets the entry.~~ Resolved during implementation: PR #43 shipped as
  0.7.0 and #44 as 0.7.1, so the entry opens a new `0.8.0` section. The branch still has to be
  rebased onto `main` (#43 was squash-merged, and #44 touches `code-interpreter.md` and the
  changelog next to this change's edits).
