## Why

The platform reported that cancelling a turn ended its worker process, and every turn running in
that process with it. The turn's script awaited child sessions through `tools.*` when the person
cancelled it. Three gaps meet:

- **The sandbox never sees the turn's abort signal.** `SandboxSession.eval(code, timeoutMs)` takes
  none. A cancelled script runs on until its timeout, and its `tools.*` calls keep reaching tools:
  the production script caught its failed dispatch and started another under the cancelled turn.
- **Disposal does not wait for calls in flight.** `dispose(sessionId)` reaches
  `ReplSession.deleteSession` synchronously, whatever is pending in the REPL. A host that disposes
  in a `finally` around `send`, as the platform does, frees a REPL that a call will still write
  into. The same happens without a host: a script whose evaluation timed out with a call pending
  has its REPL freed by `afterAgent` when the turn ends.
- **`@langchain/quickjs` writes into the context after an await without checking it.** Both host
  bridges settle the script's promise with `context.newString` or `context.newError` once the host
  call settles. Into a freed context that throws from a detached async function, an unhandled
  rejection, which ends a Node process. QuickJS also asserts in `JS_FreeRuntime`, because the
  pending promise's resolvers are still alive at the free.

The platform found it in production on 0.6.0 and reproduced it against `@langchain/quickjs` 0.6.3.

## What Changes

- **A cancelled turn stops its scripts.** `SandboxSession.eval` takes the turn's signal as a third
  argument. `archmax_eval` and `archmax_run` pass their call's, and a hook script the signal of the
  turn it runs in, read where the hook runs. Child sessions inherit the parent's signal through
  their run config, so the signal reaches their scripts too. Once it aborts, the evaluation settles
  with an error at once, a pending host call is abandoned, and a new one is refused before it
  reaches the PTC gateway.
- **Disposal is safe while a call is in flight.** The bundled runtime holds each REPL as a lease
  that counts its pending host calls and running evaluations. Disposal releases the lease: its
  calls are abandoned, new ones refused, and the namespace starts afresh on its next acquisition.
  The REPL is freed once the lease is idle, on a later macrotask. A backstop frees it at its last
  evaluation's deadline plus a grace period, whatever is still running. `dispose` stays
  synchronous.
- **`LifecycleContext.signal`.** A custom `hookExecutors` kind receives the turn's signal too.
- **Upstream.** An issue asks `@langchain/quickjs` to check `context.alive` before settling a
  bridged call. The harness's fix does not wait for it.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `sandbox`: two new requirements, "A cancelled turn stops its scripts" and "Disposal is safe while
  a host call is pending"; "Pluggable sandbox runtime" names the signal and the disposal contract.

## Impact

- **Code:** `src/sandbox/runtime.ts` (leases, guarded tools, deferred free), `src/sandbox/executor.ts`
  (`ScriptRunParams.signal`), `src/sandbox/tools.ts` (both tools pass their signal),
  `src/lifecycle/runner.ts` (`LifecycleContext.signal`, passed to a script hook's run), and the
  three call sites that build a hook's context (`src/workflow/governance.ts`,
  `src/workflow/tool-service.ts`, `src/workflow/middleware.ts`).
- **Tests:** `src/sandbox/runtime.test.ts`; `src/behaviour/cancelled-turns.test.ts` through `send`
  and `dispose`; QuickJS free and unhandled-rejection watchers in `src/behaviour/support.ts`.
- **Docs:** `reference/public-api.md` (cancelling a turn, `hookExecutors`, `sandboxRuntime`),
  `guides/code-interpreter.md`, `reference/changelog.md`.
- **Authoring skill:** `references/hook-and-test-scripts.md` (what a script sees when its turn is
  cancelled) and `references/backend-integration.md` (cancelling and disposing).
- **Release:** no breaking change. `SandboxSession.eval` gains an optional argument and `dispose`
  stays synchronous, so it could ship as a patch. On this branch it ships with 0.7.0.
