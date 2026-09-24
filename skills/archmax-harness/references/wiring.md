# Wiring the runtime into a backend — the short form

Load this when embedding `@archmax-ai/harness` in a service. Every option shape, the
event catalogue and recipes: [`backend-integration.md`](backend-integration.md).


```ts
import { createAgent, WORKFLOW_STATUSES, createUsageTracker } from "@archmax-ai/harness";

const usage = createUsageTracker();
const agent = await createAgent({
  workflow: "order-lookup",
  workspace: { rootDir, /* mounts?, sessionStore? */ },
  onEvent: (e) => { usage.handler(e); publish(e); },   // omit for the console subscriber
  // model | modelFactory, tools, systemPrompt, middleware, backend, checkpointer,
  // trigger, variables, promptCache, pricing, hookExecutors …
});
const sessionId = `run-${runId}`;
const result = await agent.invoke(
  { messages: [{ role: "user", content: prompt }] },
  { configurable: { thread_id: sessionId }, recursionLimit: 50 },
);
if (result.status === WORKFLOW_STATUSES.awaitingDecision) {
  // result.pendingDecision.transitions → show to a person, then:
  // await agent.workflow.decide(sessionId, { target, comment });
}
usage.totals(sessionId);       // tokens (+ costUsd only when pricing is configured)
agent.dispose(sessionId);
```

- **Install**: `npm i @archmax-ai/harness`; pre-publish, `npm pack` and install the
  tarball (a real copy, not a symlink). This skill ships in the package at
  `BUNDLED_AUTHORING_SKILL_DIR` (`<dir>/archmax-harness/SKILL.md`).
- **Mounts**: `workspace.mounts` is a route table — key → backend, or
  `{ backend, readOnly, governed }`. Mark a mount `governed: true` to hand the
  spec's `mounts` block the decision of which **states** reach it (closed by
  default, like a skill bundle) and whether each may write there; a mount not so
  declared is visible in every state, so an existing table behaves unchanged.
  `readOnly` is a ceiling the spec cannot lift.

  ```ts
  workspace: {
    rootDir,
    mounts: {
      ...defaultMounts(rootDir),                                  // skills/, .platform/, AGENTS.md
      "/reference/": { backend: mountSubtree(store, "reference"), governed: true },
      "/shared/": { backend: mountSubtree(store, "shared"), readOnly: false, governed: true },
    },
  },
  ```

  Then in `workflow.yaml`: `mounts: { allow_always: [reference] }`, a state's
  `mounts: { allow: [{ mount: shared, access: read }] }`, and
  `mounts.forbid_always` for what no state (or child session) may reach. Pass the
  same table to `validateWorkflow({ mounts })` so `archmax validate` checks the
  spec's names against the wiring.
- **Storage**: default filesystem store at `<root>/sessions`; else
  `createFilesystemSessionStore({ dir })`, `createBackendSessionStore({ backend, prefix? })`,
  `createMemorySessionStore()`. A custom `backend` without `sessionStore`
  throws `SessionStoreRequiredError`. Delete sessions via `agent.sessions.delete(id)`.
- **Agent**: Deep Agents' `invoke`/`stream`/`streamEvents` + checkpoint
  surface; `sessions.list/get/delete`; `emitRunArtifacts`; `dispose`.
  Governance under `agent.workflow`: `machine`, `resolveTrigger`,
  `send(sessionId, input)` → one `Outcome` (`decide`/`reply`/`deliver` are
  conveniences), `resolveSession`.
- **Multi-turn**: re-invoke the same `thread_id` with only the new message;
  never concatenate a conversation into one string. A spec edit is adopted,
  not refused: the next turn runs under the current `workflow.yaml` (the
  recorded `specHash` says which version each turn ran under), and a state
  the edit removed reopens at the entry state.
- **Human-in-the-loop**: `status === "awaiting_decision"` →
  `pendingDecision.transitions` → `decide`. `reply(sessionId, text)`
  answers a message without moving the run. An `archmax_wait` park is
  `awaiting_input` → `deliver(sessionId, { trigger, variables, message? })` — the
  person's message travels with the firing; a park with `resumeAt` is the host
  scheduler's cue. A delegated child's park is named on `Outcome.delegation`.
- **Events**: `onEvent` receives the one typed stream — `state-enter/leave`,
  `advance`, `hook-verdict`, `parked/decided`, `tool-called/result/blocked`
  (every governed call, `archmax_advance` included, grouped by `callId`),
  `agent-text-delta`/`agent-text` (streaming by default, `messageId` groups
  chunks), `model-usage` (provider counts per turn), `title-set`, warnings.
  There is no run-end event; `invoke` returning is the end. Metrics are a
  fold over this stream; only cost is checkpointed (`sessions.get(id).usage`).
- **Artifacts** per session under `sessions/<id>/artifacts/`: `graph.json`/`.mmd`,
  `trajectory.json`, `trail.json`, `variables.json`, `metadata.json` (incl.
  usage); the agent's files under `scratchpad/`.
- **Cases against your agent**: `runTests({ workflow, rootDir, createTarget?, sessionIdForCase? })`
  from `@archmax-ai/harness/testing`; wire `createToolMockMiddleware()` into your
  target or a case with `mocks:` is refused before running.
- **Model/caching**: `ARCHMAX_API_BASE_URL`, `ARCHMAX_API_KEY`, `ARCHMAX_MODEL`
  (+ `ARCHMAX_TEMPERATURE`, `ARCHMAX_MAX_TOKENS`, `ARCHMAX_STREAMING`) for any
  OpenAI-compatible endpoint, or pass `model`. Prompt prefix is cache-marked
  by default (`promptCache: { enabled, ttl: "5m" | "1h" }`); watch
  `cacheReadTokens`. Pricing via `pricing: { "<model-substring>": { input, output, cacheRead, cacheWrite } }`
  or `ARCHMAX_PRICE_*`; without it report tokens, never a guessed cost. A keyed
  table works behind a proxy that echoes no model back — the id falls back to the
  one the runtime was configured to run. Cached tokens are charged once, at the
  cache rate, not at the input rate as well.

Typical split: worker = `createAgent` + `invoke` + `decide`/`deliver`; API =
artifacts + event subscription; frontend = graph + trajectory + live stream.
