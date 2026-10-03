## MODIFIED Requirements

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
