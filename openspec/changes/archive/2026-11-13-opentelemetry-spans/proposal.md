## Why

A host traces a turn end to end — its API, its queue, its worker, then the archmax harness — and
the harness is where a turn spends its time and money, yet a tracing backend sees none of it. The
facts exist on the event stream (`state-enter`/`state-leave`, `tool-called`/`tool-result`/
`tool-blocked`, `model-usage`, `sub-workflow-start`/`-result`), but as diagnostics for one handler
with no trace context: a host cannot put them in the trace it is already in, the provider's HTTP
request cannot nest under the model call that made it, and every host would rebuild spans from
events after the fact with guessed start times (archmax-ai/harness#77).

## What Changes

- The runtime reports its work as OpenTelemetry spans through `@opentelemetry/api` alone, named and
  attributed by the GenAI semantic conventions: one `invoke_agent {workflow}` span per turn, one
  `state {slug}` span per visit to a state within a turn (automated states included), one
  `chat {model}` span per model call (a grader's included) and one `execute_tool {tool}` span per
  tool call (a script's and a grader's included). A sub-workflow's child session is its own
  `invoke_agent` span inside the call that dispatched it. A plain agent reports its turns, model
  calls and tool calls the same way, with no state spans.
- Each span is active while its call runs and starts in the context it is called in, so a host
  that invokes a turn inside its own span gets the turn as a child, and what a call does — the
  provider's HTTP request, a host tool's own spans — nests under it.
- Spans carry metadata only: identifiers authored in the workspace (workflow, state and tool
  slugs), model ids, token counts, cost when priced, durations, outcomes, the session id and the
  tool call id the events carry. Never message text, prompts, completions, tool arguments or
  results, variable values, error messages, or a blocked call's reason text; a blocked call carries
  the kernel's rule id instead.
- The runtime records the GenAI client metrics `gen_ai.client.operation.duration` and
  `gen_ai.client.token.usage` for every model call.
- `@opentelemetry/api` (`^1.9.0`) becomes the package's one peer dependency. The harness registers
  no SDK, exporter or instrumentation: without a host's SDK the API is a no-op, so a host that does
  not trace (the CLI included) sees no change in behaviour.
- Additive: no option, export, event or message changes. Released as a minor version.

## Capabilities

### New Capabilities

- `telemetry`: what the runtime reports as OpenTelemetry spans and metrics — the span tree, each
  span's name, kind and attributes, the context it starts in and nests, the metadata-only rule,
  the ids it shares with the event stream, cost as usage accounting reports it, the metrics, and
  the peer dependency that leaves the SDK to the host.

### Modified Capabilities

- `documentation`: the Guides section gains a telemetry guide, and the authoring skill's
  `references/backend-integration.md` teaches what a host does to see the spans.

## Impact

- **Code:** a new `src/core/telemetry.ts` (tracer, meter, the span and attribute helpers, the
  per-session state spans); the turn runners (`src/workflow/turn-runner.ts`); governance's model
  and tool wrappers (`src/workflow/governance.ts`), with the state span bookkeeping fed from the
  assembly's event chain (`src/assembly/index.ts`); the PTC gateway (`src/sandbox/ptc-gateway.ts`);
  the grader state's middleware (`src/workflow/grader-state.ts`); the plain composition
  (`src/assembly/plain.ts`), which gains a telemetry middleware; the wiring in
  `src/assembly/compose.ts` and `src/workflow/middleware.ts`.
- **Dependency:** `@opentelemetry/api` `^1.9.0` as a peer dependency; the OpenTelemetry SDK packages
  as dev dependencies, for the tests' in-memory exporter and metric reader.
- **Public API:** none. No option, export or type changes; the barrel and `public-api.md` are
  unchanged.
- **Docs (`docs/`):** a new guide, `guides/telemetry.md` (the span tree, every attribute, the
  metrics, what never appears, how a host registers an SDK to see them), listed in the sidebar;
  the configuration reference links to it; the changelog gains a 2.2.0 section.
- **README.md:** a short "Tracing" section saying the harness reports OpenTelemetry spans and
  metrics when the host registers an SDK, linking the guide.
- **Skill (`skills/archmax-harness/`):** `references/backend-integration.md` gains a tracing
  section (register an SDK in the host; what the turn, state, chat and tool spans carry; nothing
  to pass to `createAgent`).
