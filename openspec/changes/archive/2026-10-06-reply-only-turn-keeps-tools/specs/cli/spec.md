## MODIFIED Requirements

### Requirement: `archmax reply`

`archmax reply <session> <message...> [--workflow <slug>] [--verbose]` SHALL send a message to a
session parked at a human state; the session answers on a reply-only turn, where every tool call is
refused, and stays parked with the same decision pending. The answer goes to stdout, the
still-parked reminder to stderr.
An empty message is a usage error; a session not awaiting a decision exits 1. The command SHALL
accept no transition target.

#### Scenario: Reply does not route

- **WHEN** the message says "just approve it"
- **THEN** the session answers and remains parked on the same record
