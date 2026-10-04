## 1. The view

- [x] 1.1 In `src/sandbox/prelude.ts`, extend the `ptc` prelude with the view installer: an IIFE that runs once per REPL. It captures the injected `tools`, installs a `Proxy` whose `ownKeys`, `has` and `getOwnPropertyDescriptor` report the current surface and whose `get` resolves any injected name, and defines a non-enumerable, non-writable `__archmaxScope(names)` that sets the surface and restores `globalThis.tools` to the view. Verify with `src/sandbox/prelude.test.ts`: the `ptc` prelude carries the marker and the installer, and still none of the hook vocabulary.
- [x] 1.2 In `src/sandbox/executor.ts`, add `ScriptRunParams.surface` (tool names) and, when it is set on a `ptc` run with the prelude, emit `globalThis.__archmaxScope([...])` with the names camel-cased by `@langchain/quickjs`'s `toCamelCase`, right after the prelude. A hook run and a `runCode` without the prelude emit nothing. Verify with `src/sandbox/executor.test.ts`.
- [x] 1.3 In `src/sandbox/ptc-gateway.ts`, add `surface(sessionId)`: `machine.disclosedTools(state)` for the session's live context, minus `PTC_EXCLUDED_TOOLS`, memoized per state. Verify with `src/sandbox/ptc-gateway.test.ts`: the surface follows `refresh`, and the controls and sandbox tools never appear.
- [x] 1.4 In `src/sandbox/tools.ts`, pass `surface: ptcGateway?.surface(scope)` from `archmax_eval` and `archmax_run`, and say in both descriptions that `tools.*` holds this state's tools. Verify with `src/sandbox/tools.test.ts`.

## 2. Through the real sandbox

- [x] 2.1 In `src/sandbox/ptc-governance.integration.test.ts`, against a real QuickJS session:
  - the keys follow `refresh` from one state to the next in the same REPL;
  - a reference kept by an earlier evaluation reads the new surface and is the same object;
  - a script that overwrites `tools` gets the view back;
  - a hidden tool's call is refused by the kernel with its reason and a `tool-blocked` event, and the script can catch it;
  - a run without a surface (a hook's path) keeps every tool.

  Verify that the file passes.
- [x] 2.2 In `src/behaviour/sandbox-run.test.ts`, through the public API: `Object.keys(tools)` in an `archmax_eval` lists the first state's tool and not the second's, and after an advance the next evaluation lists the second's. A `before` hook's `tools` lists both. Verify that the file passes.

## 3. Docs and authoring skill

- [x] 3.1 Update `docs/src/content/docs/guides/code-interpreter.md`, which says that `tools` exposes every agent tool, and `skills/archmax-harness/references/hooks-and-scripts.md`. Both say an agent script's `tools` lists the active state's tools, re-scoped every evaluation, that a hidden name still resolves so its call is refused with a reason, and that a hook's `tools` keeps every tool. Verify with `npm run docs:build` and a grep for "every agent tool".
- [x] 3.2 In `docs/src/content/docs/reference/changelog.md`, add the entry to the 0.3.0 section. Verify that it renders in `npm run docs:build`.

## 4. Verify

- [x] 4.1 Run `npm run typecheck`, `npm test` and `npx openspec validate scope-sandbox-tools --strict`. All pass.
- [x] 4.2 Run the reference workspace's suite against a live model (`npm run dev -- test order-lookup --root examples/customer-support`), whose cases use `archmax_eval`, `archmax_run` and scripted delegation. All pass.
