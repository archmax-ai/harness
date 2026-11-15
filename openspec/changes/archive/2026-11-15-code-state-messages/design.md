# Design

## Context

See proposal.md for why. An automated state runs inside `wrapModelCall`, in place of the agent's
model call (`src/workflow/automated.ts`). Its controls are real tools bound to one **step recorder**
(`src/workflow/automated-controls.ts`), which holds the run's decision and its variable writes.
When the run settles, `runAutomatedStep` returns a marker `AIMessage` whose `additional_kwargs`
carry the serializable outcome; `afterModel` removes the marker and commits the outcome
(`commitAutomated` in `src/workflow/middleware.ts`): the writes, the trail, and the move's or
raise's runtime note. Narrative events (`code-result`, `advance`, `raised`) are emitted once the run
has settled, so nothing announces what an error then discards. The outcome rides in the marker so a
process that dies between the model node and `afterModel` replays the commit.

Which controls each state type has is one table, `STATE_TYPE_TOOLS`
(`src/machine/tool-names.ts`), read by the machine's surface, the kernel's grant, disclosure and
`validate`. Today the grader and the code state share one entry.

## Goals / Non-Goals

**Goals:**

- A code state's script says something to the person, and the session treats it exactly as text
  the agent wrote: transcript, `reply`, `agent-text`, the next model call, a later state's history.
- What a failed run said never reaches anyone.
- Hosts need no change to show it.

**Non-Goals:**

- **Other roles.** A script writes no user message (only a person speaks as the user), no runtime
  note (only the runtime writes those; the move's reason already reaches the next state as one),
  and no tool message.
- **Streaming.** A script's message is whole when it is recorded; there is no `agent-text-delta`.
- **A grader's messages.** A grader is an isolated judge; nothing it says enters the transcript.
- **The handoff rule.** An advance into a human state owes its one reply-only handoff call whether
  or not the code state said something, as an agent's advance does today.
- **Attachments, structured content or per-message metadata.** A message is text.

## Decisions

### 1. A control tool, `archmax_add_message`, not a return value or a console channel

A script already acts on the session through `tools.*` controls, each governed by the kernel and
reported as a tool-event pair. A message is one more act on the session, so it is one more
control: forbiddable per state, visible on the event stream, typed like the others.

- **Rejected: the default export's return value as the reply.** A return value is never read
  today, and a script may want to say several things, or say something before raising.
- **Rejected: `console.log` lines.** They are diagnostics (`code-output`), and must stay free to be
  noisy.
- **Name.** `add_message` pairs with `archmax_get_history` (the session's messages are what the
  history holds). `reply` is taken (a person's message to a parked session, `archmax reply`) and
  so is `send` (`agent.workflow.send`, which resumes a session).

### 2. Code state only; the grader withholds it

The two automated types' control sets split: `code.controls` is the grader's set plus
`archmax_add_message`, and `grader.withheld` adds it, so `validate` reports a grader state that
names it, through the existing withheld-tool check, whose message gains the reason for this tool.
The agent's own set does not change: an agent speaks by writing text, and the tool is registered
nowhere an agent could reach it (its controls are built per automated run), as with
`archmax_get_history`. It joins `HARNESS_CONTROL_TOOLS`, so no agent script reaches it through the
PTC surface and no case's mock serves it.

### 3. Recorded on the step recorder, committed with the outcome

The recorder gains `messages`: each accepted call appends `{ id, text }`, with the id assigned at
the call (a UUID, as LangGraph's reducer would assign). The outcome carries them as
`messages`, and `commitAutomated` appends one `AIMessage({ id, content: text })` per message after
the marker's removal and before the runtime note. Riding in the marker keeps the replay guarantee:
a commit replayed from the marker writes the same messages under the same ids.

`text` is refused when it is blank (a rejection the script can catch). It is kept as written.

### 4. A failed run's messages are discarded with its move

`runAutomatedStep` leaves the messages out of the outcome when the run settles `failed`. A raise
beats an error already, so a script that raises and then throws keeps what it said. Variable writes
are untouched by this change (they still commit with a failed run).

- **Rejected: committing them whatever the outcome**, as a log would. A retry through `on_error`
  into the same state would repeat a half-said answer on every attempt, and the person would read
  a promise ("your refund is on its way") the failed run then broke.

### 5. Reported as `agent-text` when the run settles

For each committed message, `runAutomatedStep` emits
`agent-text { state, text, messageId }` after the script's `code-output` lines and before
`code-result`, with the id the transcript message carries — the event's existing contract
("`messageId` is the id the message carries in state"). Emitting at settle time, not at the call,
is what lets a failed run's messages never reach the stream. `afterModel`'s own `agent-text` for the
model's message sees only the marker, whose content is empty, so nothing is reported twice.

### 6. The run's own history does not change

`archmax_get_history` answers with the session as it stood when the state was entered, as it does
for variable writes. A later state reads the messages as `assistant` entries, because they are
assistant messages in the checkpointed transcript; `historyMessages` needs no change.

## Risks / Trade-offs

- [Two assistant messages in a row (the script's, then the note's tool-call message) reach the
  next model call] → Providers accept consecutive assistant messages (Anthropic merges them, and the
  transcript already has this shape after a park's handoff followed by a decision note).
- [A host that maps tools to state types by assuming `STATE_TYPE_TOOLS.grader` equals `.code`] →
  The table is the documented source; the changelog names the split.
- [A script that adds very long text] → Bounded as any tool argument is, by the sandbox's quotas;
  the transcript holds what the agent itself could have written.

## Migration Plan

None: additive. Released as a minor version (`release:minor`). A host picks it up by upgrading.
