# Tasks

## 1. The sandbox runtime

- [x] 1.1 In `src/sandbox/runtime.ts`, give `SandboxSession.eval` an optional `signal` and hold each REPL as a lease: guarded tools and `task()` dispatch, counts of pending calls and running evaluations, release on `dispose`, free on a macrotask once idle, and a backstop at the last deadline plus a grace period. Verify with `src/sandbox/runtime.test.ts`: an abort settles the eval before its timeout, the pending call is abandoned and the next refused, an already-aborted eval does not run, a dispose under a pending call frees cleanly whether the call resolves or rejects, a timed-out eval's call does the same, a running eval delays the free, and the namespace starts afresh.
- [x] 1.2 Check the tests fail against the previous `runtime.ts`: all eight do, the dispose cases with the production `JS_FreeRuntime` assertion and an unhandled `QuickJSUseAfterFree`.

## 2. The signal reaches every script

- [x] 2.1 Add `ScriptRunParams.signal` in `src/sandbox/executor.ts` and pass it to `eval`.
- [x] 2.2 Pass the call's `signal` from `archmax_eval` and `archmax_run` in `src/sandbox/tools.ts`.
- [x] 2.3 Add `LifecycleContext.signal` in `src/lifecycle/runner.ts`, passed to a script hook's run, and fill it from the live runtime at the three sites that build a hook's context: `wrapModelCall` (`governance.ts`), the advance in `wrapToolCall` (`tool-service.ts`) and the terminal `after` hook in `afterModel` (`middleware.ts`).

## 3. Behaviour

- [x] 3.1 Add `src/behaviour/cancelled-turns.test.ts`. A script fans out over a child workflow whose model stalls until the abort, and `send` settles with no `sub-workflow-start` and no `script`-origin `tool-called` after the abort. A script awaits a host tool, the turn is aborted, the session is disposed as soon as `send` settles, and the tool then resolves or rejects: no unhandled rejection, no assertion at the free, and another session still evaluates. Check they fail against the previous runtime.

## 4. Docs, skill and specs

- [x] 4.1 `docs/`: `reference/public-api.md` (a "Cancelling a turn" section, `ctx.signal` for `hookExecutors`, the `sandboxRuntime` obligations), `guides/code-interpreter.md` ("A script lives as long as its turn"), and the changelog.
- [x] 4.2 `skills/archmax-harness/`: `references/hook-and-test-scripts.md` and `references/backend-integration.md`.
- [x] 4.3 Sync the delta into `openspec/specs/sandbox/spec.md` and run `npx openspec validate --specs`.
- [ ] 4.4 File the upstream issue with `@langchain/quickjs` (`langchain-ai/deepagentsjs`) and link it from the changelog entry.
