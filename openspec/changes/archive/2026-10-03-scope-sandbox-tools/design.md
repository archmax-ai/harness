## Context

See proposal.md for why the change is needed. This section describes how the bridge is built
today.

- **Selection happens before governance narrows the list.** The interpreter middleware sits
  outside the workflow middleware, so `ScriptInterpreter.wrapModelCall` (`src/sandbox/tools.ts`)
  sees the unfiltered `request.tools`. It keeps every tool except `PTC_EXCLUDED_TOOLS` (the
  controls and bare `eval`), wraps them with the PTC gateway, and stores them per scope.
- **The REPL freezes what it was given.** `@langchain/quickjs` injects `tools` as a plain object
  when a session first evaluates (`ensureStarted` → `injectTools`). `getOrCreate` returns the
  existing session and ignores later options. So whatever the first evaluation was handed stays
  in place for the scope's lifetime, across every state the turn moves through. Re-injecting is
  not possible from the host, because `injectTools` is private, and recreating the REPL would
  break the requirement that REPL state persists.
- **Enforcement already follows the state.** Every wrapped tool reads the gateway's per-session
  context, which `wrapModelCall` refreshes at each model call. A script's call is decided
  against the state in force, so only the names leak.
- **Hooks run elsewhere.** A hook evaluates in the `process` REPL of its session with the
  `lifecycle-hook` prelude, and gets the unfiltered set on runtime authority. It never runs the
  `ptc` prelude.

## Goals / Non-Goals

**Goals:**

- An agent script's `tools` enumerates exactly the tools the model is offered in the state the
  script's calls are governed against.
- REPL state keeps persisting: helpers and references from earlier evaluations keep working, and
  see the current state's surface.
- A blocked call keeps its reason and its `tool-blocked` event.

**Non-Goals:**

- **Changing what is disclosed.** The view follows `disclosedTools`. A bare `forbid: ["*"]`
  leaves disclosure as it is and lets the kernel refuse every call, and the view inherits that
  behaviour unchanged.
- **Narrowing a hook's view.** Hooks run on runtime authority, and their `tools` stays whole.
  Two inconsistencies found on the way are out of scope here, to be raised on their own: a hook
  can see `tools.task` (the kernel refuses the call), and a state's `tools.forbid` currently
  binds hooks.
- **Hiding names from a script that already knows them.** The view governs enumeration. A name
  the script spells out still resolves, so that governance can refuse the call with its reason.

## Decisions

### Re-scope inside the sandbox, through one stable proxy

The full wrapped set is still injected. The `ptc` prelude, which every agent evaluation runs
first, installs a view once per REPL: a `Proxy` over the injected object, stored as `tools`.
Its `ownKeys`, `has` and `getOwnPropertyDescriptor` report only the current surface. Its `get`
resolves any registered name. The installer also defines a non-enumerable, non-writable
`__archmaxScope(names)`, which replaces the surface and restores `globalThis.tools` to the view.
The executor emits `__archmaxScope([...])` with the camel-cased surface right after the prelude.

The installer is an IIFE, because `transformForEval` hoists top-level declarations to
`globalThis` and would publish its internals. It returns at once on every later evaluation, so
the identity of the view never changes.

- *Alternative: narrow the selection in `wrapModelCall`.* The REPL keeps the first evaluation's
  set, so the view would be the first state's for the whole turn, wrong after any advance.
- *Alternative: recreate the REPL when the state changes.* This loses REPL state, which the
  sandbox spec guarantees persists.
- *Alternative: a plain object mutated in place.* This would also keep identity, but a hidden
  name would then be `undefined`, and calling it would fail with a `TypeError` instead of
  governance's reason.

### The surface is the disclosed list, read from the gateway's live context

`PtcToolGateway.surface(sessionId)` returns `machine.disclosedTools(state)` minus
`PTC_EXCLUDED_TOOLS`, memoized per state. The state is the session's live context, the one every
wrapped tool reads when it decides a call. So the view and enforcement agree by construction,
including a message that batches `archmax_advance` with `archmax_eval`: both use the state of
the model call that issued them. Names the view lists but the REPL never injected (an allow
entry for a tool the host did not bind) are dropped inside the sandbox, because the installer
only reports names present on the injected object.

### Only the agent path is scoped

`ScriptRunParams.surface` is set by `archmax_eval` and `archmax_run` alone. A hook, a bespoke
`runCode` without the prelude, and the existing direct-executor tests pass no surface, and keep
the unscoped object exactly as today.

## Risks / Trade-offs

- [Model code can call `__archmaxScope` itself.] → It can only list names already on the
  injected object, every call stays governed, and the next evaluation re-scopes. The function is
  non-enumerable, so a listing of `globalThis` does not advertise it.
- [`typeof tools.x` is `"function"` while `"x" in tools` is `false` for a hidden registered
  tool.] → This is deliberate, so that a call reaches governance and its reason. The docs say
  so.
- [A REPL created before any model call in this process has no tools.] → This is unchanged.
  The scope's tool set falls back to empty today, and the view then lists nothing.

## Migration Plan

None. Sessions and specs are untouched. A script that enumerated `tools` now sees fewer names.
Every call it could make before is decided exactly as before.
