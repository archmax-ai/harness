## MODIFIED Requirements

### Requirement: Hook scripts default-export a function returning a verdict

A hook script SHALL default-export a function (optionally wrapped in `defineHook`) that receives
one input object — `{ state, phase, trigger, variables, messages, toolCalls, tools }` plus `from`,
`to` and `reason` on an `after` hook run for an `archmax_advance` — and returns `ok()`,
`veto(reason)`, `correct(reason)` or nothing (an `ok`). `toolCalls` SHALL be an async function
whose filtering runs outside the sandbox: a call copies into the sandbox only the records it
returns, and the hook input itself carries no tool results. The executor SHALL rewrite
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

#### Scenario: Only the queried tool results enter the sandbox

- **WHEN** a session has made a hundred `search` calls and one `lookup` call, and a hook calls
  `await toolCalls({ name: "lookup" })`
- **THEN** the hook receives the one `lookup` record, and no `search` result is part of the hook's
  input or of what the call returned

#### Scenario: The query is not a tool

- **WHEN** a hook lists `Object.keys(tools)`, or the agent's `archmax_eval` script reads `toolCalls`
- **THEN** the listing does not include the query, and the agent's script finds no `toolCalls`
