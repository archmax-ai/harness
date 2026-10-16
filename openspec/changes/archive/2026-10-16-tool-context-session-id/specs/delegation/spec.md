## ADDED Requirements

### Requirement: A host tool's file work inside a child belongs to the child

A host tool called inside a child session SHALL be handed the child's workspace and the child's
`sessionId` (see `assembly`), so its file work lands in the child's session, where the child's own
file tools look. A host that keeps session files in its own store SHALL key them by
`ToolContext.sessionId`, never by the session it sent the turn to: in a child session that id names
the caller's folder, which the child neither reads nor writes.

#### Scenario: A child's host tool writes into the child

- **WHEN** a host tool called in a child unpacks a document into 41 files, keyed by
  `ToolContext.sessionId`
- **THEN** the child's `read_file`, `ls` and `glob` find all 41, and the caller's workspace holds
  none of them
