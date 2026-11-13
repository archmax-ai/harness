## MODIFIED Requirements

### Requirement: Documentation information architecture

The Starlight configuration (`docs/astro.config.mjs`) SHALL define a sidebar with Getting
Started, Guides, Reference, and Contributing sections, and SHALL set the site title, description,
a GitHub social link, and an edit link pointing at the `docs/` source on the default branch. The
Reference section SHALL carry the configuration, CLI, machine-spec, glossary, public-API and
changelog pages; the Guides section SHALL cover the workflow machine, the authoring plane,
triggers, skills, grader and code states (`guides/automated-states.md`), sub-workflows, sessions,
the code interpreter, the CLI, testing, token efficiency, and telemetry
(`guides/telemetry.md`: the OpenTelemetry spans and metrics the runtime reports, and what a host
does to see them).

No page SHALL present a removed concept as current behaviour: a `subagents/` directory, a
`SUBAGENT.md` file, a `before` or `after` hook of any kind (`script`, `rubric`, `subagent` or a
custom kind), a hook verdict (`ok`, `correct`, `veto`), an agent-callable `task` tool, a
`max_iterations` or `max_corrections` key, an `extensions` block, the `hookExecutors` option, the
`rubric` model role, a runtime contract `1` or `2`, or an `editor:` spec block.

#### Scenario: Sidebar exposes the core sections

- **WHEN** a reader opens the site
- **THEN** the sidebar presents Getting Started, Guides, Reference, and Contributing
- **AND** every entry resolves to an existing content page

#### Scenario: The grading guide replaces the subagent guide

- **WHEN** a reader looks for how a session's work is graded or checked before the session moves on
- **THEN** the Guides section offers the grader and code states page (`guides/automated-states.md`),
  and no page documents grading rubrics, hooks or subagents

#### Scenario: A host looks for tracing

- **WHEN** a reader wants to see the harness's work in their tracing backend
- **THEN** the Guides section offers the telemetry page, which shows the span tree, every span's
  attributes, the metrics, what a span never carries, and registering an SDK in the host

### Requirement: The skill teaches the wiring API as it is

`references/backend-integration.md` SHALL teach `createAgent` with Deep Agents' own option names
plus `workflow`, `workspace` (`rootDir`, `mounts`, `sessionStore`) and
`authoring` (the backend serving `workflows/**`, that is specs, `WORKFLOW.md`, code-state scripts
and cases, to the runtime only); `modelFactory` and its roles (`agent`, `judge`, `grader`), a
grader state's model being resolved under `grader`; that `workflow: false` declares a plain Deep
Agent, while an omitted `workflow` looks for the default workflow and is governed by it when found;
the `agent.workflow.*` surface
(`send`, `decide`, `reply`, `deliver`, `resolveSession`, `resolveTrigger`) and the session-level
members on the agent (`sessions`, `emitRunArtifacts`, `getSpecSnapshot`, `dispose`); the
`onEvent` stream, including the `code-*` and `grader-*` events that bracket an automated state's
run; the session artifacts (`graph.json`, `trail.json`, `variables.json`,
`metadata.json`); and token accounting via `model-usage` events (a grader's calls included),
`createUsageTracker` and the `pricing` option; and tracing: that the runtime reports
OpenTelemetry spans and metrics through `@opentelemetry/api` once the host registers an SDK, with
nothing to pass to `createAgent`, the turn, state, model-call and tool-call spans, and that spans
carry metadata only. Every code path or export it names SHALL exist in
the current source, so it names no `hookExecutors` option and no `rubric` model role.

#### Scenario: Wiring example is Deep Agents-shaped

- **WHEN** an agent reads the assembly example
- **THEN** it calls `createAgent({ workflow, workspace, onEvent, … })` and reaches session
  handles at `agent.sessions`

#### Scenario: Human-in-the-loop resumption

- **WHEN** a session parks at a human state
- **THEN** the reference shows reading the pending decision from the `Outcome`, listing its
  transitions, and resuming with `agent.workflow.decide(sessionId, { target, comment })`

#### Scenario: Graders on their own model

- **WHEN** an agent reads how to run grader states on a different model from the session's agent
- **THEN** the reference shows a `modelFactory` that answers the `grader` role, and names no
  `rubric` role and no `hookExecutors` option

#### Scenario: Tracing needs only the host's SDK

- **WHEN** an agent reads how to see a session's turns in a tracing backend
- **THEN** the reference shows registering an OpenTelemetry SDK in the host before `createAgent`,
  passes no tracing option, and names the `invoke_agent`, `state`, `chat` and `execute_tool` spans
