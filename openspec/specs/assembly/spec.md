# assembly Specification

## Purpose

Define how the archmax harness assembles an agent: `createAgent(params)` takes LangChain Deep Agents' own
parameters, adds `workflow` and a small set of additive options, and returns a `ArchmaxAgent` wrapper
over one compiled Deep Agent graph. This spec covers the parameters and their defaults, the errors
assembly fails closed with, the wrapper and its governance surface, Deep Agents parity, the single
framework seam, the enumerated public API and its subpaths, model configuration, runtime contract
versioning, and how the package is distributed.

## Requirements

### Requirement: `createAgent` mirrors `createDeepAgent`

`createAgent(params)` SHALL accept Deep Agents' own parameters under Deep Agents' names and meanings — `model`, `tools`, `systemPrompt`, `middleware`, `backend`, `skills`, `checkpointer`, `store`, `interruptOn`, `name`, `description` — so a `createDeepAgent` call ports by changing only the import, with one recorded exception. the harness's concerns SHALL be additive options that rename or reshape no shared concept: `workflow`, `workspace` (`rootDir`, `mounts`, `sessionStore`), `authoring`, `trigger`, `variables`, `sessionPath`, `modelFactory`, `essentialTools`, `policyRules`, `hookExecutors`, `sandboxRuntime`, `onEvent`, `promptCache`, `pricing`. `store`, `interruptOn` and `name` SHALL reach `createDeepAgent` untouched on both the governed and the plain composition, and `middleware` SHALL be honoured on both — appended after the runtime's own middleware — so `toolMocks` reports the host's tool-mock middleware on a plain agent too.

`subagents` SHALL NOT be a parameter. It is the one deliberate deviation from parity: an agent-facing subagent is not a concept the archmax harness offers, because each need it served has a governed construct — grading is a **rubric** declared on the hook that applies it, and delegating work to another reasoning context is a **sub-workflow**. Assembly SHALL pass `generalPurposeAgent: false` to `createDeepAgent` on every composition.

#### Scenario: A Deep Agents call ports unchanged

- **WHEN** a consumer calls `createAgent({ model, tools, systemPrompt, backend })` with arguments previously passed to `createDeepAgent`
- **THEN** an agent is assembled with the same meaning for every one of those options

#### Scenario: The one deviation is a type error

- **WHEN** a consumer passes `subagents`
- **THEN** it is a type error, and the documented parity list records the parameter as removed with rubrics and sub-workflows as its replacements

#### Scenario: Governance is one added option

- **WHEN** the same call adds `workflow: "order-lookup"`
- **THEN** the assembled agent is governed by that machine and no other option changes meaning

### Requirement: Governance is opt-in and fails closed

Omitting `workflow` SHALL yield a plain Deep Agent — no machine, no control tools, no per-state tool gating — over the same workspace, session store, event stream and skills, with `agent.workflow` undefined. Naming a `workflow` whose `workflow.yaml` is missing or has no valid machine spec SHALL throw `WorkflowLoadError` naming the workflow and the problem rather than returning an ungoverned agent. A YAML frontmatter block in `WORKFLOW.md` beside `workflow.yaml` SHALL be a `competing-machines` load error. The plain agent SHALL be returned only when no workflow was requested and the default workflow's spec file does not exist, or when `workflow: false` declares the agent ungoverned — in which case no spec SHALL be read and no rubric discovered; an existing but invalid default spec fails when `workflow` is merely omitted.

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

Assembly SHALL refuse, before any model call, each of: a host tool in `tools` whose name carries the reserved `archmax_` prefix (`ReservedToolNameError`, naming every offender at once, on the governed and the plain path); a custom `backend` without `workspace.sessionStore` (`SessionStoreRequiredError`, naming the store factories); a writable mount served by the same backend as the authoring backend (`AuthoringBackendExposedError`, naming the mount key); a partly composed workspace whose filesystem default would be built over the working directory (`WorkspaceRootRequiredError`, naming the option); a mount key that shadows a session area (`MountCollisionError`); a workflow declaring an unsupported runtime contract (`UnsupportedRuntimeContractError`); and a `hookExecutors` entry registered under a built-in hook kind. Each error class a caller can catch SHALL be exported from the package root.

#### Scenario: Reserved tool name

- **WHEN** `tools` contains a tool named `archmax_anything`
- **THEN** assembly throws `ReservedToolNameError` before reading the workflow

#### Scenario: Custom backend without a session store

- **WHEN** `backend` is supplied and `workspace.sessionStore` is not
- **THEN** assembly throws `SessionStoreRequiredError`; storage is never inferred

#### Scenario: Authoring backend behind a writable mount

- **WHEN** a `workspace.mounts` entry is declared writable and its backend is the authoring backend
- **THEN** assembly throws `AuthoringBackendExposedError`

### Requirement: The return value is a wrapper over the compiled graph

`createAgent` SHALL return a `ArchmaxAgent`: a delegating wrapper over the compiled Deep Agent graph, not the graph itself. It SHALL expose `invoke(input, config?)`, `stream(input, options?)` and `streamEvents(...)`; `graph` (the compiled `CompiledStateGraph`, a real Pregel); the checkpoint surface `getState`, `getStateHistory`, `updateState`, `getSubgraphs`, `getSubgraphsAsync`, `getGraphAsync`, delegated to the graph; and `checkpointer` and `store` accessors. `withConfig(config)` SHALL return a new `ArchmaxAgent` carrying the merged config, so `.workflow` and the session-level members survive reconfiguration. Every method SHALL be bound so the agent survives destructuring. The wrapper SHALL carry a default config of integration metadata (`ls_integration: "archmax-harness"`) and a generous recursion limit (`DEFAULT_RECURSION_LIMIT`) that a caller's config overrides. A governed agent's `invoke` and `stream` SHALL go through the turn runner, which binds the session and event context around the turn; a plain agent drives its graph directly. `{ messages }` alone SHALL start a governed session, with the `manual` trigger applied when none is given.

#### Scenario: Reconfiguration preserves governance

- **WHEN** a consumer calls `agent.withConfig({ recursionLimit: 100 })` on a governed assembly
- **THEN** the result is a distinct `ArchmaxAgent` whose `workflow.machine` and `sessions` are the same objects and whose graph runs under the merged config

#### Scenario: The graph is a real Pregel

- **WHEN** a consumer reads `agent.graph`
- **THEN** it is the compiled `CompiledStateGraph` (carrying `lg_is_pregel`), usable for LangGraph-native integrations, while the wrapper itself is not a Pregel

#### Scenario: Destructured methods still work

- **WHEN** a caller writes `const { invoke, withConfig } = agent`
- **THEN** both calls succeed against the agent they were taken from

### Requirement: Session-level members live on the agent; governance is namespaced

Every `ArchmaxAgent`, governed or plain, SHALL carry `sessions` (`SessionOperations`), `emitRunArtifacts`, `getSpecSnapshot`, `dispose(sessionId)`, `runtimeContract` and `toolMocks` (whether the tool-mock middleware is wired, always `false` on a plain assembly). Only what is meaningless without a machine SHALL hang off `agent.workflow` (`WorkflowSurface`): `name`, `machine`, `resolveTrigger`, `decide`, `reply`, `deliver`, `resolveSession` and `send`. `Agent` SHALL be the exported name of the wrapper type; a governed agent is an `Agent` whose `workflow` is present, and no separate type names it.

#### Scenario: A plain assembly still has sessions

- **WHEN** a consumer calls `agent.sessions.list()` or `agent.emitRunArtifacts(...)` on a plain assembly
- **THEN** the configured session store answers and artifacts are written, with `specHash`, `variables.json` and `trail.json` omitted

#### Scenario: Governance is reached under `workflow`

- **WHEN** a consumer needs the compiled machine or trigger resolution
- **THEN** they are at `agent.workflow.machine` and `agent.workflow.resolveTrigger`, and on a plain assembly `agent.workflow` is `undefined`

### Requirement: `send` is the one entry into a session

`agent.workflow.send(sessionId, input, config?)` SHALL accept a turn (`{ message, trigger?, variables?, sessionPath? }`) or a resume payload (`{ decision }` or `{ delivery }`) and settle to one `Outcome` whose `disposition` is `turn`, `decide`, `reply` or `deliver`. A turn SHALL be resolved through `resolveSession` first: a new or finished session takes it as its next turn; a session parked at a human state has it answered as a reply (`reply`); a session parked with `archmax_wait` has its trigger, variables **and message** delivered (`deliver`) — the message travels with the firing rather than being dropped. A session that ends rejected SHALL settle an `Outcome` of kind `rejected` carrying `rejected`, the reason the runtime committed, and every resume outcome (`DecideOutcome`) SHALL carry it the same way. When a parked session's pending decision belongs to a delegated child, the `Outcome` SHALL carry `delegation` (`DelegatedPark`: `workflow`, the child's `sessionId`, `identity`, `dispatchId`, `toolCallId`, calling `state`). A fresh turn on a workflow declaring `disabled: true` SHALL throw `WorkflowDisabledError`; an empty message SHALL throw `EmptyMessageError`. `config` SHALL merge into the invoke config.

#### Scenario: A turn on a new session

- **WHEN** `send("s1", { message: "Which orders are delayed?" })` is called on a fresh session id
- **THEN** one turn runs under `thread_id: "s1"` and one `Outcome` with `disposition: "turn"` is returned

#### Scenario: A decision for a session nobody holds

- **WHEN** `send(id, { decision })` names a session that is not parked at a human state
- **THEN** `SessionNotParkedError` is thrown and the graph is not invoked

### Requirement: Workspace composition

The `workspace` group SHALL compose the agent's workspace root as a Deep Agents `CompositeBackend` whose default route is the session zone over the resolved session store, with authored content mounted at the keys of `workspace.mounts` (key → backend, or `{ backend, readOnly }`; a trailing slash marks a directory mount, none an exact-path file mount; mounts are read-only unless declared otherwise and enforce read-only themselves). With no custom `backend`, omitted `mounts` SHALL apply `defaultMounts(rootDir)` and omitted `sessionStore` SHALL default to a filesystem store at `<rootDir>/sessions`; with a custom `backend`, omitted `mounts` SHALL serve nothing authored, so exposing that backend is an explicit act (`mountSubtree(backend, "skills")`). `rootDir` SHALL default to the consumer's current working directory **only** when none of `backend`, `mounts`, `sessionStore` and `authoring` is supplied. Once any of them is, a filesystem default that still needs a root SHALL be refused with `WorkspaceRootRequiredError` naming the option rather than built over the cwd; and when every source is supplied, no root SHALL be resolved — `WorkspaceContext.rootDir` is absent. Assembly SHALL resolve the mount table exactly once, through `createWorkspaceContext`, and share the resolved `MountPrefixes` with routing, the kernel and static validation. `createWorkspaceContext` SHALL be public so a consumer serving authored content from its own backend composes the same way.

#### Scenario: Zero-config workspace

- **WHEN** `createAgent({ workflow })` is called with no `backend`, `mounts` or `sessionStore`
- **THEN** the conventional mounts are applied over the working directory and sessions land under `<cwd>/sessions/`

#### Scenario: Custom backend exposes nothing implicitly

- **WHEN** a custom `backend` is supplied with a `sessionStore` and no `mounts`
- **THEN** no authored path is served to the agent

#### Scenario: A partly composed workspace gets no silent root

- **WHEN** `createWorkspaceContext({ mounts: {} })` is called with no `rootDir`
- **THEN** it throws `WorkspaceRootRequiredError` naming `sessionStore`, and nothing is built over the working directory

#### Scenario: A fully composed workspace has no root

- **WHEN** `mounts`, `sessionStore` and `authoring` are all supplied and no `rootDir`
- **THEN** the context is built and its `rootDir` is absent

### Requirement: The authoring backend is never served to the agent

`authoring` SHALL name the backend the runtime reads `workflows/<slug>/` from — `workflow.yaml` (its inline grading rubrics included), `WORKFLOW.md`, hook scripts, cases. It SHALL default to `backend` when one is supplied, else to a filesystem backend over the resolved root. It SHALL appear in no mount table, no root listing and no path an agent tool or sandbox `tools.*` call can address; hook scripts SHALL be read from it by a separate executor while `archmax_run` reads from the agent workspace, both sharing one sandbox runtime.

There SHALL be no second authoring prefix. A grader's prompt is part of the spec, so it is protected by the one route that does not exist rather than by a directory reserved for it.

#### Scenario: Default authoring backend

- **WHEN** `createAgent({ workflow: "order-lookup" })` is called with no `authoring`
- **THEN** the spec, its prose, its rubrics and its hook scripts are read from the root's `workflows/` directory, which no agent tool can reach

#### Scenario: Rubrics need no agent-visible route

- **WHEN** a workflow's states declare rubric hooks and the workspace serves no authored mount at all
- **THEN** the rubric registry is populated by walking the spec read through the authoring backend

### Requirement: Every workspace file is read through a backend

Assembly SHALL read every file it needs through a Deep Agents backend — the machine spec, `WORKFLOW.md` and hook scripts through the authoring backend; `AGENTS.md` and skill bundles through the agent's workspace composite — never via direct `fs`. The only pre-assembly or consumer-chosen exceptions SHALL be `.env` loading from the workspace root and the filesystem session store's own storage. The default platform prompt SHALL be compiled into the runtime, not read from a file.

Graders SHALL add no file to that list: a rubric arrives inside the state that applies it.

#### Scenario: Custom backend

- **WHEN** a caller supplies a custom `backend`, `sessionStore` and `mounts`
- **THEN** every workspace read flows through those backends, and skill discovery issues backend reads only

#### Scenario: No grader read

- **WHEN** an agent is assembled for a workflow whose states declare rubric hooks
- **THEN** no read beyond the machine spec was issued to obtain them

### Requirement: System prompt composition

Assembly SHALL compose the system prompt from, in order: `AGENTS.md`; the consumer's `systemPrompt`; the platform prompt, for a governed agent only (`.platform/system/GRAPH_STATE.md` when the workspace serves it, else the prompt compiled into the runtime, whatever the backend); the workspace-zones section rendered from the resolved mounts; the workflow header rendered from the spec — its `title` and root `instructions`, and no state of the graph; and the `WORKFLOW.md` prose with HTML comments stripped. It SHALL hand that text to `createDeepAgent` as `systemPrompt: { prefix, base: null }`, so Deep Agents' own base prompt is dropped and the persona leads. Deep Agents' tool guidance (middleware) and the volatile "Current state" block — which carries the current date and time (rounded to a ten-minute bucket so a turn's calls share one line), the active state's `instructions`, its outgoing transitions, its markers and hooks, the run's trigger signature, its skills, the governed mounts it reaches with their read-only/read-write posture, its variable names and its argument constraints — follow per model call; the composed layers SHALL be the cacheable prefix. Because the prefix is a function of the workflow's header alone, it SHALL NOT grow with the number of states. A plain agent (no machine) SHALL get no platform prompt. `resolveSystemPrompt` SHALL take the override path as a required `platformBackendPath`, `null` leaving the platform layer out.

#### Scenario: Persona leads, base prompt absent

- **WHEN** a governed agent with `AGENTS.md` and a consumer `systemPrompt` issues its first model call
- **THEN** the system message starts with the persona, then the consumer text, then the platform prompt, the zones and the workflow header, and never contains "You are a Deep Agent"

#### Scenario: The prefix does not grow with the graph

- **WHEN** a one-state workflow and a twenty-state workflow declare the same `title` and root
  `instructions`
- **THEN** their cacheable prefixes are byte-identical, and neither carries any state's slug,
  title, summary, markers, hooks or transitions

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

### Requirement: Skills are discovered once through the backend

`skills` SHALL be the list of skill sources read through the agent's workspace (default `["skills/"]`; `[]` for none), discovered once per assembly into the registry that disclosure, the kernel and `validate` share; a source that serves nothing SHALL NOT be an error. A governed assembly SHALL NOT hand `skills` to `createDeepAgent`, because upstream disclosure cannot vary per state — the governance middleware renders the active state's skills instead. The plain assembly SHALL pass every declared source to Deep Agents' skills middleware.

#### Scenario: Governed assembly renders its own skills section

- **WHEN** a workflow-governed agent is assembled
- **THEN** no upstream skills middleware is installed and the model sees the active state's skills from the per-state block

### Requirement: Model configuration

When neither `model` nor `modelFactory` is given, assembly SHALL use `createChatModel()`: a `ChatOpenAI` pointed at any OpenAI-compatible endpoint, configured from `ARCHMAX_API_BASE_URL`, `ARCHMAX_API_KEY`, `ARCHMAX_MODEL`, and optional `ARCHMAX_TEMPERATURE`, `ARCHMAX_MAX_TOKENS`, `ARCHMAX_STREAMING` (default on, with `streamUsage`). `.env` SHALL be loaded from the workspace root (`workspace.rootDir`, else the consumer's working directory), never from the package's install directory, and a variable already in the process environment SHALL win. `ARCHMAX_MODEL` SHALL be the default a spec may override, not the last word: `settings.model` and a state's `model` name the id a turn runs on, over the same endpoint and credentials.

`modelFactory(role, env, requested?)` SHALL supply the model per role — `agent`, `judge` (the case grader), `rubric` — with `env` a thunk so a factory bringing its own credentials never loads `ARCHMAX_*`; an explicit `model` SHALL take precedence for the agent role. `requested` SHALL carry the model id the spec asks for — a rubric's `model` key, and for the `agent` role the state's `model` else the spec's `settings.model` — so one seam resolves every model the runtime uses; a factory that ignores the argument SHALL behave as though it were absent. `createChatModel` SHALL apply a `requested` id over `ARCHMAX_MODEL`, keeping the configured endpoint and credentials, and SHALL build one model per distinct id per assembly.

`createChatModel` SHALL read a response naming no role, or a role the chat-completions protocol does not define for another turn, as the assistant's, on both the streaming-delta and the whole-message conversion seams.

#### Scenario: Factory supplies every model

- **WHEN** `modelFactory` is supplied and no `ARCHMAX_*` variable is set
- **THEN** assembly succeeds, and the agent, case-grader and rubric models all come from the factory

#### Scenario: A rubric's model id reaches the factory

- **WHEN** a dispatched rubric declares `model: some-model-id`
- **THEN** the factory is called for the `rubric` role with that id as `requested`

#### Scenario: A state's model id reaches the factory

- **WHEN** the state in force declares `model: some-model-id`
- **THEN** the factory is called for the `agent` role with that id as `requested`

#### Scenario: The default path applies the requested id

- **WHEN** a rubric declares a `model` and no `modelFactory` is supplied
- **THEN** the grader runs on that id against the configured endpoint and credentials, and no other role's model changes

#### Scenario: A factory may ignore the request

- **WHEN** a factory taking only `(role, env)` is supplied and a rubric declares a `model`
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
reply-only handoff turn, and to nothing else. Lifecycle hooks, rubric graders and the case
grader SHALL keep their own model resolution. A sub-workflow SHALL resolve the ids its **own**
spec declares, inheriting neither the caller's `settings.model` nor the caller's state model.

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

### Requirement: An explicit model instance outranks a declared id, and says so

An explicit `model` handed to `createAgent` SHALL keep precedence for the agent role over every
id a spec declares: a host that constructed a model instance means it, and the SDK SHALL NOT
rebuild it under another id. When a spec declares `settings.model` or any state `model` while an
explicit `model` is in force, assembly SHALL emit exactly **one** `warning` event naming the
ignored ids and the states that declare them, and SHALL NOT fail — so a host learns that
supplying `modelFactory` instead is what honours the declaration.

#### Scenario: The declared ids are reported once

- **WHEN** `createAgent({ model, workflow })` is called for a spec declaring `settings.model` and
  two state models
- **THEN** assembly succeeds, every turn runs on the supplied instance, and one `warning` event
  names the ignored ids and the declaring states

#### Scenario: A factory honours what an instance overrides

- **WHEN** the same spec is assembled with `modelFactory` and no explicit `model`
- **THEN** no warning is emitted and each state's turns run on the id it declares

### Requirement: Extension options

`essentialTools` SHALL name host tools treated as always-on (disclosed and permitted in every state, still narrowed by a per-state entry and bound by safety and policy rules), and SHALL apply to every child machine the assembly composes. `policyRules` SHALL insert custom kernel rules after the safety and `policy` rules and before per-state grants. `hookExecutors` SHALL register custom hook kinds beside `script` and `rubric`. `sandboxRuntime` SHALL replace the default QuickJS runtime for the sandbox tools and hook scripts. Omitting every extension option SHALL yield the default behaviour.

#### Scenario: A built-in hook kind cannot be overridden

- **WHEN** `hookExecutors` carries a `script` or `rubric` key
- **THEN** assembly throws naming the shadowed kind

### Requirement: Diagnostics flow through the event stream

Every assembly-time and runtime diagnostic — `interpreter-enabled`, `skills-loaded`, `prompt-shaping`, `graph-topology`, spec-load and platform-prompt `warning`s, usage — SHALL be emitted as a `WorkflowLifecycleEvent`. When `onEvent` is supplied it SHALL receive every event and the runtime SHALL write nothing to the console; when omitted, a default console subscriber renders them.

There SHALL be no grader-loading diagnostic: rubrics arrive with the spec, so their availability is not a loading step with its own outcome to report.

#### Scenario: Handler replaces the console

- **WHEN** `createAgent` is called with `onEvent`
- **THEN** assembly diagnostics reach the handler and no console line is written

#### Scenario: No graders-loaded event

- **WHEN** an agent is assembled for a workflow declaring rubrics
- **THEN** no event reports a grader registry being loaded

### Requirement: Prompt cache and pricing options

`promptCache` (enable flag and lifetime) SHALL resolve against the spec's `settings.prompt_cache` and `ARCHMAX_PROMPT_CACHE` / `ARCHMAX_PROMPT_CACHE_TTL`, defaulting to enabled with the short lifetime; a model that supports no cache strategy SHALL produce no `warning`, its strategy being reported only by the `prompt-shaping` event. The strategy SHALL be resolved per model the assembly can run on — the default agent model and every id the spec declares — and the per-call `anthropic-compat` breakpoint SHALL be placed according to the strategy of the model in force for that call. The **model id** in force for a state SHALL be resolved alongside its strategy, once per composition and from the model the assembly will actually run, so it is available however that model was chosen — an id the spec declares, the environment's configured id, an explicit `model` instance, or one a `modelFactory` returned — and a model exposing no id SHALL resolve to none rather than failing assembly. LangChain's provider-native caching middleware SHALL be wired from the workflow-level model; when a state's model resolves to a different native strategy, assembly SHALL emit a `warning` naming the state rather than silently applying the wrong one. `pricing` (USD per 1M tokens keyed by model id, `default` for any) SHALL fall back to `ARCHMAX_PRICE_INPUT` / `ARCHMAX_PRICE_OUTPUT` / `ARCHMAX_PRICE_CACHE_READ` / `ARCHMAX_PRICE_CACHE_WRITE`; a table keyed by real model ids SHALL price calls whether or not the endpoint echoes an id back, and without pricing, cost SHALL be omitted, never reported as zero. Neither option SHALL change which tools are permitted or which states exist.

#### Scenario: Pricing configured

- **WHEN** `pricing` is supplied for the configured model
- **THEN** `costUsd` appears on usage events, in `metadata.json` and on the session summary

#### Scenario: A table keyed by the configured id needs no echo

- **WHEN** `pricing` carries an entry keyed by the id the environment configures, no `default` entry, and the endpoint returns usage without naming a model
- **THEN** `costUsd` is computed from that entry rather than omitted

#### Scenario: The breakpoint follows the model in force

- **WHEN** a state declares a model whose cache strategy is `anthropic-compat` while the
  workflow's default model's is `off`
- **THEN** that state's calls carry the explicit `cache_control` breakpoint and the other states'
  calls carry none

#### Scenario: A mixed native strategy is reported

- **WHEN** a state's model resolves to a native caching strategy the workflow-level model does not
  use
- **THEN** assembly emits a `warning` naming the state, and the native middleware stays wired from
  the workflow-level model

#### Scenario: Per-model pricing

- **WHEN** a workflow runs two states on two ids and `pricing` carries an entry for each
- **THEN** each call's `costUsd` is computed from the entry for the model that answered

#### Scenario: Per-state pricing without an echoed id

- **WHEN** a workflow runs two states on two declared ids, `pricing` carries an entry for each, and neither response names a model
- **THEN** each state's calls are priced from the entry for the id that state was assembled to run

#### Scenario: A model with no cache strategy raises no warning

- **WHEN** a workflow declares a state whose model supports no cache strategy, beside a state whose model's native strategy differs from the workflow-level model's
- **THEN** the only prompt-cache `warning` assembly emits names the state with the mismatched native strategy
- **AND** no `warning` names the model with no cache strategy

### Requirement: Trigger, variables and session path defaults

`trigger` SHALL be the trigger applied when a turn names none (default `manual`), validated against the machine at assembly (`UnknownTriggerError`). `variables` SHALL seed every session of the assembly, each seed locked; an illegal name SHALL throw `InvalidVariableNameError`. `sessionPath` SHALL be the default dotted path over the variables where a firing's session id lives, overridden per turn. Assembly SHALL emit a `warning` for every `${{name}}` reference in the spec's allow globs that no seed, no state's `requires` and no built-in variable guarantees, and SHALL NOT throw for it.

#### Scenario: Unbacked guard reference warns

- **WHEN** a `tools.allow` glob references `${{case_id}}` and nothing guarantees it
- **THEN** a warning names the reference, its state and entry, and assembly still returns an agent

### Requirement: Delegation targets are resolved at assembly; children are composed lazily

Assembly SHALL read the `manual` signature of every workflow an `archmax_workflow_<slug>` allow entry names, once per target, and bind one delegation tool per target. A missing target, an invalid spec or a target with no `manual` entry SHALL fail assembly with `WorkflowLoadError`; a target declaring `disabled: true` SHALL still bind (the dispatcher refuses it). Child compositions SHALL be built from the same `AssemblyContext` as the root — model, backends, mounts, session store, checkpointer, host tools, `essentialTools`, skills, `hookExecutors`, `policyRules`, pricing, event emitter — building its rubric registry from its own spec rather than inheriting the caller's, and inheriting every ancestor's `policy` denials (the caller hands down what it inherited plus its own), composed lazily and memoized per slug and delegation chain, so a broken child surfaces at dispatch, never at assembly.

#### Scenario: Missing target fails assembly

- **WHEN** a state allows `archmax_workflow_absent` and no such workflow exists
- **THEN** assembly throws `WorkflowLoadError` naming the slug

#### Scenario: Uncalled targets are not composed

- **WHEN** an allowed delegation tool is never called
- **THEN** its spec is read for the signature but no child agent is composed

### Requirement: A disabled workflow assembles

Assembly SHALL succeed for a workflow declaring `disabled: true`, because the same agent serves the operations that finish work already started — deciding, replying, delivering — and `agent.workflow.machine.disabled` SHALL report the flag so a host can ask before invoking.

#### Scenario: Assembly succeeds

- **WHEN** a host assembles a workflow whose spec declares `disabled: true`
- **THEN** an agent is returned and nothing is thrown

### Requirement: Runtime contract resolution

Assembly, `validate` and the case engine SHALL resolve a workflow's runtime contract from the spec's `runtime: { engine, version }` block, its sole source: engine and version verbatim, `source: "declared" | "defaulted"`, and the derived `sandbox` and `testFormat` surfaces. Omitted metadata SHALL resolve to `archmax-harness@1` with `source: "defaulted"`. No engine id SHALL be normalized to another.

#### Scenario: Omitted runtime block

- **WHEN** `workflow.yaml` declares no `runtime`
- **THEN** the contract resolves to engine `archmax`, version `"1"`, `source: "defaulted"`, and the workflow remains valid

### Requirement: Runtime contract support checking

The runtime SHALL keep one table of supported contracts — `archmax-harness@1` and `archmax-harness@2` — and a governed assembly SHALL throw `UnsupportedRuntimeContractError` (carrying `requested` and `supported`) before any model call when the declared contract is not in it. `validateWorkflow` SHALL report the same case as an error diagnostic naming the requested and supported contracts. A plain agent SHALL require no runtime metadata. Version `2` identifies the current authoring contract (two-file layout, verdict-returning hook functions, typed `@archmax-ai/harness/sandbox` imports); load behaviour SHALL be layout-driven, not version-driven.

#### Scenario: Unsupported contract

- **WHEN** a workflow declares `runtime: { engine: archmax-harness, version: "9" }`
- **THEN** assembly fails with `UnsupportedRuntimeContractError` naming `archmax-harness@9` and the supported set, and the model is never invoked

#### Scenario: Another engine id

- **WHEN** a workflow declares `runtime.engine: other`
- **THEN** it is rejected as unsupported as declared, with no normalization

### Requirement: One contract governs runtime, sandbox and case format

The resolved contract SHALL be the only version negotiation: it selects the sandbox script contract (`sandbox` 1 or 2; the prelude is assembled per context, `lifecycle-hook` or `ptc`, against that version) and the case format (`testFormat`); a case file SHALL carry no version of its own. The contract SHALL be observable as `agent.runtimeContract`, and `emitRunArtifacts` SHALL record it with `packageVersion` (`PACKAGE_VERSION`) in `metadata.json`. `createCaseTarget` SHALL assemble through `createAgent`, so cases run under the same checks.

#### Scenario: Metadata records the contract

- **WHEN** a session emits artifacts
- **THEN** `metadata.json` carries the resolved runtime contract and the package version

### Requirement: One typed framework seam

All typing of Deep Agents' middleware request and handler shapes (`ModelRequest`, `ToolCallRequest`, `ToolCallHandler`, `BuiltInState`, `Runtime`) and of the compiled graph (`DeepAgent`'s invoke/stream/result types, `CompiledAgentGraph`, `IntrospectableStateGraph`) SHALL be expressed in `src/core/deepagents.ts`, and every other runtime module SHALL consume those seams through its aliases and helpers (`asStructuredTools`, `asModelCallResult`, `asCompiledAgentGraph`, `asDecisionGraph`) rather than importing those framework types directly. `asModelCallResult` SHALL pass an `AIMessage`, a `Command` or a structured-output result through, rebuild an assistant message that arrived without class identity into a real `AIMessage`, and refuse anything else naming the model as the origin. The `ArchmaxAgent` surface SHALL be typed through the seam's aliases. `@typescript-eslint/no-explicit-any` SHALL be enforced across `src/`, with the seam the sanctioned home for framework-boundary casts.

#### Scenario: Framework reshape surfaces at compile time

- **WHEN** a Deep Agents upgrade changes a model-call request, tool-call request or compiled-graph shape
- **THEN** `npm run typecheck` fails in `src/core/deepagents.ts` or its call sites rather than at runtime

#### Scenario: Seam types are imported nowhere else

- **WHEN** `src/**/*.ts` (tests excluded) is searched for imports of `ModelRequest`, `ToolCallRequest`, `BuiltInState` or `DeepAgent` from `langchain` or `deepagents`
- **THEN** only `src/core/deepagents.ts` matches

### Requirement: An enumerated public surface, tested against its documentation

The root barrel (`src/index.ts`) SHALL export a small, enumerated API — `createAgent`, `ArchmaxAgent`, the option and outcome types, the error classes, workspace composition (`defaultMounts`, `mountSubtree`, the three session-store factories, `isReservedRootName`, `sessionIdRejection`, `isChildSessionOf`, `createWorkspaceContext`, `PLATFORM_PROMPT_PATH`), the park readers (`readParkedSession`, `pendingParkOf`, `parkedStateOf`), prompt and message plumbing (`lastAgentText` included), `loadMachineSpec`, `WorkflowMachine`, `validateWorkflow`, `normalizeHooks`, the delegation bounds, the trigger and tool-name constants (`sessionIdForTrigger` included), the event types, usage helpers, `createChatModel`, `BUNDLED_AUTHORING_SKILL_DIR`, `PACKAGE_VERSION` and the runtime-contract types — every export carrying a docstring. A unit test SHALL pin an upper bound on the barrel's runtime export count, keep the heavy subpaths disjoint from the root, check that `package.json` declares every subpath's built module, and compare the barrel (type exports included) with the export list in `docs/src/content/docs/reference/public-api.md` in both directions.

The barrel SHALL export no grader loader, inspector, merge helper, registry projection or definition type: a rubric is spec content, so nothing outside the runtime assembles a grader registry.

#### Scenario: Documented list matches the barrel

- **WHEN** the reference page's export list is compared with the barrel's runtime and type exports
- **THEN** no barrel export is undocumented and no documented name is missing

#### Scenario: Internals are not importable from the root

- **WHEN** a consumer imports a checkpointer class, a prompt renderer or an allow-matcher from `@archmax-ai/harness`
- **THEN** the import fails at type-check and at runtime

#### Scenario: The grader loader surface is gone

- **WHEN** a consumer imports a subagent inspector, parser, registry loader, merge helper or definition type from `@archmax-ai/harness`
- **THEN** the import fails at type-check and at runtime

### Requirement: Subpath entry points for the specialist surfaces

Surfaces that need deep access SHALL be published as subpaths declared in the `exports` map with their own `types` and `import` conditions: `@archmax-ai/harness/sandbox` (hook authoring: `ok`, `veto`, `correct`, `defineHook`, `HookInput`, `HookVerdict`, `HookMessage`, `TrailStep`), `@archmax-ai/harness/testing` (the case engine: `runTests`, `discoverCases`, `runCase`, `reduceVerdict`, `exitCodeForVerdict`, `assertWorkflowGovernedTarget`, `createCaseTarget`, `parseCaseDocument`, `serializeCaseDocument`, the title and description length constants, `CaseSchemaError`, `createToolMockMiddleware`, `partialMatch`), and `@archmax-ai/harness/cli` (`renderEventLine`, `createStyle`, `icons`, `createStateFlowRenderer`, `createTestView`, `caseVerdictLine`). A symbol SHALL live on at most one of the root and these **heavy** subpaths.

Two **light** subpaths SHALL publish vocabulary with no runtime behind it: `@archmax-ai/harness/spec` — the `workflow.yaml` schema (every exported schema, `parseMachineSpec`, `refineSpec`, `stateTriggersSchema`), the pure validator (`validateSpec`, `lintSpec`, `schemaIssueDiagnostic`), mount grants and hook shape (`normalizeMountGrants`, `mountNameOf`, `mountNameOfPattern`, `normalizeHooks`, `hookKind`, `hookValue`), the slug, trigger and variable grammars (`SLUG_PATTERN`, `isSlug`, `parseSessionPath`, `resolveSessionId`, `sessionIdForTrigger`, `triggerBindings`, `stateTriggerIds`, `declaredVariableNames`, `VARIABLE_NAME_PATTERN`, the reserved variables, `parseReferences`, `resolveText`, …), the trigger signature (`SIGNATURE_TYPES`, `normalizeSignature`, `signatureForTrigger`, `signatureJsonSchema`, `signatureValueIssues`, and the `SignatureEntry`, `SignatureType`, `TriggerSignature` and `SignatureValueIssue` types), the tool names and delegation bounds, the root namespace (`SESSION_*`, `sessionAreaNames`, `classifyWorkspacePath`, `isReservedRootName`, `AUTHORING_PREFIXES`, `authoringPlanePrefix`), the session-id rule and child-id convention (`sessionIdRejection`, `SessionStoreIdError`, `isChildSessionOf`, `parentSessionIdOf`, `childSessionId`, `subRunIdentity`), the paths (`workflowPaths`, `sessionPaths`, `resolveHookScript`, `HOOKS_DIR`) and `parseCodeDescription`, with their types — and `@archmax-ai/harness/messages` — the transcript readers (`contentToString`, `messageTypeOf`, `isAiMessage`, `isHumanMessage`, `isRuntimeNote`, `runtimeNoteKind`, `lastAgentText`, `opensTurn`, `messagesSince`, `lastTurn`, `RuntimeNoteKind`). A light subpath's transitive runtime import graph SHALL reach no `node:*` module and no bare specifier other than `zod` and `picomatch` (`spec`) or none at all (`messages`); a unit test SHALL walk the graph from each barrel and fail on any other specifier, skipping type-only imports. An allowed bare specifier SHALL itself be browser-safe: the same test SHALL walk that library's own transitive files, across nested packages, and fail on a `node:*` or bare builtin import and on a read of `process`, `Buffer`, `__dirname` or `__filename` that no `typeof` guard covers. A name on both the root and a light subpath SHALL be the same binding, and each light subpath SHALL be documented in its own section of the public API page, checked in both directions.

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

### Requirement: Package distribution

The package SHALL be published as `@archmax-ai/harness`, ESM only (`"type": "module"`), for Node >= 22, with an `exports` map declaring `.`, `./sandbox`, `./testing`, `./cli`, `./spec`, `./messages` and `./package.json`, and a single `archmax` binary at `dist/cli.js`. The published files SHALL be `dist/`, the authoring skill source `skills/archmax-harness/`, the README and the license. The build SHALL stage every runtime asset into `dist/`: the compiled output, the sandbox prelude parts (`dist/sandbox/assets/parts`) and the authoring skill (`dist/authoring-skill/archmax-harness`). `BUNDLED_AUTHORING_SKILL_DIR` SHALL resolve to the directory holding `archmax-harness/` (`dist/authoring-skill` when built, the repository's `skills/` when run from `src/`). The platform prompt SHALL be part of the compiled output: its source `src/core/platform-prompt.md` SHALL be generated into a TypeScript module by the build, and a unit test SHALL fail when the committed module differs from the Markdown. `PACKAGE_VERSION` SHALL be read from the installed `package.json`. `prepack` SHALL refuse to pack when `dist/` contains an `.env` file other than `.env.example`. The example workspace (`examples/customer-support/`) SHALL NOT be shipped or resolvable from an install; it is repository reference content reached by cloning.

#### Scenario: Runtime assets resolve from the install

- **WHEN** the package is installed into another project and an agent is assembled
- **THEN** the sandbox prelude and the authoring skill resolve from files inside the installed package, and the platform prompt needs no file at all

#### Scenario: Install root resolves for tooling

- **WHEN** a tool calls `require.resolve("@archmax-ai/harness/package.json")`
- **THEN** it resolves without `ERR_PACKAGE_PATH_NOT_EXPORTED`

#### Scenario: Example absent from an install

- **WHEN** a consumer looks for `examples/` inside the installed package
- **THEN** it is not present, and no `BUNDLED_EXAMPLE_DIR` export exists
