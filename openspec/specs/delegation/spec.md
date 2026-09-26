# delegation Specification

## Purpose

Define how one workflow calls another in the same workspace: a state names
`archmax_workflow_<slug>` in its `tools.allow`, the target's `manual` trigger signature becomes
the tool's call signature, and a call runs the target as a **child session** of its own to
completion and answers with the declared returns and the closing message. Delegation is an
ordinary governed tool call built on the public runtime — bounded by depth and concurrency,
failing closed on every error, and suspending the caller when the child parks.

## Requirements

### Requirement: A delegatable workflow is exposed to a calling state as a tool

The runtime SHALL bind a tool named `archmax_workflow_<slug>` for a sibling workflow when — and
only when — that name appears in the calling workflow's `tools.allow` for a state or in
`tools.allow_always`, and the target declares a `manual` trigger. Naming the tool is the whole
declaration: there is no state kind, no second key and no discovery walk over `workflows/*/`.
The tool is governed like every other tool (closed by default, and a `tools.forbid_always` or
`tools.forbid` entry denies it like any other),
its name space is reserved (`ReservedToolNameError` for a host tool claiming the prefix), and
`workflowToolName`/`workflowSlugFromToolName` map slug and tool name in both directions.

#### Scenario: Only named targets are callable

- **WHEN** a workspace holds three workflows and a state allows `archmax_workflow_enrich-order`
- **THEN** that state can call `enrich-order` and no other sibling

#### Scenario: A state naming no target can delegate to none

- **WHEN** a state's `tools.allow` names no delegation tool and `allow_always` names none
- **THEN** no delegation tool is disclosed or permitted in that state

#### Scenario: A denied delegation tool is blocked like any other

- **WHEN** `tools.forbid_always` names `archmax_workflow_enrich-order` and a state's `tools.allow`
  names it too
- **THEN** the call is blocked and the tool is not disclosed: a denial beats every grant

### Requirement: The call signature is the target's declared requires

A delegation tool's input schema SHALL be derived from the target's `manual` trigger by the
runtime's one signature-to-JSON-Schema mapping (see `workflow-spec`): one required parameter
per entry of `requires`, carrying the entry's type and description where it declares them and
described as a locked variable, and nothing else — no prose argument, no fan-out argument. The
tool description SHALL be built from the target's own spec — the `manual` trigger's
`description` first when it declares one, then the title, requires and returns — never its
`instructions`. A dispatch missing a required name SHALL be refused with kind `missing-param`,
and a dispatch whose argument does not conform to a typed entry SHALL be refused with kind
`invalid-param` naming the argument, its declared type and what arrived, both before any child
is composed; an argument carrying a `${{…}}` reference SHALL be resolved against the caller's
variables verbatim (not glob-escaped) before dispatch, an argument that is exactly one
reference SHALL take the referenced value's own type, and an unresolvable reference SHALL
refuse the call with kind `unresolved-param`.

#### Scenario: Missing input refused

- **WHEN** a target declares `requires: [order_id]` and the caller omits `order_id`
- **THEN** the call is refused as a blocked call naming the target and `order_id`, and no child runs

#### Scenario: Referencing argument substituted

- **WHEN** a script calls the tool with `{ account_id: "${{account_id}}" }` and `account_id` is `acct-42`
- **THEN** the child is seeded with `account_id` = `acct-42`

#### Scenario: A typed parameter reaches the tool schema

- **WHEN** a target's `manual` trigger declares
  `requires: [{ name: due, type: date, description: "The day the refund is due." }]`
- **THEN** the tool's input schema describes `due` as `{ type: string, format: date }` with that
  description, and lists it as required

#### Scenario: A mistyped argument is refused

- **WHEN** the target declares `{ name: quantity, type: integer }` and the caller passes
  `quantity: "three"`
- **THEN** the call is refused with kind `invalid-param` naming `quantity` and `integer`, and no
  child runs

#### Scenario: The entry's description leads the tool description

- **WHEN** the target's `manual` trigger declares `description: "Refund one order."`
- **THEN** the tool description begins with that sentence and still carries nothing of the
  target's `instructions`

### Requirement: The child is its own session, seeded with the call's arguments only

A dispatch SHALL run the target as a separate session with id `<parent>~<state>:<workflow>:<ordinal>`,
in the configured session store with its own checkpoints, artifacts and `scratchpad/`, and
with the parent session id recorded on it. Its variable store SHALL contain exactly the built-in
`trigger` (`manual`) and the call's arguments, seeded locked through the same construction a
host's `variables` seeds use; the caller's variables SHALL NOT be copied down under any name.
The child's transcript SHALL start with one fixed `opening` runtime note and no caller prose;
its brief is its own spec. The child SHALL be composed lazily and memoized per slug from the
parent assembly's model and options, while its signature is read from its spec at assembly for
every allow-listed target.

#### Scenario: Caller variables are not visible

- **WHEN** a calling session holds `stage` and calls `archmax_workflow_enrich-account({ account_id })`
- **THEN** the child is seeded with `account_id` only, and `${{stage}}` is unset in it

#### Scenario: Standalone parity

- **WHEN** the same workflow is run directly with `--variables` supplying its `requires`
- **THEN** its guards, hooks and `${{trigger}}` observe the same values as when a caller dispatched it

### Requirement: The call answers with the declared returns and the closing message

A completed child SHALL answer its tool call with `{ message, returns }` when the target
declares `returns` — the values of those variables read from the child's settled store, each
conforming to its declared type because the child's completion check held them to it — and
with the closing message alone otherwise. Nothing else SHALL cross back: the child's transcript,
trail and every other variable are discarded when it settles. Nothing captures the answer into a
caller variable; an agent that needs one sets it with `archmax_set_variables`, a script writes
the value it received, and the calling state's `requires:` is the guarantee.

#### Scenario: Returns delivered by name

- **WHEN** a target declaring `returns: [enrichment_file, delayed]` completes
- **THEN** the caller's tool result carries both under `returns` beside the closing `message`

#### Scenario: Child that settles without its returns fails closed

- **WHEN** a child finishes with a declared return unset
- **THEN** it settles rejected with kind `missing-return` naming the state and the unset names, and
  no partial result reaches the caller

#### Scenario: A child whose typed return does not conform fails closed

- **WHEN** a target declares `returns: [{ name: delayed, type: boolean }]` and its child finishes
  with `delayed` holding `"no"`
- **THEN** it settles rejected with kind `invalid-return` naming the state, `delayed` and
  `boolean`, and no partial result reaches the caller

### Requirement: Dispatch is bounded by depth, cycles, concurrency and target state

The dispatcher SHALL refuse a dispatch that would exceed its depth bound (default
`DEFAULT_SUB_WORKFLOW_DEPTH` = 3, counting the parent chain), a dispatch naming a workflow already
on the current chain (kind `cycle`, naming the chain), a target that is disabled (kind
`disabled`), unknown (kind `unknown-workflow`) or not delegatable (kind `not-delegatable`). It
SHALL bound in-flight children per session by a semaphore (default
`DEFAULT_SUB_WORKFLOW_CONCURRENCY` = 4), queuing excess rather than refusing. Both bounds are
dispatcher configuration (`bounds: { maxDepth, maxConcurrent }`), not spec settings. Every
refusal SHALL reach the caller as a blocked call, made before the child is composed, and a
refused target's load SHALL NOT be memoized as refused.

#### Scenario: Cycle refused

- **WHEN** workflow `a` calls `b` and `b`'s state allows `archmax_workflow_a`
- **THEN** the second dispatch is refused with kind `cycle`, naming the chain

#### Scenario: Disabled target refused without failing assembly

- **WHEN** a state allows a target whose spec declares `disabled: true`
- **THEN** assembly succeeds, `validate` warns, and the dispatch is refused with kind `disabled`

#### Scenario: Fan-out bounded

- **WHEN** a script issues ten calls under `Promise.all` with `maxConcurrent` 4
- **THEN** at most four children run at once and all ten complete

### Requirement: One call, one child; fan-out is many calls

One call SHALL start exactly one child. A caller that wants several SHALL make several calls —
a model by emitting parallel tool calls, a script through the PTC bridge with `Promise.all` —
and the runtime SHALL run them concurrently within the bound. A delegation tool is the one
runtime tool a script may call through the bridge, governed by the kernel like any other call;
a script's call SHALL fail closed with kind `parked` if its child parks, since a sandbox frame
cannot resume.

#### Scenario: Script delegates and uses the result

- **WHEN** a script in a state allowing the tool calls `tools.archmaxWorkflowEnrichOrder({ order_id })`
- **THEN** the child runs and the script receives its returns and message as the call's value

### Requirement: Every failure fails closed

A child that is rejected, exhausts a budget, errors, or settles without its returns SHALL
answer the call with a tool error (`SubWorkflowError` with its kind) naming the workflow and
the reason, writing no variable and returning no partial result; the calling agent may retry,
route around it, or stop, and the calling state's `on_error` catches an unrecovered failure.
Refusals (`depth-exceeded`, `cycle`, `missing-param`, `unresolved-param`, `unknown-workflow`,
`not-delegatable`, `disabled`) SHALL be blocked calls the caller may correct within the turn.
Concurrent children SHALL fail independently.

#### Scenario: Rejected child answers its own call

- **WHEN** two children run concurrently and one is vetoed by its hook
- **THEN** that call receives the tool error and the other call's result is unaffected

### Requirement: Every ancestor's workflow-wide denials bind inside a child

A child's kernel SHALL be compiled from its own denials plus those compiled from every ancestor's
**workflow-wide** lists — `tools.forbid_always`, `skills.forbid_always` and `mounts.forbid_always`, the
root's and each intermediate caller's, accumulated down the chain — evaluated ahead of the child's own
rules, so a child may be more permitted but never re-grant what any ancestor denied. Allow lists are
the child's own and are not inherited, and neither is any ancestor's per-state `forbid`: a state's
denial governs that state's turns, not a child session.

#### Scenario: Root denial holds in the child

- **WHEN** the root workflow denies `send_email` with `tools.forbid_always` and a child state allows it
- **THEN** the child's call is blocked, and the reason names the root workflow

#### Scenario: A caller's per-state denial does not reach the child

- **WHEN** the calling state declares `tools: { forbid: [send_email] }` and the child's own state
  grants `send_email`
- **THEN** the child's call succeeds

#### Scenario: An ancestor's skill denial puts a bundle out of the child's reach

- **WHEN** the root declares `skills: { forbid_always: [orders] }` and a child grants itself that
  bundle with `skills.allow_always`
- **THEN** a read inside `skills/orders/**` is blocked in the child, naming the workflow that denied it

#### Scenario: An ancestor's mount denial puts a folder out of the child's reach

- **WHEN** the root declares `mounts: { forbid_always: [reference] }` and a child enables that mount
  with `mounts.allow_always`
- **THEN** a read under `reference/` is blocked in the child with `mount.forbidden`, naming the
  workflow that denied it

### Requirement: A child that parks suspends its caller

A child reaching a human state or calling `archmax_wait` SHALL park the parent session with it.
The runtime SHALL record one pending delegation (calling state, tool call, workflow, dispatch)
in checkpointed state, answer the model with a tool result saying the child parked and why,
let sibling calls in the same batch land their results, and park the parent at the next hook
site. The decision presented SHALL be the child's — its state, instructions, evidence and
transitions. `decide`/`deliver` on the parent SHALL resume only the parked child from its own
session; its result SHALL be appended to the parent transcript as a `sub-workflow` runtime note
and the parent SHALL continue in the calling state without replaying the turn or re-dispatching
finished siblings. Several parked children SHALL be presented one at a time, the parent parking
again until all are decided. A message sent to the parked parent SHALL be answered on a
reply-only turn, never handed to the child as a decision. The trail SHALL carry a
`sub-workflow` step with the workflow and its status, and the child's events SHALL be
attributed to the dispatch.

#### Scenario: Parent parks awaiting the child's decision

- **WHEN** a child reaches `type: human`
- **THEN** the parent session is parked for a decision presenting the child's transitions

#### Scenario: Two children park in one batch

- **WHEN** two calls in one tool batch each park
- **THEN** the first decision is presented, deciding it parks the parent again on the second, and
  after both the parent continues in the calling state with both results

#### Scenario: Message while parked is answered, not routed

- **WHEN** a person replies to the parked parent
- **THEN** the reply is answered on a tool-less turn and the child's pending decision is unchanged

### Requirement: Static validation of delegation

`archmax validate` SHALL report, for every `archmax_workflow_<slug>` named in a workflow: an
unknown target, a target without a `manual` entry, a self-reference or cycle computed over what
each workflow may call, a chain deeper than the depth bound, and a currently disabled target
(a warning). Whether a call supplies the target's `requires` is not statically knowable and is
enforced at dispatch.

#### Scenario: Unknown target reported

- **WHEN** a state allows `archmax_workflow_nope` and no such workflow exists
- **THEN** `validate` reports an error against that state
