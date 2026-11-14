# Tasks

## 1. The API, the telemetry module and the test kit

- [x] 1.1 Add `@opentelemetry/api` `^1.9.0` to `peerDependencies`, and `@opentelemetry/api`,
      `@opentelemetry/sdk-trace`, `@opentelemetry/sdk-metrics` and
      `@opentelemetry/context-async-hooks` (the 1.10 API and the 3.x SDK) to `devDependencies`.
      Verify `npm ci`, `npm run typecheck` and `npm test` pass unchanged.
- [x] 1.2 Add `src/core/telemetry.ts`: the tracer and meter (`@archmax-ai/harness`,
      `PACKAGE_VERSION`), the span and attribute name constants, the sanitisers (tool name, raise
      code, `error.type`), the per-session registry (turn context, open state span, the turn's
      usage totals) fed by lifecycle events, the parenting rule, settle-once model-call and
      tool-call spans, and the two GenAI histograms with their advised buckets. Verify
      `src/core/telemetry.test.ts`: every sanitiser case; the registry's state machine (enter,
      leave, a stray enter, lazy resume, park, error route, raise, turn end); the parenting rule
      (inside a tool span of the same session, of another session, none); a span settled twice
      is ended once; with no provider nothing is recorded.
- [x] 1.3 Add the test kit `src/behaviour/otel.ts` (outside the build, beside the behaviour suite's
      support): an in-memory span exporter and metric reader on an
      AsyncLocalStorage context manager, registered and reset around a test, with helpers to read
      a trace as a tree, find spans by name and collect every recorded string. Verify it is used
      by 1.2's tests and leaves no global provider registered after a test.
- [x] 1.4 Document the wiring: `README.md` gains a short "Tracing" section and
      `skills/archmax-harness/references/backend-integration.md` a tracing section (register an
      SDK in the host before `createAgent`, nothing to pass, the four span kinds, metadata only),
      both linking `guides/telemetry.md`, which this task creates with the introduction and the
      "Seeing the spans" section and lists in the sidebar. Verify `npm run docs:build` passes.

## 2. Turn spans

- [x] 2.1 Make every turn a span in the governed and plain turn runners (`invoke`, and each step
      of `stream` and `streamEvents` until the iterator ends): name, kind, start in the active
      context with the tool-span mark cleared, `archmax.turn.resume`, and on settling
      `archmax.session.status`, `archmax.state`, the turn's own usage totals, and the error
      statuses. Verify behaviour tests: a message turn; `decide`, `reply` and `deliver` each one
      resumed turn; a turn inside a host span is its child; a raise is `session_failed`; a park
      is not an error; a thrown turn carries `error.type` and still throws; `stream` and
      `streamEvents` end their span when the iterator ends; a plain agent's turn.
- [x] 2.2 Write the guide's "Turns" section (the span, its attributes, its statuses). Verify the
      docs build.

## 3. State spans

- [x] 3.1 Feed the registry from the assembly's event chain beside the usage tracker, so
      `state-enter`, `state-leave`, `parked`, `code-result`, `grader-result`,
      `state-error-routed` and `raised` open, close and annotate state spans; the turn's end
      closes what is left. Verify behaviour tests: an advance yields two state spans with
      `archmax.state.next`; a code state and a grader state are state spans of their type; a
      follow-up turn's state is `resumed`; a park sets `archmax.state.parked`; a timed-out state
      is `routed_on_error` with its target; a raise is `raised` with its code, and a code that is
      not a short token is left out.
- [x] 3.2 Write the guide's "States" section. Verify the docs build.

## 4. Model-call spans and metrics

- [x] 4.1 Make governance's `wrapModelCall` open a `chat` span for an agent or human state's call
      (not an automated state's), active around the handler: request and response model, provider,
      role, usage and cost through `extractUsage`/`summarizeUsage`, finish reasons, the tool-call
      count, `error.type` on a throw, and the time budget settling the span once at expiry; record
      the duration and token metrics. Verify behaviour tests: tokens and cost equal the
      `model-usage` event's; an unpriced call has no cost; HTTP 429 is `error.type` `429`; a call
      over its budget ends at the expiry with `timeout`; a span the fake model opens during its call
      is a child of the `chat` span; one call records one duration and two token measurements with
      no session id.
- [x] 4.2 Give the grader's middleware `chat` spans (`archmax.model.role` `grader`, under the
      grader state's span) and metrics. Verify a grader state's calls appear under its state span
      with their usage.
- [x] 4.3 Add the telemetry middleware to the plain composition, first in its array: `chat` and
      `execute_tool` spans under the turn, with usage and metrics. Verify a plain agent's turn
      holds its model and tool call spans.
- [x] 4.4 Write the guide's "Model calls" and "Metrics" sections. Verify the docs build.

## 5. Tool-call spans

- [x] 5.1 Make governance's `wrapToolCall` wrap the whole governed path in an `execute_tool` span,
      active around it, with the outcomes `ok`, `error`, `blocked` (kernel rule, or
      `unresolved-argument`), `unknown` (named `unknown` when the called name is not a plain
      identifier), `parked` and `cancelled`. Verify behaviour tests: a granted call; a blocked
      call carries `tool.not-allowed`; an unresolved `${{name}}` is `unresolved-argument`; a
      throwing host tool is `tool_error` and the model still reads the error; an unknown free-text
      name; `archmax_advance` is a span under the state it left; a delegation's child turn is
      inside the delegation's span, with `archmax.dispatch.id`, and its tokens stay out of the
      parent's totals.
- [x] 5.2 Report a grader's calls as `execute_tool` spans (`origin` `grader`): the gateway reports
      the calls that reach it, under their events' ids, with the kernel's rule on a block; the
      grader's middleware reports the ones that never do (an unresolved argument, a name no tool
      has, as `unknown`). Verify a grader's calls, a blocked grader call and an unknown one.
- [x] 5.3 Make the PTC gateway open `execute_tool` spans for every call through it (`origin`
      `script`, or `grader` for a grader's), with the kernel rule on a block. Verify a code state's
      script calls sit under its state span; `archmax_eval`'s `tools.*` calls sit under the
      `archmax_eval` span; a grader's calls are each reported once.
- [x] 5.4 Write the guide's "Tool calls" and "Sub-workflows" sections. Verify the docs build.

## 6. Whole-turn invariants

- [x] 6.1 A metadata-only test over a workflow that exercises every path (agent calls, a blocked
      call, an unknown call, a failing tool, `archmax_eval`, a code state, a grader, a delegation,
      a raise), with a distinct marker in the message, every reply, every argument, every result,
      every variable value and every error message: no span name, attribute, event, status
      message or metric attribute contains a marker. Write the guide's "What a span never
      carries" section. Verify the test and the docs build.
- [x] 6.2 An ids test: every `tool-called`, `tool-result` and `tool-blocked` event has exactly one
      span with its `gen_ai.tool.call.id`, tool, state and session. Verify.
- [x] 6.3 A concurrency test: two sessions run at once on one agent produce two traces with no
      span crossing between them and separate totals. Verify.
- [x] 6.4 An equivalence test: one scripted turn with and without a provider registered yields the
      same result and the same events (envelope times aside). Verify.
- [x] 6.5 Add the 2.2.0 section to `reference/changelog.md`, linking the guide. Verify the docs
      build.

## 7. Verification

- [x] 7.1 Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
      `npm run docs:build` and `openspec validate opentelemetry-spans --strict`; all pass.

## Workflow follow-up

- Archive the change (`openspec archive opentelemetry-spans`) in the same branch, as the
  repository's changes are, and check that `openspec/specs/telemetry/spec.md` and the
  `documentation` spec read as the delta says.
- Commit on the local branch `feat/77-opentelemetry-spans`; nothing is pushed.
