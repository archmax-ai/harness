# AGENTS.md

Guidance for coding agents working in this repository (Claude Code and others read this file).
Vocabulary: one term per concept, as defined in `docs/src/content/docs/reference/glossary.md` —
session (not run/thread), turn (not segment), state (not node), automated state (a grader state
or a code state; never "hook"), case/grade, archmax harness/runtime/kernel/Deep Agents ("archmax
harness", or "the harness" once named, is the SDK; never "framework" for it, and never "harness"
for the runtime or kernel).

## What this is

`@archmax-ai/harness` is **archmax harness**: a thin, governed layer over
[LangChain Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview)
(Node/TypeScript, ESM). It assembles one Deep Agent per workflow, serves the agent's workspace
through a Deep Agents backend, and enforces a declarative state machine (`workflow.yaml`) with
middleware and a pure decision kernel. It contains **no use-case logic** — everything specific
lives as files in a workspace; `examples/customer-support/` is the reference workspace (not
shipped in `dist/`).

Everything the runtime reads — specs, prompts, code-state scripts, skill bundles — comes
through a backend, never direct `fs`. The documented exceptions are pre-assembly or
consumer-chosen: `.env` loading (`src/env.ts`) and the filesystem session store's own storage.
The default platform prompt is compiled in, not read (see the directory map).

## Commands

```bash
npm run dev          # run the CLI from source via tsx (src/cli.ts)
npm run build        # clean + tsc -p tsconfig.build.json + copy assets; emits dist/
npm start            # run the compiled CLI (node dist/cli.js)
npm run typecheck    # tsc --noEmit over everything INCLUDING tests
npm test             # vitest run — colocated *.test.ts + src/behaviour/ suite
npm run docs:build   # build the Astro Starlight site in docs/
npx openspec validate --specs   # validate openspec/specs
npx vitest run src/machine/allow.test.ts      # one unit-test file; -t "<name>" filters by test name
```

Run the CLI from source against the reference workspace:

```sh
npm run dev -- run order-lookup "Which orders are delayed for Acme?" --root examples/customer-support
npm run dev -- test order-lookup --root examples/customer-support
npm run dev -- validate order-lookup --root examples/customer-support
```

The `bin` is `archmax` → `dist/cli.js`. A declarative command table (`src/cli.ts`, shapes in
`src/cli/command.ts`) drives `util.parseArgs` (strict), generated help, and dispatch.

| Command                                                  | Purpose                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| `archmax run <workflow> <prompt...>`                     | Start or continue a session (`--session`, `--trigger`, `--variables`, `--file`) |
| `archmax test [workflow] [filter]`                       | Run the workflow's cases; `--json`                                    |
| `archmax validate [workflow]`                            | Static validation, no model calls; `--json`                           |
| `archmax sessions [session]`                             | List durable sessions or show one; `--json`                           |
| `archmax decide <session> --to <state> [--comment]`      | Resume a session parked at a human state                              |
| `archmax reply <session> <message...>`                   | Answer a session parked at a human state (it stays parked)            |
| `archmax deliver <session> --trigger <id> [--variables]` | Resume a session parked with `archmax_wait`                           |
| `archmax help [command]`                                 | Help generated from the table                                         |

Arguments are positional; only optional, keyed things are flags. Global `--root <dir>` (default
cwd; `.env` is loaded from it). `<workflow>` may be omitted when the workspace has exactly one.
Results go to **stdout**, narration (session header, state flow, verdicts) to **stderr**;
`--verbose` adds raw event lines. Exit codes: 0 done/parked, 1 failure, 2 usage error. No
default workflow or prompt; unknown flags exit 2. `NO_COLOR` / `ARCHMAX_CLI_NO_BANNER` respected.

## Model configuration

Env-configured, any OpenAI-compatible endpoint (`ChatOpenAI` built in `src/env.ts`): `.env` from
the workspace root, process env wins. Keys: `ARCHMAX_API_BASE_URL`, `ARCHMAX_API_KEY`,
`ARCHMAX_MODEL`, `ARCHMAX_TEMPERATURE?`, `ARCHMAX_MAX_TOKENS?`, `ARCHMAX_STREAMING?`. A host may pass
`model` or a per-role `modelFactory` (roles `agent`, `judge`, `grader`) to `createAgent` instead.

## Architecture

### `workflow.yaml` is the single source of truth

A workflow is `workflows/<slug>/workflow.yaml` plus an optional `WORKFLOW.md` (plain Markdown
prose appended after the rendered graph section; frontmatter there is a `competing-machines` load
error). The schema is **one strict zod schema**, `src/machine/spec-schema.ts`: every root and
state key, enums, path grammars, and `refineSpec` for cross-references (targets exist, one
`manual` start, trigger ownership, `${{…}}` guard references, an undescribed edge routing on its
target's instructions: refused on a human state and into a grader or code state). Warnings live in
`src/machine/lint-spec.ts`; both the loader and `validate` run both. An unknown key is a load
error naming the key. The one loose spot is `triggers.<id>` (host-extensible). `WorkflowMachine`
(`src/machine/machine.ts`) is the compiled object the runtime consults. `src/validate/` adds what
needs more than the document: code-state scripts and their imports, the skill registry, sibling
workflows, case files, kernel probes.

### Execution: one Deep Agent graph per workflow

`createAgent` (`src/assembly/index.ts`; composition in `compose.ts`, plain agent in `plain.ts`,
lazy child compositions in `delegation-registry.ts`) returns a `ArchmaxAgent` (`src/agent.ts`)
wrapping the one `createDeepAgent` graph. The graph's checkpointed state carries the machine's
position, variables, trail, visits and park records as extra channels (`src/workflow/state.ts`).
Governance is middleware (`src/workflow/middleware.ts`): `beforeAgent` is the turn boundary
(trigger → start state or retained position; `disabled`/`requires` refusals; locked seeds; spec
snapshot), `wrapModelCall` applies the per-state tool surface and prompt (or, in an automated
state, runs the state in place of the model call), `wrapToolCall` services the control tools and
applies the kernel verdict to every call, `afterModel` does budgets, `on_error` and the commit of
an automated state's outcome. The agent moves only by `archmax_advance({ to, reason })`: edge
and `requires` validated, then the target's tools unlock (an automated target runs before any
further model call). **Parks are LangGraph interrupts**
(`src/workflow/parks.ts`): a human state parks for a decision, `archmax_wait` for input. Every way
back in is `agent.workflow.send(sessionId, input)` → one `Outcome` (`src/sessions/resume.ts`;
`decide`/`reply`/`deliver` are conveniences). A park, a decision routed to another human
state, or a reply to a parked session spends one reply-only model call — the handoff message.
Assembly **fails closed**: `WorkflowLoadError`, `SessionStoreRequiredError`,
`AuthoringBackendExposedError`.

### Automated states

A state of `type: code` or `type: grader` is an **automated state**: the runtime runs it on entry
(an opening, an advance, a decision, an `on_error` route, a reset) with no call of the agent's
model. `wrapModelCall` runs it in place of the model call and returns a marker `AIMessage`
carrying its serializable outcome; `afterModel` strips the marker, commits the outcome and jumps
back to the model, so each automated state is its own checkpointed step and a chain of code states
makes no model call (a runaway cycle ends at the recursion limit). It is offered exactly its
state's surface (`disclosedTools`, which for an automated state holds no `write_todos`,
`archmax_eval`, `archmax_run`, `archmax_wait` or `archmax_reset`, even when `allow_always`
lists them), each tool wrapped by the
PTC gateway so the kernel decides every call against that state. Its controls
(`machine.controlTools`, bound to one step recorder per run) are `archmax_advance` (edge and
`requires` checked at the call; absent when terminal), `archmax_raise`, `archmax_get_variables`,
`archmax_set_variables`, plus `archmax_get_history` for a grader; never `archmax_wait` or
`archmax_reset`, since an automated state cannot park. The first accepted advance or raise is the
decision. A run settles as `advanced` (trail kind `grader`/`code`, a runtime note carrying the
reason), `raised` (session `failed`), `completed` (a terminal state; `returns` checked) or
`failed` (a throw, a timeout, a spent budget, a non-terminal state left undecided), which routes
through `on_error`. A raise beats an error; an error discards a recorded advance; a session that
completed in a terminal automated state opens its next turn at the trigger's entry; a control is
never served from a case's mock. A **code state** runs `script: scripts/<file>.js` (confined to
`workflows/<slug>/scripts/`) in a fresh `code` REPL; its default export receives
`{ state, trigger?, variables, messages, trail, toolCalls(filter?), tools }` and its return value
is not read. A **grader state** is an isolated langchain agent built per run: the compiled grader
preamble plus the state's `instructions`, its transitions as the task, the `grader` model role, no
checkpointer, tokens tagged `nostream`; it reads the session only through `archmax_get_history`
(`{ messages, trail, toolCalls }`), and `budget.maxTurns`/`timeoutMs` bound its own calls. Both
read the whole session, never a visit (`history.ts`, `tool-calls.ts`), and neither spends the
turn's `budget.maxModelCalls`, which counts the agent's calls. Events `code-start/output/result`,
`grader-start/result`. Types: `@archmax-ai/harness/sandbox` (`defineCodeState`, `CodeStateInput`).
Runner: `src/workflow/automated.ts` (with `automated-controls.ts`, `code-state.ts`,
`grader-state.ts`, `history.ts`).

### Sandbox

`archmax_eval`, `archmax_run` (default tools: granted wherever the workflow-wide grant includes
them, never in an automated state; an allow entry may narrow which files `archmax_run` may
execute) and code-state scripts share one QuickJS sandbox (`@langchain/quickjs`): the agent's code
gets one REPL session per session scope (`src/sessions/scope.ts`), a code state a fresh REPL per
run. Scripts get `args` (flat `args.variables` for `archmax_run`; a code state's input) and
`tools.*`, the governed tool-call bridge: exactly the active state's surface, anything else
`undefined` (an agent's script never reaches a control tool). Contexts `ptc` and `code`.
`src/sandbox/`: `prelude.ts` + `assets/parts/code-state.js`, `executor.ts` (reads sources through
the authoring backend), `tools.ts`, `ptc-gateway.ts`. Cases do not run in the sandbox.
`runtime.ts` holds each REPL as a lease: an eval takes the turn's abort signal (a cancelled turn's
eval settles at once and its `tools.*` calls are refused), and `dispose` frees a REPL only once
every host call made from it has settled. `@langchain/quickjs` cannot survive a call settling into
a freed context.

### Sessions and the workspace

The agent's workspace root **is the session**. The composite (`src/core/workspace-context.ts`)
routes its default to the session zone (`src/core/session-zone.ts`) and mounts authored content
read-only at the keys of a consumer-composed table (`workspace.mounts`; `defaultMounts(rootDir)`
is the conventional default; `mountSubtree` rebases; `MountCollisionError` on a shadowed area).
Session areas (`src/core/zones.ts`): `scratchpad/` (read/write in every state for the file tools it grants, rule `tool.scratchpad`),
offload `large_tool_results/` + `conversation_history/` (agent reads only), internal
`checkpoints/`, `artifacts/`, `_specs/` (no agent access). Any other session path is governed by
the state's `tools.allow`. Storage is the **session store** (`src/core/session-store.ts`):
filesystem default at `<root>/sessions/`, `createBackendSessionStore({ backend, prefix })`,
`createMemorySessionStore()`. The checkpointer (`src/workflow/checkpointer.ts`) is `MemorySaver`
with write-through and lazy replay. The session id is bound with `AsyncLocalStorage` per turn and
stripped from paths (`src/core/path-mapping.ts`). Session handles: `agent.sessions.list/get/
delete`; firing → session resolution in `src/sessions/resolve.ts`. A sub-workflow
(`archmax_workflow_<slug>`, `src/workflow/sub-workflow.ts`) runs as a separate child session.

### Cases (`archmax test`)

Declarative YAML, one case per `workflows/<slug>/tests/*.test.yaml`, interpreted host-side by
`src/testing/`: `title` + `description`, `trigger`, `variables`, `workspace` (inline or
`{ from: }`), `mocks:`, and one flat `steps` list where actions (`send`/`decide`/`deliver`) and
assertions (`reachedState`, `reply`, `calledTool`, `trail`, `parked`, `grade`, …) are peers;
each assertion evaluates against the nearest action above. Strict zod (`case-schema.ts`,
`STEP_SCHEMAS`). `runner.ts` exposes
`discoverCases`/`runCase`/`runTests` returning data; the one partial matcher is
`src/core/match.ts`. Public subpath: `@archmax-ai/harness/testing`. Unit tests are colocated
`*.test.ts`; `src/behaviour/` drives the public barrel with a scripted fake model.

### Events and prompt

Every diagnostic flows through one typed stream (`src/core/events.ts`); pass `onEvent` to
`createAgent` to receive it (the CLI's state flow is built on it), omit it for the console
subscriber. Runtime notes are marked tool pairs (`isRuntimeNote`, `runtimeNoteKind`), never a
person's message. The system prompt has eight layers in a fixed order (`src/core/prompt.ts`):
`AGENTS.md`, consumer `systemPrompt`, the platform prompt (governed agents only),
workspace zones (rendered from mounts), the graph section (rendered from the spec),
`WORKFLOW.md`, the middleware's tool guidance (`write_todos`; Deep Agents 1.13 adds none for its
file tools), and the volatile "Current state" block. Layers 1–6 are the cacheable prefix; Deep
Agents' base prompt is dropped.

## Directory map

- `src/assembly/` createAgent · `src/agent.ts` ArchmaxAgent · `src/machine/` schema, lint,
  machine, triggers, variables, tool names, slugs · `src/validate/` · `src/workflow/` middleware,
  parks, control tools, automated states (orchestration, controls, code and grader runs,
  history), state channels, checkpointer, session view/artifacts, snapshot, prompt rendering and
  caching, sub-workflows · `src/kernel/` pure verdict function · `src/sandbox/` ·
  `src/sessions/` resume, resolve, operations, summary, scope · `src/testing/` cases ·
  `src/cli/` command, bootstrap, turn, state flow, banner, style · `src/core/` workspace,
  mounts, zones, session store/zone, events, messages, prompt,
  usage, match; `deepagents.ts` is the one framework seam · `src/public/` subpath barrels
  (`sandbox`, `testing`, `cli`) · `src/runtime/` contract versioning · `src/behaviour/`
  behaviour suite · `src/env.ts` · `src/index.ts` public barrel (tested against
  `docs/.../reference/public-api.md` both ways).
- `src/core/platform-prompt.md` — the platform prompt (movement and tools). `npm run build`
  (or `npm run generate:prompt`) generates `platform-prompt.generated.ts` from it, so it ships
  in the code; a test fails while the two differ. A workspace may override it by serving
  `.platform/system/GRAPH_STATE.md`.
- `examples/customer-support/` — reference workspace: `AGENTS.md`, `workflows/order-lookup/`
  (code-state scripts under its `scripts/`), skill bundles under `skills/`.
- `skills/archmax-harness/` — the authoring skill (`SKILL.md` plus `references/*.md`) that teaches
  a coding agent to author a workspace, shipped as `dist/authoring-skill/archmax-harness`
  (`BUNDLED_AUTHORING_SKILL_DIR` resolves to the `dist/authoring-skill` parent).
- `docs/` — Astro Starlight site, served at https://harness.archmax.ai. `openspec/` — specs
  (`openspec/specs/`) and in-flight changes.

## Conventions

- ESM only, Node ≥ 22. `tsconfig.json` typechecks incl. tests; `tsconfig.build.json` emits.
  `build` copies the sandbox prelude parts (`src/sandbox/assets/parts/`, now `code-state.js`)
  and `skills/archmax-harness` into `dist/` — never name a `src/` directory after a dist-root
  asset (`skills`, `examples`).
- **Slugs** are kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`) at both levels: the workflow directory
  and each state key. A slug is the only routing token (`to`, `on_error`, trigger entries,
  events, `reachedState`, `archmax_advance`); `title` is a label. Records and events carry
  `state`.
- **Zones**: read authored inputs from the owning skill bundle (`skills/<slug>/assets/…`), write
  every session file under `scratchpad/` (no leading slash). Authored mounts are read-only
  even outside governance. Deletion goes through `agent.sessions.delete(id)`, never `fs`.
- A custom `backend` needs an explicit `sessionStore`; storage is never inferred.
- No behaviour change ships without its docs: `docs/`, `README.md` and `skills/archmax-harness/`
  update in the same change. Any change to the authoring surface — the `workflow.yaml` schema,
  grader and code states and the code-state script contract, governance, human states, cases,
  the CLI, the wiring API — updates the skill. OpenSpec specs under `openspec/specs/` describe
  present behaviour.
