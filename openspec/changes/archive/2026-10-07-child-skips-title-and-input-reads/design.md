## Context

See proposal.md for why the change is needed. This section describes how the pieces fit today.

- **A child is its own composition.** `createDelegationRegistry` (`src/assembly/delegation-registry.ts`)
  composes each target lazily with `renderSystemPrompt` and `composeGoverned`, memoized per slug
  and delegation chain. So a child's system prompt and tool list are built once per target and
  shared by every dispatch of it, and never by the root. Running the same workflow standalone
  (`archmax run <child>`) goes through `createAgent`, a top-level composition.
- **The platform prompt** is `src/core/platform-prompt.md`, compiled into
  `platform-prompt.generated.ts` (a test fails while the two differ). `resolveSystemPrompt` reads
  a workspace override at `.platform/system/GRAPH_STATE.md` first. The title instruction lives
  in two places in it: step 1 of the "How you move" list, and the "Naming the run" paragraph that
  says the step "is not optional" and "still goes first when the state's instructions tell you
  to do something else first".
- **`archmax_set_variables`' description** (`createControlTools`, one list per composition) ends
  with "`title` is reserved …: set it early, update it when the task changes, and never lock it."
- **The opening line** (`SUB_RUN_OPENING` in `src/workflow/sub-workflow.ts`) is the child's
  whole transcript when its first model call runs: a human-role message marked `opening`, built
  where the dispatcher already holds the resolved, validated params.
- **The volatile block** lists the names of the variables set ("Run variables set: … Read one
  with archmax_get_variables.") for every session, by design never their values.

## Goals / Non-Goals

**Goals:**

- A child's first model call can start the state's work: nothing it reads asks for a title, and
  its short scalar inputs are in front of it.
- A top-level session's system prompt, tool descriptions and cacheable prefix stay
  byte-identical.
- A child's static prefix stays identical across dispatches of the same target, so parallel
  children share a cache entry.

**Non-Goals:**

- **The volatile names line.** "Run variables set: … Read one with archmax_get_variables." is
  shared by every session and points at variables a child sets later too. It stays.
- **A child setting its returns twice**, or a missing return with no second chance. Independent
  requests from the same report.
- **Rendering values for a top-level session.** A host's seeds can be a whole event payload;
  the names-only rule for the volatile block is unchanged.

## Decisions

### Omit the title step in the child's prompt layer, by markers in the platform prompt

The two passages are wrapped in `<!-- top-level-only -->` / `<!-- /top-level-only -->` lines.
`platformPromptFor(text, session)` (`src/core/prompt.ts`) removes the marker lines for a
top-level session and the whole passages for a child, renumbering the ordered list a passage cut
items from (step 1 goes, steps 2–4 become 1–3). The child composition passes `child: true` to
`renderSystemPrompt`, which hands it to `resolveSystemPrompt`.

The rule is applied to whatever the platform layer reads, bundled or overridden. An override
copied from the bundled prompt keeps the omission; an override written without markers reads the
same in both sessions, exactly as it did before. The markers live in the Markdown, so whoever
edits the prompt sees which passages a child skips, and the knowledge is not a string match in
code that a rewording would silently break.

The same composition flag drops the title sentence from the child's `archmax_set_variables`
description, so nothing a child reads nudges it toward a title.

- *Alternative: seed the child's `title` from the dispatch so the instruction is already met.*
  Rejected. The prompt still says the step "is not optional" and "still goes first" whatever
  else the state says, so a model would likely rewrite a seeded title rather than skip the call.
  Making the step conditional ("unless a title is set") changes the top-level prompt and its
  cache prefix for every session. And a seeded title would invent a label for a session nothing
  lists, emitting a `title-set` a host has to filter out.
- *Alternative: tell the child to skip it in the opening message.* Rejected. It contradicts a
  system prompt that anticipates exactly that ("it still goes first when the state's
  instructions tell you to do something else first"); a model resolving the conflict either way
  is not a fix.
- *Alternative: two generated constants, top-level and child.* Rejected: the override still
  needs the rule at runtime, so the logic would exist twice (in the `.mjs` generator and in TS).

### Render input values into the opening message, not the system prompt

`subRunOpening(params)` builds the opening note from the call's resolved arguments. A value is
shown when it is a string (rendered with `JSON.stringify`, with U+2028/U+2029 escaped too), a
finite number or a boolean, its rendering is at most 200 characters, and the values shown so far
plus it stay within 1,000 characters. Names are taken alphabetically, so the message is
deterministic whatever order the caller's model wrote the arguments in. Any other input is named
on one line with `archmax_get_variables` as the way to read it. With nothing to name, the message
never mentions reading.

The opening message is per dispatch and already child-only, it is built where the params are
known and validated, and the arguments are locked, so the rendering stays true for the child's
run (a later delivery that re-seeds a name arrives in the transcript as its own `[event]` note).
It sits after the system prompt, so a child's static prefix stays shared across dispatches.

Quoting is the injection defence: a string is shown as a JSON literal, so a line break, a
`- name:` or a `## Current state:` inside it stays inside the quotes on one line, and the line
parses back to the exact value.

- *Alternative: render values into the volatile signature section ("This run was started
  with: …").* Rejected. That block is rendered for top-level sessions too, where seeds may be
  whole event payloads and the names-only rule is deliberate; restricting it to children would
  couple the governance middleware to the session's depth for no gain over the opening message.
- *Alternative: render every value, structured ones as JSON.* Rejected. The platform prompt
  tells the agent to pass a value on as `${{name}}` rather than retype it; a large value a child
  only passes through would be paid for on every model call of the child for nothing. The bounds
  keep the message to what a child plainly needs to read.

## Risks / Trade-offs

- [A model still calls `archmax_get_variables` because of the volatile "Read one with …" line] →
  The values are in the message right before it acts, and nothing tells it to read them. The
  behaviour test pins what the child is handed; a live run confirms the call count (tasks 4.2).
- [An override author does not know about the markers] → An override without them behaves as
  before (the child is asked for a title). The sub-workflow guide, the workflow-machine guide and
  the authoring skill name the markers; the changelog entry tells override authors to add them.
- [Renumbering an override's list wrongly] → Only the ordered list a left-out passage cut items
  from is renumbered, ending at the first unindented non-item line; unit tests pin continuation
  lines, blank lines inside a list, a second list, padded markers and an unclosed marker.
- [A caller that relied on the child's title] → None can: `returns` refuses `title`, and a child's
  `title-set` carries the dispatch id. A caller that wants a label passes `title` down, as before.
