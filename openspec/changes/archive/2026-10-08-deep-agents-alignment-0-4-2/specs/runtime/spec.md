## MODIFIED Requirements

### Requirement: The system prompt is layered

The model SHALL read the system prompt in this order: `AGENTS.md`; the consumer `systemPrompt`; the
platform prompt (compiled into the runtime, or `.platform/system/GRAPH_STATE.md` when the workspace
serves it; absent for a plain agent); the workspace zones section; the workflow graph
section; `WORKFLOW.md` with HTML comments stripped; the middleware's tool guidance (the
`write_todos` section; Deep Agents 1.13 appends none for its file tools); and the volatile "Current
state" block. Deep Agents' base prompt SHALL be dropped (`systemPrompt: { prefix, base: null }`).
Layers one to six SHALL form the static prefix, identical on every model call of a session. Deep
Agents offers no per-agent opt-out from a harness profile, so a model it keeps a profile for SHALL
also read that profile's suffix after layer six: Deep Agents looks the profile up from the client's
provider and its `model_name` or `modelName`, so a LangChain `ConfigurableModel` is matched and a
`ChatOpenAI` instance, which sets only `model`, is not.
The workspace zones section SHALL be rendered from the resolved `MountPrefixes`: `scratchpad/` as
the always-writable working area, the offload areas as readable only, then **one line per ungoverned
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

### Requirement: Prompt caching

The middleware SHALL write the system message as content blocks — the static prefix, then the
volatile block — through the request's `systemMessage`. The strategy SHALL follow the model: a native
Anthropic model uses LangChain's Anthropic caching middleware; a Bedrock Converse Claude or Nova
model uses LangChain's Bedrock caching middleware; a Claude model over an OpenAI-compatible endpoint
gets `cache_control: { type: "ephemeral", ttl }` on the static block and none on the volatile block;
any other model gets no marker and no `warning`, because the providers that serve it — OpenAI,
Gemini and OpenAI-compatible proxies — cache a stable prefix automatically, which the byte-identical
static block already serves. Precedence SHALL
be the `promptCache` option, then `settings.prompt_cache`, then
`ARCHMAX_PROMPT_CACHE`/`ARCHMAX_PROMPT_CACHE_TTL`, then the default (enabled, `5m`; `1h` accepted).
The static block and the disclosed tool order SHALL be byte-identical across a session's model
calls. Assembly SHALL emit one `prompt-shaping` event naming the cache strategy and the withheld
built-in tools.

For a `ChatAnthropic` and a `ChatBedrockConverse` model, `createDeepAgent` installs LangChain's
caching middleware itself, whatever the configuration. With caching enabled, the runtime's
same-named middleware SHALL replace Deep Agents', so the configured lifetime holds; with caching
disabled, Deep Agents' remains, and the model SHALL still be cached with a five-minute lifetime. On a
`ChatAnthropic` model, Deep Agents' own breakpoint middleware SHALL mark the last system block — the
volatile block — on every call, enabled or not.

#### Scenario: Claude over an OpenAI-compatible endpoint

- **WHEN** the model id names Claude and the client is `ChatOpenAI`
- **THEN** the static system block carries `cache_control` and the volatile block does not

#### Scenario: A model with no marker mechanism is not warned about

- **WHEN** the model is `ChatOpenAI` serving `gpt-5` with prompt caching enabled
- **THEN** no system block carries `cache_control`
- **AND** assembly emits no `warning` about prompt caching
- **AND** the `prompt-shaping` event names the `unsupported` strategy

#### Scenario: Deep Agents marks a ChatAnthropic agent's volatile block

- **WHEN** a governed agent runs on `ChatAnthropic` with `promptCache: { enabled: true, ttl: "1h" }`
- **THEN** the static block is unmarked, the volatile block carries `{ type: "ephemeral" }`, and the
  `cache_control` model setting carries `ttl: "1h"`

#### Scenario: Turning caching off leaves Deep Agents' caching on

- **WHEN** a governed agent runs on `ChatAnthropic` or `ChatBedrockConverse` with
  `promptCache: { enabled: false }`
- **THEN** the `cache_control` model setting is still `{ type: "ephemeral", ttl: "5m" }`
