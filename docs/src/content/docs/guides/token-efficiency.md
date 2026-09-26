---
title: Token efficiency and cost
description: What a governed session actually sends on every model call, how to shrink it, how prompt caching works, and how to read a session's tokens and cost.
---

A governed session's input-token cost is dominated by a **prefix that is re-sent on
every model call**: the tool schemas plus the static system prompt. A single
state's turn runs several model→tool→model iterations. Each one re-bills that
prefix in full unless the provider serves it from cache.

Measured on the bundled `order-lookup` example, one model call. Both columns were
measured with the same package and dependency versions, so the comparison
isolates the payload shaping:

| Component | pre-reduction | today |
| --- | --- | --- |
| Tool schemas | 21,731 (~5,430 tok) | 19,807 (~4,950 tok) |
| - `write_todos` alone | 12,175 | 12,175 (always disclosed) |
| - `task` alone | 1,924 | 0 (disclosed in no state) |
| System prompt | 16,333 (~4,080 tok) | 9,321 (~2,330 tok) |
| **Prefix per model call** | **38,064 (~9,520 tok)** | **29,128 (~7,280 tok)** |

One tool dominates the surface: `write_todos` alone is 56% of the tool schemas,
and it is standard equipment in every assembly, so it stays. The whole reduction
therefore comes out of the system prompt, which keeps the prefix saving modest.
Caching removes the bulk of what is left.

That is ~7.3k input tokens per call with *zero* host tools bound. Fourteen calls
reaches 100k. A workspace binding 30-40 connector/MCP tools (~1.5k chars of
schema each) roughly triples the prefix. The archmax harness addresses this in three ways: a
smaller prefix, a cached prefix, and reporting so you can see both.

These numbers are upstream-sensitive. A Deep Agents or LangChain release that
rewords a built-in's schema moves them. Real numbers come from `model-usage`
events on an actual run, which report the provider's exact token counts.

## What the model reads, in order

One system prompt, layered. Every layer is either read through the backend or
rendered from something the runtime enforces:

1. `AGENTS.md`: the workspace's persona.
2. The consumer's `systemPrompt` option.
3. The platform prompt: how to move, which tools are the runtime's. It ships in the package; a
   workspace may override it with `.platform/system/GRAPH_STATE.md`. A plain agent has no
   platform layer.
4. Workspace zones, rendered from the resolved mount table.
5. The workflow header: the spec's `title` and `instructions`, and **no state of the graph**.
6. `WORKFLOW.md`: the prose addendum, HTML comments stripped.
7. Deep Agents' tool guidance: the file tools' and `write_todos`' sections, from their middleware.
8. The volatile "Current state" block, per model call: the current date and
   time, then the active state's instructions, skills, variables, argument
   constraints, **its own outgoing transitions**, its hooks, and the run's
   trigger signature.

Layers 1-6 are handed to Deep Agents as `{ prefix, base: null }`. Its own base
prompt ("You are a Deep Agent…", ~1,700 characters) is dropped: it is generic
assistant guidance that contradicts layer 3. Layers 1-7 are the static, cacheable
prefix. Layer 8 is never cached.

**The clock lives in layer 8, and is rounded.** Every model call opens with
`Current date and time: 2026-09-10 14:30 UTC (Thursday), rounded down to the
nearest 10 minutes — it can be that much behind.`. The host's IANA zone and its
local time follow when that zone is not UTC. Two things there are deliberate:

- **Layer 8 carries it.** A timestamp in the cacheable prefix would differ
  on every call and cost the cache of every layer behind it.
- **A ten-minute bucket.** "Volatile" has a price of its own. The provider's
  cache key is a *prefix*, and LangChain's Anthropic and Bedrock caching
  middlewares put their breakpoint on the last message. So a system block that
  differs between two calls re-prices the whole transcript behind it, not just
  its own ~40 tokens.

  Quantising the clock makes the line byte-identical across every model call of a
  turn shorter than the bucket. It usually holds across two turns as well, close
  enough for the previous turn's cache to still be warm (the default TTL is 5m).
  What it gives up is precision the prompt can spare: a date, a weekday and the
  time to ten minutes are what date arithmetic runs on. A state that needs the
  exact instant can read it in the sandbox.

A parked run reads the clock too. The handoff message is written now, and "now"
may be days after the run started.

**The graph is disclosed per state, not per workflow.** Listing every state in
the cached prefix would make it grow with the graph, while the agent can act on
exactly one state's edges. So layer 5 is a function of the workflow header alone. A one-state and a
fifty-state workflow with the same `title` and `instructions` produce
byte-identical prefixes. What the agent is told about the graph is the active
state's outgoing edges, in layer 8, so the per-call graph cost scales with that
state's out-degree.

That also closes a disclosure hole. A state the agent cannot advance to is a
state it cannot name, so a prompt injection has no map of the workflow to steer
with.

## One rendering

There is **one** model-facing payload. The reductions below are unconditional.
No option and no spec setting selects a different rendering, so a disclosure test
has a single payload shape to pin.

What the rendering does:

- **The graph stays out of the static prompt.** The rendered header carries
  the workflow's `title` and root `instructions`. A state's own `instructions`,
  edges, markers and hooks arrive per turn while it is active. Each state's
  guidance is billed once, for the turns where it applies.
- **`task` is withheld** in every state of every assembly, and nothing grants it.
  A [grading rubric](/guides/grading-rubrics/) grades the agent,
  so the tool belongs to the runtime. Its schema is ~1,900 characters, and no
  state ever sends it.
- **Upstream guidance for a withheld tool is pruned** from the system prompt by
  exact heading match. If an upstream rewording makes a heading unmatchable, the
  prompt is left untouched and a `warning` event says so.
- **HTML comments are stripped from the prose addendum.** `WORKFLOW.md` can
  therefore hold diagrams and rationale for whoever opens the file, without
  charging every model call for them.

The reduction leaves the workflow's top-level `instructions` in place. Those are
standing direction for the whole session, so they sit in the static, cacheable
prefix: paid in full once per session, then at cache-read rates.

A state's `instructions` apply to one turn, so they are injected per turn and
stay out of the static section.

### Authoring for a small prefix

- Put behavior guidance in the state's `instructions`. It is sent only while that
  state is active.
- Put workflow-wide conventions in the workflow's top-level `instructions`, where
  they are sent once in the cached prefix. The same paragraph pasted into every
  state is paid for per turn.
- Write each transition's `description` for a reader standing in the *source*
  state. It is required, and it is the whole of what the agent knows about where
  an edge leads: nothing about the target is disclosed. Say *when* to take the
  edge ("Refunds over $50").
- A state's `summary` and `title` stay out of every model call and cost nothing.
  They are labels for people and hosts, so write them for whoever opens the spec.
- Splitting one broad state into several narrow ones does not widen the prefix.
  The cost is what each state's own block carries while that state is active.
- Keep prose non-derivable. Anything the spec already says is re-sent on every
  model call for no added value. Put reader-facing material in an HTML comment.

### Keeping the transcript small

The prefix is only half of it. Everything a turn does is re-sent on every later
model call of that turn.

- **Do multi-call work in `archmax_eval`.** Its `tools.*` calls are governed
  identically. Only the last expression and the console output come back, so a
  loop over 50 records puts one result in the transcript instead of 50. The
  platform prompt instructs this by default.
- **Quote a stored value with `${{name}}`** in a tool argument. The substitution
  happens after the model writes, so the transcript keeps the reference and the
  tool gets the value.

### Measuring what you spend

Read the `model-usage` events on a real run. They carry the provider's own exact
token counts, per turn, with `costUsd` when pricing is configured. See
[reading tokens and cost](#reading-tokens-and-cost).

## Prompt caching

The archmax harness marks the stable prefix so the provider serves it at cache-read rates
(~10% of input price on Anthropic). This is on by default.

To make that possible, the system message is split into two content blocks. The
**static** block (persona, platform prompt, rendered workflow header, upstream
guidance) is byte-identical for the whole session and carries the cache
breakpoint. The **volatile** block holds the active state's section, and is never
marked.

Which mechanism applies is resolved from the model. **LangChain owns the
provider mechanics wherever it has them**:

| Model | Mechanism |
| --- | --- |
| `ChatAnthropic` | LangChain's `anthropicPromptCachingMiddleware` |
| `ChatBedrockConverse` (Claude/Nova) | LangChain's `bedrockPromptCachingMiddleware` |
| Claude over an OpenAI-compatible endpoint | Explicit `cache_control` on the static block (no LangChain built-in exists for this path) |
| Anything else | No markers. OpenAI and Gemini do automatic prefix caching, which the stable prefix already serves. |

An unrecognized model never fails a session. It gets no markers and no
`warning`; the `prompt-shaping` event names its strategy (`unsupported`). To
confirm the provider's automatic caching works, watch `cacheReadTokens` on the
`model-usage` events: it rises from the second call of a turn on. If it stays at
zero, the provider caches nothing. See
[reading tokens and cost](#reading-tokens-and-cost).

| Variable | Description |
| --- | --- |
| `ARCHMAX_PROMPT_CACHE` | Master switch (default on) |
| `ARCHMAX_PROMPT_CACHE_TTL` | `5m` (default) or `1h`. A 1-hour lifetime costs more per cache *write*; it pays off for sessions that pause (e.g. parked at a human state). |

```ts
await createAgent({ promptCache: { enabled: true, ttl: "1h" } });
```

### Where caching misses

Tool definitions sit at the front of the cached prefix, and per-state disclosure
changes the tool list. So **entering a new state invalidates the cache**.

That is deliberate. The dominant cost is the several model calls *within* a turn,
where the tool set is constant, and governance-derived disclosure is worth more
than the boundary miss would save.

## Reading tokens and cost

Token counts come from the provider (LangChain's `usage_metadata`), including how
many input tokens were served from cache. They arrive as one `model-usage` event
per model call, carrying:

- `state` and `model`
- `inputTokens`, `outputTokens`
- `cacheReadTokens`, `cacheCreationTokens`
- `costUsd`, when pricing is configured

`inputTokens` is the **total** input count, and `cacheReadTokens` and
`cacheCreationTokens` break it down. Subtract both from `inputTokens` and you
have the part billed at the full input rate, which is the figure the table at the
end of this page carries.

There is deliberately no "run finished" event to wait for. Your `invoke`
returning *is* the end of the session, and that is where you read the totals. The
supported way to aggregate them is `createUsageTracker()`:

```ts
import { createAgent, createUsageTracker } from "@archmax-ai/harness";

const usage = createUsageTracker({ onEvent: myOwnSubscriber }); // onEvent optional
const runtime = await createAgent({ onEvent: usage.handler });

await agent.invoke(input, { configurable: { thread_id: "t1" } });

console.log(usage.totals("t1"));
// { inputTokens: 20369, outputTokens: 287, cacheReadTokens: 18074,
//   cacheCreationTokens: 0, costUsd: 0.016612 }
console.log(usage.bySession());     // per-session totals for concurrent sessions
```

That cost is the `claude-sonnet` rates below applied to those counts, all per 1M:
`2,295 * $3 + 287 * $15 + 18,074 * $0.30`. The 2,295 is what is left of the input
once the cache reads come out of it.

A finished session's totals are also written to
`sessions/<sessionId>/artifacts/metadata.json` (`usage`), so cost survives the
process. `archmax run` and `archmax test` print a footer on stderr; `stdout` stays
the answer channel:

```
tokens     in 20,369 · out 287 · cache r 18,074/w 0 · $0.0166
```

### Pricing

Cost is **omitted, never guessed**: without prices you get token counts. Prices
are USD per 1M tokens.

The input rate applies to the input tokens the cache did **not** serve, and the
cache rates apply to the rest. A cached token is charged once, at its own rate.

| Variable | Description |
| --- | --- |
| `ARCHMAX_PRICE_INPUT` | Input rate |
| `ARCHMAX_PRICE_OUTPUT` | Output rate |
| `ARCHMAX_PRICE_CACHE_READ` | Cache-read rate (defaults to the input rate) |
| `ARCHMAX_PRICE_CACHE_WRITE` | Cache-write rate (defaults to the input rate) |

Or per model, which is what a multi-model deployment wants:

```ts
await createAgent({
  pricing: {
    "claude-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    default: { input: 1, output: 2 },
  },
});
```

Lookup is exact model id, then the longest key that is a substring of the id (so
`claude-sonnet` prices `anthropic/claude-sonnet-4.6`), then `default`.

**Which id is looked up** is the one the response reported, then the one the
runtime asked the endpoint to run. The reported id leads deliberately: a proxy
may serve an alias, a fallback or a load-balanced deployment, and what it served
is the honest thing to price.

An OpenAI-compatible endpoint is free to omit the model from its response, and
many proxies do. The requested id carries the lookup then, so a table keyed by
real model ids prices a workload either way. With neither id in hand the lookup
falls to `default`.

Each `model-usage` event reports the id its call was priced against.

## What this adds up to

The same prompt against the bundled example, `anthropic/claude-sonnet-4.6` over
an OpenAI-compatible endpoint:

| | input tokens | served from cache | billed at full price |
| --- | --- | --- | --- |
| pre-reduction, caching off | 36,221 | 0 | 36,221 |
| reduced payload, caching on | 20,369 | 18,074 | **2,295** |

44% fewer input tokens, and 94% fewer input tokens at full price.

That run was measured while the todo surface was still an opt-in. It is now
always disclosed, so the reduced figure would be higher today. The composition
table above gives the current prefix.

The addition sits in the **static** block. After the first call of a session the
provider serves it from cache like the rest of the prefix.

## Turning caching off

`ARCHMAX_PROMPT_CACHE=0` removes every cache marker. What the kernel permits is
decided by the spec and the governance rules, so it reads the same with caching
on or off.
