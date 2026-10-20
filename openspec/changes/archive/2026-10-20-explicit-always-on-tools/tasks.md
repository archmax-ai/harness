# Tasks

## 1. Baseline

- [x] 1.1 Confirm the worktree (`../wt/harness-explicit-always-on-tools`, branch
  `feat/explicit-always-on-tools`) has `node_modules` (`npm ci` if not). Verify the unchanged tree with
  `npm run typecheck` and `npm test`, both green, before any edit.

## 2. The workflow-wide grant (machine)

- [x] 2.1 In `src/machine/tool-names.ts`, rename `ESSENTIAL_TOOLS` to `DEFAULT_TOOLS` and rewrite its doc
  comment: the workflow-wide grant when `tools.allow_always` is absent; a declared list replaces it.
  Update every import: `machine.ts`, `kernel.ts`, `lint-spec.ts`, the tests, and the
  `src/public/spec.ts` export, whose comment changes too. In `docs/src/content/docs/reference/public-api.md`,
  replace the name in the exports list. Verify with `npm run typecheck` and the public-API barrel
  test (`npx vitest run -t "public"` or the test that reads `public-api.md`).
- [x] 2.2 In `src/machine/machine.ts`, implement design D2:
  - Add a private `workflowGrant()`: declared `allow_always` entries, or `DEFAULT_TOOLS` as bare
    entries when the key is absent. A non-list value counts as absent.
  - Rewrite `effectiveEntries` to three tiers: state entries, then host `essentialTools`, then
    `workflowGrant()`.
  - Remove `isEssential`.
  - Add `opensWorkingAreas(state, tool)`: a host essential tool, or a `DEFAULT_TOOLS` member that some
    effective entry of the state names, guards ignored.
  - Add `grantsAnywhere(tool)`: `disclosedTools` of some declared state contains it.

  Also rewrite the stale doc comments in `machine.ts`, `src/machine/types.ts` (`ToolsBlock`),
  `src/machine/spec-schema.ts` (state tools block, workflow tools config), `src/machine/tool-paths.ts`
  (`SCRATCHPAD_ACCESSES`) and `src/assembly/index.ts` (`essentialTools`: always on whatever the
  workflow declares). Verify with `npm run typecheck`.
- [x] 2.3 Update `src/machine/machine.test.ts`. Keep the tests on specs without `allow_always`
  unchanged as the "absent → defaults" pins, and rename their "essential" wording to "default". In the
  "allow-only governance and allow_always" block, turn "treats an allow_always constraint on an
  essential tool as inert" into "enforces …". Add tests for:
  - a declared list grants exactly its entries (`write_file` neither disclosed nor permitted under
    `[read_file, ls]`);
  - `[]` discloses only the controls;
  - a state entry grants an omitted default tool in that state only;
  - host `essentialTools` survive a declared list;
  - `opensWorkingAreas` with a narrowing entry, with a state-only grant and with no grant;
  - `grantsAnywhere` honouring a bare `forbid_always`.

  Verify with `npx vitest run src/machine/machine.test.ts src/machine/tool-names.test.ts`.
- [x] 2.4 Fix the other tests whose inline spec declares `tools.allow_always` and relies on the
  built-ins. Make these prove the new rule:
  - `src/sandbox/ptc-gateway.test.ts`: `SURFACE_SPEC` and the test that expects `read_file` and
    `write_file` in the surface;
  - `src/behaviour/governance.test.ts`: "grants a tool in every state through allow_always" now also
    asserts that the built-ins are absent.

  Add the default list to the remaining specs so they keep testing what they were written for:
  `behaviour/governance.test.ts` "tools.forbid on a state" and `src/kernel/kernel.pipeline.test.ts`
  (`allow_always: [{tool: write_file}]`, `read_file` on `skills/**` and `catalogs/**`). On
  inspection, these needed no list. Each asserts only about the tool its `allow_always` names, and
  the "deliberately wide" `read_file` grants are now enforced rather than inert, so the tests prove
  what their names say. Verify with `npm test`; everything else is green at this point.
- [x] 2.5 Document the rule in `docs/`:
  - `reference/machine-spec.md`: the tool-governance section (:240-307), the
    `### tools.allow_always` section (:1133-1150; drop "inert … validate warns", add absent vs declared
    with an example listing the default tools), the `archmax_run` note (:416-419) and the forbid
    wording (:1205-1208);
  - `guides/workflow-machine.md`: "present in every state" (:180-201), the YAML comment (:217-218),
    :259-267 and :526-528;
  - `guides/code-interpreter.md` (:20-21, :112-122, :159-165): the sandbox tools are default tools,
    granted like any other;
  - `guides/skills.md` (:89-95): `tools.allow_always: []` now means the same as `skills.allow_always: []`;
  - `reference/glossary.md`: add **default tools**, and redefine **always-on tools** as the
    workflow-wide grant (or the default tools), the host's `essentialTools` and the control tools.

  Verify with `npm run docs:build` and a `grep -rn "always-on\|essential" docs/src/content/docs` that
  turns up no stale claim (historical changelog entries excepted).
- [x] 2.6 Update the authoring skill's governance teaching. In
  `skills/archmax-harness/references/workflow-schema.md`, change the `allow_always` field comment
  (:148-149), the state `tools.allow` note (:330-337), the no-`tools`-block note (:669-674), the
  always-on paragraph (:749-786), the precedence list (:797-813; step 4 becomes "the workflow-wide
  grant: declared `allow_always`, else the default tools") and :815-817. In
  `references/workflow-yaml.md`, rewrite the "Always on, never declared" governance passage
  (:255-262). Update `references/backend-integration.md` (`essentialTools` row :103, :683-684) and
  `references/hook-and-test-scripts.md` (:276-279, :778-779). Verify with a grep of
  `skills/archmax-harness` for "always on" and "essential" that turns up only the host
  `essentialTools` option and the control tools.

## 3. Open areas follow the grant (kernel)

- [x] 3.1 In `src/kernel/kernel.ts`, have `runOpenAccessRule` call
  `machine.opensWorkingAreas(action.state, action.tool)`, falling back to `DEFAULT_TOOLS.has(tool)` with
  no machine. Rewrite its doc comment and the reply-only rule comment (:325-332). Verify with
  `npm run typecheck`.
- [x] 3.2 Add kernel tests in `src/kernel/kernel.paths.test.ts`, keeping the existing
  `tool.scratchpad`/`tool.offload-read` tests unchanged:
  - with `allow_always: [read_file]`, `write_file` on `scratchpad/a.md` is `tool.not-allowed` in a
    state that does not name it, and `tool.scratchpad` in a state granting
    `{ tool: write_file, paths: [reports/**] }`;
  - `read_file` on `large_tool_results/x` is `tool.offload-read` only where `read_file` is granted;
  - a host essential tool stays open under a declared list.

  Verify with `npx vitest run src/kernel/`.
- [x] 3.3 Update the scratchpad wording to "open in every state to the file tools that state is
  granted":
  - docs: `reference/machine-spec.md` (:94-97, :273-275), `guides/workflow-machine.md` (:255-257,
    :405), `reference/public-api.md` (:810, :883-886);
  - skill: `SKILL.md` (:214-217) and `references/backend-integration.md` (:683-684, if not done in 2.6);
  - `AGENTS.md`: the sandbox line ("always-on in every state") and the scratchpad line.

  Verify with `npm run docs:build`.

## 4. Lint and validate

- [x] 4.1 In `src/machine/lint-spec.ts`, per design D4:
  - remove the essential-tool `allow_always` warnings and the stale `task` comment;
  - add the "declared `allow_always`, no default tool granted anywhere" warning at
    `tools.allow_always`, naming the default tools, the replacement rule and offloaded tool results;
  - extend the scratchpad-only narrowing warning to `allow_always` entries, with "permitted wherever
    the tool is granted" wording.

  Verify with `npm run typecheck`.
- [x] 4.2 In `src/validate/validate.test.ts`, replace "warns when tools.allow_always names an essential
  tool" with tests that:
  - the new warning fires for `allow_always: []` and for `allow_always: [lookup]`;
  - it is silent once any state's `tools.allow` names a default tool, and when the key is absent;
  - `read_file` and a guarded `write_file` in `allow_always` draw no warning;
  - a scratchpad-only guard in `allow_always` draws the narrowing warning.

  Verify with `npx vitest run src/validate/ src/machine/`.
- [x] 4.3 In `skills/archmax-harness/references/diagnostics.md`, replace the "constrains essential
  tool" row (:31) with a row for the new warning and its two fixes: list the default tools, or remove
  the key. Verify the row's wording matches the emitted message.

## 5. The prompt follows the grant

- [x] 5.1 In `src/assembly/compose.ts`, install `todoMiddleware()` only when
  `machine.grantsAnywhere("write_todos")`, and update its doc comment. Add an assembly or behaviour
  test: a workflow with `allow_always: [read_file, ls]` has no `write_todos` section in the system
  prompt and never offers the tool, while one without `allow_always` keeps both. Verify with that
  test and with the existing `src/behaviour/upstream-additions.test.ts`.
- [x] 5.2 Reword `src/core/platform-prompt.md` ("`scratchpad/`, always writable, is only the default";
  "`archmax_eval(…)`, in every state, runs …") so it promises no particular tool, and regenerate with
  `npm run generate:prompt`. Change the `scratchpad/` bullet in `src/core/workspace-prompt.ts` to
  "readable and writable in every state with the file tools that state is granted". Fix the tests
  that pin these strings (`grep -rn "Always readable and writable\|always writable" src`). Verify
  with `npm test`, including the generated-prompt equality test.
- [x] 5.3 Update the `write_todos` docs: `reference/machine-spec.md` (:1305-1309) and
  `guides/token-efficiency.md` (:20-28) say `write_todos` and its guidance are present when the
  workflow grants it, as the default tools do. Verify with `npm run docs:build`.

## 6. Examples, the skeleton and the README

- [x] 6.1 In `examples/customer-support/workflows/order-lookup/workflow.yaml`, add
  `tools.allow_always` listing all twelve default tools (file tools, file operations, `write_todos`,
  `archmax_eval`, `archmax_run`) beside `forbid_always: [archmax_reset]`. Rewrite the comments at
  :40-44, :202-203 and in `enrich-order` (:352-357: "narrows the workflow-wide `archmax_run` grant
  here"). Do the same for `examples/customer-support/workflows/enrich-order/workflow.yaml`: a new root
  `tools` block, with the comment at :90-93 rewritten. Verify with
  `npm run dev -- validate order-lookup --root examples/customer-support` and the same for
  `enrich-order`, both with no new warning, and with `npm test` (the suites that load the examples).
- [x] 6.2 Replace `allow_always: []` in the skeleton in
  `skills/archmax-harness/references/workflow-yaml.md` (:29-31) with the twelve default tools and a
  comment: the default tools, remove only what this workflow must not have, add workflow-wide tools
  here and state-specific ones under a state's `tools.allow`. Also update the state `allow` comments
  ("narrows an always-on tool", "beats every grant incl. the always-on surface"). In `SKILL.md`,
  have the "Write `workflow.yaml` from the skeleton" step (:80) say that a new workflow keeps the
  default tools listed. Verify by validating a workflow pasted from the skeleton in a scratch
  workspace: `archmax validate` reports no error and no default-tool warning.
- [x] 6.3 In `README.md`, update the `workflow.yaml` excerpt (:74-81) to show the explicit
  `tools.allow_always`, and add one sentence on the rule (absent → default tools, declared → exactly
  what it lists). Verify that the excerpt still matches `order-lookup/workflow.yaml`.
- [x] 6.4 Add a **Breaking** entry to `docs/src/content/docs/reference/changelog.md`, in the top
  unreleased section (see design Open Questions). It covers:
  - a declared `tools.allow_always` replaces the default tools;
  - the scratchpad and offload areas follow the grant;
  - the removed and added warnings;
  - `write_todos` guidance follows the grant;
  - `ESSENTIAL_TOOLS` → `DEFAULT_TOOLS`;
  - the migration (list the default tools, or remove the key).

  Verify with `npm run docs:build`.

## 7. Integration

- [x] 7.1 Add a behaviour test (`src/behaviour/default-tools.test.ts`, beside 5.1's, scripted fake
  model, public barrel) for a two-state workflow with `allow_always: [read_file, ls]`, where state `draft` grants
  `{ tool: write_file, paths: [reports/**] }`. Assert:
  - disclosure per state;
  - `write_file` and `archmax_eval` are refused with `tool.not-allowed` outside `draft`;
  - `scratchpad/` is writable in `draft` only;
  - a `before` script hook still runs.

  Verify with `npx vitest run src/behaviour/`.
- [x] 7.2 Run the full gate: `npm run typecheck`, `npm test`, `npm run build`, `npm run docs:build`,
  `npx -y @fission-ai/openspec validate explicit-always-on-tools --strict`, and
  `npx -y @fission-ai/openspec validate --specs`. Everything must be green.

## Workflow follow-up

- Rebase onto `main` once PR #43 (`fix/hook-mount-grants`) merges, and settle the changelog section
  then.
- Sync the delta specs and archive the change after review (`/opsx:archive`).
