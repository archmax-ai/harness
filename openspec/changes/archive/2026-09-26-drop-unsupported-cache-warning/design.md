## Context

`composeWorkflowAgent` (in `src/assembly/compose.ts`) resolves a cache strategy once per distinct model through the `strategyOf` memo. When a model resolves to `unsupported`, the memo calls `warn(unsupportedCacheMessage(model))`. Assembly runs at the start of every turn, so a host sees the warning once per turn per such model.

The same strategy already reaches the host twice more, and neither is a warning:

- the `prompt-shaping` event carries `cache: "unsupported"`, which the default console subscriber renders as `[workflow] prompt cache unsupported`;
- usage events carry `cacheReadTokens`, which is the evidence of whether caching is actually working.

The second warning in the same memo — a state whose model resolves to a different **native** strategy than the workflow-level model — names a misconfiguration: the native middleware is graph-level, so that state is cached with the wrong mechanism or not at all.

## Goals / Non-Goals

**Goals:**

- No `warning` for a model the runtime places no marker for.
- Keep every signal that stays true: the `prompt-shaping` strategy, the usage counters, and the mismatched-native-strategy warning.

**Non-Goals:**

- Renaming the `unsupported` strategy value or changing the `prompt-shaping` line. `PromptCacheStrategy` is part of the event contract hosts read, and renaming it would break them without changing what any call does.
- Detecting whether an endpoint caches automatically. The runtime cannot know before the first call, and after it the host already has `cacheReadTokens`.

## Decisions

### Remove the warning rather than lower its level

The diagnostic is deleted, not re-emitted as `info`.

- **Why:** at `info` it would repeat what the `prompt-shaping` event already says, one line after it, on every turn. The owner asked for the log entry to go.
- **Alternative considered:** reword it to "cache markers are not placed for '…'; the provider's automatic prefix caching applies". That is accurate, but it would still be a second line reporting the same strategy the `prompt-shaping` event names.

### Delete `unsupportedCacheMessage`

With no caller left, the helper and its unit test go. It is not exported from the package root, so no host can depend on it.

## Risks / Trade-offs

- [An author on a provider that really does not cache loses the hint] → The `prompt-shaping` line still names `unsupported`, and a `cacheReadTokens` of zero on the usage events shows it directly. The token-efficiency guide says so.
- [A host that matched the warning's text to suppress it] → It stops receiving the warning, which is the outcome the match was for.
