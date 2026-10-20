## Context

See proposal.md for the motivation. Edges reach the agent through one function,
`renderTransition` in `src/workflow/render-prompt.ts`, called from `renderStateGraph` for the
active state only. The volatile "Current state" block puts that output last, just before the model
acts. The required description is enforced by `machineTransitionSchema` in
`src/machine/spec-schema.ts`, with one message that covers missing, empty, blank and mistyped values.
Cross-reference checks (a target exists, `on_error` resolves) live in `refineSpec`, which sees the
whole `states` map. Every other reader of `description` already treats it as optional: park options
in `parks.ts`, `archmax decide`'s listing in `cli/turn.ts`, and the graph artifact in
`session-artifacts.ts`. A state's `instructions` is an optional string, inserted trimmed and without
interpolation for the active state.

## Goals / Non-Goals

**Goals:**

- An undescribed edge is navigable: the agent sees what the target will have it do.
- A described edge renders byte-identically to today, and every spec that loads today loads
  unchanged.
- An edge with nothing to route on is still refused at load.

**Non-Goals:**

- Disclosing anything else of a target: `title`, `summary`, hooks, transitions or approvers.
- Changing what a person sees at a human state, or the decision record.
- Interpolating `${{…}}` in a target's instructions. They are rendered raw, the way the active
  state's are.
- Recursive transparency. If the target's own edges are undescribed, nothing beyond the target's
  instructions is shown.

## Decisions

### D1. One notion of "undescribed": absent, empty or whitespace-only

Authors write `description: ""` as readily as they leave the key out, and a blank string carries no
routing information either way. All three mean the same thing. A non-string value stays a load
error, because it is a typo, not a choice.

### D2. The checks live in `refineSpec`, not in the transition schema

The transition schema becomes `description: z.string(...).optional()`, with a message for the
non-string case. Whether an undescribed edge is acceptable depends on two other states: the source,
which must not be human, and the target, which must have non-blank instructions. That makes it a
cross-reference check, and `refineSpec` already runs those. Both errors are addressed to
`states.<slug>.transitions.<index>.description`, as today, and each says what to write: a
description, or instructions on the target. Keeping them as schema errors, rather than lint errors,
matches the "unnavigable graph is worse to warn about than to refuse" rationale in the current code.

### D3. Render the instructions as a quoted block under the edge line

```
- to `lookup` — no description; the instructions you will follow once in `lookup`, given only for choosing this edge:
  > Look up the order by its id and summarise its status.
  >
  > Use the order-data skill.
```

The type and human/terminal markers keep their place in the parenthetical after the slug. Each
instruction line is prefixed `  > `, and a blank line becomes `  >`, so a multi-paragraph or
markdown body stays one visible unit under its bullet. A heading in the body cannot be mistaken for
a section of the prompt. The framing sentence says these instructions are for the target, so the
model does not start that state's work early. *Alternative:* inline the first line only. Rejected:
instructions are often several paragraphs, and a truncated first line routes worse than a short
description would.

### D4. A human target's reviewer-facing instructions are disclosed when the author leaves the edge undescribed

The spec currently withholds a human target's instructions. Transparency is opt-in per edge, so the
author decides: describe the edge to keep them private. The docs and the skill say this next to the
rule. *Alternative:* forbid undescribed edges into human states. Rejected: the human marker already
tells the agent it will stop, and the decision text is often exactly what it needs to prepare the
evidence.

## Risks / Trade-offs

- **[Long target instructions inflate the volatile block on every call in the source state]** → The
  author opts in by omitting the description, and the docs point at a description as the compact
  alternative. The block is volatile in any case, so the cacheable prefix is unaffected.
- **[The agent follows the target's instructions while still in the source state]** → The framing
  sentence and the quoting address this. A behaviour test pins the framing text so a later edit
  cannot drop it.
- **[Reviewer-only guidance leaks to the agent through an undescribed edge into a human state]** →
  This is documented, and a description restores today's behaviour.
