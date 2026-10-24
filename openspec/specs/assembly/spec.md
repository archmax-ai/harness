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

`createAgent(params)` SHALL accept Deep Agents' own parameters under Deep Agents' names and meanings — `model`, `tools`, `systemPrompt`, `middleware`, `backend`, `skills`, `checkpointer`, `store`, `interruptOn`, `name`, `description` — so a `createDeepAgent` call ports by changing only the import, with one recorded exception. the harness's concerns SHALL be additive options that rename or reshape no shared concept: `workflow`, `workspace` (`rootDir`, `mounts`, `sessionStore`), `authoring`, `trigger`, `variables`, `sessionPath`, `modelFactory`, `essentialTools`, `policyRules`, `sandboxRuntime`, `onEvent`, `promptCache`, `pricing`, `clock`. `store`, `interruptOn` and `name` SHALL reach `createDeepAgent` untouched on both the governed and the plain composition, and `middleware` SHALL be honoured on both — appended after the runtime's own middleware — so `toolMocks` reports the host's tool-mock middleware on a plain agent too.

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

`agent.workflow.send(sessionId, input, config?)` SHALL accept a turn (`{ message, trigger?, variables?, sessionPath? }`) or a resume payload (`{ decision }` or `{ delivery }`) and settle to one `Outcome` whose `disposition` is `turn`, `decide`, `reply` or `deliver`. A turn SHALL be resolved through `resolveSession` first: a new or finished session takes it as its next turn; a session parked at a human state has it answered as a reply (`reply`); a session parked with `archmax_wait` has its trigger, variables **and message** delivered (`deliver`) — the message travels with the firing rather than being dropped. A session that ends rejected SHALL settle an `Outcome` of kind `rejected` carrying `rejected`, the reason the runtime committed, and every resume outcome (`DecideOutcome`) SHALL carry it the same way. A session that ends with `archmax_raise` SHALL settle an `Outcome` of kind `failed`. Every finished `Outcome` and `DecideOutcome` that the agent ended SHALL carry `exit` (`SessionExit`): `{ success: true }` for kind `completed`, and `{ success: false, code, reason }` for kind `failed`. A parked or rejected outcome SHALL carry no `exit`. When a parked session's pending decision belongs to a delegated child, the `Outcome` SHALL carry `delegation` (`DelegatedPark`: `workflow`, the child's `sessionId`, `identity`, `dispatchId`, `toolCallId`, calling `state`). A fresh turn on a workflow declaring `disabled: true` SHALL throw `WorkflowDisabledError`; an empty message SHALL throw `EmptyMessageError`. `config` SHALL merge into the invoke config.

#### Scenario: A turn on a new session

- **WHEN** `send("s1", { message: "Which orders are delayed?" })` is called on a fresh session id
- **THEN** one turn runs under `thread_id: "s1"` and one `Outcome` with `disposition: "turn"` is returned

#### Scenario: A decision for a session nobody holds

- **WHEN** `send(id, { decision })` names a session that is not parked at a human state
- **THEN** `SessionNotParkedError` is thrown and the graph is not invoked

#### Scenario: A completed session carries a successful exit

- **WHEN** a turn completes without `archmax_raise`
- **THEN** the `Outcome` has kind `completed` and `exit: { success: true }`

#### Scenario: A session that raised settles failed

- **WHEN** the agent calls `archmax_raise({ code: "orders-unavailable", reason: "The orders API is down." })`
- **THEN** the `Outcome` has kind `failed`, status `failed`, the state it raised in as `state`,
  `exit: { success: false, code: "orders-unavailable", reason: "The orders API is down." }`, and
  `reply` holding what the agent said this turn

#### Scenario: A decision that leads to a raise

- **WHEN** a person's decision routes a session to a state whose agent then raises
- **THEN** the `send` with `{ decision }` settles an `Outcome` of kind `failed` with the exit record

### Requirement: An outcome's reply is what the agent said this turn

Every outcome `send` settles (`Outcome`, and the `DecideOutcome` and `ReplyOutcome` that `decide`, `reply` and `deliver` return) SHALL carry `reply`: the text of every assistant message the turn added to the session's transcript, in order, each trimmed, empty ones skipped, joined by a blank line (`\n\n`). Runtime notes SHALL never contribute text. Once a runtime note of kind `grader` or `code` (an automated state having moved the session) appears in the turn, the next assistant text SHALL replace the text collected before it, so a draft a grader or code state sent back for revision never reaches the person; when no assistant text follows that note, the text collected before it SHALL stand, so a draft an automated state passed, with nothing said after it, is the reply. No other note kind SHALL discard text. A turn that added no assistant text SHALL have `reply: ""`, whatever earlier turns said. A turn's messages are those after the transcript's length as it stood before the turn began; messages the runtime rewrites ahead of that point SHALL NOT bring earlier assistant text into `reply`.

#### Scenario: Text next to an advance reaches the person

- **WHEN** in one turn the agent writes "X" in the message that calls `archmax_advance` from `a` to `b`, and then writes "Y" in `b`
- **THEN** the outcome's `reply` is "X\n\nY"

#### Scenario: A silent turn says nothing

- **WHEN** a turn ended with the agent saying "Y", and the next turn on the same session adds no assistant text
- **THEN** the second outcome's `reply` is ""

#### Scenario: A revision replaces the draft sent back

- **WHEN** in one turn the agent answers "draft" and advances into a grader state, the grader advances back with what to change, and the agent then answers "final"
- **THEN** the outcome's `reply` is "final"

#### Scenario: A passed draft is the reply

- **WHEN** in one turn the agent answers "the answer" and advances into a code state, the code state advances onward, and the agent adds no text after the `code` note
- **THEN** the outcome's `reply` is "the answer"

#### Scenario: A park's handoff is part of the turn

- **WHEN** the agent writes "Your refund is eligible" next to an advance into a human state, and the reply-only handoff call writes "A reviewer will confirm it"
- **THEN** the parked outcome's `reply` is "Your refund is eligible\n\nA reviewer will confirm it"

#### Scenario: A decision that ends the session without the agent speaking

- **WHEN** a decision routes a parked session to a terminal state and the agent adds no text
- **THEN** the `DecideOutcome`'s `reply` is "", not the park's handoff message

#### Scenario: A reply to a parked session

- **WHEN** a person sends "Any news?" to a session parked at a human state and the reply-only call answers "Still with a reviewer"
- **THEN** the `ReplyOutcome`'s `reply` is "Still with a reviewer"

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

`authoring` SHALL name the backend the runtime reads `workflows/<slug>/` from — `workflow.yaml` (its grader states' instructions included), `WORKFLOW.md`, code-state scripts (`workflows/<slug>/scripts/`), cases. It SHALL default to `backend` when one is supplied, else to a filesystem backend over the resolved root. It SHALL appear in no mount table, no root listing and no path an agent tool or sandbox `tools.*` call can address; code-state scripts SHALL be read from it by a separate executor while `archmax_run` reads from the agent workspace, both sharing one sandbox runtime. The runtime SHALL read nothing from a workflow's `hooks/` directory.

There SHALL be no second authoring prefix. A grader's prompt is part of the spec, so it is protected by the one route that does not exist rather than by a directory reserved for it.

#### Scenario: Default authoring backend

- **WHEN** `createAgent({ workflow: "order-lookup" })` is called with no `authoring`
- **THEN** the spec, its prose, its grader states' instructions and its code-state scripts are read from the root's `workflows/` directory, which no agent tool can reach

#### Scenario: Graders need no agent-visible route

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

Assembly SHALL compose the system prompt from, in order: `AGENTS.md`; the consumer's `systemPrompt`; the platform prompt, for a governed agent only (`.platform/system/GRAPH_STATE.md` when the workspace serves it, else the prompt compiled into the runtime, whatever the backend); the workspace-zones section rendered from the resolved mounts; the workflow header rendered from the spec — its `title` and root `instructions`, and no state of the graph; and the `WORKFLOW.md` prose with HTML comments stripped. It SHALL hand that text to `createDeepAgent` as `systemPrompt: { prefix, base: null }`, so Deep Agents' own base prompt is dropped and the persona leads. The middleware's tool guidance (the `write_todos` section) and the volatile "Current state" block — which carries the current date and time (rounded to a ten-minute bucket so a turn's calls share one line) or the pinned instant when one is set (see "The clock can be pinned"), the active state's `instructions`, its outgoing transitions, its markers, the run's trigger signature, its skills, the governed mounts it reaches with their read-only/read-write posture, its variable names and its argument constraints — follow per model call; the composed layers SHALL be the cacheable prefix. Because the prefix is a function of the workflow's header alone, it SHALL NOT grow with the number of states. A plain agent (no machine) SHALL get no platform prompt. `resolveSystemPrompt` SHALL take the override path as a required `platformBackendPath`, `null` leaving the platform layer out.

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

### Requirement: The clock can be pinned

`createAgent` SHALL accept `clock`, a string. When it is non-empty, every model call the assembly makes (the root session's, a sub-workflow child's, and a park's handoff call) SHALL show that instant in the `Current date and time:` line in place of the real time, in the same format and ten-minute rounding, and without the host's local time. Absent or empty, the line SHALL show the real time. Timestamps the runtime records and the sandbox's clock SHALL stay real.

#### Scenario: The real clock by default

- **WHEN** a governed agent assembled without `clock`, or with `clock: ""`, makes a model call
- **THEN** the first line of the volatile block is `Current date and time: …` with the current time, rounded down to ten minutes

#### Scenario: A pinned instant replaces the real one

- **WHEN** an agent assembled with `clock: "2026-03-20T14:30:00Z"` makes a model call on a host whose zone is `Europe/Berlin`
- **THEN** the line reads `Current date and time: 2026-03-20 14:30 UTC (Friday), rounded down to the nearest 10 minutes — it can be that much behind.`, with no local-time clause

#### Scenario: A pinned clock does not move

- **WHEN** an agent assembled with a pinned `clock` runs two turns of one session hours apart
- **THEN** every model call of both turns carries the same line

#### Scenario: A park's handoff message reads the pinned clock

- **WHEN** an agent assembled with a pinned `clock` parks at a human state
- **THEN** the reply-only call's prompt says the run is parked and carries the pinned line

#### Scenario: A child session reads the pinned clock

- **WHEN** an agent assembled with a pinned `clock` dispatches a sub-workflow
- **THEN** every model call of the child session carries the pinned line

#### Scenario: Recorded time stays real

- **WHEN** an agent assembled with a pinned `clock` advances and then parks with `archmax_wait({ until: "1d" })`
- **THEN** the trail step and the park record carry the real time, and `resumeAt` is one day after it

### Requirement: A pinned clock is an ISO 8601 date or zoned date-time

A non-empty `clock` SHALL be an ISO 8601 calendar date (`2026-03-20`, read as midnight UTC) or a date-time with optional seconds and a `Z` or `±hh:mm` offset. A date-time without a zone, a date that does not exist, and any other text SHALL fail assembly with an error naming `clock` and the accepted forms, before any session runs.

#### Scenario: A date is midnight UTC

- **WHEN** an agent is assembled with `clock: "2026-03-20"`
- **THEN** its clock line reads `Current date and time: 2026-03-20 00:00 UTC (Friday)`, followed by the rounding note

#### Scenario: An offset is converted to UTC

- **WHEN** an agent is assembled with `clock: "2026-03-20T16:37+02:00"`
- **THEN** its clock line reads `Current date and time: 2026-03-20 14:30 UTC (Friday)`, followed by the rounding note

#### Scenario: A date-time without a zone is rejected

- **WHEN** an agent is assembled with `clock: "2026-03-20T10:00"`
- **THEN** assembly throws an error naming `clock` and the accepted forms

#### Scenario: A date that does not exist is rejected

- **WHEN** an agent is assembled with `clock: "2026-02-30"` or `clock: "next tuesday"`
- **THEN** assembly throws an error naming `clock` and the accepted forms

### Requirement: A turn's run configuration overrides the clock option

A turn whose run configuration carries a non-empty clock SHALL show that instant on every model call of the turn in place of the `clock` option. A sub-workflow child dispatched during the turn SHALL show the same instant. A turn whose run configuration carries no clock, or an empty one, SHALL follow the option.

#### Scenario: A turn pins the clock of an agent that shows the real time

- **WHEN** an agent assembled without `clock` runs a turn whose run configuration pins `2026-03-20`
- **THEN** that turn's model calls show `2026-03-20 00:00 UTC`, and the next turn without the setting shows the real time again

#### Scenario: A turn's pin outranks the option's

- **WHEN** an agent assembled with `clock: "2026-01-05"` runs a turn whose run configuration pins `2026-03-20`
- **THEN** that turn's model calls show `2026-03-20 00:00 UTC`

#### Scenario: The child follows its caller's turn

- **WHEN** a turn whose run configuration pins `2026-03-20` dispatches a sub-workflow on an agent assembled without `clock`
- **THEN** the child session's model calls show `2026-03-20 00:00 UTC`

### Requirement: Skills are discovered once through the backend

`skills` SHALL be the list of skill sources read through the agent's workspace (default `["skills/"]`; `[]` for none), discovered once per assembly into the registry that disclosure, the kernel and `validate` share; a source that serves nothing SHALL NOT be an error. A governed assembly SHALL NOT hand `skills` to `createDeepAgent`, because upstream disclosure cannot vary per state — the governance middleware renders the active state's skills instead. The plain assembly SHALL pass every declared source to Deep Agents' skills middleware.

#### Scenario: Governed assembly renders its own skills section

- **WHEN** a workflow-governed agent is assembled
- **THEN** no upstream skills middleware is installed and the model sees the active state's skills from the per-state block

### Requirement: Model configuration

When neither `model` nor `modelFactory` is given, assembly SHALL use `createChatModel()`: a `ChatOpenAI` pointed at any OpenAI-compatible endpoint, configured from `ARCHMAX_API_BASE_URL`, `ARCHMAX_API_KEY`, `ARCHMAX_MODEL`, and optional `ARCHMAX_TEMPERATURE`, `ARCHMAX_MAX_TOKENS`, `ARCHMAX_STREAMING` (default on, with `streamUsage`). `.env` SHALL be loaded from the workspace root (`workspace.rootDir`, else the consumer's working directory), never from the package's install directory, and a variable already in the process environment SHALL win. `ARCHMAX_MODEL` SHALL be the default a spec may override, not the last word: `settings.model` and a state's `model` name the id a turn runs on, over the same endpoint and credentials.

`modelFactory(role, env, requested?)` SHALL supply the model per role — `ModelRole = "agent" | "judge" | "grader"`: `agent` (the session's agent), `judge` (the case grader) and `grader` (a grader state's subagent); there SHALL be no `rubric` role — with `env` a thunk so a factory bringing its own credentials never loads `ARCHMAX_*`; an explicit `model` SHALL take precedence for the agent role. `requested` SHALL carry the model id the spec asks for — for the `grader` role the grader state's `model` else the spec's `settings.model`, and for the `agent` role the state's `model` else the spec's `settings.model` — so one seam resolves every model the runtime uses; a factory that ignores the argument SHALL behave as though it were absent. `createChatModel` SHALL apply a `requested` id over `ARCHMAX_MODEL`, keeping the configured endpoint and credentials, and SHALL build one model per distinct id per assembly.

A grader state's model SHALL be resolved once per composition, however many times the state runs (see `automated-states`): through `modelFactory("grader", env, requested)` when a factory is supplied; otherwise the env-configured model at the requested id, or the assembly's default agent model when neither the state nor the spec declares an id.

`createChatModel` SHALL read a response naming no role, or a role the chat-completions protocol does not define for another turn, as the assistant's, on both the streaming-delta and the whole-message conversion seams.

#### Scenario: Factory supplies every model

- **WHEN** `modelFactory` is supplied and no `ARCHMAX_*` variable is set
- **THEN** assembly succeeds, and the agent, case-grader and grader-state models all come from the factory

#### Scenario: A grader state's model id reaches the factory

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

#### Scenario: There are no hook executors to register

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

Assembly SHALL read the `manual` signature of every workflow an `archmax_workflow_<slug>` allow entry names, once per target, and bind one delegation tool per target. A missing target, an invalid spec or a target with no `manual` entry SHALL fail assembly with `WorkflowLoadError`; a target declaring `disabled: true` SHALL still bind (the dispatcher refuses it). Child compositions SHALL be built from the same `AssemblyContext` as the root — model, backends, mounts, session store, checkpointer, host tools, `essentialTools`, skills, `policyRules`, pricing, event emitter — taking its grader states and their model ids from its own spec rather than inheriting the caller's, and inheriting every ancestor's `policy` denials (the caller hands down what it inherited plus its own), composed lazily and memoized per slug and delegation chain, so a broken child surfaces at dispatch, never at assembly.

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

### Requirement: One typed framework seam

All typing of Deep Agents' middleware request and handler shapes (`ModelRequest`, `ToolCallRequest`, `ToolCallHandler`, `BuiltInState`, `Runtime`) and of the compiled graph (`DeepAgent`'s invoke/stream/result types, `CompiledAgentGraph`, `IntrospectableStateGraph`) SHALL be expressed in `src/core/deepagents.ts`, and every other runtime module SHALL consume those seams through its aliases and helpers (`asStructuredTools`, `asModelCallResult`, `asCompiledAgentGraph`, `asDecisionGraph`) rather than importing those framework types directly. `asModelCallResult` SHALL pass an `AIMessage`, a `Command` or a structured-output result through, rebuild an assistant message that arrived without class identity into a real `AIMessage`, and refuse anything else naming the model as the origin. The `ArchmaxAgent` surface SHALL be typed through the seam's aliases. `@typescript-eslint/no-explicit-any` SHALL be enforced across `src/`, with the seam the sanctioned home for framework-boundary casts.

#### Scenario: Framework reshape surfaces at compile time

- **WHEN** a Deep Agents upgrade changes a model-call request, tool-call request or compiled-graph shape
- **THEN** `npm run typecheck` fails in `src/core/deepagents.ts` or its call sites rather than at runtime

#### Scenario: Seam types are imported nowhere else

- **WHEN** `src/**/*.ts` (tests excluded) is searched for imports of `ModelRequest`, `ToolCallRequest`, `BuiltInState` or `DeepAgent` from `langchain` or `deepagents`
- **THEN** only `src/core/deepagents.ts` matches

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

Surfaces that need deep access SHALL be published as subpaths declared in the `exports` map with their own `types` and `import` conditions: `@archmax-ai/harness/sandbox` (code-state authoring: `defineCodeState`, `CodeStateInput`, `CodeStateArgs`, `CodeStateFn`, `HistoryMessage`, `TrailStep`, `ToolCallRecord`, `ToolCallFilter`, `SandboxTools`; it SHALL carry none of the removed hook vocabulary — `ok`, `veto`, `correct`, `defineHook` and the hook types), `@archmax-ai/harness/testing` (the case engine: `runTests`, `discoverCases`, `runCase`, `reduceVerdict`, `exitCodeForVerdict`, `assertWorkflowGovernedTarget`, `createCaseTarget`, `parseCaseDocument`, `serializeCaseDocument`, the title and description length constants, `CaseSchemaError`, `createToolMockMiddleware`, `partialMatch`), and `@archmax-ai/harness/cli` (`renderEventLine`, `createStyle`, `icons`, `createStateFlowRenderer`, `createTestView`, `caseVerdictLine`). A symbol SHALL live on at most one of the root and these **heavy** subpaths.

Two **light** subpaths SHALL publish vocabulary with no runtime behind it: `@archmax-ai/harness/spec` — the `workflow.yaml` schema (every exported schema, `parseMachineSpec`, `refineSpec`, `stateTriggersSchema`), the pure validator (`validateSpec`, `lintSpec`, `schemaIssueDiagnostic`), mount grants (`normalizeMountGrants`, `mountNameOf`, `mountNameOfPattern`), the slug, trigger and variable grammars (`SLUG_PATTERN`, `isSlug`, `parseSessionPath`, `resolveSessionId`, `sessionIdForTrigger`, `triggerBindings`, `stateTriggerIds`, `declaredVariableNames`, `VARIABLE_NAME_PATTERN`, the reserved variables, `parseReferences`, `resolveText`, …), the trigger signature (`SIGNATURE_TYPES`, `normalizeSignature`, `signatureForTrigger`, `signatureJsonSchema`, `signatureValueIssues`, and the `SignatureEntry`, `SignatureType`, `TriggerSignature` and `SignatureValueIssue` types), the tool names and delegation bounds, the root namespace (`SESSION_*`, `sessionAreaNames`, `classifyWorkspacePath`, `isReservedRootName`, `AUTHORING_PREFIXES`, `authoringPlanePrefix`), the session-id rule and child-id convention (`sessionIdRejection`, `SessionStoreIdError`, `isChildSessionOf`, `parentSessionIdOf`, `childSessionId`, `dispatchIdOf`, `rootSessionIdOf`), the paths (`workflowPaths`, `sessionPaths`, `resolveCodeScript`, `SCRIPTS_DIR`), `parseCodeDescription`, and Deep Agents' binary types (`BINARY_MIME_TYPES`, `binaryMimeTypeOf`: the extensions whose `write` carries base64 the store decodes), with their types — and `@archmax-ai/harness/messages` — the transcript readers (`contentToString`, `messageTypeOf`, `isAiMessage`, `isHumanMessage`, `isRuntimeNote`, `runtimeNoteKind`, `lastAgentText`, `opensTurn`, `messagesSince`, `lastTurn`, `RuntimeNoteKind`). The spec subpath SHALL carry none of the removed hook shape (`normalizeHooks`, `hookKind`, `hookValue`, `resolveHookScript`, `HOOKS_DIR`). A light subpath's transitive runtime import graph SHALL reach no `node:*` module and no bare specifier other than `zod` and `picomatch` (`spec`) or none at all (`messages`); a unit test SHALL walk the graph from each barrel and fail on any other specifier, skipping type-only imports. An allowed bare specifier SHALL itself be browser-safe: the same test SHALL walk that library's own transitive files, across nested packages, and fail on a `node:*` or bare builtin import and on a read of `process`, `Buffer`, `__dirname` or `__filename` that no `typeof` guard covers. A name on both the root and a light subpath SHALL be the same binding, and each light subpath SHALL be documented in its own section of the public API page, checked in both directions.

`validateSpec(value)` SHALL be total — never throwing, yielding every schema issue as an `error` diagnostic addressed by `field` beside the lint's findings, with the typed spec when the shape held — and the loader SHALL obtain its schema and lint findings from it, so `archmax validate` and an editor report the same findings for one document.

`signatureForTrigger(spec, triggerId)` SHALL read a trigger's normalized signature from a parsed spec — its `description` and its `requires`/`returns` as `{ name, type?, description? }` entries — the same reading the machine exposes, so a host that holds only a spec (an editor, an API request path) reads a signature without compiling a machine.

#### Scenario: The removed hook vocabulary is not importable

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
