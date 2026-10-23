## MODIFIED Requirements

### Requirement: Durable checkpointer

Absent a caller-supplied `checkpointer`, assembly SHALL use `BackendCheckpointSaver`: a LangGraph `MemorySaver` with **write-through** to the session store and **lazy per-session replay**. Every checkpoint (`{ k: "cp", ns, id, parent, cp, md }`) and pending write (`{ k: "w", ns, id, ik, taskId, channel, val }`) the parent accepts SHALL be persisted as one immutable JSON file under `<sessionId>/checkpoints/` (`cp-<key>.json`, `w-<key>.json`, key base64url-encoded and digest-truncated to fit a 255-byte file name); an "already exists" collision, which a create-only backend reports, SHALL be ignored. The first access to a session (`getTuple`, `list`, `put`, `putWrites`) SHALL replay its files into memory, a failed replay retrying on the next access; a listing that names no `thread_id` SHALL hydrate every non-reserved folder at the store root. `deleteThread` SHALL evict the session from memory and mark it as not to be replayed; physical removal is the store's job. **Evicting** a session SHALL drop its checkpoints and pending writes from memory without that mark, so its next access replays it from the store as the first access after a restart does. A session whose namespace holds no checkpoint yet (a write still in flight) SHALL read as having no checkpoint, never fail the read. The saver SHALL assume one writer per session id. A caller-supplied checkpointer SHALL be used as-is and the store not consulted for checkpoints.

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

#### Scenario: A half-written session reads as absent

- **WHEN** a checkpoint write for a session has created its namespace but not yet stored the checkpoint, and `getTuple` reads that session
- **THEN** the read returns no checkpoint rather than throwing
