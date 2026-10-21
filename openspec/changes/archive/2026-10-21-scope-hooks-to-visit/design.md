## Context

See proposal.md for the motivation and the specs for the rules.

- **What hooks read today.** `runPhase` (`src/lifecycle/runner.ts:425`) builds the script input
  with `messages: hookTranscript(ctx.messages)`, the last 24 entries
  (`src/lifecycle/transcript.ts`). A rubric's payload comes from `runContextFromMessages`
  (`src/core/messages.ts:114`): the last 24 messages as `history`, plus `userRequest` from the
  whole list (issue #61).
- **Which messages.** The advance gate (`tool-service.ts:373`) and a terminal state's `after` hook
  (`middleware.ts:436`) pass `state.messages`. A `before` hook run from `wrapModelCall`
  (`governance.ts:593`) passes `request.messages`. Our middleware sits inside Deep Agents'
  summarization, so after a summary that list starts with a summary `HumanMessage`.
- **The transcript is complete.** Deep Agents' summarization keeps a `_summarizationEvent` and
  never rewrites `state.messages`. `patchToolCallsMiddleware` rewrites the list but keeps each
  message's id. A tool result over about 80k characters is replaced in the transcript by a pointer
  to `large_tool_results/<id>.txt`.
- **Where entries are committed.** Every entry writes a trail step: an advance
  (`control-tools.ts:364`), a reset (`control-tools.ts:574`), an `on_error` route
  (`on-error.ts:71`), a person's decision (`parks.ts:388`). Continuations write trail steps too:
  each turn's `trigger` step (`turn-boundary.ts:185`), a delivery (`parks.ts:639`), a sub-workflow
  return (`parks.ts:543`, `governance.ts:799`, `tool-service.ts:204`). So the trail cannot tell
  a visit's start from a continuation, and it does not know where the transcript stood.
- **How hook input reaches the sandbox.** The executor pastes the arguments into the evaluated
  source as a JSON literal (`executor.ts:88`) on every hook run. Hooks run in their own REPL per
  session (namespace `process`), apart from the agent's `archmax_eval`/`archmax_run` REPL
  (`agent`), and they run there whether or not the workflow grants the agent the sandbox tools.
  A REPL keeps the tools it was first handed for its lifetime (`runtime.ts:243`).

## Goals / Non-Goals

**Goals:**

- One definition of a visit, recorded once and used by `messages`, `toolCalls` and the rubric
  payload alike.
- Tool results cross into the sandbox only when a hook asks for them.

**Non-Goals:**

- Recording calls the transcript does not hold (a script's or a hook's `tools.*` calls).
- Following an offloaded result's pointer for the hook. It reads the file with `tools.readFile` if
  it needs the content.
- Changing what the model sees, or `userRequest`.

## Decisions

### A visit log, beside the trail

A new checkpointed channel, `visits`, appends `{ state, from: TurnAnchor }` whenever a visit
starts. The visit's number is its index plus one. `TurnAnchor` (`{ id?, count }`, from
`fix-turn-reply`) marks where the transcript stood: the visit's messages are those after the
message with that id, falling back to the count when the id is gone.

The entries that append are the four that start a visit (advance, reset, `on_error`, decision),
and a turn boundary that opens a state its session was not in (a first turn, or a reopening).
Continuations append nothing.

Alternatives:
- **A field on `TrailStep`.** Rejected: `TrailStep` is public (`@archmax-ai/harness/sandbox`,
  `trail.json`, `auditTrail`), and the trail mixes entries with continuations.
- **Stamping every message with its state.** Rejected: it means touching every write path,
  including the person's messages, which arrive as graph input.

### Where each anchor is taken

- **An advance, a reset or a decision:** the last message in `state.messages` when the entry
  commits. That's the assistant message carrying the call, or the parked transcript's last
  message. The new visit starts with what the entry appends, such as the advance's tool result
  or the decision note.
- **An `on_error` route:** `routeFailure` removes the failing message. The anchor is the message
  before it.
- **A turn that opens a state:** the message before the turn's opening message(s), so the visit
  starts with the person's words. The first turn's anchor is `{ count: 0 }`.

### A call belongs to the visit of the message that made it

`messages` is positional: an entry is in a visit when it lies after that visit's anchor. A tool
call's `state` and `visit` come from the assistant message that made the call, not from where
its result landed.

Take a `lookup` called in the same message as `archmax_advance`. It was governed in `S`, so its
record says `S`, even though its result lands after the anchor of `T`. If the leaving state's
`after` hook runs before that result exists, the call shows as `pending`.

### Hooks read `state.messages`

The `before` hook in `wrapModelCall` is handed `request.state.messages`, as the others are. The
visit slice, `hookTranscript` and `runContextFromMessages` all work on the session's transcript,
so a summary never reaches a hook. The 24-entry limits (`HOOK_TRANSCRIPT_LIMIT`,
`HISTORY_WINDOW`) are deleted. Tool entries in `hookTranscript` carry `tool` and `id` with
`text: ""`. The shape stays the same, so a hook that reads `.text` gets an empty string instead
of throwing. The rubric payload keeps the full text.

### `toolCalls` is a host function on the hooks' REPL

The runner hands the hooks' REPL one extra tool beside the PTC tools, under a reserved name
(`archmax_tool_calls`) that no host tool can claim. `buildHookCode` wires the hook input's
`toolCalls` to it. It is left out of the scoped `tools` listing, does not pass the PTC gateway
(it is a runtime read: no governance, no tool telemetry), and is never handed to the agent's REPL.

A REPL keeps its first tools, so the function cannot close over one hook's context. It reads the
session's current transcript and visit log from a per-session holder that the runner sets before
each script hook runs. A session's hooks run one at a time, so the holder is never shared between two runs.

The function:
- pairs calls and results with `messagesToSessionView`;
- drops the control tools named in the spec, which are exactly `ALWAYS_ALLOWED_TOOLS`
  (`HARNESS_CONTROL_TOOLS` also lists `archmax_eval` and `archmax_run`, which stay);
- attributes each call to its visit;
- applies the filter, and returns plain records.

Alternatives:
- **An inline array.** Rejected: it would be serialized and parsed on every hook run.
- **A visible `tools.*` entry.** Rejected: it would be governed and counted as a tool call.

### Sessions from before the change

A session with no visit log treats its transcript up to the first logged visit as visit 1, with
the session's `entryState` as its state. The first entry after the upgrade then starts a logged
visit. No migration runs.

## Risks / Trade-offs

- **[Breaking for hooks that read further back]** A hook that relied on messages from an earlier
  state, or on a tool result's text in `messages`, changes behaviour. → The changelog entry is
  marked breaking with the before and after. The skill teaches `toolCalls` and the visit, and
  the reference workspace's cases must keep passing.
- **[A long visit is inlined whole]** `messages` has no count bound. → The heavy part, tool
  results, is no longer inlined. A visit is bounded by the turn budget and the turns spent in one
  state. Large tool arguments (a `write_file`'s content) are still inlined, which is a
  shortcut: if visits grow too large, the arguments go behind the query as the results did.
- **[A rubric's prompt grows with the visit]** Results stay in full there, because a grader
  cannot query. → It is still bounded by the visit, and smaller than today for most rubrics,
  which judge a reply at the end of a short visit.
- **[The sandbox's result cap]** Checked: `maxResultChars` caps console output and an
  evaluation's formatted result, not what a host call returns, so a query's records arrive whole
  (a behaviour test reads a 20,000-character result through it). What does bound a hook is the
  REPL's PTC call budget (`maxPtcCalls`), which each query spends like any `tools.*` call.
- **[A visit's start is guessed wrong]** A missed append merges two visits, and an extra one
  splits a visit. → Behaviour tests cover every way in (advance, reset, `on_error`, decision,
  first turn, continued turn, delivery, sub-workflow return).
