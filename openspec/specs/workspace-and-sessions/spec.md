# workspace-and-sessions Specification

## Purpose

Define the agent's workspace at run time and the session that lives in it: the workspace root is
the executing session's folder in the consumer-chosen session store, authored content is mounted
read-only beside it at consumer-composed keys, and everything durable about a session — its
checkpoints, working files, offloaded context, artifacts, audit trail, variables and token usage —
is addressed per session without the session id appearing in any path the agent sees. It also
defines how a session persists across turns and processes, how it is listed, resolved, deleted and
seeded, and how the spec that governed it stays resolvable after `workflow.yaml` changes.

## Requirements

### Requirement: The workspace root is the session

The agent's workspace root SHALL be the executing session's folder in the configured session store,
served as the **default route** of the workspace composite (Deep Agents `CompositeBackend`), so that
every path outside a declared mount — including the fixed root paths Deep Agents writes for its own
offloaded context — lands in the session. While a turn is bound to a session (`AsyncLocalStorage`
around the turn runner's `invoke`), agent-visible paths SHALL resolve against that session's folder
with the session id required on no input path and stripped from every result path (`ls`, `glob`,
`grep`, `write`, `edit`). Two sessions writing the same relative path SHALL never see or overwrite
each other's file, and a session's folder SHALL be stable across its turns.

#### Scenario: Write and read back without the id

- **WHEN** the agent writes `scratchpad/notes.txt` during a turn and reads the same path in a later turn of the same session
- **THEN** it reads the content it wrote, and neither path carries the session id

#### Scenario: Concurrent sessions are isolated

- **WHEN** two sessions each write `scratchpad/answer.json`
- **THEN** each write lands under its own `<sessionId>/scratchpad/answer.json` in the store and neither session can read the other's

#### Scenario: Unmounted root path is session state

- **WHEN** a write targets a root path under no declared mount
- **THEN** it is served by the session store inside the executing session's folder, never by an authored backend

### Requirement: Paths are canonicalized before routing

The workspace router SHALL canonicalize every path before routing it: a leading slash added, `.` and empty (`//`) segments dropped, `..` applied against the accumulated path. Equivalent spellings (`./skills/x`, `//skills/x`, `skills/./x`) SHALL route to one mount. A path that resolves above the workspace root SHALL be refused with `WorkspacePathEscapeError` before any backend is consulted.

#### Scenario: Dot-prefixed authored path routes to its mount

- **WHEN** a component reads `./skills/refund-request/SKILL.md`
- **THEN** the read is served by the `skills/` mount, not the session folder

#### Scenario: Escaping path rejected

- **WHEN** a path canonicalizes to `../secrets`
- **THEN** the operation throws `WorkspacePathEscapeError` and no backend is consulted

### Requirement: Authored mounts are a consumer-composed route table

Authored content SHALL reach the agent only through the `workspace.mounts` route table the consumer composes — key to backend, or `{ backend, readOnly, governed, searchable }` — never through inspection of the workspace or a built-in list of directory names. A key ending in `/` SHALL be a **directory mount**, expressed as a composite route with its prefix stripped before delegation and re-applied to result paths; a key without a trailing slash (`/AGENTS.md`) SHALL be an **exact-path file mount**, routed by the workspace router so `AGENTS.md.bak` is not captured. Keys SHALL be normalized (one leading slash, collapsed separators) so equivalent spellings name one mount. A backend rooted at the mounted directory SHALL need no adaptation; the exported `mountSubtree(backend, prefix)` SHALL rebase one backend serving several mounts, mapping paths in both directions so results are never double-prefixed. Authored paths SHALL be addressed exactly as authors write them (`skills/order-data/assets/orders.json`).

A mount declared `governed: true` SHALL be visible to a state only where the spec's `mounts` lists enable it (see `governance`); a mount not so declared SHALL be visible in every state, so a consumer that marks nothing composes exactly the workspace it composes today. The consumer owns which backend serves a mount, its write posture, whether it is governed and whether it is searchable; the spec owns which states enable it, and whether each of those states may write there. Neither SHALL be inferred from the other. `readOnly` SHALL be a **ceiling** rather than a default: a spec grant may narrow a writable mount to reads in a state (`access: read`) but SHALL NOT open one the consumer serves read-only.

A directory mount declared `searchable: false` SHALL be a mount the runtime never searches on its own initiative (see "Search dispatch honours a mount's search posture"); a mount not so declared SHALL be searchable, which is what every table without the flag resolves to. The resolved mount SHALL carry the posture, and the names of unsearchable directory mounts SHALL arrive as `MountPrefixes.unsearchable`. On a file mount the flag SHALL be ignored — a file is never searched as a tree — and the name SHALL NOT appear in `MountPrefixes.unsearchable`. Search posture SHALL NOT be a governance concern: the kernel, the listing redaction and `archmax validate` SHALL neither read it nor report on it.

When `mounts` is omitted on the default filesystem backend, the exported `defaultMounts(rootDir)` SHALL apply: `/skills/` and `/.platform/` as filesystem backends rooted at those directories, plus the `/AGENTS.md` file served from the root, none of them governed. It SHALL be a default value only — nothing classifies or validates against those names — and SHALL include no `/workflows/` mount. A conventional directory that does not exist SHALL NOT be an error. When `mounts` is omitted with a custom `backend`, nothing authored SHALL be served.

#### Scenario: Directory mount from a rooted backend

- **WHEN** a consumer mounts `"/skills/"` to a backend rooted at the workspace's `skills` directory and the agent lists `skills/`
- **THEN** every returned path appears once, as `skills/<entry>`, matching the path a subsequent read accepts

#### Scenario: Exact-path file mount

- **WHEN** the table contains `/AGENTS.md`
- **THEN** `AGENTS.md` is served from that mount and `AGENTS.md.bak` is not

#### Scenario: Several mounts from one backend

- **WHEN** a consumer mounts `"/skills/"` and `"/data/"` through `mountSubtree(backend, "skills")` and `mountSubtree(backend, "data")`
- **THEN** each mount serves its own subtree and result paths come back in workspace form

#### Scenario: A governed mount from the same backend

- **WHEN** a consumer mounts `"/reference/"` as `{ backend: mountSubtree(store, "reference"), governed: true }` beside an ungoverned `"/skills/"`
- **THEN** `reference` appears in the resolved `MountPrefixes.governed`, `skills` does not, and both are served by their backends where the spec enables them

#### Scenario: A governed writable mount the spec may narrow

- **WHEN** a consumer mounts `"/shared/"` as `{ backend, readOnly: false, governed: true }`
- **THEN** `shared` appears in both `MountPrefixes.writable` and `MountPrefixes.governed`, a state enabling it plainly may write there, and a state enabling it as `{ mount: shared, access: read }` may not

#### Scenario: An unsearchable mount is resolved

- **WHEN** a consumer mounts `"/contracts/"` as `{ backend, governed: true, searchable: false }` beside `"/skills/"`
- **THEN** `contracts` appears in `MountPrefixes.unsearchable` and in `MountPrefixes.governed`, `skills` appears in neither, and the resolved `contracts` mount carries `searchable: false`

#### Scenario: The flag is inert on a file mount

- **WHEN** a consumer mounts `"/AGENTS.md"` as `{ backend, searchable: false }`
- **THEN** assembly succeeds, `AGENTS.md` is served exactly as before, and `MountPrefixes.unsearchable` does not contain it

#### Scenario: Extending the default

- **WHEN** a consumer spreads `defaultMounts(rootDir)` and adds `"/templates/"`
- **THEN** the conventional mounts and `templates/` are all served

#### Scenario: Custom backend serves nothing by default

- **WHEN** `createAgent({ backend, workspace: { sessionStore } })` is called with no `mounts`
- **THEN** no authored path is served to the agent until the consumer mounts one

### Requirement: Read-only is enforced at the mount and diagnosed by the kernel

A mount SHALL be read-only unless declared `{ readOnly: false }`. A read-only mount SHALL itself refuse `write` and `edit` with an error naming the path in workspace form, so authored content cannot be modified even by a caller that bypasses governance; the kernel SHALL additionally block an agent tool call targeting a read-only mount with rule `zone.read-only`, naming `scratchpad/` as the writable alternative. `archmax validate` SHALL report a state `tools.allow` entry that would permit a write into a read-only mount. A mount declared writable SHALL be classified as session state — governed by the active state's `tools.allow` — rather than as authored.

#### Scenario: Mount refuses a write independently of governance

- **WHEN** any component writes to a read-only mount's path directly through the workspace backend
- **THEN** the mount returns an error and no file behind it is created or modified

#### Scenario: Agent write blocked by the kernel

- **WHEN** the agent calls `write_file` on `skills/refund-request/SKILL.md`
- **THEN** the call is blocked with rule `zone.read-only` and a message pointing at `scratchpad/`

#### Scenario: Writable mount still governed

- **WHEN** a state's `tools.allow` does not permit a path under a writable mount and the agent writes it
- **THEN** the call is blocked by per-state governance, not by the read-only rule

#### Scenario: Validator flags a contradictory allow entry

- **WHEN** a state's `tools.allow` declares a write whose path falls under a read-only mount
- **THEN** `archmax validate` reports the contradiction

### Requirement: Search dispatch honours a mount's search posture

The workspace router SHALL dispatch `grep` and `glob` by where the search is addressed, after the usual canonicalization. A search whose path is the root, an ancestor of a mount, a session path, or a path inside a **searchable** mount SHALL be served by a composite over the searchable directory routes only — the same default route, the same longest-prefix routing and the same prefix re-application as every other operation — so an unsearchable mount contributes neither matches nor an error to it. A search whose path is an **unsearchable** mount or a path inside it SHALL be delegated directly to that mount's backend with the route-relative path (`/` for the mount itself), and the backend's result SHALL be returned verbatim: matches and files re-prefixed into workspace form, an `{ error }` untouched, so the backend's own refusal reaches the caller. The routing mount of a search path SHALL be determined by longest prefix across every directory mount, so a searchable mount nested inside an unsearchable one is still searched, and vice versa. `ls`, `read`, `readRaw`, `write` and `edit` SHALL be unaffected: a listing of the root still shows an unsearchable mount, and its files read as before.

With no unsearchable mount in the table, the search composite SHALL be the routing composite itself, so every existing table behaves byte-identically. The behaviour SHALL hold for every caller of the workspace backend — an agent tool, a hook or sandbox script's `tools.*` bridge, and the runtime's own discovery — since all of them reach the router.

The model-facing prompt SHALL disclose the posture wherever it names the mount: the "Mounts available in this state" section for a governed unsearchable mount, and the static "Workspace zones" section for an ungoverned one, SHALL mark it browse-only — list and read it, do not search it — and SHALL be unchanged for a table with no unsearchable mount.

#### Scenario: A root-wide grep survives a refusing mount

- **WHEN** the table is `{ "/skills/": skills, "/contracts/": { backend: contracts, governed: true, searchable: false } }`, the `contracts` backend answers every `grep` with `{ error }`, and the agent greps `x` at `/`
- **THEN** the result carries the matches from the session zone and `skills/`, no error, and the `contracts` backend's `grep` is never called

#### Scenario: A root-wide glob survives a refusing mount

- **WHEN** the same table's `contracts` backend answers every `glob` with `{ error }` and the agent globs `**/*.md` at `/`
- **THEN** the result lists the session zone's and `skills/` files and the `contracts` backend's `glob` is never called

#### Scenario: A grep addressed at the mount reaches its backend

- **WHEN** the agent greps `x` at `/contracts/`
- **THEN** the `contracts` backend receives `grep("x", "/")` and its `{ error }` is returned to the agent verbatim

#### Scenario: A glob inside the mount reaches its backend

- **WHEN** the agent globs `**/*.md` at `/contracts/2026`
- **THEN** the `contracts` backend receives `glob("**/*.md", "/2026")` and its `{ error }` is returned to the agent verbatim

#### Scenario: An addressed search that succeeds comes back in workspace form

- **WHEN** the `contracts` backend answers `grep("x", "/2026")` with a match at `/2026/a.md`
- **THEN** the agent's grep at `contracts/2026` returns that match at `contracts/2026/a.md`

#### Scenario: The mount still lists and reads

- **WHEN** the agent lists `/` or reads `contracts/2026/a.md`
- **THEN** `contracts/` appears in the root listing and the read is served by the `contracts` backend as before

#### Scenario: An ancestor path skips the mount

- **WHEN** the table mounts `/catalogs/eu/` as `{ backend, searchable: false }` and the agent greps `x` at `/catalogs`
- **THEN** the search is served without calling the `eu` backend

#### Scenario: Longest prefix decides the routing mount

- **WHEN** the table mounts `/data/` as `{ backend: a, searchable: false }` and `/data/public/` as `{ backend: b }`, and the agent greps `x` at `data/public/reports`
- **THEN** backend `b` serves the search with path `/reports`, and backend `a` is not called

#### Scenario: Tables without the flag are unchanged

- **WHEN** no mount in the table declares `searchable: false`
- **THEN** `grep` and `glob` at every path produce the same result they produce today, including an error a searchable mount returns on a root-wide search

#### Scenario: The prompt marks an unsearchable mount

- **WHEN** a state enables the governed mount `contracts` declared `searchable: false`
- **THEN** its line in "Mounts available in this state" says the mount is browse-only, and a table without the flag renders the section exactly as before

### Requirement: Reserved root names fail assembly when shadowed

The session areas (`scratchpad`, `large_tool_results`, `conversation_history`, `checkpoints`, `artifacts`, `_specs`) and the authoring prefix (`workflows`) SHALL be reserved at the workspace root. A declared mount whose key names one of them — or whose first segment does — SHALL throw `MountCollisionError` at assembly, naming the collision. A writable mount served by the same backend as the authoring backend SHALL throw `AuthoringBackendExposedError`. The resolved `MountPrefixes` (`dirs`, `files`, `writable`, `governed`, `unsearchable`) SHALL be the single classification input shared by the router, the kernel, session operations and `validate`; a nested directory name in it SHALL be matched by longest prefix wherever a path is classified or a root name checked for reservation.

`subagents` SHALL NOT be reserved: no part of the runtime reads that prefix, so a workspace may mount a directory of that name as ordinary agent-visible content.

#### Scenario: Mount over a session area refused

- **WHEN** a consumer supplies a mount at `/scratchpad/`
- **THEN** assembly throws `MountCollisionError` and no agent is returned

#### Scenario: Mount over the authoring prefix refused

- **WHEN** a consumer supplies a mount at `/workflows/` or `/workflows/order-lookup/`
- **THEN** assembly throws `MountCollisionError` naming what that prefix holds

#### Scenario: A former prefix is mountable

- **WHEN** a consumer supplies a mount at `/subagents/`
- **THEN** assembly succeeds and the mount is served as ordinary authored content

#### Scenario: Writable mount over the authoring backend refused

- **WHEN** a mount is declared `{ backend: authoring, readOnly: false }` where `authoring` is the authoring backend
- **THEN** assembly throws `AuthoringBackendExposedError` naming the mount key

#### Scenario: A nested mount name reserves its prefix

- **WHEN** the table mounts `/catalogs/eu/` and a session id `catalogs` is requested
- **THEN** the id is refused as a reserved root name, as it would be for a single-segment mount

### Requirement: Session areas and their kernel rules

A session's folder SHALL contain exactly these runtime-owned areas, addressed by the agent without any prefix:

- `scratchpad/` — the one working area; read and write SHALL be permitted in every state by kernel rule `tool.scratchpad`, independent of `tools.allow`;
- `large_tool_results/`, `conversation_history/` — offload areas; reads and listings SHALL be permitted in every state by rule `tool.offload-read`, and agent writes or edits SHALL be blocked by rule `zone.runtime-managed` with a message naming `scratchpad/`;
- `checkpoints/`, `artifacts/`, `_specs/` — runtime-internal areas; any agent tool access SHALL be blocked by rule `zone.runtime-internal`, and they SHALL be omitted from a root listing performed while a session is bound.

Any other path in the session folder SHALL be governed by the active state's `tools.allow`. A root listing while a session is bound SHALL show the declared mounts (file mounts surfaced even when the session folder holds no such entry) and the agent-addressable areas, and no `workflows` entry, since that prefix is never mounted; a listing outside a bound session SHALL be returned unshaped.

#### Scenario: Scratchpad open in every state

- **WHEN** the agent writes `scratchpad/draft.md` in a state whose `tools.allow` names no paths
- **THEN** the write is permitted by rule `tool.scratchpad`

#### Scenario: Offload pointer followed

- **WHEN** the transcript names `large_tool_results/<id>.txt` and the agent calls `read_file` on it with an offset and limit
- **THEN** the read is permitted by rule `tool.offload-read` and returns the requested slice

#### Scenario: Offload write blocked

- **WHEN** the agent calls `edit_file` on a path under `conversation_history/`
- **THEN** the call is blocked with rule `zone.runtime-managed` and a message directing writes to `scratchpad/`

#### Scenario: Internal area unreachable

- **WHEN** the agent lists `/` or attempts to read `_specs/<hash>.json`
- **THEN** `checkpoints`, `artifacts` and `_specs` are absent from the listing and the read is blocked with rule `zone.runtime-internal`

### Requirement: Offloaded context lands in the session

The fixed root paths Deep Agents' middleware writes evicted content to — `large_tool_results/` for oversized tool results and `conversation_history/` for evicted messages and summarization — SHALL resolve into the executing session's folder (`<sessionId>/large_tool_results/…`, `<sessionId>/conversation_history/…`) through the session store, with no change to the upstream middleware. No offload SHALL touch an authored backend. The system prompt's workspace-zones section, rendered from the resolved mounts, SHALL describe these areas as runtime-managed and read-only beside `scratchpad/`.

#### Scenario: Offload with an object-storage session store

- **WHEN** the consumer configures a backend session store and a tool result exceeds the eviction threshold
- **THEN** the full result is written through that store under the session's folder, with no local filesystem write and no authored-backend write

#### Scenario: Prompt describes the areas

- **WHEN** the system prompt is assembled
- **THEN** its workspace-zones section names `scratchpad/` as writable and the offload areas as read-only, runtime-managed

### Requirement: Session-qualified addressing for runtime-internal callers

Runtime callers that operate outside or across the per-turn binding — the checkpointer, artifact writing, session listing and seeding — SHALL address the session store with an explicit `<sessionId>/…` path as built by `sessionPaths(sessionId)`, and such access SHALL resolve to the same physical location as the agent's id-free access during that session's bound turn. Data shared across sessions SHALL use the session-agnostic `_specs/` prefix, which SHALL resolve at the store root whether or not a session is bound.

#### Scenario: Internal write without a bound session

- **WHEN** the checkpointer writes `<sessionId>/checkpoints/cp-1.json` outside any bound turn
- **THEN** the write lands at that physical path without requiring the session to be bound

#### Scenario: Internal and agent access agree

- **WHEN** `sessions.seed(id, { "scratchpad/notes.txt": "hi" })` writes through the store and the agent later reads `scratchpad/notes.txt` in a turn of session `id`
- **THEN** both resolve to the same file

#### Scenario: Spec snapshot is session-agnostic

- **WHEN** `_specs/<hash>.json` is written during a bound turn
- **THEN** it lands at the store root, not inside the session's folder

### Requirement: One retention model

Every area of a session's folder — `scratchpad/`, the offload areas, checkpoints and artifacts — SHALL be durable and kept for inspection after a turn ends. Nothing SHALL be discarded on completion; a session's state SHALL be removed only through `sessions.delete(sessionId)`.

#### Scenario: Scratchpad persists after the turn

- **WHEN** a session's turn completes
- **THEN** its `scratchpad/` contents remain readable, with the same lifecycle as its checkpoints and offloaded context

### Requirement: Session stores

The SDK SHALL own the logical session namespace — the `<sessionId>/…` layout, the reserved areas, the `_specs/` prefix, session-scoped routing and lazy creation — while the consumer SHALL own physical storage through a `SessionStore` (`kind`, `backend`, `capabilities: { list, delete }`, `deleteSession`). Three factories SHALL be exported: `createFilesystemSessionStore({ dir })` (listable and deletable; deletion contained under `dir`), `createBackendSessionStore({ backend, prefix?, deleteSession?, list? })` (any `BackendProtocolV2`; the `prefix` is applied inside the store and never appears in an SDK- or agent-visible path; `delete` capability only when `deleteSession` is supplied), and `createMemorySessionStore()` (Deep Agents `StoreBackend` over an `InMemoryStore`; nothing touches disk). With the default filesystem backend and no `sessionStore`, assembly SHALL default to a filesystem store at `<rootDir>/sessions/` (`DEFAULT_SESSIONS_DIR`), which the repository keeps gitignored. With a custom `backend` and no `sessionStore`, assembly SHALL throw `SessionStoreRequiredError` naming the three factories.

#### Scenario: Zero-config default

- **WHEN** `createAgent()` is called with no `backend` and no `sessionStore`
- **THEN** session `chat-42` lives under `<rootDir>/sessions/chat-42/`

#### Scenario: Backend store with prefix

- **WHEN** `createBackendSessionStore({ backend, prefix: "tenants/a" })` is used and a session writes a checkpoint
- **THEN** the record is stored through `backend` under `tenants/a/<sessionId>/checkpoints/…`, and no result path returned to the SDK or the agent carries `tenants/a`

#### Scenario: Custom backend requires a store

- **WHEN** `createAgent({ backend })` is called without `workspace.sessionStore`
- **THEN** assembly throws `SessionStoreRequiredError`

#### Scenario: Non-deletable store

- **WHEN** `sessions.delete(id)` is called over a backend store constructed without `deleteSession`
- **THEN** it throws `SessionStoreCapabilityError` and nothing is deleted

### Requirement: Session ids are validated at every ingress

A session id SHALL be rejected — via `sessionIdRejection` and `SessionStoreIdError`, both pure (`core/session-id.ts`) and exported from the root and from `@archmax-ai/harness/spec` so a host refuses a bad id with the same words before it reaches a store — when it is empty after stripping leading slashes, contains a `..` segment, or has a first segment equal to a reserved root name (a session area or, when the resolved mounts are supplied, a declared mount). The check SHALL run where an id becomes a store address: binding a turn (governed or plain), `sessions.seed`, `sessions.delete`, and the memory and filesystem stores' own deletion. A child session's id SHALL be `<parent>~<state>:<workflow>:<ordinal>`, derived rather than minted, and `parentSessionId` SHALL be derivable from it.

#### Scenario: Reserved id refused before any write

- **WHEN** a turn is bound to session id `skills` or `_specs`
- **THEN** it is refused with a message naming the reserved root name, before any session state is written

#### Scenario: Traversing id refused

- **WHEN** `sessions.delete("../x")` is called
- **THEN** it throws `SessionStoreIdError` and nothing outside the store is touched

### Requirement: Durable checkpointer

Absent a caller-supplied `checkpointer`, assembly SHALL use `BackendCheckpointSaver`: a LangGraph `MemorySaver` with **write-through** to the session store and **lazy per-session replay**. Every checkpoint (`{ k: "cp", ns, id, parent, cp, md }`) and pending write (`{ k: "w", ns, id, ik, taskId, channel, val }`) the parent accepts SHALL be persisted as one immutable JSON file under `<sessionId>/checkpoints/` (`cp-<key>.json`, `w-<key>.json`, key base64url-encoded and digest-truncated to fit a 255-byte file name); an "already exists" collision, which a create-only backend reports, SHALL be ignored. The first access to a session (`getTuple`, `list`, `put`, `putWrites`) SHALL replay its files into memory, a failed replay retrying on the next access; a listing that names no `thread_id` SHALL hydrate every non-reserved folder at the store root. `deleteThread` SHALL evict the session from memory and mark it as not to be replayed; physical removal is the store's job. The saver SHALL assume one writer per session id. A caller-supplied checkpointer SHALL be used as-is and the store not consulted for checkpoints.

#### Scenario: Session survives a process restart

- **WHEN** a session runs, the process exits, and a new process assembles the agent over the same store
- **THEN** invoking the same `thread_id` continues from the checkpointed position, variables, trail and transcript

#### Scenario: Checkpoints follow the store

- **WHEN** the session store is a backend store over object storage
- **THEN** checkpoint records are read and written through it with no change to the saver

#### Scenario: Deleted session is not resurrected

- **WHEN** `sessions.delete(id)` evicts a session and a later access names the same id
- **THEN** no record files are replayed for it

### Requirement: A session is extended, never copied

The runtime SHALL model a conversation as exactly one session: one checkpoint chain under one `thread_id`, one folder, one position in the machine. Each turn SHALL run on the same session id, continuing the retained position, variables, trail and transcript; the runtime SHALL never mint a second identity for an existing session, and a caller SHALL NOT need to replay earlier messages. An id SHALL be minted (`session-<uuid>`) only for a firing that declares no session. The checkpointed `status` SHALL be one of `running`, `completed`, `rejected`, `awaiting_decision`, `awaiting_input`; `completed` and `rejected` SHALL classify as **finished** and the rest as **open** (`classifyStatus`, `isFinished`), and a parked session SHALL never be reported finished. The checkpointed state SHALL also carry the `specHash` the session last ran under, its `entryState`, and its current `trigger`.

#### Scenario: Second turn on the same session

- **WHEN** a session's previous turn finished in `orders-question` and a new message arrives for it
- **THEN** the turn runs on the same session id and begins in `orders-question`, not at the trigger's entry state

#### Scenario: Parked session is open

- **WHEN** a session parks on `archmax_wait`, including in a terminal state
- **THEN** its status is `awaiting_input`, its classification is `open`, and no surface reports it completed

### Requirement: Session resolution and disposition

`agent.workflow.resolveSession({ trigger?, variables?, sessionId?, sessionPath? })` SHALL derive the session id from the most specific source — an explicit `sessionId`; else a dotted **session path** over the firing's variables (the caller's `sessionPath`, then the assembly's, then the invoking trigger's `session:` declaration on the state it enters, all read by one parser); else a minted id — and classify the disposition from the session's own checkpoint without invoking the graph or a model: `turn` (no prior state or finished; `startState` is the retained position when the current spec still declares it, else the trigger's entry state), `resume` (`awaiting_input`; any trigger resumes the parked state), or `reply` (`awaiting_decision`; the message is answered without routing). A session mid-turn (`running`) SHALL fail closed with `SessionNotResumableError`. A declared path that does not resolve SHALL fall back to a minted id with a `warning` event naming the trigger and path; a malformed caller path SHALL throw `InvalidSessionPathError`; a first turn under a trigger no state declares SHALL throw `UnknownSessionTriggerError`. `agent.workflow.send(sessionId, input)` SHALL apply the disposition, returning an `Outcome` whose `disposition` is `turn`, `decide`, `reply` or `deliver`.

#### Scenario: Declared path resolves the id

- **WHEN** state `intake` declares `triggers: { email_received: { session: triggers.-1.conversationId } }` and a firing supplies `triggers: [{ conversationId: "A" }, { conversationId: "B" }]`
- **THEN** the session id is `B`

#### Scenario: Parked session takes the firing

- **WHEN** the session is parked `awaiting_input` in `clarify` and a firing arrives whose trigger enters a state
- **THEN** the disposition is `resume` naming `clarify`; no competing turn starts

#### Scenario: Mid-turn session fails closed

- **WHEN** a firing arrives for a session whose status is `running`
- **THEN** resolution throws `SessionNotResumableError` naming the session and status

#### Scenario: An event with no start trigger names its session

- **WHEN** a host delivers an event that must not start a run (a closed ticket, say) for which no state declares a trigger
- **THEN** it names the session — `agent.workflow.send(sessionId, { delivery })` or `archmax deliver <session> --trigger <id>` — or supplies a `sessionPath` on the firing; a firing that names neither and whose trigger no state declares throws `UnknownSessionTriggerError`

### Requirement: Content-addressed spec snapshots

`computeSpecHash(spec)` SHALL hash the spec with object keys sorted at every level and every runtime-inert `metadata` block removed — at the root, on each state, and inside each rubric declared on a state's hooks — so key order, formatting and canvas state never change the hash. A governing edit SHALL change it, a rubric's `instructions`, `max_iterations` or `model` included. At each turn boundary whose machine `specHash` differs from the one the session last recorded, the runtime SHALL write that governing spec (without any `metadata` block) to `_specs/<specHash>.json` at the store root unless the file exists; a losing create race SHALL be treated as success and any other write failure SHALL be a `warning` event, never a turn failure. `agent.getSpecSnapshot(hash)` SHALL return the persisted `MachineSpec` or `null`.

The persisted snapshot SHALL carry each state's inline rubrics: a grader governed the session being recorded, so the record of what governed it is incomplete without the standards its transitions were held to.

#### Scenario: Hash ignores host metadata at every position

- **WHEN** two specs differ only in a `metadata` block at the root, on a state, or inside a rubric
- **THEN** `computeSpecHash` is identical and the persisted snapshot omits every such block

#### Scenario: A rubric edit is a governing edit

- **WHEN** two specs differ only in the `instructions` of a rubric one state declares
- **THEN** `computeSpecHash` differs and a snapshot is written for the new hash

#### Scenario: Definition changes between turns

- **WHEN** a session's first turn runs under spec A, `workflow.yaml` is edited to B, and the session takes a second turn
- **THEN** snapshots exist for both hashes and the session's recorded `specHash` is B's

#### Scenario: Unknown hash

- **WHEN** `getSpecSnapshot` is called with a hash no session has recorded
- **THEN** it resolves to `null` rather than throwing

### Requirement: Session operations

The agent SHALL expose `sessions.list()`, `sessions.get(sessionId)`, `sessions.messageCount(sessionId)`, `sessions.delete(sessionId)` and `sessions.seed(sessionId, files)` over the configured store. `messageCount()` SHALL read the transcript length off the latest checkpoint through `getTuple` alone (`0` for a session that has not run), so a host reads it before a turn and slices what the turn appended with `messagesSince` afterwards. `list()` SHALL enumerate the store root's non-reserved folders and project each latest checkpoint, returning `[]` when the checkpointer is not the `BackendCheckpointSaver` or the store cannot list. `get()` SHALL project one session through `getTuple` alone, so it works for any checkpointer, and return `null` for a session that has not run. `delete()` SHALL evict the session from the live checkpointer, remove its namespace through the store, release its per-session resources, and return whether anything was removed. `seed()` SHALL classify every key against the resolved mounts and write only paths in the governed session zone or `scratchpad/` at `<sessionId>/<path>` — strings verbatim, other values as JSON — rejecting the whole call when any key classifies as authored, internal, offload, root or escaping.

A `SessionSummary` SHALL carry `sessionId`, `status`, `classification`, `workflowState`, `specHash`, and for a parked session `state` (the state awaiting a decision or input) plus, for an `archmax_wait` park, `waitReason` and any absolute `resumeAt`; `variables` as the checkpoint holds them (`name -> { value, locked }`, omitted when empty — the reserved `title` variable, when set, names the session's task for a listing); `usage` when anything was spent; and `parentSessionId` for a child session. Malformed checkpointed variables or usage SHALL read as absent rather than failing the listing.

#### Scenario: Listing parked sessions

- **WHEN** one session is parked at a human state and another completed its latest turn
- **THEN** the listing reports the first with status `awaiting_decision` and its `state`, and the second `completed`

#### Scenario: Scheduled park listed

- **WHEN** a session parked with `until: "1d"` is listed
- **THEN** its summary carries the absolute `resumeAt`, and a park without a due time carries none

#### Scenario: Delete through the store

- **WHEN** `sessions.delete(id)` runs on a filesystem store
- **THEN** that session's checkpoints, artifacts, scratchpad and offloaded context are removed, and other sessions and `_specs/` are untouched

#### Scenario: Seeding a protected area rejected

- **WHEN** `sessions.seed(id, { "checkpoints/x.json": "..." })` is called
- **THEN** it throws naming the path and its zone, and nothing from that call is written

### Requirement: Session artifacts

`agent.emitRunArtifacts(sessionId, trajectory, { trail? })` SHALL write, through the workspace, under `<sessionId>/artifacts/` (paths from `runArtifactPaths`): `graph.json` and `graph.mmd` — for a governed session the machine's own topology from the spec (states, declared transitions, `on_error` routes as conditional edges, one start edge per trigger, human states marked), for a plain agent the compiled graph; `trajectory.json` — the supplied ordered record stamped with the session id; `metadata.json` — `sessionId`, `workflow`, `runtimeContract`, `packageVersion`, `specHash` (governed only) and `usage` when any was spent; `trail.json` — `{ sessionId, workflow, steps }` from the supplied trail or a fresh checkpoint read; `variables.json` — every checkpointed variable as `{ value, locked }`, an empty store written as an empty map. When the checkpoint cannot be read and no trail was supplied, `trail.json` and `variables.json` SHALL be skipped rather than written empty; a plain agent writes neither. Emission SHALL be best-effort: a write failure SHALL be a `warning` event with scope `run-artifacts` and a `null` return, never a thrown error.

#### Scenario: Governed graph comes from the spec

- **WHEN** artifacts are emitted for a governed session
- **THEN** `graph.json` lists the spec's states, transitions and `on_error` edges, and `metadata.json` carries the `specHash` that `getSpecSnapshot` resolves

#### Scenario: Trail reflects a resume

- **WHEN** a parked session is resumed by a decision and artifacts are emitted again
- **THEN** `trail.json` holds the `human` step alongside every step recorded before the park

#### Scenario: Unreadable checkpoint skips trail and variables

- **WHEN** the session's checkpoint cannot be read and no trail was supplied
- **THEN** graph, trajectory and metadata are written and `trail.json` and `variables.json` are not

#### Scenario: Write failure warns

- **WHEN** the store rejects an artifact write
- **THEN** a `warning` event is emitted and the call resolves to `null`

### Requirement: Audit trail

The runtime SHALL record an ordered `auditTrail` in checkpointed state, one `TrailStep` (`to`, `kind`, `ts`, optional `reason`, and for `sub-workflow` steps `workflow` and `status: ok | error`) at every commit site: `trigger` at each turn boundary (`to` the opening state, `reason` the trigger id); `agent` on a committed `archmax_advance` with its reason; `human` on a decision at a human state (`to` the chosen target, or the parked state itself when the decision ends the session), with the comment as reason when given; `reset` on `archmax_reset`; `on_error` when a failure routes to the state's `on_error` target; `sub-workflow` once per child session, with `to` the calling state. A vetoed or invalid transition SHALL append nothing. The channel's fold SHALL treat an equal list as a no-op echo, an extension as a replacement, and anything else as an append, so every step a state commits is retained in commit order and the order is total. A child session's trail SHALL never be spliced into the parent's. The trail SHALL be exposed on every `Outcome`, on `SessionView.auditTrail`, and in `trail.json`; a checkpoint predating the field SHALL read as an empty trail.

#### Scenario: Turn opening recorded

- **WHEN** a turn opens in state `identify-case` under trigger `manual`
- **THEN** the trail gains `{ to: "identify-case", kind: "trigger", reason: "manual" }`

#### Scenario: Vetoed transition leaves no step

- **WHEN** an `archmax_advance` is vetoed by an `after` hook
- **THEN** no step is appended

#### Scenario: Delegation recorded in the calling state

- **WHEN** state `enrich` calls `archmax_workflow_enrich-order` three times in one batch
- **THEN** three `sub-workflow` steps with `to: "enrich"` are recorded in call order, none of the child's own steps appear, and a later `archmax_advance` adds an `agent` step after them

### Requirement: Token accounting

After every model call the governance middleware SHALL read the provider's usage from the AI message (`usage_metadata` with `input_token_details.{cache_read,cache_creation}`, or the OpenAI-compatible and Anthropic raw shapes), treating a missing field as zero, and emit one `model-usage` event carrying `state`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, the `model` it was priced against, and `costUsd` when priced; the default model client SHALL request usage in its stream (`streamUsage: true`). The reported `inputTokens` SHALL be the **total** input count, of which `cacheReadTokens` and `cacheCreationTokens` are a breakdown: a provider shape that reports those counts beside an input count that excludes them SHALL be normalized to the inclusive total, so one reading holds whatever the provider sent. Cost SHALL come from a `PricingTable` (USD per million tokens; `input`, `output`, `cacheRead`, `cacheWrite`, a missing cache rate falling back to the input rate) resolved by exact model id, then the longest key that is a substring of the id, then `default`; the id resolved against SHALL be **the one the response reported, else the one the runtime asked the endpoint to run, else none** — a response that names no model SHALL NOT cost the call its price, and the id actually used SHALL appear on the event. Cost SHALL charge the input rate on the input tokens that were neither served from nor written to cache, and the cache rates on the remainder, never charging a cached token twice; a breakdown exceeding the reported total SHALL clamp the full-rate portion at zero rather than going negative. The `pricing` assembly option SHALL take precedence over `ARCHMAX_PRICE_INPUT`, `ARCHMAX_PRICE_OUTPUT`, `ARCHMAX_PRICE_CACHE_READ` and `ARCHMAX_PRICE_CACHE_WRITE` (which populate the `default` key); an unpriced model SHALL report tokens only and never a cost of zero. The session's cumulative `UsageSummary` SHALL be written to the checkpointed `usage` channel after each call, so totals survive parks and process restarts, and SHALL be read from the checkpoint onto `Outcome.usage`, `SessionSummary.usage` and `metadata.json` (the in-memory tracker is the fallback when the checkpoint holds none). The exported `createUsageTracker({ onEvent? })` SHALL accumulate `model-usage` events per session from the event envelope's `sessionId`, forward every event to the wrapped subscriber, and expose `totals(sessionId?)`, `bySession()` and `reset()`.

#### Scenario: Cache detail captured while streaming

- **WHEN** a streamed response reports cached-input detail beside its input and output counts
- **THEN** the `model-usage` event records cache-read and cache-creation tokens in their own fields, and `inputTokens` is the total that includes them

#### Scenario: A provider that echoes no model id is still priced

- **WHEN** a response carries usage but names no model, and a price table holds an entry keyed by the id the runtime asked the endpoint to run
- **THEN** that entry prices the call, `costUsd` appears on the `model-usage` event, and the event's `model` is the configured id

#### Scenario: The served model outranks the requested one

- **WHEN** a response names a model different from the one the runtime asked for, and the price table holds an entry for each
- **THEN** the call is priced from the entry for the model that answered, and the event's `model` is the reported id

#### Scenario: Cached tokens are charged once

- **WHEN** a call reports 20,000 input tokens of which 18,000 were served from cache, priced at an input rate and a lower cache-read rate
- **THEN** `costUsd` charges 2,000 tokens at the input rate and 18,000 at the cache-read rate, not 20,000 at the input rate plus 18,000 at the cache-read rate

#### Scenario: A disjoint provider shape is normalized

- **WHEN** a raw provider shape reports an input count that excludes its cache-read count
- **THEN** `inputTokens` reports the two combined and the call is priced identically to the same usage reported inclusively

#### Scenario: Unpriced model omits cost

- **WHEN** no `pricing` option and no `ARCHMAX_PRICE_*` variable is set
- **THEN** every `model-usage` event, `Outcome.usage` and `SessionSummary.usage` carry token counts and no `costUsd`

#### Scenario: Totals survive park and resume

- **WHEN** a session consumes tokens, parks at a human state, the process exits, and the session resumes elsewhere and consumes more
- **THEN** `sessions.get(id).usage` and the emitted `metadata.json` carry the sum of both stretches

#### Scenario: Tracker separates concurrent sessions

- **WHEN** two sessions run concurrently on one assembled agent with the tracker's handler as `onEvent`
- **THEN** `totals("a")` and `totals("b")` each hold only their own session's usage and `totals()` holds the sum
