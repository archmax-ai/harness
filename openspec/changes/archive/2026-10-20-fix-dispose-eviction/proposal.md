## Why

`agent.dispose(sessionId)` is documented as releasing every per-session resource, but it leaves
the session's checkpoints in memory. The default checkpointer, `BackendCheckpointSaver`, writes
every checkpoint through to the session store and also keeps it in `MemorySaver`'s maps, and
only `sessions.delete` ever clears them. A long-running host that disposes finished sessions
therefore grows without bound. While benchmarking, a host serving many multi-turn sessions grew
by tens of MB per session and was killed after a few hundred. The growth was in `arrayBuffers`
(the checkpoints are stored as `Uint8Array`), not the JS heap, so heap metrics gave no warning.
Child sessions (`<id>~1`, `<id>~1~1`) share the same checkpointer and leak the same way.

## What Changes

- `agent.dispose(sessionId)` evicts the session's checkpoints and pending writes from the
  default checkpointer's memory, together with those of every child session under it. The
  session's records stay in the session store.
- A later turn or read on a disposed session replays it from the session store, as it does
  after a process restart. Disposing does not end, fork or lose a session.
- A plain agent (`workflow: false`) evicts the same way. Its `dispose` does nothing today.
- A host-supplied `checkpointer` is left alone. Nothing guarantees it has a durable copy, so
  evicting could lose the session. The docs say such a host frees a session's memory with
  `sessions.delete` or through its own checkpointer.
- `dispose` stays synchronous and idempotent.
- `sessions.delete` keeps its current behaviour.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `workspace-and-sessions`: "Durable checkpointer" gains the eviction behaviour: an evicted
  session is replayed from the store on its next access. A new requirement says `dispose`
  evicts a session and its child sessions from the default checkpointer, and leaves a
  host-supplied checkpointer alone.

## Impact

- **Code**: `src/workflow/checkpointer.ts` (a synchronous eviction method on
  `BackendCheckpointSaver`), `src/assembly/index.ts` (the `dispose` handed to `AgentMembers`,
  governed and plain), and colocated tests in `src/workflow/checkpointer.test.ts`, plus a
  behaviour test that a disposed session's next turn continues where it left off.
- **Public API**: no new names. What `dispose` does changes; its signature does not.
- **docs/**: `reference/public-api.md` says what `dispose` releases, that the session replays
  from the store on next use, and what a host with its own checkpointer must do. Add a
  changelog entry in `reference/changelog.md`.
- **README.md**: no change; it does not describe `dispose`.
- **skills/archmax-harness/**: `references/backend-integration.md` says `dispose` "cleans up
  sandbox/PTC state". It needs to say that it also frees the session's checkpoints from memory.
  `references/wiring.md` needs no change.
