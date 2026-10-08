## Why

The platform's review of the harness boundary (its request of 8 October 2026, F1–F6) found places
where the harness and Deep Agents 1.13.4 disagree about what the other does:

- The workspace's `grep` wrappers take three arguments, and Deep Agents passes the match cap as a
  fourth, so no cap ever reaches a store.
- The harness prunes Deep Agents' `task` guidance, which 1.13.4 never adds. The pruning finds
  nothing and warns on every governed assembly.
- A dependency floor, a parameter and several texts still describe Deep Agents 1.11.
- Deep Agents adds two things per model that nothing pinned: a harness profile's prompt suffix, and
  its own prompt-cache middleware for Anthropic and Bedrock Converse clients.

## What Changes

- **F1 — `grep`'s cap reaches the store.** The session zone, `mountSubtree` (every read-only mount
  too) and the workspace router forward `maxCount`; the router caps a search delegated to an
  unsearchable mount with Deep Agents' `applyGrepMaxCount`.
- **F2 — the prompt pruning is deleted**, with its warning and its plumbing. The `prompt-shaping`
  event keeps `withheld`.
- **F3 — Deep Agents `^1.13.4`**, and the stale texts: the todo-middleware comment, prompt layer 7
  (`AGENTS.md`, `core/prompt.ts`, the token-efficiency guide, two specs), and the delegation-bounds
  docstrings, which named a `bounds` option no host has.
- **F4 — `generalPurposeAgent: false` is dropped.** It is not a `createDeepAgent` parameter. The
  general-purpose subagent is still built: a governed agent never offers `task`, and a plain agent
  offers it, as a plain Deep Agent does. The docs now say so.
- **F5 — the profile suffix is pinned.** An `it.fails` test assembles a governed agent on a Codex
  model and asserts no Codex suffix; a sibling test pins why the env-configured `ChatOpenAI` is not
  affected. No upstream request is filed: if the gap is closed, the harness closes it itself.
- **F6 — Deep Agents' own caching is pinned and documented.** Tests capture what reaches a
  `ChatAnthropic` and a `ChatBedrockConverse` model with caching on and off. The docs no longer say
  that turning caching off removes every marker.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `workspace-and-sessions`: "Search dispatch honours a mount's search posture" (the cap).
- `governance`: "Per-state tool disclosure" (no pruning, no warning).
- `runtime`: "The system prompt is layered" (layer 7, the profile suffix); "Prompt caching" (what
  Deep Agents adds for Anthropic and Bedrock Converse clients).
- `assembly`: "`createAgent` mirrors `createDeepAgent`" (the general-purpose subagent); "System
  prompt composition" (layer 7).

## Impact

`src/core/{path-mapping,session-zone,workspace-router,prompt}.ts`, `src/assembly/compose.ts`,
`src/workflow/{governance,middleware}.ts` (and the deleted `prompt-pruning.ts`),
`src/machine/delegation.ts`, `src/index.ts`, `package.json`; new behaviour tests
`grep-cap.test.ts` and `upstream-additions.test.ts`. Docs: the token-efficiency guide,
`reference/public-api.md`, `reference/configuration.md`, the changelog, `AGENTS.md`; the authoring
skill's `backend-integration.md`. No public export changes. Released as 0.4.2.
