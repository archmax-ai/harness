# Tasks

## 1. The control and the split control sets

- [x] 1.1 Add `ADD_MESSAGE_TOOL` (`archmax_add_message`) to `src/machine/tool-names.ts`, split the
      automated sets into the grader's controls and the code state's (the grader's plus
      `archmax_add_message`), add it to the grader's withheld tools and to `HARNESS_CONTROL_TOOLS`.
      Verify `src/machine/tool-names.test.ts` and `src/machine/machine.test.ts` assert the two
      sets, the grader's withheld tool, and that the kernel permits it in a code state only.
- [x] 1.2 Make the withheld-tool error in `src/machine/lint-spec.ts` name why a grader is never
      offered `archmax_add_message`. Verify a lint test: a grader state whose `tools.allow` names it
      is an error at that entry, and a code state's is not.

## 2. Recording, committing and reporting a code state's messages

- [x] 2.1 In `src/workflow/automated-controls.ts`, give the step recorder `messages` and an `add`,
      and add the `archmax_add_message` tool (schema `{ text }`, blank refused) where the state's
      controls offer it. Verify `src/workflow/automated-controls.test.ts`: the tool exists for a
      code state and not for a grader, records messages in order with ids, refuses blank text, and
      is accepted after a decision.
- [x] 2.2 In `src/workflow/automated.ts`, carry the recorded messages in the outcome unless the run
      failed, and emit one `agent-text { state, text, messageId }` per carried message after the
      script's `code-output` and before `code-result`; in `src/workflow/middleware.ts`, commit them
      as assistant messages after the marker's removal and before the runtime note. Verify the
      behaviour suite (`src/behaviour/automated-states.test.ts`): a terminal code state answers with
      no model call (`reply`, transcript, one `agent-text` whose `messageId` is the transcript id);
      messages precede the move's note and reach the agent's next model call; a raise keeps them; a
      throw discards them (no transcript message, no event); a blank call is caught and nothing is
      added; a later code state reads them as `assistant` in its history while the adding run's own
      history holds none; the event order of the observability scenario.
- [x] 2.3 Update the typed surface's docs in `src/public/sandbox.ts` (the controls a code state's
      `tools` holds). Verify `npm run typecheck` passes.

## 3. Documentation, README and the authoring skill

- [x] 3.1 Update `docs/`: `guides/automated-states.md` (a code state's messages: the control, when
      they commit, how they read, an example that answers without a model call),
      `reference/machine-spec.md`, `reference/public-api.md`, `guides/workflow-machine.md` and
      `guides/code-interpreter.md` where they list a code state's controls,
      `reference/glossary.md` (control tools), and a 2.3.0 section in
      `reference/changelog.md`. Verify `npm run docs:build` passes and every page names the control
      the same way.
- [x] 3.2 Update `README.md` where it describes code states: a script can add a message to the
      session. Verify the README's code-state example and prose agree with the guide.
- [x] 3.3 Update `skills/archmax-harness/`: `references/code-states-and-scripts.md` (the
      control's contract and an example), `references/workflow-schema.md` (the tool table) and
      `SKILL.md` (the checks-are-states patterns).
      Verify a search for `archmax_get_history` across `skills/` finds no control list that lacks
      `archmax_add_message` for a code state.

## 4. Integration checks

- [x] 4.1 Run `npm run typecheck`, `npm test`, `npm run lint` and `npx openspec validate --specs`;
      all pass.

## Workflow follow-up

- Archive the change (`openspec archive code-state-messages`) and verify the merged specs validate.
- Open the pull request labelled `release:minor` and merge it once its checks pass.
