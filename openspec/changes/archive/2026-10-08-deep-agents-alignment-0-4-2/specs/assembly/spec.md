## MODIFIED Requirements

### Requirement: `createAgent` mirrors `createDeepAgent`

`createAgent(params)` SHALL accept Deep Agents' own parameters under Deep Agents' names and meanings — `model`, `tools`, `systemPrompt`, `middleware`, `backend`, `skills`, `checkpointer`, `store`, `interruptOn`, `name`, `description` — so a `createDeepAgent` call ports by changing only the import, with one recorded exception. the harness's concerns SHALL be additive options that rename or reshape no shared concept: `workflow`, `workspace` (`rootDir`, `mounts`, `sessionStore`), `authoring`, `trigger`, `variables`, `sessionPath`, `modelFactory`, `essentialTools`, `policyRules`, `hookExecutors`, `sandboxRuntime`, `onEvent`, `promptCache`, `pricing`. `store`, `interruptOn` and `name` SHALL reach `createDeepAgent` untouched on both the governed and the plain composition, and `middleware` SHALL be honoured on both — appended after the runtime's own middleware — so `toolMocks` reports the host's tool-mock middleware on a plain agent too.

`subagents` SHALL NOT be a parameter. It is the one deliberate deviation from parity: an agent-facing subagent is not a concept the archmax harness offers, because each need it served has a governed construct — grading is a **rubric** declared on the hook that applies it, and delegating work to another reasoning context is a **sub-workflow**. `createDeepAgent` builds its general-purpose subagent on every composition and takes no parameter
that leaves it out: a governed agent SHALL NOT be offered `task` in any state (see `governance`),
and a plain agent SHALL be offered `task` with the general-purpose subagent, as a plain Deep Agent
is.

#### Scenario: A Deep Agents call ports unchanged

- **WHEN** a consumer calls `createAgent({ model, tools, systemPrompt, backend })` with arguments previously passed to `createDeepAgent`
- **THEN** an agent is assembled with the same meaning for every one of those options

#### Scenario: The one deviation is a type error

- **WHEN** a consumer passes `subagents`
- **THEN** it is a type error, and the documented parity list records the parameter as removed with rubrics and sub-workflows as its replacements

#### Scenario: A plain agent is offered task

- **WHEN** an agent assembled with `workflow: false` makes a model call
- **THEN** the call offers `task`, whose description names the general-purpose subagent

#### Scenario: Governance is one added option

- **WHEN** the same call adds `workflow: "order-lookup"`
- **THEN** the assembled agent is governed by that machine and no other option changes meaning

### Requirement: System prompt composition

Assembly SHALL compose the system prompt from, in order: `AGENTS.md`; the consumer's `systemPrompt`; the platform prompt, for a governed agent only (`.platform/system/GRAPH_STATE.md` when the workspace serves it, else the prompt compiled into the runtime, whatever the backend); the workspace-zones section rendered from the resolved mounts; the workflow header rendered from the spec — its `title` and root `instructions`, and no state of the graph; and the `WORKFLOW.md` prose with HTML comments stripped. It SHALL hand that text to `createDeepAgent` as `systemPrompt: { prefix, base: null }`, so Deep Agents' own base prompt is dropped and the persona leads. The middleware's tool guidance (the `write_todos` section) and the volatile "Current state" block — which carries the current date and time (rounded to a ten-minute bucket so a turn's calls share one line), the active state's `instructions`, its outgoing transitions, its markers and hooks, the run's trigger signature, its skills, the governed mounts it reaches with their read-only/read-write posture, its variable names and its argument constraints — follow per model call; the composed layers SHALL be the cacheable prefix. Because the prefix is a function of the workflow's header alone, it SHALL NOT grow with the number of states. A plain agent (no machine) SHALL get no platform prompt. `resolveSystemPrompt` SHALL take the override path as a required `platformBackendPath`, `null` leaving the platform layer out.

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
