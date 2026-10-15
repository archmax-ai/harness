## MODIFIED Requirements

### Requirement: A host tool is handed the turn's workspace

A `toolsFromMap` descriptor SHALL accept `paths` (its path declaration, carried to assembly with the
tool), and its handler SHALL receive a second argument, a `ToolContext` whose `workspace` is the
turn's workspace: the host's mounts with their read-only posture and the session zone at the root,
bound to the session the turn runs — the instance the built-in file tools resolve through, carrying
`downloadFiles`, `uploadFiles` (when the session store has it) and `delete` besides the text methods — and whose
`sessionId` is the id of the session the call is made in: inside a sub-workflow's dispatch, the
child's own id (`<parent>~<n>`), never the session the host sent the turn to. The governed and the plain
composition SHALL bind the same context for every turn, a delegated child's included, where the
session binding is made, so it holds for a model's tool call and for a script's call through the PTC
gateway alike. Called outside
a turn, the handler SHALL still run, and reading `context.workspace` or `context.sessionId` SHALL throw an error saying it
exists only during a turn; the properties SHALL be non-enumerable there, so a deep-equality
check or a serializer walking the context does not throw.

#### Scenario: A host tool reads what read_file reads

- **WHEN** a host tool reads `skills/x/SKILL.md`, `AGENTS.md`, a file under a writable `tmp/` mount
  backed by memory, and a `scratchpad/` file through `context.workspace`
- **THEN** each returns the content `read_file` returns for the same path

#### Scenario: Bytes and deletion through the context

- **WHEN** a host tool uploads a PNG to `scratchpad/a.png` through `context.workspace`, downloads it
  and deletes it, then uploads to and deletes under a read-only mount
- **THEN** the bytes round-trip, the file is removed, and the read-only mount answers `permission_denied`
  for the upload and an error naming the path as written for the delete

#### Scenario: An out-of-turn context can be compared and serialized

- **WHEN** a host invokes a tool outside a turn and its handler's context is compared with `{}` and passed to `JSON.stringify`
- **THEN** neither throws, the context equals `{}`, and `"workspace" in context` and
  `"sessionId" in context` are still true

#### Scenario: A host tool names the session its call is made in

- **WHEN** a host tool is called in session `s1`, and in the child `s1~1` that `s1` dispatched,
  each time once by the model and once by a script through the PTC gateway
- **THEN** it reads `context.sessionId` `s1` in the parent and `childSessionId("s1", 1)`, `s1~1`, in
  the child, from both callers
