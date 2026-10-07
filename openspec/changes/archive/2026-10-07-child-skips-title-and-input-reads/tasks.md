## 1. Runtime

- [x] 1.1 In `src/core/platform-prompt.md`, wrap the "Name the run first" step and the "Naming the run" paragraph in `<!-- top-level-only -->` / `<!-- /top-level-only -->` lines and run `npm run generate:prompt`. Verify that the top-level rendering equals the v0.3.1 prompt byte for byte.
- [x] 1.2 In `src/core/prompt.ts`, add `platformPromptFor(text, session)` (marker lines removed for a top-level session; passages removed and the cut list renumbered for a child; an unclosed marker leaves the rest in place) and apply it in `readPlatformPrompt` to the bundled prompt and to an override; `resolveSystemPrompt` takes `child`. Verify with the unit tests in 2.1.
- [x] 1.3 In `src/workflow/control-tools.ts`, `createControlTools({ child })` leaves the `title` sentence out of `archmax_set_variables`' description; thread `child` through `createWorkflowInstrumentation` (`src/workflow/middleware.ts`). Verify with the unit tests in 2.3.
- [x] 1.4 In `src/assembly/compose.ts` and `src/assembly/delegation-registry.ts`, render a child composition's system prompt and control tools with `child: true`; the root composition passes nothing. Verify with the behaviour tests in 2.4.
- [x] 1.5 In `src/workflow/sub-workflow.ts`, replace `SUB_RUN_OPENING` with `subRunOpening(params)`: scalars JSON-quoted (U+2028/U+2029 escaped) or as written, alphabetical, at most 200 characters each and 1,000 in all; the rest named with `archmax_get_variables`. Verify with the unit tests in 2.2.

## 2. Tests

- [x] 2.1 `src/core/prompt.test.ts`: a top-level session reads the Markdown less its marker lines; a child's platform layer has no `title`, no marker and a movement list numbered 1–3, and otherwise keeps every line; an override with markers and one without; `platformPromptFor` on lists, continuation lines, padded markers and an unclosed marker. Verify with `npx vitest run src/core/prompt.test.ts`.
- [x] 2.2 `src/workflow/sub-workflow.test.ts`, "the opening note": all scalars shown and no reading mentioned; no arguments; a string with a line break, a list-item and a heading stays one JSON literal on its line; structured, `null` and non-finite values named; the per-value and total bounds. Verify with `npx vitest run src/workflow/sub-workflow.test.ts`.
- [x] 2.3 `src/workflow/control-tools.test.ts`, "set-variables tool declaration": a top-level session is asked for a title, a child is not, and the rest of the description is the same. Verify with `npx vitest run src/workflow/control-tools.test.ts`.
- [x] 2.4 `src/behaviour/support.ts`: `ModelCall` records each call's human-message texts and tool descriptions. `src/behaviour/delegation.test.ts`, "what a child's model is handed": the child's first call gets the inputs' values, a platform layer with no `title` and step `1. Do the current state's work.`, and a set-variables description with no `title`, and the child holds no title and emits no `title-set`; the caller's two calls keep step 1, the paragraph and the title sentence, byte-identical; a structured input is named. Verify that the two child tests fail against the v0.3.1 runtime and that all three pass here (the caller's test pins what must not change).

## 3. Docs and authoring skill

- [x] 3.1 `docs/src/content/docs/guides/sub-workflows.md`: a "What the child's model reads" section (the opening note, its bounds and quoting, no title step, the override markers); the passages on a child's inputs and title.
- [x] 3.2 `docs/src/content/docs/guides/workflow-machine.md` (the reserved `title`, the override note), `guides/triggers.md`, `guides/token-efficiency.md` (layer 3 and the rendering list), `reference/public-api.md` (the `opening` kind, `title-set`), `contributing/development.md` (the markers).
- [x] 3.3 `skills/archmax-harness/references/workflow-schema.md` (the reserved `title`, a child's inputs and prompt), `references/workflow-yaml.md`, `references/backend-integration.md`.
- [x] 3.4 Confirm that README.md needs no change. Verify with a grep for `title` and `child`.
- [x] 3.5 `docs/src/content/docs/reference/changelog.md`: an entry under the next release, with the note for override authors and hosts.

## 4. Verify and release

- [x] 4.1 Run `npm run typecheck`, `npm test`, `npm run docs:build` and `npx openspec validate child-skips-title-and-input-reads --strict`. All pass.
- [x] 4.2 Run a delegating workflow with a one-state child against a live model and confirm the child makes no `archmax_set_variables` call for `title` and no `archmax_get_variables` call before its work.
  - Run on 7 October 2026: `npm run dev -- run order-lookup "Enrich the requested orders." --trigger enrichment_requested --variables '{"orders_to_enrich":[{"order_id":"ORD-1002"}]}' --root examples/customer-support --session live-child-1 --verbose`, model `anthropic/claude-sonnet-5`.
  - The child (`enrich-order`, state `enrich`) called `read_file` (`skills/order-data/SKILL.md`, then `orders.json`), `archmax_set_variables` once (`enrichment_file` and `delayed`, no `title`), `write_file` (`scratchpad/enrichment/ORD-1002.json`) and replied. It made no `archmax_get_variables` call. The sub-run completed in 11.4 s and the caller recorded `enrichments` and advanced.
  - Before the run, `enrich-order`'s instructions told the child to "Read `order_id` with archmax_get_variables"; they now say the opening message gives it, since an authored instruction would otherwise ask for the call this change removes.
- [ ] 4.3 Open a PR with the `release:minor` label (`0.4.0`, together with `governed-file-operations` and `missing-returns-come-back-with-a-note`).
