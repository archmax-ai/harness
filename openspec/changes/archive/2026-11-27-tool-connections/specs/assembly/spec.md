## MODIFIED Requirements

### Requirement: Extension options

`essentialTools` SHALL name host tools treated as always-on (disclosed and permitted in every state, still narrowed by a per-state entry and bound by safety and policy rules), and SHALL apply to every child machine the assembly composes. `toolPaths` SHALL declare host tools' path arguments by tool name (see the governance requirement "Tools declare their path arguments"), and SHALL apply to every child machine the assembly composes. `toolConnections` SHALL declare, by tool name, the argument through which a host tool takes its connection (see the governance requirement "Tools declare the argument that carries their connection"), and SHALL apply to every child machine the assembly composes. `policyRules` SHALL insert custom kernel rules after the safety and `policy` rules and before per-state grants. `sandboxRuntime` SHALL replace the default QuickJS runtime for the sandbox tools and code-state scripts. There SHALL be no option registering a custom hook kind: `hookExecutors` and the `HookExecutor` type are removed. Omitting every extension option SHALL yield the default behaviour.

#### Scenario: There are no hook executors to register

- **WHEN** a consumer passes `hookExecutors` to `createAgent`, keyed `script`, `rubric` or anything else
- **THEN** it is a type error, and assembly reads nothing from it: no hook kind remains to
  register or override

#### Scenario: One sandbox runtime for agent scripts and code states

- **WHEN** a host supplies `sandboxRuntime`
- **THEN** `archmax_eval`, `archmax_run` and every code state's script run in it

#### Scenario: A child machine governs by the same connection declarations

- **WHEN** a host declares `toolConnections: { rest__request: "connection" }` and a workflow
  delegates to one whose state allows `rest__request` through `nominatim` only
- **THEN** a call in the child session naming `zaepflefinder` is blocked with `tool.not-allowed`
