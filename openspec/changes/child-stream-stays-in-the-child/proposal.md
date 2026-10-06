## Why

A sub-workflow child's model output reaches its caller's stream as the caller's own text.

A consumer hit this on 2026-10-05/06. On the archmax platform, a `supplier-communication`
session's state `run-invoice-lookup` called `archmax_workflow_invoice-lookup` twice in one tool
batch. Both children answered at the same time, and their tokens reached the platform as one
message of the calling state, interleaved word by word:

```
InvoiceInvoice 159159123123 is is pending pending approval…
```

The platform showed that text as the calling state's activity and in the chat reply. A turn that
failed while a child was streaming would also have finalized the child's text as the caller's
`partial` `agent-text`, which the platform persists into the caller's trace. The platform worked
around it by dropping untagged deltas while a dispatch is open.

The cause is callback inheritance. A child runs inside its caller's tool call, so it inherits the
caller's callbacks through LangChain's ambient config, the `StreamMessagesHandler` of the caller's
own `streamMode: "messages"` stream among them. That handler reports every chat-model run beneath
it, the child's included, into the caller's stream. The caller's turn runner then emits those
chunks from its own context: the caller's `state`, the caller's `sessionId`, no
`subWorkflowDispatchId`. The child's own turn runner already streams the same text correctly
tagged, so every child chunk arrived twice: once as the child's, once as the caller's.

## What Changes

- A child is invoked with its caller's callbacks **minus the caller's stream handlers**
  (`StreamMessagesHandler`, `StreamProtocolMessagesHandler`, `StreamToolsHandler`). Every other
  callback, a host's tracer included, still sees the child's runs, under the same parent run.
  Both dispatch and resume go through the one place that builds a child's config.
- A child's text now reaches the event stream once, from the child's own turn runner, tagged with
  the child's `sessionId` and the dispatch's `subWorkflowDispatchId`. Live child tokens keep
  flowing; they are no longer duplicated as the caller's.
- A caller's partial `agent-text`, emitted when its turn fails mid-stream, holds only the caller's
  own text.
- Grading rubrics are unchanged: a rubric's chunks are still attributed to the dispatching state,
  as documented.
- **Behaviour change for hosts:** the untagged duplicate of a child's text is gone. A host that
  drops untagged deltas while a dispatch is open (the platform's workaround) can delete that
  filter. Event shapes are unchanged.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `runtime`: "Text, usage and variable events" says that a child's text streams only as the
  child's, and that a caller's deltas and partial text are its own.

## Impact

- **Code:** `src/workflow/sub-workflow.ts`. `childConfig` adds `callbacks` from a new
  `callbacksForChild()`, which copies the ambient callbacks and removes the stream handlers.
- **Tests:**
  - `src/behaviour/support.ts`: a `StreamingScriptedModel` that streams replies word by word, and
    a `STREAM_FAILURE` marker that fails the endpoint mid-stream.
  - `src/behaviour/delegation.test.ts`, "a child's streamed text": two concurrent children with a
    streaming and a non-streaming model; a host tracer still sees every child model call; a
    failed caller turn finalizes only its own text as partial.
- **docs/:** `reference/public-api.md`, the `agent-text-delta` row; `reference/changelog.md`, an
  entry for the next release.
- **README.md:** no update. It does not describe text deltas.
- **skills/archmax-harness/:** `references/backend-integration.md`, the `agent-text-delta` row.
- **Release:** a patch (`release` label). The archmax platform then upgrades its three exact pins
  together (`packages/contracts`, `packages/core`, `apps/worker`) and deletes its workaround in
  `packages/core/src/streaming/agui-events.ts`.
