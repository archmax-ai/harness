# sandbox Specification

## Purpose

Define the one QuickJS sandbox the archmax harness runs authored JavaScript in: the two sandbox tools the
agent calls (`archmax_eval` for inline code, `archmax_run` for a script file from a skill bundle)
and the lifecycle hook scripts the runtime runs on its own authority. It fixes the two execution
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

The runtime SHALL define exactly two sandbox contexts, `lifecycle-hook` and `ptc`, each with its
own prelude assembled from versioned parts and selected by the executor from how the script is
run. The `ptc` prelude (for `archmax_eval` and `archmax_run`) SHALL install only the
`SANDBOX_CONTRACT` marker; `tools` and `args` are injected by the executor. The `lifecycle-hook`
prelude SHALL install the verdict helpers `ok`, `veto`, `correct`, the `defineHook` identity
wrapper, the verdict reducer and the `SANDBOX_CONTRACT` marker. Neither context SHALL carry
driver or grader members, and there SHALL be no context for cases.

There SHALL be no third prelude. A compatibility prelude for a superseded hook vocabulary is not
one of the contexts, so no source selects one and no assembly installs one.

#### Scenario: Prelude selected by context

- **WHEN** the executor runs a script as a lifecycle hook
- **THEN** the `lifecycle-hook` prelude is installed, and running source via `archmax_run` or
  `archmax_eval` installs the `ptc` prelude instead

#### Scenario: Contract marker is introspectable

- **WHEN** a script reads `SANDBOX_CONTRACT`
- **THEN** it sees `{ context, version }` naming its context and the sandbox contract version

#### Scenario: Only two preludes exist

- **WHEN** the assembled preludes are enumerated
- **THEN** there are exactly two, and neither is a compatibility shim for a superseded vocabulary

### Requirement: Hook scripts default-export a function returning a verdict

A hook script SHALL default-export a function (optionally wrapped in `defineHook`) that receives
one input object — `{ state, phase, trigger, variables, messages, tools }` plus `from`, `to` and
`reason` on an `after` hook run for an `archmax_advance` — and returns `ok()`, `veto(reason)`,
`correct(reason)` or nothing (an `ok`). The executor SHALL rewrite
`export default` so the function survives evaluation, call it with the hook input and reduce its
return to a verdict; a script that throws SHALL yield a veto.

A return value outside that vocabulary SHALL reduce to no verdict, which the runtime treats as a
fail-closed veto. A bare `false`, an `{ ok: false }` object, and the superseded
`t.check`/`t.require`/`t.log` assertion vocabulary SHALL have no meaning in the sandbox: no
compatibility prelude SHALL be installed for them and no deprecation SHALL be reported, because
there is nothing left to deprecate.

#### Scenario: Hook returns a verdict

- **WHEN** an `after` hook's function returns `veto("no orders")`
- **THEN** the lifecycle runner receives a `veto` verdict with that reason

#### Scenario: Throwing is a veto

- **WHEN** a hook function throws
- **THEN** the hook outcome is a veto carrying the error, never an `ok`

#### Scenario: A superseded return shape is not a verdict

- **WHEN** a hook returns `false` or `{ ok: false, reason }`
- **THEN** the reduction yields no verdict and the phase vetoes fail-closed, rather than reading the
  value as a veto

#### Scenario: The superseded assertion vocabulary is an ordinary error

- **WHEN** a hook source calls `t.check(value, matcher)`
- **THEN** `t` is undefined, the script throws, the phase vetoes with that error, and no
  compatibility prelude or deprecation warning is involved

### Requirement: Typed imports are stripped, foreign imports are errors

The executor SHALL accept hook sources that begin with static imports from `@archmax-ai/harness/*`
specifiers (type carriers such as `import { ok, veto } from "@archmax-ai/harness/sandbox"`), SHALL strip
them before evaluation while preserving line count, and SHALL reject any other import specifier
with `ForbiddenSandboxImportError` naming the specifier — at execution and in `archmax validate`.
The package SHALL ship `@archmax-ai/harness/sandbox` as an entry point whose runtime members are the
verdict helpers and `defineHook` and whose types describe the hook input and verdict.

#### Scenario: @archmax-ai/harness import stripped

- **WHEN** a hook begins with `import { veto } from "@archmax-ai/harness/sandbox";`
- **THEN** it executes as if the line were absent, with `veto` provided by the prelude, and stack
  traces still point at the right source lines

#### Scenario: Foreign import rejected

- **WHEN** a hook imports `node:fs`
- **THEN** the script is rejected with an error naming `node:fs`, and validation reports the same

### Requirement: Script arguments, variables and return value

`archmax_run` SHALL pass the call's arguments to the script as the global `args`, with the
session's variables as the flat read-only map `args.variables` (`name → value`, including the
built-in `trigger`, structured values whole). Hooks SHALL receive the same map as
`input.variables`. Mutating the map SHALL not affect the checkpointed variables. Both sandbox
tools SHALL return the last expression value, formatted, to the model, with errors reported as a
tool error message rather than thrown out of the graph.

#### Scenario: Script reads a variable

- **WHEN** an upstream state set `case_id` and an `archmax_run` script reads `args.variables.case_id`
- **THEN** it is that value directly

#### Scenario: Snapshot mutation is inert

- **WHEN** a script assigns to `args.variables.case_id`
- **THEN** the session's checkpointed variables are unchanged after the script returns

### Requirement: Programmatic tool calls are governed per call

Scripts SHALL reach the agent's tools through the `tools.*` bridge, keyed by camelCase name
(`tools.readFile`, `tools.archmaxWorkflowEnrichOrder`), with every result marshalled to text.
The control tools and both sandbox tools (`archmax_advance`, `archmax_reset`, `archmax_wait`,
`archmax_eval`, `archmax_run`, `archmax_get_variables`, `archmax_set_variables`) and bare `eval`
SHALL be absent from the bridge. Every PTC call SHALL pass through the kernel at call time
against the workflow state active at that moment — an `archmax_run` or `archmax_eval` script on
the model's authority (the state's `tools.allow` and `tools.forbid` bind it), a hook on runtime
authority (the state's own governance does not bind it in either direction; the safety rules, the
workflow's `tools.forbid_always` and `skills.forbid_always`, consumer rules and the
reply-only rule do) — and SHALL emit the same tool events as an agent-initiated call. A script
call's `${{name}}` guards SHALL resolve against the run's variables; no `${{…}}` substitution is
applied to a script's arguments, which reach the kernel and the tool verbatim. A blocked call SHALL not execute the
tool and SHALL reject inside the script with the rule id and reason. The bridge SHALL forward
the turn's `RunnableConfig` (session id, abort signal, tool mocks) to the underlying tool, and a
delegation tool called from a script SHALL fail closed with kind `parked` if the child parks.

#### Scenario: Script call governed by the active state

- **WHEN** code run via `archmax_eval` calls `tools.writeFile` on a path the state does not allow
- **THEN** the kernel blocks it before the tool runs, exactly as it would block the agent's own
  `write_file` call in that state, and the script can catch the rejection

#### Scenario: Hook reads on runtime authority

- **WHEN** a `before` hook in a state that enables no skill calls `tools.readFile` on a skill asset
- **THEN** the read is permitted, while a write into the read-only authored zone is still refused

#### Scenario: Governance tracks the active state

- **WHEN** a REPL session persists across calls made from different workflow states
- **THEN** each PTC call is checked against the state active when it is made

#### Scenario: Reply-only turn refuses every tool

- **WHEN** a script issues a PTC call during a reply-only turn
- **THEN** the kernel blocks it with rule `tool.reply-only`

### Requirement: `archmax_run` executes skill-bundle sources only

`archmax_run` SHALL execute only sources that resolve inside a skill of the assembly's resolved
skill registry, read through the backend; any other path SHALL be blocked by the non-overridable
`script.skill-only` rule ahead of the declared denials, consumer and per-state rules, and a script in a skill
the state does not enable SHALL be refused by `skill.not-allowed`. Both sandbox tools are
always-on; a state's own `tools.allow` entry on `archmax_run` SHALL narrow which files it may
execute there, and an entry naming paths outside `skills/` SHALL be inert and reported by
validation.

#### Scenario: Non-skill source blocked

- **WHEN** the agent calls `archmax_run` on `scratchpad/x.js` or a `workflows/**` path
- **THEN** the call is blocked with rule `script.skill-only`, whatever the state declares

#### Scenario: Restricted script path

- **WHEN** a state allows `{ tool: archmax_run, paths: ["skills/order-data/scripts/lookup.js"] }`
- **THEN** only that script may run in that state and other skill scripts are blocked

### Requirement: No sandbox context has `task()`

The `task()` global SHALL NOT be provided in any sandbox context — not to `archmax_eval`, not to
`archmax_run`, and not to a lifecycle hook script. A grading rubric is declared inline on the hook
that applies it and therefore has no name a script could pass, and no author-facing name SHALL be
invented to keep the global alive. `ScriptRunParams` SHALL carry no dispatch option.

A hook script needing a model verdict SHALL get a `rubric` hook declared beside it in the same
phase's list, which keeps every model dispatch visible in the spec.

The runtime's own dispatch is unaffected and does not pass through the sandbox: a `{ rubric: … }`
hook is dispatched through the framework `task` tool, bracketed with `rubric-start`/`rubric-result`
events, and run on the model the declaration's `model` selects, else the assembly's `rubric`-role
model.

#### Scenario: No script has task

- **WHEN** a lifecycle hook script, an `archmax_eval` snippet, or an `archmax_run` script references
  `task`
- **THEN** it is undefined in every case

#### Scenario: A hook script that reaches for it fails closed

- **WHEN** a lifecycle hook script calls `task(...)`
- **THEN** it throws, and the phase vetoes fail-closed with that error

### Requirement: Quotas and settings

Every sandbox session SHALL run under the workflow's `settings`: `timeoutMs` (per evaluation,
default 5,000 ms), `memoryLimitBytes`, `maxPtcCalls` (null for unbounded) and `maxResultChars`,
expressed against the runtime interface so any implementation receives them. Exceeding a quota
SHALL surface as a script error, and in a hook a script error is a veto.

#### Scenario: Evaluation times out

- **WHEN** a script runs longer than `settings.timeoutMs`
- **THEN** the evaluation fails with a timeout error the caller reports as a tool error (or a
  veto, for a hook)

### Requirement: Pluggable sandbox runtime

Script execution SHALL target the `SandboxRuntime` interface — namespaced sessions with an
`eval(code, timeoutMs)` operation, per-session options (tools, quotas, console capture, session
id) and disposal — with the bundled QuickJS implementation as the default and
a consumer-supplied `sandboxRuntime` accepted by `createAgent`. A custom runtime SHALL serve the
sandbox tools and lifecycle hooks alike; cases are interpreted host-side and never reach it.

#### Scenario: Default runtime

- **WHEN** no `sandboxRuntime` is supplied
- **THEN** scripts run in the bundled QuickJS sandbox

#### Scenario: Custom runtime serves every script context

- **WHEN** a caller supplies a custom `sandboxRuntime`
- **THEN** `archmax_eval`, `archmax_run` and hook scripts all execute through it, with per-scope
  namespacing preserved
