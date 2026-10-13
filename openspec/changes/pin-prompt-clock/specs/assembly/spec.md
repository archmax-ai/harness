## MODIFIED Requirements

### Requirement: `createAgent` mirrors `createDeepAgent`

`createAgent(params)` SHALL accept Deep Agents' own parameters under Deep Agents' names and meanings — `model`, `tools`, `systemPrompt`, `middleware`, `backend`, `skills`, `checkpointer`, `store`, `interruptOn`, `name`, `description` — so a `createDeepAgent` call ports by changing only the import, with one recorded exception. the harness's concerns SHALL be additive options that rename or reshape no shared concept: `workflow`, `workspace` (`rootDir`, `mounts`, `sessionStore`), `authoring`, `trigger`, `variables`, `sessionPath`, `modelFactory`, `essentialTools`, `policyRules`, `hookExecutors`, `sandboxRuntime`, `onEvent`, `promptCache`, `pricing`, `clock`. `store`, `interruptOn` and `name` SHALL reach `createDeepAgent` untouched on both the governed and the plain composition, and `middleware` SHALL be honoured on both — appended after the runtime's own middleware — so `toolMocks` reports the host's tool-mock middleware on a plain agent too.

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

Assembly SHALL compose the system prompt from, in order: `AGENTS.md`; the consumer's `systemPrompt`; the platform prompt, for a governed agent only (`.platform/system/GRAPH_STATE.md` when the workspace serves it, else the prompt compiled into the runtime, whatever the backend); the workspace-zones section rendered from the resolved mounts; the workflow header rendered from the spec — its `title` and root `instructions`, and no state of the graph; and the `WORKFLOW.md` prose with HTML comments stripped. It SHALL hand that text to `createDeepAgent` as `systemPrompt: { prefix, base: null }`, so Deep Agents' own base prompt is dropped and the persona leads. The middleware's tool guidance (the `write_todos` section) and the volatile "Current state" block — which carries the current date and time (rounded to a ten-minute bucket so a turn's calls share one line) or the pinned instant when one is set (see "The clock can be pinned"), the active state's `instructions`, its outgoing transitions, its markers and hooks, the run's trigger signature, its skills, the governed mounts it reaches with their read-only/read-write posture, its variable names and its argument constraints — follow per model call; the composed layers SHALL be the cacheable prefix. Because the prefix is a function of the workflow's header alone, it SHALL NOT grow with the number of states. A plain agent (no machine) SHALL get no platform prompt. `resolveSystemPrompt` SHALL take the override path as a required `platformBackendPath`, `null` leaving the platform layer out.

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

## ADDED Requirements

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
