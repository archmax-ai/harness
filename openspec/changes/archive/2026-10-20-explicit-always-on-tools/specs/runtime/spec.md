## MODIFIED Requirements

### Requirement: The system prompt is layered

The model SHALL read the system prompt in this order: `AGENTS.md`; the consumer `systemPrompt`; the
platform prompt (compiled into the runtime, or `.platform/system/GRAPH_STATE.md` when the workspace
serves it; absent for a plain agent); the workspace zones section; the workflow graph
section; `WORKFLOW.md` with HTML comments stripped; the middleware's tool guidance (the
`write_todos` section, present only when some state of the workflow is granted `write_todos`, a
`forbid` subtracting as everywhere; Deep Agents 1.13 appends none for its file tools); and the volatile "Current
state" block. Deep Agents' base prompt SHALL be dropped (`systemPrompt: { prefix, base: null }`).
Layers one to six SHALL form the static prefix, identical on every model call of a session. Deep
Agents offers no per-agent opt-out from a harness profile, so a model it keeps a profile for SHALL
also read that profile's suffix after layer six: Deep Agents looks the profile up from the client's
provider and its `model_name` or `modelName`, so a LangChain `ConfigurableModel` is matched and a
`ChatOpenAI` instance, which sets only `model`, is not.
The workspace zones section SHALL be rendered from the resolved `MountPrefixes`: `scratchpad/` as
the working area, readable and writable in every state with the file tools that state is granted, the offload areas as readable only, then **one line per ungoverned
mount — its name as the agent addresses it (a directory with a trailing slash, a file by its exact
path) followed by `read-only` or `read/write`** — read-only names before writable ones and
alphabetically within each, any other root path governed by the state's tool rules, and dot-prefixed
mounts omitted. The posture SHALL be stated as permission, not caution: a `read/write` mount is
described as being as open to the agent as `scratchpad/`, and the read/write wording SHALL be absent
when no ungoverned mount is writable. Governed mounts SHALL NOT be named in this
section — their visibility varies by state, and the static prefix does not — but when the table
declares any, the section SHALL say that the mounts available in the current state are listed in
the "Current state" block.

#### Scenario: Prose appended after the graph section

- **WHEN** a workflow has both `workflow.yaml` and `WORKFLOW.md`
- **THEN** the prompt carries the rendered graph section followed by the prose, and a workflow with
  no `WORKFLOW.md` assembles with the graph section alone

#### Scenario: A Codex model reads Deep Agents' suffix

- **WHEN** a governed agent runs on `initChatModel("gpt-5.2-codex", { modelProvider: "openai" })`
- **THEN** its static prompt carries Deep Agents' "Codex-Specific Behavior" suffix after the
  composed layers, while the same id on a `ChatOpenAI` instance carries none

#### Scenario: Governed mounts keep the prefix stable

- **WHEN** the table governs `reference` and two states enable different mount sets
- **THEN** the static prefix is byte-identical for model calls in both states and names `reference`
  in neither

#### Scenario: No write_todos guidance without the tool

- **WHEN** a workflow declares `tools.allow_always: [read_file, ls]` and no state's `tools.allow` names `write_todos`
- **THEN** the system prompt carries no `write_todos` section and `write_todos` is offered on no model call, while a workflow without `tools.allow_always` carries the section as before
