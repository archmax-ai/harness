## Context

See proposal.md for the motivation.

- `BackendCheckpointSaver` (`src/workflow/checkpointer.ts`) extends `MemorySaver`. Its memory is
  three maps:
  - `storage[threadId]`: checkpoints by namespace and id.
  - `writes[JSON.stringify([threadId, ns, id])]`: pending writes.
  - `loading`: one promise per thread id. It means "this thread has been replayed (or is being
    replayed)".
- `deleteThread` clears the first two maps and sets `loading` to a resolved promise, so the
  deleted session's files are never replayed.
- Each agent has one checkpointer (`src/assembly/index.ts:314`). The governed graph, every lazily
  composed child workflow, and the plain graph all use it. Child sessions are separate thread
  ids, `<parent>~<n>`, which is why disposing a parent must cover its children.
- `dispose` is built in two places: `compose.ts` for a governed agent (instrumentation,
  interpreter, dispatcher) and `index.ts` for a plain agent, where it is `() => {}`. Both reach
  `AgentMembers` through `members()` in `index.ts`, which also hands `dispose` to
  `createSessionOperations` for `sessions.delete`.
- The sandbox spec requires `dispose` to stay synchronous.

## Goals / Non-Goals

**Goals:**

- After `dispose`, the default checkpointer holds nothing in memory for the session or its
  children.
- A disposed session behaves exactly like a session after a restart: the next access replays it.

**Non-Goals:**

- `sessions.list()` and the CLI's `archmax sessions` replay every session they project, through
  `getTuple`, and keep them in memory. That is the same retention, triggered by listing instead
  of running. It is left for a later change: a host that lists sessions in a loop can dispose
  what it listed.
- The usage tracker's per-session map keeps one small summary per session. It is not the
  reported leak, and `usage.reset(id)` already exists.
- Growth of the on-disk store. Write-through keeps every checkpoint by design.
- Disposing a session while one of its turns is still running. The docs already say `dispose` is
  safe "once `send` settles". This change keeps that contract and does not widen it.

## Decisions

**1. A synchronous `evict(sessionId)` on `BackendCheckpointSaver`, separate from `deleteThread`.**
For the session and every id that `isChildSessionOf` it (`src/sessions/scope.ts`), it deletes
`storage[id]`, every `writes` key whose first element is `id`, and `loading[id]`. Deleting the
`loading` entry, instead of setting it to resolved as `deleteThread` does, is what makes the next
access replay.

- *Alternative: reuse `deleteThread`.* It is async, it covers only the one id given, and it leaves
  the "do not replay" mark. A disposed session would then read as empty and fork on its next
  turn. Rejected.
- *Alternative: a bounded LRU of loaded sessions inside the saver.* It would also bound
  `sessions.list()` and hosts that never dispose. But it evicts sessions without the host asking,
  which can happen mid-turn for a concurrent session, and it needs a size setting. Rejected for
  now. The explicit `dispose` contract is what hosts already call.
- Child ids are found by scanning the keys of `storage`, `writes` and `loading`. A child that was
  never loaded has nothing to evict.

**2. Wire eviction once, in `members()` in `src/assembly/index.ts`.**
The `dispose` given to `AgentMembers` becomes the existing per-composition `dispose` followed by
`checkpointer.evict(id)` when `checkpointer instanceof BackendCheckpointSaver`. Doing this in
`members()` covers the governed and the plain agent at once, and keeps the instanceof check in
the same place where `sessions.list` already makes it. A host-supplied checkpointer fails the
check and is left alone.

**3. `sessions.delete` evicts before it marks.**
`delete` currently runs `deleteThread`, then the store's `deleteSession`, then `dispose`. If
`dispose` now evicts, running it last would remove `deleteThread`'s "do not replay" mark. The new
order is: `dispose` (release resources and evict), then `deleteThread` (sets the mark), then
`deleteSession`. Memory is still cleared before the store removes the files, as the existing
comment requires, and the mark is the last word.

## Risks / Trade-offs

- [Disposing a parent while a concurrent turn is running in one of its children] → The
  documented contract already rules this out. If it happens anyway, a write after eviction
  replays from the store first (`ensureLoaded`), and the store already holds every earlier
  record, so no data is lost. The only unsafe gap is between `super.put` and the read of
  `storage` in `put` (`checkpointer.ts:163-165`). Eviction there would throw instead of losing
  data silently.
- [A host disposes after every turn, so every turn replays the whole session from the store] →
  One listing and N small file reads per turn. This is the same cost a restarted process pays,
  and it is the price of bounded memory. Hosts that want speed can dispose only finished
  sessions.
- [Hosts that use their own `MemorySaver` still grow] → Documented: they free memory with
  `sessions.delete` or through their own checkpointer.

## Migration Plan

No migration. A behaviour test covers the round trip: a turn, `dispose`, then the next turn
continues where it left off. Rolling back restores the leak and nothing else.
