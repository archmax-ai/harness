# Runtime bugs found while benchmarking (ticket)

> **Closed.** This was a bug ticket, not a proposal. It records runtime defects found while
> running governed agents on τ²-bench (the `harness-benchmark` repo). Each one was split into its
> own change and shipped in 0.9.0; see [Resolution](#resolution). Line numbers are at `cc59261`
> (0.7.1).

## 1. Hooks lose sight of tool results

**What happens.** A hook reads tool results only through `messages`, which is the last 24
entries of the transcript (`HOOK_TRANSCRIPT_LIMIT`, `src/lifecycle/transcript.ts:29`, sliced at
`:59`). Every control call (`archmax_set_variables`, `archmax_get_variables`, `archmax_advance`, …)
adds two entries, an assistant entry with the call and a tool entry with its result, so a few
control calls push a domain tool result out of the window. `HookArgs`
(`src/public/sandbox.ts:38`) offers nothing else: only `variables` and `messages`.

There is also no way for a tool result to reach a variable without the model retyping it,
because hooks cannot write variables. A hook therefore checks either a result that may have
scrolled away or a copy the model made. Calling the tool again from the hook through `tools.*`
repeats the call, which for a host whose tools reach an external system is a new action
against it.

What this leads to in practice:
- Hooks veto valid advances because the evidence left the window. The agent fetches the same
  record again, which costs more messages, which pushes more out. Conversations loop until a
  step or time limit.
- Authors design around the window: they re-fetch before every check, and keep the person's
  confirmation and the action in adjacent states.
- Checks compare model-made copies with results. A copy drifts (key order, a stringified number,
  a dropped field), the check vetoes, and the agent loops. Copies then get locked (see 5b) and
  can't be refreshed.

**How to recreate.**
1. Write a workflow whose state allows one domain tool, `lookup`. Give it an `after` hook that
   vetoes unless `messages` holds a `tool` entry from `lookup`.
2. In one turn, call `lookup` once, then make 12 control calls (for example
   `archmax_get_variables`), then `archmax_advance`.
3. The hook vetoes, even though `lookup` ran in this session and returned. Or, as a unit test:
   pass `hookTranscript` one `lookup` result followed by 12 control-call pairs. The result is
   not in the output.

**What should happen instead.**
- A hook can read every domain tool call of the session, with its arguments and result,
  however many messages came after it. For example, a `toolResults` field on `HookArgs`.
- Control traffic doesn't use up the window a hook sees of the conversation.
- Optionally, a state can declare that a tool's latest successful result is stored into a
  variable by the runtime, unchanged, so checks compare against the result itself and not a
  model copy.

**Open questions.** Should control pairs be dropped from `messages`? That is **breaking** for
hooks that read control traffic. Should the window size be set per hook? Is capture still
needed once `toolResults` exists? How should `toolResults` be bounded in long sessions?

## 2. `dispose` leaks the session's checkpoints

**What happens.** `dispose(sessionId)` is documented as "Release every per-session resource held
for `sessionId`" (`src/agent.ts:115`). The implementation (`src/assembly/compose.ts:649`) releases
instrumentation, the interpreter and the dispatcher, but not the checkpointer. The default
checkpointer, `BackendCheckpointSaver`, extends `MemorySaver` (`src/workflow/checkpointer.ts:65`).
It writes through to the session store, but also keeps every checkpoint of every session it has
seen in `MemorySaver`'s in-memory maps, and its `loading` map (`:72`) keeps an entry per
session. Only `sessions.delete` (`src/sessions/operations.ts:98`) evicts them, and that also
deletes the session.

A long-running host that disposes finished sessions grows without bound. In the benchmark, a
host serving many multi-turn sessions grew by tens of MB per session and was killed after a few
hundred. The growth showed in the container's memory, not in the Node heap figures, so nothing
warned before the kill.

**How to recreate.**
1. Call `createAgent` with the default checkpointer and a memory session store.
2. In a loop, `send` one turn on a new session id, then `dispose(id)`.
3. The checkpointer's storage (or `process.memoryUsage().rss` / `arrayBuffers`) grows with
   every iteration and never shrinks.

**What should happen instead.** After `dispose`, the checkpointer holds nothing in memory for
that session. A later `send` on the same id replays it from the session store, as it does after
a restart.

**Open questions.** What should `dispose` do with a host-supplied ephemeral `MemorySaver`, where
evicting means losing the session? Either document that such hosts must use `sessions.delete`,
or evict only caches backed by durable storage.

## 3. To investigate: a turn has no defined reply

**What happens.** An outcome's `reply` is `lastAgentText(messages)` over the session's whole
history (`src/sessions/resume.ts:412`; documented as "what the session last said", `:238`,
`:308`). There are two consequences:
- If a turn ends without text, `reply` is the previous turn's text, so the person is told the
  same thing again.
- If the agent writes text in one state, advances, and writes more in the next, `reply` holds
  only the last text. The earlier text is lost if the host shows only `reply`. In the benchmark,
  the text an agent wrote before an advance was a proposal, and the person saw only "I'll wait
  for your confirmation". It asked what it was confirming, and the conversation ran out of
  steps.

Each host has to work out the turn's reply itself, by slicing `messages`.

**How to recreate.**
1. Write a two-state workflow, `a` → `b`. In `a`, the model writes "X" and calls
   `archmax_advance` to `b` in the same message. In `b`, it writes "Y".
2. `reply` is "Y". "X" appears only in `messages`.
3. Send another turn in which the agent writes no text. `reply` is still "Y".

**What should happen instead (to decide).** `reply` is everything the agent said to the person
during this turn, in order (or there's a defined per-turn list), and it is empty when the turn
said nothing.

**To investigate.** Is text written next to an `archmax_advance` meant to reach the person, or
is it narration? What does `archmax run` show? Does every outcome type (`Outcome`,
`ReplyOutcome`, `DecideOutcome`) share the behaviour?

## 4. To investigate: unbounded state cycling within a turn

**What happens.** In one turn, an agent advanced 12 times, cycling between two states and
repeating their lookups. The turn ended at the recursion limit (`DEFAULT_RECURSION_LIMIT = 400`,
`src/core/deepagents.ts:238`) with a `GraphRecursionError`, which the host saw as an
infrastructure failure, not as a governed outcome. The comment at `src/core/deepagents.ts:234`
says the authored budgets are the real bound. But `budget.maxTurns` (`src/machine/types.ts:70`)
bounds the model iterations within one state, and nothing bounds transitions across states in
one turn.

**How to recreate.**
1. Write a workflow with states `a` and `b`, each with a transition to the other.
2. Mock a model that always calls `archmax_advance` to the other state.
3. The turn runs until the recursion limit and throws `GraphRecursionError`.

**What should happen instead (to decide).** A per-turn bound on advances (or a cycle detector)
ends the turn through `on_error`, or refuses the advance with a reason the agent can act on.
For example: "you have advanced N times this turn; answer the person". It never ends with a
raw recursion error.

**To investigate.** Does a `GraphRecursionError` currently go through `on_error`? Does a
state's `maxTurns` reset when the state is entered again?

## 5. Also observed (tracked elsewhere or small)

- **a. The prompt clock can't be set.** Every model call states the real time
  (`src/workflow/governance.ts:438`) and overrides the date a domain states, so an agent treats
  scenario dates as past. Expected: the host sets the time. This is covered by
  `pin-prompt-clock`. Not covered: a host that wants no clock line at all.
- **b. The lock description pushes the model to lock.** `archmax_set_variables` says locking is
  "required for anything a tool guard reads" (`src/workflow/control-tools.ts:276`). A lock
  covers every key in the call and can't be lifted. Models lock saved copies, or values written
  before a lookup, and later requests can't correct them. Expected: the workflow declares what
  is immutable, not the model, and the description stops requiring locks.
- **c. A guard on an empty value fails the turn.** An `args` glob whose `${{…}}` resolves to
  `""` goes into picomatch and throws (`src/machine/allow.ts:39`). Values that aren't paths are
  path-canonicalized too. To recreate: guard `address2: "${{p.address2}}"` with
  `p.address2 = ""`. Expected: `""` admits only an empty argument, and a value that isn't a path
  matches literally.

## Resolution

Every item was confirmed, then fixed in its own change (archived under `openspec/changes/archive/`),
all shipping in 0.9.0:

| Item | Change | What was done |
|---|---|---|
| 1. Hooks lose sight of tool results | `2026-10-21-scope-hooks-to-visit` | A hook sees its **visit** (everything since the session entered the state), with no window, and queries the session's tool results with `toolCalls`, filtered outside the sandbox. A `before` hook no longer reads the summarized request. |
| 2. `dispose` leaks the session's checkpoints | `2026-10-20-fix-dispose-eviction` | `dispose` evicts the session and its children from the default checkpointer; a host's own checkpointer is left alone. |
| 3. A turn has no defined reply | `2026-10-20-fix-turn-reply` | `reply` is every text of the turn, starting over at an `after` revision note, and `""` when the turn said nothing. A case's grade is given the action's own reply. |
| 4. Unbounded state cycling within a turn | `2026-10-20-bound-turn-budget` | A root `budget.maxModelCalls` (default 50) bounds a turn across states and routes through `on_error`; the step limit follows it; a turn that throws ends the session `failed` instead of stranding it. Loop detection was dropped as too open to interpretation. |
| 5a. The prompt clock can't be set | `2026-10-22-pin-prompt-clock` | `createAgent({ clock })` and a case's `clock:` pin the prompt's "now". A clock line that can be switched off was not added: a pin covers what was reported. |
| 5b. The lock description pushes the model to lock | `2026-10-22-lock-by-owning-state` | A state may own variables (`locks:`): only it writes them, so a value changes by going back there. `archmax_reset` releases the agent's locks. The tool's description and the agent's `lock` were kept. |
| 5c. A guard on an empty value fails the turn | `2026-10-22-fix-guard-literal-args` | Only an argument the tool declares as a path is canonicalized; others match as written (a denial also catches the path form), and an empty pattern matches only an empty value. |

Found along the way and fixed in the same branch:

- A cancelled turn could crash a concurrent read inside `MemorySaver` (fixed in `bound-turn-budget`).
- A rubric's `userRequest` was the session's first message, so a later turn was judged against
  turn 1's question (`2026-10-22-rubric-current-request`).

Not built, by decision: guards reading tool results directly. A `before` hook reads the real
result through `toolCalls` before a state's tools unlock, and a guard binds to a variable the
deciding state owns.
