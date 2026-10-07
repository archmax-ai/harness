## Context

See proposal.md for why the change is needed. This section describes how the pieces fit today.

- **Where the tool list is chosen.** `wrapModelCall` in `src/workflow/governance.ts` shapes every
  model call. On an ordinary call it filters the bound tools down to the active state's disclosed
  surface (`machine.disclosedTools(state)`). On a reply-only call it sets `request.tools = []`
  instead. LangChain's agent node then binds an empty list, and `ChatOpenAI` sends the request
  with no `tools` field.
- **The disclosed surface is never empty in practice.** `disclosedTools` always contains the
  essential built-ins (the file tools, `write_todos`, `archmax_eval`, `archmax_run`) and the
  always-allowed controls (`archmax_reset`, `archmax_wait`, the two variable tools, and
  `archmax_advance` outside a terminal state). Only a bare `forbid` entry naming a tool removes it
  from the list. The `*` wildcard is enforced by the kernel and leaves the list as it is.
- **Transcripts always carry tool-call pairs.** A runtime note (`runtimeNote` in
  `src/core/messages.ts`) is an `AIMessage` with one `archmax_note` tool call, followed by its
  `ToolMessage`. So an `on_error` route into a human state reaches its reply-only call with an
  `[error]` note in the transcript, even if the agent never called a tool.
- **The reply-only call is already governed.** The kernel's `replyOnlyRule` refuses every
  tool-call action whose `replyOnly` flag is set, ahead of every permitting rule. The PTC gateway
  carries the same flag for script calls.
- **The park already handles a refused call.** After the model, `servePark` does not mark the
  reply spent while the last AI message carries tool calls. The tools node answers the calls with
  their refusals. At the next hook site, `suspendIfParked` finds phase `suspend`, no reply owed
  (the last message is a tool message, not a person's), and no unanswered calls. It then calls
  `interrupt`. No second model call is made.

## Goals / Non-Goals

**Goals:**

- No model request carries tool-call history with an empty tool list, on any park.
- The reply-only turn keeps every guarantee it has today: it cannot act, cannot move the session,
  gets no transitions and no human-state `instructions`, and spends exactly one model call.

**Non-Goals:**

- **Stopping the model from calling tools at the API level** (`tool_choice: "none"`). Not every
  provider behind an OpenAI-compatible endpoint supports it. LiteLLM's Bedrock route refuses
  `tool_choice: "none"` unless `drop_params` is set, which is the same class of failure this change
  removes. The runtime uses only request features that work on every such provider.
- **Retrying a handoff whose model called a tool.** The spec keeps it to one model call. A retry
  would change park timing and spend, and it can be added later if a real model shows the need.
- **A state that forbids every tool by name.** Such a state would still send an empty list with
  tool history on every call, not only on a reply-only one. Getting there takes a bare `forbid`
  entry for each of the fourteen essential and always-allowed tools, and `*` does not do it. No
  real workflow needs that, and it is not worth a rule.
- **Changing the providers' own behaviour or adding provider-specific request shaping.** The fix
  is one uniform rule: the tool list follows the state.

## Decisions

### Hand the reply-only call the parked state's disclosed surface

Delete the `if (replyOnly)` branch in `wrapModelCall`, so both kinds of call run
`request.tools = tools.filter((t) => disclosed.has(t.name))` for the state the session is parked
at. That is the state the reply-only call is already made in, and the state whose model it
already uses.

- *Alternative: flatten tool history to text on a tool-free call.* This would rewrite the
  transcript for one kind of call and break the byte-identical prefix that prompt caching relies
  on. It would also make the reply-only call see a different conversation from every other call.
- *Alternative: bind one placeholder tool on a tool-free call.* This is what LiteLLM's
  `modify_params` does. It invents a tool the kernel knows nothing about, and it is the
  per-provider shim the platform does not want.
- *Alternative: bind only the always-allowed controls.* This would still be a special tool list
  for one kind of call, and the model could call those tools just as well. It buys nothing over
  the state's own list.

### Keep the refusal in the kernel, and say it in the directive

The `tool.reply-only` rule already refuses every call on a reply-only turn, so nothing is added
there. What changes is what the model is told. The directive's closing paragraph moves from
"This turn has no tools: you cannot read, write, move the run, or do any further work" to an
instruction that the model must not call any tool because every call is refused. The rest stays:
it cannot do any further work, and the run stays parked until someone else acts. The kernel's
refusal reason already says the run is parked and to reply in text.

### Transitions stay undisclosed

The graph section is still omitted on a reply-only call. `archmax_advance` may now be in the tool
list outside a terminal state, but the model sees no edge to take, and the kernel refuses the
call anyway. The spec's reason changes from "consistent with being handed no tools" to "because
it cannot move the session".

## Risks / Trade-offs

- [A model that sees tools may call one instead of writing its handoff message. The session then
  parks without that message.] → The directive names the refusal, and the kernel's refusal reason
  tells the model to reply in text. The failure mode is the one that exists today when a model
  invents a call from the transcript: no loop, no extra spend, and the park itself is unaffected.
  A behaviour test pins that the session suspends after a refused call. Task 3.2 runs the reference
  workspace's human-state cases against a live model to check that the handoff still speaks.
- [The reply-only call's input grows by the parked state's tool definitions.] → It is one call
  per park. When the previous call was in the same state, as with `archmax_wait`, the tool list is
  byte-identical to that call's, so the cached prefix can be reused. Today the empty list makes
  the start of the request differ from every ordinary call's.

## Migration Plan

Nothing to migrate. Sessions parked before the upgrade resume normally: a pending reply-only call
simply runs with the state's tools. The release is a patch. The archmax platform upgrades its three
exact pins together.
