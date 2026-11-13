---
title: Testing workflows
description: Cases are declarative YAML documents with tool mocks and model-scored grades, run by archmax test and interpreted host-side.
sidebar:
  order: 9
---

A workflow's **cases** live under `workflows/<slug>/tests/`. One case is one `*.test.yaml` (or
`*.test.yml`) document of declarative data: one conversation on one session, driven end to end
against the real workflow agent. The runtime parses it, validates it against a strict schema, then
interprets its steps on the host. Code states' scripts, `archmax_eval` and `archmax_run` still run
in the sandbox inside the driven session.

Run a suite with `archmax test`:

```bash
archmax test order-lookup             # all cases
archmax test order-lookup requester   # filter by path substring
```

Discovery is recursive under `tests/` and sorted by path, and a case's **id** is its
`tests/`-relative path minus the extension. Anything in the directory that is not a
`*.test.yaml` or `*.test.yml` document, such as a leftover `tests.config.js` or a `*.test.js`
file, is ignored without a diagnostic.

`archmax test` narrates on **stderr**, in the same visual language as `archmax run`: a session
header, then each case's live state flow under a dimmed case header, a verdict line (✔ passed,
✖ failed, ○ skipped) with failure details and grade scores indented, and a closing summary.
**stdout** gets one summary line, or the results as data with `--json`. The process exits 1 when
any case fails, and when a filter matches no case.

## A case document, annotated

A case reads like a script. This is the reference workspace's refund-approval case:

```yaml
# workflows/order-lookup/tests/refund-approved.test.yaml
# `parked`, `reachedState` and the `trail` step pin the governed path: the
# session may not answer straight through or shortcut past review, and only the
# check-refund code state may hand the decision to the reviewer. The grade
# (threshold 0.7) checks the closing reply tells the customer it is approved.
title: Refund approved after human review   # required — short label, ≤ 60 chars
description: >-             # required — the scenario and what is asserted, ≤ 200 chars
  A refund for delivered ORD-1001 travels refund-request → refund-review and
  parks there with a reply naming the order and its approval; the session
  succeeds once the reviewer approves.
steps:
  # A flat list: actions and assertions are peers. An assertion evaluates
  # against the view of the nearest action above it.
  - send: "Hi, I'm support@acmecorp.com. I'd like a refund for order ORD-1001."
  - parked: true                    # the session parked at a human state
  - reachedState: refund-request    # committed transitions, from the trail
  - trail:                          # the check-refund code state moved it into review
      to: refund-review
      kind: code
      count: 1
  - reply:
      includes: ["ORD-1001", "/approv|eligib/i"]   # substrings or /pattern/flags regexes
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

The top-level keys:

| Key | |
| --- | --- |
| `title` | Required. A one-line label, **≤ 60 characters**, printed beside the case's verdict. |
| `description` | Required. One or two sentences, **≤ 200 characters**, stating the scenario the case drives and what it asserts. |
| `skip: <reason>` | Yields a skipped verdict; the case drives nothing. |
| `trigger` | Which trigger starts the session (see [start conditions](#start-conditions-trigger-variables-and-workspace)). |
| `variables` | The session's input, seeded locked on every driven turn. |
| `workspace` | Files seeded into the session workspace before any step. |
| `mocks` | Tool-result mocks the driven session sees. |
| `clock` | The date and time every model call of the case states as "now" (see [cases and the date](#cases-and-the-date)). |
| `steps` | The flat list of actions and assertions. |

The schema **fails closed**. An unknown top-level key or step key is an error, raised at
`archmax validate` and again before execution, so a mistyped `reachedstate:` cannot silently pass.
Both length limits are enforced the same way. They measure whitespace-collapsed text, so a folded
(`>-`) and a literal (`|`) block of the same prose score alike.

Keep longer rationale in a **YAML comment** above the document, as the example does: why the case
exists, what an assertion is really pinning, how the fixture is wired. There it stays clear of the
label the CLI has to fit on one line.

A case file carries no `version` of its own. The authoring surface is versioned once, by
[`runtime.version`](/reference/machine-spec/#runtime) in `workflow.yaml`.

## Steps: actions and assertions

`steps` is **one flat, sequential list** in which actions and assertions are peers. Every entry is
a single-key mapping. The actions are:

- **`send: "<message>"`** drives one agent turn with a user message. A second `send` is a second
  **turn on the same session**: it continues in the state the previous turn ended in and keeps that
  turn's transcript, variables and files, exactly as a host's follow-up message does.
- **`decide: { to: <state>, comment? }`** resumes a session parked at a
  [human state](/guides/workflow-machine/#human-in-the-loop-states), taking the named transition as
  the reviewer.
- **`deliver: { trigger, variables? }`** resumes a session parked for input with the trigger that
  arrived (see [below](#driving-a-park-and-resume-flow)).

Every other entry is one of the [assertions](#assertions). An assertion evaluates against the view
after the **nearest action above it**, and one with no action above it is a schema error. That is
what keeps the order of events in a flat list.

The reference workspace's refund-rejection case asserts `parked` twice, with a trail count between
the two decisions:

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

The trail accumulates across the session's turns, so `trail: { to: refund-review, count: 2 }`
asserts the review state was entered once on submit and exactly once on resubmit. There is no
multi-session surface: per-session isolation is an engine invariant, covered by the SDK's own unit
tests.

## Start conditions: trigger, variables, and workspace

A case declares the conditions its session starts from on the document itself: which
[trigger](/guides/triggers/) starts it, what input it carries, and which files exist before
anything happens.

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

**`trigger: { id }`** selects the start state for **every** driven turn of the case; a follow-up
`send` runs under the same one. Omit it for `manual`. It is validated against the workflow
**before any step executes**: an unknown id fails the case with the workflow's declared triggers
listed, even when the case has no steps, and `archmax validate` reports the same statically. A
trigger carries **only** an id. `trigger: { id, args }` is an unknown-key error, and the payload
belongs in `variables:`.

**`variables: { <name>: <value> }`** is the session's input. It is seeded on every driven turn as
the runtime's `variables`, so it is **locked**, and values may be structured. A seed here is
indistinguishable from a production host seed:

- a `${{…}}` reference in a `tools.allow` glob resolves from it;
- a state's `requires:` gate is satisfied by it;
- a code state's script and a grader read it among the variables;
- `archmax_set_variables` refuses to rewrite it.

To recover a real payload from a session that already ran, see
[authoring a case from a real session](#authoring-a-case-from-a-real-session).

**`workspace: { <path>: <content> }`** seeds input files into the session workspace before any
step, as a host materializes a trigger's payload as a workspace file. Keys are agent-visible
session paths: root-level files like `trigger.json`, or `scratchpad/…`. Mounts (`skills/…`) and
runtime areas are rejected before anything is written. String values are written verbatim, other
YAML values as JSON, and `{ from: <path> }` copies an existing file (see
[file fixtures](#file-fixtures-from-references)). Reading a seeded file is still governed: the
start state must allow the read tool the agent needs.

Seeding goes through the target runtime's `sessions.seed` handle, so a case declaring workspace
files against a target without it fails before the agent runs.

## Assertions

Each assertion is a single-key step entry, evaluated against the nearest action above it. An
unknown step key is an error that names the known ones. **Every assertion is a hard failure**,
`grade` included: the `atLeast` you declare is the bar, and a score under it fails the case.

Assertions marked **structural** pin *where the session went* and what it carries. A failure in one
of them [halts the case](#which-assertions-halt-a-case).

| Assertion | Meaning |
| --- | --- |
| `succeeded: true` | **Structural.** The action's outcome is `completed`: the turn did not park, raise, fail or end rejected. A failed tool call the agent recovered from does not fail it. A failure says why: the session is parked, the turn did not complete, or the code and reason it raised with `archmax_raise`. |
| `parked: true` | **Structural.** The turn parked, in either channel. `parked: decision` / `parked: input` pins the channel; `parked: { channel?, state? }` also pins the state it parked in. |
| `raised: true` | **Structural.** The turn ended with `archmax_raise`: the agent's, a grader's or a code state's. `raised: <code>` pins the code exactly. `raised: { code?, reason? }` pins the code and matches the reason, exactly or as a regex when written `/pattern/flags`. A miss names the code that was raised, or says the session did not raise. |
| `reachedState: <state>` | **Structural.** A **committed** (non-trigger) trail step entered the state, whoever made the move: the agent, a person, a grader or a code state. The trigger-arrival step does not count, so a session reaches its start state only by moving into it. |
| `reply: { includes?, excludes? }` | `includes`: every token must match. `excludes`: none may match (leak checks). Each is a single token or a list, and a token is a substring or a `/pattern/flags` regex. Tokens match against the **whole assistant transcript** so far, because a session that parks often closes with a short "advancing to review" note after the substantive answer. |
| `calledTool: { name, input? }` | The session's agent recorded a matching tool call in the transcript. A grader's and a code state's calls are not in it, so they never match. `input` matches partially: declared keys must match, others are ignored. String values of the form `/pattern/flags` match as regexes, and arrays match element-wise. The same matcher decides a mock's `whenInput`. |
| `notCalledTool: { name, input? }` | The session recorded no matching tool call. |
| `blockedTool: { name, input? }` | A matching call was made **and refused by governance**: the assertion for testing a guard, such as a state's `tools.allow` narrowing or its `skills.allow` set. `notCalledTool` also passes when the agent never tried, and neither is a tool that ran and errored. |
| `usedNoTools: true` | The session's agent has recorded no tool calls at all, earlier turns included. A grader's or a code state's calls do not count. |
| `ranWorkflow: { workflow, status?, count? }` | The session dispatched that sub-workflow. It reads the trail, so a dispatch a script, a code state or a grader made counts too. `status` defaults to `ok`. With `count`, exactly that many dispatches must match; without it, at least one. |
| `trail: { to?, kind?, reason?, count }` | **Structural.** Exactly `count` trail steps match **all** given fields, and at least one of `to`/`kind`/`reason` is required. `kind` is one of `trigger`, `agent`, `human`, `grader`, `code`, `sub-workflow`, `reset` or `on_error`, so `{ kind: grader, to: orders-question, count: 2 }` counts a grader's send-backs. |
| `noTraversal: true` | **Structural.** The trail holds only trigger arrivals: the session never moved, as when its entry code state raised. |
| `triggerArrival: <trigger-id>` | **Structural.** Some trail step has `kind: trigger` and that reason, confirming the session started from the declared trigger. |
| `variables: { expect, path?, locked? }` | **Structural.** Every named variable is set to the expected value, by deep equality. `path` addresses into a value per name (`items.-1.sku` is the last element), and `locked` asserts the lock state. |
| `grade: { closedQA: <criterion>, atLeast: <0..1> }` | A model scores the turn's **evidence** against a yes/no criterion: what the action's turn said *and* what the session did to get there (see [what the judge sees](#what-the-judge-sees)). **`atLeast` decides the outcome**: at or above it passes, below it fails the case, whatever the model's own boolean says. Requires `tests: { judge: … }` in `workflow.yaml`; without it, a `grade` entry records an actionable failure. |

The **trail** is the session's durable, typed record of every committed move: trigger arrivals,
the agent's advances, a person's decisions, grader and code state moves, sub-workflow dispatches,
resets and `on_error` routes. It is checkpointed and written to
`sessions/<sessionId>/artifacts/trail.json`. Each turn begins with a `trigger` step whose `reason`
names the trigger id, and a `trail:` count after several actions counts the whole accumulated
trail. The assistant transcript and the recorded tool calls accumulate the same way.

A string of the form `/pattern/flags` is compiled as a regular expression in three places: the
tokens of a `reply` entry, the input values of `calledTool`, `notCalledTool` and `blockedTool`, and
a mock's `whenInput`. Anything else matches as a plain substring, or by equality for input values.
A malformed regex is a **static error**, caught at validation.

### What the judge sees

A `grade` criterion is scored by the **judge**, the model `tests.judge` configures (the `judge`
model role). It is not a grader state: it runs on the host after the turn and decides nothing in the
session. The grading input has two labelled sections:

1. **What the assistant did, in order**: every assistant message and every tool call of the session
   so far, earlier turns included, interleaved as they happened, with the runtime's notes among
   them (a person's decision, a delivered event, an error route). Each call carries its input, its
   output and its status (`completed`, `failed`, `rejected`, `pending`). A call answered by a
   [mock](#mocking-tool-results) carries the mocked value, so the judge scores the turn the agent
   actually experienced.
2. **The final reply to the user**: the action's turn `reply`, every text the agent said during it,
   in order. A turn that said nothing has an empty reply, never an earlier turn's.

The prompt weighs the two differently. A criterion about what the user was *told* is met only by
the final reply; a criterion about what the assistant *did* may be met by the record. So a
behavioural criterion stands on its own, where a `calledTool` assertion would have to pin an exact
input shape:

```yaml
- grade:
    closedQA: looked the order up in the data file before answering
    atLeast: 0.7
```

The evidence is **bounded**, and every reduction is marked in the prompt. An oversized tool input,
output or record message is cut at 800 characters and marked `…(+N chars)`. A record over its
12,000-character budget drops its **oldest** entries behind a `… N earlier entries omitted` marker,
so the work nearest the graded reply is kept, and the final reply itself is rendered whole.

The evidence is built from the same turn view the step's other assertions read, so a `grade` and a
`calledTool` on the same step never disagree about what the session did. A grading model that wraps
its verdict in prose or a code fence is still read. One whose reply holds no JSON at all is asked
once more, JSON only, before the turn scores 0.

### Which assertions halt a case

A failed **structural** assertion stops the case where it stands: no further action is driven, and
no further assertion is evaluated. Structural assertions are `succeeded`, `parked`, `raised`,
`reachedState`, `trail`, `noTraversal`, `triggerArrival` and `variables`, the ones that say where
the session went and what it carries. Once one of them misses, the session is no longer the one the
case describes: a `decide` after a failed `parked` cannot succeed, and a `reply` check after a
failed `reachedState` grades a state the session never entered.

The content assertions let the case carry on: `reply`, `calledTool`, `notCalledTool`,
`blockedTool`, `usedNoTools`, `ranWorkflow` and `grade`. A wrong reply is a defect in the session,
and the session is still the one under test, so the remaining steps still test something real.

Write the structural assertion you depend on *early* in a case. A diverged session then stops
there, before later steps spend model calls.

### Reading a case that stopped early

A case can stop before its steps run out: a structural halt, a thrown action, or a `caseTimeoutMs`
overrun. It still reports every record produced up to that point, each with the `steps` index it
came from, and every assertion step that never ran with `status: "not-executed"`. Those contribute
no failures, so an assertion that never ran stays visibly distinct from one that passed, both in
the CLI's `N assertions not executed` line and to a host reading
[the records](/reference/public-api/#what-a-case-reports).

A halt is a verdict the case reached; an error is a failure of the machinery running it. A case
that died (a thrown action, a timeout) sets the `error` field, and its failures list the
terminating error **first**, followed by anything the earlier records had already missed. A case
that halted leaves `error` unset and names the assertion that missed.

## Driving a park-and-resume flow

`deliver` resumes a session the agent parked with `archmax_wait`, carrying the trigger that arrived
and the variables it brought, and the session continues in the state it parked in.

`parked: input` pins the channel, so a session that parked at a human state instead cannot satisfy
it. The mapping form `parked: { channel: input, state: clarify }` also pins *where* it parked,
which `reachedState` cannot express, because parking commits no transition.

```yaml
steps:
  - send: "About the thing we discussed on the phone — can you sort it out?"
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

A delivery to a session that is not parked fails the case the way it fails a host, and halts it.
The trigger id is required, but a park awaits no declared id, so any id is deliverable and
validation leaves it alone.

## Mocking tool results

Declarative tool-result mocks pin down what the session sees:

```yaml
mocks:
  - tool: read_file
    whenInput: { file_path: skills/order-data/assets/orders.json }
    result: "[]"
```

`whenInput` matches partially, through the same matcher as `calledTool` input, exported as
`partialMatch` from `@archmax-ai/harness/testing`. `/pattern/flags` strings are regexes, and arrays
match element-wise.

Mocks answer the agent's tool calls, the programmatic calls scripts make inside the driven session,
and the calls of its grader and code states: a code state's script reading
`skills/order-data/assets/orders.json` sees the mocked result, and so does a grader. Governance
decides each call first, and the mock answers once it is permitted. A control tool is never mocked.

Mocking is capability-gated. A case that declares `mocks:` against a target that cannot intercept
fails **before the agent runs**, naming `createToolMockMiddleware()` as the fix. The default target
wires the middleware for you, and a host-supplied target must
[wire it itself](#running-cases-from-a-host). A case that declares no mocks runs against any
workflow-governed target.

A mocked sub-workflow is held to its target's signature, `file` returns included. A `file` return
names a file in the case's own session, seeded with `workspace:`. The runtime copies it into
`scratchpad/attachments/` exactly as it copies a real child's file back, so the case sees the path a
real call would give. A mock naming a file that is not there fails the call:

```yaml
workspace:
  scratchpad/fixtures/report.json: { total: 412.5 }
mocks:
  - tool: archmax_workflow_reconcile
    result:
      returns: { report: scratchpad/fixtures/report.json }   # arrives as scratchpad/attachments/report.json
```

## File fixtures: `from:` references

Bulk fixtures live as real files under `tests/`: a `trigger.json` captured from a previous session,
a large orders dump. Any `workspace` entry may take `{ from: <path> }` as its value, resolved
relative to the workflow's `tests/` directory:

```yaml
workspace:
  trigger.json: { from: triggered-report/trigger.json }   # a directory of this case's own
  orders.json: { from: shared/acme-orders.json }          # a fixture shared between cases
```

Every seed is declared in the case, so a directory no case references is ignored. The rules fail
closed:

- A `from:` path that escapes `tests/` or names a missing file fails the case before any step runs,
  and `archmax validate` reports both statically.
- A seeded file and an inline `workspace:` entry cannot target the same path; YAML itself refuses a
  duplicate key.

## Cases and the date

Every model call states the current date and time. A case whose fixtures or prompts carry dates (an
order placed on `2026-03-15`, a refund window of 30 days) would otherwise read a different "now" on
every run, and its verdict would drift with the calendar. Pin it:

```yaml
title: Refund inside the window
description: A delivered order placed five days ago is refunded.
clock: 2026-03-20            # or "2026-03-20T14:30:00Z", "2026-03-20T16:30+02:00"
```

- **Forms:** an ISO 8601 date (midnight UTC) or a date-time with `Z` or an offset. A date-time
  without a zone, a date that doesn't exist, or anything else is a schema error naming `clock`.
  `clock: ""` pins nothing.
- **Pin on a ten-minute mark.** The line is rounded down to ten minutes, as the real one is, and it
  shows UTC only.
- **Every action carries it:** `send`, `decide` and `deliver`, a park's handoff message and a
  sub-workflow's calls included. It outranks the host's
  [`clock` option](/reference/public-api/#clock-pinning-the-date) for this case, and a case without
  one runs on the host's choice.
- **Only the prompt is pinned.** The sandbox's `Date`, in code states' scripts as in the agent's,
  recorded timestamps and a park's `resumeAt` stay real. A script that needs the case's "today"
  reads it from a variable the case seeds. An absolute `archmax_wait` `until` the model derives
  from the pinned date may lie in the real past, so resume such a wait with `deliver`.

## Authoring a case from a real session

A trigger carries only an id, so everything a firing passes arrives as
[variables](/guides/workflow-machine/#session-variables). Their names, shapes and values live in
the host's call sites and in the sessions that already ran. Every governed session records them, so
read one:

```bash
archmax sessions                 # ids, status, state, parked state, `vars=` names
archmax sessions <sessionId>     # that session's variables: value + locked state
```

`archmax sessions <id>` reads the session's checkpoint, so it answers for every session that has
run, including one driven by `archmax run`, which writes no session artifacts. A host that calls
`emitRunArtifacts` leaves the same record at `sessions/<sessionId>/artifacts/variables.json`:

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

Pick the newest session whose recorded `trigger` matches the trigger the case drives, then map its
store onto the case document:

| Recorded entry | Where it belongs |
| --- | --- |
| `trigger` (always locked) | the case's `trigger: { id: … }`, never an entry in `variables:` |
| any other `locked: true` | the case's `variables:` block: this is the firing's payload |
| `locked: false` | nothing: the agent established it, so **assert** it with `variables: { expect: … }` |

`locked` is all the attribution the record needs. A locked entry came from the host: a `variables`
seed, a delivery's seeds, or the built-in `trigger`. An unlocked one came from the agent's own
`archmax_set_variables`.

Do not copy the whole store into `variables:`. A case's seeds are locked, so seeding a name the
agent is supposed to establish hides a missing `archmax_set_variables` call, and the case passes for
the wrong reason. It also makes the agent's own write fail against the lock, so the case exercises
a write production never performs. The file records the store as the session's **latest** turn
left it, rewritten at the end of every turn, including one that parked: one more reason to build a
case from the locked entries, which do not change from turn to turn.

With no session to read, derive the same facts statically. The `${{…}}` references in
`tools.allow`/`allow_always` and the names in each state's `requires:` are the variables the
workflow depends on, and `archmax validate` warns about a reference nothing guarantees. The host's
own call sites, `createAgent({ variables })` and `deliver(sessionId, { trigger, variables })`, name
what production supplies.

## Suite configuration

The `tests:` block in `workflow.yaml` configures the suite:

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
[`disabled: true`](/reference/machine-spec/#disabled-take-a-workflow-out-of-service) runs no cases.
The suite is reported as **skipped**, one line in place of the summary, and the process exits
**0**, so retiring a workflow keeps a CI run green. There is no flag to force the cases to run, and
`archmax validate` stays fully functional in the meantime.

## No predicate escape hatch

There is no arbitrary-predicate assertion in the YAML format. Bespoke logic belongs in vitest unit
tests against the engine, or in a [code state](/guides/automated-states/#code-states) on the
workflow's graph, which is plain JavaScript that moves the session itself.

## Running cases from a host

A host embedding the SDK runs the same cases by calling
[`runTests`](/reference/public-api/#runtests-cases-from-a-host). Its agent is assembled differently
from the CLI's, so it supplies three more things:

- **`authoring`**, the backend the suite is read from: the spec, the case documents and their
  `from:` fixtures. It defaults to the local filesystem under `rootDir`. A host whose authored tree
  lives in a store names that store here for discovery to find its cases.
- **`createTarget`**, the agent under test: a built workflow-governed runtime or a factory. Cases
  then run against the host's real assembly: mounts, connection tools, session store,
  checkpointer. Such a target wires `createToolMockMiddleware()` itself; a case that declares
  `mocks:` against a target that cannot intercept is refused before the agent runs.
- **`sessionIdForCase`**, which names the session a case runs on, given the case file's path. That
  makes the case's checkpoints, artifacts and token usage addressable from the host's own records.
  Whatever id is used is reported back on `CaseResult.sessionId`.

`runTests` returns data and prints nothing. The CLI's test view is one renderer of its
`CaseResult`s, and a host's reporter is another. Its two halves, `discoverCases` and `runCase`, are
exported for a host that schedules cases itself.

The `sandboxRuntime` option is forwarded only to the agent under test, for its code states' scripts
and `archmax_run` sources; case documents are interpreted on the host. Everything above holds either
way: the same files, the same schema, the same verdicts. See
[what a case reports](/reference/public-api/#what-a-case-reports) for the record shape.
