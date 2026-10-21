## Why

Every transition must carry a non-empty `description`, because the agent sees the active state's
outgoing edges and nothing else of the graph. Often the best description of an edge is just what
the next state does, and the author has already written that once, as that state's `instructions`.
Making the author paraphrase it on every edge into the state is duplicate work, and the copies drift
when the instructions change. An author should be able to leave an edge undescribed and let the
agent route on the target's own instructions.

## What Changes

- **`description` becomes optional on a transition.** An absent, empty or whitespace-only
  `description` marks the edge as *undescribed*. A non-string value is still a load error.
- **An undescribed edge is transparent.** On the edge's line in the "Current state" block, the
  agent is shown the target state's `instructions` instead of a description, quoted and framed as
  what that state will have it do: for choosing the edge, to be followed only once it is there. The
  edge's `type` and its human/terminal markers are rendered as before. A described edge renders
  exactly as today, and still discloses nothing of its target.
- **An edge still needs something to route on.** An undescribed edge whose target has no non-blank
  `instructions` is a load error at `states.<slug>.transitions.<index>.description`. The error says
  to write a description or give the target instructions.
- **A human state's own transitions still require a description.** There the description is the
  decision's button label for a person, and the target's instructions would not help them. This
  stays a load error.
- **An undescribed edge *into* a human state discloses that state's instructions** to the agent.
  They are written for the reviewer. An author who wants to keep them from the agent describes the
  edge. Docs and the authoring skill say so.
- **Only agent-facing text changes.** The decision record, `archmax decide`'s option list, park
  options and the session's graph artifact already treat a missing description as absent, and they
  keep doing so. A reply-only turn still discloses no transitions.
- Not breaking: every spec that loads today loads unchanged and renders the same prompt.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `workflow-spec`: transition `description` is optional. New load errors cover an undescribed edge
  to a target without instructions, and an undescribed transition on a human state.
- `governance`: per-state graph disclosure renders the target's `instructions` for an undescribed
  edge. This is the one case in which an attribute of the target state is disclosed.

## Impact

- **Code:** `src/machine/spec-schema.ts` (schema, `refineSpec` checks, error messages),
  `src/machine/types.ts` (`MachineTransition` doc), `src/workflow/render-prompt.ts`
  (`renderTransition`), and `src/machine/lint-spec.ts` (stale comments about the schema guaranteeing
  a description). Tests go in `spec-schema.test.ts`, `render-prompt.test.ts` and the behaviour suite.
- **Docs (`docs/`):** `reference/machine-spec.md` (transitions), `guides/workflow-machine.md`
  (routing and edge descriptions), and a non-breaking entry in `reference/changelog.md`.
- **Authoring skill (`skills/archmax-harness/`):** `references/workflow-yaml.md` (skeleton
  comments on `description`), `references/workflow-schema.md` (the transition shape and the
  disclosure rule), and `references/diagnostics.md` (the two load errors).
- **README.md:** there is no change unless it says edges must be described. Check, and fix if it
  does.
