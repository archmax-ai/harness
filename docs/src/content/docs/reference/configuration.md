---
title: Configuration
description: Environment variables for the model endpoint, CLI behavior, and the session zone.
sidebar:
  order: 1
---

The archmax harness is configured through environment variables. `.env` is loaded from the
**workspace root**. That is the directory passed via `--root` (CLI) or
`rootDir` (library), falling back to the current working directory.

Two rules decide precedence, in this order:

1. **The real process environment always wins.** An exported variable keeps
   its value whatever a `.env` file sets.
2. **The workspace root wins over the working directory.** A `.env` beside the
   process's cwd is loaded early as a convenience. Once the workspace root is
   resolved, its `.env` replaces whatever that earlier file set. Keys only the
   cwd file declares are kept.

So running `archmax run --root ./support …` from somewhere else reads
`./support/.env`. A stray `.env` in the directory you started from cannot
shadow it.

## Model endpoint

The model targets any **OpenAI-compatible** endpoint (a `ChatOpenAI` instance
is built under the hood):

| Variable | Required | Description |
| --- | --- | --- |
| `ARCHMAX_API_BASE_URL` | yes | Base URL of the OpenAI-compatible API (e.g. `https://openrouter.ai/api/v1`) |
| `ARCHMAX_API_KEY` | yes | API key for the endpoint |
| `ARCHMAX_MODEL` | yes | Default model identifier (e.g. `anthropic/claude-sonnet-4.6`); a workflow may name its own (see below) |
| `ARCHMAX_TEMPERATURE` | no | Sampling temperature |
| `ARCHMAX_MAX_TOKENS` | no | Max output tokens |
| `ARCHMAX_STREAMING` | no | Model response streaming (default `1`). Controls the granularity of `agent-text-delta` lifecycle events: chunk-by-chunk when on, one whole-message delta per response when off. The events themselves always flow. Set `0` for OpenAI-compatible endpoints that misbehave under SSE. `invoke` results are identical either way. |


### Which model a turn runs on

`ARCHMAX_MODEL` is the **default** model id. A workflow may name the id its
states run on, at two positions in `workflow.yaml`:

```yaml
settings:
  model: gpt-5-mini         # every state of this workflow
states:
  draft:
    model: claude-opus-5    # this state only
```

Precedence, most specific first:

1. A state's `model`
2. The workflow's `settings.model`
3. An explicit `model` or `modelFactory` passed to `createAgent`
4. `ARCHMAX_MODEL`

A declared id is resolved over the endpoint and credentials configured above, so
the id is the one thing that changes. Sampling stays environment configuration
(`ARCHMAX_TEMPERATURE`, `ARCHMAX_MAX_TOKENS`), because an id is all a workflow
declares. See [`model`](/reference/machine-spec/#model).

One exception matters if you embed the SDK. An explicit `model` **instance**
handed to `createAgent` outranks every declared id, because the SDK cannot
rebuild a host's model under another id. Assembly emits one warning naming the
ids it made inert.

Pass a `modelFactory` instead. It is called for the `agent` and `rubric` roles
with the declared id as its `requested` argument. The `judge` role is called
without one, and `tests.judge.model` arrives in the `env` the factory is handed.

## Prompt caching

The stable prompt prefix (tool schemas + static system prompt) is cached by the
provider. A turn's repeated model calls then read that prefix from the cache,
priced at the cache-read rate below. See
[Token efficiency and cost](/guides/token-efficiency/).

| Variable | Description |
| --- | --- |
| `ARCHMAX_PROMPT_CACHE` | Master switch (default on). `0` removes every cache marker. |
| `ARCHMAX_PROMPT_CACHE_TTL` | Cache lifetime: `5m` (default) or `1h`. A 1-hour lifetime costs more per cache write and pays off for sessions that pause. |

Precedence runs the same way: the `promptCache` option to `createAgent`, then
the workflow's `settings.prompt_cache`, then these variables, then the defaults.

## Token pricing

Prices are USD **per 1M tokens**. Setting them makes `costUsd` appear on usage
events, in session artifacts, and in the CLI footer. Without them, tokens are
reported and cost is omitted.

| Variable | Description |
| --- | --- |
| `ARCHMAX_PRICE_INPUT` | Input token rate |
| `ARCHMAX_PRICE_OUTPUT` | Output token rate |
| `ARCHMAX_PRICE_CACHE_READ` | Cache-read rate (defaults to the input rate) |
| `ARCHMAX_PRICE_CACHE_WRITE` | Cache-write rate (defaults to the input rate) |

The cache rates cover the tokens the cache read and wrote. The input rate covers
the input tokens left over, so every token is charged once.

For per-model rates, pass the `pricing` option instead, keyed by model id. These
variables price every model the same, because they populate a `default` entry
that matches whatever is running. That matters for a workflow that runs its
states on different models.

A keyed table resolves against the id the response reported, then against the id
the runtime asked the endpoint to run. That second lookup keeps a workload priced
behind a proxy that omits the model id from its response.

To bypass env configuration entirely, pass `model` (a LangChain
`BaseChatModel`) or a per-role `modelFactory` to `createAgent`. See
the [public API reference](/reference/public-api/).

## CLI behavior

| Variable | Description |
| --- | --- |
| `ARCHMAX_CLI_NO_BANNER` | Suppress the interactive startup banner |
| `NO_COLOR` | Suppress ANSI color in all CLI-rendered output ([no-color.org](https://no-color.org)) |

Both are also automatic. The banner is skipped and output is plain whenever the
target stream is not a TTY: CI, piped or redirected output.

## Authored mounts

No configuration is needed. With no `mounts` option, the conventional table
(`defaultMounts(rootDir)`) is applied over the workspace root, which is what the
CLI does. The mounted keys are the whole served surface, so `.env` and `.git`
stay out of reach.

Pass `mounts` on `createAgent` to add a mount, narrow the set, or declare one
writable. See
[authored mounts](/reference/public-api/#authored-mounts-what-the-agent-may-read).

## Scratchpad

Each session gets an isolated working area at the agent-visible path
`scratchpad/…`, and it is the session's one named writable area. Alongside it
sit the runtime's offload areas and the agent-invisible checkpoints and
artifacts.

No configuration is needed. The path carries no session id: the runtime resolves
it against whichever session's turn is currently executing. The area persists as
long as the rest of the session, following its retention.

See the [code interpreter guide](/guides/code-interpreter/#the-working-area)
for what `tools.allow` can and cannot govern about it.

## Spec snapshot store

The first time a session's turn boundary writes a given machine-spec hash, the
runtime persists the full spec to `_specs/<specHash>.json` in the session store.
That store is content-addressed and shared by every session running against the
same spec version, so it grows with the number of distinct spec versions run,
not with the number of sessions or checkpoints.

Read it back with `agent.getSpecSnapshot(hash)`. See
[spec snapshots](/reference/public-api/#spec-snapshots-auditing-a-session-after-the-spec-changes)
for the audit use case this enables.

## Per-workflow settings

Sandbox and runtime settings live in the workflow's `workflow.yaml`, outside the
environment. Three blocks carry them:

| Block | Keys, for example |
| --- | --- |
| `settings` | `timeoutMs` for script execution |
| `tests` | `caseTimeoutMs` and `judge` for the case suite; `maxConcurrency` accepts 1 |
| `runtime` | `engine: archmax-harness` and `version: "2"`, the authoring contract |

See the [machine spec reference](/reference/machine-spec/).
