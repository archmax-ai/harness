# Wiring the harness into a backend

Load this when you embed `@archmax-ai/harness` in a service: a worker that sends turns,
an API that answers parked sessions, a frontend that draws them. Every name here is an
export of the installed package. When in doubt, check its `dist/index.d.ts`.

## Contents

- [Install](#install)
- [The smallest program](#the-smallest-program)
- [`createAgent` options](#createagent-options)
- [Models](#models)
- [Outcomes and parked sessions](#outcomes-and-parked-sessions)
- [Events](#events)
- [Sessions, storage and artifacts](#sessions-storage-and-artifacts)
- [Host tools that use the workspace](#host-tools-that-use-the-workspace)
- [Exposing a workflow to callers](#exposing-a-workflow-to-callers)
- [Cases against your agent](#cases-against-your-agent)
- [Sub-workflows in a service](#sub-workflows-in-a-service)
- [A typical split](#a-typical-split)

## Install

Install `@archmax-ai/harness`, plus `langchain` and `zod` to write host tools. It needs
Node 22 or later. Before a release is published, `npm pack` the harness and install the
tarball: a real copy behaves like production, and a symlink does not.

This skill ships inside the package. `BUNDLED_AUTHORING_SKILL_DIR` is the directory that
holds it (`<dir>/archmax-harness/SKILL.md`), and
`npx skills add ./node_modules/@archmax-ai/harness` installs the copy that matches the
installed version.

## The smallest program

[`examples/refund/`](https://github.com/archmax-ai/harness/tree/main/examples/refund)
runs a four-state workflow with two host tools. A host tool is an ordinary LangChain
tool, built with `tool(fn, { name, description, schema })` from `langchain`, and a state
grants it in `tools.allow`. The program, `index.js`:

```js
import { createAgent } from "@archmax-ai/harness";
import { lookupCustomer, sendEmail } from "./tools.js";

const agent = await createAgent({
  workflow: "refund",                           // workflows/refund/
  tools: [lookupCustomer, sendEmail],           // host tools
  workspace: { rootDir: import.meta.dirname },  // sessions are stored under sessions/
});

const outcome = await agent.workflow.send("ticket-1001", {
  message: "Hi, I'd like a refund for my last order.",
  variables: { email: "ann@example.com" },      // the trigger's requires, seeded locked
});
console.log(outcome.kind); // "completed"
```

- One `send` is one turn. The session id is yours to choose (a ticket, a conversation).
  `send` with the same id continues the session, and each turn carries only the new
  message: the session already holds the transcript.
- `send` works out what the session needs: a new turn for a new or finished session, a
  reply for one parked at a human state, a delivery for one parked with `archmax_wait`.
- In TypeScript, `agent.workflow` is `undefined` on an ungoverned agent: narrow it
  before you call it.

## `createAgent` options

Deep Agents' own options keep their names: `model`, `tools`, `systemPrompt`,
`middleware`, `backend`, `checkpointer`, `store`, `skills`, `interruptOn`, `name`,
`description`. The harness adds:

| Option | What it does |
| --- | --- |
| `workflow` | The workflow's slug under `workflows/`. When omitted, the default workflow governs the agent if it exists; `false` assembles a plain Deep Agent. |
| `workspace` | `{ rootDir, mounts?, sessionStore? }`. `rootDir` defaults to the current directory. |
| `authoring` | The backend that serves `workflows/**` (specs, `WORKFLOW.md`, code-state scripts, cases) to the runtime only. It defaults to `backend`, else the files under `rootDir`. Exposing it through a writable mount throws `AuthoringBackendExposedError`. |
| `trigger`, `variables`, `sessionPath` | The default trigger, seeded variables (locked) and session path for turns. |
| `modelFactory` | `(role, env, requested?) => model`, called per role: `agent`, `judge` (a case's `grade`) and `grader` (a grader state, asked with the state's model id). |
| `essentialTools` | Host tools that are on in every state, whatever `allow_always` says. A state's entry still narrows one. |
| `toolPaths` | Each host tool's path arguments and how it uses them (`{ get_markdown: { path: "read" } }`), governed like a built-in tool's. |
| `images` | Shows a vision model the images it reads with `read_file`. Off by default. |
| `policyRules`, `sandboxRuntime` | Extra governance rules, and a custom sandbox runtime. |
| `onEvent` | Receives the event stream, in place of the console subscriber. |
| `promptCache` | `{ enabled, ttl: "5m" \| "1h" }`, on by default. |
| `pricing` | USD per million tokens by model id (`{ input, output, cacheRead, cacheWrite }`; `default` matches any id). Without it, usage reports tokens and no cost. |
| `clock` | Pins "now" for cases. Not for production. |

Assembly fails closed. A missing or invalid spec throws `WorkflowLoadError`, a custom
`backend` without a `sessionStore` throws `SessionStoreRequiredError`, and a host tool
named `archmax_*`, or after a file operation, throws `ReservedToolNameError`.

## Models

By default the model comes from the environment, for any OpenAI-compatible endpoint:
`ARCHMAX_API_BASE_URL`, `ARCHMAX_API_KEY` and `ARCHMAX_MODEL`, optionally
`ARCHMAX_TEMPERATURE`, `ARCHMAX_MAX_TOKENS` and `ARCHMAX_STREAMING`. They are read from
the workspace's `.env`, and the process environment wins.

Pass `model` to use your own instance; it then outranks every model id a spec declares.
Pass `modelFactory` instead to honour those ids, and to put grader states on their own
model, as the service below does.

## Outcomes and parked sessions

`send`, `decide`, `reply` and `deliver` each settle one turn and return what it did:

| Field | Meaning |
| --- | --- |
| `kind` | `completed`; `parked` (waiting on a person or an event); `failed` (the agent, a grader or a code state called `archmax_raise`, or the turn threw); `rejected` (governance ended it). |
| `exit` | `{ success: true }` when completed, `{ success: false, code, reason }` when failed. |
| `reply` | Everything the agent said this turn, in order; `""` when it said nothing. |
| `state`, `parkedChannel`, `pending` | Where the session is. For a park: `"decision"` or `"input"`, and the park record. |
| `rejected` | Why, when the outcome is `rejected`. |
| `delegation` | When a sub-workflow child is the one parked: which child, and which call. |
| `auditTrail`, `variables`, `usage`, `messages` | The trail, the variables, the cumulative usage and the transcript. |

A host that reads "not rejected" as success must check for `failed` too.

A service that waits for people:

```ts
import { createAgent, createChatModel, createUsageTracker } from "@archmax-ai/harness";

const usage = createUsageTracker({ onEvent: publish });   // publish: your event fan-out
const agent = await createAgent({
  workflow: "order-lookup",
  workspace: { rootDir },
  tools: hostTools,
  onEvent: usage.handler,
  modelFactory: (role, env, requested) =>
    role === "grader" ? graderModel : createChatModel({ ...env(), model: requested ?? env().model }),
});
const flow = agent.workflow!;

const outcome = await flow.send(sessionId, { message });
if (outcome.kind === "parked" && outcome.parkedChannel === "decision") {
  // outcome.pending.transitions: [{ to, description, type }], one button each
  await flow.decide(sessionId, { target: chosen.to, comment });
}
usage.totals(sessionId);   // tokens, plus costUsd when pricing is set
agent.dispose(sessionId);  // frees the session's in-memory resources
```

- **`decide(sessionId, { target, comment? })`** moves a session parked at a human state
  along the chosen transition. It throws `SessionNotParkedError` when the session awaits
  no decision, and `InvalidDecisionTargetError` for a target that is not one of the
  state's transitions.
- **`reply(sessionId, message)`** answers a person who writes to a parked session. The
  session stays parked.
- **`deliver(sessionId, { trigger: { id }, variables? })`** continues a session parked
  with `archmax_wait`, in the state that parked, with the variables locked. Any trigger
  id continues a park. It throws `SessionNotAwaitingInputError` when nothing waits.
- **The same operations** are payloads of `send`: `{ decision }` and `{ delivery }`.
- **Scheduled parks.** A park with `until` carries `resumeAt`. The harness schedules
  nothing: your scheduler lists `agent.sessions.list()`, picks the parks whose
  `resumeAt` has passed, and delivers to them. A duplicate delivery is refused.
- **`resolveSession({ trigger, variables, sessionPath? })`** says which session a
  trigger's arrival belongs to, and whether it is a turn or a delivery, without sending
  it.
- **Files.** `send(id, { message, files: { invoice: { name, content } } })` places the
  bytes under the session's `scratchpad/attachments/` and seeds `invoice`, locked, with
  the path: what a `file` input takes.
- **A turn that throws** (a provider failure, a cancellation, the recursion limit)
  rejects with the error, and the session ends `failed` with `turn-error`,
  `turn-cancelled` or `recursion-limit`. The `recursionLimit` is 400 unless your config
  sets one; `send`'s third argument merges into the invoke config. Cancel a turn with an
  `AbortSignal` passed as `{ signal }`: its scripts stop with it. `dispose` in a
  `finally` is always safe.

## Events

`onEvent` receives one typed stream, `WorkflowLifecycleEvent`, each event carrying its
`sessionId`:

| Event | Meaning |
| --- | --- |
| `state-enter`, `state-leave`, `advance` | The session's movement. `advance` carries `from`, `to`, `reason` and `callId`. |
| `code-start`, `code-output`, `code-result` | A code state's run: its script, each `console.log` line, its `status` and `reason`. |
| `grader-start`, `grader-result` | A grader state's run. |
| `parked`, `decided`, `delivered`, `raised`, `state-error-routed` | Parks, decisions, deliveries, raises and `on_error` routes. |
| `tool-called`, `tool-result`, `tool-blocked` | Every governed call, `archmax_advance` included, grouped by `callId`. A code state's calls carry `origin: "script"`. |
| `agent-text-delta`, `agent-text` | Streamed text and the complete message, grouped by `messageId`. A grader's tokens never stream. |
| `model-usage` | The provider's token counts per model call (a grader's under its state), with `costUsd` when priced. |
| `variables-set`, `title-set` | Variable writes, by name; the session's `title`, with its value. |
| `sub-workflow-start`, `sub-workflow-result` | A child session's dispatch and its result. |
| `warning`, `skills-loaded`, `graph-topology`, `prompt-shaping` | Diagnostics. |

There is no end-of-turn event: `send` returning is the end. The ids join events to the
stored messages: `callId` is the tool call's id, and `messageId` the message's.

The harness keeps no metrics ledger: count what you need by folding the stream. Cost is
the exception. Usage is checkpointed, so `(await agent.sessions.get(id))?.usage` answers
it for any session.

The runtime writes its own messages into the transcript, as tool-call pairs: runtime
notes such as `[decision]`, `[event]`, `[error]`, `[grader]` and `[code]`. Tell them
apart with `isRuntimeNote(message)` and `runtimeNoteKind(message)`, never by role or by
a bracket prefix.

## Sessions, storage and artifacts

- **Sessions** are durable by default, under `<rootDir>/sessions/<id>/`.
  `agent.sessions.list()`, `.get(id)` and `.delete(id)` work over the session store.
  Delete through them, never through the file system.
- **Session stores**: `createFilesystemSessionStore({ dir })`,
  `createBackendSessionStore({ backend, prefix? })` for S3 or any Deep Agents backend
  (how a worker fleet shares sessions), and `createMemorySessionStore()`. A custom
  `backend` needs an explicit `sessionStore`.
- **Session ids**: a session's files sit at `<id>/<path>` in the store.
  `sessionIdRejection(id)` is the rule every ingress applies. Mint top-level ids without
  `~`, which separates a child session's number (`<parent>~<n>`).
- **Mounts**: `workspace.mounts` is a route table, key → backend or
  `{ backend, readOnly?, governed?, searchable? }`. `defaultMounts(rootDir)` is the
  conventional table (`skills/`, `.platform/`, `AGENTS.md`), and
  `mountSubtree(backend, "skills")` rebases a backend. Mounts are read-only unless
  declared otherwise. `governed: true` hands the spec's `mounts` lists the decision of
  which states reach a mount. A key over a session zone or `workflows/` throws
  `MountCollisionError`. Pass the same table to `validateWorkflow({ mounts })` so that
  validation checks the spec's mount names.
- **Artifacts**: `agent.emitRunArtifacts(sessionId, trajectory)` writes `graph.json`,
  `graph.mmd`, `trajectory.json`, `trail.json`, `variables.json` (each variable with its
  value and lock) and `metadata.json` (the contract, the package version, the
  `specHash` and usage) under `sessions/<id>/artifacts/`. An API reads them to draw past
  sessions.
- **Spec edits** are adopted. The next turn runs under the current `workflow.yaml`, the
  recorded `specHash` says which version a turn ran under (`agent.getSpecSnapshot(hash)`
  returns it), and a session positioned in a removed state reopens at its trigger's
  entry.

## Host tools that use the workspace

`toolsFromMap({ <name>: { description, inputSchema, paths?, handler } })` builds host
tools whose `handler(input, { workspace, sessionId })` reads and writes through the
turn's workspace, bound to the session. Inside a sub-workflow, `sessionId` is the child's.
Declared `paths` (`{ path: "read" }`) are governed like a built-in tool's path
arguments, so a refused call never runs the handler.

## Exposing a workflow to callers

A trigger's signature is the contract the runtime enforces, so build an MCP tool, an API
operation or a start form from it. `@archmax-ai/harness/spec` is browser-safe and holds
the helpers (they are also on the root):

- `parseMachineSpec(raw)` parses a spec; `signatureForTrigger(spec, "manual")` returns
  `{ description?, requires, returns }`.
- `signatureJsonSchema(entries)` returns a JSON Schema object with every name required,
  and `date`, `date-time` and `file` as formatted strings.
- `signatureValueIssues(entries, values)` returns one issue per missing or
  non-conforming value. It never coerces, so convert form text first.
- Use the trigger's `description` as the tool's description: the session never sees it.
  Read `requires` and `returns` through `normalizeSignature`, never as `string[]`.

## Cases against your agent

`runTests` from `@archmax-ai/harness/testing` runs a workflow's cases with the discovery,
judge and verdicts of `archmax test`. By default it builds its own agent, with none of
your tools, mounts or stores. Supply yours:

| Option | Why |
| --- | --- |
| `createTarget` | Your agent, or a factory `({ workflow, rootDir, onEvent }) => agent`. It must be workflow-governed. Wire `createToolMockMiddleware()` into its `middleware`, or a case that declares `mocks:` is refused before it runs. |
| `authoring` | Where the spec, the cases and their fixtures are read. When omitted, they are read from files under `rootDir`, so a workspace kept in a store finds no cases. |
| `sessionIdForCase` | The session id each case runs on, so its files and usage join your records. |

Cases run one at a time, and `tests.caseTimeoutMs` bounds each.

## Sub-workflows in a service

A child session is composed from its caller's inputs: the model and `modelFactory`, the
backend and mounts, the session store and checkpointer, the host tools, the policy
rules, the prompt cache and the pricing. Composition is lazy, per slug, so a child
whose spec is broken fails its dispatch, not the assembly. The child is its own session
(`<parent>~<n>`) in the same store, listed by `sessions.list()` with `parentSessionId`.

## A typical split

- **Worker**: `createAgent` and `send`. It owns the session store.
- **API**: reads artifacts from the shared session store, relays `onEvent`, and exposes
  `sessions.list()`, a session's detail and a decide endpoint.
- **Frontend**: draws `graph.json`, the trail and the live stream, and posts decisions to
  the API. It needs only the types, which ship in `dist/index.d.ts`.
