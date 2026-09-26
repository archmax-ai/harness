## Why

When a tool bound into a governed agent throws, the whole turn fails. The tool might be a remote
tool whose connection drops, a flaky HTTP API or a filesystem call. The error escapes
`agent.workflow.send` as an exception. The model never sees the failure, so it cannot retry,
switch tools or say what it could not do. The results of sibling calls made in the same step are
lost with the turn.

Nobody designed this. Without middleware, LangChain's tool node answers a failing tool with an
error-status tool message. It re-raises only errors that come *out of middleware*. The workflow
middleware's `wrapToolCall` emits the call's `tool-result` event and then rethrows what the tool
threw, so every tool failure turns into a middleware failure. The documented turn failures that
`on_error` routes are an exhausted budget, a timed-out model call, a hook error, exhausted
corrections, a terminal kernel block and a rejected sub-run. A tool failure is not on that list.
Yet it ends the turn, and it never even reaches `on_error`.

A consumer hit this on 2026-09-26. On the archmax platform, a scheduled research session ran four
web searches in parallel. One failed after 51 s with `MCP error -32000: Connection closed`. The
turn ended failed, although the three sibling searches had succeeded and the model could easily
have searched again.

## What Changes

- When a governed tool call's tool throws, the runtime answers the call with an error-status tool
  message that carries the error's message, as it already does for a blocked call. The session
  stays in the active state, and the next model call sees the failure in its transcript. The
  call's `tool-result` still settles `error`, with the message as its preview, so the event stream
  is unchanged.
- Signals still propagate unchanged. These are LangGraph interrupts and the other bubble-up
  signals (a park, a delegated child's park, a parent command), plus any failure raised after the
  run's abort signal has fired (a cancellation).
- These paths are unchanged:
  - The control and delegation tools the runtime services itself. Their refusals and failures
    already have defined answers.
  - Script-origin `tools.*` calls. The script still receives a throw it can catch.
  - Lifecycle-origin calls. A hook whose tool call fails still fails closed.
- **Behaviour change for hosts:** a turn that used to throw on a tool failure now continues. The
  public API does not change, and there is no option to restore the old behaviour.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `runtime`: a new requirement says that a failed tool call is answered to the model rather than
  thrown out of the turn. It names the signals that still propagate and the origins it does not
  cover.

## Impact

- **Code:** the catch in `wrapToolCall` in `src/workflow/governance.ts`. Tests: the existing test
  "reports an error result and rethrows when the tool throws" in `src/workflow/middleware.test.ts`
  becomes an "answers" test, and a behaviour test under `src/behaviour/` drives a whole turn
  through a throwing tool.
- **docs/:**
  - `reference/machine-spec.md` (`on_error`): a tool failure is not a turn failure.
  - `guides/workflow-machine.md`: where governed tool calls are described.
  - `reference/public-api.md`: the `tool-result` row. A throwing tool settles `error`, and the
    model reads the failure.
  - `reference/changelog.md`: an entry for the release.
- **README.md:** no update. It says nothing about tool failures or `on_error`, and this is a
  behaviour fix below its level of detail.
- **skills/archmax-harness/:** this is governance behaviour on the authoring surface.
  - `references/workflow-yaml.md`: `on_error` semantics. A failing tool is answered, not routed.
  - `references/backend-integration.md`: what a host sees when a tool fails. The turn continues,
    and a `tool-result` event with status `error` is emitted.
- **Release:** a patch (`release` label). The archmax platform then upgrades its three exact pins
  together (`packages/contracts`, `packages/core`, `apps/worker`). Its own boundary for bounding
  tool errors keeps sanitizing the message.
