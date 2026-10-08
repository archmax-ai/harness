## Context

Deep Agents 1.13.4 is installed and its `@langchain/quickjs` dependency already requires it, while
`package.json` still allowed 1.11.1. Each item below was checked against the installed bundle
(`node_modules/deepagents/dist/langsmith-BAO_h4J6.js`) before it was changed.

## Decisions

**F1: forward the cap everywhere; cap where nothing else does.** Deep Agents' grep tool calls
`backend.grep(pattern, path, glob, input.max_count ?? 1000)`. `CompositeBackend.grep` already
forwards the cap to each route and applies `applyGrepMaxCount` to the total, so a search it serves
is capped even if a store ignores it. The router's direct path to an unsearchable mount bypasses
the composite, so it applies `applyGrepMaxCount` itself. The wrappers (`mountSubtree`, which also
wraps every read-only mount, and the session zone) forward the cap so a store can stop early. Before
this, the default cap of 1,000 was dropped too: every store returned every match, and only the grep
tool's 80,000-character limit on its answer cut the result short.

**F2: delete, don't fix.** `createDeepAgent` hands `createSubAgentMiddleware` no `systemPrompt`, so
the middleware appends nothing, and `TASK_SYSTEM_PROMPT` is only exported. There is no text to
prune. The prompt is byte-identical with one exception, found by making the old code record every
prompt it changed across the whole suite: `pruneSections` also collapsed runs of three or more line
breaks and trimmed the text. No real assembly in the suite, and no file in the reference workspace,
has such a run; authored prose that does now reaches the model as written. The `withheld` field of
`prompt-shaping` stays: it is still true, and hosts read event fields as a contract.

**F4: the general-purpose subagent cannot be turned off, so say what holds.** In 1.13.4
`createDeepAgent` builds it unless the harness profile sets `generalPurposeSubagent.enabled: false`,
and passes `generalPurposeAgent: false` to the subagent middleware itself only because the
subagent is already in the list. Probing the bound tools shows a governed agent never offers
`task`, and a plain agent offers `task` with the general-purpose subagent. The comment, the public
API page and the assembly spec now say so, and a test pins the plain agent's surface. Changing it
would need a per-agent profile (see F5).

**F5: the suffix lands, but not through `ChatOpenAI`.** `createDeepAgent` appends
`harnessProfile.systemPromptSuffix` after `{ prefix, base: null }`, and the profile is looked up from
the provider and the instance's `model_name ?? modelName`. `@langchain/openai` 1.5.13's
`ChatOpenAI` sets only `model`, so a `ChatOpenAI` instance resolves no profile. That is why the
request's reproduction (`new ChatOpenAI({ model: "gpt-5.2-codex" })`) gives no suffix. A LangChain
`ConfigurableModel` (`initChatModel("gpt-5.2-codex", { modelProvider: "openai" })`) carries its id
in `_defaultConfig.model` and does get the Codex suffix. The `it.fails` test uses that route. A
second, ordinary test asserts that the `ChatOpenAI` instance gets no suffix; if Deep Agents starts
reading `model`, it fails, and the gap reaches the env-configured model. The library does not call
`registerHarnessProfile`: that would change the host's whole process.

Probing also showed a second Codex effect. The Codex profile adds `todoListMiddleware` to the
**tail** of the stack, and Deep Agents merges a same-named custom middleware into that position. So
on such a model the harness's todo middleware runs inside the workflow instrumentation, and its
guidance lands after the volatile block instead of in the static prefix. A per-agent profile in
Deep Agents would fix both, but no upstream request is filed, so closing either gap is the
harness's own work: removing the suffix from the static prompt it already rewrites, and keeping its
todo middleware where the merge cannot move it.

**F6: both suspicions hold, by test and by source.** Deep Agents adds, for `ChatAnthropic`,
LangChain's `anthropicPromptCachingMiddleware` and its own `CacheBreakpointMiddleware`, and for
`ChatBedrockConverse`, LangChain's `bedrockPromptCachingMiddleware`, unconditionally in the tail of
the stack. Deep Agents' merge lets a same-named custom middleware replace a default, and the
harness's copies of LangChain's middleware have the same names. So:

| Client, `promptCache` | Static block | Volatile block | `cache_control` setting |
| --- | --- | --- | --- |
| `ChatAnthropic`, on (`1h`) | unmarked | `{ type: "ephemeral" }` (Deep Agents) | `1h` (the harness's copy) |
| `ChatAnthropic`, off | unmarked | `{ type: "ephemeral" }` (Deep Agents) | `5m` (Deep Agents' copy) |
| `ChatBedrockConverse`, on (`1h`) | unmarked | unmarked | `1h` (the harness's copy) |
| `ChatBedrockConverse`, off | unmarked | unmarked | `5m` (Deep Agents' copy) |

From `@langchain/aws` 1.4.5's source (read in the platform's install, not run):
`ChatBedrockConverse` turns the setting into a `cachePoint` appended after the last system block,
after the last message, and after the tools, and adds none when the system blocks already hold a
cache point. So on Bedrock the cached system prefix ends after the volatile block as well.

The consequences: caching cannot be turned off for these two clients, and a change to the volatile
block (every state change, and every ten-minute clock bucket) re-writes the system prefix on them.
The lifetime is right while caching is on. Whether the harness should place its own breakpoint
after the static block for these clients (a `cachePoint` block on Bedrock, which suppresses the
appended one; `cache_control` on the static block on Anthropic) and keep Deep Agents' out is a 0.5.0
decision. For 0.4.2 the tests pin the table above and the docs describe it.

## Risks

- [A host relied on unbounded `grep`] → A search over 1,000 matches now stops there, with Deep
  Agents' note telling the agent to narrow it or raise `max_count`. That is Deep Agents' documented
  behaviour.
- [The `it.fails` test passes for the wrong reason] → If assembly broke, `it.fails` would still
  pass. Its sibling test runs the same helper and must pass, so a broken helper shows up there.
