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

A dispatch SHALL run the target as a separate session with id `<parent>~<n>`, `n` the dispatch's
number in the parent session (see "A child's id is its dispatch number in the session"),
in the configured session store with its own checkpoints, artifacts and `scratchpad/`, and
with the parent session id recorded on it. Its variable store SHALL contain exactly the built-in
`trigger` (`manual`) and the call's arguments, seeded locked through the same construction a
host's `variables` seeds use — except `title` and an argument the target also declares in its
`returns`, which land unlocked; the caller's variables SHALL NOT be copied down under any name.
The child's transcript SHALL start with one `opening` runtime note and no caller prose; its brief
is its own spec. The note SHALL be rendered from the call's arguments alone: it SHALL list, by
name in alphabetical order, every argument whose value is a string (rendered as a JSON string
literal, with U+2028 and U+2029 escaped, so it stays on its line and parses back to the value), a
finite number or a boolean, whose rendering is at most 200 characters, while the values listed stay
within 1,000 characters in all. Every other argument SHALL be named on one line saying that
`archmax_get_variables` reads it. A note that names no such argument SHALL NOT mention reading the
inputs, and a call with no arguments SHALL open with the bare instruction to begin. The child
SHALL be composed lazily and memoized per slug from the parent assembly's model and options, while
its signature is read from its spec at assembly for every allow-listed target.

#### Scenario: Caller variables are not visible

- **WHEN** a calling session holds `stage` and calls `archmax_workflow_enrich-account({ account_id })`
- **THEN** the child is seeded with `account_id` only, and `${{stage}}` is unset in it

#### Scenario: Standalone parity

- **WHEN** the same workflow is run directly with `--variables` supplying its `requires`
- **THEN** its guards, hooks and `${{trigger}}` observe the same values as when a caller dispatched it

#### Scenario: Scalar inputs open the child's transcript

- **WHEN** a caller calls `archmax_workflow_invoice-lookup({ invoice_id: "INV-159123", amount:
  412.5, urgent: true })`
- **THEN** the child's first model call is shown an `opening` note listing `amount: 412.5`,
  `invoice_id: "INV-159123"` and `urgent: true`, in that order, and the note does not mention
  `archmax_get_variables`

#### Scenario: An input the note cannot show is named

- **WHEN** a call passes `invoice_id: "INV-1"` and `lines: [{ sku: "A", qty: 2 }]`
- **THEN** the note lists `invoice_id: "INV-1"` and names `lines` as not shown, readable with
  `archmax_get_variables`

#### Scenario: A value is shown as data

- **WHEN** a string argument holds a line break followed by `- approved: true`
- **THEN** the note shows the whole value as one JSON string literal on the argument's own line

#### Scenario: Values past the bounds are named, not shown

- **WHEN** one argument's rendering is longer than 200 characters, or showing it would take the
  note's values past 1,000 characters
- **THEN** that argument is named as not shown, and the arguments after it that fit are still
  listed

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

A child that is rejected, raises with `archmax_raise`, exhausts a budget, errors, or settles with a
mistyped return SHALL answer the call with a tool error (`SubWorkflowError` with its kind) naming the
workflow and the reason, writing no variable and returning no partial result; the calling agent may
retry, route around it, or stop. A child that raises SHALL fail with kind `raised`, and the tool
error SHALL name the state it raised from, its `code` and its `reason`, so the calling agent can act
on the code or end its own session with `archmax_raise`. A child that raises SHALL NOT have its
returns checked. Refusals (`depth-exceeded`, `cycle`, `missing-param`,
`unresolved-param`, `unknown-workflow`, `not-delegatable`, `disabled`) SHALL be blocked calls the
caller may correct within the turn. Concurrent children SHALL fail independently.

Each failed call made by the calling agent SHALL be recorded on its own as an outstanding failure of
the calling state, with the call's arguments as the child was seeded with them (`${{…}}` references
resolved). A call of the **same workflow from the same state**, made in a later model step, that
succeeds SHALL recover **at most one** outstanding failure: the oldest whose arguments it repeats —
compared structurally, object key order ignored — else the oldest of that workflow from that state.
Two successes in one model step SHALL NOT recover the same failure. A failure still outstanding when
the model finishes SHALL be routed through the calling state's `on_error`, or end the turn rejected
without one, and the route SHALL name every outstanding failure with the arguments of its call. A
success of another workflow, a sibling call in the same tool batch, and a rejection with another
cause SHALL NOT recover any failure; whatever clears a committed rejection — a successful
transition, a park, a reset, a raise, a new turn — SHALL clear outstanding failures too. A script's
call answers its script and records no failure on the state. The delegation tool's description
SHALL say that a failed call fails the calling state when the agent finishes, unless a later call of
the same workflow from the same state succeeds, and that each success recovers one failed call.

#### Scenario: Rejected child answers its own call

- **WHEN** two children run concurrently and one is vetoed by its hook
- **THEN** that call receives the tool error and the other call's result is unaffected

#### Scenario: A child that raises fails the call with its code

- **WHEN** a child declaring `returns: [enrichment_file]` calls `archmax_raise({ code:
  "customer-unknown", reason: "No customer matches the id." })` before setting `enrichment_file`
- **THEN** the caller's tool call is answered with a tool error of kind `raised` naming the child
  workflow, the state, `customer-unknown` and the reason; no returns are reported; and the
  caller's `sub-workflow-result` event and `sub-workflow` trail step settle `error`

#### Scenario: A retry that succeeds recovers the failure

- **WHEN** a terminal calling state declaring `on_error: failed` calls `enrich`, the child raises,
  the agent calls `enrich` again from the same state, that child completes, and the agent finishes
- **THEN** the session completes in the calling state, no `state-error-routed` is emitted, and the
  trail records both `sub-workflow` steps, `error` then `ok`

#### Scenario: Another workflow's success recovers nothing

- **WHEN** the call to `enrich` fails and a later call to `audit` from the same state succeeds
- **THEN** the failure of `enrich` routes through `on_error` when the agent finishes

#### Scenario: One retry of two parallel failures still routes the other

- **WHEN** one tool batch calls `enrich` for `ORD-1` and for `ORD-2`, both children fail, and a later
  call of `enrich` for `ORD-1` succeeds
- **THEN** `ORD-1`'s failure is recovered, and when the agent finishes the session routes through
  `on_error` with a reason naming `ORD-2`'s call and not `ORD-1`'s

#### Scenario: Retrying both parallel failures completes

- **WHEN** both of those calls are retried in a later step, for `ORD-1` and `ORD-2`, and both
  succeed
- **THEN** both failures are recovered and the session completes without routing

#### Scenario: A corrected retry recovers one failure, never two

- **WHEN** the failed call was for `ORD-1` and a later call for `ORD-1b` succeeds
- **THEN** the failure is recovered and the session completes; but when two calls had failed, that
  one success recovers only the oldest, and the other still routes

#### Scenario: Two children failing in one batch both route

- **WHEN** one tool batch calls `enrich` for `ORD-1` and for `ORD-2` and both children fail
- **THEN** the turn does not crash, both failures are recorded, and the one `on_error` route names
  both calls

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

### Requirement: A child session is not asked to name itself

A child session's prompt SHALL NOT ask it to set the reserved `title`: its title would describe a
session nothing lists, and `returns` cannot carry it. The platform layer of a child's system
prompt SHALL leave out every passage between a line `<!-- top-level-only -->` and a line
`<!-- /top-level-only -->` (surrounding whitespace ignored); the bundled platform prompt SHALL mark
its "Name the run first" step and its "Naming the run" paragraph that way. Where a left-out
passage held items of an ordered list, the items after it in that list SHALL be renumbered. A
top-level session SHALL read the passages with only the marker lines removed, so its system
prompt and its cacheable prefix are what they were before the markers existed; the marker lines
SHALL reach no model. A workspace's platform-prompt override SHALL be read by the same rule, and
an override without markers SHALL read the same in both sessions. An opening marker with no
closing marker SHALL leave the text after it in place for both. A child's
`archmax_set_variables` description SHALL leave out the sentence asking for a title; a top-level
session's description SHALL be unchanged. A child's `title` SHALL NOT be seeded by the runtime; a
caller that passes `title` as an argument seeds it unlocked, as before.

#### Scenario: The child goes straight to its work

- **WHEN** a caller dispatches a one-state child whose inputs are scalars
- **THEN** the child's first model call is handed a system prompt whose movement list begins
  `1. Do the current state's work.` and which never mentions `title`, and an
  `archmax_set_variables` description that does not mention `title`

#### Scenario: The caller's prompt is unchanged

- **WHEN** the same caller's model calls run before and after the child's
- **THEN** each carries the step `1. **Name the run first.**`, the "Naming the run" paragraph and
  the `title` sentence in `archmax_set_variables`' description, no marker line, and a platform
  layer byte-identical across both calls

#### Scenario: An override keeps its markers' meaning

- **WHEN** a workspace's override marks one item of a numbered list `top-level-only`
- **THEN** a child's prompt leaves the item out and renumbers the items after it, and a top-level
  session's prompt keeps it with the marker lines removed

#### Scenario: An override without markers reads the same

- **WHEN** a workspace's override carries no marker
- **THEN** a child session and a top-level session read it identically

#### Scenario: A child emits no title of its own

- **WHEN** a child completes without its caller passing `title`
- **THEN** the child session holds no `title` variable and no `title-set` event carries its
  dispatch id

### Requirement: The call answers with the child's returns and the closing message

A completed child SHALL answer its tool call with `{ message, returns }` when the target declares
`returns`, and with the closing message alone otherwise. `returns` SHALL carry every declared return,
each the child set conforming to its declared type. A child that finished with some declared returns
unset SHALL still complete the call — it is not handed back for another attempt — and `returns` SHALL
carry each unset name empty, as `null` (never left out, never `undefined`), and also `note`, reading
`Not all return variables were set by the sub-workflow: '<name>', … was not set.` / `were not set.`,
naming every unset one. Whether a return is set SHALL be decided only as the child settles: no state
of the child is held for one, and an argument seeding one lands unlocked (see `runtime`). A declared return holding a value
that does not conform to its type SHALL fail the call with kind `invalid-return` naming the state,
the variable and the type, and no partial result SHALL reach the caller then. `note` SHALL be reserved: a trigger's `returns` may not declare it. A
mocked dispatch SHALL be held to the same rule. Nothing else SHALL cross back: the child's transcript,
trail and every other variable are discarded when it settles. Nothing captures the answer into a
caller variable; an agent that needs one sets it with `archmax_set_variables`, a script writes the
value it received, and the calling state's `requires:` is the guarantee. The delegation tool's
description SHALL say that a run finishing without some returns answers with those empty (`null`)
and a `note` naming them.

#### Scenario: Returns delivered by name

- **WHEN** a target declaring `returns: [enrichment_file, delayed]` completes with both set
- **THEN** the caller's tool result carries both under `returns` beside the closing `message`, and no `note`

#### Scenario: A child short of its returns answers with the rest empty and a note

- **WHEN** a target declaring `returns: [enrichment_file, delayed]` finishes with only
  `enrichment_file` set
- **THEN** the call succeeds at once, with no further model call in the child, and `returns` is
  `{ enrichment_file, delayed: null, note: "Not all return variables were set by the sub-workflow: 'delayed' was not set." }`

#### Scenario: A child that set none answers with every return empty and the note

- **WHEN** a target declaring `returns: [enrichment_file]` finishes without setting it
- **THEN** `returns` is `{ enrichment_file: null, note: "Not all return variables were set by the sub-workflow: 'enrichment_file' was not set." }`
  and the caller's state is not failed

#### Scenario: A child whose typed return does not conform fails closed

- **WHEN** a target declares `returns: [{ name: delayed, type: boolean }]` and its child finishes
  with `delayed` holding `"no"`
- **THEN** it settles rejected with kind `invalid-return` naming the state, `delayed` and
  `boolean`, and no partial result reaches the caller

#### Scenario: note cannot be declared

- **WHEN** a trigger declares `returns: [note]`
- **THEN** the spec fails to load, saying `note` is reserved in `returns`

### Requirement: A child's file space is its own

A child session's workspace SHALL be its own session zone. The child SHALL read and write only
its own `scratchpad/`, never its caller's, and nothing the child writes SHALL appear in the
caller's workspace. The only files that reach a caller SHALL be copies of the child's declared
`file` returns, made by the runtime when the child settles. Every other file the child wrote
stays in the child's session.

#### Scenario: A child's write stays in the child

- **WHEN** a child writes `scratchpad/notes.md` and `scratchpad/out/summary.txt` and completes
- **THEN** both files are in the child's session, and the caller's workspace holds neither

#### Scenario: A child cannot reach its caller's files

- **WHEN** the caller holds `scratchpad/secret.txt` and the child reads `scratchpad/secret.txt`
- **THEN** the child's read resolves against its own session and finds nothing there

#### Scenario: A child cannot overwrite its caller's files

- **WHEN** the caller and its child each write `scratchpad/result.json`
- **THEN** each session holds its own `scratchpad/result.json`, and the caller's is unchanged by
  the child's write

### Requirement: A file argument is copied into the child

Before a child starts, the runtime SHALL copy each `file` argument's exact bytes from the
caller's workspace into the child's `scratchpad/attachments/`, keeping the file name, and seed
the child with the child-side path. Two arguments sharing a file name SHALL be kept apart by the
attachment naming rule (see `workspace-and-sessions`). An argument naming no file SHALL be
refused `invalid-param` before any child runs.

#### Scenario: The child is seeded with its own copy

- **WHEN** the caller holds `scratchpad/inbox/invoice.pdf` and calls
  `archmax_workflow_reconcile({ invoice: "scratchpad/inbox/invoice.pdf" })`
- **THEN** the child's session holds `scratchpad/attachments/invoice.pdf` with identical bytes,
  the child's `invoice` variable reads `scratchpad/attachments/invoice.pdf`, and its `opening`
  note shows that path

#### Scenario: The child's copy is independent

- **WHEN** the child edits or removes `scratchpad/attachments/invoice.pdf`
- **THEN** the caller's `scratchpad/inbox/invoice.pdf` is unchanged

#### Scenario: Two arguments with one file name

- **WHEN** a target declares `requires: [{ name: current, type: file }, { name: previous, type:
  file }]` and the call passes `scratchpad/2026/statement.pdf` and `scratchpad/2025/statement.pdf`
- **THEN** the child is seeded with `current` = `scratchpad/attachments/statement.pdf` and
  `previous` = `scratchpad/attachments/statement-1.pdf`, in declaration order

#### Scenario: An argument naming no file is refused

- **WHEN** the call passes `invoice: "scratchpad/inbox/missing.pdf"` and the caller holds no such
  file
- **THEN** the call is refused as a blocked call with kind `invalid-param` naming `invoice`, `file`
  and the path, and no child session is created

#### Scenario: An authored file is copied like a session file

- **WHEN** the call passes `template: "skills/billing/assets/template.pdf"`, a mounted file the
  calling state may read
- **THEN** the child's session holds `scratchpad/attachments/template.pdf` with identical bytes
  and the child is seeded with that path

#### Scenario: A reference resolves before the copy

- **WHEN** a script calls `tools.archmaxWorkflowReconcile({ invoice: "${{invoice_path}}" })` and
  the caller holds `invoice_path: "scratchpad/inbox/invoice.pdf"`
- **THEN** that file is copied into the child exactly as for a literal path

### Requirement: A file argument is read with the calling state's governance

A `file` argument SHALL be a `read` path argument of its delegation tool, so the kernel rules for
reading a path, and a `paths:` guard on an allow or forbid entry naming that tool, bind it as
they bind any declared path argument. A call the kernel blocks for its path SHALL copy nothing
and start no child.

#### Scenario: A paths guard narrows what may be passed

- **WHEN** a state allows `{ tool: archmax_workflow_reconcile, paths: ["scratchpad/inbox/**"] }`
  and the agent calls it with `invoice: "scratchpad/private/payroll.pdf"`
- **THEN** the call is blocked naming the rule, nothing is copied, and no child runs

### Requirement: A file return is copied back under a name nothing holds

When a child settles, the runtime SHALL copy each `file` return it set from the child's session
into the caller's `scratchpad/attachments/` and hand the caller that path in `returns`. The copy
SHALL take a name nothing in that folder holds, by the attachment naming rule, so a returned file
never overwrites a file of the caller's, one an earlier or concurrent call returned included. A
return that can't be copied SHALL fail the call `invalid-return`.

#### Scenario: A returned file arrives as the caller's own

- **WHEN** a child declaring `returns: [{ name: report, type: file }]` settles with `report` =
  `scratchpad/out/report.pdf`
- **THEN** the caller's session holds `scratchpad/attachments/report.pdf` with identical bytes, the
  call's `returns.report` reads `scratchpad/attachments/report.pdf`, and the child's own file stays
  in the child's session

#### Scenario: A second call does not overwrite the first

- **WHEN** the caller calls the same workflow again and that child also returns a file named
  `report.pdf`
- **THEN** the second copy lands at `scratchpad/attachments/report-1.pdf`, its call answers that
  path, and `scratchpad/attachments/report.pdf` is unchanged

#### Scenario: Concurrent calls take distinct names

- **WHEN** one tool batch, or a script's `Promise.all`, runs three calls whose children each return
  `report.pdf`
- **THEN** the caller ends with `report.pdf`, `report-1.pdf` and `report-2.pdf` in
  `scratchpad/attachments/`, each call's `returns.report` names a different one of them, and each
  holds the bytes its own child returned

#### Scenario: A file the caller already holds is kept

- **WHEN** the caller's agent wrote `scratchpad/attachments/report.pdf` itself before the call
- **THEN** the returned copy lands at `scratchpad/attachments/report-1.pdf` and the agent's file is
  unchanged

#### Scenario: A return whose file is gone fails the call

- **WHEN** a child set `report` while the file existed and then removed it before settling
- **THEN** its own completion check rejects it, the call fails with kind `invalid-return` naming
  `report` and `file`, and nothing is copied

#### Scenario: A child cannot return a file its ancestors denied

- **WHEN** the root workflow declares `skills: { forbid_always: [billing] }` and its child's agent
  sets its `file` return to `skills/billing/assets/salaries.md`
- **THEN** the child's write is refused as naming a path the session may not read, the call
  answers with a `note` naming the unset return, and nothing is copied into the caller; a value
  written by a script or hook instead is rejected by the child's completion check, and the call
  fails with kind `invalid-return`

#### Scenario: A child may return an authored file

- **WHEN** a child sets its `file` return to `skills/billing/assets/template.pdf`, which no
  ancestor denies
- **THEN** the caller receives a copy at `scratchpad/attachments/template.pdf`

#### Scenario: An unset file return copies nothing

- **WHEN** a child declaring `returns: [{ name: report, type: file }, total]` settles with only
  `total` set
- **THEN** the call answers `total` and a `note` naming `report`, and nothing is copied

#### Scenario: A child that parked copies back when it settles

- **WHEN** a child parks at a human state, the parent is decided, and the child then settles with
  a `file` return
- **THEN** the file is copied into the parent's `scratchpad/attachments/` at that settle by the
  same rule, and the `sub-workflow` note appended to the parent's transcript carries the child's
  returns beside its closing message, the parent-side path among them

#### Scenario: A mocked file return is held to the same rule

- **WHEN** a case seeds `scratchpad/fixtures/report.txt` through `workspace:` and mocks the
  dispatch with `returns: { report: "scratchpad/fixtures/report.txt" }`
- **THEN** the call answers `report` = `scratchpad/attachments/report.txt`, a copy of the fixture;
  a mock naming no file fails the call with kind `invalid-return`

### Requirement: The delegation tool says how files cross

When a target's `manual` signature declares a `file` entry, its delegation tool's description
SHALL say that a `file` argument is a path in the caller's workspace that the child receives as
its own copy, and that a `file` return arrives as a copy in the caller's
`scratchpad/attachments/` whose path the result names. A target with no `file` entry SHALL have
its description unchanged.

#### Scenario: The description names the file convention

- **WHEN** the target declares `requires: [{ name: invoice, type: file }]`
- **THEN** the tool's description says the child receives its own copy of the file `invoice`
  names, and the input schema describes `invoice` as `{ type: string, format: file }`

#### Scenario: A target without files reads as before

- **WHEN** the target declares only `string` and `date` entries
- **THEN** the tool's description is byte-identical to what it was before `file` existed

### Requirement: A failed call names the caller's file paths

A failed call SHALL be recorded, and named in its `on_error` route, with each `file` argument as
the caller passed it (references resolved), not as the child-side path the child was seeded with.
Recovering a failure SHALL compare the caller's paths.

#### Scenario: The route names the path the caller passed

- **WHEN** a call passing `invoice: "scratchpad/inbox/invoice.pdf"` fails and the agent finishes
- **THEN** the `on_error` route names the call with `invoice: "scratchpad/inbox/invoice.pdf"`,
  not `scratchpad/attachments/invoice.pdf`

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

### Requirement: A child's id is its dispatch number in the session

A child session's id SHALL be `<parent session id>~<n>`, where `n` numbers the parent session's
dispatches from 1 across all its turns; a grandchild SHALL be `<parent>~<n>~<m>`. The count SHALL be
part of the parent session's checkpointed state (`dispatchCount`), never process memory. A dispatch
SHALL take its number when it is made and record it as the pending delegation's `identity`, and
resume SHALL read the recorded identity as it is, never re-deriving it.

#### Scenario: Dispatches number across turns on fresh agents

- **WHEN** two turns of one session, each on a fresh `createAgent`, dispatch the same workflow from
  the same state
- **THEN** the children are `<session>~1` and `<session>~2`, each with its own thread and its own
  folder

#### Scenario: A parent resumes on the child it parked on

- **WHEN** a parent parked on child `~2` is decided on a fresh `createAgent`
- **THEN** the decision reaches `~2`, and `~1` is untouched

### Requirement: A batch's dispatches are numbered in tool-call order

The model's delegation calls in one tool batch SHALL be numbered in tool-call order from the count
the step read, so a node replayed from its checkpoint gives each call the same number, and so the
same child. A call refused before its child runs SHALL keep the number it took. A script's or a
hook's dispatch SHALL take the next number above the step's count and the batch's calls, and the
count it leaves SHALL be committed with the tool call or model step that made it.

#### Scenario: A batch is numbered in tool-call order

- **WHEN** three delegation calls are made in parallel in one batch
- **THEN** they get `1`, `2` and `3` in tool-call order, and replaying that node gives them the same
  three ids

#### Scenario: A script numbers above the batch

- **WHEN** one batch holds a script that dispatches and a model's delegation call
- **THEN** the model's call gets `1`, the script's dispatch `2`, and the next turn's first dispatch
  `3`

### Requirement: A dispatch is named by its path below the root

A dispatch's `dispatchId` SHALL be the child's session id with the root session's id and its
separator taken off: `1`, `2`, and `1~1` for the first dispatch made inside `1`. The
`sub-workflow-*` events, a pending delegation and the child's session id SHALL name a child the same
way. `parentSessionIdOf` and `isChildSessionOf` SHALL read `~` and a number from 1 as a child, and
SHALL still read the 0.5 shape (`<state>:<workflow>:<ordinal>`) as one, which nothing mints.

#### Scenario: A grandchild is named by its path

- **WHEN** child `1` makes its first dispatch
- **THEN** the grandchild's session id is `<root>~1~1`, its dispatch id is `1~1`, and its
  `sub-workflow-start` event carries `1` as the dispatch it was emitted inside

#### Scenario: A park from before the upgrade resumes

- **WHEN** a parent parked before the upgrade, its pending delegation recording the identity
  `start:enrich:0`, is decided
- **THEN** the child `<parent>~start:enrich:0` is resumed under that identity and completes
