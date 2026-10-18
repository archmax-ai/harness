## Context

See proposal.md for why. The relevant code before the change:

- `createQuickJsSandboxRuntime` (`src/sandbox/runtime.ts`) wraps `ReplSession.getOrCreate`, and
  its `dispose` calls `ReplSession.deleteSession`, which frees the context and runtime at once.
- The bridge (`injectTools` in `@langchain/quickjs`) calls `t.invoke(input)` with no config. The
  PTC gateway forwards the turn's config, so a tool reads the signal, but nothing between the REPL
  and the gateway does.
- `ReplSession.eval` polls the script's promise every millisecond until it settles or the deadline
  passes. Its interrupt handler fires only while QuickJS executes bytecode.
- A hook's `LifecycleContext.config` is captured at the session's last model call.

## Goals / Non-Goals

**Goals:**

- No call settles into a freed context, whether the REPL was disposed by a host, by `afterAgent`
  or by `sessions.delete`.
- A cancelled turn's scripts stop at once and start no work.
- `dispose` stays synchronous.

**Non-Goals:**

- **Stopping a tool that ignores the signal.** Its call is abandoned, so the script and the REPL
  move on, and the tool runs to its end with its result dropped.
- **Interrupting a CPU-bound script.** QuickJS runs it synchronously on Node's event loop, so no
  abort can be observed until it yields. Its deadline still bounds it.
- **Refusing calls in the PTC gateway.** See decision 5.

## Decisions

1. **Abandon pending calls rather than wait for them.** On an abort or a release, the guard around
   each tool rejects the script's call at once instead of waiting for the tool. The bridge then
   writes the rejection into a context that is still alive, the script resumes, and its next calls
   are refused, all in microtasks. That makes disposal bounded by construction. The alternative,
   counting calls until the tools themselves settle, leaves a REPL alive as long as the slowest tool
   that ignores the signal.

2. **Free on a macrotask once idle.** The lease counts pending calls and running evaluations. When
   both reach zero after a release, the free is scheduled with `setImmediate`. A call's settle,
   the bridge's write and its `executePendingJobs` all run in the microtasks that follow, so they
   land before the free. The callback re-checks the counts, because a resumed script may have made
   another (refused) call. Waiting for running evaluations matters as much as waiting for calls:
   `ReplSession.eval` holds the script's promise handle until it returns, and a free under it trips
   the same `JS_FreeRuntime` assertion.

3. **Settle the eval host-side; do not interrupt QuickJS.** An aborted evaluation resolves its
   caller with an `AbortError` result as soon as the signal fires. Interrupting the runtime was
   tried and rejected. An interrupt raised inside a resumed continuation leaves the async function's
   promise pending until the deadline, and `executePendingJobs` leaks the error handle it returns,
   so the later free asserts.

4. **Hold REPLs in the runtime's own map.** Each lease constructs its `ReplSession` directly and
   never registers it in `ReplSession`'s process-wide map. A released namespace then starts afresh
   on its next acquisition while the old REPL waits to be freed, and the old instance's `dispose`
   cannot remove the new one by id.

5. **Refuse in the runtime, from the evaluation's signal.** The guard refuses a call when the
   signal of the lease's latest evaluation has aborted. The PTC gateway could refuse on its context
   config's signal instead, but that signal is refreshed per model call. A resumed turn that runs a
   hook before its first model call would read the previous turn's signal, and a cancelled reply
   would make the next decision's hook calls fail. For the same reason a hook's evaluation takes the
   signal of its own call site (`LifecycleContext.signal`), not `config.signal`.

6. **A backstop, not a timeout.** Evaluations always end by their deadline (`timeoutMs` is a
   positive integer) and pending calls are abandoned at the release, so a released lease goes idle
   on its own. The backstop frees it at its last evaluation's deadline plus one second regardless.
   A free under a running evaluation still trips the assertion, which `ReplSession.dispose`
   swallows, and leaks that one REPL rather than ending the process. A call that would settle after
   such a free never settles.

## Risks / Trade-offs

- **The guard depends on the bridge's call shape.** It wraps `invoke`, which the bridge calls
  synchronously from the host function, so a call is counted before the script can suspend. A
  bridge that queued calls before invoking would leave a gap until it invokes. The `task()` bridge
  queues, which is why its dispatch is guarded at call time and a dispatch reached after a free
  never settles. No sandbox context exposes `task()` today.
- **An interrupted continuation still leaks.** A script whose evaluation timed out, and that later
  runs enough code after a settled call to be interrupted, leaks one error handle, and its free
  asserts. That was true before the change, and `ReplSession.dispose` swallows it. It needs a
  continuation that runs heavy code past its deadline. A cancel resumes the script at once, well
  before it.
- **Every free throws a benign error in this QuickJS version.** `QuickJSRuntime.dispose` throws
  `QuickJSRuntime … not found when trying to free HostRef` even for an idle REPL.
  `ReplSession.dispose` swallows it. The tests tell it apart from the assertion, which is an
  `Aborted(…)` `RuntimeError`.
