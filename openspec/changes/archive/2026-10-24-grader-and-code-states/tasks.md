# Tasks

## 1. Schema, machine and lint

- [x] 1.1 Add `grader` and `code` to `stateTypeSchema`. Add the `script` key with its
      `scripts/` path grammar. Remove `before`/`after`, the hook and rubric schemas, and the root
      `extensions` block from `src/machine/spec-schema.ts` and `types.ts`. Verify with
      `spec-schema.test.ts`: a leftover `before`/`after`/`extensions` fails with the
      unrecognized-key error naming its path.
- [x] 1.2 Add `refineSpec` rules: a code state must declare `script`, and no other type may.
      Verify with schema tests for both errors.
- [x] 1.3 Make `WorkflowMachine` type-aware: `stateType`, `isAutomatedState`, `isCodeState`,
      `isGraderState`, the control set per type (`archmax_get_history` for graders), the
      automated essential set without `write_todos`/`archmax_eval`/`archmax_run`, and
      `effectiveEntries` dropping agent-only tools. Remove `lifecycleHooks()`. Verify with
      `machine.test.ts` cases for each type's `disclosedTools` and `checkAllowed`.
- [x] 1.4 Add `GET_HISTORY_TOOL` to `src/machine/tool-names.ts` and `HARNESS_CONTROL_TOOLS`, plus
      the `AGENT_ONLY_TOOLS` constant. Verify with `tool-names.test.ts`.
- [x] 1.5 Add `lint-spec.ts` errors:
      - Code: `instructions`, `model`, `budget`, `evidence` or `approvers` declared.
      - Grader: `evidence`, `approvers` or `budget.maxParks` declared; missing instructions; no
        transitions.
      - Any automated state: a grant of an agent-only tool.
      - Drop the human-state hook lint.
      Verify with `lint-spec.test.ts`.

## 2. Kernel

- [x] 2.1 Remove `HookFact`, `reduceHookFact`, the `enter-state` action and `hookFacts`. The
      `transition` action is `requires` plus the edge. Verify with `kernel.test.ts`.
- [x] 2.2 Rename the `lifecycle` origin to `runtime`, used only by the `file`-value check, and
      reword the mount and skill refusals. Update the `task` refusal text. Verify with
      `kernel.test.ts`, `kernel.pipeline.test.ts` and `file-values.test.ts`.

## 3. Sandbox

- [x] 3.1 Add the `code` prelude context: contract marker, `defineCodeState`, the scoped `tools`
      view shared with `ptc`. Remove the `lifecycle-hook` context and the `parts/core.js` and
      `parts/lifecycle-hook.js` verdict helpers. Verify with `prelude.test.ts`.
- [x] 3.2 In the scoped `tools` view, `get` resolves only names inside the surface. Verify with
      `executor.test.ts` and `ptc-governance.integration.test.ts`: a name outside the surface is
      `undefined`.
- [x] 3.3 Add `executor.runCodeState(path, { sessionId, args, tools, surface, signal })`, which
      runs in a fresh `code` namespace disposed after the run. Rename `prepareHookSource` to
      `prepareScriptSource`, which writes `__stateDef`. Verify with `executor.test.ts` and
      `imports.test.ts`.
- [x] 3.4 Runtime contract `3` only, as the default, with sandbox contexts `ptc | code`. Verify
      with `contract.test.ts`.
- [x] 3.5 Allow the agent origin in the PTC gateway (the grader's calls). Verify with
      `ptc-gateway.test.ts`.

## 4. Automated-state runtime

- [x] 4.1 `src/workflow/history.ts`: the history view `{ messages, trail }`, moved from
      `lifecycle/transcript.ts` and no longer windowed. Verify with its unit test.
- [x] 4.2 Factor `transitionUpdate` out of `handleAdvance`, used by agent and automated moves.
      Trail kinds `grader`/`code`, note kinds `grader`/`code`, and the `iterations`/`beforeDone`
      channels removed from `state.ts`, the turn boundary and `archmax_reset`. Verify with
      `control-tools.test.ts` and `state.test.ts`.
- [x] 4.3 `src/workflow/automated-controls.ts`: the step recorder and its control tools
      (advance, raise, get/set variables, get history). Verify with unit tests: validation,
      one decision, variable writes.
- [x] 4.4 `src/workflow/code-state.ts`: run a code state (tools from the surface through the
      gateway, `code-*` events, outcome). Verify with behaviour tests.
- [x] 4.5 `src/workflow/grader-state.ts`: the grader subagent. Covers the preamble and task, the
      governed tools with substitution and error answers, stopping on a decision, budgets,
      usage events, no streaming and no checkpoint. Verify with behaviour tests using a scripted
      grader model.
- [x] 4.6 `src/workflow/automated.ts`: run the step and build or read the marker outcome. Wire
      it into `governance.wrapModelCall` (serviced in place of the model call), `afterModel`
      (commit, note, jump, completion and failure routing) and `beforeModel` (no turn budget in
      an automated position). Verify with behaviour tests for chaining with no model call,
      human targets, raise, failure routing and completion.
- [x] 4.7 Events: add `code-*`/`grader-*`, remove `hooks-summary`/`hook-*`/`rubric-*`, and update
      console lines and levels. Render code and grader runs in the CLI state flow. Verify with
      `events.test.ts` and `state-flow.test.ts`.
- [x] 4.8 Prompt: the platform prompt and the `archmax_advance` description drop hooks. The graph
      section marks grader and code targets and no longer renders hooks. Regenerate
      `platform-prompt.generated.ts`. Verify with `render-prompt.test.ts` and `prompt.test.ts`.

## 5. Removal and assembly

- [x] 5.1 Delete `src/lifecycle/` and `src/rubrics/`, the `hookExecutors` option, the rubric
      subagent registration and `runContextFromMessages`. Rename the `rubric` model role to
      `grader`, with per-state grader models resolved per composition. Verify with
      `npm run typecheck` and `assembly.test.ts`.
- [x] 5.2 Public barrels: drop the hook and rubric exports, export the new types, and update
      `@archmax-ai/harness/sandbox` (`CodeStateInput`, `defineCodeState`, `HistoryMessage`).
      Verify with the public-API test against `docs/.../reference/public-api.md`.
- [x] 5.3 `validate`: check that a code state's script exists in `scripts/` and imports only
      `@archmax-ai/harness/*`. Drop the hook and extension checks and update the kernel probes.
      Verify with `validate.test.ts`.
- [x] 5.4 Replace `src/behaviour/hooks.test.ts` with `automated-states.test.ts`. Update the other
      behaviour, unit and case tests that used hooks or rubrics. Verify with `npm test`.

## 6. Reference workspace

- [x] 6.1 Convert `examples/customer-support/workflows/order-lookup`: the `screen-request` code
      state (`scripts/screen-request.js`), `decline`, `check-refund` (`scripts/check-refund.js`),
      the `review-reply` grader and the terminal code state `answered`
      (`scripts/answered.js`). Delete `hooks/`, set `runtime.version: "3"` and update
      `WORKFLOW.md`. Verify that
      `npm run dev -- validate order-lookup --root examples/customer-support` reports it clean.
- [x] 6.2 Update the order-lookup cases for the new states: veto cases reach `decline`, refund
      cases pass `check-refund`, reply cases pass `review-reply`. Verify with
      `npm run dev -- test order-lookup --root examples/customer-support`, which parses every
      case.

## 7. Documentation, README and authoring skill

- [x] 7.1 Update the docs site:
      - New `guides/automated-states.md` (grader and code states), replacing
        `guides/grading-rubrics.md`.
      - Updated `guides/workflow-machine.md`, `guides/code-interpreter.md`,
        `guides/authoring-plane.md` and every other guide that mentions hooks.
      - Updated `reference/machine-spec.md`, `reference/public-api.md` and
        `reference/glossary.md`.
      - A major `reference/changelog.md` entry with the migration recipe.
      Verify with `npm run docs:build`.
- [x] 7.2 README.md: replace the hook and rubric sections with grader and code states. Verify
      that no hook vocabulary is left (`grep -n "hook" README.md`).
- [x] 7.3 `skills/archmax-harness/`: update `SKILL.md`, `references/workflow-schema.md` and
      `references/workflow-yaml.md`, the script references (rewritten for code-state scripts),
      `references/backend-integration.md` and `references/diagnostics.md`. Verify that a grep
      finds no `before:`/`after:`/`rubric` authoring guidance left.
- [x] 7.4 AGENTS.md and `openspec/config.yaml`: the vocabulary line, the hooks contract section
      (now automated states) and the directory map. Verify by reading.

## 8. Integration

- [x] 8.1 `npm run typecheck`, `npm run lint` and `npm test` all pass.
- [x] 8.2 `npm run build`, `npm run docs:build` and `openspec validate grader-and-code-states`
      all pass.

## Workflow follow-up

- Archive the change with `/opsx:archive`, which syncs the delta specs into `openspec/specs/`.
  Then remove the emptied `grading-rubrics` capability and validate the specs.
