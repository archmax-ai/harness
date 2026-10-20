# Tasks

## 1. Schema and load errors

- [x] 1.1 In `src/machine/spec-schema.ts`, make the transition `description` optional, keeping an
  error for a non-string value. Add two `refineSpec` checks, both addressed to
  `states.<slug>.transitions.<index>.description` (design D2):
  - an undescribed edge (absent, empty or blank) whose target has no non-blank `instructions`;
  - an undescribed transition on a `type: human` state: the description is the decision's button
    label.

  Rewrite the `TRANSITION_DESCRIPTION` rationale comment and message. Update the `MachineTransition`
  doc in `src/machine/types.ts`, and the two stale comments in `src/machine/lint-spec.ts` (:250-251,
  :266-267). Verify with `npm run typecheck`.
- [x] 1.2 Add tests to `src/machine/spec-schema.test.ts` (and the lint/validate tests that pin the old
  message) covering:
  - `{ to: lookup }` and `description: "  "` load when `lookup` has instructions;
  - both fail at the `description` path when `lookup` has none or only blank ones;
  - a numeric description fails whatever the target;
  - a human state's undescribed transition fails even when the target has instructions.

  Fix the existing "missing description" tests to the new rule. Verify with
  `npx vitest run src/machine/ src/validate/`.

## 2. Transparent rendering

- [x] 2.1 In `src/workflow/render-prompt.ts`, change `renderTransition` so that, for an undescribed
  edge, it emits the D3 format: the framing sentence on the bullet line, then each instruction line
  quoted under it (`  > `, with blank lines as `  >`). Described edges stay byte-identical. Update the
  module and function doc comments (the "nothing of the target's … instructions" claims). Verify with
  `npm run typecheck`.
- [x] 2.2 Add tests to `src/workflow/render-prompt.test.ts` covering:
  - a described edge is unchanged;
  - an undescribed edge carries the target's trimmed instructions, quoted, with the framing
    sentence, and none of the target's `title`, `summary` or hooks;
  - markers and `type` are still rendered;
  - a multi-paragraph body keeps its blank lines as `  >`;
  - an undescribed edge into a human state carries its instructions and not its approvers.

  Verify with `npx vitest run src/workflow/render-prompt.test.ts`.
- [x] 2.3 Add a behaviour test (`src/behaviour/`, scripted fake model, public barrel). Use a
  two-state workflow whose first state has one undescribed edge. Assert that the recorded model
  call's "Current state" block carries the target's instructions under the edge line with the
  framing sentence. Assert that `archmax_advance` to that target succeeds. Verify with
  `npx vitest run src/behaviour/`.

## 3. Docs, skill, changelog

- [x] 3.1 Update `docs/src/content/docs/reference/machine-spec.md` (the transitions section:
  `description` optional, the undescribed rule, the two load errors, and that an undescribed edge
  into a human state discloses its reviewer-facing instructions) and
  `docs/src/content/docs/guides/workflow-machine.md` (where it explains what the agent routes on).
  Add a non-breaking entry to `reference/changelog.md` in the top unreleased section. Verify with
  `npm run docs:build`.
- [x] 3.2 Update the authoring skill:
  - `skills/archmax-harness/references/workflow-yaml.md`: the skeleton's transition comments say
    `description` may be omitted when the target's instructions say enough;
  - `references/workflow-schema.md`: the transition shape `{ to, description?, type? }`, the
    disclosure rule, and that human-state transitions need one;
  - `references/diagnostics.md`: rows for the two load errors.

  Check `README.md` for any claim that edges must be described, and fix it if there is one. Verify
  with `grep -rn "description" skills/archmax-harness` that no line still calls an edge's
  description required for agent states.

## 4. Integration

- [x] 4.1 Run `npm run typecheck`, `npm test`, `npm run docs:build`,
  `npm run dev -- validate order-lookup --root examples/customer-support` and
  `npx -y @fission-ai/openspec validate optional-edge-descriptions --strict`. Everything must be
  green, and the example workflows render unchanged.

## Workflow follow-up

- Sync the delta specs and archive after review (`/opsx:archive`). This change is independent of
  `explicit-always-on-tools` but ships on the same branch.
