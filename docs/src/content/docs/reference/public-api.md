---
title: Public API
description: createAgent, the Agent surface, session storage (sessionStore), and the extension options (modelFactory, hookExecutors, policyRules, sandboxRuntime).
sidebar:
  order: 5
---

## The complete public surface

This is the whole of `@archmax-ai/harness`. A symbol not listed here is internal and may
change without a major version. A unit test checks the barrel and this page
against each other, in both directions, so the two cannot drift.

Adjacent surfaces live on their own subpaths, so a production import stays
scoped to what it needs:

| Subpath | What it holds |
| --- | --- |
| **`@archmax-ai/harness/testing`** | the case engine |
| **`@archmax-ai/harness/cli`** | the state-flow renderer and styling |
| **`@archmax-ai/harness/sandbox`** | hook and script authoring |
| **`@archmax-ai/harness/spec`** | the `workflow.yaml` schema, the pure validator and the grammars |
| **`@archmax-ai/harness/messages`** | transcript readers |

The last two are **light**: they mirror part of the root and leave the runtime
behind, so they are safe to bundle for a browser. A unit test walks each one's
import graph on every run. A name carried by both the root and a light subpath
is the same binding, and each light subpath has its own section below.

### Assembly

`createAgent` `ArchmaxAgent`

### Errors

`WorkflowLoadError` `WorkflowDisabledError` `UnknownTriggerError` `ReservedToolNameError` `InvalidVariableNameError` `MountCollisionError` `SessionStoreRequiredError` `SessionStoreIdError` `SessionStoreCapabilityError` `AuthoringBackendExposedError` `WorkspaceRootRequiredError` `UnsupportedRuntimeContractError` `SessionNotParkedError` `InvalidDecisionTargetError` `EmptyMessageError` `SessionNotAwaitingInputError` `MissingDeliveryTriggerError` `SessionNotResumableError`

### Workspace composition

`defaultMounts` `mountSubtree` `createFilesystemSessionStore` `createBackendSessionStore` `createMemorySessionStore` `isReservedRootName` `sessionIdRejection` `isChildSessionOf` `createWorkspaceContext` `PLATFORM_PROMPT_PATH` `classifyWorkspacePath` `WorkspaceZone`

### Sessions and parks

Every resume reads a parked session through these three:

| | |
| --- | --- |
| `readParkedSession` | requires the checkpointed status *and* a live suspension |
| `pendingParkOf` | finds the park record on either channel |
| `parkedStateOf` | reads the state a record names |

### Prompt and message plumbing

`resolveSystemPrompt` `toolsFromMap` `contentToString` `isAiMessage` `isRuntimeNote` `runtimeNoteKind` `lastAgentText` `RuntimeNoteKind` `RubricDeclaration` `SpecMetadata` `parseCodeDescription`

### The machine

`loadMachineSpec` `WorkflowMachine` `validateWorkflow` `normalizeHooks` `DEFAULT_SUB_WORKFLOW_DEPTH` `DEFAULT_SUB_WORKFLOW_CONCURRENCY`

### Names a host must not hard-code

`MANUAL_TRIGGER` `DEFAULT_WORKFLOW` `DEFAULT_TRIGGER_ID` `sessionIdForTrigger` `WORKFLOW_TOOL_PREFIX` `workflowToolName` `workflowSlugFromToolName`

### Token accounting

`createUsageTracker` `formatUsage`

### Environment

`createChatModel` `BUNDLED_AUTHORING_SKILL_DIR` `PACKAGE_VERSION`

`BUNDLED_AUTHORING_SKILL_DIR` is the directory that holds the bundled authoring
skill. Installed, that is `dist/authoring-skill`, with the skill itself at
`archmax-harness/SKILL.md` beneath it. A repo checkout falls back to the top-level
`skills/` directory.

### Types

Every type the barrel exports. A type reachable from a public signature is itself
public, because an exported function is usable only when you can name what it
returns.

`Agent` `AgentWorkspaceParams` `CreateAgentParams` `DecideOutcome` `DecisionResolution` `DelegatedPark` `DeliverOutcome` `Diagnostic` `GovernanceRule` `IntrospectableStateGraph` `MachineSpec` `MachineState` `MountPrefixes` `MountSpec` `Outcome` `PendingDecision` `PendingInput` `PricingTable` `ReplyOutcome` `ResolvedRuntimeContract` `ResolvedSession` `ResolvedTrigger` `ResolveSessionInput` `ResumePayload` `RuntimeContract` `SendInput` `SessionOperations` `SessionStore` `SessionSummary` `TriggerDelivery` `TriggerInput` `TurnInput` `UsageSummary` `ValidationResult` `WorkflowEventHandler` `WorkflowLifecycleEvent` `WorkflowSurface` `WorkspaceContext`

## `@archmax-ai/harness/spec`

The workflow vocabulary on its own, with **no runtime behind it**: the
`workflow.yaml` schema, a pure validator, and the slug, variable, session-path and
reserved-name grammars. It is browser-safe by construction, for the reasons in
the notes below.

Several of these names are also on the root. They are the same bindings, exported
here for the weight of the import.

- **The schema:** `machineSpecSchema` `machineStateSchema` `triggerDeclarationSchema` `stateTriggersSchema` `machineTransitionSchema` `transitionTypeSchema` `stateTypeSchema` `stateBudgetSchema` `allowEntrySchema` `forbidEntrySchema` `FORBID_ANY_TOOL` `toolsBlockSchema` `skillsBlockSchema` `mountAccessSchema` `mountGrantEntrySchema` `mountsBlockSchema` `workflowMountsConfigSchema` `hookSchema` `hookSpecSchema` `rubricDeclarationSchema` `workflowToolsConfigSchema` `workflowSkillsConfigSchema` `machineSettingsSchema` `machinePromptCacheSettingsSchema` `workflowTestsConfigSchema` `runtimeMetadataSchema` `specExtensionsSchema` `specMetadataSchema` `parseMachineSpec` `refineSpec` `specDisabled`. Types: `MachineSpec` `MachineState` `MachineTransition` `TransitionType` `Hook` `HookSpec` `StateBudget` `AllowEntry` `ForbidEntry` `ToolsBlock` `SkillsBlock` `MountAccess` `MountGrantEntry` `MountsBlock` `WorkflowMountsConfig` `StateType` `WorkflowToolsConfig` `WorkflowSkillsConfig` `MachineSettings` `MachinePromptCacheSettings` `WorkflowTestsConfig` `RuntimeMetadata` `TriggerDeclaration` `SpecExtensions` `SpecMetadata` `RubricDeclaration` `SpecSchemaIssue`.
- **Validation:** `validateSpec` `lintSpec` `schemaIssueDiagnostic` `SpecValidation` `Diagnostic` `DiagnosticSeverity`.
- **Mount grants and hooks:** `normalizeMountGrants` `NormalizedMountGrant` `mountNameOf` `mountNameOfPattern` `normalizeHooks` `hookKind` `hookValue` `HOOK_SIDECAR_KEYS`.
- **Slugs, triggers and variables:** `SLUG_PATTERN` `isSlug` `MANUAL_TRIGGER` `DEFAULT_TRIGGER_ID` `parseSessionPath` `resolveSessionId` `sessionIdForTrigger` `triggerBindings` `stateTriggerIds` `declaredVariableNames` `SessionPath` `SessionPathParse` `TriggerBinding` `TriggerInput` `ResolvedTrigger` `VARIABLE_NAME_PATTERN` `TRIGGER_VARIABLE` `TITLE_VARIABLE` `TITLE_MAX_LENGTH` `hasVariableReference` `parseReferences` `referenceError` `resolvePath` `resolveText` `VariableReference` `VariableStore` `VariableEntry`.
- **Tool names and delegation bounds:** `ARCHMAX_TOOL_PREFIX` `ADVANCE_TOOL` `RESET_TOOL` `WAIT_TOOL` `EVAL_TOOL` `RUN_TOOL` `GET_VARIABLES_TOOL` `SET_VARIABLES_TOOL` `NOTE_TOOL` `WORKFLOW_TOOL_PREFIX` `workflowToolName` `workflowSlugFromToolName` `isWorkflowToolName` `isReservedToolName` `HARNESS_CONTROL_TOOLS` `ALWAYS_ALLOWED_TOOLS` `ESSENTIAL_TOOLS` `UNGRANTABLE_TOOLS` `ReservedToolNameError` `DEFAULT_SUB_WORKFLOW_DEPTH` `DEFAULT_SUB_WORKFLOW_CONCURRENCY`.
- **The root namespace:** `SESSION_INTERNAL_DIRS` `SESSION_OFFLOAD_DIRS` `SESSION_OPEN_DIR` `SESSION_AGNOSTIC_PREFIX` `SESSION_AGNOSTIC_PREFIXES` `NO_MOUNTS` `sessionAreaNames` `classifyWorkspacePath` `isReservedRootName` `isSessionAgnosticPath` `AUTHORING_PREFIXES` `isAuthoringPrefix` `authoringPlanePrefix` `describeAuthoringPrefix` `MountPrefixes` `WorkspaceZone` `AuthoringPrefix`.
- **Session ids:** `sessionIdRejection` `SessionStoreIdError` `DEFAULT_SESSIONS_DIR` `isChildSessionOf` `parentSessionIdOf` `childSessionId` `subRunIdentity`.
- **Paths and scripts:** `DEFAULT_WORKFLOW` `HOOKS_DIR` `PLATFORM_PROMPT_PATH` `workflowPaths` `sessionPaths` `resolveHookScript` `parseCodeDescription` `CodeDescription`.

### Using the spec subpath

The whole subpath rests on two bare imports, `zod` and `picomatch`. Everything
else it reaches is source in this package, so `node:*`, LangGraph, Deep Agents,
the sandbox and the filesystem libraries stay out of the graph.

A unit test walks that graph on every run to keep it so, and the walk reaches
past the package boundary: those two libraries are themselves checked for a
`node:*` import or an unguarded `process`. Bundling and *running* in a browser
are different bars, and this subpath is held to the second.

So an editor can bundle it into a page. An API request path that has to parse or
validate a spec imports it and leaves the runtime behind.

**Parse with the schema and pass its output on.** `machineSpecSchema.parse(raw)`
yields a `MachineSpec`, as does `parseMachineSpec(raw)`, which also runs the
document-level cross-references.

Keep SDK schemas out of your own compositions: no `.extend()`, no `.and()`, no
SDK schema inside your `z.object`. The SDK's zod pin moves independently of
yours, and a split between the two shows up at runtime rather than at typecheck.

Host metadata has two homes that pass through intact. One is the three loose
`specMetadataSchema` slots, at the root, on a state and on a rubric. The other is
a trigger declaration's unknown keys.

**Validation.** `validateSpec(value)` says everything the document alone can say:
the shape, the cross-references and the lint, as one `SpecValidation` carrying
`ok`, `spec?`, `schema`, `lint` and `diagnostics`.

It is total. A refused document still yields every issue the schema found,
addressed by `field`, so a blank transition `description` or a misspelled state
key shows inline. The loader runs this same function, which is why an editor and
`archmax validate` always agree about a document.

Whatever needs more than the document is `validateWorkflow` on the root: hook
scripts, sibling workflows, the skill registry, kernel probes.

**Session ids and triggers.** Three groups of names cover a firing:

- `sessionIdRejection` is the rule every ingress applies to an id.
- `isChildSessionOf`, `parentSessionIdOf` and `childSessionId` are the
  `<parent>~<state>:<workflow>:<ordinal>` convention a child session's id follows.
- `sessionIdForTrigger(spec, triggerId, variables)` is the question a host asks
  of a firing. It answers with the session id that trigger's `session:` path
  resolves to, or `undefined` when the runtime would mint one.

Some names stay on the root because they cannot be pure: `loadMachineSpec`,
`WorkflowMachine`, `validateWorkflow`, `resolveTrigger`,
`createWorkspaceContext`, every store and mount.

## `@archmax-ai/harness/messages`

Reading a transcript without the runtime. The root exports the readers a governed
host needs most. They are the same bindings here.

`contentToString` `messageTypeOf` `isAiMessage` `isHumanMessage` `isRuntimeNote`
`runtimeNoteKind` `lastAgentText` `opensTurn` `messagesSince` `lastTurn`
`RuntimeNoteKind`

### Using the messages subpath

Every reader is duck-typed over the shapes a message takes: a LangChain class
instance, a checkpoint's serialized form, a raw `{ role, content }`. The module
imports nothing at all, so an API request path that renders or slices a
transcript stays clear of LangGraph.

- **`lastAgentText(messages)`** is the last thing the agent said to the person.
  Tool results and the runtime's own notes are skipped.
- **`messagesSince(messages, cursor)`** slices what one turn appended. Read
  `await agent.sessions.messageCount(sessionId)` before the turn and hand it back
  afterwards. Seeds, notes and all are counted for you.
- **`lastTurn(messages)`** is the trailing turn: from the last thing the session
  was told to the end. What it was told is a person's message or a runtime note.
  A delivered firing is a note pair followed by the person's message, so an
  adjacent run of openers counts as one. A child's result note lands mid-turn and
  opens a reply window of its own, so prefer the cursor when you want everything
  one invocation added.

## Reading a transcript

`isRuntimeNote` / `runtimeNoteKind` answer *who wrote this transcript message*.
The runtime writes messages of its own into a session's transcript, in six kinds:

| Kind | What it records |
| --- | --- |
| `decision` | a human decision at a human state |
| `event` | a delivered trigger firing |
| `error` | an `on_error` route |
| `after` | a completion check asking for a revision |
| `sub-workflow` | a resumed child's result |
| `opening` | the line a child session opens with |

Each note carries a structured marker, and the marker is the authority on
authorship. Read it to slice a turn out of a session's messages, or to render a
transcript.

## `Agent`, in detail

`createAgent(params)` assembles a runnable agent and returns an **`Agent`**. It
wraps the compiled graph, the shape `createDeepAgent` returns. Governance hangs
off `.workflow`, and is `undefined` when no `workflow` was supplied.
Session-level operations are on the agent either way.

```ts
import { createAgent, type Agent } from "@archmax-ai/harness";

const agent = await createAgent({ workflow: "order-lookup" });

// Operations on every agent (workflow-governed or plain):
agent.graph;                        // the runnable LangGraph graph
agent.dispose(sessionId);           // release per-session resources
agent.workflow?.name;               // the workflow slug (undefined if ungoverned)
agent.runtimeContract;              // resolved (and enforced) runtime contract
agent.toolMocks;                    // whether declared tool mocks intercept the agent's own calls
await agent.emitRunArtifacts(sessionId, trajectory);
await agent.sessions.list();             // SessionSummary[]
await agent.sessions.get(sessionId);     // one session's summary
await agent.sessions.messageCount(sessionId); // a cursor for slicing one turn (see `messagesSince`)
await agent.sessions.delete(sessionId);  // remove the session's whole folder
await agent.sessions.seed(sessionId, files); // seed input files into the session's workspace
await agent.getSpecSnapshot(specHash);

// Workflow-only operations require narrowing on `workflow`:
if (agent.workflow) {
  // The one operation a host needs: a turn, resolved to whatever the session's
  // state dictates — a new turn, a reply to a session a person holds, or a
  // delivery into a session parked with archmax_wait.
  const outcome = await agent.workflow.send(sessionId, { message: "Look up order 1234" });
  outcome.kind;          // "completed" | "parked" | "rejected"
  outcome.disposition;   // "turn" | "decide" | "reply" | "deliver"
  outcome.state;         // where the session is — for a park, the state it is parked at
  outcome.pending;       // the park record, when parked
  outcome.delegation;    // when the pending decision is a delegated child's: which child, which call
  outcome.reply;         // what the session said
  // …and the three resumes, as payloads of the same call or as their own verbs:
  await agent.workflow.send(sessionId, { decision: { target: "approve" } });
  await agent.workflow.send(sessionId, { delivery: { trigger: { id: "email_reply" }, variables } });
  const resolved = agent.workflow.resolveTrigger({ id: "email_received" });
  const decided = await agent.workflow.decide(sessionId, { target: "approve" });
  const answer = await agent.workflow.reply(sessionId, "Any news?"); // parked session, still parked
}
```

**Ungoverned by declaration.** Omitting `workflow` still *looks for* the default
workflow (`DEFAULT_WORKFLOW`) on the authoring backend, and governs the agent
when it is found. Pass `workflow: false` for an agent that is ungoverned on
purpose. That reads no spec and discovers no rubric, so a stray `workflows/` tree
under the resolved root leaves the agent alone.

A plain agent behaves like a governed one in most other respects. It honours
`middleware`. Every `invoke`, `stream` and `streamEvents` on it is bound to the
session named by `configurable.thread_id`, and its `scratchpad/…` and offload
paths land under `<sessionId>/` in the session store just as a governed session's
do. A reserved or escaping id is refused before anything is written.

An ungoverned assembly has `agent.workflow === undefined`, so `send`,
`resolveTrigger` and `decide` are unreachable, and misuse is a compile-time type
error rather than a runtime throw. Session-level members stay on the agent either
way: `sessions`, `emitRunArtifacts`, `getSpecSnapshot`, `toolMocks` and
`dispose`.

### Multi-turn conversations (chat history)

`agent.invoke` accepts an **array of role-tagged messages** as well as a
single user string. The `messages` channel is a LangChain `add_messages`
channel. Whatever you pass is appended to the session's transcript, and the
model sees real turns. A prior conversation goes in as its own turns.

**Preferred: session persistence.** Sessions are durable by default, with the
`BackendCheckpointSaver` writing each turn to the session store. Prior turns are
already in the checkpoint, so a conversation is repeated invokes of the **same
`thread_id`**, carrying the new message each turn:

```ts
// turn 1
await agent.invoke(
  { messages: [{ role: "user", content: "Look up order 1234" }] },
  { configurable: { thread_id: "chat-42" } },
);
// turn 2 — SAME thread_id; only the new message
await agent.invoke(
  { messages: [{ role: "user", content: "And when did it ship?" }] },
  { configurable: { thread_id: "chat-42" } },
);
```

Each turn re-enters the workflow with the full history retained. A session
continues in the state its previous turn left it in (see [sessions](/guides/sessions/)).

**Alternative: seed prior history on the first invoke.** Your transcript may live
in your own store rather than a harness session. Pass it as the initial `messages`
array, with the newest user turn last:

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
  { configurable: { thread_id: "chat-42" } },
);
```

Three things to know:

- **A hook reads the transcript from `messages`, newest last.** A hook that
  keys off "the current request" should take the *last* `user` entry. The
  first is the message that opened the session.
- **A definition edit is adopted.** A session takes its next turn under the
  `workflow.yaml` in force now. The recorded `specHash` is a record of which
  definition each turn ran under, resolvable via `getSpecSnapshot`, and it binds
  no later turn. A turn positioned in a state the edit removed reopens at its
  trigger's entry state.
- **Seed assistant turns as text only.** Don't fabricate dangling `tool_calls`
  in seeded history, or the model provider may reject the turn.

The trigger surface is five names: `TriggerInput`, `ResolvedTrigger`,
`resolveTrigger`, `CreateAgentParams.trigger` and `UnknownTriggerError`.
`resolveTrigger({ id })` maps the id to the state whose `triggers:` declares that
id (see [triggers](/guides/triggers/)), and fails closed on an
unknown one.

A trigger carries an id and nothing else, so a firing's input travels as
`variables`. In the SDK a trigger is always a **manual invocation**: the caller
supplies the id, and listening for external events is the host's job.

> `createAgent` returns an agent wrapping the compiled graph rather than a record
> holding it. Narrow on `agent.workflow` (`undefined` on an ungoverned assembly)
> before calling workflow-only operations. The earlier `createWorkflowAgent` entry
> point no longer exists. See the [changelog](/reference/changelog/).

### Reading what a session returned

A trigger may declare `returns:`: the variables a session started through it
guarantees are set when it completes (see [triggers](/guides/triggers/)).
A return is an ordinary variable, so it is read by name from `Outcome.variables`,
or from a `SessionSummary`'s `variables`. The completion check rejects a session
that finishes with a declared return unset, so a host sees the full set or a
failure. A sub-workflow hands its returns back on the tool result instead.

Every ingress enters through `MANUAL_TRIGGER`: a delegation, the CLI's `run`, a
trigger-less invoke. `DEFAULT_TRIGGER_ID` is the same value, and delegation
reuses it rather than carrying a sub-workflow trigger id of its own.

### Session artifacts: what a finished session leaves behind

`emitRunArtifacts(sessionId, trajectory)` writes a session's observability files under
`sessions/<sessionId>/artifacts/`:

| File | Contents |
| --- | --- |
| `graph.json`, `graph.mmd` | the machine's topology, serialized per session |
| `trajectory.json` | per-state messages and tool calls, as supplied |
| `trail.json` | the audit trail: committed transitions, edge kinds, rationale |
| `variables.json` | the session's variables as `name → { value, locked }` |
| `metadata.json` | runtime contract, package version, `specHash`, `usage` |

A session's variables are also on its **summary**. `sessions.list()` and
`sessions.get(sessionId)` carry `variables` as `name → { value, locked }`, read
straight from the checkpoint.

So the record exists for every session that has run, even where artifacts were
skipped (the CLI emits none). A checkpoint predating variables, or one holding a
malformed store, reads as an empty set and the listing still succeeds.

`variables.json` is the session's **input record**. It carries
`{ sessionId, workflow, variables }`. Each entry is the value as stored, plus its
lock state: structured values whole, scalar types preserved. It is sourced from
the same checkpoint read that produces the trail:

```json
{
  "sessionId": "s-42",
  "workflow": "order-lookup",
  "variables": {
    "trigger": { "value": "report_requested", "locked": true },
    "company": { "value": "Acme Corp", "locked": true },
    "case_id": { "value": "K-9", "locked": false }
  }
}
```

`locked` is the file's one attribution of who established a variable. A locked
entry came from the host: a `variables` seed, a delivery's seeds, or the built-in
`trigger`. An unlocked one came from the agent's own `archmax_set_variables`. That
distinction is what makes the file usable for
[authoring a case from a real session](/guides/testing/#authoring-a-case-from-a-real-session).

Two properties worth knowing:

- **Empty is distinct from absent.** A governed session whose store is empty
  writes `"variables": {}`, meaning "took no seeded input". The file is omitted
  entirely for an ungoverned (machine-less) session, and for one whose checkpoint
  could not be read. Artifact emission stays best-effort, so a failed write
  surfaces as a `warning` event and the session still succeeds.
- **Values are persisted verbatim**, untruncated and unredacted. That matches
  `trajectory.json`, which already records the conversation and every tool call's
  arguments. Treat seeding as persistence, then, and reach for
  `agent.sessions.delete(sessionId)` to remove what you seeded.

### Spec snapshots: auditing a session after the spec changes

A session's checkpoints and its `metadata.json` (from `emitRunArtifacts`) both
carry the `specHash` of the machine spec that governed them. It is a stable,
key-order-insensitive hash of the `workflow.yaml` mapping, surfaced on a
`SessionSummary` from `sessions.list()` and in `metadata.json`. On its own that
hash answers one question: whether two sessions used the same spec.

`getSpecSnapshot(hash)` resolves it back to the full `MachineSpec`, with its
states, tool `allow` lists, transitions and hooks. It returns the spec as
persisted the first time a session produced that hash, whatever `workflow.yaml`
holds today:

```ts
const sessions = await agent.sessions.list();
const spec = await agent.getSpecSnapshot(sessions[0].specHash);
// spec is the exact machine spec that governed that session, even if
// workflow.yaml has since been edited. `null` if no snapshot was ever
// persisted for that hash (e.g. it predates this capability).
```

The snapshot is written once per distinct spec version, content-addressed under
`_specs/<specHash>.json` in the session store. The write happens the first time a
turn boundary sees that hash, so a session's later turns and checkpoints add
nothing.

## Authored mounts: what the agent may read

The agent's workspace root is the session. Authored content is mounted beside it
as `CompositeBackend` routes **you compose**. Which directories those are is
workspace shape, and the runtime holds no knowledge of them.

The archmax harness ships a conventional table, `defaultMounts(rootDir)`, as a default value
you spread, replace, or ignore. The workspace then serves exactly what that table
mounts, so credentials (`.env`) and repository internals (`.git`) sit outside it
and there is no exclusion rule to get wrong.

```ts
import { createAgent, defaultMounts, mountSubtree } from "@archmax-ai/harness";
import { FilesystemBackend } from "deepagents";

const agent = await createAgent({
  workspace: { rootDir, mounts: {
    ...defaultMounts(rootDir),                                   // the convention
    "/templates/": new FilesystemBackend({ rootDir: "/srv/templates", virtualMode: true }),
    "/memories/": { backend: sharedStore, readOnly: false },      // writable mount
    "/policies/": mountSubtree(myS3Backend, "policies"),          // one backend, many mounts
    "/catalogs/eu/": { backend: euCatalog, governed: true },       // per-state, and nested
    "/contracts/": { backend: sharePoint, governed: true, searchable: false }, // browse, never fan out
  } },
});
```

- A key ending in `/` is a **directory mount**, a real composite route. A key
  without one (`"/AGENTS.md"`) is an **exact-path file mount**, which a prefix
  route cannot express.
- Mounts are **read-only** unless the mount entry says otherwise
  (`{ backend, readOnly: false }`). The mount itself enforces that, so an
  authored path holds even against a caller that bypasses governance. The
  kernel's `zone.read-only` rule remains the agent-facing message and what
  `archmax validate` probes statically. A **writable** mount's paths are governed
  by the state's `tools.allow`, like session paths.
- A backend rooted *at* the mounted directory works as it is, because the
  composite strips the route prefix before delegating. Use
  `mountSubtree(backend, "dir")` when one backend serves several mounts.
- A mount is visible in **every state** unless the entry declares
  `governed: true`. That hands the spec's `mounts` block two decisions: which
  states may reach it (closed by default, like a skill bundle) and whether each
  may write there. The resolved names arrive as `MountPrefixes.governed`, and a
  table that marks nothing behaves exactly as it does today.

  Four `WorkflowMachine` readers answer for it, and the kernel, the listing
  redaction, prompt disclosure and `validate` all consult them:

  | Reader | Answers |
  | --- | --- |
  | `enabledMounts(state, governed)` | which governed mounts the state reaches |
  | `mountWritable(state, name, prefixes)` | whether it may write there |
  | `forbiddenMounts(state)` | what is denied while that state is active, from either level |
  | `workflowForbiddenMounts()` | what `forbid_always` denies in every state |

  `readOnly` is a **ceiling** the spec cannot lift. A grant may narrow a writable
  mount to reads in one state; a read-only mount stays read-only everywhere. See
  [`mounts.allow_always` /
  `mounts.allow`](/reference/machine-spec/#mountsallow_always--mountsallow-which-states-reach-a-mount).
- A mount is **searched** like any other unless the entry declares
  `searchable: false`. A `grep` or `glob` at the root, at an ancestor, or
  anywhere outside the mount then fans out over the other mounts and skips that
  one. So a backend that refuses searches (a remote folder served live, where a
  search would download it) can sit in the workspace while root-wide searches
  keep working.

  A search addressed **at** the mount, or at a path inside it, still reaches the
  backend with the route-relative path. Its answer comes back verbatim, matches
  or the backend's own `{ error }`. Listing and reading behave as they always
  do, and the prompt marks the mount "browse only".

  The resolved names arrive as `MountPrefixes.unsearchable`. The kernel and
  `archmax validate` both leave the flag alone, and a file mount ignores it too,
  since search walks trees and a file mount is one path.
- A key may be several segments deep (`"/catalogs/eu/"`), matched by **longest
  prefix** wherever a path is classified. Its **first** segment is what is
  reserved.
- A key colliding with a session area (`/scratchpad/`, `/checkpoints/`, …) throws
  `MountCollisionError` at assembly.
- **`/workflows/` may not be mounted.** It belongs to the authoring backend, and
  `defaultMounts()` leaves it out; that table is `/skills/`, `/.platform/` and
  `/AGENTS.md`. See below.
- With a custom `backend` and no `mounts`, the workspace serves the session
  alone. Exposing authored content is then an explicit act.

`createWorkspaceContext` is synchronous. It exposes the resolved `mountPrefixes`
(`dirs`, `files`, `writable`, `governed`), which
`isReservedRootName(name, mountPrefixes)` takes. Pass the same table to
`validateWorkflow({ mounts })` so `archmax validate` checks a spec's `mounts` names
against the wiring. Omit it and every mounts diagnostic stays silent, for want of
anything to check against.

A path under a mount the active state cannot reach is refused by the kernel,
under one of three rules:

| Rule | Cause |
| --- | --- |
| `mount.not-allowed` | nothing enabled the mount |
| `mount.forbidden` | a list denies it, naming the workflow when the denial is inherited from a caller |
| `mount.read-only` | the state has the mount, and a grant narrowed it to reads |

A write into a mount the *host* serves read-only stays `zone.read-only`.

## The authoring backend: `authoring`

`workflows/**` holds specs, `WORKFLOW.md`, `hooks/` and `tests/`, and the grading
rubrics a spec's states declare are part of those specs.

The runtime reads all of it through a **separate backend**, which is kept out of
the agent's workspace routes. So a tool call and a PTC call alike stop at the
composite. The prefix is reserved too: declaring it as a mount key throws
`MountCollisionError`.

```ts
const agent = await createAgent({
  workflow: "order-lookup",
  authoring: myGovernanceBackend,
  // specs (rubrics included), hook scripts, test cases
  backend: myContentBackend,
  // what the agent may read
  mounts: { "/skills/": mountSubtree(myContentBackend, "skills") },
  workspace: { sessionStore: createBackendSessionStore({ backend: myRunStore }) },
});
```

- **Defaults to `backend` when you supply one**, and otherwise to a filesystem
  backend over the resolved root. Existing wiring keeps working as it is.
- Handing it to a **writable** mount throws `AuthoringBackendExposedError`.
  A writable route onto it would let a session edit the machine governing it. A
  *read-only* mount may share the backend safely.
- `createWorkspaceContext` returns it as `authoring`, a `Workspace` distinct from
  `workspace`.
- Hook scripts are read here, from `workflows/<slug>/hooks/`, wired
  workflow-relative (`{ script: hooks/check.js }`). Scripts the *agent* runs with
  `archmax_run` stay in skill bundles and are confined there by the kernel's
  `script.skill-only` rule.
- Grading rubrics are read here too, as part of the spec. A rubric is declared
  inline on the hook that applies it, and the runtime alone dispatches it. The
  agent has no `task` tool, and `task()` is absent from every sandbox context. See
  [grading rubrics](/guides/grading-rubrics/).

See [The authoring plane](/guides/authoring-plane/).

## Session storage: `sessionStore` and the `sessions` handles

Everything a session produces lives in a logical session namespace the SDK owns.
That namespace is the per-session `<sessionId>/…` layout that *is* the agent's
workspace root. Four things belong to it:

- the reserved areas `scratchpad/`, `large_tool_results/`,
  `conversation_history/`, `checkpoints/` and `artifacts/`
- the session-agnostic `_specs/` prefix
- session-scoped routing of the agent's id-free paths
- lazy creation

The **consumer** owns the physical storage behind it: which backend, tenancy
prefixing, durability, and retention. It is expressed as a **`SessionStore`**
passed to `createAgent`:

```ts
import { createAgent, createBackendSessionStore } from "@archmax-ai/harness";

const agent = await createAgent({
  backend: authoredBackend,
  workspace: { sessionStore: createBackendSessionStore({ backend: s3Backend, prefix: `tenants/${id}/runs` }) },
});
```

Three factories ship from the package root:

- **`createFilesystemSessionStore({ dir })`** is a local directory. Zero-config
  assembly (default filesystem authored backend, no `sessionStore`) defaults
  to `<root>/sessions`.
- **`createBackendSessionStore({ backend, prefix?, deleteSession?, list? })`** takes any
  `BackendProtocolV2`, with an optional tenancy `prefix` and optional
  delete/list capabilities.
- **`createMemorySessionStore()`** is ephemeral, for tests.

The `SessionStore` type is exported alongside them. Storage is always declared:
supplying a custom authored `backend` **without** an explicit `sessionStore`
throws `SessionStoreRequiredError` at assembly.

**The same holds for a root.** `rootDir` is where the zero-config filesystem
defaults are built: the conventional mounts, the `sessions/` store, the authoring
backend. With none of `backend`, `mounts`, `sessionStore` and `authoring`
supplied, it defaults to the working directory, as documented.

Once any of them is supplied, a default that still needs a root is refused with
`WorkspaceRootRequiredError` naming the option, rather than built over the cwd.
When every source is supplied, no root is resolved at all, so
`WorkspaceContext.rootDir` and `ValidationResult.rootDir` are absent.

Agent-visible session paths resolve **per session** through the session store,
`sessions/<sessionId>/…` on the filesystem default. So concurrent sessions stay
apart, and the session id is stripped from every path the agent sees, in both
directions.

Governance varies by area:

| Area | Access |
| --- | --- |
| `scratchpad/**` | the session's one working area, permitted in every state |
| any other session path | governed by the state's `tools.allow` |
| the offload areas | readable, and agent writes are refused |
| `checkpoints/`, `artifacts/`, `_specs/` | outside the agent's address space |

**Checkpointing follows the session store.** The default checkpointer is still a
`BackendCheckpointSaver` writing `<sessionId>/checkpoints/`, but through the
configured session store. A caller-provided LangGraph `checkpointer` still takes
precedence, as the custom-adapter escape hatch.

The agent exposes session handles over the same store:

- `sessions.list()` returns `SessionSummary[]`, or `[]` on configurations that
  cannot list. 
- `sessions.get(sessionId)` returns one session's summary.
- `sessions.messageCount(sessionId)` gives how many messages the transcript holds,
  from the latest checkpoint (`0` for a session that has not run). It is a cursor.
  Read it before a turn, and hand it to `messagesSince(messages, cursor)` from
  `@archmax-ai/harness/messages` afterwards. That slices exactly what the turn appended.
- `sessions.delete(sessionId)` removes the session's whole folder through the
  store. It throws a typed `SessionStoreCapabilityError` if the store cannot delete.
- `sessions.seed(sessionId, files)` writes input files into the session's
  workspace through the store. It is the supported way to place a payload before
  the agent starts, such as a `trigger.json`, in place of materializing physical
  store paths out-of-band.

  Keys are workspace-relative session paths: root-level files, `scratchpad/…`.
  Authored mounts and runtime-internal areas (`checkpoints/…`, offload dirs) are
  rejected before anything is written. String values are written verbatim, other
  JSON values as pretty-printed JSON, and an existing file is overwritten. The
  case engine seeds a case's declared `workspace:` files through this handle.

## Extension options

All options are additive. Omit every one and the agent behaves exactly as it did
before they existed.

### `promptCache`, `pricing`: caching and cost

```ts
const agent = await createAgent({
  workflow: "order-lookup",
  promptCache: { enabled: true, ttl: "5m" },   // provider prompt caching
  pricing: { default: { input: 3, output: 15, cacheRead: 0.3 } }, // USD per 1M
});
```

The model-facing payload has **one** shape, and every option and spec setting
leaves that rendering alone. The static prefix holds nothing of the graph's
position: the active state's instructions, edges, markers and hooks arrive per
turn. `task` is withheld in every state, with that tool's upstream guidance
pruned along with it.

- **`promptCache`** marks the stable prefix so the provider serves it from cache.
  On by default. `{ enabled: false }`, `settings.prompt_cache`, or
  `ARCHMAX_PROMPT_CACHE=0` turn it off.
- **`pricing`** supplies USD-per-1M-token rates so `costUsd` appears on usage
  events, in session artifacts, and in the CLI footer. An unpriced model reports
  its tokens and leaves cost out, since cost is measured from the rates you give.

Both options leave what the kernel permits untouched. Full details, including the
measured savings, are in
[Token efficiency and cost](/guides/token-efficiency/).

### `modelFactory`: pluggable model provider

Supply the chat model per role: `agent`, `judge` for the case grader, and
`rubric`. The runtime can then run against any LangChain `BaseChatModel`. Example
(Amazon Bedrock):

```ts
import { ChatBedrockConverse } from "@langchain/aws";
import { createAgent, type CreateAgentParams } from "@archmax-ai/harness";

const modelFactory: CreateAgentParams["modelFactory"] = (role, env, requested) =>
  new ChatBedrockConverse({
    // `requested` is the id a grading rubric declared, when it declared one.
    model: requested ?? (role === "judge" ? "anthropic.claude-3-haiku" : "anthropic.claude-3-5-sonnet"),
    region: "us-east-1",
  });

const agent = await createAgent({ workflow: "order-lookup", modelFactory });
```

The second argument is a **thunk** returning the env-configured settings, so a
factory carrying its own credentials, like the one above, skips the `ARCHMAX_*`
lookup entirely. A host with none of those variables set still assembles a
runtime and grades `grade:` expectations.

Call `env()` when you want to build on the env-configured settings:
`(role, env) => createChatModel({ ...env(), model })`. It throws on a missing
`ARCHMAX_API_BASE_URL`, exactly as it would have during a default assembly.

The third argument is the model id a [grading
rubric](/guides/grading-rubrics/) asked for, or `undefined`. It is
additive, so a factory taking `(role, env)` behaves exactly as before and may
ignore the request. The default path applies it over `ARCHMAX_MODEL`, keeping the
configured endpoint and credentials.

With `model` and `modelFactory` both omitted, the runtime defaults to the
env-configured OpenAI-compatible model for every role. With both given, `model`
wins for the `agent` role and the factory supplies `judge` and `rubric`.

### `hookExecutors`: custom lifecycle hook kinds

Register executors for hook kinds beyond the built-in `script` and `rubric`,
so `workflow.yaml` may declare hooks like `{ webhook: <path> }`:

```ts
import { createAgent, type CreateAgentParams } from "@archmax-ai/harness";

type HookExecutors = NonNullable<CreateAgentParams["hookExecutors"]>;

const webhook: HookExecutors[string] = async (hook, ctx, args) => {
  // …call the webhook, return the script outcome shape (ok/value/logs/error/formatted)…
  return { ok: true, value: { verdict: "ok" }, logs: [], formatted: "" };
};

await createAgent({ workflow: "…", hookExecutors: { webhook } });
```

Registering an executor under a built-in kind (`script`/`rubric`) fails assembly,
and a hook whose kind has no executor vetoes fail-closed at runtime. Declare
custom kinds under
[`extensions.hooks`](/reference/machine-spec/#extensionshooks) so
`archmax validate` accepts them.

An executor's `value` is read as **the same verdict vocabulary a script hook
returns**, whoever implements the kind:

| `value` | Effect |
| --- | --- |
| `{ verdict: "ok" \| "correct" \| "veto", reason }` | That verdict. |
| `false` | A veto (`"precondition not met"`). |
| `undefined`, `null`, or any non-object | No opinion; the phase proceeds. |
| any other object | **Fails closed**, terminally, with the object's keys named. |

The last row is the one to know about. An executor's return value *is* its
verdict, so an unrecognized object is a verdict the executor got wrong, and
reading it as `ok` would silently permit what the hook meant to block.

Return `{ ok: true, value: { verdict: "veto", reason } }` to block, and an
`{ ok: false, error }` outcome for a call that could not be made at all.

### `policyRules`: programmatic governance rules

Custom pure governance rules, inserted into the kernel pipeline. They run
**after** the non-overridable safety rules (inline-`eval` block, read-only zone)
and the workflow `policy` rules, but **before** the per-state `allow` defaults:

```ts
import { createAgent, type GovernanceRule } from "@archmax-ai/harness";

const blockExternalFetch: GovernanceRule = (action) =>
  action.kind === "tool-call" && action.tool === "web_fetch"
    ? { decision: "block", ruleId: "custom.no-fetch", reason: "network disabled" }
    : null;

await createAgent({ workflow: "…", policyRules: [blockExternalFetch] });
```

A custom rule tightens the pipeline: it may block a call a state would otherwise
permit, and the safety rules stand whatever it returns.

### `sandboxRuntime`: pluggable script execution

Script execution targets the interface typed as
`CreateAgentParams["sandboxRuntime"]`: namespaced sessions with an `eval`
operation and disposal. That covers the agent's `archmax_eval` and `archmax_run`,
along with hook scripts.

Omit the option and the bundled QuickJS runtime runs them. Supply your own to run
scripts in a worker or remotely:

```ts
await createAgent({ workflow: "…", sandboxRuntime: myWorkerSandbox });
```

Sandbox quotas (`timeoutMs`, `memoryLimitBytes`, `maxPtcCalls`, `maxResultChars`)
are expressed against the interface, so any implementation receives them.

### `parseCodeDescription`: code description frontmatter

An `archmax_run` script opens with a leading JSDoc block: a title line, a blank
line, then prose describing what the code does and how. That block is the
[description frontmatter](/guides/code-interpreter/#description-frontmatter)
an admin UI shows its users. Lifecycle hook scripts sit outside the convention,
and their one check is that the referenced file exists.

`parseCodeDescription` returns the whole block's prose, title included. It is the
canonical extractor, so consumers can leave the comment parsing to it:

```ts
import { parseCodeDescription } from "@archmax-ai/harness";

const source = await readThroughYourBackend("workflows/order-lookup/hooks/check-refund.js");
const parsed = parseCodeDescription(source);
// { description: "Veto unless the recorded decision matches the …" } or null
```

It is a pure string helper over the file's source, which you read through your
configured backend. It normalizes BOM/CRLF, strips the `*` gutters, and cuts the
prose at the first `@tag` line. A file lacking a leading JSDoc block, or holding
one with no prose, yields `null`.

## `runTests`: cases from a host

`runTests` runs a workflow's [cases](/guides/testing/). It uses
the same discovery, schema validation, host-side case interpretation, grader, and
verdict reduction as `archmax test`. It is what the CLI's `test` subcommand
calls:

```ts
import { runTests } from "@archmax-ai/harness/testing";

const { results, exitCode } = await runTests({ workflow: "order-lookup", rootDir: "./ws" });
```

It takes eight ordinary options: `workflow`, `rootDir`, `filter`, `onEvent`,
`onCaseStart`, `onCaseResult`, `sandboxRuntime` and `modelFactory`. Three more,
covered below, exist for hosts that assemble their own agent.

`sandboxRuntime` reaches the **agent under test** alone, for its hooks and
`archmax_run` sources. Case documents are YAML interpreted on the host, so running
a suite creates no sandbox of its own.

### `authoring`: where the suite is read from

`runTests` reads a few things itself: the machine spec and its `tests:` block,
the case documents under `workflows/<slug>/tests/`, and the fixtures their
`from:` entries name. All of them come from the authoring backend, the same
option `createAgent` takes. It defaults to a filesystem backend over the
resolved `rootDir`, which suits `archmax test` and any host whose cases really
are files on disk.

A host whose authored tree lives somewhere else (an object store, a database, a
signed bundle) passes that backend here. Usually it is the very one its
`createTarget` assembles over.

```ts
await runTests({
  workflow: "order-lookup",
  authoring: myStoreBackend,
  createTarget: myRuntime,
});
```

Leave it out in that case and the failure is silent. Discovery looks under
`<rootDir>/workflows/`, finds an empty tree, and reports **no cases**. An empty
suite comes back as a clean run with no verdicts, so a missing suite looks
exactly like a passing one.

### `createTarget`: the agent under test

By default `runTests` builds the agent it drives, via `createCaseTarget` →
`createAgent`. Some hosts carry more than that: a mounted authored tree,
connection tools resolved per tenant, a session store, a composed system prompt,
a durable checkpointer. Such a host supplies its own target, either a factory or
an already-built workflow-governed agent.

```ts
await runTests({
  workflow: "order-lookup",
  createTarget: async ({ workflow, rootDir, onEvent }) =>
    createAgent({
  workflow,
  onEvent,
  backend,
  tools: await resolveConnectionTools(tenant),
  checkpointer,
  middleware: [createToolMockMiddleware()],
  // ← see below,
  workspace: { rootDir, sessionStore, mounts },
}),
});

// or, with an agent you already hold:
await runTests({ workflow: "order-lookup", createTarget: myRuntime });
```

The seam is a target rather than a forwarded option list on purpose: the case
protocol is the runtime's, and agent assembly is yours. In the factory form,
`rootDir` in the context is the *resolved* workspace root.

Either form is held to the same contract as the default target. The target must
be workflow-governed, and an ungoverned one is refused before any case runs.

:::caution[Your target owns its own mocks, and the runtime checks]
A case's `mocks:` declarations intercept agent-initiated tool calls through
`createToolMockMiddleware()`, which `createCaseTarget` wires for you.
`createAgent` stamps `toolMocks` on the agent it returns, from the middleware
actually wired.

A case that declares mocks against a target without that middleware **fails
loudly before the agent runs**, naming the fix. The gateway always intercepts
script-initiated PTC calls, so such a target would mock some calls and let others
through. The refusal is what keeps a case from running half-mocked.

A bespoke target that intercepts by other means declares it by setting
`toolMocks` itself. A case with no `mocks:` runs against any workflow-governed
target.
:::

### `sessionIdForCase`: naming the case's session

Each case runs its conversation on a session the runtime mints:
`test-default-test-run-<timestamp>-<file>`. That id is unpredictable from
outside, which leaves a host nothing to join its own records to. Name it
instead:

```ts
await runTests({
  workflow: "order-lookup",
  sessionIdForCase: (file) => `${hostRunId}/${file}`,
});
```

The hook receives the case file's workspace-relative path, and is invoked once
per case file. A case is one conversation on one session, so per-file is the
isolation unit being named. Name the session and you name the whole case: its
checkpoints, its `scratchpad/…` files, and its token usage all resolve under an
id you chose.

Omit both options and you get the CLI's behavior exactly: same target, same
session ids, same verdicts, same exit code.

### What a case reports

Each `CaseResult` carries a reduced `verdict` plus the flat `AssertionRecord[]`
the case produced. Three properties of that array let a host build its own view
on top of it.

**Every record has one outcome.** `AssertionRecord.status` is an
`AssertionStatus`: `"passed"`, `"failed"`, or `"not-executed"`. It is the single
authoritative result of that assertion, and the field `reduceVerdict` itself keys
off. `"not-executed"` is a first-class outcome in its own right (see below).

```ts
for (const r of results[0].records) {
  switch (r.status) {
    case "passed": /* ✓ */ break;
    case "failed": /* ✗ — r.detail says what missed */ break;
    case "not-executed": /* the case stopped before this step */ break;
  }
}
```

**Every record names its step.** `AssertionRecord.step` is the zero-based index
of the assertion step that produced the record, in the case document's flat
`steps` list. It is the same index the schema uses in its `steps[i]` parse
errors, so it points straight back into the case file.

Attribution is stamped at construction. An expectation that emits several records
attributes all of them to its own step, and a host reads each record's origin
straight off it:

```ts
const { results } = await runTests({ workflow: "order-lookup" });

const byStep = new Map<number, AssertionRecord[]>();
for (const record of results[0].records) {
  const bucket = byStep.get(record.step) ?? [];
  bucket.push(record);
  byStep.set(record.step, bucket);
}
// step 1 → [reply.includes "ORD-1003", reply.includes "/delayed/i", reply.excludes "ORD-2001"]
```

Values are **sparse** with respect to `steps`, because an action step (`send`,
`decide`) produces no records. So a case whose steps are `send`, `reply`,
`decide`, `succeeded` yields records at `step: 1` and `step: 3`.

**A case that stops early accounts for the rest.** A case can stop before its
steps run out in two ways, and both report every assertion step:

- It **halts**. A structural assertion failed, so the session has diverged from
  the one the case describes and driving it further would grade the wrong
  session. The verdict is `failed`, naming that assertion, and `error` stays
  unset: a halt is a verdict in its own right. See
  [which assertions halt a case](/guides/testing/#which-assertions-halt-a-case).
- It **dies**: a failed `send`/`decide`, a refused start, or an exceeded
  `tests.caseTimeoutMs`. The verdict is `failed`, and `error` holds the
  terminating message. `verdict.failures` lists that message **first**, followed
  by the failures of the already-evaluated records. So an assertion that missed at
  step 3 is still visible when the case died at step 5.

In both cases the assertion steps that never ran are reported with
`status: "not-executed"`, one record per step, carrying that step's index and the
assertion's kind. They contribute no failures, and they are present, so a UI can
grey them out. That presence is the point, since a gap in the list would read as
a pass.

An un-run multi-token `reply` yields exactly one record. The engine reports the
step it skipped, and invents no outcomes for the tokens inside it.

### Reading a grade

A `grade` assertion's record (kind `grade.closedQA`) is the one whose result is a
score. Four fields carry it:

| Field | Meaning |
| --- | --- |
| `status` | `"passed"` when `score >= threshold`, `"failed"` otherwise. **This is the verdict**: the same comparison `reduceVerdict` makes, so a record can never contradict the verdict shown beside it. |
| `score` | The grader's 0–1 score, clamped. Display it; do not re-decide from it. |
| `threshold` | The case's declared `atLeast`. Non-null only for grade records, which makes `r.threshold != null` the way to select them. |
| `detail` | `"<criterion>: <reason>"`, the grader's short explanation (it is instructed to keep it to 1–3 sentences). Where the grader could not run, this names the fix instead. |

The case author's declared `atLeast` decides the record, and the grading model's
own `pass` boolean is advisory. So a grader returning `{ score: 0.6, pass: true }`
against `atLeast: 0.7` records `status: "failed"`, matching the verdict.

A failed grade fails its case like any other assertion. There is one tier of
severity: `CaseVerdict.status` (`CaseStatus`) is `"passed"`, `"failed"`, or
`"skipped"`, and `reduceVerdict` and `exitCodeForVerdict` each take no `strict`
argument.

A grader whose reply cannot be read as JSON is asked once more, JSON only, before
its turn scores 0.

What the grader scores is the turn's `JudgeEvidence`. That is its final reply,
plus a bounded chronological record of the assistant messages and tool calls
behind it (see [what the grader sees](/guides/testing/#what-the-grader-sees)).

```ts
const judged = results[0].records.filter((r) => r.threshold != null);
for (const j of judged) {
  console.log(`${j.status}  ${j.score} / ${j.threshold}  ${j.detail}`);
}
```

A case's grader may fail to run at all, for want of a `tests.judge` in
`workflow.yaml` or through a model error. It then records `status: "failed"` with
`score: 0` and an actionable `detail`.

Each `CaseResult` also carries the `sessionId` the case ran on, absent for a
skipped or unparseable case. So a host (and `archmax test`) attributes token usage
per case from the event stream, reading each id off the result it belongs to.

### Case schema exports

The declarative case format is a public surface, so hosts can validate and
tool over it without running a suite:

- **`parseCaseDocument(file, source, testsDir)`** parses and validates one
  case document, with the same fail-closed schema the runner and `archmax validate`
  use. It returns a typed `CaseDocument`, or throws `CaseSchemaError` on an
  unknown key, a malformed regex string, or a structural violation, addressed by
  file and location.

  Five types ship alongside it: `CaseDocument`, `CaseStep`, `CaseExpectation`,
  `CaseTriggerDecl` and `CaseWorkspaceEntry`. So do the enforced prose budgets
  `CASE_TITLE_MAX_LENGTH` (60) and `CASE_DESCRIPTION_MAX_LENGTH` (200), so a host
  authoring or linting cases measures them exactly as the schema does.
- **`serializeCaseDocument(doc)`** is the inverse: a `CaseDocument` back to YAML,
  in the grammar's own key order (`title`, `description`, `skip`, `trigger`,
  `variables`, `workspace`, `mocks`, `steps`). So an editor that parses a file,
  edits the document and writes it back changes just what it edited, and
  `parse(serialize(doc))` is deep-equal to `doc` for every document the grammar
  accepts.

  A reply token keeps its `/pattern/flags` spelling. Comments live outside the document, so a round trip
  drops them.
- **`discoverCases(authoring, testsDir)`** and **`runCase(options)`** are the
  two halves `runTests` is built from: find-and-parse, then drive one. They are
  there for a host that schedules cases itself. **`partialMatch(expected, actual)`**
  is the one matcher `calledTool.input` assertions and `whenInput` mocks share.
- A case file carries no version of its own. The authoring surface is versioned
  once, by `runtime.version` in `workflow.yaml`.

## Spec loading and prompt rendering

- **`loadMachineSpec(workspace, { workflowYaml, workflow })`** reads a
  workflow's `workflow.yaml` through the given workspace. It returns
  `{ spec, issues, body, layout: "v2" | "none", specFile, usable }`, where
  `layout` says whether a `workflow.yaml` was found, `body` is the `WORKFLOW.md`
  prose, and each issue carries `severity: "error" | "warning"`.

  `MachineSpec` and `MachineState` are the parsed shapes. `WorkflowMachine` is
  the compiled object the runtime consults for transitions, tool surfaces and
  enabled skills.
- **State identity is the slug**, a state's key in `states`.
  `MachineState.title` is a human label, carried in a decision record and host
  surfaces and kept out of routing and out of the prompt. `MachineSpec.title`
  heads the rendered workflow header. A top-level `name` key is a load error
  under the strict schema. See the
  [changelog](/reference/changelog/).
- **`MachineTransition.description` is required and non-empty.** It is all the
  agent is told about an edge, and a spec constructed in TypeScript without it
  fails to compile. See the
  [changelog](/reference/changelog/).
- **`resolveSystemPrompt(workspace, options)`** assembles the layered system
  prompt. `options.platformBackendPath` is where a workspace may override the
  platform prompt (normally `PLATFORM_PROMPT_PATH`); the prompt that ships in
  the package applies when nothing is served there, and `null` leaves the
  platform layer out, as for a plain agent. `options.workflowPrompt` carries the
  rendered workflow header plus prose the caller composed. `mountPrefixes`
  drives the workspace-zones section. See [what the model reads](/guides/token-efficiency/#what-the-model-reads-in-order).

## Variable references

`${{name}}` / `${{name.dotted.path}}` is resolved by one resolver everywhere it
appears. There are three places it appears:

| Where | How the value lands |
| --- | --- |
| a `tools.allow` guard | glob-escaped, so a value holding `*` matches the literal `*` |
| a sub-workflow argument | verbatim |
| the agent's own tool arguments | verbatim, before governance |

Resolution fails closed. An unset name, a missing path or a non-scalar result
yields no output at all, and the literal text is never passed through in its
place. The resolvers themselves are internal. See
[session variables](/guides/workflow-machine/#referencing-a-variable-in-a-tool-argument).

## Sessions and event delivery

A governed agent resolves which session a firing belongs to, and resumes a session the
agent parked with `archmax_wait`:

```ts
const resolved = await agent.workflow.resolveSession({ trigger, variables, sessionId? });
// { sessionId, disposition: "turn" | "resume" | "reply",
//   startState?, state?, native }       // `state` = where a resume/reply is parked

// or let `send` apply the disposition for you:
await agent.workflow.send(sessionId, { message: text, trigger, variables });

await agent.workflow.deliver(sessionId, {
  trigger: { id: "email_reply" },
  variables: { reply_body: "It's ORD-1001." },
  message: "It's ORD-1001.", // what the person said with the firing, optional
});
```

A delivery may carry the person's **message**. It is appended as their own human
message in the same resume that delivers the firing, right after the `[event]`
note.

One resume means the two arrive together. A session whose park is gone refuses
the delivery with `SessionNotAwaitingInputError` before either is written, and a
crash between two writes cannot separate the message from the arrival. `send`
does this for you, so a turn's message on a session parked with `archmax_wait`
travels with the delivery.

A `reply` disposition means a person holds the session at a human state, so the
firing arrives as a message within the park.
`agent.workflow.reply(sessionId, text)` answers it on a turn with **no tools
bound**, and parks again on the same record: same state, same `seq`, same park
timestamp, same audit trail. So the reported human wait still measures the
original park, however long the conversation runs.

It returns a `ReplyOutcome` carrying `reply`, `state`, `status`, `messages` and
`auditTrail`. It throws `SessionNotParkedError` for a session awaiting no
decision, and `EmptyMessageError` when there is nothing to answer. Routing stays
with `decide` alone, whatever is said in either direction.

`DecideOutcome` and `DeliverOutcome` carry the same `reply` field, so a re-park's
message is there to read off the outcome. All three name the parked state as
`state`. See [a parked
session can still
talk](/guides/workflow-machine/#a-parked-session-can-still-talk).

**A delegated child's park.** A sub-workflow a state called may park at its own
human state. The calling session then parks with it and presents the child's
decision as its own, so `Outcome.kind` is `parked` on the `decision` channel.

`Outcome.delegation` says so and names the child. It is a `DelegatedPark`,
carrying `workflow`, the child's `sessionId`, `identity`, `dispatchId`,
`toolCallId` and the calling `state`. So a host reads one field where it would
otherwise fold `sub-workflow-*` events or shape-test the child's interrupt. A
decision on the parent is handed to that child, and the caller addresses the
parent session throughout.

Where the id comes from is, most specific first:

1. an explicit `sessionId`
2. a per-firing `sessionPath`
3. `createAgent({ sessionPath })`
4. the invoking trigger's `session:` declaration
5. otherwise, an id the runtime mints for the firing

`resolveSession` classifies the firing and invokes nothing, leaving the caller to
invoke the graph or deliver. It needs **no assembly-time option**: the session
path is declared in the workflow, and the id it resolves to *is* the id the
runtime addresses, so there is no mapping to maintain.

Resolving a firing and delivering it fail with typed errors. `resolveSession`
raises the first; the delivery raises the other three:

| Error | Raised for |
| --- | --- |
| `SessionNotResumableError` | a mid-turn session; a session has one writer |
| `SessionNotAwaitingInputError` | a delivery to a session holding no input park |
| `MissingDeliveryTriggerError` | a delivery with no trigger |
| `InvalidVariableNameError` | a delivered variable whose name is an illegal identifier |

A delivered trigger id is *recorded* and matched against nothing. Any id resumes
a park, which is why there is no un-awaited-trigger failure and no awaited-id
list.

`SessionSummary` carries `sessionId` and the open/finished `classification`,
which is where consumers read that partition. An agent park adds `waitReason`,
the reason the agent gave.

A wait that declared an `until` also carries `resumeAt`, as an absolute instant.
Scheduling is the host's, so that instant is what its cron queries. See [sessions
and parked sessions](/guides/sessions/).

## Reserved tool names

The runtime's own tools carry the `archmax_` prefix. Seven are fixed:
`archmax_advance`, `archmax_reset`, `archmax_wait`, `archmax_eval`, `archmax_run`,
`archmax_get_variables` and `archmax_set_variables`. One more,
`archmax_workflow_<slug>`, appears per sub-workflow a state allows.

The namespace is a guarantee rather than a convention, so a tool passed through
`tools` whose name starts with the prefix is rejected at assembly with
`ReservedToolNameError`. For delegation tools, `WORKFLOW_TOOL_PREFIX`,
`workflowToolName(slug)` and `workflowSlugFromToolName(name)` map slug and tool
name in both directions. A host declaring a mock or a governance entry derives
the spelling from those.

`archmax_advance` takes `{ to, reason, evidence? }`. `evidence` is a list of
workspace-relative paths the agent attaches for the person deciding next, and it
is accepted **only** when `to` is a `type: human` state. The paths are merged
after that state's declared `evidence`, in the `PendingDecision` record a host
reads.

Three things are refused back to the agent with the transition left untaken: an
agent target, a path the agent cannot read, and more than 20 paths. See
[human-in-the-loop states](/guides/workflow-machine/#evidence-declared-plus-whatever-the-session-attached).

## Typed sandbox entry point

One package entry point carries the sandbox authoring types (declared in the
package `exports`):

- **`@archmax-ai/harness/sandbox`** holds the verdict helpers `ok` / `veto` /
  `correct`, `defineHook`, and the types `HookInput`, `HookArgs`, `HookMessage`,
  `HookVerdict`, `SandboxTools`, `TrailStep`, for hook scripts:

  ```js
  import { ok, veto } from "@archmax-ai/harness/sandbox";

  /** Vetoes a refund the policy forbids. */
  export default async function hook({ variables, messages, tools }) {
    // …
    return ok();
  }
  ```

The import is a **type carrier only**. The prelude provides the globals, and the
import line is stripped before QuickJS evaluation, so authoring against the bare
globals stays fully valid.

Every import specifier must start with `@archmax-ai/harness/`. Anything else is an
error, flagged by `archmax validate` and rejected at execution. Cases are
[declarative YAML documents](/guides/testing/) interpreted on the
host, which is why they have no entry point of their own here.

## Lifecycle event stream

Every runtime diagnostic flows through one typed stream. Pass `onEvent` to
`createAgent` to receive each `WorkflowLifecycleEvent`, and to silence all
console output. Omit it to get the default console subscriber.

### Envelope

Every delivered event carries, besides its payload and severity `level`:

| Field | Meaning |
| --- | --- |
| `ts` | Epoch milliseconds at emission |
| `seq` | Strictly increasing across all events delivered to the same handler (one assembled agent). Order across *different* agents by `ts`. |
| `sessionId` | The session the event belongs to; present on run-scoped events, absent on assembly-time events (`graph-topology`, `skills-loaded`, …) |

One handler observing concurrent sessions can demultiplex them by `sessionId`.

### Event catalog

| Family | Events |
| --- | --- |
| State movement | `workflow-reset`, `state-enter`, `state-leave`, `state-error-routed`, `advance` |
| Hooks | `hook-start`, `hook-output`, `hook-passed`, `hook-verdict`, `hook-rejected` |
| Parks | `parked`, `decided`, `delivered` |
| Assembly and warnings | `interpreter-enabled`, `skills-loaded`, `hooks-summary`, `graph-topology`, `warning` |

`hook-verdict.verdict` is typed `"ok" | "correct" | "veto"`. Consume it
directly. The `logJudgeVerdict`/`logLifecycleDecision` helpers are removed.

These events are telemetry aimed at GUIs and monitors. The default console
subscriber and the CLI pass over them silently:

| Event | Payload highlights |
| --- | --- |
| `tool-called` | `callId` (the tool-call id, correlating with message history), structured `args`, one-string `detail` hint. Emitted for **every** governed call, including the control tools the runtime services itself: `archmax_advance`, `archmax_wait`, `archmax_reset`, `archmax_get_variables`, `archmax_set_variables`. |
| `tool-result` | Same `callId`, `status` (`ok`/`error`), `durationMs`, `output` preview (capped at 4 KB, `truncated` flag). Blocked calls emit `tool-blocked` instead (nothing ran), carrying the governance `reason` (renamed from `message`). A refused `archmax_advance` settles `error` even though the reply the model reads is not an error message: the status reports whether the session moved. |
| `agent-text` | Complete text of each AI message a turn produced, with that message's `messageId`, always present for a completed message and absent only on a `partial: true` event from a failed turn |
| `agent-text-delta` | Text chunks as the model produces them, attributed to the active state; render live typing without consuming `graph.streamEvents`. Emitted via the graph's native streaming for every session, whether you drive the graph with `invoke` or `stream`; when the model endpoint does not stream (`ARCHMAX_STREAMING=0`), the whole message arrives as one delta. Chunks a dispatched grading rubric generates are attributed to the dispatching state. |
| `rubric-start` / `rubric-result` | Bracket every grading-rubric dispatch (a `{ rubric: … }` hook, which the runtime dispatches itself), paired by `dispatchId`, with the rubric's `name`, `status` and `durationMs`. Operator-facing: they reach no prompt |
| `model-usage` | Per-turn tokens from the provider's own usage metadata: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `model`, and `costUsd` when pricing is configured (the whole event is omitted when the endpoint reports no usage) |
| `prompt-shaping` | Assembly-time summary of the model-facing payload: resolved prompt `profile`, the resolved prompt-cache mechanism, and any built-in tools `withheld` |

A session's total is the caller's to aggregate. `invoke` returning is the end of
the turn, so that return is the signal to read a total; there is no session-end
event to wait for. Use `createUsageTracker()` rather than summing events by hand.
See [Token efficiency and cost](/guides/token-efficiency/):

```ts
import { createAgent, createUsageTracker } from "@archmax-ai/harness";

const usage = createUsageTracker();
const agent = await createAgent({ onEvent: usage.handler });
await agent.invoke(input, { configurable: { thread_id: "t1" } });
usage.totals("t1"); // tokens by kind + costUsd when priced
```

## Session cost

Tokens and cost stay in the SDK, because pricing is a host **input** the runtime
is uniquely placed to apply once. It is the one component that sees per-call
provider usage before it is aggregated. Cost is measured, so with no pricing
configured the SDK reports tokens and omits cost.

### From a session handle

The simplest access path. A session's usage is checkpointed, so this answers for
the whole session, including one that parked and resumed in another process:

```ts
const summary = await agent.sessions.get(sessionId);
summary?.usage;
// { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd? }
```

`costUsd` is present once pricing is configured, through the per-model `pricing`
option or the four environment variables `ARCHMAX_PRICE_INPUT`,
`ARCHMAX_PRICE_OUTPUT`, `ARCHMAX_PRICE_CACHE_READ` and `ARCHMAX_PRICE_CACHE_WRITE`.

A session that has spent nothing omits the `usage` key entirely, since absent and
zero are different facts.

A **parked** session reports what it has spent so far, and keeps accumulating
when it resumes. That is exactly the case a live view wants: "waiting for
approval, $0.08 so far".

### From the event stream, or in process

`createUsageTracker()` folds the stream for in-process consumers, and
`model-usage` carries each turn's tokens for a host that projects events. The
session's total is also written to `sessions/<sessionId>/artifacts/metadata.json` as
`usage`. All three agree.

## Measuring anything else: fold the event stream

Beyond cost, the SDK keeps no ledger. Every diagnostic it observes is already on
the typed event stream, so what a host wants counted is a fold over that stream:
about twenty lines, written once, counting exactly what that host cares about:

```ts
interface RunTally {
  toolCalls: number;
  toolBlocks: number;      // governance refusals
  corrections: number;     // hook `correct` verdicts — rework
  vetoes: number;
  path: string[];          // ordered states
  humanDecisions: number;
}

function tally(): { handler: WorkflowEventHandler; totals: () => RunTally } {
  const t: RunTally = {
    toolCalls: 0, toolBlocks: 0, corrections: 0, vetoes: 0, path: [], humanDecisions: 0,
  };
  return {
    handler: (event) => {
      switch (event.type) {
        case "tool-called": t.toolCalls++; break;
        case "tool-blocked": t.toolBlocks++; break;
        case "state-enter": t.path.push(event.state); break;
        case "hook-verdict": if (event.verdict === "correct") t.corrections++;
                             if (event.verdict === "veto") t.vetoes++; break;
        case "decided": t.humanDecisions++; break;
      }
    },
    totals: () => t,
  };
}

const runs = tally();
const agent = await createAgent({ workflow: "order-lookup", onEvent: runs.handler });
```

Two properties make this the right home for it. The events are the same ones the
runtime acts on, so a fold tracks behavior where a parallel ledger would drift
from it. And a host counts what it needs, such as a per-tenant tool budget or a
per-state SLA, rather than what the SDK guessed it would want.

:::caution
A fold is a **live view** over the events this process observed, so a session
that parked before the process started is invisible to it. Cost is the deliberate
exception: it is checkpointed, and readable from `sessions.get(id)` at any time.
:::


Delivery is a synchronous callback. A slow handler, such as one making a network
hop per event, should buffer internally. That matters most for high-frequency
`agent-text-delta` events.

Frontends render a live transcript from three event families:

- Accumulate `agent-text-delta` chunks into an assistant bubble keyed by
  `messageId`.
- Replace that bubble with the final `agent-text` carrying the same `messageId`.
- Interleave tool activity from the `tool-called`/`tool-result` pair correlated
  by `callId`, with `seq` giving the exact ordering.

A **delta** carries `messageId` when the model reports chunk ids. Where it is
absent, treat a turn's deltas as one running message until its `agent-text`
arrives.

### Joining the stream to a transcript

The ids are the same ids the messages carry. A consumer building a durable
record, rather than a live view, joins the two exactly:

- `tool-called.callId` / `tool-result.callId` equal the issuing AI message's
  `tool_calls[].id` and the settling `ToolMessage.tool_call_id`, whenever the
  provider supplied a call id. An unnamed call gets a generated id, which
  correlates the two events with each other and matches no message.
- `agent-text.messageId` equals the assistant message's `id` for every completed
  message. One event may omit it: a `partial: true` one, holding text accumulated
  before a turn failed with nothing committed.

Every event a call *causes* carries that call's `callId` too, so the events one
call produced can be grouped from ids alone:

| Event | Carries `callId` | Absent when |
| --- | --- | --- |
| `advance` | the `archmax_advance` call that drove the transition | the turn's opening arrival at its state (`from` is the session origin), which no call causes |
| `parked` | the `archmax_wait` call that asked to wait | a human-state park (the session routed there) |
| `variables-set` | the `archmax_set_variables` call that wrote | session-start seeding and trigger delivery |
| `title-set` | the `archmax_set_variables` call that wrote the title | session-start seeding and trigger delivery |
| `sub-workflow-start` / `sub-workflow-result` | the delegation call, as `toolCallId`: an agent's call id or the `ptc:<n>` id of a script's | no tool call started the dispatch |

Because the transition tool is an ordinary call on the stream, a surface that
renders one row per tool call will render one per transition. Filter it there if
you already draw transitions from `advance` / `state-leave`, as the CLI's
state-flow view does.

### `title-set`: the one event carrying a variable's value

`variables-set` carries variable **names only, never values**. A session variable
can hold a whole event payload, and a consumer rendering the stream should be
able to do so without echoing an oversized or sensitive value.

`title-set` is the single exception. It is a separate event rather than a field
on `variables-set`, which keeps that rule unconditional:

```ts
{ type: "title-set", title: string, state?: string, callId?: string }
```

It is emitted whenever the reserved [`title`](/guides/workflow-machine/#two-reserved-names)
session variable takes a new value, through an agent's write, a delivery carrying
one, or session-start seeding. It carries the stored (trimmed) value.

Two fields are conditional. `state` is absent for session-start seeding, and
`callId` is there when a tool call made the write. A refused write emits nothing
at all.

Carrying the value is safe here and nowhere else, because `title` is the one
session variable bounded by its write check: a non-empty single line of at most
200 characters, display metadata by construction.

This is how a host learns a session's title **without touching the checkpoint**.
That matters for a platform that installs its own checkpointer, since the SDK's
session-summary lookup answers for the SDK's own alone:

```ts
createAgent({
  onEvent: (event) => {
    if (event.type === "title-set") void indexTitle(event.sessionId, event.title);
  },
});
```

:::note
`WorkflowLifecycleEvent` is a discriminated union, so an exhaustive `switch` over
it in your own code will surface this new member at compile time. A consumer that
ignores unknown types carries on unchanged.
:::

## State-flow renderer

`createStateFlowRenderer` is exported so third-party frontends can reuse the
runtime's own event-to-line logic when rendering the typed event stream:

```ts
import { createAgent } from "@archmax-ai/harness";
import { createStateFlowRenderer } from "@archmax-ai/harness/cli";

const renderer = createStateFlowRenderer(process.stderr);
const agent = await createAgent({ workflow: "…", onEvent: renderer.onEvent });
```
