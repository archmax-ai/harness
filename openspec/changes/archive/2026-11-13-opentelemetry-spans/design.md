## Context

A turn enters the runtime through one place: the turn runner (`src/workflow/turn-runner.ts`)
drives every `invoke`, `stream` and `streamEvents`, every `send`, `decide`, `reply` and `deliver`
(`resumable.invoke` is the runner's), and every sub-workflow child (the delegation registry hands
the dispatcher the child's `driver.invoke`). Inside a governed turn the model and tool calls pass
through governance (`wrapModelCall`, `wrapToolCall`), except where the runtime calls on its own
behalf: a grader runs its own langchain agent (`grader-state.ts`), and scripts and graders reach
tools through the PTC gateway (`ptc-gateway.ts`). A state visit is not one call: entries and exits
are reported from the turn boundary, `archmax_advance`, automated states, `on_error` routing, parks
and the completion check, and all of them reach one event chain the assembly builds once
(`src/assembly/index.ts`), with the session id on every event's envelope.

## Goals / Non-Goals

**Goals:**

- Spans that are true to the work: started when the call starts, active while it runs, so what it
  causes nests under it in whatever the host instruments.
- One module owns span names, attribute names and what may be recorded, so the metadata-only rule
  is enforced in one place and tested once over everything.

**Non-Goals:**

- No SDK, exporter or propagator in the package; no CLI flag to enable tracing.
- No content capture, opt-in or otherwise.
- No trace context in checkpoints: a park's resumption is a new turn, so it starts a new span in
  the host's context, not the parked turn's trace.
- No span for Deep Agents' own internal model calls (summarisation) that never pass governance,
  nor for the calls of a plain agent's Deep Agents subagents (`task`): their middleware stack is
  Deep Agents' own, so the telemetry middleware does not reach it. The `task` call itself is a
  tool span.

## Decisions

**Spans at the call sites, not rebuilt from events.** A span built from `tool-called`/`tool-result`
after the fact cannot be active while the call runs, so the provider's HTTP request and a host
tool's own spans could never nest under it, and its start time would be reconstructed. The turn,
model-call and tool-call spans are therefore created where the call is made, with
`context.with(...)` around the handler. Considered and rejected: an `onEvent`-to-spans converter
(above); OpenInference's LangChain instrumentation (patches LangChain, sees LangChain runs rather
than states, governance and blocked calls, records content by default, uses OpenInference names);
LangChain callbacks (the same blindness to governance).

**Where each span is made.**
- Turn: the turn runner, governed and plain, wrapping the whole drive (and, for `stream` and
  `streamEvents`, each step of the iterator, ending at its last).
- Model call: `wrapModelCall` for an agent or human state (not for an automated state, which
  `wrapModelCall` services in place of a model call); the grader's own middleware for a grader's
  calls; a small telemetry middleware, first in the plain composition, for a plain agent.
- Tool call: `wrapToolCall` for the agent's calls, wrapping the whole governed path (name
  resolution, substitution, the kernel, control tools, delegation), so blocked and unknown calls
  are spans too; the PTC gateway for a script's and a grader's calls, under the `ptc:<n>` id
  their events carry, with the kernel's rule on a block; the grader's own middleware only for the
  calls that never reach the gateway (an unresolved argument, a name no tool has), so a grader's
  call is never counted twice.

**State spans from the event chain.** Six sites move a session; the event chain is where they
meet, already carrying the session id. The telemetry registry observes the assembly's chain
(beside the usage tracker) and keeps, per session, the open turn context and the open state span:
`state-enter` opens one (closing a stray one first), `state-leave` sets `archmax.state.next` and
ends it, `parked`, `code-result`/`grader-result`, `state-error-routed` and `raised` annotate it,
and the turn's end closes what is left. A turn that starts in the state the session is already in
emits no `state-enter`, so a call opens the state span lazily, marked `archmax.state.resumed`.
State spans are never made active: a visit spans several graph steps, so its children are parented
to it explicitly.

**Parenting rule.** A model or tool call's span is parented to the active context when that
context is inside a tool-call span of the same session (a script's calls inside `archmax_eval`),
else to the session's open state span (or the turn's span), keeping the active context's other
values, else to the active context (a session with no open turn). A private context key marks
"inside a tool call of session X"; a turn span clears it, so a child session's own calls attach to
the child's states rather than to the parent's dispatching call. A second key names the turn work
belongs to, so two turns open on one session at once (a host invoking it twice) keep their states,
calls and totals apart; an ended turn leaves the registry at once, in whatever order turns end.

**Usage from the response, through the same accounting.** The model-call wrapper reads the
response it returned with the same `extractUsage` and `summarizeUsage` the `afterModel` hook and
the grader use, so a span's tokens and cost equal the call's `model-usage` event by construction.
The turn's totals add the calls of its own session as `addSummaries` does; a child's calls go to
the child's turn.

**Time budget.** `wrapModelCall` races the call against `budget.timeoutMs`. The span ends once:
at the expiry with `error.type` `timeout`, or when the answer arrives first; a late answer finds
the span settled and changes nothing.

**Metadata only, by construction.** The telemetry module takes typed values (slugs, model ids,
counts, outcomes) and never a message, an argument, a result or an error message. `error.type` is
derived from an error's HTTP status or class name; exceptions are not recorded; a tool name that is
not a plain identifier (`[A-Za-z0-9_.:-]`, at most 64 characters) is reported as `unknown`; a raise
code is reported only when it is such a token. One test runs whole turns with marker strings in
every content position and asserts that no span or metric carries any of them.

**The API as a peer dependency.** `@opentelemetry/api` keeps its registry on a global symbol and
refuses a provider registered by a newer minor than its own copy, so a second copy inside the
harness could silently drop every span. A peer dependency gives the host's copy to the harness.
`^1.9.0` admits both SDK lines in use: 2.x requires an API below 1.10, 3.x requires 1.10. The tests
run on API 1.10 with the 3.x SDK packages as dev dependencies (`@opentelemetry/sdk-trace`,
`@opentelemetry/sdk-metrics`, `@opentelemetry/context-async-hooks`).

**Semantic conventions.** Span names, kinds and `gen_ai.*` attributes follow the GenAI conventions
(`invoke_agent`, `chat`, `execute_tool`; `gen_ai.provider.name`, the `cache_read`/`cache_creation`
token names). What they do not define is under `archmax.*`. `gen_ai.usage.cost` is not in the
conventions; OpenObserve and others read it. The names are constants in the telemetry module and
in the guide, not imported from `@opentelemetry/semantic-conventions`, which would be a second
runtime dependency for a handful of strings.

**Metrics.** `gen_ai.client.operation.duration` and `gen_ai.client.token.usage`, with the
conventions' advised bucket boundaries passed as instrument advice, recorded per model call with
low-cardinality attributes only.

## Risks / Trade-offs

- [Async context does not survive a boundary (LangGraph's task scheduling, QuickJS host calls)] →
  The tests assert each nesting; where context is lost a call still parents to its state span, so
  the trace stays whole, only less deep.
- [GenAI conventions are still in development; names may change] → Every name is a constant in one
  module and listed in the guide; a rename ships as a minor version with a changelog entry.
- [Overhead with an SDK registered] → One span per call and two histograms per model call; nothing
  is serialised. Without an SDK every call is a no-op.
- [A process that dies mid-turn leaves open spans] → They are lost with the process; nothing is
  persisted.

## Migration Plan

Additive. A host sees spans once it registers an SDK; without one nothing changes. Rolling back is
removing the module and the peer dependency.
