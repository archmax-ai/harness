## MODIFIED Requirements

### Requirement: State keys

Each state SHALL accept exactly: `type` (`agent`, the default, or `human`), `title`
(non-empty string), `instructions`, `summary` (a one-line authoring and host label, rendered
into no part of the prompt), `evidence` (list of paths),
`approvers` (list of strings, presented to a reviewer and otherwise uninterpreted),
`triggers`, `before`, `after`, `budget`, `model` (a non-empty model id this state's turns run
on), `on_error` (a state slug), `tools` (`allow`, `forbid`),
`skills` (`allow`, `forbid`), `mounts` (`allow`, `forbid`), `requires` (list of variable names),
`locks` (list of variable names the state owns),
`metadata` (the loose, runtime-inert host slot), and `transitions`. A bare `done:` (YAML
`null`) SHALL be read as an empty state — terminal, `agent`, always-on tools only.

#### Scenario: Unknown state type

- **WHEN** a state declares `type: wait` or `type: workflow`
- **THEN** loading fails naming the type and the two accepted kinds, `agent` and `human`

#### Scenario: A state's metadata is accepted and inert

- **WHEN** a state declares `metadata: { x: 120, y: 340 }`
- **THEN** it loads clean, the block survives on the parsed state, no part of it is rendered into
  the prompt, and it takes no part in governance, routing or the spec hash

#### Scenario: A state's summary reaches no model call

- **WHEN** two workflows differ only in that one declares `summary` on every state and the other
  declares none
- **THEN** every model call of both sees byte-identical prompt text, and the summaries survive on
  the parsed spec for hosts and authors to read

#### Scenario: A state's governance blocks accept their own keys and no others

- **WHEN** a state declares `tools: { allow: [...], forbid: [...] }`,
  `skills: { allow: [...], forbid: [...] }` and `mounts: { allow: [...], forbid: [...] }`
- **THEN** each loads under the strict schema, while a root-level key on a state
  (`tools: { allow_always: [...] }`, `skills: { forbid_always: [...] }`,
  `mounts: { allow_always: [...] }`) is a load error naming the key and its path

#### Scenario: A state's mounts block is part of the machine

- **WHEN** two specs differ only in one state's `mounts.allow`
- **THEN** their spec hashes differ, and a session pinned to one keeps its mount governance when
  the other is published

#### Scenario: A state's model is an id string

- **WHEN** a state declares `model: small-model`
- **THEN** it loads clean and the id survives on the parsed state, while `model: ""` and
  `model: 3` are load errors naming `states.<slug>.model`

#### Scenario: A state stays strict otherwise

- **WHEN** a state declares an undefined key that is not `metadata` (for example `position:`)
- **THEN** loading fails naming the key and its path

#### Scenario: Routing context advisory

- **WHEN** a non-human state with several transitions declares no `instructions`
- **THEN** the lint warns, because the agent has nothing telling it how to classify the request
  before it routes

#### Scenario: Singular trigger is not a state key

- **WHEN** a state declares `trigger: chat`
- **THEN** loading fails naming the unrecognized key `states.<slug>.trigger` and its path

### Requirement: Seeds are locked; locking is monotonic

Every host-supplied variable SHALL be seeded locked (`title` excepted) through one
construction, `buildSeededVariables`, whether it arrives as `createAgent`'s `variables`, a
delivery's variables or a call's arguments, so a guard bound to a seed cannot be invalidated
by the agent. A locked variable SHALL NOT be unlocked, deleted or rewritten by any tool, hook
or script; only a host seeding boundary (a turn start or a delivery) replaces a locked entry,
re-establishing the session's facts, and only `archmax_reset` unlocks one: the locks the agent
set with `archmax_set_variables`, never a host's. A lock SHALL record whether the agent set it; a
lock recorded without that is a host's. Variables SHALL be checkpointed with the session and survive transitions,
parks and turn boundaries; successive writes in one state accumulate.

#### Scenario: Delivery re-seeds a locked name

- **WHEN** a delivery into a parked session carries `reply_body` again
- **THEN** the new value replaces the old, stays locked, and the agent still cannot rewrite it

#### Scenario: A reset frees the agent's locks and keeps the host's

- **WHEN** a session seeded `customer_email` (locked by the host), the agent set `case_id` with
  `lock: true`, and the agent then calls `archmax_reset`
- **THEN** `case_id` keeps its value and can be written again, while `customer_email` stays locked

### Requirement: The variable tools

`archmax_get_variables` SHALL take optional `name` and `path`; a blank or whitespace-only
argument counts as absent. With no `name` it returns every variable with its value and locked
flag; an unknown `name` is an error naming the set variables; a `path` that does not resolve
is an error rather than the whole value. `archmax_set_variables` SHALL take `variables` (name
to whole value; any JSON value, no sub-path write) and optional `lock`; it creates or replaces
each variable and locks them all when `lock` is true. A call SHALL be refused atomically —
nothing written — when it names no variables, uses an invalid name, targets a locked variable,
targets a variable another state owns (naming that state, so the agent can go back there), locks
`title` or a variable a state owns, or writes a malformed `title`. Both tools SHALL be disclosed in every state,
terminal states included.

#### Scenario: Blank name reads everything

- **WHEN** the agent calls `archmax_get_variables({ name: "" })`
- **THEN** it receives every variable, not an unknown-variable error

#### Scenario: One bad key refuses the call

- **WHEN** one call writes `{ case_id: "K-9", title: "Refund" }` with `lock: true`
- **THEN** neither is written and the reason names `title`

#### Scenario: A write from outside the owner is refused naming it

- **WHEN** state `lookup` declares `locks: [order_id]` and the agent calls
  `archmax_set_variables({ variables: { order_id: "2" } })` in `act`
- **THEN** nothing is written and the reason names `order_id` and `lookup` and says to go back
  there to change it

#### Scenario: An owned variable cannot be made final

- **WHEN** the agent in `lookup`, which owns `order_id`, writes it with `lock: true`
- **THEN** nothing is written and the reason says `lookup` owns `order_id`, so it stays
  changeable there

## ADDED Requirements

### Requirement: A state may own variables

A state MAY declare `locks:`, a list of variable names it **owns**. Only the owning state SHALL
write a variable it owns, on any of its visits and in any turn, before or after the variable is
set; a write from any other state is refused (see "The variable tools"). Ownership SHALL apply to
any variable, whether or not a guard reads it, and SHALL be read from the spec, never from the
session. Loading SHALL fail when two states own the same variable, when `locks` names `trigger` or
`title`, when it names a variable twice, or when it is declared on a human state, which makes no
tool calls. A variable the host supplies (a seed, a trigger input, a delivered variable) stays
locked and final although a state owns its name; assembly SHALL warn about a seed with an owned
name, and the lint SHALL warn about a trigger's required input with one. A sub-workflow's states
own variables of the child session only.

#### Scenario: The owner decides again after the session goes back

- **WHEN** `lookup` owns `order_id` and sets it to `1`, the session advances to `act`, the person
  names order 2, and the agent advances back to `lookup`
- **THEN** a write of `order_id` in `act` is refused naming `lookup`, the write in `lookup`
  succeeds, and `act`'s guard on `${{order_id}}` admits order 2 once the session is there again

#### Scenario: Two owners fail loading

- **WHEN** `lookup` and `confirm` both declare `locks: [order_id]`
- **THEN** loading fails naming `order_id` and both states

#### Scenario: Ownership is not tied to guards

- **WHEN** `draft` declares `locks: [summary]` and no guard references `summary`
- **THEN** only `draft` may write `summary`, as for a guarded variable
