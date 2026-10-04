## MODIFIED Requirements

### Requirement: A session is extended, never copied

The runtime SHALL model a conversation as exactly one session: one checkpoint chain under one `thread_id`, one folder, one position in the machine. Each turn SHALL run on the same session id, continuing the retained position, variables, trail and transcript; the runtime SHALL never mint a second identity for an existing session, and a caller SHALL NOT need to replay earlier messages. An id SHALL be minted (`session-<uuid>`) only for a firing that declares no session. The checkpointed `status` SHALL be one of `running`, `completed`, `failed`, `rejected`, `awaiting_decision`, `awaiting_input`; `completed`, `failed` and `rejected` SHALL classify as **finished** and the rest as **open** (`classifyStatus`, `isFinished`), and a parked session SHALL never be reported finished. The checkpointed state SHALL also carry the `specHash` the session last ran under, its `entryState`, its current `trigger`, and, for a session whose last turn ended with `archmax_raise`, its exit record.

#### Scenario: Second turn on the same session

- **WHEN** a session's previous turn finished in `orders-question` and a new message arrives for it
- **THEN** the turn runs on the same session id and begins in `orders-question`, not at the trigger's entry state

#### Scenario: Parked session is open

- **WHEN** a session parks on `archmax_wait`, including in a terminal state
- **THEN** its status is `awaiting_input`, its classification is `open`, and no surface reports it completed

#### Scenario: Failed session is finished

- **WHEN** a session's turn ends with `archmax_raise`
- **THEN** its status is `failed`, its classification is `finished`, and the next firing for it is
  resolved as a `turn`

### Requirement: Session operations

The agent SHALL expose `sessions.list()`, `sessions.get(sessionId)`, `sessions.messageCount(sessionId)`, `sessions.delete(sessionId)` and `sessions.seed(sessionId, files)` over the configured store. `messageCount()` SHALL read the transcript length off the latest checkpoint through `getTuple` alone (`0` for a session that has not run), so a host reads it before a turn and slices what the turn appended with `messagesSince` afterwards. `list()` SHALL enumerate the store root's non-reserved folders and project each latest checkpoint, returning `[]` when the checkpointer is not the `BackendCheckpointSaver` or the store cannot list. `get()` SHALL project one session through `getTuple` alone, so it works for any checkpointer, and return `null` for a session that has not run. `delete()` SHALL evict the session from the live checkpointer, remove its namespace through the store, release its per-session resources, and return whether anything was removed. `seed()` SHALL classify every key against the resolved mounts and write only paths in the governed session zone or `scratchpad/` at `<sessionId>/<path>` — strings verbatim, other values as JSON — rejecting the whole call when any key classifies as authored, internal, offload, root or escaping.

A `SessionSummary` SHALL carry `sessionId`, `status`, `classification`, `workflowState`, `specHash`, and for a parked session `state` (the state awaiting a decision or input) plus, for an `archmax_wait` park, `waitReason` and any absolute `resumeAt`; for a `failed` session, `exit` (`{ success: false, code, reason }`); `variables` as the checkpoint holds them (`name -> { value, locked }`, omitted when empty — the reserved `title` variable, when set, names the session's task for a listing); `usage` when anything was spent; and `parentSessionId` for a child session. Malformed checkpointed variables, usage or exit records SHALL read as absent rather than failing the listing.

#### Scenario: Listing parked sessions

- **WHEN** one session is parked at a human state and another completed its latest turn
- **THEN** the listing reports the first with status `awaiting_decision` and its `state`, and the second `completed`

#### Scenario: Scheduled park listed

- **WHEN** a session parked with `until: "1d"` is listed
- **THEN** its summary carries the absolute `resumeAt`, and a park without a due time carries none

#### Scenario: Failed session listed

- **WHEN** a session whose latest turn ended with `archmax_raise({ code: "orders-unavailable", … })` is listed
- **THEN** its summary carries status `failed`, classification `finished` and `exit` with that code
  and reason

#### Scenario: Delete through the store

- **WHEN** `sessions.delete(id)` runs on a filesystem store
- **THEN** that session's checkpoints, artifacts, scratchpad and offloaded context are removed, and other sessions and `_specs/` are untouched

#### Scenario: Seeding a protected area rejected

- **WHEN** `sessions.seed(id, { "checkpoints/x.json": "..." })` is called
- **THEN** it throws naming the path and its zone, and nothing from that call is written
