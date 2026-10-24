# Design

## Context

Today a state can carry two hook slots, `before` and `after`. Each slot runs a hook script, an
inline grading rubric, or a custom kind registered by the host. The hooks are run by
`LifecycleRunner` (`src/lifecycle/`) at these points:

- In `wrapModelCall`, gated by `beforeDone`.
- Inside `archmax_advance`.
- In `afterModel`, for a terminal state.

Each hook's return is reduced by the kernel into `ok`/`correct`/`veto`, and `iterations` counts
its retries. A hook script's `tools.*` run with `origin: "lifecycle"`: on runtime authority,
captured from the *unfiltered* tool list, so a hook reaches every tool of the assembly. Rubrics
are registered as Deep Agents subagents and dispatched through the `task` tool. See proposal.md
for why both go.

Constraints that shape the replacement:

- One Deep Agent graph per workflow; the machine's position lives in a checkpointed channel.
- `jumpTo: "model"` from `afterModel` goes straight to the model node and **skips** every
  `beforeModel` hook (langchain `ReactAgent` routes it to `AGENT_NODE_NAME`). Several existing
  paths do this: decision routing, `on_error` routes and reply-only closing turns.
- A `wrapModelCall` that returns a `Command` is collected once per middleware layer it passes
  through, so its update can be applied more than once. The runtime already reports
  "no model call happened" with a marker `AIMessage` that `afterModel` strips: the budget
  marker, and formerly the before-veto marker.
- The sandbox REPL freezes its injected tool set at its first evaluation. The agent's REPL
  outlives many states within a turn, so a scoped view (`__archmaxScope`) picks the visible
  tools per evaluation.
- The PTC gateway (`src/sandbox/ptc-gateway.ts`) already governs a programmatic call against a
  per-session live context. That covers the kernel `decide`, the events, the mocks and listing
  redaction.

## Goals / Non-Goals

**Goals:**

- Every step of a workflow is a state on the graph. Every state moves with `archmax_advance`
  and fails with `archmax_raise`, and is governed by its own tool surface.
- One place decides what a state may use, for every state type:
  `WorkflowMachine.disclosedTools(state)` and `checkAllowed`. Agent scripts, code scripts and
  graders read it unchanged.
- Chained code states make no model call. A grader makes model calls of its own, never of the
  session's agent.
- Each automated step is committed as its own checkpointed step.

**Non-Goals:**

- No compatibility path for hooks, rubrics, `max_iterations`, `hookExecutors` or runtime
  contracts `1`/`2`.
- No parking in an automated state. `archmax_wait` and `archmax_reset` are not offered there: a
  script frame is not durable, and a grader judges rather than waits.
- No visit counter or iteration budget for graders. The trail in the history is what a grader
  reads to count rounds.
- No new sandbox runtime and no change to the QuickJS lease model.

## Decisions

### 1. State types and schema

`type` becomes `agent | human | grader | code`. Two keys are removed from the state schema,
`before` and `after`, and with them the hook union, the rubric declaration and the hook path
grammar. The root `extensions` block goes too (it held only `hooks`). The strict schema then
reports a leftover `before:` or `after:` as the unrecognized key it is. That is the error old
workflows get. It is deliberately not a special-cased message, in line with the schema's rule
that a retired spelling reads like a typo.

New key: `script`. It is a workflow-relative path confined to `scripts/` and ending in `.js` or
`.mjs`, with no `..` segment, using the same segment-wise confinement as the old hook path.
`refineSpec` adds two rules, both errors because the runtime cannot run without them:

- A code state must declare `script`.
- No other type may declare `script`.

`lint-spec` adds errors for keys a type never reads. These follow the existing pattern for
human states: the runtime tolerates them and `validate` fails.

- **code:** `instructions`, `model`, `budget`, `evidence`, `approvers`.
- **grader:** `evidence`, `approvers`, `budget.maxParks`. A grader must also have non-empty
  `instructions` and at least one transition. Like a human state, a grader decides, and a
  grader with nowhere to send the run could only approve by silence, which fails open.
- **automated states:** a `tools.allow` entry naming a tool an automated state never offers is
  an error. Those tools are `write_todos`, `archmax_eval`, `archmax_run`, `archmax_wait` and
  `archmax_reset`.

*Alternative considered:* one schema per type (a discriminated union). Rejected: the state
object stays strict and readable as one mapping, error messages keep the issue path the
loader already produces, and the type-dependent rules are few.

### 2. Type-aware tool surfaces in the machine

`WorkflowMachine` gains `stateType(state)`, `isAutomatedState(state)`, `isCodeState` and
`isGraderState`. Its existing derivations become type-aware in one place:

- **Essential tools.** Agent and human states get `ESSENTIAL_TOOLS` plus the host's
  `essentialTools`. Automated states get the same set minus `AGENT_ONLY_TOOLS`
  (`write_todos`, `archmax_eval`, `archmax_run`).
- **Control tools** (`controlTools(state)`):

  | Type          | Control tools                                                         |
  | ------------- | --------------------------------------------------------------------- |
  | agent / human | advance, reset, wait, raise, get variables, set variables (as today)  |
  | code          | advance, raise, get variables, set variables                          |
  | grader        | the code set plus `archmax_get_history`                               |

  `checkAllowed` passes a tool in the state's control set, replacing the unconditional
  `ALWAYS_ALLOWED_TOOLS` check. `disclosedTools` adds the control set, and omits
  `archmax_advance` in a terminal state.
- **Own entries.** In an automated state, `effectiveEntries` drops an own entry that names an
  agent-only tool. The lint above reports it.

`archmax_get_history` joins `HARNESS_CONTROL_TOOLS`. It is therefore reserved, PTC-excluded
from agent scripts, and offered only where the control set names it.

*Why:* the kernel's `stateToolsRule`, prompt disclosure, the PTC listing and an automated
state's tool list all read these two answers, so "what a code state may call" cannot drift
between enforcement and what the script sees.

### 3. Where an automated state runs: serviced in place of the model call

`governance.wrapModelCall` is the one point every model call crosses. That includes the
`jumpTo: "model"` paths that skip `beforeModel`. When the session's position is an automated
state and the turn is not reply-only, `wrapModelCall` does not call the agent's model. It runs
the state, which is one step, and returns a **marker `AIMessage`** whose `additional_kwargs`
carry the step's serializable outcome (`AutomatedOutcome`). Then `afterModel` takes over:

1. It removes the marker (`RemoveMessage`).
2. It commits the outcome: the variables delta, the trail steps, the grader's usage, the
   transition or the raise, and the runtime note.
3. If the session moved, it jumps back to the model with `jumpTo: "model"`. The next state's
   call reaches `wrapModelCall` again. If that state is automated, it is serviced the same way
   with no model call. If it is an agent state, it gets the real call. If it is a human state,
   the call is the park's reply-only handoff. A finished terminal state instead falls through
   to the ordinary completion path: the `returns` check, then `completed`.

The outcome is in the marker rather than in process memory. The model node's commit and
`afterModel` are separate checkpointed steps, so a process that dies between them replays
`afterModel` against a marker that still carries what to commit.

*Alternatives considered:*

- **Run in `beforeModel`.** Misses every `jumpTo: "model"` path. A decision routing into a
  code state would call the agent's model in a code state.
- **Return a `Command` from `wrapModelCall`.** Each middleware layer collects it, so the
  update would be applied twice.
- **Run the whole chain inside one call.** One step per graph iteration is checkpointed per
  step, and the session's recursion limit bounds a runaway automated cycle exactly as it
  bounds a runaway agent loop. No new counter or setting is needed.

`beforeModel` skips the turn budget (`budget.maxTurns`) for an automated position: no agent
call is made there.

### 4. The outcome vocabulary and how it commits

An automated run settles into exactly one result:

| Run settles as                                                     | Result      |
| ------------------------------------------------------------------ | ----------- |
| Called `archmax_advance` and the run finished cleanly              | `advanced`  |
| Called `archmax_raise`                                             | `raised`    |
| A terminal state finished without either call                      | `completed` |
| Threw an error, timed out, exhausted its budget, or a non-terminal state finished undecided | `failed` |

`raised` wins over an error, and an error discards a recorded advance. The decision is
recorded when its tool call is accepted and applied only when the run settles. So a script
that advances and then throws fails, and nothing moves.

How each result commits:

- **`advanced`** commits through the same transition update the agent's `archmax_advance` now
  uses, factored out of `handleAdvance` as `transitionUpdate`. The trail step is
  `kind: "grader" | "code"`. A human target gets its park record. Because the commit happens
  in `afterModel` with `jumpTo: "model"`, which skips `beforeModel`, the park is opened
  directly in its closing turn (`parkPhase: "suspend"`, `replyOnly: true`), as `routeFailure`
  already does for a human `on_error` target.
- **`raised`** commits the raise record and `status: failed` with no jump, so the turn ends.
- **`failed`** goes through `routeFailure`: to `on_error`, or the session ends rejected.

Every result except `completed` adds a runtime note of kind `grader` or `code`. The note
carries the reason: for a send-back, it is the correction the agent reads.

### 5. The controls an automated state calls

An automated state's control tools are real `StructuredTool`s built for each run and bound to a
**step recorder**. The recorder holds the live variable view (the store plus this run's delta)
and the one decision. The tools reuse the agent path's schemas and handlers:

- `archmax_advance`:
  - Refused if a decision was already made.
  - Validated immediately with the kernel's `transition` verdict (`requires` plus the edge)
    against the live store, and refused as a rejection the script or grader can handle.
  - Evidence is accepted only into a human state.
  - Records the decision and its call id.
- `archmax_raise`: refused after a decision; records a raise.
- `archmax_get_variables` and `archmax_set_variables`: `handleGetVariables` and
  `handleSetVariables` run against the live view. That includes locks, the `title` rules, typed
  returns and `file` returns. An accepted write merges into the delta and emits
  `variables-set`/`title-set`.
- `archmax_get_history` (grader only): returns `{ messages, trail }`. The message entries keep
  the plain shape hooks used to receive (`role`, `text`, `toolCalls?`, `tool?`, `note?`).
  Nothing is windowed.

Every tool an automated state is offered, controls included, is wrapped by the PTC gateway.
The gateway's live context is first refreshed to the automated state. So every call runs the
kernel `decide`, which means a `tools.forbid` can deny even a control. Every call emits the
paired tool events and honours mocks the way any programmatic call does. The control tool
bodies emit the effect events, `advance`, `raised`, `state-leave`/`state-enter` and `parked`,
only when the run settles. They carry the recorded call id, which keeps the `callId` pairing
rule.

### 6. Code states

The script is read from the authoring backend: `workflows/<slug>/scripts/…`, resolved by
`resolveCodeScript`, which replaces `resolveHookScript`. It runs in the shared QuickJS runtime,
in a **fresh REPL namespace per run** (`code`), disposed when the run settles. A fresh REPL
means the injected `tools` are exactly this state's and nothing leaks between code states.

The new sandbox context `code` replaces `lifecycle-hook`. It has its own contract marker, the
`defineCodeState` registration alias, the same `export default` rewrite and import stripping,
and the same scoped `tools` view the PTC context uses. So `tools.read_file` and
`tools.readFile` both resolve, and only the surface is listed.

The default export is called with `{ state, trigger, variables, messages, trail, tools }`, and
a bare-body script simply runs. The return value is not read. Console lines become
`code-output` events, and the run is bracketed by `code-start`/`code-result`.

The script's tools are origin `script`. They are governed against the code state exactly like
an `archmax_run` script in an agent state: its allow and forbid lists, and its skill and mount
grants. The `lifecycle` origin is gone.

### 7. Grader states

A grader is a langchain `createAgent` built per run. It takes:

- **Model:** the state's model, resolved per state at composition through the new `grader`
  role: `modelFactory("grader", env, id)`, or with no factory the env model at that id or the
  workflow's model. This replaces the `rubric` role.
- **System prompt:** a compiled-in grader preamble followed by the state's `instructions`.
- **Task message:** the state's transitions, rendered with the same line format the graph
  section uses.
- **Tools:** the grader state's surface, wrapped by the gateway with `origin: "agent"`, plus
  the recorder controls.
- **Middleware:** one grader middleware. It:
  - Applies `${{…}}` argument substitution, as the agent's own calls get it.
  - Turns a refused or failed call into an error `ToolMessage`.
  - Ends the grader loop as soon as a decision is recorded.
  - Enforces `budget.maxTurns` (the grader's own model calls) and `budget.timeoutMs`.
  - Emits `model-usage` under the grader state.
- **Invocation:** `checkpointer: false` and the tag `langsmith:nostream`. So the grader's
  tokens never stream as the session's `agent-text-delta`, and the grader writes no
  checkpoint into the session's thread.

The grader's context is isolated. It reads the session only through `archmax_get_history`, and
its own messages never enter the session's transcript. What it decided reaches the session as
the trail step and the runtime note.

The Deep Agents `task` tool still exists (Deep Agents always builds its general-purpose
subagent). It stays ungrantable and undisclosed, and its refusal message now points at grader
states and sub-workflows. No subagent is registered by the assembly any more.

### 8. Agent PTC restricted to the state's surface

In the PTC prelude's scoped `tools` view, `get` now resolves only names inside the surface,
matching `has` and `ownKeys`. `tools.write_file` in a state that does not grant it is
`undefined`. Before, it was a function that reached governance and was refused. The kernel
still decides every call, so the two gates stay independent.

### 9. Origins and the runtime authority

`ToolCallOrigin` becomes `agent | script | runtime`. `runtime` is used only by the runtime's
own `file`-value read check (`runtimeReadDenial`). It keeps today's semantics: outside the
state's surface, held to the workflow's own grants and every workflow-wide denial. The mount
and skill refusal wording that named hooks now names the runtime's reads.

### 10. Removed machinery

| Removed                                                                        | Notes                                                                                    |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `src/lifecycle/` and `src/rubrics/`                                            | The transcript view moves to `src/workflow/history.ts`.                                  |
| Kernel `HookFact`, `reduceHookFact`, `enter-state` and the transition `hookFacts` | —                                                                                     |
| `iterations` and `beforeDone` channels                                         | Along with every reset of them (turn boundary, `archmax_reset`).                         |
| `hooks-summary`, `hook-*` and `rubric-*` events                                | —                                                                                        |
| Rubric subagent registration and the `rubricModel` context                     | —                                                                                        |
| `hookExecutors`, `HookExecutor` and `BUILTIN_HOOK_KINDS`                       | —                                                                                        |
| Runtime note kind `after`                                                      | Replaced by `grader` and `code`.                                                         |
| `runContextFromMessages`                                                       | Only rubrics used it.                                                                    |
| Runtime contracts `1`/`2` and the `lifecycle-hook` sandbox context             | Contract `3` (sandbox `3`) is the only supported one and the default.                    |

### 11. Reference workspace

`order-lookup` becomes:

- **`screen-request`** (code, the entry for `manual`/`email_reply`): runs
  `scripts/screen-request.js`, which merges the requester and tenancy checks. It advances to
  `identify-case`, or to `decline` (a terminal agent state that tells the person why) with the
  reason.
- **`refund-request`** advances to **`check-refund`** (code, `scripts/check-refund.js`). That
  state advances to `refund-review` when the recorded decision matches the policy. Otherwise
  it sends the run back to `refund-request` with what is wrong.
- **`orders-question`** advances to **`review-reply`** (a grader with the former tone criteria).
  The grader approves to **`answered`**, a terminal code state that records the approved reply
  in `scratchpad/answer.json`. It sends the run back with the correction, or raises after two
  send-backs, which it reads from the trail.

## Risks / Trade-offs

- **[A runaway cycle of automated states, e.g. two code states advancing to each other.]** →
  It is stopped by the session's recursion limit like any runaway turn, which raises
  `GraphRecursionError` rather than routing through `on_error`. This is documented. An
  intentional bounded loop (a counter in a variable) keeps working.
- **[Breaking every workspace that uses hooks, or that declares `runtime.version` `1`/`2`.]**
  → The load errors name the key and path, or the unsupported contract and the supported set.
  The changelog and the authoring skill carry the rewrite recipe:
  - `before` checks become a code state in front of the state.
  - `after` checks become a code state behind it.
  - A rubric becomes a grader state.
- **[A grader is fail-open if it answers in text without deciding.]** → A non-terminal grader
  that finishes undecided fails closed (`on_error`). A grader must declare at least one
  transition, so there is no approve-by-silence terminal grader.
- **[A send-back loop between an agent and a grader has no runtime bound.]** → This is by
  request: the grader reads the rounds in the trail and raises. The session's recursion limit
  remains the backstop.
- **[An extra model call for "approve then end".]** → Approve into a terminal **code** state.
  It completes the session with no model call. The example records the approved reply there.
- **[Full history passed to graders and code scripts can be large.]** → It is bounded by the
  sandbox's result and memory quotas (`maxResultChars`, `memoryLimitBytes`) and by the grader
  model's context. It is not windowed, because a grader counting rounds needs all of it.

## Reference: names and shapes

The one vocabulary the specs, code, docs and skill use for this change.

### Spec, scripts and tools

| Concept | Name / shape |
| --- | --- |
| State types | `agent` (default), `human`, `grader`, `code`. Collective name for `grader`/`code`: **automated state** |
| Code state key | `script: scripts/<file>.js` (or `.mjs`). Workflow-relative, confined to `workflows/<slug>/scripts/`, no `..` |
| Code script input (and the global `args`) | `{ state, trigger?, variables, messages, trail }`. The default export receives the same object plus `tools` |
| History message shape | `{ role: "user"\|"assistant"\|"tool"\|"system"\|"runtime", text, toolCalls?: {name,args}[], tool?, note? }` |
| History | `archmax_get_history` returns JSON `{ messages: HistoryMessage[], trail: TrailStep[] }`. It is the full transcript and full trail, not windowed |
| New control tool | `archmax_get_history`: no arguments, offered in grader states only |
| Automated state controls | advance, raise, get variables, set variables (+ `archmax_get_history` for graders) |
| Tools no automated state offers | `write_todos`, `archmax_eval`, `archmax_run`, `archmax_wait`, `archmax_reset` |

### Sandbox and assembly

| Concept | Name / shape |
| --- | --- |
| Sandbox contexts | `ptc` (agent's `archmax_eval`/`archmax_run`), `code` (a code state's script). `SANDBOX_CONTRACT.context` is one of these |
| Authoring alias | `defineCodeState(fn)` (identity, registers the default export). Types: `CodeStateInput`, `CodeStateFn`, `HistoryMessage`, `TrailStep`, `SandboxTools` from `@archmax-ai/harness/sandbox` |
| Tool-call origins (kernel) | `agent` (a model: the session's agent or a grader), `script` (an agent's sandbox script or a code state's script), `runtime` (the runtime's own `file`-value read check) |
| Tool event `origin` | absent for a model's call, `"script"` for a programmatic call |
| Model role | `ModelRole = "agent" \| "judge" \| "grader"`. A grader state's model is `modelFactory("grader", env, stateModelId)` |
| Runtime contract | `archmax-harness@3` only; omitted metadata resolves to `3`; sandbox contract version `3` |

### Trail, notes and outcomes

| Concept | Name / shape |
| --- | --- |
| Trail step kinds | `trigger`, `agent`, `human`, `grader`, `code`, `sub-workflow`, `reset`, `on_error` |
| Runtime note kinds | `decision`, `event`, `error`, `grader`, `code`, `sub-workflow`, `opening` (`after` removed) |
| Note text (advance) | `[grader] The '<state>' grader moved the run to '<to>': <reason>. You are now in '<to>'.` / `[code] '<state>' moved the run to '<to>': <reason>. You are now in '<to>'.` |
| Note text (raise) | `[grader] The '<state>' grader ended the session as failed ('<code>'): <reason>` / `[code] '<state>' ended the session as failed ('<code>'): <reason>` |
| Undecided failure reason | `<type> state '<state>' finished without calling archmax_advance or archmax_raise` |

### Events

| Event | Payload |
| --- | --- |
| `code-start` | `{ state, script }` |
| `code-output` | `{ state, line }` |
| `code-result` | `{ state, status: "ok"\|"error", durationMs, reason? }` |
| `grader-start` | `{ state }` |
| `grader-result` | `{ state, status: "ok"\|"error", durationMs, reason? }` |
| Removed | `hooks-summary`, `hook-start`, `hook-output`, `hook-passed`, `hook-verdict`, `hook-rejected`, `rubric-start`, `rubric-result` |

`status` is `ok` when the run settled on a decision or a completion, and `error` when it
failed.
