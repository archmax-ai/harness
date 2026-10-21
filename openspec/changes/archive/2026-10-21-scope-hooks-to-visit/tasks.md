## 1. Reproduce

- [x] 1.1 Add a behaviour test for the ticket's repro in `src/behaviour/hook-visit.test.ts`: a state allowing `lookup`, whose `after` hook vetoes unless `messages` holds a `lookup` entry. One turn calls `lookup`, makes twelve `archmax_get_variables` calls, then advances. Verify it fails on the current code (the advance is refused). It must pass once section 4 lands.

## 2. The visit log

- [x] 2.1 Add the `visits` channel (`{ state, from: TurnAnchor }[]`, appending) to `src/workflow/state.ts`, and a reader that returns a visit's message span and attributes a message index to its visit, including the fallback for a session with no log (visit 1 from the start, at `entryState`). Verify with unit tests: id anchor, count fallback after the id is gone, empty log.
- [x] 2.2 Append a visit at each entry, with the anchor design.md gives: advance and reset (`control-tools.ts`), `on_error` (`on-error.ts`, the message before the removed one), a person's decision (`parks.ts`), and a turn boundary that opens a state (`turn-boundary.ts`, before the turn's opening message). Verify with behaviour tests: one per way in starts a new visit, and a continued turn, a delivery and a sub-workflow return do not.

## 3. Hooks read the session's transcript

- [x] 3.1 Pass `request.state.messages` to the `before` hook in `wrapModelCall` (`src/workflow/governance.ts`). Verify with a behaviour test where a summarized transcript reaches a `before` hook and `messages` holds no summary entry. If summarization cannot be triggered in a behaviour test, a unit test over `lifecycleCtx` is enough.

## 4. `messages` is the visit

- [x] 4.1 Slice `ctx.messages` to the current visit before `hookTranscript` in `runPhase` (`src/lifecycle/runner.ts`). Delete `HOOK_TRANSCRIPT_LIMIT`. Tool entries carry `tool` and `id` with `text: ""`. Verify that the repro from 1.1 passes, plus behaviour tests for the spec scenarios "A visit spans turns", "Re-entering a state starts a new visit", "Both hooks of an advance see the visit being left" and "A before hook at the start of a turn sees the person's message".
- [x] 4.2 Give `runContextFromMessages` (`src/core/messages.ts`) the visit's messages for `history` and the whole list for `userRequest`, and delete `HISTORY_WINDOW`. Verify with a rubric behaviour test showing the grader's history starts at the entry and keeps tool results in full.

## 5. `toolCalls`

- [x] 5.1 Build the query: pair calls with `messagesToSessionView`, drop the spec's control tools, attribute each call by the visit of the message that made it, apply `name`/`state`/`visit` (`"current"` included)/`status`/`last`, and return `{ id, name, args, result, status, state, visit }`. Verify with unit tests covering every filter key, a refused call (`rejected`), a call with no result yet (`pending`), and a call made beside `archmax_advance` attributed to the visit it left.
- [x] 5.2 Expose it to hooks only. Add a reserved host tool on the hooks' REPL (`process` namespace) that reads a per-session holder the runner sets before each phase. Keep it out of the `tools` listing and the PTC gateway, and wire `toolCalls` into the hook input in `buildHookCode` (`src/sandbox/executor.ts`). Verify with tests: a hook awaits `toolCalls({ name: "lookup" })` and gets the record; `Object.keys(tools)` doesn't list the query; an `archmax_eval` script finds no `toolCalls`; a hundred `search` results don't enter the hook's input.
- [x] 5.3 Check what `maxResultChars` does to a large query result. If it truncates silently, make the query fail with a reason naming the cap. Verify with a test returning records over the cap.
- [x] 5.4 Add `toolCalls` and a `ToolCallRecord` type to `HookArgs`/`HookInput`, and `id` to `HookMessage`, in `src/public/sandbox.ts`. Update `public-api.md` if the type names are listed there. Verify with `npm run typecheck` and the public-API test.

## 6. Reference workspace and suite

- [x] 6.1 Run the reference workspace's cases (`npm run dev -- test order-lookup --root examples/customer-support`, or the suite's equivalent) and its hooks unchanged. Verify they pass. If one reads beyond its visit, fix the hook, not the rule. _(Done statically: `archmax validate` passes for both workflows, and the two hooks reading `messages` run as `before` hooks when `identify-case` opens, so the request is in their visit. The live cases need a model endpoint and were not run here.)_
- [x] 6.2 Run `npm test` and `npm run typecheck`. Verify both pass.

## 7. Docs and skill

- [x] 7.1 Update the hook input table in `docs/src/content/docs/guides/code-interpreter.md`, the lifecycle-hooks section of `guides/workflow-machine.md` (the visit, `toolCalls` with an example, and the rule that the conversation is memory while tool results, variables and files are the records hooks read), and the transcript paragraph in `reference/public-api.md`. Verify with `npm run docs:build`.
- [x] 7.2 Update `guides/grading-rubrics.md` where it describes the grader's payload, and add a **visit** entry to `reference/glossary.md`. Verify with `npm run docs:build`.
- [x] 7.3 Add a 0.9.0 changelog entry in `reference/changelog.md`, marked breaking: what `messages` held before and holds now, `toolCalls`, the rubric `history`, and the migration (read tool results through `toolCalls`, store what later states need). Verify with `npm run docs:build`.
- [x] 7.4 Update `skills/archmax-harness/references/hook-and-test-scripts.md` and `references/hooks-and-scripts.md` (the input tables, a `toolCalls` example, the visit rule). Check `SKILL.md` and the rubric material for "last 24" or `history` wording with `grep -rn "24\|history" skills/archmax-harness`. Verify by reading the diff.
- [x] 7.5 Check README.md for hook-input text (`grep -n "messages" README.md`) and update it if it describes the window. Run `npx openspec validate scope-hooks-to-visit --strict`. Verify it passes.
