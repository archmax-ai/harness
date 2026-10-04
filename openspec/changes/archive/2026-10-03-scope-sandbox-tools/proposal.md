## Why

A script the agent runs with `archmax_eval` or `archmax_run` sees every tool the assembly
registered, not only the tools of the state it runs in. `Object.keys(tools)` in a state that
allows two tools lists all 120 tools of a connected GitHub MCP server. The calls are still
governed, because the kernel refuses each one the state does not allow. But the names leak.
That defeats per-state disclosure, which hands the model only the active state's tools so that
it never reasons about tools it cannot use. It also spends tokens on a listing the model then
acts on. A consumer saw exactly this in a session on the archmax platform.

## What Changes

- For an agent script (`archmax_eval`, `archmax_run`), `tools` lists only the active state's
  tools: the names the model's own tool list carries in that state, minus the runtime controls
  that scripts never call. `Object.keys`, `in` and `for…in` see only those names.
- The view is re-scoped at the start of every evaluation, against the state the script's calls
  are governed against. After an `archmax_advance`, the next evaluation in the same REPL sees
  the new state's tools.
- `tools` stays one stable object across evaluations. A helper or a `const t = tools` kept from
  an earlier evaluation reads the current state's surface. A script that overwrites `tools` gets
  the view back at its next evaluation.
- A name outside the view that still names a registered tool resolves as before. Calling it
  reaches governance, which refuses it with its reason and a `tool-blocked` event, exactly as it
  refuses the model's own call to a tool the state does not offer.
- Lifecycle hooks are unchanged. A hook runs on runtime authority, and its `tools` keeps every
  tool on the bridge.
- The `ptc` prelude gains the installer that does this, beside the `SANDBOX_CONTRACT` marker.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `sandbox`: what an agent script's `tools` enumerates, when it is re-scoped, and what the `ptc`
  prelude installs.

## Impact

- **Code:**
  - `src/sandbox/prelude.ts`: the view installer in the `ptc` prelude.
  - `src/sandbox/executor.ts`: `ScriptRunParams.surface`, emitted as the scope call after the
    prelude.
  - `src/sandbox/ptc-gateway.ts`: `surface(sessionId)`, the state's disclosed tools minus the
    PTC exclusions, read from the same live context the kernel governs script calls against.
  - `src/sandbox/tools.ts`: the agent's two sandbox tools pass the surface, and their
    descriptions say that `tools` holds this state's tools.
- **Public API:** none. `ScriptRunParams` and `PtcToolGateway` are internal.
- **docs/:**
  - `guides/code-interpreter.md`: what `tools` exposes to an agent script and to a hook.
  - `reference/changelog.md`.
- **skills/archmax-harness/:** `references/hooks-and-scripts.md`, which describes what a
  script's `tools` holds, and that a hook's keeps every tool.
- **README.md:** no change, because it does not describe the bridge's contents.
- **Release:** part of the `release:minor` PR that also carries `add-archmax-raise`.
- **Archive order:** archive this change after `add-archmax-raise`. Both modify the sandbox
  requirement "Programmatic tool calls are governed per call", and this delta carries that
  change's wording.
