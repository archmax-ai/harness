## Context

This section describes how the pieces fit today. See proposal.md for why the change is needed.

- **How `createAgent` builds the tool node.** LangChain's `createAgent`, which Deep Agents uses,
  builds its `ToolNode` with only `signal` and the composed `wrapToolCall` chain
  (`langchain/dist/agents/ReactAgent.js`). It never sets `handleToolErrors`, so the default handler
  applies.
- **The default handler.** It answers any error thrown by the tool itself, but only when no
  `wrapToolCall` middleware is installed. With middleware present, the base handler rethrows so
  the middleware can see the error. Whatever then leaves the chain is treated as a middleware
  error, is wrapped as a `MiddlewareError` (bubble-up signals pass through unwrapped) and is
  re-raised (`ToolNode#handleError`). The one exception is a `ToolInvocationError`, a schema
  failure, found at the root of the cause chain.
- **The harness middleware.** The workflow middleware's `wrapToolCall`
  (`src/workflow/governance.ts`) brackets every governed call with `tool-called` and
  `tool-result`. Its catch settles `error` and then rethrows. Because it always installs a
  `wrapToolCall`, every tool failure leaves the tool node as a middleware error.
- **Tools the runtime services itself.** Control and delegation tools never reach the base handler
  (`tool-service.ts`). Delegation already catches a child's failure and turns it into a committed
  `rejected`, and a child's park into `pendingDelegations`.
- **Script calls.** Script tool calls bypass the tool node entirely (`sandbox/ptc-gateway.ts`).

## Goals / Non-Goals

**Goals:**

- A tool's failure reaches the model as that call's answer, with one `tool-result` (`error`).
- Parks and cancellations behave exactly as today.

**Non-Goals:**

- Retrying failed calls inside the runtime. The model decides whether to retry. A transport retry
  is the tool's or the host's concern.
- Bounding or sanitizing the error text. The host owns its tools and their failures, and the
  archmax platform already bounds them at bind time.
- A host option to make tool failures fatal again. It can be added if a host asks for it.
- Changing how control tools, delegation, the PTC gateway or lifecycle hooks treat failures.

## Decisions

### Answer in the workflow middleware's catch

Where the handler call in `wrapToolCall` fails, the catch settles `tool-result` with `error` as it
does today, and then returns
`new ToolMessage({ content, tool_call_id, name: toolName, status: "error" })` instead of
rethrowing.

- *Alternative: `handleToolErrors: true` on the tool node.* The harness does not construct the
  tool node, and `createAgent` exposes no such option. `true` would also swallow genuine
  middleware defects and append LangChain's "Please fix your mistakes." suffix.
- *Alternative: wrap each tool at registration.* The harness does not own the host's tools or
  Deep Agents' built-in ones. A per-tool wrapper would also miss errors raised by inner
  middleware.
- *Alternative: route through `on_error`.* A transient failure would end the state. `on_error` is
  for failures the model cannot correct, and a failed call is one it usually can.

### Propagate exactly what the tool node itself refuses to answer

A failure keeps propagating when either of these holds:

- `isGraphBubbleUp(err)` from `@langchain/langgraph` is true. This covers `GraphInterrupt`
  (including one carrying `SUB_WORKFLOW_PARK`) and `ParentCommand`.
- The run's `request.runtime.signal` is aborted.

These are the checks `ToolNode#handleError` makes before it will answer, so the runtime stays
consistent with what LangChain would do without middleware. Keep today's `settle` for the
propagating case, so an announced call still settles, as the paired-events requirement demands.

### The answer's content is the error's message, verbatim

The content is the same text the `tool-result` preview carries. There is no suffix, because
advice like "fix your mistakes" is wrong for a dropped connection. There is no tool-name prefix,
because the message is already that call's answer. A non-`Error` throw is rendered with `String()`.

### Scope is the handler path only

The serviced paths (`withPairedEvents`) keep rethrowing. A throw there is a runtime defect rather
than a tool failure, and every expected refusal on those paths already has an answer.

## Risks / Trade-offs

- [A tool that fails deterministically invites retries] → `budget.maxTurns` bounds model calls per
  state, and hosts bound the turn's wall time.
- [A host counted on the throw to mark the turn failed] → the release note says so. The event
  stream still carries the call's `tool-result` with `status: "error"`, which is where a host
  should read tool failures from.
- [Very long error text enters the transcript] → Hosts bound their tools' errors, as the archmax
  platform does, and Deep Agents' summarization bounds the history. The event preview stays capped
  as today.
- [Errors raised by middleware inside the workflow middleware are answered too] → For example, the
  mock middleware or the sandbox middleware's pass-through. From the model's side it is the same
  "the call failed", and signals still propagate.
