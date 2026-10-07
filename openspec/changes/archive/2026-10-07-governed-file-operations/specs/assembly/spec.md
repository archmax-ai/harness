## MODIFIED Requirements

### Requirement: Assembly fails closed on misconfiguration

Assembly SHALL refuse, before any model call, each of: a host tool in `tools` whose name carries the reserved `archmax_` prefix, or takes the name of a runtime file operation (`copy_file`, `move_file`, `remove_file`) (`ReservedToolNameError`, naming every offender at once, on the governed and the plain path); a host path declaration for a built-in tool, with an unknown access, or with no argument (`ToolPathsError`); a custom `backend` without `workspace.sessionStore` (`SessionStoreRequiredError`, naming the store factories); a writable mount served by the same backend as the authoring backend (`AuthoringBackendExposedError`, naming the mount key); a partly composed workspace whose filesystem default would be built over the working directory (`WorkspaceRootRequiredError`, naming the option); a mount key that shadows a session area (`MountCollisionError`); a workflow declaring an unsupported runtime contract (`UnsupportedRuntimeContractError`); and a `hookExecutors` entry registered under a built-in hook kind. Each error class a caller can catch SHALL be exported from the package root.

#### Scenario: Reserved tool name

- **WHEN** `tools` contains a tool named `archmax_anything`
- **THEN** assembly throws `ReservedToolNameError` before reading the workflow

#### Scenario: Custom backend without a session store

- **WHEN** `backend` is supplied and `workspace.sessionStore` is not
- **THEN** assembly throws `SessionStoreRequiredError`; storage is never inferred

#### Scenario: Authoring backend behind a writable mount

- **WHEN** a `workspace.mounts` entry is declared writable and its backend is the authoring backend
- **THEN** assembly throws `AuthoringBackendExposedError`

#### Scenario: A host tool shadowing a file operation

- **WHEN** a host passes a tool named `copy_file` in `tools`
- **THEN** `createAgent` throws `ReservedToolNameError` naming it, before any model call

### Requirement: Extension options

`essentialTools` SHALL name host tools treated as always-on (disclosed and permitted in every state, still narrowed by a per-state entry and bound by safety and policy rules), and SHALL apply to every child machine the assembly composes. `toolPaths` SHALL declare host tools' path arguments by tool name (see the governance requirement "Tools declare their path arguments"), and SHALL apply to every child machine the assembly composes. `policyRules` SHALL insert custom kernel rules after the safety and `policy` rules and before per-state grants. `hookExecutors` SHALL register custom hook kinds beside `script` and `rubric`. `sandboxRuntime` SHALL replace the default QuickJS runtime for the sandbox tools and hook scripts. Omitting every extension option SHALL yield the default behaviour.

#### Scenario: A built-in hook kind cannot be overridden

- **WHEN** `hookExecutors` carries a `script` or `rubric` key
- **THEN** assembly throws naming the shadowed kind

## ADDED Requirements

### Requirement: A host tool is handed the turn's workspace

A `toolsFromMap` descriptor SHALL accept `paths` (its path declaration, carried to assembly with the
tool), and its handler SHALL receive a second argument, a `ToolContext` whose `workspace` is the
turn's workspace: the host's mounts with their read-only posture and the session zone at the root,
bound to the session the turn runs — the instance the built-in file tools resolve through, carrying
`downloadFiles`, `uploadFiles` and `delete` besides the text methods. The governed and the plain
composition SHALL bind the same context for every turn, a delegated child's included. Called outside
a turn, the handler SHALL still run, and reading `context.workspace` SHALL throw an error saying the
workspace exists only during a turn.

#### Scenario: A host tool reads what read_file reads

- **WHEN** a host tool reads `skills/x/SKILL.md`, `AGENTS.md`, a file under a writable `tmp/` mount
  backed by memory, and a `scratchpad/` file through `context.workspace`
- **THEN** each returns the content `read_file` returns for the same path

#### Scenario: Bytes and deletion through the context

- **WHEN** a host tool uploads a PNG to `scratchpad/a.png` through `context.workspace`, downloads it
  and deletes it, then uploads to and deletes under a read-only mount
- **THEN** the bytes round-trip, the file is removed, and the read-only mount answers `permission_denied`
  for the upload and an error naming the path as written for the delete
