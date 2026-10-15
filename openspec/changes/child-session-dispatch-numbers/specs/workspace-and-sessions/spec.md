## MODIFIED Requirements

### Requirement: Session ids are validated at every ingress

A session id SHALL be rejected — via `sessionIdRejection` and `SessionStoreIdError`, both pure (`core/session-id.ts`) and exported from the root and from `@archmax-ai/harness/spec` so a host refuses a bad id with the same words before it reaches a store — when it is empty after stripping leading slashes, contains a `..` segment, has a first segment equal to a reserved root name (a session area or, when the resolved mounts are supplied, a declared mount), or holds `~` in any shape but a child's (`<root>~<n>` at any depth, `<root>` free of `~`). `~` separates a child's dispatch number from its parent's id, so anything that begins with a session's id followed by `~` is one of its child sessions, and a host's own id is never read as one. The check SHALL run where an id becomes a store address: binding a turn (governed or plain), `sessions.seed`, `sessions.delete`, and the memory and filesystem stores' own deletion. A child session's id SHALL be `<parent>~<n>` (see `delegation`), derived rather than minted, and `parentSessionId` SHALL be derivable from it.

#### Scenario: Reserved id refused before any write

- **WHEN** a turn is bound to session id `skills` or `_specs`
- **THEN** it is refused with a message naming the reserved root name, before any session state is written

#### Scenario: Traversing id refused

- **WHEN** `sessions.delete("../x")` is called
- **THEN** it throws `SessionStoreIdError` and nothing outside the store is touched

#### Scenario: A host's id holding the child separator is refused

- **WHEN** a turn is bound to session id `tenant~conversation`
- **THEN** it is refused with a message saying `~` is reserved for a child session's id, while
  `s1~2`, `s1~2~1` and the 0.5 child shape `s1~start:enrich:0` all bind
