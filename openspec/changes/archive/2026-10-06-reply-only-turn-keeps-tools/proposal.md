## Why

A reply-only turn sends the model an empty tool list, but its transcript still holds tool calls and
their results. Some providers refuse such a request outright. Every park then fails at its
handoff message, before the session suspends.

A consumer hit this on 2026-09-28. On the archmax platform, a session ran on a model served from
Amazon Bedrock through a LiteLLM proxy. Its reply-only turn failed with:

```
400 litellm.UnsupportedParamsError: Bedrock doesn't support tool calling without `tools=` param
specified.
```

Bedrock's Converse API requires tool definitions whenever the messages contain tool-use or
tool-result blocks. OpenAI's Chat Completions API does not, which is why the problem went
unnoticed.

Nearly every transcript has such blocks, even when the model never called a tool: every runtime
note (`[error]`, a decision, a delivered event) is written as a synthetic `archmax_note` tool-call
pair. So on such a provider, every kind of park fails:

- advancing into a human state;
- `archmax_wait`;
- a decision or `on_error` route into a human state, where the `[error]` note alone is enough;
- presenting a delegated child's decision;
- answering a person's message while parked.

## What Changes

- A reply-only turn is handed the parked state's tool list, exactly as any other model call in
  that state would be. The special case that empties it goes away. A model request therefore
  never carries tool-call history without the tool definitions it belongs to.
- The reply-only turn still cannot act. The kernel's `tool.reply-only` rule already refuses every
  call made during one, ahead of every permitting rule. The park already handles a refused call:
  the call gets its refusal, and the session then suspends on its record, without another model
  call.
- The parked directive says every tool call is refused, instead of "This turn has no tools".
- A reply-only turn is still disclosed no transitions, and a human state's `instructions` are
  still withheld.
- **Behaviour change for hosts:** the reply-only model call now carries tool definitions. A model
  that calls a tool instead of writing its message leaves the park without that message, exactly
  as today when a model invents a call. The public API and the events are unchanged.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `runtime`: "The handoff message" no longer says "no tools bound". The directive's closing
  instruction says tool calls are refused.
- `governance`: "No tool is callable during a reply-only turn" hands the model the state's tool
  list and keeps refusing every call. "Per-state graph disclosure" drops its "consistent with being
  handed no tools" clause.
- `cli`: `archmax reply` answers on a reply-only turn, where every tool call is refused, rather
  than "on a turn with no tools".

## Impact

- **Code:**
  - `wrapModelCall` in `src/workflow/governance.ts` drops the `if (replyOnly) request.tools = []`
    branch.
  - `replyOnlyDirective` in `src/workflow/parks.ts` changes its closing paragraph.
  - Comments that say a reply-only turn has no tools: `src/kernel/kernel.ts`,
    `src/workflow/state.ts`, `src/workflow/parks.ts`, `src/workflow/governance.ts`.
  - The `archmax reply` help text in `src/cli.ts`.
- **Tests:**
  - `src/workflow/middleware.test.ts`: "discloses no tools at all" becomes a test that the tools
    are the parked state's.
  - `src/behaviour/parks.test.ts`: the three `tools` assertions expecting `[]`, plus the comment in
    the deliver mock test.
  - A new behaviour test: a model that calls a tool on its handoff turn is refused and the session
    suspends.
- **docs/:**
  - `guides/workflow-machine.md`, "A parked session can still talk": "no tools bound at all" and
    "disclosed no tools".
  - `reference/public-api.md`: the `reply` disposition.
  - `reference/cli.md`: `archmax reply`.
  - `reference/changelog.md`: an entry for the release.
- **README.md:** no update. It does not describe reply-only turns.
- **skills/archmax-harness/:** park behaviour is on the authoring surface.
  - `references/workflow-schema.md`, "A parked run may speak, never act".
  - `references/workflow-yaml.md`: human states.
  - `references/hook-and-test-scripts.md`: the `send` row.
- **Release:** a patch (`release` label). The archmax platform then upgrades its three exact pins
  together (`packages/contracts`, `packages/core`, `apps/worker`).
