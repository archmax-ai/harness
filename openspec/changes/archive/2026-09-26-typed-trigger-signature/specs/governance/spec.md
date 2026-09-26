## ADDED Requirements

### Requirement: A disclosed trigger signature names each variable's type and description

Where the volatile "Current state" block discloses the session's own trigger signature (see
*Per-state graph disclosure*), each variable SHALL be disclosed with its declared type and
description beside its name when its entry declares them, and by name alone when it does not.
The disclosure SHALL keep its scope: the session's own trigger only, and never the trigger
declaration's `description`, which describes the entry to a caller rather than to the agent
serving it. The rendering SHALL be deterministic for one signature, so the block stays
byte-identical across the model calls of a turn.

#### Scenario: A typed return is disclosed with its type

- **WHEN** a session started by `manual` declaring
  `returns: [{ name: total, type: number, description: "Refunded amount in EUR." }, note]`
  makes a model call
- **THEN** the block names `total` as a `number` with its description and `note` by name alone

#### Scenario: The entry's description is not disclosed

- **WHEN** the `manual` declaration also carries `description: "Refund one order."`
- **THEN** no model call of the session carries that sentence

#### Scenario: An untyped signature renders as before

- **WHEN** a trigger declares `requires: [order_id]` and `returns: [status]`
- **THEN** the block names both by name alone
