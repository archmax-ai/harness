## MODIFIED Requirements

### Requirement: Two execution contexts with distinct globals

The runtime SHALL define exactly two sandbox contexts, `lifecycle-hook` and `ptc`, each with its
own prelude assembled from versioned parts and selected by the executor from how the script is
run. The `ptc` prelude (for `archmax_eval` and `archmax_run`) SHALL install the
`SANDBOX_CONTRACT` marker and the state-scoped view of `tools` (see "Programmatic tool calls are
governed per call"), and nothing else; `tools` and `args` are injected by the executor. The
`lifecycle-hook` prelude SHALL install the verdict helpers `ok`, `veto`, `correct`, the
`defineHook` identity wrapper, the verdict reducer and the `SANDBOX_CONTRACT` marker. Neither
context SHALL carry driver or grader members, and there SHALL be no context for cases.

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

### Requirement: Programmatic tool calls are governed per call

Scripts SHALL reach the agent's tools through the `tools.*` bridge, keyed by camelCase name
(`tools.readFile`, `tools.archmaxWorkflowEnrichOrder`), with every result marshalled to text.
The control tools and both sandbox tools (`archmax_advance`, `archmax_reset`, `archmax_wait`,
`archmax_raise`, `archmax_eval`, `archmax_run`, `archmax_get_variables`, `archmax_set_variables`)
and bare `eval` SHALL be absent from the bridge. Every PTC call SHALL pass through the kernel at
call time against the workflow state active at that moment — an `archmax_run` or `archmax_eval`
script on the model's authority (the state's `tools.allow` and `tools.forbid` bind it), a hook on
runtime authority (the state's own governance does not bind it in either direction; the safety
rules, the workflow's `tools.forbid_always` and `skills.forbid_always`, consumer rules and the
reply-only rule do) — and SHALL emit the same tool events as an agent-initiated call. A script
call's `${{name}}` guards SHALL resolve against the run's variables; no `${{…}}` substitution is
applied to a script's arguments, which reach the kernel and the tool verbatim. A blocked call SHALL not execute the
tool and SHALL reject inside the script with the rule id and reason. The bridge SHALL forward
the turn's `RunnableConfig` (session id, abort signal, tool mocks) to the underlying tool, and a
delegation tool called from a script SHALL fail closed with kind `parked` if the child parks.

For an `archmax_eval` or `archmax_run` script, `tools` SHALL enumerate only the active state's
surface: the tools the model's own tool list carries in the state the script's calls are
governed against, minus the names absent from the bridge. `Object.keys`, `in` and `for…in`
SHALL see only those names. The view SHALL be re-scoped at the start of every evaluation, so the
first evaluation after a transition sees the new state's tools. `tools` SHALL be one object for
the life of the REPL session: a reference an earlier evaluation kept SHALL read the current
surface, and a script that overwrites `tools` SHALL get the view back at its next evaluation. A
name outside the view that names a tool on the bridge SHALL still resolve, so calling it reaches
the kernel, which refuses it with its rule and reason and emits `tool-blocked`. A lifecycle
hook's `tools` SHALL keep every tool on the bridge.

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

#### Scenario: A script cannot end the session

- **WHEN** code run via `archmax_eval` or a hook script looks up `tools.archmaxRaise`
- **THEN** no such function exists on the bridge, and the session's status is unchanged

#### Scenario: A script lists the state's tools

- **WHEN** state `work` allows `alpha`, state `done` allows `beta`, and both tools are registered
- **THEN** `Object.keys(tools)` in an `archmax_eval` made in `work` includes `alpha` and not
  `beta`, and the first evaluation after the session advances to `done` includes `beta` and not
  `alpha`

#### Scenario: A kept reference follows the state

- **WHEN** an evaluation in `work` stores `const t = tools`, and an evaluation in `done` reads
  `Object.keys(t)`
- **THEN** it sees `done`'s tools, and `t === tools` holds

#### Scenario: A hidden tool is refused with its reason

- **WHEN** an `archmax_eval` in `work` calls `tools.beta({})`, which `work` does not offer
- **THEN** the call reaches the kernel, which refuses it with its not-allowed reason, emits
  `tool-blocked`, and lets the script catch the rejection

#### Scenario: A hook keeps every tool

- **WHEN** a `before` hook of `work` lists `Object.keys(tools)`
- **THEN** it sees both `alpha` and `beta`
