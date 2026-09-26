## MODIFIED Requirements

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

#### Scenario: Claude over an OpenAI-compatible endpoint

- **WHEN** the model id names Claude and the client is `ChatOpenAI`
- **THEN** the static system block carries `cache_control` and the volatile block does not

#### Scenario: A model with no marker mechanism is not warned about

- **WHEN** the model is `ChatOpenAI` serving `gpt-5` with prompt caching enabled
- **THEN** no system block carries `cache_control`
- **AND** assembly emits no `warning` about prompt caching
- **AND** the `prompt-shaping` event names the `unsupported` strategy
