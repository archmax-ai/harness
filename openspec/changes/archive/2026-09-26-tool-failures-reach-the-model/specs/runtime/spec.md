## ADDED Requirements

### Requirement: A failed tool call is answered, not thrown

A governed call whose tool throws SHALL be answered with an error-status tool message, never thrown
out of the turn. The message SHALL carry the error's message, answer the call's id and name the
tool, exactly as a blocked call is answered. The session SHALL stay in the active state, and the
next model call SHALL see the failure in its transcript. The call SHALL settle with exactly one
`tool-result` whose `status` is `error` and whose preview is that message. A tool failure SHALL NOT
be a state failure: it does not route through `on_error` and does not end the turn. Answers already
given to other calls of the same model step SHALL be kept.

Two things SHALL still propagate unchanged, with no answer recorded for the call:

- a LangGraph bubble-up signal, which covers an interrupt that parks the session (including a
  delegated child's park) and a parent command;
- any failure raised once the run's abort signal has fired.

This requirement covers calls that reach the tool node. It does not cover these calls:

- The control and delegation tools the runtime services itself keep their own answers.
- A `script`-origin call still throws to the script, which may catch it.
- A `lifecycle`-origin call's failure still fails the hook closed.

#### Scenario: A throwing tool is answered and the turn continues

- **WHEN** a state allows `web_search`, and the model calls it, and the tool throws
  `Error("Connection closed")`
- **THEN** the call is answered with an error-status tool message whose content is
  `Connection closed`
- **AND** exactly one `tool-result` for the call's id is emitted, with `status: "error"`
- **AND** the session stays in the same state, and the next model call receives that message as
  the call's answer

#### Scenario: Sibling calls survive one failure

- **WHEN** one model step issues four tool calls, and one throws while three return
- **THEN** the turn does not fail
- **AND** the next model call sees three results and one error-status answer, each correlated to
  its own call id

#### Scenario: A tool failure does not route through on_error

- **WHEN** a state declares `on_error: escalate`, and a tool it calls throws
- **THEN** no `state-error-routed` event is emitted, and the session stays in the state it was in

#### Scenario: A park still propagates

- **WHEN** a tool call raises a LangGraph interrupt, for example a delegated child that parks at a
  human state
- **THEN** the interrupt propagates and the session parks as it did before this requirement
- **AND** the call is not answered with an error-status message

#### Scenario: A cancelled run is not answered

- **WHEN** the run's abort signal fires while a tool call is in flight, and the tool rejects
- **THEN** the rejection propagates and the turn ends. No error-status answer is recorded for the
  call.

#### Scenario: A script still receives the throw

- **WHEN** code run by `archmax_eval` calls `tools.webSearch`, and that tool throws
- **THEN** the script receives the thrown error and may catch it. The `archmax_eval` call itself
  is answered with whatever the script produced.
