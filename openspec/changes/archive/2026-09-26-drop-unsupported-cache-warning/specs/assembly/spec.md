## MODIFIED Requirements

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
