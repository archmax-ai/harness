## MODIFIED Requirements

### Requirement: `createAgent` mirrors `createDeepAgent`

`createAgent(params)` SHALL accept Deep Agents' own parameters under Deep Agents' names and meanings — `model`, `tools`, `systemPrompt`, `middleware`, `backend`, `skills`, `checkpointer`, `store`, `interruptOn`, `name`, `description` — so a `createDeepAgent` call ports by changing only the import, with one recorded exception. the harness's concerns SHALL be additive options that rename or reshape no shared concept: `workflow`, `workspace` (`rootDir`, `mounts`, `sessionStore`), `authoring`, `trigger`, `variables`, `sessionPath`, `modelFactory`, `essentialTools`, `policyRules`, `sandboxRuntime`, `onEvent`, `promptCache`, `pricing`. `store`, `interruptOn` and `name` SHALL reach `createDeepAgent` untouched on both the governed and the plain composition, and `middleware` SHALL be honoured on both — appended after the runtime's own middleware — so `toolMocks` reports the host's tool-mock middleware on a plain agent too.

`subagents` SHALL NOT be a parameter. It is the one deliberate deviation from parity: an agent-facing subagent is not a concept the archmax harness offers, because each need it served has a governed construct — grading is a **grader state** on the graph (see `automated-states`), and delegating work to another reasoning context is a **sub-workflow**. Assembly SHALL register no subagent of its own with `createDeepAgent`, on either composition: a grader state's subagent is built by the runtime for each run of that state and is never registered. `createDeepAgent` builds its general-purpose subagent on every composition and takes no parameter
that leaves it out: a governed agent SHALL NOT be offered `task` in any state (see `governance`),
and a plain agent SHALL be offered `task` with the general-purpose subagent alone, as a plain
Deep Agent is.

#### Scenario: A Deep Agents call ports unchanged

- **WHEN** a consumer calls `createAgent({ model, tools, systemPrompt, backend })` with arguments previously passed to `createDeepAgent`
- **THEN** an agent is assembled with the same meaning for every one of those options

#### Scenario: The one deviation is a type error

- **WHEN** a consumer passes `subagents`
- **THEN** it is a type error, and the documented parity list records the parameter as removed with grader states and sub-workflows as its replacements

#### Scenario: A plain agent is offered task

- **WHEN** an agent assembled with `workflow: false` makes a model call
- **THEN** the call offers `task`, whose description names the general-purpose subagent and no other

#### Scenario: Governance is one added option

- **WHEN** the same call adds `workflow: "order-lookup"`
- **THEN** the assembled agent is governed by that machine and no other option changes meaning

#### Scenario: Grader states register no subagent

- **WHEN** a governed agent is assembled for a workflow declaring a grader state
- **THEN** `createDeepAgent` is handed no subagent, so the general-purpose subagent it builds
  itself is the only one, and no state's model call offers `task`

### Requirement: Governance is opt-in and fails closed

Omitting `workflow` SHALL yield a plain Deep Agent — no machine, no control tools, no per-state tool gating — over the same workspace, session store, event stream and skills, with `agent.workflow` undefined. Naming a `workflow` whose `workflow.yaml` is missing or has no valid machine spec SHALL throw `WorkflowLoadError` naming the workflow and the problem rather than returning an ungoverned agent. A YAML frontmatter block in `WORKFLOW.md` beside `workflow.yaml` SHALL be a `competing-machines` load error. The plain agent SHALL be returned only when no workflow was requested and the default workflow's spec file does not exist, or when `workflow: false` declares the agent ungoverned — in which case no spec SHALL be read; an existing but invalid default spec fails when `workflow` is merely omitted.

The plain agent SHALL be a first-class host path: its `invoke`, `stream` and `streamEvents` SHALL be bound to the session named by `configurable.thread_id` — the session zone's id-free view and the event context — exactly as a governed turn is, so the agent's `scratchpad/…` and offload paths land under `<sessionId>/` in the session store, and a reserved or escaping id SHALL be refused with `SessionStoreIdError` as a rejection before anything is written.

#### Scenario: Ungoverned assembly

- **WHEN** `createAgent({ model })` is called with no `workflow` and no `workflows/order-lookup/workflow.yaml` exists
- **THEN** a plain agent is returned whose tool surface is its bound tools, and `agent.workflow` is `undefined`

#### Scenario: Missing named workflow

- **WHEN** `workflow: "nope"` names a workflow with no `workflow.yaml`
- **THEN** assembly throws `WorkflowLoadError`

#### Scenario: Invalid default workflow

- **WHEN** no `workflow` is given but the default workflow's `workflow.yaml` exists and fails the schema
- **THEN** assembly throws `WorkflowLoadError` instead of falling back to a plain agent

#### Scenario: Ungoverned by declaration

- **WHEN** `createAgent({ workflow: false })` is called over a root that holds a valid `workflows/order-lookup/workflow.yaml`
- **THEN** a plain agent is returned, `agent.workflow` is `undefined`, and no `workflows/**` path was read from the authoring backend

#### Scenario: A plain turn is a session

- **WHEN** a plain agent's `invoke` runs under `thread_id: "s1"` and the model writes `scratchpad/note.md`
- **THEN** the file is at `s1/scratchpad/note.md` in the session store, not at its root, and `sessions.get("s1")` reports the session

### Requirement: Assembly fails closed on misconfiguration

Assembly SHALL refuse, before any model call, each of: a host tool in `tools` whose name carries the reserved `archmax_` prefix, or takes the name of a runtime file operation (`copy_file`, `move_file`, `remove_file`) (`ReservedToolNameError`, naming every offender at once, on the governed and the plain path); a host path declaration for a built-in tool, with an unknown access, or with no argument (`ToolPathsError`); a custom `backend` without `workspace.sessionStore` (`SessionStoreRequiredError`, naming the store factories); a writable mount served by the same backend as the authoring backend (`AuthoringBackendExposedError`, naming the mount key); a partly composed workspace whose filesystem default would be built over the working directory (`WorkspaceRootRequiredError`, naming the option); a mount key that shadows a session area (`MountCollisionError`); and a workflow declaring an unsupported runtime contract (`UnsupportedRuntimeContractError`). Each error class a caller can catch SHALL be exported from the package root.

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

### Requirement: The authoring backend is never served to the agent

`authoring` SHALL name the backend the runtime reads `workflows/<slug>/` from — `workflow.yaml` (its grader states' instructions included), `WORKFLOW.md`, code-state scripts (`workflows/<slug>/scripts/`), cases. It SHALL default to `backend` when one is supplied, else to a filesystem backend over the resolved root. It SHALL appear in no mount table, no root listing and no path an agent tool or sandbox `tools.*` call can address; code-state scripts SHALL be read from it by a separate executor while `archmax_run` reads from the agent workspace, both sharing one sandbox runtime. The runtime SHALL read nothing from a workflow's `hooks/` directory.

There SHALL be no second authoring prefix. A grader's prompt is part of the spec, so it is protected by the one route that does not exist rather than by a directory reserved for it.

#### Scenario: Default authoring backend

- **WHEN** `createAgent({ workflow: "order-lookup" })` is called with no `authoring`
- **THEN** the spec, its prose, its grader states' instructions and its code-state scripts are read from the root's `workflows/` directory, which no agent tool can reach

#### Scenario: Rubrics need no agent-visible route

- **WHEN** a workflow declares grader states, which replace inline rubrics, and the workspace serves no authored mount at all
- **THEN** each grader runs on the `instructions` its state declares in the spec read through the authoring backend

#### Scenario: A code-state script stays out of the agent's reach

- **WHEN** a code state declares `script: scripts/check-refund.js`
- **THEN** the runtime reads `workflows/<slug>/scripts/check-refund.js` through the authoring
  backend, and no agent tool or sandbox `tools.*` call can read that file

### Requirement: Every workspace file is read through a backend

Assembly SHALL read every file it needs through a Deep Agents backend — the machine spec, `WORKFLOW.md` and code-state scripts through the authoring backend; `AGENTS.md` and skill bundles through the agent's workspace composite — never via direct `fs`. The only pre-assembly or consumer-chosen exceptions SHALL be `.env` loading from the workspace root and the filesystem session store's own storage. The default platform prompt SHALL be compiled into the runtime, not read from a file.

Grader states SHALL add no file to that list: a grader's instructions arrive inside the state that declares them.

#### Scenario: Custom backend

- **WHEN** a caller supplies a custom `backend`, `sessionStore` and `mounts`
- **THEN** every workspace read flows through those backends, and skill discovery issues backend reads only

#### Scenario: No grader read

- **WHEN** an agent is assembled for a workflow that declares grader states
- **THEN** no read beyond the machine spec was issued to obtain their instructions

### Requirement: System prompt composition

Assembly SHALL compose the system prompt from, in order: `AGENTS.md`; the consumer's `systemPrompt`; the platform prompt, for a governed agent only (`.platform/system/GRAPH_STATE.md` when the workspace serves it, else the prompt compiled into the runtime, whatever the backend); the workspace-zones section rendered from the resolved mounts; the workflow header rendered from the spec — its `title` and root `instructions`, and no state of the graph; and the `WORKFLOW.md` prose with HTML comments stripped. It SHALL hand that text to `createDeepAgent` as `systemPrompt: { prefix, base: null }`, so Deep Agents' own base prompt is dropped and the persona leads. The middleware's tool guidance (the `write_todos` section) and the volatile "Current state" block — which carries the current date and time (rounded to a ten-minute bucket so a turn's calls share one line), the active state's `instructions`, its outgoing transitions, its markers, the run's trigger signature, its skills, the governed mounts it reaches with their read-only/read-write posture, its variable names and its argument constraints — follow per model call; the composed layers SHALL be the cacheable prefix. Because the prefix is a function of the workflow's header alone, it SHALL NOT grow with the number of states. A plain agent (no machine) SHALL get no platform prompt. `resolveSystemPrompt` SHALL take the override path as a required `platformBackendPath`, `null` leaving the platform layer out.

#### Scenario: Persona leads, base prompt absent

- **WHEN** a governed agent with `AGENTS.md` and a consumer `systemPrompt` issues its first model call
- **THEN** the system message starts with the persona, then the consumer text, then the platform prompt, the zones and the workflow header, and never contains "You are a Deep Agent"

#### Scenario: The prefix does not grow with the graph

- **WHEN** a one-state workflow and a twenty-state workflow declare the same `title` and root
  `instructions`
- **THEN** their cacheable prefixes are byte-identical, and neither carries any state's slug,
  title, summary, markers or transitions

#### Scenario: Disabled flag is not rendered

- **WHEN** the same workflow is rendered with and without `disabled: true`
- **THEN** the system prompt is identical

#### Scenario: A custom backend gets the platform prompt

- **WHEN** a governed agent is assembled on a custom `backend` that serves no `.platform/system/GRAPH_STATE.md`
- **THEN** its system prompt carries the platform prompt compiled into the runtime, and no warning is emitted

#### Scenario: A workspace overrides the platform prompt

- **WHEN** the workspace serves `.platform/system/GRAPH_STATE.md`
- **THEN** that text is the platform layer, in place of the compiled-in prompt

#### Scenario: A plain agent has no platform layer

- **WHEN** an agent is assembled with `workflow: false`
- **THEN** its system prompt contains no platform prompt, whether or not the workspace serves an override

### Requirement: Model configuration

When neither `model` nor `modelFactory` is given, assembly SHALL use `createChatModel()`: a `ChatOpenAI` pointed at any OpenAI-compatible endpoint, configured from `ARCHMAX_API_BASE_URL`, `ARCHMAX_API_KEY`, `ARCHMAX_MODEL`, and optional `ARCHMAX_TEMPERATURE`, `ARCHMAX_MAX_TOKENS`, `ARCHMAX_STREAMING` (default on, with `streamUsage`). `.env` SHALL be loaded from the workspace root (`workspace.rootDir`, else the consumer's working directory), never from the package's install directory, and a variable already in the process environment SHALL win. `ARCHMAX_MODEL` SHALL be the default a spec may override, not the last word: `settings.model` and a state's `model` name the id a turn runs on, over the same endpoint and credentials.

`modelFactory(role, env, requested?)` SHALL supply the model per role — `ModelRole = "agent" | "judge" | "grader"`: `agent` (the session's agent), `judge` (the case grader) and `grader` (a grader state's subagent); there SHALL be no `rubric` role — with `env` a thunk so a factory bringing its own credentials never loads `ARCHMAX_*`; an explicit `model` SHALL take precedence for the agent role. `requested` SHALL carry the model id the spec asks for — for the `grader` role the grader state's `model` else the spec's `settings.model`, and for the `agent` role the state's `model` else the spec's `settings.model` — so one seam resolves every model the runtime uses; a factory that ignores the argument SHALL behave as though it were absent. `createChatModel` SHALL apply a `requested` id over `ARCHMAX_MODEL`, keeping the configured endpoint and credentials, and SHALL build one model per distinct id per assembly.

A grader state's model SHALL be resolved once per composition, however many times the state runs (see `automated-states`): through `modelFactory("grader", env, requested)` when a factory is supplied; otherwise the env-configured model at the requested id, or the assembly's default agent model when neither the state nor the spec declares an id.

`createChatModel` SHALL read a response naming no role, or a role the chat-completions protocol does not define for another turn, as the assistant's, on both the streaming-delta and the whole-message conversion seams.

#### Scenario: Factory supplies every model

- **WHEN** `modelFactory` is supplied and no `ARCHMAX_*` variable is set
- **THEN** assembly succeeds, and the agent, case-grader and grader-state models all come from the factory

#### Scenario: A rubric's model id reaches the factory

- **WHEN** a grader state, which replaces a rubric, declares `model: some-model-id`
- **THEN** the factory is called for the `grader` role with that id as `requested`, and never for
  a `rubric` role, which no longer exists

#### Scenario: A grader state's model is resolved once

- **WHEN** a grader state declaring `model: some-model-id` runs three times in one session
- **THEN** the factory was called for the `grader` role with that id once for the composition,
  and every run used the model it returned

#### Scenario: A grader state inherits the spec's model id

- **WHEN** the spec declares `settings: { model: some-model-id }` and a grader state declares no
  `model`
- **THEN** the factory is called for the `grader` role with `some-model-id` as `requested`

#### Scenario: A state's model id reaches the factory

- **WHEN** the state in force declares `model: some-model-id`
- **THEN** the factory is called for the `agent` role with that id as `requested`

#### Scenario: The default path applies the requested id

- **WHEN** a grader state declares a `model` and no `modelFactory` is supplied
- **THEN** the grader runs on that id against the configured endpoint and credentials, and no other role's model changes

#### Scenario: A grader with no declared id runs on the default model

- **WHEN** neither a grader state nor the spec declares a `model` and no `modelFactory` is supplied
- **THEN** the grader runs on the assembly's default agent model

#### Scenario: A factory may ignore the request

- **WHEN** a factory taking only `(role, env)` is supplied and a grader state declares a `model`
- **THEN** the factory's model is used and the unhonoured request raises no error

#### Scenario: Real environment wins

- **WHEN** `ARCHMAX_MODEL` is set in the process environment and `.env` names another
- **THEN** the process value is used

### Requirement: The model a turn runs on follows the state in force

A governed assembly SHALL resolve the model per model call from the machine position the call is
made in: the state's `model`, else the spec's `settings.model`, else the assembly's default
agent model. Resolution SHALL go through the one seam every other model uses —
`modelFactory("agent", env, requested)` when a factory is supplied, otherwise
`createChatModel({ ...env(), model: requested })` — and SHALL build **one model per distinct id
per assembly**, memoized, so a workflow naming two ids builds two models however many turns run.
A factory that ignores `requested` SHALL behave as though the spec named nothing, raising no
error.

The swap SHALL happen in the workflow middleware's model-call wrapper, where the state in force
is already known, and SHALL therefore apply to that state's agent turns and to a park's
reply-only handoff turn, and to nothing else. An automated state makes no model call of the
session's agent, so the swap resolves no model for it: a grader state's model is resolved under
the `grader` role (see "Model configuration"), and the case grader keeps its own model
resolution. A sub-workflow SHALL resolve the ids its **own** spec declares, inheriting neither
the caller's `settings.model` nor the caller's state model.

Naming a model SHALL change nothing else about a turn: the same tool surface, the same prompt
layers, the same governance verdicts, the same events. Usage and cost SHALL continue to be
reported per call against the model that answered, so a workflow mixing models reports each
against its own pricing entry.

#### Scenario: Each state's call carries its own model

- **WHEN** a governed session advances from a state declaring `model: small-model` to one
  declaring `model: large-model`
- **THEN** the first state's model calls are made with `small-model` and the second's with
  `large-model`, with one model built per id

#### Scenario: The factory is asked for the id in force

- **WHEN** `modelFactory` is supplied and the state in force declares `model: small-model`
- **THEN** the factory is called for the `agent` role with `small-model` as `requested`, and its
  result is reused for every later call in a state resolving to that id

#### Scenario: A sub-workflow resolves its own ids

- **WHEN** a workflow declaring `settings: { model: small-model }` dispatches
  `archmax_workflow_<slug>` to a child whose spec declares no model
- **THEN** the child's turns run on the assembly's default agent model, not on `small-model`

#### Scenario: A reply-only turn follows the parked state

- **WHEN** a session parked at a human state declaring `model: small-model` is replied to
- **THEN** the handoff turn's single model call is made with `small-model`

#### Scenario: A grader keeps its own model

- **WHEN** a workflow declaring `settings: { model: small-model }` advances from an agent state
  into a grader state declaring `model: large-model`
- **THEN** the grader's model calls are made with `large-model`, resolved under the `grader`
  role, and the agent's calls keep `small-model`

### Requirement: An explicit model instance outranks a declared id, and says so

An explicit `model` handed to `createAgent` SHALL keep precedence for the agent role over every
id a spec declares: a host that constructed a model instance means it, and the SDK SHALL NOT
rebuild it under another id. When a spec declares `settings.model` or any agent or human state's
`model` while an explicit `model` is in force, assembly SHALL emit exactly **one** `warning`
event naming the ignored ids and the states that declare them, and SHALL NOT fail — so a host
learns that supplying `modelFactory` instead is what honours the declaration. A grader state's
`model` SHALL NOT be named there: it is resolved under the `grader` role, which an explicit
`model` does not override.

#### Scenario: The declared ids are reported once

- **WHEN** `createAgent({ model, workflow })` is called for a spec declaring `settings.model` and
  two state models
- **THEN** assembly succeeds, every turn runs on the supplied instance, and one `warning` event
  names the ignored ids and the declaring states

#### Scenario: A factory honours what an instance overrides

- **WHEN** the same spec is assembled with `modelFactory` and no explicit `model`
- **THEN** no warning is emitted and each state's turns run on the id it declares

#### Scenario: A grader's id is not reported as ignored

- **WHEN** `createAgent({ model, workflow })` is called for a spec whose only declared id is a
  grader state's `model`
- **THEN** no warning is emitted, and the grader runs on that id

### Requirement: Extension options

`essentialTools` SHALL name host tools treated as always-on (disclosed and permitted in every state, still narrowed by a per-state entry and bound by safety and policy rules), and SHALL apply to every child machine the assembly composes. `toolPaths` SHALL declare host tools' path arguments by tool name (see the governance requirement "Tools declare their path arguments"), and SHALL apply to every child machine the assembly composes. `policyRules` SHALL insert custom kernel rules after the safety and `policy` rules and before per-state grants. `sandboxRuntime` SHALL replace the default QuickJS runtime for the sandbox tools and code-state scripts. There SHALL be no option registering a custom hook kind: `hookExecutors` and the `HookExecutor` type are removed. Omitting every extension option SHALL yield the default behaviour.

#### Scenario: A built-in hook kind cannot be overridden

- **WHEN** a consumer passes `hookExecutors` to `createAgent`, keyed `script`, `rubric` or anything else
- **THEN** it is a type error, and assembly reads nothing from it: no hook kind remains to
  register or override

#### Scenario: One sandbox runtime for agent scripts and code states

- **WHEN** a host supplies `sandboxRuntime`
- **THEN** `archmax_eval`, `archmax_run` and every code state's script run in it

### Requirement: Diagnostics flow through the event stream

Every assembly-time and runtime diagnostic — `interpreter-enabled`, `skills-loaded`, `prompt-shaping`, `graph-topology`, spec-load and platform-prompt `warning`s, usage — SHALL be emitted as a `WorkflowLifecycleEvent`. When `onEvent` is supplied it SHALL receive every event and the runtime SHALL write nothing to the console; when omitted, a default console subscriber renders them.

There SHALL be no grader-loading diagnostic: grader states arrive with the spec, so their availability is not a loading step with its own outcome to report.

#### Scenario: Handler replaces the console

- **WHEN** `createAgent` is called with `onEvent`
- **THEN** assembly diagnostics reach the handler and no console line is written

#### Scenario: No graders-loaded event

- **WHEN** an agent is assembled for a workflow declaring grader states
- **THEN** no event reports graders being loaded

### Requirement: Delegation targets are resolved at assembly; children are composed lazily

Assembly SHALL read the `manual` signature of every workflow an `archmax_workflow_<slug>` allow entry names, once per target, and bind one delegation tool per target. A missing target, an invalid spec or a target with no `manual` entry SHALL fail assembly with `WorkflowLoadError`; a target declaring `disabled: true` SHALL still bind (the dispatcher refuses it). Child compositions SHALL be built from the same `AssemblyContext` as the root — model, backends, mounts, session store, checkpointer, host tools, `essentialTools`, skills, `policyRules`, pricing, event emitter — taking its grader states and their model ids from its own spec rather than inheriting the caller's, and inheriting every ancestor's `policy` denials (the caller hands down what it inherited plus its own), composed lazily and memoized per slug and delegation chain, so a broken child surfaces at dispatch, never at assembly.

#### Scenario: Missing target fails assembly

- **WHEN** a state allows `archmax_workflow_absent` and no such workflow exists
- **THEN** assembly throws `WorkflowLoadError` naming the slug

#### Scenario: Uncalled targets are not composed

- **WHEN** an allowed delegation tool is never called
- **THEN** its spec is read for the signature but no child agent is composed

### Requirement: Runtime contract resolution

Assembly, `validate` and the case engine SHALL resolve a workflow's runtime contract from the spec's `runtime: { engine, version }` block, its sole source: engine and version verbatim, `source: "declared" | "defaulted"`, and the derived `sandbox` and `testFormat` surfaces. Omitted metadata SHALL resolve to `archmax-harness@3` with `source: "defaulted"`, sandbox contract `3` and case format `1`. No engine id SHALL be normalized to another.

#### Scenario: Omitted runtime block

- **WHEN** `workflow.yaml` declares no `runtime`
- **THEN** the contract resolves to engine `archmax-harness`, version `"3"`, `source: "defaulted"`, sandbox `3`, and the workflow remains valid

### Requirement: Runtime contract support checking

The runtime SHALL keep one table of supported contracts — `archmax-harness@3` alone, implying sandbox contract `3` and case format `1` — and a governed assembly SHALL throw `UnsupportedRuntimeContractError` (carrying `requested` and `supported`) before any model call when the declared contract is not in it. The retired contracts `archmax-harness@1` and `archmax-harness@2` SHALL be refused the same way, naming the supported set; there SHALL be no compatibility path for them. `validateWorkflow` SHALL report the same case as an error diagnostic naming the requested and supported contracts. A plain agent SHALL require no runtime metadata. Version `3` identifies the current authoring contract (two-file layout, grader and code states, code-state scripts with typed `@archmax-ai/harness/sandbox` imports); load behaviour SHALL be layout-driven, not version-driven.

#### Scenario: Unsupported contract

- **WHEN** a workflow declares `runtime: { engine: archmax-harness, version: "9" }`
- **THEN** assembly fails with `UnsupportedRuntimeContractError` naming `archmax-harness@9` and the supported set, and the model is never invoked

#### Scenario: Another engine id

- **WHEN** a workflow declares `runtime.engine: other`
- **THEN** it is rejected as unsupported as declared, with no normalization

#### Scenario: A retired contract is refused

- **WHEN** a workflow declares `runtime: { engine: archmax-harness, version: "2" }` or `version: "1"`
- **THEN** assembly fails with `UnsupportedRuntimeContractError` naming the declared contract and
  the supported set `archmax-harness@3`, the model is never invoked, and `validateWorkflow`
  reports the same as an error diagnostic

### Requirement: One contract governs runtime, sandbox and case format

The resolved contract SHALL be the only version negotiation: it selects the sandbox script contract (`sandbox` 3; the prelude is assembled per context, `ptc` for the agent's `archmax_eval` and `archmax_run` or `code` for a code state's script, against that version) and the case format (`testFormat`); a case file SHALL carry no version of its own. The contract SHALL be observable as `agent.runtimeContract`, and `emitRunArtifacts` SHALL record it with `packageVersion` (`PACKAGE_VERSION`) in `metadata.json`. `createCaseTarget` SHALL assemble through `createAgent`, so cases run under the same checks.

#### Scenario: Metadata records the contract

- **WHEN** a session emits artifacts
- **THEN** `metadata.json` carries the resolved runtime contract and the package version

#### Scenario: The one contract selects sandbox 3

- **WHEN** an agent is assembled for a workflow that declares no `runtime`
- **THEN** `agent.runtimeContract` reports version `"3"`, sandbox `3` and case format `"1"`, and
  both the `ptc` and the `code` prelude are assembled against sandbox contract `3`

### Requirement: An enumerated public surface, tested against its documentation

The root barrel (`src/index.ts`) SHALL export a small, enumerated API — `createAgent`, `ArchmaxAgent`, the option and outcome types, the error classes, workspace composition (`defaultMounts`, `mountSubtree`, the three session-store factories, `isReservedRootName`, `sessionIdRejection`, `isChildSessionOf`, `createWorkspaceContext`, `PLATFORM_PROMPT_PATH`), the park readers (`readParkedSession`, `pendingParkOf`, `parkedStateOf`), prompt and message plumbing (`lastAgentText` included), `loadMachineSpec`, `WorkflowMachine`, `validateWorkflow`, the delegation bounds, the trigger and tool-name constants (`sessionIdForTrigger` included), the event types, usage helpers, `createChatModel`, `BUNDLED_AUTHORING_SKILL_DIR`, `PACKAGE_VERSION` and the runtime-contract types — every export carrying a docstring. A unit test SHALL pin an upper bound on the barrel's runtime export count, keep the heavy subpaths disjoint from the root, check that `package.json` declares every subpath's built module, and compare the barrel (type exports included) with the export list in `docs/src/content/docs/reference/public-api.md` in both directions.

The barrel SHALL export no grader loader, inspector, merge helper, registry projection or definition type: a grader state is spec content, so nothing outside the runtime assembles a grader. It SHALL export none of the removed hook vocabulary either: no `normalizeHooks`, `HookExecutor` or `RubricDeclaration`.

#### Scenario: Documented list matches the barrel

- **WHEN** the reference page's export list is compared with the barrel's runtime and type exports
- **THEN** no barrel export is undocumented and no documented name is missing

#### Scenario: Internals are not importable from the root

- **WHEN** a consumer imports a checkpointer class, a prompt renderer or an allow-matcher from `@archmax-ai/harness`
- **THEN** the import fails at type-check and at runtime

#### Scenario: The grader loader surface is gone

- **WHEN** a consumer imports a subagent inspector, parser, registry loader, merge helper or definition type from `@archmax-ai/harness`
- **THEN** the import fails at type-check and at runtime

#### Scenario: The hook surface is gone

- **WHEN** a consumer imports `normalizeHooks`, `HookExecutor` or `RubricDeclaration` from `@archmax-ai/harness`
- **THEN** each import fails at type-check, and `normalizeHooks` is absent at runtime

### Requirement: Subpath entry points for the specialist surfaces

Surfaces that need deep access SHALL be published as subpaths declared in the `exports` map with their own `types` and `import` conditions: `@archmax-ai/harness/sandbox` (code-state authoring: `defineCodeState`, `CodeStateInput`, `CodeStateFn`, `HistoryMessage`, `TrailStep`, `SandboxTools`; it SHALL carry none of the removed hook vocabulary — `ok`, `veto`, `correct`, `defineHook` and the hook types), `@archmax-ai/harness/testing` (the case engine: `runTests`, `discoverCases`, `runCase`, `reduceVerdict`, `exitCodeForVerdict`, `assertWorkflowGovernedTarget`, `createCaseTarget`, `parseCaseDocument`, `serializeCaseDocument`, the title and description length constants, `CaseSchemaError`, `createToolMockMiddleware`, `partialMatch`), and `@archmax-ai/harness/cli` (`renderEventLine`, `createStyle`, `icons`, `createStateFlowRenderer`, `createTestView`, `caseVerdictLine`). A symbol SHALL live on at most one of the root and these **heavy** subpaths.

Two **light** subpaths SHALL publish vocabulary with no runtime behind it: `@archmax-ai/harness/spec` — the `workflow.yaml` schema (every exported schema, `parseMachineSpec`, `refineSpec`, `stateTriggersSchema`), the pure validator (`validateSpec`, `lintSpec`, `schemaIssueDiagnostic`), mount grants (`normalizeMountGrants`, `mountNameOf`, `mountNameOfPattern`), the slug, trigger and variable grammars (`SLUG_PATTERN`, `isSlug`, `parseSessionPath`, `resolveSessionId`, `sessionIdForTrigger`, `triggerBindings`, `stateTriggerIds`, `declaredVariableNames`, `VARIABLE_NAME_PATTERN`, the reserved variables, `parseReferences`, `resolveText`, …), the trigger signature (`SIGNATURE_TYPES`, `normalizeSignature`, `signatureForTrigger`, `signatureJsonSchema`, `signatureValueIssues`, and the `SignatureEntry`, `SignatureType`, `TriggerSignature` and `SignatureValueIssue` types), the tool names and delegation bounds, the root namespace (`SESSION_*`, `sessionAreaNames`, `classifyWorkspacePath`, `isReservedRootName`, `AUTHORING_PREFIXES`, `authoringPlanePrefix`), the session-id rule and child-id convention (`sessionIdRejection`, `SessionStoreIdError`, `isChildSessionOf`, `parentSessionIdOf`, `childSessionId`, `dispatchIdOf`, `rootSessionIdOf`), the paths (`workflowPaths`, `sessionPaths`, `resolveCodeScript`, `SCRIPTS_DIR`), `parseCodeDescription`, and Deep Agents' binary types (`BINARY_MIME_TYPES`, `binaryMimeTypeOf`: the extensions whose `write` carries base64 the store decodes), with their types — and `@archmax-ai/harness/messages` — the transcript readers (`contentToString`, `messageTypeOf`, `isAiMessage`, `isHumanMessage`, `isRuntimeNote`, `runtimeNoteKind`, `lastAgentText`, `opensTurn`, `messagesSince`, `lastTurn`, `RuntimeNoteKind`). The spec subpath SHALL carry none of the removed hook shape (`normalizeHooks`, `hookKind`, `hookValue`, `resolveHookScript`, `HOOKS_DIR`). A light subpath's transitive runtime import graph SHALL reach no `node:*` module and no bare specifier other than `zod` and `picomatch` (`spec`) or none at all (`messages`); a unit test SHALL walk the graph from each barrel and fail on any other specifier, skipping type-only imports. An allowed bare specifier SHALL itself be browser-safe: the same test SHALL walk that library's own transitive files, across nested packages, and fail on a `node:*` or bare builtin import and on a read of `process`, `Buffer`, `__dirname` or `__filename` that no `typeof` guard covers. A name on both the root and a light subpath SHALL be the same binding, and each light subpath SHALL be documented in its own section of the public API page, checked in both directions.

`validateSpec(value)` SHALL be total — never throwing, yielding every schema issue as an `error` diagnostic addressed by `field` beside the lint's findings, with the typed spec when the shape held — and the loader SHALL obtain its schema and lint findings from it, so `archmax validate` and an editor report the same findings for one document.

`signatureForTrigger(spec, triggerId)` SHALL read a trigger's normalized signature from a parsed spec — its `description` and its `requires`/`returns` as `{ name, type?, description? }` entries — the same reading the machine exposes, so a host that holds only a spec (an editor, an API request path) reads a signature without compiling a machine.

#### Scenario: Hook authoring import

- **WHEN** a script imports `ok`, `veto`, `correct` or `defineHook` from `@archmax-ai/harness/sandbox`
- **THEN** the import fails at type-check: the subpath carries no hook vocabulary

#### Scenario: Code-state authoring import

- **WHEN** a code-state script imports `defineCodeState` and the `CodeStateInput` type from `@archmax-ai/harness/sandbox`
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

#### Scenario: A host resolves a code-state script path from the spec subpath

- **WHEN** an editor calls `resolveCodeScript` from `@archmax-ai/harness/spec` for `scripts/check-refund.js` and for `scripts/../hooks/x.js`
- **THEN** the first resolves to `workflows/<slug>/scripts/check-refund.js` and the second is refused with a reason
