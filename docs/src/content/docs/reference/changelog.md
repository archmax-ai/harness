---
title: Changelog
description: One section per release, newest first, saying what changed and where the current behaviour is documented.
sidebar:
  order: 6
---

Newest first. Each section says what changed and links to the guide that describes the behaviour
as it is today; the guides themselves describe only the present. Every release also has
[GitHub release notes](https://github.com/archmax-ai/harness/releases) listing its pull requests.

## 0.2.0 (unreleased)

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
