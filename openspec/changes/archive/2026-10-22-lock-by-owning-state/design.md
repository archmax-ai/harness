## Context

See proposal.md for the motivation and the delta specs for the rules.

- **The store.** A variable entry is `{ value, locked }` (`src/machine/variables.ts`,
  `variableEntrySchema` in `src/workflow/state.ts`). `mergeVariables` keeps a locked entry
  against every write except one marked `reseed`, the marker a host seeding boundary (a turn's
  opening, a delivery) sets. It copies only `value` and `locked` into the merged entry.
- **The one agent writer.** `handleSetVariables` (`src/workflow/control-tools.ts`) refuses a call
  atomically: an invalid name, a locked target, `lock` on `title`, a mistyped return. It receives
  the machine and the checkpointed state, so it knows the current state. Hooks and scripts cannot
  write variables.
- **Reset.** `handleReset` (same file) moves the position and clears the turn's correction state.
  It writes no variables.
- **Where a spec is checked.** `refineSpec` (`src/machine/spec-schema.ts`) checks
  cross-references and fails loading. `lintSpec` (`src/machine/lint-spec.ts`) warns. Assembly warns
  about seeds (`unguaranteedReferenceWarnings` in `compose.ts`).

## Goals / Non-Goals

**Goals:**

- One rule decides who may write a variable: the spec's owner if there is one, else the lock.
- A reset releases exactly the locks the agent set.

**Non-Goals:**

- Telling the model in the prompt which variables a state owns. The refusal names the owner and
  says to go back there, which is the moment the model needs to know.
- Locking guarded variables automatically, or changing the variable tools' description.
- Moving ownership, or an owned variable that some other state may "refine".

## Decisions

### Ownership is read from the spec

`WorkflowMachine` builds `owners: Map<variable, state>` from every state's `locks` at load and
exposes `ownerOf(name)`. Nothing about ownership is stored in the session. A spec edit therefore
takes effect on the next write, as every other governance rule does, and a reset or a park needs
nothing.

The alternative was to record the owner on the variable when it is first written. Rejected: it
would put a second source of truth in the checkpoint, and it would go stale when the spec changes.

### An owned variable is never locked

An owned variable's entry stays `locked: false`. `handleSetVariables` gains two checks, both
atomic like the rest:

- **A write from outside the owner:** the target has an owner, and the current state is not it.
  The refusal: *"'order_id' belongs to state 'lookup': only 'lookup' can change it. Go back to
  'lookup' to change it. Nothing was written."*
- **`lock: true` naming an owned variable:** refused, worded like the `title` refusal.

A host seed of an owned name is still a host lock. The existing locked check refuses the write
first, so the host wins without special handling.

### A lock records that the agent set it

The entry gains an optional `lockedBy: "agent"`, set by `handleSetVariables` when `lock` is true.
`mergeVariables` carries it, and a host boundary's `reseed` write replaces the entry and so drops
it. An entry locked without the marker is a host's, which is also how every lock from before this
change reads.

Alternatives:

- **A separate `agentLocks` list channel.** Rejected: a host boundary that later re-seeds the same
  name would have to remember to remove it from the list, or a reset would unlock a host value.
  The marker on the entry cannot drift from the entry.
- **Hiding the marker from hosts.** Not done. `outcome.variables`, `variables.json` and
  `sessions.get` show it, as an optional addition to `{ value, locked }`, and the public-API page
  says what it means.

### Reset releases the agent's locks

`handleReset` adds a variables delta: every entry with `lockedBy: "agent"`, rewritten as
`{ value, locked: false }` and marked `reseed` so the merge accepts it over the lock. The marker
is the merge's runtime-only instruction to replace a locked entry, and no agent-reachable path
sets it, so the guarantee that the agent cannot break a lock holds. Only the runtime's reset
releases one.

### Validation

`refineSpec` fails loading for:
- a variable owned by two states (naming both);
- `trigger` or `title` in `locks`;
- a duplicate within one list;
- `locks` on a human state.

`lintSpec` warns when a trigger's `requires` names an owned variable, because the firing seeds it
locked. Assembly warns when a `createAgent` seed names one. A `returns` name may be owned: its
seed lands unlocked by design, so the owner can still write it.

## Risks / Trade-offs

- **[A workflow with no way back]** If no edge leads from the state that needs the change to the
  owner, the value cannot change. → The refusal says where the value belongs, and the docs and
  the skill tell authors to give an owner a back-edge from the states that act on its variables.
  A static reachability warning is left for later.
- **[A reset frees more than an author expects]** An agent lock the author relied on is
  released by a reset. → That is the point of the change. An author who needs a value fixed
  across resets has it seeded by the host, or owned by the entry state.
- **[The marker is visible]** Hosts reading variables see `lockedBy: "agent"`. → It is additive
  and documented, and it tells a host something true.
