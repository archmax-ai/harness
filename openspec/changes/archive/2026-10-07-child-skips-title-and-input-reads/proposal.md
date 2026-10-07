## Why

A sub-workflow child spends two model calls on bookkeeping before it does its work.

A consumer measured it on 5–6 October 2026. On the archmax platform, a `supplier-communication`
session's state `run-invoice-lookup` called `archmax_workflow_invoice-lookup` twice in parallel.
`invoice-lookup` has one state and declares two returns. Each child took about 30 s: five model
calls in a row, 0.5–10 s each. The child set `title`, read its inputs, set its returns (one child
twice), and wrote its closing message. The first two calls bought nothing:

- **The title.** The platform prompt tells every agent, a child included, to name the session
  first: "This is step 1 above, and it is not optional". A child's title is never returned (a
  trigger's `returns` may not declare it), and the platform ignores a `title-set` from inside a
  dispatch. `archmax_set_variables`' own description says "set it early" as well.
- **The inputs.** A child's prompt lists its input names but not their values ("Run variables
  set: … Read one with archmax_get_variables."), and its fixed opening line tells it to "read
  any input you need with archmax_get_variables". The caller already held every value.

## What Changes

- **A child's prompt does not ask it to name its session.** The platform prompt marks the "Name
  the run first" step and the "Naming the run" paragraph as top-level only
  (`<!-- top-level-only -->` … `<!-- /top-level-only -->`). A child session's platform layer
  leaves the marked passages out and renumbers the movement list; a top-level session reads the
  text with only the marker lines removed, so its prompt and its cacheable prefix are
  byte-identical to before. A workspace override is read by the same rule: one with the markers
  gets the same omission, one without them reads the same in both sessions.
- **A child's `archmax_set_variables` description asks for no title.** The sentence about the
  reserved `title` is left out of the child's tool description; a top-level session's
  description is unchanged.
- **A child's opening message carries its inputs' values.** The fixed `opening` line becomes a
  message rendered from the call's arguments: each string (JSON-quoted), finite number or
  boolean whose rendering is at most 200 characters, by name in alphabetical order, while the
  values shown stay within 1,000 characters in all. An input not shown (a structured value,
  `null`, one past either bound) is named, with `archmax_get_variables` as the way to read it.
  The message mentions reading only when it names such an input.
- The child's title is not seeded. A caller that wants one still passes `title` down as an
  argument, which lands unlocked as before.
- **For hosts:** a child session emits no `title-set` unless its caller passed a `title`. The
  `opening` note's text changes; its kind and shape do not.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `delegation`: "The child is its own session, seeded with the call's arguments only" says what
  the opening note carries in place of "one fixed `opening` runtime note"; a new requirement, "A
  child session is not asked to name itself", covers the platform layer's top-level-only
  passages (bundled and overridden) and the set-variables description.

## Impact

- **Code:**
  - `src/core/platform-prompt.md` (and the generated module): the two title passages wrapped in
    `top-level-only` markers.
  - `src/core/prompt.ts`: `platformPromptFor(text, session)`, applied to the bundled prompt and
    to an override; `resolveSystemPrompt` takes `child`.
  - `src/assembly/compose.ts`, `src/assembly/delegation-registry.ts`: a child composition renders
    its system prompt and its control tools with `child`.
  - `src/workflow/control-tools.ts`, `src/workflow/middleware.ts`: `createControlTools({ child })`.
  - `src/workflow/sub-workflow.ts`: `subRunOpening(inputs)` replaces `SUB_RUN_OPENING`.
- **Tests:** unit tests in `src/core/prompt.test.ts`, `src/workflow/sub-workflow.test.ts`,
  `src/workflow/control-tools.test.ts`; a behaviour test in `src/behaviour/delegation.test.ts`
  ("what a child's model is handed"), with `ModelCall` in `src/behaviour/support.ts` recording
  the human messages and tool descriptions of each call.
- **docs/:** `guides/sub-workflows.md` (a new "What the child's model reads" section, and the
  passages on a child's inputs and title); `guides/workflow-machine.md` (the reserved `title`, the
  override note); `guides/triggers.md`; `guides/token-efficiency.md`;
  `reference/public-api.md` (the `opening` note kind, `title-set`);
  `contributing/development.md` (the markers); `reference/changelog.md` (an entry under
  `0.4.0`).
- **examples/customer-support/:** `enrich-order`'s instructions point at the opening message for
  `order_id` instead of telling the child to read it with `archmax_get_variables`.
- **README.md:** no update. It does not describe a child's prompt, its inputs or its title.
- **skills/archmax-harness/:** `references/workflow-schema.md` (the reserved `title`, a child's
  inputs and prompt), `references/workflow-yaml.md`, `references/backend-integration.md`.
- **Release:** ships in `0.4.0` (`release:minor`) with `governed-file-operations` and
  `missing-returns-come-back-with-a-note`; on its own it would be a patch. A workspace that overrides
  the platform prompt should wrap its own title step in the markers to get the saving for its
  children.
