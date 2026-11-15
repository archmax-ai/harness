## MODIFIED Requirements

### Requirement: A code state's script sees only its state's tools

A code state's script SHALL see under `tools` exactly its state's surface: its own grants, the file
tools, `archmax_advance` (outside a terminal state), `archmax_raise`, `archmax_get_variables`,
`archmax_set_variables`, `archmax_get_history` and `archmax_add_message`. Each call SHALL be
governed with origin `script` against that code state, under either spelling (`tools.read_file`,
`tools.readFile`); a name outside the surface SHALL be `undefined`. What the control tools do is the `automated-states`
capability's.

#### Scenario: The listing names the surface only

- **WHEN** code state `check-refund` allows `lookup_order`, state `refund-request` allows
  `issue_refund`, and the script of `check-refund` lists `Object.keys(tools)`
- **THEN** it sees `lookupOrder`, the file tools, `archmaxAdvance`, `archmaxRaise`,
  `archmaxGetVariables`, `archmaxSetVariables`, `archmaxGetHistory` and `archmaxAddMessage`, and
  none of `issueRefund`, `writeTodos`, `archmaxEval`, `archmaxRun`, `archmaxWait` or `archmaxReset`

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
