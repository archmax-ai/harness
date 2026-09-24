# AGENTS.md

Guidance for coding agents working in this repository (Claude Code and others read this file).
Vocabulary: one term per concept, as defined in `docs/src/content/docs/reference/glossary.md` —
session (not run/thread), turn (not segment), state (not node), hook/verdict, case/grade,
archmax harness/runtime/kernel/Deep Agents ("archmax harness", or "the harness" once named, is
the SDK; never "framework" for it, and never "harness" for the runtime or kernel).

## What this is

`@archmax-ai/harness` is **archmax harness**: a thin, governed layer over
[LangChain Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview)
(Node/TypeScript, ESM). It assembles one Deep Agent per workflow, serves the agent's workspace
through a Deep Agents backend, and enforces a declarative state machine (`workflow.yaml`) with
middleware and a pure decision kernel. It contains **no use-case logic** — everything specific
lives as files in a workspace; `examples/customer-support/` is the reference workspace (not
shipped in `dist/`).

Everything the runtime reads — specs, prompts, subagents, hook scripts, skill bundles — comes
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
| `archmax run <workflow> <prompt...>`                     | Start or continue a session (`--session`, `--trigger`, `--variables`) |
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
`model` or a per-role `modelFactory` to `createAgent` instead.

## Architecture

### `workflow.yaml` is the single source of truth

A workflow is `workflows/<slug>/workflow.yaml` plus an optional `WORKFLOW.md` (plain Markdown
prose appended after the rendered graph section; frontmatter there is a `competing-machines`
load error). The schema is **one strict zod schema**, `src/machine/spec-schema.ts`: every root
and state key, enums, path grammars, and `refineSpec` for cross-references (targets exist, one
`manual` start, trigger ownership, `${{…}}` guard references). Warnings live in
`src/machine/lint-spec.ts`; both the loader and `validate` run both. An unknown key is a load
error naming the key. The one loose spot is `triggers.<id>` (host-extensible).
`WorkflowMachine` (`src/machine/machine.ts`) is the compiled object the runtime consults.
`src/validate/` adds what needs more than the document: hook scripts and imports, `SUBAGENT.md`,
the skill registry, sibling workflows, case files, kernel probes.

### Execution: one Deep Agent graph per workflow

`createAgent` (`src/assembly/index.ts`; composition in `compose.ts`, plain agent in `plain.ts`,
lazy child compositions in `delegation-registry.ts`) returns a `ArchmaxAgent` (`src/agent.ts`)
wrapping the one `createDeepAgent` graph. The graph's checkpointed state carries the machine's
position, variables, trail and park records as extra channels (`src/workflow/state.ts`).
Governance is middleware (`src/workflow/middleware.ts`): `beforeAgent` is the turn boundary
(trigger → start state or retained position; `disabled`/`requires` refusals; locked seeds; spec
snapshot), `wrapModelCall` applies the per-state tool surface and prompt and runs the `before`
hook, `wrapToolCall` services the control tools and applies the kernel verdict to every call,
`afterModel` does budgets, `on_error` and the terminal `after` hook. The agent moves only by
`archmax_advance({ to, reason })`: edge validated, leaving state's `after` hook, target's
`before` hook, then the target's tools unlock. **Parks are LangGraph interrupts**
(`src/workflow/parks.ts`): a human state parks for a decision, `archmax_wait` for input. Every way
back in is `agent.workflow.send(sessionId, input)` → one `Outcome` (`src/sessions/resume.ts`;
`decide`/`reply`/`deliver` are conveniences). A park, a decision routed to another human
state, or a reply to a parked session spends one reply-only model call — the handoff message.
Assembly **fails closed**: `WorkflowLoadError`, `SessionStoreRequiredError`,
`AuthoringBackendExposedError`.

### Hooks contract

A hook is `before:`/`after:` on a state: `{ script: hooks/<file>.js }` (confined to the
workflow's `hooks/`), `{ subagent: <name> }`, or a custom kind registered via `hookExecutors`.
A script's default export receives `{ state, phase, trigger, variables, messages, tools, from?,
to?, reason? }` and returns `ok()`, `veto(reason)`, `correct(reason)`, `false` (veto) or
nothing (ok); throwing vetoes, and so does returning any other object (a verdict got wrong
fails closed with its keys named, never read as `ok`). A custom `hookExecutors` kind's value is
reduced by the same rules — one verdict vocabulary, whoever implements the kind. `before` is ok/veto only; `max_corrections` bounds `correct` on
`after`. Hooks run on runtime authority (the state's allow and forbid lists do not bind them;
safety rules and the workflow-wide `forbid_always` do). `task()` is available to hooks only. Types: `@archmax-ai/harness/sandbox`. Runner:
`src/lifecycle/`.

### Sandbox

`archmax_eval`, `archmax_run` (always-on in every state; an allow entry may narrow which files
`archmax_run` may execute) and hook scripts share one QuickJS sandbox (`@langchain/quickjs`),
one REPL session per session scope (`src/sessions/scope.ts`). Scripts get `args` (flat
`args.variables` for `archmax_run`) and `tools.*`, the governed privileged tool-call bridge.
`src/sandbox/`: `prelude.ts` + `assets/parts/*.js`, `executor.ts` (reads sources through the
authoring backend), `tools.ts`, `bridge.ts` (`task()` ↔ subagents), `ptc-gateway.ts`. Cases do
not run in the sandbox.

### Sessions and the workspace

The agent's workspace root **is the session**. The composite (`src/core/workspace-context.ts`)
routes its default to the session zone (`src/core/session-zone.ts`) and mounts authored content
read-only at the keys of a consumer-composed table (`workspace.mounts`; `defaultMounts(rootDir)`
is the conventional default; `mountSubtree` rebases; `MountCollisionError` on a shadowed area).
Session areas (`src/core/zones.ts`): `scratchpad/` (always read/write, rule `tool.scratchpad`),
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
`WORKFLOW.md`, Deep Agents' tool guidance, and the volatile "Current state" block. Layers 1–6
are the cacheable prefix; Deep Agents' base prompt is dropped.

## Directory map

- `src/assembly/` createAgent · `src/agent.ts` ArchmaxAgent · `src/machine/` schema, lint,
  machine, triggers, variables, tool names, slugs · `src/validate/` · `src/workflow/` middleware,
  parks, control tools, state channels, checkpointer, session view/artifacts, snapshot, prompt
  rendering and caching, sub-workflows · `src/kernel/` pure verdict function · `src/sandbox/` ·
  `src/lifecycle/` hooks · `src/subagents/` · `src/sessions/` resume, resolve, operations,
  summary, scope · `src/testing/` cases · `src/cli/` command, bootstrap, turn, state flow, banner,
  style · `src/core/` workspace, mounts, zones, session store/zone, events, messages, prompt,
  usage, match; `deepagents.ts` is the one framework seam · `src/public/` subpath barrels
  (`sandbox`, `testing`, `cli`) · `src/runtime/` contract versioning · `src/behaviour/`
  behaviour suite · `src/env.ts` · `src/index.ts` public barrel (tested against
  `docs/.../reference/public-api.md` both ways).
- `src/core/platform-prompt.md` — the platform prompt (movement and tools). `npm run build`
  (or `npm run generate:prompt`) generates `platform-prompt.generated.ts` from it, so it ships
  in the code; a test fails while the two differ. A workspace may override it by serving
  `.platform/system/GRAPH_STATE.md`.
- `examples/customer-support/` — reference workspace: `AGENTS.md`, `workflows/order-lookup/`,
  `subagents/`, skill bundles under `skills/`.
- `skills/archmax-harness/` — the authoring skill (`SKILL.md` plus `references/*.md`) that teaches
  a coding agent to author a workspace, shipped as `dist/authoring-skill/archmax-harness`
  (`BUNDLED_AUTHORING_SKILL_DIR` resolves to the `dist/authoring-skill` parent).
- `docs/` — Astro Starlight site, served at https://harness.archmax.ai. `openspec/` — specs
  (`openspec/specs/`) and in-flight changes.

## Conventions

- ESM only, Node ≥ 22. `tsconfig.json` typechecks incl. tests; `tsconfig.build.json` emits.
  `build` copies the sandbox prelude parts and `skills/archmax-harness` into `dist/` — never
  name a `src/` directory after a dist-root asset (`skills`, `examples`).
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
  the hook contract, governance, human states, cases, the CLI, the wiring API — updates the
  skill. OpenSpec specs under `openspec/specs/` describe present behaviour.
