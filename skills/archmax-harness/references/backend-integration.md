# Wiring @archmax-ai/harness into a backend — integration reference

How to embed the `@archmax-ai/harness` package in a service so a worker can
**execute** workflows and an API/frontend can **visualize** run state. All names
below are the real public API (`src/index.ts`); confirm against the installed
package's `dist/index.d.ts`.

## Contents

- [Install (registry & local tarball)](#install)
- [Public exports](#public-exports)
- [createAgent options](#createworkflowagent-options)
- [Agent](#workflowruntime)
- [Running a workflow](#running-a-workflow)
- [Human-in-the-loop](#human-in-the-loop)
- [Exposing a workflow to outside callers (MCP, forms, APIs)](#exposing-a-workflow-to-outside-callers)
- [Lifecycle events (live visualization)](#lifecycle-events)
- [Session artifacts (historical visualization)](#run-artifacts)
- [Model configuration](#model-configuration)
- [Custom backends](#custom-backends)
- [Cases against your agent](#cases-against-your-agent)
- [Suggested worker / API / frontend split](#suggested-split)

---

## Install

**Registry** (once published): `npm i @archmax-ai/harness`.

**Local / pre-publish** — install exactly what the registry would ship (a real copy
in `node_modules`, not a symlink), so behavior matches production:

```bash
# in the harness repo
npm run build
npm pack --pack-destination /tmp        # → /tmp/archmax-ai-harness-<version>.tgz

# in the consuming service
npm  add /tmp/archmax-ai-harness-<version>.tgz
# or pnpm --filter <pkg> add /tmp/archmax-ai-harness-<version>.tgz
```

The published tarball contains only `dist/` + `README.md` (the package `files`
allowlist), so `dist/index.d.ts` types travel with it — a shared types package can
re-export the run-artifact/event shapes for an API/frontend without importing the
runtime. Because the version rarely changes during development, `remove` then `add`
(or prune the store) so a repack of the same version actually reinstalls.

**This skill ships inside the package** (staged into `dist/authoring-skill/archmax-harness/`):
resolve it from the install via the `BUNDLED_AUTHORING_SKILL_DIR` export — the
`dist/authoring-skill` directory holding `archmax-harness/`, so this file is
`<BUNDLED_AUTHORING_SKILL_DIR>/archmax-harness/SKILL.md` — e.g.
`npx skills add ./node_modules/@archmax-ai/harness/dist/authoring-skill/archmax-harness`.
Prefer this over
syncing a copy from a source checkout, so the skill can never drift from the
installed SDK's validator. Tooling that needs the install root without importing
the runtime can use `require.resolve("@archmax-ai/harness/package.json")` (exposed in the
`exports` map).

## Public exports

From `@archmax-ai/harness` (`src/index.ts`):

| Export | Kind | Purpose |
| --- | --- | --- |
| `createAgent` | fn | Assemble a runnable workflow-governed agent |
| `Agent` | type | Returned runtime (`graph`, `decide`, `deliver`, `resolveSession`, `runs`, `emitRunArtifacts`, `dispose`, `resolveTrigger`) |
| `CreateAgentParams` | type | Assembly options |
| `DecideOutcome` | type | Return of `decide()` |
| `DeliverOutcome`, `TriggerDelivery` | type | Argument / return of `deliver()` |
| `WorkflowLoadError` | class | Thrown when the workflow spec (`workflow.yaml`) is missing/invalid (fails closed) |
| `DEFAULT_WORKFLOW` | const | `"order-lookup"` |
| `BUNDLED_AUTHORING_SKILL_DIR` | const | The packaged `dist/authoring-skill` directory holding `archmax-harness/` (`<dir>/archmax-harness/SKILL.md`). The example workspace is not shipped in `dist/`; clone the repo to use it. |
| `WORKFLOW_STATUSES` | const | `running` \| `completed` \| `rejected` \| `awaiting_decision` (`awaitingDecision`) \| `awaiting_input` (`awaitingInput`) |
| `isFinished`, `classifyStatus` | fn | The open/finished partition — a parked session is **open** |
| `WorkflowLifecycleEvent`, `WorkflowEventHandler` | type | Event stream types |
| `createWorkflowEventEmitter`, `renderEventLine` | fn | Event emitter + console formatter |
| `createWorkspaceContext` | fn | Compose the workspace backends (session zone + mounts + authoring backend) |
| `createFilesystemSessionStore`, `createBackendSessionStore`, `createMemorySessionStore` | fn | Run-store factories (physical storage for the session zone) |
| `SessionStoreRequiredError`, `SessionStoreCapabilityError` | class | Assembly / capability errors for run storage |
| `workflowStateSchema`, `workflowPaths`, `sessionPaths`, `runArtifactPaths` | schema/fn | State schema + path helpers |
| `runTests`, `RunTestsOptions`, `CaseResult` | fn/type | Run a workflow's cases — [against your own agent](#cases-against-your-agent) |
| `SIGNATURE_TYPES`, `normalizeSignature`, `signatureForTrigger`, `signatureJsonSchema`, `signatureValueIssues` | const/fn | A trigger's typed signature as JSON Schema and its conformance rule — [exposing a workflow](#exposing-a-workflow-to-outside-callers); also on `@archmax-ai/harness/spec` |

## createAgent options

All optional (`CreateAgentParams`, `src/assembly/index.ts`):

| Option | Type | Notes |
| --- | --- | --- |
| `rootDir` | `string` | Workspace root for the default filesystem backend. Defaults to cwd. |
| `workflow` | `string` | Named workflow under `workflows/<name>/`. |
| `trigger` | `TriggerInput` | `{ id, args? }`; defaults to `{ id: "manual" }`. Selects the start state. |
| `model` | `BaseChatModel` | Defaults to the env-configured OpenAI-compatible model. Inject your own to bypass env. |
| `backend` | `BackendProtocolV2` | Serves the authored workspace. Defaults to a `FilesystemBackend` over `rootDir`. |
| `authoring` | `BackendProtocolV2` | Serves the **authoring plane** — `workflows/**` (machine specs including the rubrics their states declare, `WORKFLOW.md`, `hooks/`, `tests/`) — to the runtime only. Never a route in the agent's workspace, so no tool call or PTC call can reach it. Defaults to `backend` when you supply one, else a `FilesystemBackend` over the resolved root. Handing it to a **writable** mount throws `AuthoringBackendExposedError`; a read-only mount may share it. |
| `mounts` | `Record<string, MountSpec>` | Authored mounts as a `CompositeBackend` route table: key → backend, or `{ backend, readOnly, governed, searchable }`. Trailing slash = directory mount; no slash = exact-path file mount (`"/AGENTS.md"`). Read-only unless declared otherwise. `governed: true` hands the spec's `mounts` block the decision of **which states** may reach it (closed by default, like a skill bundle) and whether each may write there; a mount not so declared is visible in every state exactly as today, so a table that marks nothing behaves unchanged. `readOnly` is a **ceiling** the spec cannot lift: a grant may narrow a writable mount to reads in a state, never open a read-only one. A key may be several segments deep (`"/catalogs/eu/"`); its **first** segment is what is reserved, so `/workflows/x/` fails as `/workflows/` does. Omitted on the default backend: `defaultMounts(rootDir)` (the conventional table — `/skills/`, `/.platform/`, `/AGENTS.md`, none governed — extend with `{ ...defaultMounts(root), "/templates/": … }`). Omitted with a custom `backend`: nothing authored is served; expose subtrees with `mountSubtree(backend, "skills")`. A key colliding with a run area — or naming the authoring-plane prefix (`/workflows/`) — throws `MountCollisionError`. `searchable: false` declares a mount the runtime never searches on its own initiative: a root-wide `grep`/`glob` fans out over the other mounts only, while a search the agent addresses at the mount (or a path inside it) still reaches its backend and returns the backend's own answer — matches or `{ error }` — verbatim. Use it for a backend that must refuse searches (a remote folder served live). Listing and reading are unchanged, the prompt marks it "browse only", names arrive as `MountPrefixes.unsearchable`, and it is ignored on a file mount. |
| `sessionStore` | `SessionStore` | Physical storage for run state (checkpoints, artifacts, the per-session `scratchpad/`). Zero-config default: `createFilesystemSessionStore({ dir: "<rootDir>/sessions" })`. Required with a custom `backend` (else `SessionStoreRequiredError`). Build with `createBackendSessionStore({ backend, prefix? })` for S3-style storage or `createMemorySessionStore()` for ephemeral runs. |
| `systemPrompt` | `string` | Appended after workspace `AGENTS.md`. |
| `checkpointer` | `BaseCheckpointSaver` | Custom-adapter escape hatch; takes precedence over the session store for checkpoint persistence. Defaults to a durable `BackendCheckpointSaver` writing through the session store. Use `MemorySaver` for ephemeral runs. |
| `middleware` | `AgentMiddleware[]` | Extra middleware appended after workflow instrumentation. |
| `onEvent` | `WorkflowEventHandler` | Subscribe to all lifecycle diagnostics; suppresses console output when set. |
| `promptCache` | `PromptCacheOptions` | `{ enabled?, ttl?: "5m" \| "1h" }`. Provider prompt caching for the stable prefix; on by default. Falls back to `settings.prompt_cache`, then `ARCHMAX_PROMPT_CACHE`/`_TTL`. |
| `pricing` | `PricingTable` | USD per 1M tokens, keyed by model id (`default` matches any): `{ input?, output?, cacheRead?, cacheWrite? }`. Looked up by the id the response reported, else the id the runtime was configured to run — so a keyed table prices a workload behind a proxy that echoes no model back. Input rate applies to the input tokens the cache did not serve. Makes `costUsd` appear on usage events, run metadata, and the CLI footer. Falls back to `ARCHMAX_PRICE_*`. Unpriced → tokens only. |

Fails closed: throws `WorkflowLoadError` if the named workflow's `workflow.yaml`
is missing or has no valid machine spec (never silently runs ungoverned; a
`WORKFLOW.md` carrying frontmatter with no `workflow.yaml` — the removed
single-file layout — is a load error with migration guidance).

## Agent

```ts
interface Agent {
  graph: /* LangGraph runnable */;
  workflow: string;
  runtimeContract: ResolvedRuntimeContract;
  resolveTrigger(trigger?: TriggerInput): ResolvedTrigger;
  emitRunArtifacts(sessionId: string, trajectory: Trajectory): Promise<string | null>;
  runs: {                                // run handles over the configured session store
    list(): Promise<SessionSummary[]>;    // [] when the store/checkpointer can't list
    get(sessionId: string): Promise<SessionSummary | null>;
    delete(sessionId: string): Promise<boolean>;  // throws SessionStoreCapabilityError
  };
  decide(sessionId: string, resolution: DecisionResolution): Promise<DecideOutcome>;
  dispose(sessionId: string): void;
}
```

## Running a workflow

```ts
import { createAgent, WORKFLOW_STATUSES } from "@archmax-ai/harness";

const agent = await createAgent({ workflow, onEvent, workspace: { rootDir } });
const sessionId = `run-${runId}`;

try {
  const result = await agent.invoke(
    { messages: [{ role: "user", content: prompt }] },
    { configurable: { thread_id: sessionId }, recursionLimit: 50 },
  );
  // result: { messages, status?, workflowState?, pendingDecision? }
  if (result.status === WORKFLOW_STATUSES.awaitingDecision) {
    // parked — see Human-in-the-loop
  } else {
    return lastAssistantText(result.messages);
  }
} finally {
  agent.dispose(sessionId);   // cleans up sandbox/PTC state for the session
}
```

Use `agent.stream(...)` instead of `invoke` when you want to record a
trajectory or push incremental updates.

`lastAssistantText` walks `result.messages` from the end and returns the last
assistant/AI message's text.

## Multi-turn conversations (chat history)

`agent.invoke` accepts an **array of role-tagged messages**, not just one user
string — the `messages` channel is a LangChain `add_messages` channel, so
whatever you pass is appended to the session's transcript. There is no need to
concatenate a prior chat into one giant user prompt; give the model real turns.

**Preferred — session persistence.** Sessions are durable by default (the
`BackendCheckpointSaver` writes each turn to the session store). Drive a live
conversation by re-invoking the **same `thread_id`** once per user message,
sending only the new message each time — prior turns are already in the
checkpoint:

```ts
// turn 1
await agent.invoke(
  { messages: [{ role: "user", content: "Look up order 1234" }] },
  { configurable: { thread_id: "chat-42" }, recursionLimit: 50 },
);
// turn 2 — SAME thread_id; only the new message
await agent.invoke(
  { messages: [{ role: "user", content: "And when did it ship?" }] },
  { configurable: { thread_id: "chat-42" }, recursionLimit: 50 },
);
```

The `init` state re-runs on each turn, resetting `workflowState` to the trigger's
start state while **preserving the accumulated messages** — exactly right for
chat: each user message re-enters the workflow with full history retained.

**Alternative — seed prior history on the first invoke.** When the transcript
lives in your own store (not a harness session), pass it as the initial `messages`
array with the newest user turn last:

```ts
await agent.invoke(
  {
    messages: [
      { role: "user", content: "Test" },
      { role: "assistant", content: "Test complete…" },
      { role: "user", content: "who are you?" },
      { role: "assistant", content: "I'm an agent that…" },
      { role: "user", content: "what was my first message?" }, // the new turn
    ],
  },
  { configurable: { thread_id: "chat-42" }, recursionLimit: 50 },
);
```

Gotchas:

- **A hook reads the transcript from `messages`, newest last.** A hook that keys
  off "the current request" should take the *last* `user` entry, not the first —
  the first is the message that opened the session. (A grading rubric still
  receives the compact `userRequest`/`history` payload its rubric is written
  against; there `userRequest` is the *first* user message.)
- **A definition edit is adopted, not refused.** A session takes its next turn
  under the `workflow.yaml` in force now; the recorded `specHash` says which
  definition each turn ran under but gates nothing. A turn positioned in a state
  the edit removed reopens at its trigger's entry state rather than failing.
- **Seed assistant turns as text only.** Don't fabricate dangling `tool_calls`
  in seeded history, or the provider may reject the turn.
- **Not every message in a session's transcript is a person's.** The runtime
  writes **runtime notes** of its own — `[decision]`, `[event]`, `[error]`,
  `[after]`, `[sub-workflow: …]` — carried as a synthetic `archmax_note` tool call
  and its result, so a model cannot read them as a person speaking. Ask
  `isRuntimeNote(message)` / `runtimeNoteKind(message)` rather than inferring
  authorship from role or a `[bracket]` prefix: a turn's lower bound is a human
  message **or** a note, and a transcript renderer should draw a note as a
  runtime line, not as the user's own bubble. The one message a person really
  sends into a running session — a reply to a run parked at a human state — is an
  ordinary human message with no marker.

```ts
import { isRuntimeNote, runtimeNoteKind } from "@archmax-ai/harness";

const opensTurn = (m: unknown) => isRuntimeNote(m) || m.role === "user";
const label = (m: unknown) => runtimeNoteKind(m); // "decision" | "event" | … | null
```

## Human-in-the-loop

```ts
if (result.status === WORKFLOW_STATUSES.awaitingDecision && result.pendingDecision) {
  const { state, transitions, evidence } = result.pendingDecision;
  // Present `transitions` (each { to, description?, type? }) + evidence to a human.
  // `evidence` is the state's declared paths followed by whatever the advancing
  // agent attached via `archmax_advance({ evidence })` — one merged list, no
  // host-side assembly, and no need to re-read the spec.
  // When they pick:
  const outcome = await agent.workflow.decide(sessionId, { target: chosenTo, comment });
  // DecideOutcome: { status?, workflowState?, reparked, state?, reply, rejected?, messages }
  // `rejected` says why when status is "rejected"; Outcome from send() carries it too.
  if (outcome.reparked) { /* parked again at another human state */ }
}
```

`decide` throws `SessionNotParkedError` if the session isn't awaiting a decision, and
`InvalidDecisionTargetError` if `target` isn't a declared transition of the parked
state. `sessions.list()` enumerates durable sessions (empty with a `MemorySaver` or a non-listable session store).

## Event-in-the-loop: a run that parked itself

The agent can park the run with `archmax_wait({ reason })` — in any state, terminal
ones included — when the work cannot continue without something from outside. The
session's status becomes `awaiting_input` (classified **open**, never finished) and
`result.pendingInput` carries `{ state, title?, reason, parkedAt }`: the state it
stopped in and, in its own words, what it is waiting for.

```ts
if (result.status === WORKFLOW_STATUSES.awaitingInput && result.pendingInput) {
  const { state, reason } = result.pendingInput;   // show "waiting in <state>: <reason>"
}

// When the event arrives, deliver it. The run continues in the state it parked in;
// the trigger id becomes its current trigger and the variables arrive locked.
const outcome = await agent.workflow.deliver(sessionId, {
  trigger: { id: "email_reply" },
  variables: { reply_body: "It's ORD-1001." },
});
// DeliverOutcome: DecideOutcome + { variables, parkedChannel? }
if (outcome.reparked) { /* parked again — outcome.parkedChannel says which channel */ }
```

### Waking a scheduled park

A park may declare when it wants to be resumed (`archmax_wait({ reason, until: "1d" })`),
which lands on the record, the summary, and the park event as an absolute
`resumeAt`. **The SDK schedules nothing** — no timer, no cron — so this is your
job, and it is a query:

```ts
const now = new Date().toISOString();
for (const t of await agent.sessions.list()) {
  if (t.status === WORKFLOW_STATUSES.awaitingInput && t.resumeAt && t.resumeAt <= now) {
    await agent.workflow.deliver(t.sessionId, { trigger: { id: "timer" }, variables: { now } });
  }
}
```

A duplicate firing is safe: `deliver` refuses a session that is no longer parked. A
`resumeAt` gates nothing — an event arriving earlier resumes the park normally — and
a state that polls can cap its own retry loop with `budget.maxParks`, whose overrun
routes through the state's `on_error`.

`deliver` throws `SessionNotAwaitingInputError` if the session isn't parked awaiting
an event and `MissingDeliveryTriggerError` if no id is supplied. The id is
**recorded, never matched**: any trigger resumes a park, so there is no awaited-id
list to check against — an id no state declares is deliverable exactly like a
declared one. `resolveSession({ trigger, variables })` tells you which of
the two a firing is — a `turn` to invoke, or a `resume` to deliver into — always on
the conversation's own id.

An event that must **never start** a run is therefore declared nowhere in the spec:
every trigger a state declares starts a session at that state. Name the session
yourself — `send(sessionId, { delivery })` / `deliver(sessionId, …)` — or pass
`sessionPath` with the firing (`resolveSession({ trigger, variables, sessionPath })`)
and let the runtime read the id out of the firing's own variables. A firing that
names neither, on a trigger no state declares, throws
`UnknownSessionTriggerError`: there is nowhere for it to go.

One turn per invoke, on **one** session. A finished session re-invoked with a new
message takes its next turn on the same id, continuing in the state the previous
turn ended in — the position, variables, transcript and files are already there, so
**never seed a previous transcript into the `messages` channel**. Pass only the new
message.

The runtime does not reposition a later turn, so nothing is injected into the
transcript to explain a jump. When a turn needs a path the current state cannot
reach, the agent calls `archmax_reset` to return to the state the conversation began
in (available in every state). To continue *mid-state* instead — inside the state
that stopped, with the arrival in its transcript — the turn must park rather than
finish.

## Exposing a workflow to outside callers

A workflow's trigger signature (`requires`/`returns`, optionally typed) is the
contract the runtime already enforces at the session boundary. A host that
exposes a workflow as an MCP tool, an OpenAPI operation or a typed start form
builds its schema **from that signature**, with the helpers on the browser-safe
`@archmax-ai/harness/spec` subpath (also on the root, as the same bindings), so
the published contract and the enforced one cannot drift:

```ts
import {
  parseMachineSpec,
  signatureForTrigger,
  signatureJsonSchema,
  signatureValueIssues,
} from "@archmax-ai/harness/spec";

const parsed = parseMachineSpec(yaml.parse(workflowYaml));
if (!parsed.ok) throw new Error(parsed.issues.map((i) => `${i.path}: ${i.message}`).join("\n"));
const signature = signatureForTrigger(parsed.spec, "manual"); // { description?, requires, returns }

// MCP tool (or an OpenAPI request/response body): the same mapping the delegation tool uses.
const mcpTool = {
  name: "refund-order",
  description: signature?.description,                 // caller-facing; never shown to the session's agent
  inputSchema: signatureJsonSchema(signature?.requires ?? []),
  outputSchema: signatureJsonSchema(signature?.returns ?? []),
};

// On a request, before any session opens: the rule the turn boundary applies.
const issues = signatureValueIssues(signature?.requires ?? [], body);
if (issues.length) return reply(400, issues.map((i) => i.message)); // { kind, name, type?, found?, message }

// A turn needs a message; an MCP call has none of its own, so say what was asked.
const outcome = await agent.workflow!.send(sessionId, { message: "Refund the order.", variables: body });
```

- `signatureJsonSchema(entries)` → `{ type: "object", properties, required }`:
  one property per entry in declaration order, every name required,
  `date`/`date-time` as `{ type: "string", format }`, an untyped entry as `{}`,
  an entry's `description` carried over. It adds no `additionalProperties`; set
  it for your own ingress.
- `signatureValueIssues(entries, values)` → one issue per missing name and per
  non-conforming value; `[]` means the turn boundary will not refuse the map for
  its signature. It **never coerces**: a form that collects text converts
  `"4"` to `4` before it validates or seeds.
- A trigger's `description` is written for the caller. Use it as the MCP tool
  or operation description. The session's own model never sees it.
- A host that reads specs itself must read `requires`/`returns` through
  `normalizeSignature` (both spellings → `{ name, type?, description? }[]`),
  never as `string[]`: an entry may be an object. Hosts must be on the release
  that introduced typed entries before any workspace they read uses them.

## Lifecycle events

Pass `onEvent`; every `WorkflowLifecycleEvent` carries a `level`
(`info`/`warn`/`error`) plus a typed payload. Map these to a live run UI:

| Event `type` | Meaning |
| --- | --- |
| `state-enter` / `state-leave` | state entered / left (`{ state, next? }`) |
| `advance` | transition committed (`{ from, to, reason?, callId? }` — `callId` names the `archmax_advance` call that drove it; absent on the turn's opening arrival) |
| `hook-start` / `hook-output` / `hook-passed` / `hook-verdict` / `hook-rejected` | lifecycle hook activity + verdict (`ok`/`correct`/`veto`) |
| `parked` / `decided` | human state parked / resolved (`{ state, sessionId, awaiting, to? }` — a human park carries no `callId`, since no call asked for it) |
| `parked` (`awaiting: "input"`) / `delivered` | the agent parked the run (`{ state, sessionId, reason, resumeAt?, callId }` — the `archmax_wait` call) / an event resumed it (`{ state, trigger, to }`, where `to` is the same state) |
| `agent-text` | complete assistant message in a state (`{ state, text, messageId }` — always the id the message is stored under; absent only on a `partial: true` event from a failed turn) |
| `agent-text-delta` | streaming text chunk (`{ state, text, messageId? }`) — flows for every run, even when the graph is driven with `invoke` |
| `tool-called` / `tool-result` / `tool-blocked` | tool passed governance (`callId`, `args`) / settled (`callId`, `status`, `durationMs`, `output` preview) / denied. **Every** governed call, `archmax_advance` included — so a UI drawing a row per call draws one per transition; filter it if you already draw transitions from `advance`/`state-leave`. A tool that **throws** settles `status: "error"` with the error's message as `output` while the turn **continues**: the model reads the same message as the call's answer, and nothing is thrown out of `send` — read tool failures here |
| `rubric-start` / `rubric-result` | grading-rubric dispatch bracketed by `dispatchId`, with the rubric's `name` |
| `model-usage` | per model call provider token usage: `inputTokens` (the total, of which the cache counts are a breakdown), `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `model?` (the id the call was priced against), `costUsd?` |
| `prompt-shaping` | assembly-time payload summary: resolved `profile`, prompt-cache mechanism, `withheld` built-ins |
| `skills-loaded`, `hooks-summary`, `graph-topology`, `workflow-reset`, `warning` | assembly-time diagnostics |

For a browser client, forward these over SSE/WebSocket keyed by `sessionId`. To
render a live chat transcript: accumulate `agent-text-delta` into a bubble
keyed by `messageId`, replace it with the final `agent-text` bearing the same
`messageId`, and interleave tool cards from `tool-called`/`tool-result` paired
by `callId` (order everything by `seq`).

Building a **durable record** rather than a live view? The ids join the stream to
the stored messages exactly: `callId` equals the issuing AI message's
`tool_calls[].id` and the settling `ToolMessage.tool_call_id`, and
`agent-text.messageId` equals the assistant message's `id`. Every event a call
*causes* carries that call's id too (`advance`, `parked`, `variables-set`,
`title-set`, and the sub-workflow pair's `toolCallId`), so the events one call
produced group from ids alone — no scanning back to a message boundary. An event
of those types with no `callId` is one the runtime caused, not a call: a turn
opening, a human park, run-start seeding.

`title-set` is the one event carrying a variable's **value** — the reserved
`title`, whenever it changes. `variables-set` still carries names only; the value
rides its own event so that rule needs no exception, and it is safe there because
a title is bounded to one short line by its write check. Indexing a run's title on
your own record is a handler for this event and nothing else — no checkpoint read,
which matters when you install your own checkpointer.

### Reading tokens and cost

Usage figures are the **provider's own** (LangChain `usage_metadata`), not
estimates — including how many input tokens were served from the prompt cache.
Use the exported tracker instead of summing events yourself:

```ts
import { createAgent, createUsageTracker } from "@archmax-ai/harness";

// Wrap your own subscriber, or omit `onEvent` if you have none.
const usage = createUsageTracker({ onEvent: forwardToClient });
const agent = await createAgent({ onEvent: usage.handler, /* … */ });

await agent.invoke(input, { configurable: { thread_id: sessionId } });

const totals = usage.totals(sessionId);
// { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd? }
usage.bySession();            // Map<sessionId, UsageSummary> for concurrent runs
usage.reset(sessionId);       // drop a finished run's totals
```

Rising `cacheReadTokens` is how you confirm prompt caching is actually working;
`costUsd` is present only when pricing is configured — report tokens rather than a
guessed cost when it is absent. `formatUsage`, `addSummaries`, `emptyUsage` and
`hasUsage` are exported for rendering and combining summaries; the extraction and
pricing internals are not part of the public surface.

### Reading a run's cost

A run's usage is **checkpointed**, so a session handle answers it for a run that
parked and resumed — including in another process:

```ts
const summary = await agent.sessions.get(sessionId);
summary?.usage;
// { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd? }
```

`costUsd` appears only when pricing is configured; without it, tokens are
reported and cost is omitted, never guessed. A parked run reports what it has
spent so far and keeps accumulating on resume. The same totals land in
`sessions/<sessionId>/artifacts/metadata.json` as `usage`, and `createUsageTracker()`
gives the same figure live in process.

### Measuring anything else — fold the stream

The SDK keeps no metrics ledger. Tool calls, governance refusals, the path a run
took, corrections and vetoes, rubric dispatches, and how long a session
sat waiting for a person are all already on the typed event stream, and a backend
counts what it needs:

```ts
const tally = { toolCalls: 0, toolBlocks: 0, path: [] as string[] };
const agent = await createAgent({
  onEvent: (e) => {
    forwardToClient(e);
    if (e.type === "tool-called") tally.toolCalls++;
    if (e.type === "tool-blocked") tally.toolBlocks++;
    if (e.type === "state-enter") tally.path.push(e.state);
  },
  /* … */
});
```

Two properties make this the right home for it: the events are the ones the
runtime acts on, so a fold cannot drift from behavior the way a parallel ledger
can; and a backend counts what it cares about — a per-tenant tool budget, a
per-state SLA — rather than what the SDK guessed.

A fold is a **live view**: it sees only events this process observed. Cost is the
deliberate exception, because it is checkpointed.

## Session artifacts

Each run persists under its own folder in the session store — which is also the
agent's workspace root for that run (`sessions/<sessionId>/` on the filesystem default):

```
sessions/<sessionId>/
  checkpoints/               # LangGraph checkpoint records (durable resume; also
                             # the sole record of a parked human decision)
  scratchpad/                # the run's working area — intermediate files AND the
                             # artifacts a state produces (agent-visible as
                             # `scratchpad/…`; the only such area)
  large_tool_results/        # runtime-offloaded oversized tool results (agent reads only)
  conversation_history/      # runtime-offloaded history (agent reads only)
  artifacts/
    graph.json               # SerializedGraph (topology; includes mermaid)
    graph.mmd                # Mermaid diagram
    trajectory.json          # Trajectory (per-state messages + tool calls)
    trail.json               # Audit trail (committed transitions + rationale)
    variables.json           # The run's variables: name -> { value, locked }.
                             # `locked` is the attribution: locked = host-established
                             # (variables, a delivery's seeds, the built-in
                             # `trigger`), unlocked = set by the agent. Written for a
                             # governed run; an empty store still writes `{}`.
    metadata.json            # RunMetadata (runtime contract, package version,
                             # specHash, and the run's `usage` summary — tokens
                             # by kind plus costUsd when priced)
```

Schemas:

```ts
interface SerializedGraph {
  nodes: string[];
  edges: { source: string; target: string; conditional: boolean; label?: string }[];
  entry?: string; finals: string[]; mermaid: string;
}
interface Trajectory {
  sessionId?: string; workflow: string; prompt?: string; finalAnswer: string;
  segments: { state: string; enteredState?: string; exitedState?: string;
              items: (MessageItem | ToolCallItem)[] }[];
}
// MessageItem: { kind:"message", role, content }
// ToolCallItem: { kind:"tool_call", name, args, result: string|null }
interface RunMetadata { sessionId: string; workflow: string;
  runtimeContract: ResolvedRuntimeContract; packageVersion: string; }
// trail.json: { sessionId, workflow, steps: TrailStep[] } — the audit trail,
// re-derived from checkpointed state on every artifact write.
// TrailStep: { to, kind: "trigger"|"agent"|"human"|"reset"|"on_error",
//              reason?, ts }
```

An **API** reads these files (through the same session store, or via `runArtifactPaths(sessionId)`
path helpers) to render historical runs: `graph.json`/`graph.mmd` for the diagram,
`trajectory.json` for the step-by-step timeline, `trail.json` for the decision
path (which edges committed, by whom, and why), `variables.json` for the run's
inputs and established facts (also what a test author reads to reproduce a real
firing's payload — see
[hook-and-test-scripts.md](hook-and-test-scripts.md#recovering-a-cases-inputs-from-previous-runs)).
Note it holds whatever the run's variables held, verbatim: a host that must not
persist an input should not seed it. To persist artifacts yourself,
stream the run and call `agent.emitRunArtifacts(sessionId, trajectory)`.

## Model configuration

Env (loaded from the workspace root `.env`, real process env wins):
`ARCHMAX_API_BASE_URL`, `ARCHMAX_API_KEY`, `ARCHMAX_MODEL`, optional
`ARCHMAX_TEMPERATURE`, `ARCHMAX_MAX_TOKENS` — any OpenAI-compatible endpoint.
Or inject a model directly:

```ts
import { ChatOpenAI } from "@langchain/openai";
const model = new ChatOpenAI({
  model: "claude-sonnet-5",
  apiKey: process.env.MY_KEY,
  configuration: { baseURL: "https://api.example.com/v1" },
});
const agent = await createAgent({ model });
```

## Custom backends

`BackendProtocolV2` (from `deepagents`) decouples storage — implement
`readRaw`/`write`/`edit`/`ls` over filesystem, a store, a sandbox, S3, or a remote.
Pass it as `backend` (authored workspace); run state goes through a `sessionStore`
(e.g. `createBackendSessionStore({ backend: s3Backend, prefix: "tenants/a/runs" })`).
A custom `backend` **requires** an explicit `sessionStore` — assembly throws
`SessionStoreRequiredError` instead of inferring storage. The SDK owns the logical
`sessions/<sessionId>/…` namespace; the store owns where it physically lives.
Persisting the session zone off-box (an S3-backed session store) is how you share run
state across a worker fleet and an API.

## Cases against your agent

`runTests` runs a workflow's cases — declarative YAML documents
under `workflows/<name>/tests/*.test.yaml`, interpreted host-side — with the
same discovery, case interpretation, judge, and verdicts `archmax test` uses.
By default it builds its own agent, which is *not* your agent: no connection
tools, no mounts, no session store, no checkpointer — and it reads the suite off
the local filesystem under `rootDir`, which is *not* your authored tree if that
tree lives in a store. Supply both:

```ts
import { runTests, createAgent, createToolMockMiddleware } from "@archmax-ai/harness";

const { results, exitCode } = await runTests({
  workflow,
  rootDir,
  // Where the spec, the case documents and their `from:` fixtures are read
  // from. Omit it only when they really are files under `rootDir`.
  authoring,
  createTarget: async ({ workflow, rootDir, onEvent }) =>
    createAgent({
  workflow,
  onEvent,
  backend,
  tools: await resolveConnectionTools(tenant),
  checkpointer,
  middleware: [createToolMockMiddleware()],
  // REQUIRED — see below,
  workspace: { rootDir, sessionStore },
}),
  sessionIdForCase: (file) => `${hostRunId}/${file}`,
});
```

| Option | Why |
| --- | --- |
| `authoring` | The backend the **suite itself** is read from: the machine spec, `workflows/<name>/tests/*.test.yaml`, and the fixtures their `from:` entries name. The same option `createAgent` takes, and normally the same backend — the agent under test runs the authored tree the cases were read from. Defaults to a filesystem backend over the resolved root, so a host whose authored tree lives in a store and omits it discovers **no cases at all** and gets an empty run rather than a failure. |
| `createTarget` | The agent under test — an already-built runtime, or a factory that builds one. Must be **workflow-governed** — a plain agent is refused before any case runs. In the factory form, `rootDir` in the context is the resolved workspace root. |
| `sessionIdForCase` | Names the *agent* session the case runs on — a case is one conversation on one session (default `test-default-<runId>-<file>`), invoked once per case file — so its checkpoints, `scratchpad/…` files, and token usage join your own run record. |

**Your target owns its mocks — and the runtime checks.** A case's `mocks:`
list intercepts agent-initiated tool calls through
`createToolMockMiddleware()`, which the default target wires for you.
`createAgent` stamps `capabilities.toolMocks` from the middleware
actually wired; a case that declares mocks against a target without the
capability **fails loudly before the agent runs**, naming the fix — never run
with partial interception (scripts' PTC calls mocked, the agent's own calls
real). A bespoke target that intercepts by other means sets
`capabilities.toolMocks` itself. Mockless cases run against any
workflow-governed target.

**Sub-workflows inherit the assembly.** When a workflow delegates (by advancing
an `archmax_workflow_<slug>` tool), the child runtime is
composed from the *same* resolved inputs as the parent — model and
`modelFactory`, `backend` and `mounts`, `sessionStore` and `checkpointer`, host
`tools` and `essentialTools`, `sandboxRuntime`, `hookExecutors`,
`policyRules`, `promptCache` and `pricing` — differing only in
the machine that governs it and the system prompt that machine renders. So a
custom backend serves the child's spec too, and a `modelFactory` supplies its
model. Composition is **lazy and memoized per workflow slug**: a workflow that is
never delegated to is never loaded, and one delegated from many places is
composed once. A child whose spec is broken surfaces as a *dispatch* failure, not
an assembly failure — a parent still assembles.

The child runs on the parent's **session id** (which is what gives it the same
run zone) under a nested checkpoint namespace, so `sessions.list()` reports one
session and the parent session's metrics include the child's tokens.
`capabilities.subWorkflows` is stamped `true` for a governed assembly and `false`
for the plain one.

Omit both options and behavior is identical to `archmax test`. Cases run
sequentially (`tests.maxConcurrency` above 1 is rejected, not silently
serialized) and there is no cancellation signal: call `runTests` once per file
(`filter`) if you need to interrupt between cases; a single case is bounded by
`tests.caseTimeoutMs`.

## Suggested split

- **Worker**: `createAgent` + `agent.invoke`/`stream`; `agent.workflow.decide` for
  approvals. Owns execution and the durable session store/checkpointer.
- **API**: reads `sessions/<sessionId>/artifacts/*` (shared session store) and/or relays
  the `onEvent` stream; exposes `sessions.list()`, run detail, and a decide endpoint.
- **Frontend**: renders `graph.json`/`graph.mmd`, the `trajectory.json` timeline,
  the `variables.json` inputs, and the live event stream; posts human decisions
  back to the API.

Keep the heavy runtime import (LangChain/LangGraph) in the worker; the API/frontend
only need the artifact/event *types*, which ship in `dist/index.d.ts`.
