## Why

A code state can read the session's history and move the session, but it cannot say anything in
it. A workflow whose answer is deterministic — an order status read from a record, a refusal
whose reason the script already knows, a confirmation after a lookup — still has to advance into an
agent state and spend a model call only to put the script's result into words. Nothing a script
computes reaches the person except through the agent, and a code state that ends the session (a
terminal state, or `archmax_raise`) leaves the turn with nothing said at all.

## What Changes

- A code state's script can add a message to the session with a new control,
  `tools.archmax_add_message({ text })`. Each call records one message; when the state's run
  settles, every message it recorded joins the session's transcript as an assistant message, in the
  order written, ahead of the runtime note of the state's move or raise. The session says it:
  it is part of the turn's `reply`, it is reported as an `agent-text` event whose `messageId` is the
  transcript message's id, the session's agent reads it on its next model call, and the history a
  later grader or code state reads holds it as an `assistant` message.
- A message stands with the run's outcome: an advance, a raise or a completion commits it, and a
  run that fails (a throw, a timeout, a non-terminal state left undecided) discards it with its
  move, so a retry through `on_error` never repeats what a failed attempt half-said. A blank `text`
  is refused, and the script may catch the rejection.
- `archmax_add_message` is a control of the code state only. A grader state is not offered it: a
  grader judges, and nothing it says enters the transcript. It joins the grader's withheld tools,
  so a grader state whose `tools.allow` names it is a `validate` error. The automated-state control
  set therefore splits in `STATE_TYPE_TOOLS`: `code.controls` is the grader's set plus
  `archmax_add_message`, and the two types no longer share one entry.
- Additive: no existing option, event or message changes shape. Released as a minor version.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `automated-states`: the code state's control set gains `archmax_add_message` and the grader's
  withheld tools gain it; a new requirement says how a code state's messages are recorded,
  committed, discarded, reported and read; observability gains the `agent-text` events.
- `governance`: the `STATE_TYPE_TOOLS` table splits its automated row into a code row and a
  grader row, and per-state disclosure lists the new control in a code state only.
- `sandbox`: a code state's script sees `archmax_add_message` under `tools`.
- `documentation`: the authoring skill teaches the message control with the code-state script
  contract.

## Impact

- **Code:** `src/machine/tool-names.ts` (the new name and the split control and withheld sets);
  `src/workflow/automated-controls.ts` (the control, bound to the step recorder, which now records
  messages); `src/workflow/automated.ts` (the outcome carries the run's messages, emitted as
  `agent-text` when the run settles); `src/workflow/middleware.ts` (the commit appends them as
  assistant messages ahead of the runtime note); `src/machine/lint-spec.ts` (the withheld-tool
  error names why a grader is never offered it); `src/public/sandbox.ts` (the typed surface's docs).
- **Public API:** no new export. `STATE_TYPE_TOOLS.code.controls` and
  `STATE_TYPE_TOOLS.grader.withheld` gain the name, and `STATE_TYPE_TOOLS.grader` no longer equals
  `STATE_TYPE_TOOLS.code`; `HARNESS_CONTROL_TOOLS` gains it.
- **Docs (`docs/`):** `guides/automated-states.md` (a code state's messages, with an example
  that answers without a model call), `reference/machine-spec.md`, `reference/public-api.md`,
  `guides/workflow-machine.md` and `guides/code-interpreter.md` where they list a code state's
  controls, `reference/glossary.md` (control tools), `reference/changelog.md` (a 2.3.0 section).
- **README.md:** where it describes code states, say that a script can add a message to the session.
- **Skill (`skills/archmax-harness/`):** `references/code-states-and-scripts.md` (the control, its
  contract and an example), `references/workflow-schema.md` (the tool table) and `SKILL.md` (the
  checks-are-states patterns).
- **Hosts:** a host that renders `agent-text` events or the transcript shows a code state's message
  with no change; one that maps state types to tool lists reads the split from `STATE_TYPE_TOOLS`.
