## ADDED Requirements

### Requirement: A session's files are stored under its id

A session's agent-visible files SHALL be stored in the session store under `<sessionId>/`, beneath
a backend store's `prefix`: the id-free path `scratchpad/x.txt` in a turn of session `s1` SHALL be
the store path `s1/scratchpad/x.txt`. A host MAY address a session's files through its own handle on
the store as `<sessionId>/<path>`, keyed by `ToolContext.sessionId` for a host tool's work. A child
session's files SHALL be under the child's own id, never its caller's.

#### Scenario: A host writes where the agent reads

- **WHEN** a host tool called in child session `s1~1` writes `s1~1/scratchpad/x.txt` through the
  session store
- **THEN** `read_file scratchpad/x.txt` in that child returns the content, and `s1` holds no
  `scratchpad/x.txt`

#### Scenario: A host reads past the workspace protocol

- **WHEN** a host serves a ranged read, a recursive listing or a presigned URL for a session's file
  through its own store handle
- **THEN** it addresses `<sessionId>/<path>` beneath its store's prefix and reaches the file the
  agent wrote at `<path>`
