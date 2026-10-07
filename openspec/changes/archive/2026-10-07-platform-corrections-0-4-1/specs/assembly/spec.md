## MODIFIED Requirements

### Requirement: A host tool is handed the turn's workspace

A `toolsFromMap` descriptor SHALL accept `paths` (its path declaration, carried to assembly with the
tool), and its handler SHALL receive a second argument, a `ToolContext` whose `workspace` is the
turn's workspace: the host's mounts with their read-only posture and the session zone at the root,
bound to the session the turn runs — the instance the built-in file tools resolve through, carrying
`downloadFiles`, `uploadFiles` (when the session store has it) and `delete` besides the text methods. The governed and the plain
composition SHALL bind the same context for every turn, a delegated child's included. Called outside
a turn, the handler SHALL still run, and reading `context.workspace` SHALL throw an error saying the
workspace exists only during a turn; the property SHALL be non-enumerable there, so a deep-equality
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
- **THEN** neither throws, the context equals `{}`, and `"workspace" in context` is still true

### Requirement: Subpath entry points for the specialist surfaces

Surfaces that need deep access SHALL be published as subpaths declared in the `exports` map with their own `types` and `import` conditions: `@archmax-ai/harness/sandbox` (hook authoring: `ok`, `veto`, `correct`, `defineHook`, `HookInput`, `HookVerdict`, `HookMessage`, `TrailStep`), `@archmax-ai/harness/testing` (the case engine: `runTests`, `discoverCases`, `runCase`, `reduceVerdict`, `exitCodeForVerdict`, `assertWorkflowGovernedTarget`, `createCaseTarget`, `parseCaseDocument`, `serializeCaseDocument`, the title and description length constants, `CaseSchemaError`, `createToolMockMiddleware`, `partialMatch`), and `@archmax-ai/harness/cli` (`renderEventLine`, `createStyle`, `icons`, `createStateFlowRenderer`, `createTestView`, `caseVerdictLine`). A symbol SHALL live on at most one of the root and these **heavy** subpaths.

Two **light** subpaths SHALL publish vocabulary with no runtime behind it: `@archmax-ai/harness/spec` — the `workflow.yaml` schema (every exported schema, `parseMachineSpec`, `refineSpec`, `stateTriggersSchema`), the pure validator (`validateSpec`, `lintSpec`, `schemaIssueDiagnostic`), mount grants and hook shape (`normalizeMountGrants`, `mountNameOf`, `mountNameOfPattern`, `normalizeHooks`, `hookKind`, `hookValue`), the slug, trigger and variable grammars (`SLUG_PATTERN`, `isSlug`, `parseSessionPath`, `resolveSessionId`, `sessionIdForTrigger`, `triggerBindings`, `stateTriggerIds`, `declaredVariableNames`, `VARIABLE_NAME_PATTERN`, the reserved variables, `parseReferences`, `resolveText`, …), the trigger signature (`SIGNATURE_TYPES`, `normalizeSignature`, `signatureForTrigger`, `signatureJsonSchema`, `signatureValueIssues`, and the `SignatureEntry`, `SignatureType`, `TriggerSignature` and `SignatureValueIssue` types), the tool names and delegation bounds, the root namespace (`SESSION_*`, `sessionAreaNames`, `classifyWorkspacePath`, `isReservedRootName`, `AUTHORING_PREFIXES`, `authoringPlanePrefix`), the session-id rule and child-id convention (`sessionIdRejection`, `SessionStoreIdError`, `isChildSessionOf`, `parentSessionIdOf`, `childSessionId`, `subRunIdentity`), the paths (`workflowPaths`, `sessionPaths`, `resolveHookScript`, `HOOKS_DIR`), `parseCodeDescription`, and Deep Agents' binary types (`BINARY_MIME_TYPES`, `binaryMimeTypeOf`: the extensions whose `write` carries base64 the store decodes), with their types — and `@archmax-ai/harness/messages` — the transcript readers (`contentToString`, `messageTypeOf`, `isAiMessage`, `isHumanMessage`, `isRuntimeNote`, `runtimeNoteKind`, `lastAgentText`, `opensTurn`, `messagesSince`, `lastTurn`, `RuntimeNoteKind`). A light subpath's transitive runtime import graph SHALL reach no `node:*` module and no bare specifier other than `zod` and `picomatch` (`spec`) or none at all (`messages`); a unit test SHALL walk the graph from each barrel and fail on any other specifier, skipping type-only imports. An allowed bare specifier SHALL itself be browser-safe: the same test SHALL walk that library's own transitive files, across nested packages, and fail on a `node:*` or bare builtin import and on a read of `process`, `Buffer`, `__dirname` or `__filename` that no `typeof` guard covers. A name on both the root and a light subpath SHALL be the same binding, and each light subpath SHALL be documented in its own section of the public API page, checked in both directions.

`validateSpec(value)` SHALL be total — never throwing, yielding every schema issue as an `error` diagnostic addressed by `field` beside the lint's findings, with the typed spec when the shape held — and the loader SHALL obtain its schema and lint findings from it, so `archmax validate` and an editor report the same findings for one document.

`signatureForTrigger(spec, triggerId)` SHALL read a trigger's normalized signature from a parsed spec — its `description` and its `requires`/`returns` as `{ name, type?, description? }` entries — the same reading the machine exposes, so a host that holds only a spec (an editor, an API request path) reads a signature without compiling a machine.

#### Scenario: Hook authoring import

- **WHEN** a hook script imports `ok` and `veto` from `@archmax-ai/harness/sandbox`
- **THEN** it type-checks, and in the sandbox the import line is stripped and the prelude supplies the names

#### Scenario: Case engine import

- **WHEN** a consumer imports `runTests` from `@archmax-ai/harness/testing`
- **THEN** cases run, and the same symbol is not exported from the package root

#### Scenario: The spec subpath is browser-safe

- **WHEN** the runtime import graph of `src/public/spec.ts` is walked
- **THEN** every bare specifier reached is `zod` or `picomatch`, and no `node:*`, `deepagents`, `@langchain/*`, `gray-matter` or `dotenv` import is reached

#### Scenario: An allowed library is browser-safe itself

- **WHEN** the files of `zod` and `picomatch` are walked from the entry a bundler would take
- **THEN** no `node:*` or bare builtin import is reached, and no `process`, `Buffer`, `__dirname` or `__filename` is read outside a `typeof` guard — so the bundled subpath evaluates where no `process` global exists

#### Scenario: One binding on two paths

- **WHEN** `MANUAL_TRIGGER` is imported from the root and from `@archmax-ai/harness/spec`
- **THEN** the two are the same value, and the same holds for every name the two share

#### Scenario: A blank transition description shows inline

- **WHEN** an editor calls `validateSpec` on a document whose transition has `description: "  "`
- **THEN** it receives an `error` diagnostic at `states.<s>.transitions.0.description`, not a thrown refusal

#### Scenario: A host reads a signature without a machine

- **WHEN** an editor imports `signatureForTrigger` and `signatureJsonSchema` from `@archmax-ai/harness/spec` and applies them to a parsed spec's `manual` trigger
- **THEN** it receives the trigger's normalized signature and the JSON Schema the delegation tool is built from, with no runtime module loaded

#### Scenario: A host store reads the binary types from the spec subpath

- **WHEN** a host store imports `binaryMimeTypeOf` from `@archmax-ai/harness/spec`
- **THEN** it answers `image/png` for `a/logo.PNG` and `undefined` for `notes.txt`, from the same table the file operations use
