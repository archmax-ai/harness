## MODIFIED Requirements

### Requirement: Session areas and their kernel rules

A session's folder SHALL contain exactly these runtime-owned areas, addressed by the agent without any prefix:

- `scratchpad/` — the one working area; read and write with a default file tool (the file tools, the file operations) that the active state is granted, or with one of the host's `essentialTools`, SHALL be permitted in every state by kernel rule `tool.scratchpad`, whatever the granting entry narrows; a file tool the state is not granted, and any other tool, SHALL need its state's grant there;
- `large_tool_results/`, `conversation_history/` — offload areas; reads and listings with a tool the scratchpad admits SHALL be permitted in every state by rule `tool.offload-read`, and agent writes or edits SHALL be blocked by rule `zone.runtime-managed` with a message naming `scratchpad/`;
- `checkpoints/`, `artifacts/`, `_specs/` — runtime-internal areas; any agent tool access SHALL be blocked by rule `zone.runtime-internal`, and they SHALL be omitted from a root listing performed while a session is bound.

Any other path in the session folder SHALL be governed by the active state's `tools.allow`. A root listing while a session is bound SHALL show the declared mounts (file mounts surfaced even when the session folder holds no such entry) and the agent-addressable areas, and no `workflows` entry, since that prefix is never mounted; a listing outside a bound session SHALL be returned unshaped.

#### Scenario: Scratchpad open in every state

- **WHEN** the agent writes `scratchpad/draft.md` in a state that is granted `write_file` (by the default tools, `tools.allow_always` or its own `tools.allow`) and whose entries name no paths
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

#### Scenario: Scratchpad closed to a file tool the state lacks

- **WHEN** the workflow declares `tools.allow_always: [read_file, ls]` and the agent calls `write_file` on `scratchpad/draft.md` in a state that does not name `write_file`
- **THEN** the call is blocked with rule `tool.not-allowed`, while `read_file` on `scratchpad/draft.md` is permitted by rule `tool.scratchpad`
