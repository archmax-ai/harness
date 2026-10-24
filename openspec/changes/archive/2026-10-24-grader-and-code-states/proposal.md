# Proposal

## Why

Hooks are a second control plane hidden inside states. `before`/`after` slots have their own
verdict vocabulary (`ok`/`correct`/`veto`), their own retry budget (`max_iterations`), positional
rubric identities, and a privileged tool authority. A hook script reaches every tool the assembly
has, outside the state's grants. Grading and deterministic checks belong on the graph itself, as
states that the same tool surface governs. Such states move with the one tool every state moves
with (`archmax_advance`) and fail with the one tool every state fails with (`archmax_raise`).

## What Changes

- **BREAKING** — `before` and `after` are removed from the state schema. A workflow that still
  declares either fails to load with the standard unrecognized-key error naming the key and its
  path, and `archmax validate` reports the same. There is no migration shim. The `{ script }`,
  `{ rubric }` and custom hook kinds go with them, and so do `max_iterations`, the
  `extensions` root block (it only held `hooks`) and the `hookExecutors` option of
  `createAgent`.
- **BREAKING** — runtime contract `3` replaces `1` and `2`. A workflow declaring `runtime.version`
  `1` or `2` is refused as an unsupported contract. An omitted declaration resolves to `3`.
- New state type **`grader`**. When a session enters a grader state, the runtime runs a grader:
  a subagent with its own isolated context, whose system prompt is the state's `instructions`.
  - It is offered exactly the grader state's tool surface: the state's grants, the file tools,
    the variable tools, `archmax_advance`, `archmax_raise` and the new `archmax_get_history`.
    `archmax_get_history` returns the session's full transcript and trail.
  - It decides with `archmax_advance` (a declared transition, carrying the reason the next
    state reads) or ends the session with `archmax_raise`.
  - There is no visit counter or iteration budget. A grader that gives up after N rounds says
    so in its instructions and reads the rounds from the history.
- New state type **`code`**. When a session enters a code state, the runtime runs the state's
  `script` (`workflows/<slug>/scripts/<file>.js`) in the sandbox, as hook scripts ran before.
  - The script is offered exactly the code state's tool surface as `tools.*`. That surface is
    the state's grants, the file tools, the variable tools, `archmax_advance` and
    `archmax_raise`. It is no longer every tool the assembly has.
  - The script moves the session by calling `tools.archmax_advance({ to, reason })`.
  - A terminal code state completes the session when its script returns.
- Grader and code states (**automated states**) are run by the runtime without a model call of
  the session's agent. A chain of code states runs with no model call at all. A non-terminal
  automated state that finishes without advancing or raising fails closed, and the failure is
  routed through `on_error`.
- **BREAKING** — the agent's programmatic tool calls (`archmax_eval`, `archmax_run`) see exactly
  the active state's tool surface. `tools.<name>` for a tool outside it is `undefined`, the way
  it is absent from the listing. It no longer resolves to a function that governance then
  refuses.
- **BREAKING** — the `lifecycle` tool-call origin (runtime authority over every tool) is gone.
  Only the runtime's own `file`-value read check runs on runtime authority, under the origin
  `runtime`.
- Trail steps gain the kinds `grader` and `code`. Runtime notes gain the kinds `grader` and
  `code`, which carry an automated state's reason to the next state.
- Events:
  - **BREAKING** — `hooks-summary`, `hook-*` and `rubric-*` are removed.
  - New `code-start`/`code-output`/`code-result` and `grader-start`/`grader-result` events
    bracket each run.
  - A grader's model calls emit `model-usage` under its state.
- **BREAKING** — the model role `rubric` becomes `grader`. A grader state's `model` is
  resolved through `modelFactory("grader", env, id)`.
- **BREAKING** — the checkpointed `iterations` and `beforeDone` channels are removed.
- **BREAKING** — `@archmax-ai/harness/sandbox` drops the hook vocabulary (`ok`, `veto`,
  `correct`, `defineHook`, `HookArgs`, `HookResult`, …). It types a code state's input
  instead (`CodeStateInput`, `defineCodeState`).
- The reference workspace (`examples/customer-support/`) is converted:
  - Its entry checks become a code state.
  - The refund policy check becomes a code state between the agent and the human review.
  - The tone rubric becomes a grader state.

## Capabilities

### New Capabilities

- `automated-states`: grader and code states. Covers how the runtime runs each on entry with no
  model call from the session's agent, the tool surface each is offered, and how each moves
  (`archmax_advance`), fails (`archmax_raise`, an error, finishing undecided) or completes.
  Also covers chaining, the history a grader reads and a code script receives, their events and
  notes, and the grader's model role.

### Modified Capabilities

- `workflow-spec`: the state type enum gains `grader` and `code`. The changes:
  - `before`/`after`, the hook shapes and `extensions` are removed.
  - A code state's `script` key and path grammar are new.
  - Keys that do not apply to a type are lint errors.
  - A grader must declare instructions and at least one transition.
- `runtime`:
  - Removed: hook declaration, contract, sequencing and fail-closed requirements, and the
    terminal `after` hook.
  - Events lose the hook and rubric types and gain the code and grader types.
  - Trail steps and runtime notes gain kinds.
  - The prompt no longer names hooks.
  - The `iterations` and `beforeDone` channels are dropped.
- `governance`:
  - Removed: hook verdict reduction in the kernel, and the `lifecycle` origin.
  - The `runtime` origin is used only for the runtime's own `file` checks.
  - A state's surface is derived by type, including which controls each type is offered.
  - `archmax_get_history` is a control tool, offered in grader states only.
  - The two script homes are skill bundles and a workflow's `scripts/`.
- `sandbox`:
  - The hook script contract is replaced by the code-state script contract.
  - Agent scripts reach only the active state's tools.
  - Code-state scripts reach only their own state's tools.
  - The sandbox contexts are `ptc` and `code`.
- `assembly`:
  - The runtime contract table becomes version `3` only.
  - `hookExecutors` is removed.
  - The `rubric` model role becomes `grader`.
  - The rubric subagent registration is removed.
- `grading-rubrics`: every requirement is removed. Grading is a grader state (`automated-states`).
- `delegation`: requirements that name hooks as dispatchers now name code states and graders.
- `testing`: a case's trail and tool-call assertions cover automated states. Hook-specific
  wording is removed.
- `cli`: the state flow renders code and grader runs in place of hook verdicts.
- `workspace-and-sessions`: the authoring backend holds code-state scripts rather than hook
  scripts. The checkpointed channels drop `iterations`/`beforeDone`.
- `documentation`: pages that documented hooks and rubrics now document grader and code states.

## Impact

- **Code**:
  - Removed: `src/lifecycle/` and `src/rubrics/`.
  - New automated-state runner under `src/workflow/` (code and grader execution, the history
    view, the controls an automated state calls).
  - Rewritten:
    - `src/machine/spec-schema.ts`, `types.ts`, `machine.ts` (type-aware surfaces) and
      `lint-spec.ts`.
    - `src/kernel/kernel.ts`: no hook facts; origins `agent`/`script`/`runtime`.
    - `src/workflow/governance.ts`, `middleware.ts`, `control-tools.ts`, `tool-service.ts`,
      `state.ts`, `turn-boundary.ts` and `render-prompt.ts`.
    - `src/sandbox/` (prelude contexts, executor, PTC gateway, scoped `tools` view).
    - `src/assembly/` (no rubric subagents; grader model role).
    - `src/core/events.ts`, `src/cli/state-flow.ts`, `src/validate/validate.ts`,
      `src/runtime/contract.ts`, `src/public/{sandbox,spec}.ts` and `src/index.ts`.
  - Tests across the suite: hook and rubric behaviour tests are replaced by automated-state
    behaviour tests.
- **Public API (BREAKING)**:
  - Removed from `createAgent`: `hookExecutors` and the `HookExecutor` type.
  - `ModelRole` `"rubric"` → `"grader"`.
  - Removed exports: `normalizeHooks`, `RubricDeclaration`, the hook spec exports.
  - Event payload types change.
  - The `@archmax-ai/harness/sandbox` vocabulary changes.
  - `TrailStep.kind` gains `grader`/`code`.
- **Workspaces (BREAKING)**:
  - Every `before:`/`after:` must be rewritten as grader or code states.
  - Hook scripts move from `workflows/<slug>/hooks/` to `workflows/<slug>/scripts/` and are
    rewritten to the code-state contract.
  - `runtime.version` must be `3` or omitted.
- **docs/**: the pages below are rewritten or updated. The governance, sandbox, events, sessions,
  sub-workflows, testing, triggers and token-efficiency pages drop their hook references.
  - `guides/workflow-machine.md`, `guides/grading-rubrics.md` (replaced by a grader and code
    states guide) and `guides/code-interpreter.md`.
  - `guides/authoring-plane.md`, `reference/machine-spec.md` and `reference/public-api.md`.
  - `reference/glossary.md`: hook, verdict, grading rubric and iteration budget go;
    automated state, grader state, code state and history are added.
  - `reference/changelog.md`: a major entry.
- **README.md**: the hook and rubric sections become grader and code states, and the example
  workflow snippet changes.
- **skills/archmax-harness/**:
  - `SKILL.md`: the authoring flow.
  - `references/workflow-schema.md`, `workflow-yaml.md`, `hook-and-test-scripts.md` and
    `hooks-and-scripts.md` (rewritten as code-state scripts) and `backend-integration.md`
    (no `hookExecutors`, grader role).
  - `references/diagnostics.md` (new load errors and events).
- **AGENTS.md** and `openspec/config.yaml`: the vocabulary line and the hooks contract
  section are replaced by the automated-state contract.
