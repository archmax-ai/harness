## Why

Every assembly on a model the runtime places no cache marker for — any model that is not Claude or Bedrock Nova — emits a `warning` that "prompt caching is inactive". That covers OpenAI, Gemini and any OpenAI-compatible proxy alias. The claim is false for the providers it fires on most: they cache a stable prefix automatically, and the byte-identical static block already serves them. A host observed a turn on such a model with 96% of its 2.24M input tokens served from cache, while the warning was repeated at the start of every turn. The warning names nothing the author can act on, and a host that forwards warnings to its logs or its users reports a false fault on every turn.

## What Changes

- Assembly stops emitting the `warning` for a model whose cache strategy is `unsupported`. Nothing else about that model's calls changes: no marker is placed, as today.
- The `prompt-shaping` event keeps naming the resolved strategy, so a host that wants to know which mechanism applies still can.
- The warning for a state whose model resolves to a different **native** strategy than the workflow's model stays. That one names a real misconfiguration.
- The unexported `unsupportedCacheMessage` helper and its test are deleted.
- Not a public API change: the helper is not exported from the package root, and the `PromptCacheStrategy` values are unchanged. A host that filtered this warning's text simply stops receiving it.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `runtime`: the "Prompt caching" requirement states that a model with no marker mechanism gets no marker and no warning.
- `assembly`: the "Prompt cache and pricing options" requirement drops the assembly-time `warning` for a model that supports no cache strategy.

## Impact

- **Code**: `src/assembly/compose.ts` (the `strategyOf` memo stops warning), `src/workflow/prompt-cache.ts` (helper removed), `src/workflow/prompt-cache.test.ts`, `src/assembly/assembly.test.ts`.
- **Docs**: `docs/src/content/docs/guides/token-efficiency.md` says "A `warning` event reports that caching is inactive". Replace that sentence with the current rule: nothing is reported beyond the `prompt-shaping` strategy, and rising `cacheReadTokens` confirms automatic caching.
- **README.md**: no update; it does not mention the warning.
- **Skill** (`skills/archmax-harness/`): no update; it does not mention the warning, and `references/backend-integration.md` already points hosts to `cacheReadTokens` to confirm caching works.
- **Release**: a patch release (`release` label). Consuming hosts pick it up with their next version bump.
