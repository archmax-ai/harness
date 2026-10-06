## Context

See proposal.md for why the change is needed. This section describes how the pieces fit today.

- **How a turn streams.** `drive()` in `src/workflow/turn-runner.ts` runs the graph with
  `streamMode: ["values", "messages"]`. For `messages`, LangGraph attaches a
  `StreamMessagesHandler` to the run's callbacks as an inheritable handler. It reports every
  chat-model run beneath the run, token by token (`handleLLMNewToken`), whole on a non-streaming
  call (`handleLLMEnd`), and the messages a graph node returns (`handleChainEnd`, deduplicated by
  message id).
- **How a child runs.** A delegation call is serviced inside the caller's `tools` node. The
  dispatcher invokes the child's turn runner with `childConfig(parent, …)`, built from the
  caller's `configurable`, `signal` and `store` only. The child's graph then fills every key the
  config leaves unset from LangChain's ambient config (`ensureConfig` reads
  `AsyncLocalStorageProviderSingleton`). That ambient config is the caller's tool run, so its
  callbacks, the caller's stream handler among them, become the child's parents.
- **What a leaked chunk looks like.** Measured in a probe: a child chunk reaching the caller's
  runner carries `thread_id` equal to the **caller's** session id (LangGraph copies
  `configurable.thread_id` into metadata only when the key is absent, and the inherited metadata
  already holds the caller's). Its `langgraph_checkpoint_ns` is `model_request:<task>`, the same
  shape as the caller's own, because a child's `checkpoint_ns` is cleared. The chunk the child's
  own runner receives is indistinguishable.

## Goals / Non-Goals

**Goals:**

- A child's text never reaches its caller's turn runner, by any of the handler's three paths.
- The child's own deltas keep flowing, tagged with its session and dispatch.
- A host's other callbacks (tracing, metering) keep seeing the child's runs, under the same
  parent run.

**Non-Goals:**

- **Rubrics.** A rubric runs through `task` inside the runtime, and its chunks are documented as
  attributed to the dispatching state. That is a separate decision and stays.
- **`streamEvents` consumers.** LangChain's event-stream handler is not a stream-mode handler
  and still sees a child's runs as nested runs, which is what an event-stream consumer expects.
- **The other two requests from the same report** (a child's title and input round trips; a
  missing return with no second chance). They are independent of this one.

## Decisions

### Remove the caller's stream handlers from the callbacks a child inherits

`childConfig` sets `callbacks` explicitly, so `ensureConfig` takes it instead of the ambient
value. `callbacksForChild()` reads the ambient callbacks, copies a `CallbackManager` (or filters
an array), and removes every handler whose `name` is one of LangGraph's stream-mode handlers:
`StreamMessagesHandler`, `StreamProtocolMessagesHandler` (the v3 protocol) and
`StreamToolsHandler` (`streamMode: "tools"`). The copy keeps the parent run id, tags and metadata,
so tracing nests exactly as before. The child's own runner attaches its own stream handler to the
child's run.

Handlers are matched by `name`, not by class, because a consumer's install can hold several
copies of `@langchain/langgraph` (the platform's holds three), where `instanceof` fails.

- *Alternative: skip chunks from another thread in `drive()`.* This was the report's proposal. It
  does not work: a leaked chunk's `thread_id` is the caller's own (see Context), so the check
  would drop nothing in the caller and drop the child's legitimate chunks in the child.
- *Alternative: tag the child's invocation `nostream`.* `StreamMessagesHandler` checks the tag
  only for chat-model runs. Its `handleChainEnd` path would still report the AI message the
  child's `model_request` node returns. The tag is also inherited by the child's own runs, so the
  child's own runner would stop streaming too.
- *Alternative: invoke the child with no inherited callbacks.* This would also cut a host's
  tracer off from every child run.

### Fix at dispatch, not in the turn runner

The leak happens because the child inherits the handler, not because the runner reads its
stream. Removing the handler at the one place a child's config is built covers every consumer
of the caller's stream: the turn runner, and a host that calls `agent.stream` with
`streamMode: "messages"` itself.

## Risks / Trade-offs

- **Handler names are LangGraph internals.** A future LangGraph that renames a stream handler, or
  adds a new stream mode with its own handler, would reopen the leak. The behaviour tests fail
  if it does, for both the streaming and the non-streaming path.
- **A host that relied on the duplicate.** A host that showed a child's text from the caller's
  untagged deltas will see it only tagged with the dispatch now. That is the documented
  attribution; the platform's workaround already dropped those deltas.
