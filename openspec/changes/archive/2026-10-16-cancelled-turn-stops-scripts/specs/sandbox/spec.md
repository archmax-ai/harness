## ADDED Requirements

### Requirement: A cancelled turn stops its scripts

The turn's abort signal SHALL reach every sandbox evaluation of the turn: `archmax_eval`,
`archmax_run` and lifecycle hook scripts, in the session and in every child session it dispatched.
A hook's evaluation SHALL take the signal of the turn it runs in, read where the hook runs. Once the
signal aborts:

- the evaluation SHALL settle with an error at once, not at `timeoutMs`;
- a host call the script has pending SHALL be abandoned: it rejects inside the script with
  `the turn was aborted` without waiting for the tool;
- a host call the script makes from then on SHALL be refused the same way before it reaches the
  PTC gateway, so it emits no `tool-called` event and dispatches no sub-workflow.

An evaluation started under a signal that has already aborted SHALL not run.

#### Scenario: A script awaiting a child session is cancelled

- **WHEN** a script awaits a delegation call through `tools.*` and the host aborts the turn's signal
- **THEN** `send` settles, the script's evaluation ends with an error before its timeout, and no
  `sub-workflow-start` and no `script`-origin `tool-called` event is emitted after the abort

#### Scenario: A retry after the abort is refused

- **WHEN** a script catches the failed call and calls a tool again
- **THEN** that call rejects with `the turn was aborted` and the tool never runs

### Requirement: Disposal is safe while a host call is pending

Disposing a session SHALL be safe at any moment, including while a script's host call is still
pending in one of its REPLs. The runtime SHALL release the REPL at once: its pending calls are
abandoned, new calls are refused, and the next acquisition of its namespace starts a fresh REPL. It
SHALL free the REPL only when no host call made from it is pending and no evaluation is running in
it, on a later macrotask than the last settle, so a settling call always writes into a live
context. A call that would settle after the REPL was freed SHALL never settle into it. The wait
SHALL be bounded: a released REPL still busy past its last evaluation's deadline plus a grace
period SHALL be freed regardless. `dispose` SHALL stay synchronous.

#### Scenario: The host disposes a cancelled session at once

- **WHEN** a script awaits a host tool, the turn is aborted, the host disposes the session as soon
  as `send` settles, and the tool then resolves or rejects
- **THEN** no unhandled rejection is raised, QuickJS frees the REPL without an assertion, and
  another session in the same process still evaluates code

#### Scenario: A timed-out script's call outlives its turn

- **WHEN** a script's evaluation timed out with a call pending, and the session is disposed before
  that call settles
- **THEN** the REPL is freed cleanly once the abandoned call has settled

## MODIFIED Requirements

### Requirement: Pluggable sandbox runtime

Script execution SHALL target the `SandboxRuntime` interface — namespaced sessions with an
`eval(code, timeoutMs, signal)` operation, per-session options (tools, quotas, console capture,
session id) and disposal — with the bundled QuickJS implementation as the default and
a consumer-supplied `sandboxRuntime` accepted by `createAgent`. A custom runtime SHALL serve the
sandbox tools and lifecycle hooks alike; cases are interpreted host-side and never reach it. The
interface's contract SHALL include the turn's signal and disposal under a pending call, as the
requirements "A cancelled turn stops its scripts" and "Disposal is safe while a host call is
pending" state them.

#### Scenario: Default runtime

- **WHEN** no `sandboxRuntime` is supplied
- **THEN** scripts run in the bundled QuickJS sandbox

#### Scenario: Custom runtime serves every script context

- **WHEN** a caller supplies a custom `sandboxRuntime`
- **THEN** `archmax_eval`, `archmax_run` and hook scripts all execute through it, with per-scope
  namespacing preserved
