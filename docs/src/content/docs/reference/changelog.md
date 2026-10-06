---
title: Changelog
description: One section per release, newest first, saying what changed and where the current behaviour is documented.
sidebar:
  order: 6
---

Newest first. Each section says what changed and links to the guide that describes the behaviour
as it is today; the guides themselves describe only the present. Every release also has
[GitHub release notes](https://github.com/archmax-ai/harness/releases) listing its pull requests.

## 0.3.1 (unreleased)

- **A sub-workflow child's streamed text is no longer reported as its caller's.** A child runs
  inside its caller's tool call and inherited the caller's callbacks, the handler of the caller's
  own stream among them, so every token a child's model produced was also emitted as an
  `agent-text-delta` of the calling state, with no `subWorkflowDispatchId`. Two children
  answering at once interleaved word by word into the caller's reply, and a caller's turn that
  failed while a child streamed finalized the child's text as the caller's `partial`
  `agent-text`. A child is now invoked without its caller's stream handlers: its text streams
  once, from its own session, tagged with the dispatch; the caller's deltas are its own. Every
  other callback a host hands down, a tracer included, still sees the child's runs. **For
  hosts:** the untagged duplicate of a child's text is gone and the event shapes are unchanged;
  a filter that dropped untagged deltas while a dispatch was open can be deleted. See
  [sub-workflow observability](/guides/sub-workflows/#observability).
- **The platform prompt says that text alone ends the turn.** GPT-6 Luna wrote the message a
  state asked for and stopped, without the `archmax_advance` or `archmax_wait` its
  instructions put after that message: a refund never reached its review, a clarifying question
  never parked. The prompt now says that a message without a tool call ends the turn and that the
  text and the call belong in the same message. A workspace that overrides the platform prompt
  (`.platform/system/GRAPH_STATE.md`) should add the rule.
- **The platform prompt is a fifth shorter** (2,232 → 1,771 tokens, `o200k_base`), with the same
  rules: repeated contrasts, generic tool-use explanation and rationale the model does not act on
  are gone, and waiting, deciding and failing are one list.

## 0.3.0

- **The agent can end a session as a failure: `archmax_raise({ code, reason })`.** A new control
  tool, offered in every state (terminal ones included) and never declared, for work that cannot
  be completed: a system the work depends on keeps failing, the thing asked about does not exist.
  `code` is the agent's own short token (`orders-unavailable`), `reason` says what failed. The
  call must stand alone in its message, and it ends the session at once with the new status
  `failed`: no further model call, no `on_error` route, no hook, no `returns` check, and a
  rejection still pending from earlier in the turn is replaced. A session that ends without it is
  a success, so the tool is for failure only; the tool description and the platform prompt tell
  the model to recover first and never to use it in place of `archmax_wait`, `archmax_reset` or a
  human state. Forbid it with `tools.forbid_always: [archmax_raise]` (or a state's
  `tools.forbid`). A child session that raises fails its caller's delegation call with the kind
  `raised`, naming the code and reason. The CLI reports `✖ failed` with the code and exits 1;
  cases gain the structural `raised` assertion, and `succeeded: true` fails on a raise.
  **For hosts:** `Outcome.kind` and `WorkflowStatus` gain `failed`, which is **finished**; a switch
  over either that must be exhaustive needs the new member, and code that read "not `rejected`"
  as success must now check for `failed` too. Every finished outcome the agent ended carries
  `exit` (`SessionExit`): `{ success: true }` when completed, `{ success: false, code, reason }`
  when failed; `SessionSummary` carries the same record for a failed session, and the `raised`
  event (`state`, `code`, `reason`, `callId`) precedes the closing `state-leave`. A workspace that
  overrides the platform prompt (`.platform/system/GRAPH_STATE.md`) should add the new "When the
  work fails" section. See
  [ending a session as a failure](/guides/workflow-machine/#ending-a-session-as-a-failure),
  [how a session ended](/guides/sessions/#how-a-session-ended) and
  [`on_error`](/reference/machine-spec/#on_error).
- **A script lists only its state's tools.** In `archmax_eval` and `archmax_run`, `tools` used to
  list every tool the assembly registered, whatever the state allowed: `Object.keys(tools)` in a
  state with two tools printed all 120 of a connected MCP server's. The calls were governed, the
  names were not. `tools` now lists exactly the tools the model's own tool list carries in the
  state the script's calls are governed against, re-scoped at the start of every evaluation, so
  after an advance the same REPL lists the next state's tools. It stays one object, so a helper
  or a reference kept from an earlier call follows along. A tool the state does not offer is
  unlisted but still resolves by name, and calling it is refused with governance's reason, as
  before. Lifecycle hooks are unchanged: they run on runtime authority and list every tool.
  **For hosts and authors:** nothing to change; a script that enumerated `tools` now sees fewer
  names, and every call is decided as before. See
  [the code interpreter](/guides/code-interpreter/).

## 0.2.1 (unreleased)

- **A parked session's handoff works on providers that refuse tool history without tools.** The
  reply-only model call a park spends (the handoff into a human state or an `archmax_wait`, a
  decision routed into another human state, a delegated child's decision, a reply to a parked
  session) used to send an empty tool list beside a transcript full of tool calls, and every
  runtime note is one. Amazon Bedrock refuses that request (through LiteLLM:
  `Bedrock doesn't support tool calling without tools= param specified`), so every park failed
  there. The call is now handed the parked state's tool list, like any other call in that state.
  It still cannot act: the kernel's `tool.reply-only` rule refuses every tool call it makes, and a
  model that calls one instead of writing its message leaves the park without that message and
  without a second model call. **For hosts:** the reply-only request now carries tool
  definitions; the public API and the events are unchanged. See
  [a parked session can still talk](/guides/workflow-machine/#a-parked-session-can-still-talk).

## 0.2.0

- **A failing tool is answered to the model, not thrown out of the turn.** When a tool the agent
  calls throws (a dropped remote connection, a flaky API, a filesystem error), the call is
  answered with an error-status tool message carrying the error's message. The session stays in
  its state, the next model call reads the failure, and the answers to sibling calls of the same
  step are kept. A tool failure is not a turn failure and never routes through `on_error`.
  **Behaviour change for hosts:** a turn that used to reject from `agent.workflow.send` on a tool
  failure now continues. Read tool failures from the `tool-result` event, which still settles
  `error` with the message as its preview. Parks and cancelled runs propagate as before, and a
  script's `tools.*` call still throws to the script. See
  [tool governance](/guides/workflow-machine/#tool-governance) and
  [`on_error`](/reference/machine-spec/#on_error).
- **Typed trigger signatures.** A `requires`/`returns` entry may be `{ name, type?, description? }`
  beside the bare name, which stays valid and untyped. `type` is one of `string`, `integer`,
  `number`, `boolean`, `date`, `date-time`, `object` or `array`. The runtime holds a typed entry
  at the turn boundary, at `archmax_set_variables`, at completion and across a delegation, which
  gains the refusal kind `invalid-param` and the failure kind `invalid-return`. The delegation
  tool's schema carries each parameter's type and description, and an argument that is exactly one
  `${{…}}` reference keeps the referenced value's type. A trigger declaration may carry a
  caller-facing `description`, which leads the delegation tool's description and never reaches the
  session's own model. `@archmax-ai/harness/spec` (and the root) export `SIGNATURE_TYPES`,
  `normalizeSignature`, `signatureForTrigger`, `signatureJsonSchema` and `signatureValueIssues`, so
  a host builds MCP tool schemas, start forms and request validation from the rule the runtime
  enforces. Additive: every existing spec loads and behaves as before. **For hosts:** a spec that
  uses an object entry does not load on an earlier version, so upgrade every host that reads a
  workspace to this release before its specs use typed entries, and read signature lists through
  `normalizeSignature` rather than as `string[]`. See
  [typing a signature](/guides/triggers/#typing-a-signature),
  [the signature reference](/reference/machine-spec/#the-signature-requires-and-returns) and
  [building a host schema](/reference/public-api/#building-a-host-schema-from-a-signature).
- **No warning for a model the runtime places no cache marker for.** Assembly used to warn that
  "prompt caching is inactive" on every turn for any model that is not Claude or Bedrock Nova,
  including OpenAI, Gemini and OpenAI-compatible proxy aliases, which cache a stable prefix
  automatically. That warning is gone. The `prompt-shaping` event still names the strategy
  (`unsupported`), `cacheReadTokens` on `model-usage` events shows whether the provider caches,
  and the warning for a state whose model wants a different native caching mechanism stays. See
  [prompt caching](/guides/token-efficiency/#prompt-caching).
- **A rejected session fails the CLI command.** `archmax run`, `decide` and `deliver` used to print
  `✔ answer` and exit 0 for a session that ended rejected, such as a start refused for a missing
  input. They now print `✖ rejected` and the reason on stderr and exit 1, as the CLI reference
  always promised. `Outcome` and `DecideOutcome` gain `rejected`, the reason, so a host reads why
  without reaching into the checkpoint. See the [CLI reference](/reference/cli/#archmax-run).

## 0.1.0: first public release

The first release of `@archmax-ai/harness`: a governed layer over LangChain Deep Agents.

- **One `workflow.yaml` per workflow** is the enforced state machine: states, transitions,
  per-state `allow`/`forbid` governance for tools, skills and mounts, `before`/`after` hooks,
  budgets, error routing and triggers. See the [workflow machine guide](/guides/workflow-machine/)
  and the [machine spec reference](/reference/machine-spec/).
- **Human states and waits** park a session durably; `decide`, `reply` and `deliver` resume it.
  See [sessions](/guides/sessions/).
- **Hooks and the sandbox**: hook scripts, `archmax_eval` and `archmax_run` share one QuickJS
  sandbox with a governed tool bridge. See the [code interpreter guide](/guides/code-interpreter/).
- **Cases** (`archmax test`) and rubric grading. See [testing](/guides/testing/) and
  [grading rubrics](/guides/grading-rubrics/).
- **Sub-workflows**, **skills** and **triggers**: see [sub-workflows](/guides/sub-workflows/),
  [skills](/guides/skills/) and [triggers](/guides/triggers/).
- **The `archmax` CLI** (`run`, `test`, `validate`, `sessions`, `decide`, `reply`, `deliver`). See
  the [CLI reference](/reference/cli/).
- **The library API**: `createAgent` and the `sandbox`, `testing`, `cli`, `spec` and `messages`
  subpaths. See the [public API reference](/reference/public-api/).
