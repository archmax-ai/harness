## MODIFIED Requirements

### Requirement: Session areas and their kernel rules

A session's folder SHALL contain exactly these runtime-owned areas, addressed by the agent without any prefix:

- `scratchpad/` — the one working area; read and write with an essential tool (the file tools, the file operations, the host's `essentialTools`) SHALL be permitted in every state by kernel rule `tool.scratchpad`, independent of `tools.allow`; any other tool SHALL need its state's grant there;
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

### Requirement: The workspace carries raw bytes and deletion

The workspace backend SHALL carry `downloadFiles`, `uploadFiles` and `delete` end to end, routing each
path as a read or a write is routed — an exact file mount to its backend, any other path through the
composite — with paths canonicalized first and mapped in and out of every prefix (a mount's route, the
session store's tenancy prefix, the bound session id), so no result names a session id or a
store-internal path. Text-only callers SHALL be unaffected.

The three methods are optional in Deep Agents' protocol, which feature-detects them, and SHALL stay
optional: no wrapper (`mountSubtree`, the session zone, the workspace router) SHALL throw for want of
one, and a store serving only the required methods SHALL serve skills, reads and text copies.
`downloadFiles` SHALL always be present and SHALL read a store without the raw channel through
`readRaw`: bytes as they come, text encoded as UTF-8, and text holding U+FFFD refused with
`permission_denied`, so a download is the file's exact bytes or an error. `uploadFiles` SHALL be
present on the workspace exactly when the session store has it — Deep Agents appends its history
through `uploadFiles` when present and through `edit` otherwise — and a store without it behind
another route SHALL refuse that file with `permission_denied`. `delete` SHALL answer a store without
it with an error.

Deep Agents SHALL be handed the workspace without `delete`, so its own recursive `delete` tool is
neither shown to the model nor able to delete; `remove_file` SHALL be the agent's one way to delete a
file, governed and plain agents alike. The file operations and host tools SHALL keep `delete`.

#### Scenario: Bytes round-trip through the session zone

- **WHEN** a caller uploads a PNG to `scratchpad/a.png` during a bound session and downloads it
- **THEN** the bytes are equal, the result paths read `/scratchpad/a.png`, and a `delete` removes it

#### Scenario: Stores with only the required methods

- **WHEN** every store — the session store and each mount — serves only the protocol's required
  methods, and a plain agent runs with a `skills/` mount
- **THEN** its skills are found, `copy_file` copies a text file byte for byte, and `remove_file`
  answers that the store cannot do that, with no call throwing

#### Scenario: No uploadFiles without the session store's

- **WHEN** the session store has no `uploadFiles`
- **THEN** the workspace has none, and with one, an upload to a writable mount without it is refused
  for that file only

#### Scenario: Deleting is remove_file's alone

- **WHEN** a plain or a governed agent is assembled over a workspace that can delete
- **THEN** the model is shown `remove_file` and no `delete` tool, and a `delete` call named anyway
  answers that deletion is not available
