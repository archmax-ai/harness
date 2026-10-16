## Context

- `sessionBinder(ctx)` (`src/assembly/compose.ts`) is the one place a session id becomes a store
  address. It wraps a turn in three bindings: the event context, the session zone's
  `sessionScoped(id)`, and `runWithToolContext({ workspace })`.
- A dispatched child runs through its own turn runner (`child.driver.invoke`, wired in
  `delegation-registry.ts`), whose `bindSession` is `sessionBinder` with the child's `thread_id`. So
  inside a dispatch every one of the three bindings already names the child.
- A script's tool call reaches the host tool through the PTC gateway inside the same async context,
  so the same `AsyncLocalStorage` binding holds there.

## Goals / Non-Goals

**Goals:**

- A host tool can address the session its call is made in, in the parent and in any child, from
  the model and from a script.
- The store layout a host relies on is written down.

**Non-Goals:**

- Exposing `SessionZoneRouter` or the session-scoped binding itself.
- Giving a host a different id (the root's, or the caller's) for a child. Files cross between
  sessions only as the copies `file` entries make.

## Decisions

**1. Bind the id where the workspace is bound.** `runWithToolContext({ workspace, sessionId })` in
`sessionBinder`, with the id the binder was handed. The binder already refuses an id that cannot own
a folder, so the id a tool reads is always one the store accepts.

*Alternative:* read `sessionZone.boundSessionId()` lazily from a getter. It gives the same value, but
the context would then depend on two bindings staying in step instead of one.

**2. Out of a turn, `sessionId` throws like `workspace`.** A host invoking a tool directly gets a
handler that runs, and an error only when it reaches for something that exists per turn. Both
properties are non-enumerable there, so `toEqual({})` and `JSON.stringify` keep working.

**3. The store address is documented, not re-implemented.** The address is what
`SessionZoneRouter` builds: the bound id prefixed onto an id-free path. The change writes it down in
the public API page, the authoring skill and the spec. No helper is added; a host builds
`` `${sessionId}/${path}` `` itself, beneath the prefix it gave its backend store.

## Risks / Trade-offs

- A host could still key by the id it sent the turn to and keep the defect. The docs say in three
  places (public API, sub-workflows guide, skill) to key by `ToolContext.sessionId`.
