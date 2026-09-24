---
title: Testing workflows
description: Cases are declarative YAML documents with tool mocks and model-scored grades, run by archmax test and interpreted host-side.
sidebar:
  order: 9
---

A workflow's **cases** live under `workflows/<slug>/tests/`. One case is one
`*.test.yaml` (or `*.test.yml`) document of **declarative data**. The runtime
parses it, validates it against a strict schema, then interprets its steps on
the host against the real workflow agent.

The QuickJS sandbox stays *inside* the driven session. There it goes on serving
[lifecycle hooks](/guides/workflow-machine/#lifecycle-hooks-before--after)
and `archmax_run`, unchanged.

Run a suite with `archmax test`:

```bash
archmax test order-lookup             # all cases
archmax test order-lookup requester   # filter by path substring
```

Discovery is recursive under `tests/`, sorted by path, and a case's **id** is
its tests/-relative path minus the extension. These cases are distinct from the
SDK's own unit tests: they exercise *your workflow*, end to end, against a
locally assembled agent.

`archmax test` narrates on **stderr**, in the same visual language as `archmax
run`. It prints a session header, then each case's live state flow under a
dimmed case header. Each case gets a styled verdict line (✔ passed / ✖ failed /
○ skipped), with failure details and grade scores indented, and a closing
summary names the passed, failed, and skipped cases.

**stdout** gets one summary line, or the results as data with `--json`. The
process exits 1 when any case fails, and when a filter matches no case at all.

## Suite configuration

The `tests:` block in `workflow.yaml` configures the suite with declarative
data:

```yaml
tests:
  maxConcurrency: 1
  caseTimeoutMs: 120000     # host-side per-case wall-clock budget
  judge: {}                 # enable grade assertions with the env-configured grading model
```

All three fields are optional:

| Field | What it does |
| --- | --- |
| `maxConcurrency` | Cases run sequentially. Case concurrency is unimplemented, so a value above 1 is rejected loudly. |
| `caseTimeoutMs` | The per-case wall clock the host enforces around a whole case: every step, every assertion. |
| `judge` | Enables `grade` assertions. It may pin a `model` and `modelOptions` (`temperature`, `maxTokens`) over the env-configured default. |

A workflow that declares
[`disabled: true`](/reference/machine-spec/#disabled-take-a-workflow-out-of-service)
runs no cases at all. The suite is reported as **skipped**, one line in place of
the summary, and the process exits **0**, so retiring a workflow keeps a CI run
green. There is no flag to force the cases to run.

`archmax validate` stays fully functional for a disabled workflow, and is the
static feedback in the meantime.

Discovery picks up `*.test.yaml` / `*.test.yml` documents. Anything else in the
tests directory is **ignored without a diagnostic**: a leftover
`tests/tests.config.js`, a `*.test.js` file.

## A case document, annotated

One YAML document is one case. A case is **one conversation on one session**,
and it reads like a script. This is the bundled refund-approval case:

```yaml
# workflows/order-lookup/tests/refund-approved.test.yaml
# `parked` plus both `reachedState` assertions pin the governed path: the
# session may not answer straight through or shortcut past review. The grade
# (threshold 0.7) checks the closing reply tells the customer it is approved.
title: Refund approved after human review   # required — short label, ≤ 60 chars
description: >-             # required — the scenario and what is asserted, ≤ 200 chars
  A refund for delivered ORD-1001 travels refund-request → refund-review and
  parks there with a reply naming the order and its approval; the session succeeds
  once the reviewer approves.
steps:
  # A flat list: actions and assertions are peers. An assertion evaluates
  # against the view of the nearest action above it.
  - send: "Hi, I'm support@acmecorp.com. I'd like a refund for order ORD-1001."
  - parked: true                    # the session parked at a human state
  - reachedState: refund-request    # committed transitions, from the audit trail
  - reachedState: refund-review
  - reply:
      includes: ["ORD-1001", "/approv/i"]   # substrings or /pattern/flags regexes
  - decide:                         # resume the parked session as the reviewer
      to: refund-closed
      comment: "Verified against refund policy, looks correct."
  - succeeded: true
  - grade:                          # model-scored bar — under it, the case fails
      closedQA: >-
        tells the customer their refund for delivered order ORD-1001 is
        approved
      atLeast: 0.7
```

These are the eight top-level keys:

| Key | |
| --- | --- |
| `title` | Required. A short one-line label, **≤ 60 characters**, printed beside the case's verdict. |
| `description` | Required. One or two sentences, **≤ 200 characters**, stating the scenario the case drives and what it asserts. |
| `skip: <reason>` | Yields a skipped verdict; the case drives nothing. |
| `trigger` | Which trigger starts the session (see [start conditions](#start-conditions-trigger-variables-and-workspace)). |
| `variables` | The session's input, seeded locked on every driven turn. |
| `workspace` | Files seeded into the session workspace before any step. |
| `mocks` | Tool-result mocks the driven session sees. |
| `steps` | The flat list of actions and assertions. |

The schema **fails closed**. An unknown top-level key or step key is an error,
raised at `archmax validate` and again before execution, so a typo'd
`reachedstate:` cannot silently pass.

A case file carries no `version` of its own. The authoring surface is versioned
once, by [`runtime.version`](/reference/machine-spec/#runtime) in
`workflow.yaml`.

Both length budgets are enforced. They measure whitespace-collapsed text, so a
folded (`>-`) and a literal (`|`) block of the same prose score alike. Over
budget is an error at `archmax validate` and before execution, just like a
missing field.

Keep longer rationale in a **YAML comment** above the document, as the example
above does: why the case exists, what a particular assertion is really pinning,
how the fixture is wired. There it stays clear of the label the CLI has to fit
on one line.

## Steps: actions and assertions

`steps` is **one flat, sequential list** in which actions and assertions are
peers. Every entry is a single-key mapping. The actions are:

- **`send: "<message>"`**: drive one agent turn with a user message. A second
  `send` in the same case is a second **turn on the same session**: it continues
  in the state the previous turn ended in, and keeps that turn's transcript,
  variables and files. This is exactly what a host's follow-up message does.
- **`decide: { to: <state>, comment? }`**: resume a session parked at a
  [human state](/guides/workflow-machine/#human-in-the-loop-states),
  taking the named transition as the reviewer.
- **`deliver: { trigger, variables? }`**: resume a session parked for input
  with the trigger that arrived (see [below](#driving-a-park-and-resume-flow)).

Every other entry is one of the [assertions below](#assertions). An assertion
evaluates against the view after the **nearest action above it**, and one with
no preceding action is a schema error. That is what preserves temporal structure
in a flat list.

The bundled refund-rejection case asserts `parked` twice, with a trail count
between the two decisions:

```yaml
steps:
  - send: "Hi, I'm support@acmecorp.com. I'd like a refund for order ORD-1001."
  - parked: true
  - decide:
      to: refund-request
      comment: >-
        Please restate the refund amount and confirm the order was delivered
        before it can be approved.
  - parked: true
  - trail:
      to: refund-review
      count: 2
  - decide:
      to: refund-closed
      comment: "The explanation is clear now."
  - succeeded: true
  - reply:
      includes: "ORD-1001"
```

A case is one conversation on one session. There is no multi-session surface.
Per-session isolation is an engine invariant, covered by the SDK's own unit
tests.

## Driving a park-and-resume flow

`deliver` is a step action beside `send` and `decide`. It resumes a session the
agent parked with `archmax_wait`, carrying the trigger that arrived and the
variables it brought, and the session continues in the state it parked in.

`parked: input` pins which suspension channel the session stopped in, so a
session that parked at a human state instead cannot satisfy it. The mapping form
`parked: { channel: input, state: clarify }` also pins *where* it parked. That
form is necessary because parking commits no transition, so `reachedState`
cannot express it.

```yaml
steps:
  - send: "About the thing we discussed on the phone — can you sort it out?"
  # Pin the channel and the state: parking commits no transition, so
  # `reachedState` cannot express where a parked session stopped.
  - parked: { channel: input, state: clarify }
  - deliver:
      trigger: email_reply
      variables: { reply_body: "It's ORD-1001." }
  - succeeded: true
  - triggerArrival: email_reply
  - variables:
      expect: { reply_body: "It's ORD-1001." }
      locked: { reply_body: true }
```

A delivery to a session that is not parked fails the case the way it fails a
host, and halts it. Every later step would otherwise grade a session the case no
longer describes.

The trigger id is required. A park awaits no declared id, so any id is
deliverable and validation leaves this one alone.

## Assertions

Each assertion is a single-key step entry, evaluated against the nearest action
above it. Unknown step keys are errors that name the known ones.

**Every assertion is a hard failure**, `grade` included. The `atLeast` you
declare is the bar, and a score under it fails the case.

Assertions marked **structural** below pin *where the session went* and what it
carries. A failure in one of them [halts the case](#which-assertions-halt-a-case).

| Assertion | Meaning |
| --- | --- |
| `succeeded: true` | **Structural.** The turn completed, without failing or parking. |
| `parked: true` | **Structural.** The turn parked, in either channel. `parked: decision` / `parked: input` pins the channel; `parked: { channel?, state? }` also pins the state it parked in. |
| `reachedState: <state>` | **Structural.** A **committed** (non-trigger) audit-trail step entered the state. The trigger-arrival step does not count. It is recorded before the entry state's `before` hook runs, so a vetoed entry never "reaches" the state. |
| `reply: { includes?, excludes? }` | `includes`: every token must match. `excludes`: none may match (leak checks). Each of `includes`/`excludes` is a single token or a list. A token is a substring or a `/pattern/flags` regex string. Tokens match against the **whole assistant transcript** the session has produced so far. A session that parks often closes with a short "advancing to review" note, while the substantive answer came a message earlier. |
| `calledTool: { name, input? }` | The session recorded a matching tool call. `input` matches partially: declared keys must match, others are ignored. String values of the form `/pattern/flags` match as regexes, which is useful for path fragments; arrays match element-wise. The same matcher decides a mock's `whenInput`. |
| `notCalledTool: { name, input? }` | The session recorded no matching tool call. |
| `blockedTool: { name, input? }` | A matching call was made **and refused by governance**. This is the assertion for testing a guard: a state's `tools.allow` narrowing, or its `skills.allow` set. It is distinct from `notCalledTool`, which also passes when the agent never tried. It is also distinct from a tool that ran and errored. |
| `usedNoTools: true` | The session has recorded no tool calls at all, earlier turns included. |
| `ranWorkflow: { workflow, status?, count? }` | The session dispatched that sub-workflow. It reads the audit trail, so a dispatch a script made counts too. `status` defaults to `ok`. With `count`, exactly that many dispatches must match. Omit it to assert at least one. |
| `trail: { to?, kind?, reason?, count }` | **Structural.** Exactly `count` audit-trail steps match **all** given fields (at least one of `to`/`kind`/`reason` is required). |
| `noTraversal: true` | **Structural.** The trail holds only trigger arrivals: a veto at entry committed no transition. |
| `triggerArrival: <trigger-id>` | **Structural.** Some trail step has `kind: trigger` and that reason, confirming the session started from the declared trigger. |
| `variables: { expect, path?, locked? }` | **Structural.** Every named variable is set to the expected value, by deep equality, so structured values compare by value. `path` addresses into a value per name: `items.-1.sku` is the last element. `locked` asserts the lock state. |
| `grade: { closedQA: <criterion>, atLeast: <0..1> }` | A model scores the turn's **evidence** against a yes/no criterion: its final reply *and* the record of what it did to get there (see [What the grader sees](#what-the-grader-sees)). **`atLeast` decides the outcome**: at or above it passes, below it fails the case. The model's own boolean never overrides your bar. Requires `tests: { judge: … }` in `workflow.yaml`; without it, a `grade` entry records an actionable failure. `judge:` is accepted as a deprecated alias for one release. |

A case seeds the session's input with a top-level `variables:` block. The block
is supplied as the runtime's `variables`, and is therefore locked for every
driven turn.

A trigger carries only an id. `trigger: { id, args }` is an unknown-key error,
and the payload belongs in `variables:`:

```yaml
trigger:
  id: report_requested
variables:
  company: "Acme Corp"
steps:
  - send: "A delayed-orders report was requested."
  - variables:
      expect: { company: "Acme Corp" }
      locked: { company: true }
```

A string of the form `/pattern/flags` is compiled as a regular expression. It is
read that way in three places:

- the tokens of a `reply` entry
- the input values of `calledTool`, `notCalledTool` and `blockedTool`
- a mock's `whenInput`

Anything else matches as a plain substring, or by equality for input values.
Malformed regex strings are **static errors**, caught at validation.

Trail assertions read the session's **audit trail**: the durable, typed record
of committed transitions. Those are trigger arrivals, agent `archmax_advance`
edges, human decisions, and `on_error` routes. The trail is kept in checkpointed
state and written to `sessions/<sessionId>/artifacts/trail.json`.

It accumulates across the turns of the case's session, and each turn begins with
a `trigger` step whose `reason` names the trigger id. So a `trail:` count after
several actions counts the whole accumulated trail. The assistant transcript and
the recorded tool calls accumulate the same way.

The refund-rejection excerpt above uses exactly that. After a refine loop,
`trail: { to: refund-review, count: 2 }` asserts the review state was entered
once on submit and exactly once on resubmit.

### What the grader sees

A `grade` criterion scores the turn's **evidence**. The grading input has two
labelled sections:

1. **What the assistant did, in order**: every assistant message and every
   tool call of the turn, interleaved as they happened, with the runtime's own
   notes among them (a person's decision, a delivered event, an error route).
   Each call carries its input, its output, and its status (`completed`,
   `failed`, `rejected`, `pending`). A call answered by a declared
   [mock](#mocking-tool-results) appears like any other, carrying the mocked
   value, so the grader scores the turn the agent actually experienced.
2. **The final reply to the user**: the turn's last assistant message.

The two are weighed differently, and the prompt says so. A criterion about what
the user was *told* is met only by the final reply, while a criterion about what
the assistant *did* may be met by the record.

That is what lets a behavioural criterion stand on its own, where a `calledTool`
assertion would have to pin an exact input shape:

```yaml
- grade:
    closedQA: looked the order up in the data file before answering
    atLeast: 0.7
```

The evidence is **bounded**, and every reduction is marked in the prompt:

- An oversized tool input, output, or record message is cut at 800 characters
  and marked `…(+N chars)`.
- A record over its 12,000-character budget drops its **oldest** entries behind
  a `… N earlier entries omitted` marker.

The graded reply sits at the end of the turn, so the work nearest it is kept,
and the final reply itself is rendered whole.

The evidence is built from the same turn view the step's other assertions read.
So a `grade` and a `calledTool` on the same step can never disagree about what
the session did.

A grading model that wraps its verdict in prose or a code fence is still read.
One whose reply holds no JSON at all is asked once more, JSON only, before the
turn scores 0.

### Which assertions halt a case

A failed **structural** assertion stops the case where it stands. No further
`send` or `decide` is driven, and no further assertion is evaluated.

Structural assertions are `succeeded`, `parked`, `reachedState`, `trail`,
`noTraversal`, `triggerArrival`, and `variables`, the ones that say where the
session went and what it carries. Once one of them misses, the session is no
longer the one the case describes, so every later step would be driving or
grading the wrong session.

A `decide` after a failed `parked` cannot succeed. A `reply` check after a
failed `reachedState` grades the output of a state the session never entered.

The content assertions let the case carry on: `reply`, `calledTool`,
`notCalledTool`, `blockedTool`, `usedNoTools`, `ranWorkflow`, `grade`. A wrong
reply is a defect in the session, and the session is still the one under test,
so the remaining steps run and still test something real.

A halt is reported as an ordinary failed verdict, naming the assertion that
missed. The steps that never ran are reported too, as `not-executed` (see
below).

Write the structural assertion you depend on *early* in a case. A diverged
session then stops there, before later steps spend model calls.

### Reading a case that stopped early

A case can stop before its steps run out: a structural halt, a thrown action, or
a `caseTimeoutMs` overrun. The assertion steps that never ran are still
reported, each with `status: "not-executed"` and the `steps` index it came from.
They contribute no failures.

That keeps a stopped case honest. An assertion that never ran stays visibly
distinct from one that passed, both in the CLI, which prints an
`N assertions not executed` line, and to any host reading
[the records](/reference/public-api/#what-a-case-reports).

## Mocking tool results

Declarative tool-result mocks pin down what the agent sees:

```yaml
mocks:
  - tool: read_file
    whenInput: { file_path: skills/order-data/assets/orders.json }
    result: "[]"
```

`whenInput` matches partially, through the very same matcher as `calledTool`
input. That matcher is exported as `partialMatch` in `@archmax-ai/harness/testing`.
`/pattern/flags` strings are regexes, and arrays match element-wise.

Declared mocks intercept **both** agent-initiated tool calls and the
programmatic (PTC) calls scripts make inside the driven session. A lifecycle
hook reading `skills/order-data/assets/orders.json` sees the mocked result too.

Mocking is capability-gated. A case that declares `mocks:` against a target that
cannot intercept fails **before the agent runs**, naming
`createToolMockMiddleware()` as the fix.

The default target wires the middleware for you, and a host-supplied target
must [wire it itself](#running-cases-from-a-host). A case that declares no mocks
runs against any workflow-governed target.

## Start conditions: trigger, variables, and workspace

A case declares the conditions its session starts from on the document itself.
Three of them: which [trigger](/guides/triggers/) starts it, what
input it carries, and which files exist in the session workspace before anything
happens:

```yaml
# workflows/order-lookup/tests/triggered-report.test.yaml (excerpt)
title: Delayed-orders report compiled from a trigger
description: >-
  The report_requested trigger starts the session: …
trigger:
  id: report_requested
variables:
  company: "Acme Corp"
steps:
  - send: "A delayed-orders report was requested."
  - succeeded: true
  - triggerArrival: report_requested
```

**`trigger: { id }`** selects the declared start state for **every** driven turn
of the case. There is no per-step trigger, so a follow-up `send` runs under the
same one. Omit it for `manual`.

It is validated against the workflow machine **before any step executes**. An
unknown id fails the case with an error listing the workflow's declared
triggers, even when the case has no steps, and `archmax validate` reports the
same statically. A trigger carries **only** an id: `args` is an unknown key, and
the payload goes in `variables:`.

**`variables: { <name>: <value> }`** is the session's input. It is seeded on
every driven turn as the runtime's `variables`, and is therefore **locked**;
values may be structured.

A seed here is indistinguishable from a production host seed to everything
downstream of it:

- a `${{…}}` reference in a `tools.allow` glob resolves from it
- a state's `requires:` gate is satisfied by it
- a lifecycle hook script reads it in `args.variables`
- `archmax_set_variables` refuses to rewrite it

Recover the real payload from a session that already ran: see
[Authoring a case from a real session](#authoring-a-case-from-a-real-session).

**`workspace: { <path>: <content> }`** seeds input files into the case's
session workspace before any step, mirroring the host convention of
materializing a trigger's payload as a workspace file.

Keys are agent-visible session paths: root-level files like `trigger.json`, or
`scratchpad/…`. Mounts (`skills/…`) and runtime areas are rejected before
anything is written.

String values are written verbatim, other YAML values as JSON, and a value of
the single-key form `{ from: <path> }` copies an existing file (see
[file fixtures](#file-fixtures-from-references)). Reading a seeded file is
still governed: the start state must allow the read tool the agent needs.

Seeding goes through the target runtime's `sessions.seed` handle. A case
declaring workspace files against a target without it fails before the agent
runs.

## Authoring a case from a real session

A trigger carries only an id, so everything a firing passes arrives as
[variables](/guides/workflow-machine/). Those names, shapes and
values live in the host's call site and in the sessions that already ran. Every
governed session records them, so read one:

```bash
archmax sessions                 # ids, status, state, parked state, `vars=` names
archmax sessions <sessionId>     # that session's variables: value + locked state
```

`archmax sessions <id>` reads the session's checkpoint. So it answers for every
session that has run, including one driven by `archmax run`, which emits no run
artifacts. A host that calls `emitRunArtifacts` leaves the same record on disk
at `sessions/<sessionId>/artifacts/variables.json`:

```json
{
  "sessionId": "s-42",
  "workflow": "order-lookup",
  "variables": {
    "trigger": { "value": "report_requested", "locked": true },
    "company": { "value": "Acme Corp", "locked": true },
    "case_id": { "value": "K-9", "locked": false }
  }
}
```

Pick the newest session whose recorded `trigger` matches the trigger the case
drives, then map its store onto the case document:

| Recorded entry | Where it belongs |
| --- | --- |
| `trigger` (always locked) | the case's `trigger: { id: … }`, never an entry in `variables:` |
| any other `locked: true` | the case's `variables:` block: this is the firing's payload |
| `locked: false` | nothing: the agent established it, so **assert** it with `variables: { expect: … }` |

`locked` is the artifact's whole attribution, and it is enough to read it by. A
locked entry came from the host: a `variables` seed, a delivery's seeds, or the
built-in `trigger`. An unlocked one came from the agent's own
`archmax_set_variables`.

Do not copy the whole store into `variables:`, because a case's seeds are
locked. Seeding a name the agent is supposed to establish hides a missing
`archmax_set_variables` call, so the case passes for the wrong reason.

It also makes the agent's own write fail against the lock, so the case exercises
a write production never performs.

The file records the store as the session's **latest** turn left it. Artifacts
are re-written at the end of every turn, including one that parked. That is
another reason to build a case from the locked entries: they are the
turn-invariant part.

With no previous session to read, derive the same facts statically. The `${{…}}`
references in `tools.allow`/`allow_always` and the names in each state's
`requires:` are the variables the workflow depends on. `archmax validate` warns
about a reference nothing guarantees.

The host's own call sites name what production supplies:
`createAgent({ variables })` and `deliver(sessionId, { trigger, variables })`.

## File fixtures: `from:` references

Bulk fixtures live as real files under `tests/`: a `trigger.json` captured from
a previous session, a large orders dump. Any `workspace` entry may take
`{ from: <path> }` as its value, pointing at such a file. The path resolves
relative to the workflow's `tests/` directory:

```yaml
workspace:
  trigger.json: { from: triggered-report/trigger.json }   # a directory of this case's own
  orders.json: { from: shared/acme-orders.json }          # a fixture shared between cases
```

Every seed is declared in the case. A directory that no case references is
silently ignored, since naming convention copies nothing in. The fail-closed
rules:

- A `from:` path that escapes `tests/` or names a missing file fails the case
  before any step runs, and `archmax validate` reports both statically.
- A seeded file and an inline `workspace:` entry cannot target the same path.
  YAML itself refuses a duplicate key.

## No predicate escape hatch

There is deliberately no arbitrary-predicate assertion in the YAML format.
Bespoke logic belongs in vitest unit tests against the engine, or in a
[lifecycle hook](/guides/code-interpreter/#lifecycle-hooks),
which is plain JavaScript returning `ok()` or `veto(reason)`.

## Running cases from a host

A host embedding the SDK runs these cases too, calling
[`runTests`](/reference/public-api/#runtests-cases-from-a-host)
directly. Its agent is assembled differently from the CLI's, so it supplies
three extra things:

- **`authoring`**, the backend the suite itself is read from: the spec, the
  case documents, their `from:` fixtures. It defaults to the local filesystem
  under `rootDir`. A host whose authored tree lives in a store must name that
  store here for discovery to find its cases.
- **`createTarget`**, the agent under test: a built workflow-governed runtime
  or a factory. Cases then run against the host's real assembly: mounts,
  connection tools, session store, checkpointer. Such a target must wire
  `createToolMockMiddleware()` itself. A case that declares `mocks:` against a
  target that cannot intercept is refused loudly before the agent runs.
- **`sessionIdForCase`**, which names the agent session a case runs on, given
  the case file's path. A case is one conversation on one session. Naming it
  makes the case's checkpoints, artifacts, and token usage addressable from the
  host's own records. Whatever id is used is reported back on
  `CaseResult.sessionId`.

`runTests` returns data and prints nothing. The CLI's test view is one renderer
of its `CaseResult`s, and a host's reporter is another. Its two halves,
`discoverCases` and `runCase`, are exported for a host that schedules cases
itself.

The `sandboxRuntime` option is forwarded only to the agent under test. It covers
that agent's lifecycle hooks and `archmax_run` sources. Case documents themselves
are interpreted on the host. Everything above this section holds either way: the
same files, the same schema, the same verdicts.

### Reading a case that died partway

A case can also die outright, when an action throws or the case blows its
`caseTimeoutMs` budget. It still reports every record produced up to that point,
each carrying the `steps` index it came from, and the steps after it as
`not-executed`.

The failures list the terminating error **first**, followed by anything those
records had already missed. So a case that failed an assertion at step 3 and
then died at step 5 shows both, in that order.

The difference from a [halt](#which-assertions-halt-a-case) is the `error`
field. A case that died sets it; a case that halted leaves it unset. A halt is a
verdict the case reached, while an error is a failure of the machinery running
it.

See
[what a case reports](/reference/public-api/#what-a-case-reports)
for the record shape.
