---
title: Telemetry
description: The OpenTelemetry spans and metrics the runtime reports for every turn, state visit, model call and tool call, and what a host does to see them.
sidebar:
  order: 10
---

The archmax harness reports its work as **OpenTelemetry** spans and metrics. Every turn on a
session is a span, and so is each visit to a state, each model call and each tool call, nested
the way the work happened. The two GenAI client metrics are recorded for every model call. Span
names and attributes follow the [GenAI semantic
conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/), so a tracing backend that
understands them shows tokens, cost and models without configuration. Anything the conventions do
not define is under `archmax.*`.

The harness reports through `@opentelemetry/api` alone, which is its one peer dependency. It
registers no SDK, exporter or instrumentation of its own. Without a host's SDK every call is a
no-op, and a turn behaves exactly as it does without telemetry.

Spans carry **metadata only**: slugs, model ids, token counts, cost, durations, outcomes and the
ids the event stream carries. They never carry what the session said or handled. See [what a span
never carries](#what-a-span-never-carries).

## Seeing the spans

Register an OpenTelemetry SDK in the host process before the first turn runs. There is nothing to
pass to `createAgent`. With the Node SDK and an OTLP exporter:

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

new NodeSDK({ serviceName: "support-worker", traceExporter: new OTLPTraceExporter() }).start();

const agent = await createAgent({ workflow: "support", workspace: { rootDir } });
```

Add a metric reader to the SDK to export the [metrics](#metrics) as well. The harness uses the
host's copy of `@opentelemetry/api` (`^1.9.0`), which is why it is a peer dependency: the API keeps
one global registry, and a second copy would not see the host's providers. The 2.x SDK packages
need an API below 1.10, and the 3.x packages need 1.10. npm 7 and later and pnpm install the peer
dependency with the harness; with a package manager that does not (Yarn, or pnpm with
`auto-install-peers` off), add `@opentelemetry/api` yourself. Spans nest only through a context
manager, which the Node SDK registers; with a tracer provider alone, each span starts a trace of
its own.

A turn invoked inside a span of the host's (an HTTP request, a queue job) becomes that span's
child, in the same trace. What a call does while it runs nests under the call's span: the
provider's HTTP request under its `chat` span, a host tool's own spans under its `execute_tool`
span. One governed turn reads like this:

```
invoke_agent support                      the turn
├─ state triage                           an agent state
│  ├─ chat gpt-6-luna                     a model call
│  ├─ execute_tool lookup_order           a host tool's call
│  │  └─ SELECT orders                    (the host's own span)
│  ├─ chat gpt-6-luna
│  └─ execute_tool archmax_advance        the move, under the state it left
├─ state check                            a code state
│  ├─ execute_tool archmax_get_history    its script's calls
│  └─ execute_tool archmax_advance
└─ state resolve
   └─ chat gpt-6-luna
```

## Turns

Every turn is one span named `invoke_agent <workflow>`, kind `INTERNAL`: a message, a decision, a
reply, a delivery, and a sub-workflow's child turn. It starts in the context active where the turn
is invoked and stays active for the whole turn. `stream` and `streamEvents` end it when their
iterator ends. A stream the host stops reading (breaking out of its loop) ends the span there;
the turn's remaining model and tool calls, which the graph still makes, report under it without
state spans. A stream dropped without being read to its end or closed keeps its turn's span open.

| Attribute | Value |
| --- | --- |
| `gen_ai.operation.name` | `invoke_agent` |
| `gen_ai.agent.name` | The workflow's slug. Absent for a plain agent. |
| `gen_ai.conversation.id` | The session id, as the events carry it. |
| `archmax.turn.resume` | `true` for a decision, a reply or a delivery; `false` for a message. |
| `archmax.session.status` | The session's status after the turn: `completed`, `awaiting_decision`, `awaiting_input`, `failed`, `rejected` or `running`. |
| `archmax.state` | The state the turn ended in. |
| `gen_ai.usage.*` | The token totals and cost of the turn's own model calls, as on a [model call](#model-calls). |
| `archmax.dispatch.id` | On a sub-workflow's child turn: the dispatch it runs for. |

The span ends with status `ERROR` when the turn throws (`error.type` is the error's HTTP status or
class name) and when the session ends `failed` or `rejected` (`session_failed`,
`session_rejected`). A raise is `session_failed`. A park is not an error, a sub-workflow
child's included: its turn ends `awaiting_decision` or `awaiting_input`. Each resumption of a
parked session is a new turn in the context it is invoked in, so it is a trace of its own.

A plain agent (`workflow: false`) reports the same turn span, named `invoke_agent`, with its model
and tool calls directly beneath it and no state spans. A plain agent's Deep Agents subagents (its
`task` tool) run inside that call's `execute_tool task` span, but their own model and tool calls
are not reported, and their tokens are not in the turn's totals.

## States

Within a governed turn each visit to a state is one span named `state <slug>`, kind `INTERNAL`,
under the turn's span. It opens when the session enters the state and ends when the session leaves
it or the turn ends. A grader state's and a code state's visits are state spans too, holding the
grader's model and tool calls or the script's tool calls.

A turn that continues in the state the session is already in opens that state's span at its first
model or tool call, marked `archmax.state.resumed`. A reply to a parked session is such a turn.

| Attribute | Value |
| --- | --- |
| `archmax.state` | The state's slug. |
| `archmax.state.type` | `agent`, `human`, `grader` or `code`. |
| `archmax.state.next` | The state the session moved to, when it left for another. |
| `archmax.state.resumed` | `true` when the turn continued in the state rather than entering it. |
| `archmax.state.parked` | `decision` or `input`, when the session parked in the state. |
| `archmax.raise.code` | The raise's code, when the state raised with a short token. |

A visit ends with status `ERROR` and an `error.type` when it fails:

| `error.type` | When |
| --- | --- |
| `automated_state_failed` | A grader or code state failed: it threw, timed out or finished without deciding. |
| `routed_on_error` | The runtime routed the session through the state's `on_error`. `archmax.state.next` is the target. |
| `raised` | The state raised with `archmax_raise`. |

## Model calls

Every model call a session's agent or grader makes is one span named `chat <model>` (`chat` when
the model exposes no id), kind `CLIENT`, under the span of the state it was made in and active
while the call runs: an agent state's calls, a park's handoff message and a grader's calls alike.
A plain agent's calls are under its turn. Calls Deep Agents makes on its own, which pass neither
governance nor the plain agent's middleware, are not reported and are not in `model-usage` events
either: its context summarisation, and a plain agent's subagents (see [turns](#turns)). Neither is
a case's `judge`, which `archmax test` runs outside any session.

| Attribute | Value |
| --- | --- |
| `gen_ai.operation.name` | `chat` |
| `gen_ai.provider.name` | The provider, from LangChain's model type (`openai`, `anthropic`, `aws.bedrock`, …). |
| `gen_ai.request.model` | The id the call asked for. |
| `gen_ai.response.model` | The id the response named, when it named one. |
| `gen_ai.response.finish_reasons` | The response's finish reason. |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | The provider's token counts. |
| `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens` | The cache's share of the input. |
| `gen_ai.usage.cost` | USD, when the model is [priced](/reference/configuration/#token-pricing). Never guessed. Not part of the GenAI conventions. |
| `gen_ai.conversation.id`, `archmax.state` | The session and the state. |
| `archmax.model.role` | `agent`, or `grader` for a grader's call. |
| `archmax.response.tool_calls` | How many tool calls the response asked for. |

The tokens and cost are read through the same accounting as the call's `model-usage` event, so the
two always agree. A turn's totals add up its own calls.

A call that throws ends with status `ERROR` and `error.type` the HTTP status (`429`) or the error's
class name. A call that outlives its state's `budget.timeoutMs` ends when the budget expires, with
`error.type` `timeout`; its late answer changes nothing.

## Metrics

Every model call the spans report records the two GenAI client metrics, with the bucket
boundaries the conventions advise:

| Metric | Unit | Recorded |
| --- | --- | --- |
| `gen_ai.client.operation.duration` | `s` | Once per call. |
| `gen_ai.client.token.usage` | `{token}` | Twice per call whose response reports usage: `gen_ai.token.type` `input` and `output`. |

Their attributes are `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`,
`gen_ai.response.model` and, on a failed call, `error.type`. They carry no session, state or
user, so their cardinality stays low.

## Tool calls

Every tool call is one span named `execute_tool <tool>`, kind `INTERNAL`, active while the call
runs. That covers the agent's calls, a grader's, and a script's (`archmax_eval`, `archmax_run`, a
code state), with the runtime's control tools among them. It sits under the state the call was
made in. A script's call made inside the agent's `archmax_eval` or `archmax_run` call sits under
that call's span. `archmax_advance` sits under the state it left.

| Attribute | Value |
| --- | --- |
| `gen_ai.operation.name` | `execute_tool` |
| `gen_ai.tool.name` | The tool's name, as the call resolved it. |
| `gen_ai.tool.call.id` | The call's id: the `callId` of its `tool-called`, `tool-result` and `tool-blocked` events. |
| `gen_ai.tool.type` | `function` |
| `gen_ai.conversation.id`, `archmax.state` | The session and the state, as the call's events carry them. |
| `archmax.tool.origin` | `agent`, `grader` or `script`. |
| `archmax.tool.outcome` | How the call ended (below). |
| `archmax.tool.rule` | For a blocked call: the kernel's rule id (`tool.not-allowed`, `zone.read-only`, …), or `unresolved-argument`. |

| `archmax.tool.outcome` | `error.type` | When |
| --- | --- | --- |
| `ok` | | The tool answered. |
| `parked` | | The call parked the session: an accepted `archmax_wait`, an `archmax_advance` into a human state, or a sub-workflow whose child stopped for a person. |
| `error` | `tool_error` | The tool failed. The model still reads its error. |
| `blocked` | `blocked` | Governance refused the call. |
| `unknown` | `unknown_tool` | No tool has the name the model called. The span is named `execute_tool unknown`. |
| `cancelled` | `cancelled` | The turn was cancelled during the call. |

The ids join a span to the call's events and its stored messages: `gen_ai.tool.call.id`,
`archmax.state` and `gen_ai.conversation.id` name the same call the events do.

## Sub-workflows

A sub-workflow's child turn is an `invoke_agent <workflow>` span under the
`execute_tool archmax_workflow_<slug>` span that dispatched it, with the child's states and calls
beneath it. Its `gen_ai.conversation.id` is the child session's id, and `archmax.dispatch.id` is
the dispatch the `sub-workflow-start` event names. Each turn's totals count its own session's
model calls only, so the parent's totals leave out the child's tokens and cost.

A child that parks ends its turn as a park, and the delegation's `execute_tool` span ends
`parked`. When a decision, a reply or a delivery on the parent reaches the child, the child's
resumed turn is an `invoke_agent <workflow>` span directly under the parent's resumed turn: no
tool call dispatches it this time.

## What a span never carries

No span name, attribute, event or status message, and no metric attribute, carries message
text, a prompt, a completion, a tool's arguments or result, a variable's value, an error's message
or a blocked call's reason. Exceptions are not recorded. An error is typed by its HTTP status or
class name only. A tool name that is not a plain identifier (letters, digits, `_`, `.`, `:` and
`-`, at most 64 characters), or that no tool answers to, is reported as `unknown`. A raise's code
is reported only when it is such a token.

The test suite holds this line. It runs whole turns through every path (agent calls, blocked,
unknown and failing calls, `archmax_eval`, a code state, a grader, a sub-workflow, a raise), puts
a marker in every message, reply, argument, result, variable value and error message, and fails if
any recorded string contains one.
