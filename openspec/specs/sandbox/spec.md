# sandbox Specification

## Purpose

Define the one QuickJS sandbox the archmax harness runs authored JavaScript in: the two sandbox tools the
agent calls (`archmax_eval` for inline code, `archmax_run` for a script file from a skill bundle)
and the code-state scripts the runtime runs when a session enters a code state, each governed
against the state it runs for. It fixes the two execution
contexts and what each exposes, how script sources are read and prepared, how programmatic tool
calls (PTC) are governed, the quotas that bound a session, and the pluggable runtime interface
the bundled QuickJS engine implements. Cases never run in the sandbox.

## Requirements

### Requirement: Two sandbox tools, one REPL session per scope

The runtime SHALL expose `archmax_eval`, which evaluates inline code supplied by the model, and
`archmax_run`, which executes a script file read through the workspace backend. Both SHALL
evaluate in the same REPL session for a session scope — keyed by the executing session, with a
child session's scope nested beneath its parent's — under the same contract and the same PTC
surface, so the only difference is where the source came from. REPL state and `console.*` output
SHALL persist across calls in one scope, and disposing a session SHALL release its scope and
every child scope beneath it.

#### Scenario: Inline code evaluated

- **WHEN** the agent calls `archmax_eval` with a snippet
- **THEN** the runtime evaluates it in the sandbox and returns the last expression value, with
  captured console output

#### Scenario: State shared between the two tools

- **WHEN** an `archmax_run` file defines a helper and a later `archmax_eval` call in the same scope
  references it
- **THEN** the helper is in scope, because both ran in the same REPL session

#### Scenario: A tool named bare `eval` is refused

- **WHEN** a tool named `eval` is called by the model or a script
- **THEN** the call is blocked by a non-overridable safety rule naming `archmax_eval` instead

### Requirement: Two execution contexts with distinct globals

The runtime SHALL define exactly two sandbox contexts, `ptc` and `code`, each with its own prelude
assembled from versioned parts and selected by the executor from how the script is run. The `ptc`
prelude (for `archmax_eval` and `archmax_run`) SHALL install the `SANDBOX_CONTRACT` marker and the
state-scoped view of `tools` (see "An agent script's tools are the active state's surface"), and
nothing else; `tools` and `args` are injected by the executor. The `code` prelude (for a code
state's script) SHALL install the `SANDBOX_CONTRACT` marker, the `defineCodeState` identity alias
that registers the default export, and the same state-scoped view of `tools`, scoped to the code
state. `SANDBOX_CONTRACT` SHALL be `{ context, version }`, with `context` one of `ptc` and `code`
and `version` the sandbox contract version, `3`, which is the only one. Neither context SHALL carry
a verdict helper (`ok`, `veto`, `correct`), `defineHook`, a verdict reducer or driver members, and
there SHALL be no context for cases or for grader states, which the runtime runs outside the
sandbox.

There SHALL be no third prelude. The removed `lifecycle-hook` context is not one of the contexts,
and no compatibility prelude for the removed hook vocabulary exists, so no source selects one and
no assembly installs one.

#### Scenario: Prelude selected by context

- **WHEN** the executor runs a code state's script
- **THEN** the `code` prelude is installed, and running source via `archmax_run` or
  `archmax_eval` installs the `ptc` prelude instead

#### Scenario: Contract marker is introspectable

- **WHEN** a script reads `SANDBOX_CONTRACT`
- **THEN** it sees `{ context: "ptc", version: 3 }` in `archmax_eval` and `archmax_run`, and
  `{ context: "code", version: 3 }` in a code state's script

#### Scenario: Only two preludes exist

- **WHEN** the assembled preludes are enumerated
- **THEN** there are exactly two, `ptc` and `code`, and neither is a compatibility shim for a
  removed vocabulary

#### Scenario: The removed hook vocabulary is not provided

- **WHEN** a code state's script calls `veto("no orders")`, or references `ok`, `correct` or
  `defineHook`
- **THEN** each is undefined, the reference throws, and the state's execution fails like any script
  error

### Requirement: Typed imports are stripped, foreign imports are errors

The executor SHALL accept code-state scripts that begin with static imports from
`@archmax-ai/harness/*` specifiers (type carriers such as
`import { defineCodeState } from "@archmax-ai/harness/sandbox"`), SHALL strip them before
evaluation while preserving line count, and SHALL reject any other import specifier with
`ForbiddenSandboxImportError` naming the specifier — at execution and in `archmax validate`. The
package SHALL ship `@archmax-ai/harness/sandbox` as an entry point whose one runtime member is
`defineCodeState` and whose types describe a code state's input (`CodeStateInput`,
`CodeStateArgs`, `CodeStateFn`, `HistoryMessage`, `SessionHistory`, `TrailStep`,
`SandboxTools`). It SHALL export none of the removed hook vocabulary (`ok`, `veto`, `correct`,
`defineHook`, `HookArgs`, `HookResult`).

#### Scenario: @archmax-ai/harness import stripped

- **WHEN** a code state's script begins with
  `import { defineCodeState } from "@archmax-ai/harness/sandbox";`
- **THEN** it executes as if the line were absent, with `defineCodeState` provided by the `code`
  prelude, and stack traces still point at the right source lines

#### Scenario: Foreign import rejected

- **WHEN** a code state's script imports `node:fs`
- **THEN** the script is rejected with an error naming `node:fs`, the state's execution fails, and
  validation reports the same

#### Scenario: The entry point carries no hook vocabulary

- **WHEN** the runtime members of `@archmax-ai/harness/sandbox` are enumerated
- **THEN** `defineCodeState` is the only one, and none of `ok`, `veto`, `correct` or `defineHook`
  is exported

### Requirement: Script arguments, variables and return value

`archmax_run` SHALL pass the call's arguments to the script as the global `args`, with the
session's variables as the flat read-only map `args.variables` (`name → value`, including the
built-in `trigger`, structured values whole). A code state's script SHALL receive the same map as
`input.variables` and `args.variables`. Mutating the map SHALL not affect the checkpointed
variables; a code state's script writes variables only through `tools.archmax_set_variables`.
Both sandbox tools SHALL return the last expression value, formatted, to the model, with errors
reported as a tool error message rather than thrown out of the graph. A code state's script's
return value SHALL NOT be read.

#### Scenario: Script reads a variable

- **WHEN** an upstream state set `case_id` and an `archmax_run` script reads `args.variables.case_id`
- **THEN** it is that value directly, as `input.variables.case_id` is in a code state's script

#### Scenario: Snapshot mutation is inert

- **WHEN** a script assigns to `args.variables.case_id`
- **THEN** the session's checkpointed variables are unchanged after the script returns

#### Scenario: A code state's script writes through the variable tool

- **WHEN** a code state's script assigns `input.variables.case_id = "x"` and then calls
  `tools.archmax_set_variables({ variables: { case_id: "y" } })`
- **THEN** only the tool call writes a variable, and the rules that write follows are the
  `automated-states` capability's

### Requirement: `archmax_run` executes skill-bundle sources only

`archmax_run` SHALL execute only sources that resolve inside a skill of the assembly's resolved
skill registry, read through the backend; any other path SHALL be blocked by the non-overridable
`script.skill-only` rule ahead of the declared denials, consumer and per-state rules, and a script in a skill
the state does not enable SHALL be refused by `skill.not-allowed`. Both sandbox tools are
default tools: granted in every state of a workflow that does not declare `tools.allow_always`,
and otherwise only where `tools.allow_always` or a state's `tools.allow` names them, and never in
an automated state. A state's own `tools.allow` entry on `archmax_run` SHALL narrow which files it
may execute there (or grant it there, when the workflow-wide grant omits it), and an entry naming
paths outside `skills/` SHALL be inert and reported by validation. A code state's script under
`workflows/<slug>/scripts/` SHALL run only when the session enters its code state, never through
`archmax_run`.

#### Scenario: Non-skill source blocked

- **WHEN** the agent calls `archmax_run` on `scratchpad/x.js` or a `workflows/**` path
- **THEN** the call is blocked with rule `script.skill-only`, whatever the state declares

#### Scenario: Restricted script path

- **WHEN** a state allows `{ tool: archmax_run, paths: ["skills/order-data/scripts/lookup.js"] }`
- **THEN** only that script may run in that state and other skill scripts are blocked

#### Scenario: A workflow that omits the sandbox tools

- **WHEN** a workflow declares `tools.allow_always: [read_file, ls]` and the model calls `archmax_eval` in a state that does not name it
- **THEN** `archmax_eval` is not disclosed and the call is blocked with `tool.not-allowed`, while the workflow's code states still run their scripts in the sandbox

#### Scenario: A code state's script is not the agent's to run

- **WHEN** the agent calls `archmax_run` on `workflows/order-lookup/scripts/check-refund.js`, the
  script of a code state
- **THEN** the call is blocked with rule `script.skill-only`, and the script runs only when the
  session enters `check-refund`

### Requirement: Quotas and settings

Every sandbox session SHALL run under the workflow's `settings`: `timeoutMs` (per evaluation,
default 5,000 ms), `memoryLimitBytes`, `maxPtcCalls` (null for unbounded) and `maxResultChars`,
expressed against the runtime interface so any implementation receives them. Exceeding a quota
SHALL surface as a script error: a sandbox tool reports it to the model as a tool error, and in a
code state it fails the state's execution, which the `automated-states` capability routes.

#### Scenario: Evaluation times out

- **WHEN** a script runs longer than `settings.timeoutMs`
- **THEN** the evaluation fails with a timeout error the caller reports as a tool error (or, for a
  code state's script, as the failure of the state's execution)

### Requirement: A cancelled turn stops its scripts

The turn's abort signal SHALL reach every sandbox evaluation of the turn: `archmax_eval`,
`archmax_run` and a code state's script, in the session and in every child session it dispatched.
A code state's script SHALL take the signal of the turn in which the session enters its code state.
Once the signal aborts:

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

#### Scenario: A code state's script is cancelled

- **WHEN** a code state's script awaits `tools.lookupOrder` and the host aborts the turn's signal
- **THEN** the evaluation ends with an error before its timeout, the pending call rejects inside the
  script with `the turn was aborted`, and no `script`-origin `tool-called` event is emitted after
  the abort

#### Scenario: A chained code state does not start after the abort

- **WHEN** the turn's signal has aborted before the script of the next code state in a chain starts
- **THEN** that script does not run

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

### Requirement: Pluggable sandbox runtime

Script execution SHALL target the `SandboxRuntime` interface — namespaced sessions with an
`eval(code, timeoutMs, signal)` operation, per-session options (tools, quotas, console capture,
session id) and disposal — with the bundled QuickJS implementation as the default and
a consumer-supplied `sandboxRuntime` accepted by `createAgent`. A custom runtime SHALL serve the
sandbox tools and code states' scripts alike; cases are interpreted host-side and never reach it.
The interface's contract SHALL include the turn's signal and disposal under a pending call, as the
requirements "A cancelled turn stops its scripts" and "Disposal is safe while a host call is
pending" state them.

#### Scenario: Default runtime

- **WHEN** no `sandboxRuntime` is supplied
- **THEN** scripts run in the bundled QuickJS sandbox

#### Scenario: Custom runtime serves every script context

- **WHEN** a caller supplies a custom `sandboxRuntime`
- **THEN** `archmax_eval`, `archmax_run` and code states' scripts all execute through it, with
  per-scope namespacing preserved, the `code` namespace included

### Requirement: Code-state scripts default-export a function called with the state's input

When a session enters a code state, the runtime SHALL read the state's `script`
(`workflows/<slug>/scripts/<file>.js` or `.mjs`) through the authoring backend and evaluate it in
the `code` context. Its default export, optionally wrapped in `defineCodeState`, SHALL be called
with `{ state, trigger, variables, tools }`, `trigger` absent when the turn has none; a bare-body
script SHALL simply run, reading the same input, without `tools`, from the global `args`, and its
tools from the global `tools`. The input SHALL carry no transcript, trail or tool result: the script
reads the session through `tools.archmax_get_history()`, whose answer the `automated-states`
capability defines. The return value SHALL NOT be read, and console lines SHALL become
`code-output` events.

#### Scenario: The default export receives the state's input

- **WHEN** code state `check-refund` runs a script whose
  `export default async function ({ state, trigger, variables, tools })` reads its input
- **THEN** `state` is `check-refund`, `trigger` is the id of the trigger the turn carries,
  `variables` is the session's flat variable map, and `tools` is the code state's scoped view

#### Scenario: The script reads the history through its tools

- **WHEN** a code state's script calls
  `const { messages, trail } = JSON.parse(await tools.archmax_get_history())`
- **THEN** it receives the session's whole transcript and trail, and its input holds neither

#### Scenario: The export default rewrite keeps the function

- **WHEN** a code state's script declares `export default defineCodeState(async (input) => { … })`
- **THEN** the executor rewrites `export default` so the function survives evaluation, and calls it
  once with the state's input after the script body has run

#### Scenario: A bare-body script reads the global args

- **WHEN** a code state's script has no default export and reads `args.state` and
  `args.variables.case_id`
- **THEN** `args` carries the same input the default export would receive, without `tools`, and
  the script runs to its end with no function to call

#### Scenario: The return value is not read

- **WHEN** a code state's default export returns `false`, `{ verdict: "veto" }` or any other value
- **THEN** nothing reads it: the session moves only through the script's `tools.archmax_advance`
  or `tools.archmax_raise` call, and what follows a script that settles without either call is the
  `automated-states` capability's

#### Scenario: Console output becomes events

- **WHEN** the script of code state `check-refund` calls `console.log("3 orders checked")`
- **THEN** a `code-output` event `{ state: "check-refund", line: "3 orders checked" }` is emitted,
  between the `code-start` and `code-result` events that bracket the execution

#### Scenario: The source comes from the authoring backend

- **WHEN** a code state declares `script: scripts/check-refund.js`
- **THEN** the executor reads `workflows/<slug>/scripts/check-refund.js` through the authoring
  backend, never the local filesystem, and a source it cannot read fails the state's execution
  with an error naming the path

### Requirement: A code state's script runs in a fresh REPL for each entry

Each time a session enters a code state, its script SHALL evaluate in a fresh REPL of the
namespace `code` in the session's scope, shared with neither the agent's `archmax_eval` and
`archmax_run` REPL nor another code state's. The REPL SHALL be released when the execution
settles, under the rules of "Disposal is safe while a host call is pending". The script is one
evaluation, so each quota in `settings` bounds it whole.

#### Scenario: Nothing leaks between code states

- **WHEN** the script of code state `first` sets `globalThis.seen = true` and advances to code state
  `second`, whose script reads `globalThis.seen`
- **THEN** it is `undefined`, and it is `undefined` again when the session later re-enters `first`

#### Scenario: The agent's REPL is not shared

- **WHEN** an `archmax_eval` defines a helper and the session then advances into a code state whose
  script references it
- **THEN** the helper is undefined in the code state's script, and still defined at the agent's next
  `archmax_eval` in the session

#### Scenario: The REPL is released when the execution settles

- **WHEN** a code state's script returns while a `tools.*` call it started without awaiting is still
  pending
- **THEN** the REPL is released at once, the pending call is abandoned, and the REPL is freed only
  once that call has settled

### Requirement: A code state's script sees only its state's tools

A code state's script SHALL see under `tools` exactly its state's surface: its own grants, the file
tools, `archmax_advance` (outside a terminal state), `archmax_raise`, `archmax_get_variables`,
`archmax_set_variables` and `archmax_get_history`. Each call SHALL be governed with origin `script`
against that code state, under either spelling (`tools.read_file`, `tools.readFile`); a name
outside the surface SHALL be `undefined`. What the control tools do is the `automated-states`
capability's.

#### Scenario: The listing names the surface only

- **WHEN** code state `check-refund` allows `lookup_order`, state `refund-request` allows
  `issue_refund`, and the script of `check-refund` lists `Object.keys(tools)`
- **THEN** it sees `lookupOrder`, the file tools, `archmaxAdvance`, `archmaxRaise`,
  `archmaxGetVariables`, `archmaxSetVariables` and `archmaxGetHistory`, and none of `issueRefund`,
  `writeTodos`, `archmaxEval`, `archmaxRun`, `archmaxWait` or `archmaxReset`

#### Scenario: A tool outside the surface is undefined

- **WHEN** that script reads `tools.issueRefund` or `tools.issue_refund`
- **THEN** both are `undefined`, `"issueRefund" in tools` is false, and nothing reaches the gateway

#### Scenario: Both spellings resolve

- **WHEN** the script calls `tools.archmax_set_variables({ variables: { case_id: "c-1" } })`, and
  later the same through `tools.archmaxSetVariables`
- **THEN** both reach the same tool under the same governance, and the listing names only the
  camelCase key

#### Scenario: Calls are governed against the code state

- **WHEN** the script calls `tools.writeFile` on a path the code state does not grant
- **THEN** the kernel refuses it with origin `script` before the tool runs, `tool-blocked` is
  emitted as for any programmatic call, and the call's promise rejects with the rule id and reason,
  which the script can catch before it carries on

#### Scenario: No runtime authority

- **WHEN** a code state that enables no skill calls `tools.readFile` on a skill asset, and separately
  on a governed mount that only another state of its workflow enables
- **THEN** the first read is refused with `skill.not-allowed` and the second with
  `mount.not-allowed`, because the code state's own grants bind its script

#### Scenario: A terminal code state is offered no advance

- **WHEN** the script of a terminal code state reads `tools.archmax_advance`
- **THEN** it is `undefined`, while `tools.archmax_raise` is a function

#### Scenario: A refused control call can be caught

- **WHEN** the script calls `tools.archmax_advance({ to, reason })` and the call is refused
- **THEN** the promise rejects with the refusal's reason, and the script can catch it and decide
  otherwise; how an accepted call is recorded and applied is the `automated-states` capability's

#### Scenario: Mocks answer a code state's calls

- **WHEN** a case mocks `lookup_order` and a code state's script calls `tools.lookupOrder`
- **THEN** governance decides the call first, the mock answers once it is permitted, and the paired
  tool events carry `origin: "script"`

### Requirement: Programmatic tool calls are governed against the script's state

Scripts SHALL reach tools through the `tools.*` bridge, every result marshalled to text. Every call
SHALL pass the kernel at call time with origin `script`, against the active state for an
`archmax_eval` or `archmax_run` script and the code state for a code state's script; no call runs
on runtime authority. It SHALL emit the same tool events as the agent's own, with
`origin: "script"`; a blocked call SHALL not run the tool and SHALL reject in the script with the
rule id and reason.

#### Scenario: Script call governed by the active state

- **WHEN** code run via `archmax_eval` calls `tools.writeFile` on a path the state does not allow
- **THEN** the kernel blocks it before the tool runs, exactly as it would block the agent's own
  `write_file` call in that state, and the script can catch the rejection

#### Scenario: A script is held to its state's grants

- **WHEN** an `archmax_eval` in a state that enables no skill calls `tools.readFile` on a skill
  asset, and separately on a governed mount that only another state of the same workflow enables
- **THEN** the first read is refused with `skill.not-allowed` and the second with
  `mount.not-allowed`, as the agent's own `read_file` would be, because the state's `tools.allow`
  and `tools.forbid`, its skill and mount grants, the safety rules, the workflow-wide denials,
  consumer rules and the reply-only rule bind every script call

#### Scenario: Governance tracks the active state

- **WHEN** a REPL session persists across calls made from different workflow states
- **THEN** each PTC call is checked against the state active when it is made

#### Scenario: Reply-only turn refuses every tool

- **WHEN** a script issues a PTC call during a reply-only turn
- **THEN** the kernel blocks it with rule `tool.reply-only`

#### Scenario: Script arguments reach the kernel verbatim

- **WHEN** a script passes the string `"${{case_id}}"` as a tool argument, and the call's grant
  carries a `${{case_id}}` guard
- **THEN** no `${{…}}` substitution is applied to the argument, which reaches the kernel and the
  tool verbatim, while the guard resolves against the session's variables

#### Scenario: The turn's config reaches the tool

- **WHEN** a script calls a tool through `tools.*`
- **THEN** the bridge forwards the turn's `RunnableConfig` (session id, abort signal, tool mocks) to
  the underlying tool

#### Scenario: A delegation call whose child parks fails closed

- **WHEN** a script calls `archmax_workflow_<slug>` through `tools.*` and the child session parks
- **THEN** the call fails closed with kind `parked`

### Requirement: An agent script's tools are the active state's surface

For an `archmax_eval` or `archmax_run` script, `tools` SHALL hold the active state's surface minus
the control tools, both sandbox tools and bare `eval`, re-scoped at the start of every evaluation.
A lookup, `in`, `Object.keys` and `for…in` SHALL see only those names; any other name SHALL be
`undefined`. A tool's own name SHALL resolve as its camelCase key, the listing naming camelCase
keys only. The kernel SHALL still decide every call made through the view.

#### Scenario: A script calls a tool by its own name

- **WHEN** an `archmax_eval` in a state that allows `read_file` calls
  `await tools.read_file({ file_path: "notes.md" })`
- **THEN** the call reaches `read_file` exactly as `tools.readFile` would, governed and evented
  the same way, and `Object.keys(tools)` still lists `readFile`

#### Scenario: A delegation tool keeps its own name too

- **WHEN** a state grants `archmax_workflow_enrich-order` and a script looks up
  `tools["archmax_workflow_enrich-order"]` and `tools.archmaxWorkflowEnrichOrder`
- **THEN** both are the same function, and `in` answers the same for either spelling

#### Scenario: A script lists the state's tools

- **WHEN** state `work` allows `alpha`, state `done` allows `beta`, and both tools are registered
- **THEN** `Object.keys(tools)` in an `archmax_eval` made in `work` includes `alpha` and not
  `beta`, and the first evaluation after the session advances to `done` includes `beta` and not
  `alpha`

#### Scenario: A kept reference follows the state

- **WHEN** an evaluation in `work` stores `const t = tools`, and an evaluation in `done` reads
  `Object.keys(t)`
- **THEN** it sees `done`'s tools, and `t === tools` holds, because `tools` is one object for the
  life of the REPL session

#### Scenario: An overwritten view comes back

- **WHEN** an evaluation assigns `tools = {}`
- **THEN** the next evaluation in the REPL session sees the state's view under `tools` again

#### Scenario: A tool outside the surface is undefined

- **WHEN** an `archmax_eval` in `work` reads `tools.beta`, which `work` does not offer, and then
  calls `tools.beta({})`
- **THEN** the lookup is `undefined`, as `Object.keys` and `in` say, the call throws a `TypeError`
  the script can catch, no tool event is emitted and `beta` never runs

#### Scenario: A script cannot end the session

- **WHEN** code run via `archmax_eval` or `archmax_run` looks up `tools.archmaxRaise`,
  `tools.archmax_advance`, `tools.archmaxSetVariables`, `tools.archmaxGetHistory`,
  `tools.archmaxEval` or `tools.eval`
- **THEN** each is `undefined`, and the session's status and position are unchanged

#### Scenario: The kernel still decides a call in the view

- **WHEN** an `archmax_eval` in `work` calls `tools.alpha` with arguments a consumer rule blocks
- **THEN** the call reaches the kernel, which refuses it with the rule's reason and emits
  `tool-blocked`, and the script can catch the rejection

### Requirement: A tool called with no argument is called with `{}`

A tool a script calls through `tools.*` with no argument SHALL be called with the empty input
`{}`, under either spelling, in an `archmax_eval` or `archmax_run` script and in a code state's
script alike. A call with an argument SHALL pass it unchanged.

#### Scenario: The history with no argument

- **WHEN** a code state's script calls `tools.archmax_get_history()` with no argument
- **THEN** the call is made with `{}` and returns the session's history

#### Scenario: An agent script's call with no argument

- **WHEN** an `archmax_eval` in a state that offers `ls` calls `await tools.ls()`
- **THEN** `ls` runs with `{}`, governed and evented as `tools.ls({})` would be

### Requirement: No sandbox context provides `task()`

The `task()` global SHALL NOT be provided in any sandbox context — `archmax_eval`, `archmax_run`
or a code state's script — and the Deep Agents `task` tool SHALL be on no state's surface, so
`tools.task` is undefined too. No author-facing name SHALL keep the global alive, and
`ScriptRunParams` SHALL carry no dispatch option. A step that needs a model's judgement SHALL be a
grader state, which the runtime runs outside the sandbox.

#### Scenario: No script has task

- **WHEN** a code state's script, an `archmax_eval` snippet, or an `archmax_run` script references
  `task` or `tools.task`
- **THEN** it is undefined in every case

#### Scenario: A code state's script that reaches for it fails closed

- **WHEN** a code state's script calls `task(...)`
- **THEN** it throws, and the state's execution fails like any script error

#### Scenario: A model's judgement is a grader state

- **WHEN** a workflow needs a model to judge the agent's work before the session moves on
- **THEN** it declares a grader state on the graph, which the `automated-states` capability runs,
  and the runtime dispatches no subagent through the `task` tool for a state
