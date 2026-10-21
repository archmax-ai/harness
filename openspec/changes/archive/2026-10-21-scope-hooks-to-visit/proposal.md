## Why

A hook is the runtime's check at a state's boundary, but what it can see of the session is the
last 24 transcript entries (`HOOK_TRANSCRIPT_LIMIT`). Every control call (`archmax_advance`,
`archmax_get_variables`, …) costs two of them, so a few control calls push a domain tool's result,
or the person's confirmation, out of sight. While benchmarking on τ²-bench, hooks vetoed valid
advances because their evidence had scrolled away. The agent fetched the same record again, which
pushed more out, and conversations looped until a step limit. Authors worked around it by having
the model copy results into variables, and checks then failed on the copy, not on the facts.
Calling the tool again from the hook repeats an action against the host's external system.

Nothing ever justified the window: it shipped with the first release, and the one recorded
problem with it (issue #61, the request scrolling out of a rubric's view) was patched beside it,
not fixed. The window is also inconsistent: a `before` hook reads the model's summarized request,
while `after` hooks read the full transcript.

## What Changes

- **A hook sees its visit.** A visit is everything since the session entered the state it is in
  when the hook runs. On an advance from `S`, both `S`'s `after` hook and the target's `before`
  hook see `S`'s visit. A visit spans turns: a turn that continues in the same state continues its
  visit, and re-entering a state starts a new one. A turn that opens a state starts its visit with
  the person's message.
- **BREAKING: `messages` is the visit's transcript**, not the last 24 entries. There is no window.
  A tool result entry carries the tool's name and the call's `id`, not the result text; the
  result is read through `toolCalls`.
- **`toolCalls`: the session's record of tool results.** A new async query on the hook input,
  `await toolCalls({ name?, state?, visit?, status?, last? })`, returns the matching domain tool
  calls of the whole session, oldest first, each `{ id, name, args, result, status, state,
  visit }`. The runtime builds it from the checkpointed transcript, nobody can edit it, and the
  filtering happens outside the sandbox, so only matching calls are copied in. Control tools are
  not in it.
- **BREAKING: a rubric is shown the visit.** A rubric's `history` is the visit's transcript, with
  tool results in full, instead of the last 24 entries. `userRequest` is unchanged.
- **Every hook reads the session's own transcript.** A `before` hook no longer reads the
  summarized request handed to the model, so a summary never appears to it as the person
  speaking.
- **The authoring rule is written down**: the conversation is the model's memory; what a later
  state or turn depends on is stored (variables, files), and the runtime stores tool results. A
  hook checks its own visit and those records.

Out of scope: storing tool results into variables and letting guards read tool results (with the
lock policy, ticket item 5b); calls a script makes through `tools.*` and calls a hook makes, which
the transcript does not record; `userRequest` being the session's first message rather than the
current turn's.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `runtime`: "The hook function contract" takes the visit-scoped `messages` and `toolCalls`, and
  drops its stale claim that hook scripts have `task()` (the sandbox spec and the code give no
  sandbox context `task()`); a new requirement defines the visit and what a hook sees of the
  session.
- `sandbox`: "Hook scripts default-export a function returning a verdict" adds `toolCalls` to the
  hook input.
- `grading-rubrics`: a new requirement fixes what a rubric is shown: the visit's transcript and
  the session's opening request.

## Impact

- **Code**: `src/workflow/state.ts` (the trail step records where the transcript stood at entry),
  every place that commits an entry (`control-tools.ts` for advance and reset,
  `turn-boundary.ts`, `parks.ts`/decision routing, `on-error.ts`, `sub-workflow.ts` returns),
  `src/lifecycle/transcript.ts` (visit transcript, tool entries without their text),
  `src/core/messages.ts` (`runContextFromMessages` over the visit), `src/workflow/governance.ts`
  (`before` hooks read `state.messages`), `src/lifecycle/runner.ts` and `src/sandbox/executor.ts`
  plus the lifecycle prelude (the `toolCalls` host function), `src/workflow/session-view.ts`
  (reused for pairing), `src/public/sandbox.ts` (`HookArgs`, `HookMessage`, a `ToolCallRecord`
  type), and tests, including behaviour tests for the ticket's repro.
- **Public API**: `@archmax-ai/harness/sandbox` gains `toolCalls` on `HookInput` and its record
  type; `HookMessage` tool entries gain `id` and lose their text. `TrailStep` is
  unchanged; where the transcript stood at each entry stays internal.
- **examples/customer-support/**: its hooks read the request at `identify-case` entry and files,
  so they keep working; checked by its cases.
- **docs/**: `guides/code-interpreter.md` (the hook input table), `guides/workflow-machine.md`
  (lifecycle hooks: the visit, `toolCalls`, the store-what-later-states-need rule),
  `reference/public-api.md` (the transcript paragraph), the rubric guide's payload description,
  `reference/glossary.md` (a **visit** entry), and a 0.9.0 changelog entry marked breaking.
- **README.md**: updated if it describes the hook input (checked in tasks).
- **skills/archmax-harness/**: `references/hook-and-test-scripts.md` and
  `references/hooks-and-scripts.md` (the input tables, `toolCalls` examples, the visit rule),
  and the rubric reference if it describes `history`.
