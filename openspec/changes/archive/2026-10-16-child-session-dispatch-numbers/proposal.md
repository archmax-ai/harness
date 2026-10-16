## Why

A child session's id was `<parent>~<state>:<workflow>:<ordinal>`, and neither counter behind a
child's names was part of the session:

- **`ordinal` restarted with every agent.** `createSubWorkflowDispatcher` kept it in its closure,
  and `composeGoverned` builds one dispatcher per `createAgent`. A host that builds an agent per
  turn, as the platform does, started every turn at `0`.
- **`dispatchId` counted per process.** It was `subwf-${++dispatchSeq}` with `dispatchSeq` at module
  level, so it counted every dispatch a worker made across all sessions. A turn resumed on another
  worker numbered its dispatches differently, and two workers handed out the same ids. The platform
  puts this id in the session view's URL.

The first lets two dispatches share one child. A parent dispatches `create-invoice` from its state
`create-invoices` for one customer, and the child parks for approval. When the parent is resumed in
a new turn, its next dispatch from that state, for the next customer, derived
`<parent>~create-invoices:create-invoice:0` again. The new child ran on the parked child's thread,
inheriting its history and its folder.

This is request 12 of the platform's handoff (`docs/sdk-handoff.md` in the platform repository).

## What Changes

- **BREAKING: a child is `<parent session id>~<n>`.** `n` numbers the parent session's dispatches
  from 1 across all its turns; a grandchild is `<parent>~<n>~<m>`. The `<state>:<workflow>` part
  goes: the state and the workflow are already on the dispatch's events and records.
- **The count is checkpointed.** A `dispatchCount` channel on the session's state, folded by
  maximum, holds it. Governance reserves it in the dispatcher before anything can dispatch, so a
  fresh agent on any worker continues where the session left off. A dispatch takes its number when
  it is made, and the number is recorded as the pending delegation's `identity`; resume reads the
  recorded identity as it is and never re-derives it.
- **A batch is numbered in tool-call order.** The model's delegation calls in one assistant message
  take `count + 1 …` in the order the model made them, so a node replayed from its checkpoint gives
  each call the same number and the same child. A script's or a hook's dispatch takes the next
  number above the batch, and the count it leaves is committed with the tool call or model step that
  made it.
- **BREAKING: `dispatchId` is the child's id below the root:** `1`, `2`, and `1~1` for the first
  dispatch made inside `1`. The event stream, a pending delegation and the child's session id name a
  child the same way across a turn's whole tree.
- **BREAKING: `~` is reserved.** `sessionIdRejection` refuses a session id holding `~` in any shape
  but a child's, so a host's own id is never read as a child of another session.
  `parentSessionIdOf` and `isChildSessionOf` read a `~` followed by a number from 1 as a child.
- **A park from before the upgrade resumes.** The 0.5 shape (`<state>:<workflow>:<ordinal>`) still
  reads as a child and still binds, so a parent parked on such a child resumes it under the
  identity its park recorded. Nothing mints that shape any more.
- **BREAKING: `subRunIdentity` is removed** from `@archmax-ai/harness/spec`; `dispatchIdOf` and
  `rootSessionIdOf` are added.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `delegation`: a child's id is its dispatch number in the session, counted in checkpointed state,
  numbered in tool-call order within a batch, and named by its path below the root.
- `workspace-and-sessions`: a session id may hold `~` only in a child's shape; the child id
  convention changes.
- `assembly`: the `spec` subpath's session-id names.

## Impact

- **Code:**
  - `src/core/session-id.ts`: the separator, the child-segment grammar (new and 0.5 shapes), the
    `~` rule in `sessionIdRejection`.
  - `src/sessions/scope.ts`: `childSessionId(parent, n)`, `dispatchIdOf`, `rootSessionIdOf`;
    `subRunIdentity` removed.
  - `src/workflow/sub-workflow.ts`: per-session numbering (`reserve`, `dispatchCount`), the
    explicit `number` on a dispatch input; `ordinal` and `dispatchSeq` removed.
  - `src/workflow/state.ts`: the `dispatchCount` channel.
  - `src/workflow/governance.ts`, `tool-service.ts`, `middleware.ts`: number a batch in tool-call
    order, reserve before a `before` hook and a tool call, commit the count with each tool result
    and in `afterModel`.
- **Public API:** session ids and dispatch ids change shape; `subRunIdentity` goes;
  `dispatchIdOf` and `rootSessionIdOf` arrive on `@archmax-ai/harness/spec`.
- **Docs:** `guides/sub-workflows.md`, `guides/triggers.md`, `reference/public-api.md`,
  `reference/changelog.md`, `README.md`.
- **Authoring skill:** `references/workflow-schema.md`, `references/backend-integration.md`.
- **Hosts:** a host that minted session ids holding `~` mints them without it. A host that parsed
  `<state>:<workflow>` out of a child's id reads the state and workflow from the
  `sub-workflow-start` event or the pending delegation instead.
- **Release:** breaking, so 0.6.0.
