## MODIFIED Requirements

### Requirement: Durable checkpointer

Absent a caller-supplied `checkpointer`, assembly SHALL use `BackendCheckpointSaver`: a LangGraph `MemorySaver` with **write-through** to the session store and **lazy per-session replay**. Every checkpoint (`{ k: "cp", ns, id, parent, cp, md }`) and pending write (`{ k: "w", ns, id, ik, taskId, channel, val }`) the parent accepts SHALL be persisted as one immutable JSON file under `<sessionId>/checkpoints/` (`cp-<key>.json`, `w-<key>.json`, key base64url-encoded and digest-truncated to fit a 255-byte file name); an "already exists" collision, which a create-only backend reports, SHALL be ignored. The first access to a session (`getTuple`, `list`, `put`, `putWrites`) SHALL replay its files into memory, a failed replay retrying on the next access; a listing that names no `thread_id` SHALL hydrate every non-reserved folder at the store root. `deleteThread` SHALL evict the session from memory and mark it as not to be replayed; physical removal is the store's job. **Evicting** a session SHALL drop its checkpoints and pending writes from memory without that mark, so its next access replays it from the store as the first access after a restart does. The saver SHALL assume one writer per session id. A caller-supplied checkpointer SHALL be used as-is and the store not consulted for checkpoints.

#### Scenario: Session survives a process restart

- **WHEN** a session runs, the process exits, and a new process assembles the agent over the same store
- **THEN** invoking the same `thread_id` continues from the checkpointed position, variables, trail and transcript

#### Scenario: Checkpoints follow the store

- **WHEN** the session store is a backend store over object storage
- **THEN** checkpoint records are read and written through it with no change to the saver

#### Scenario: Deleted session is not resurrected

- **WHEN** `sessions.delete(id)` evicts a session and a later access names the same id
- **THEN** no record files are replayed for it

#### Scenario: An evicted session replays from the store

- **WHEN** a session is evicted and a later access names the same id
- **THEN** its record files are replayed and the access reads the same latest checkpoint it read before the eviction

## ADDED Requirements

### Requirement: Disposing a session frees its checkpoints from memory

`agent.dispose(sessionId)`, on a governed or a plain agent, SHALL evict from the default checkpointer the session and every child session under it (`<sessionId>~<n>`, at any depth). Afterwards the checkpointer SHALL hold nothing in memory for those ids, and their records in the session store SHALL be untouched. A later `send`, `sessions.get` or other read of a disposed session SHALL replay it from the store and continue from its checkpointed position, variables, trail and transcript. A session whose id merely starts with `sessionId` (`<sessionId>-2`) SHALL NOT be evicted. With a caller-supplied `checkpointer`, `dispose` SHALL leave the checkpointer untouched. `dispose` SHALL stay synchronous and idempotent, and SHALL be safe to call on an id the checkpointer has never seen. `sessions.delete(sessionId)` SHALL still leave the session marked as not to be replayed.

#### Scenario: Disposing finished sessions does not grow memory

- **WHEN** a host runs one turn on each of many new session ids with the default checkpointer, disposing each once its turn settles
- **THEN** the checkpointer holds in memory no checkpoint or pending write for any disposed session

#### Scenario: A disposed session continues on its next turn

- **WHEN** a session runs a turn, is disposed, and is then sent another turn under the same id
- **THEN** the turn continues from the retained state with the earlier transcript, variables and trail, as after a restart

#### Scenario: Child sessions are evicted with their parent

- **WHEN** a session dispatched a sub-workflow, so the checkpointer holds `<id>` and `<id>~1`, and the host disposes `<id>`
- **THEN** neither `<id>` nor `<id>~1` is held in memory, and a session `<id>-2` is still held

#### Scenario: A host-supplied checkpointer is left alone

- **WHEN** an agent is assembled with its own `MemorySaver` and the host disposes a session
- **THEN** that saver still holds the session, and a later turn continues it from memory

#### Scenario: A deleted session stays deleted

- **WHEN** `sessions.delete(id)` removes a session and a later access names the same id
- **THEN** no record files are replayed for it, whatever order eviction and deletion run in
