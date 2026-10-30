# Cases

Load this when you write or fix a case. A case is one YAML document at
`workflows/<slug>/tests/<case>.test.yaml`, run by `archmax test`: one conversation on
one session. The harness reads it on the host, and no sandbox runs it. The case id is the
path under `tests/` without the extension, and `archmax test <workflow> <filter>` matches
a substring of it.

## Decide what to mock first

An unmocked tool call in a case is a real call, on every run of the suite: a real email
sent, a real card charged. Before you write the file, ask the workflow's owner how much
to mock, naming the tools the workflow calls:

- **Mock** anything that sends, pays, posts, deletes or writes outside the session, and
  anything whose result drifts between runs.
- **Keep real** reads of fixtures committed to the workspace, the workflow's own scripts
  and code states, and writes under `scratchpad/`.
- **Ask** about reads of a live system: stable enough to keep, or slow, rate-limited or
  credential-bound enough to mock?

Record the answer in a YAML comment above the case.

## Keys

| Key | Shape |
| --- | --- |
| `title` | Required. One line of at most 60 characters naming the behaviour under test, printed beside the verdict. |
| `description` | Required. At most 200 characters: the scenario and what it asserts. Longer rationale goes in a YAML comment above the document. |
| `skip` | A reason. The case reports skipped. |
| `trigger` | `{ id }`. Every turn of the case runs under it (default `manual`), and an unknown id fails the case. A case that exercises a host trigger must declare it. |
| `variables` | `{ name: value }`, seeded and **locked** on every turn: the trigger's payload. Never seed what the agent must establish; assert it instead. |
| `workspace` | `{ <path>: content }`, written before the first step. A string is written verbatim, other YAML as JSON, and `{ from: <path under tests/> }` copies a fixture file. Only session paths: a root file such as `trigger.json`, or `scratchpad/…`. |
| `mocks` | `[{ tool, whenInput?, result }]`. A call whose input matches `whenInput` (partially) returns `result`. It intercepts the agent's calls and its scripts', code states' and graders' calls alike. A control tool is never mocked. |
| `clock` | An ISO date, or a date-time with an offset: the "now" every model call states. Pin it whenever fixtures or prompts carry dates. Scripts and recorded timestamps keep the real time. |
| `steps` | One flat list of actions and assertions. |

Unknown keys are errors everywhere. `archmax validate` checks every case: the schema,
`title` and `description`, regexes, trigger ids and `from:` files. Only `*.test.yaml`
and `*.test.yml` files are cases. `tests.judge` in `workflow.yaml` enables `grade:`.

## Steps

Each step is a single-key mapping. An assertion evaluates against the nearest action
above it, so an assertion before the first action is an error.

| Action | Effect |
| --- | --- |
| `send: "<message>"` | One turn. Sent to a session parked at a human state, it is a message answered on a reply-only turn, and the session stays parked. |
| `decide: { to, comment? }` | A person picks the parked human state's transition `to`. |
| `deliver: { trigger, variables? }` | Delivers a trigger to a session parked with `archmax_wait`. |

Structural assertions are marked ˢ.

| Assertion | Passes when |
| --- | --- |
| `succeeded: true`ˢ | The action's outcome is `completed`: not parked, raised, failed or rejected. A tool error the turn recovered from does not fail it. |
| `parked: true \| decision \| input \| { channel?, state? }`ˢ | The session is parked. |
| `raised: true \| <code> \| { code?, reason? }`ˢ | The turn ended with `archmax_raise`. `code` is exact; `reason` is exact or a `"/regex/flags"` string. |
| `reachedState: <slug>`ˢ | A committed trail step entered the state. The trigger's arrival does not count. |
| `trail: { to?, kind?, reason?, count }`ˢ | Exactly `count` trail steps match every given field. `count: 0` means the state was never entered. |
| `noTraversal: true`ˢ | Nothing moved the session: the trail holds only trigger arrivals. |
| `triggerArrival: <id>`ˢ | The session arrived on that trigger. |
| `reply: { includes?, excludes? }` | Each token or `"/regex/flags"` string, one or a list, matches (or, for `excludes`, matches none of) every assistant message of the session so far. |
| `calledTool` / `notCalledTool` / `blockedTool: { name, input? }` | The agent called the tool (`input` matches partially), never called it, or called it and governance refused it. `blockedTool` is how you test a guard. |
| `ranWorkflow: { workflow, status?, count? }` | A sub-workflow ran, whoever called it, a script included. |
| `usedNoTools: true` | The agent called no tool in the whole conversation. |
| `variables: { expect, path?, locked? }` | Each named variable equals its expected value (deep equality). `path` steps into a value; `locked` checks the lock. |
| `grade: { closedQA, atLeast }` | The judge scores the action's turn against the criterion, and a score below `atLeast` fails the case. Needs `tests.judge`. |

- **A missed structural assertion halts the case**, and later steps are reported
  `not-executed`. Put the structural assertion right after the action that should
  satisfy it, before content assertions that only make sense there.
- `calledTool`, `notCalledTool`, `blockedTool` and `usedNoTools` read the agent's calls
  across the whole conversation, not one turn's. They see the `${{name}}` reference the
  agent wrote, not the value: assert a delivered value through its effect instead.
- A `/pattern/flags` string is a regex: quote it in YAML. A malformed one is a validate
  error. There is no generic predicate: bespoke logic belongs in a code state.
- `grade` sees what the action's turn said plus a record of the session's messages and
  tool calls, so it can judge what the agent did as well as what it said. It is the one
  non-deterministic assertion.

## Examples

A routed answer, with a grade:

```yaml
# reachedState pins the route: without it the case passes even when the agent
# answers from the start state.
title: Delayed orders answered for a known requester
description: >-
  A known requester's question routes into orders-question, and the reply names
  the one delayed order, ORD-1003.
steps:
  - send: "Hi, I'm support@acmecorp.com. Which orders are delayed for Acme?"
  - succeeded: true
  - reachedState: orders-question
  - reply:
      includes: ["ORD-1003", "/delayed/i"]
  - grade:
      closedQA: confirms that ORD-1003 is the delayed order for Acme Corp
      atLeast: 0.7
```

A human state, sent back once and then approved:

```yaml
title: Refund sent back for changes, then approved
description: >-
  The reviewer refines once and approves: the session parks at both reviews,
  refund-review is entered twice, and the final reply still names ORD-1001.
steps:
  - send: "Hi, I'm support@acmecorp.com. I'd like a refund for order ORD-1001."
  - parked: true
  - decide: { to: refund-request, comment: "Restate the refund amount." }
  - parked: true
  - trail: { to: refund-review, count: 2 }
  - decide: { to: refund-closed }
  - succeeded: true
  - reply:
      includes: "ORD-1001"
```

A host trigger, a fixture file and a mock:

```yaml
# Only the order database read is mocked; the agent's own writes stay real.
title: Empty order database reports no delayed orders
description: >-
  With orders.json mocked empty, a requested report still reads the database
  and reports no delayed orders.
trigger: { id: report_requested }
variables: { company: "Acme Corp" }
workspace:
  trigger.json: { from: fixtures/trigger.json }
mocks:
  - tool: read_file
    whenInput: { file_path: skills/order-data/assets/orders.json }
    result: "[]"
steps:
  - send: "A delayed-orders report was requested."
  - triggerArrival: report_requested
  - calledTool: { name: read_file, input: { file_path: "/orders\\.json/" } }
  - reply:
      includes: "/no (matching |delayed )?orders/i"
```

## Grader and code states in a case

An automated state's own calls are not in the transcript, and a grader's words are
never the reply. Assert what it committed: its move with `trail` (`kind: code` or
`kind: grader`) or `reachedState`, a raise with `raised`, a write with `variables`, and
its sub-workflows with `ranWorkflow`.

```yaml
steps:
  - send: "Hi, I'm support@acmecorp.com. Which orders are delayed?"
  - trail: { kind: code, to: identify-case, count: 1 }   # the entry screen passed it
```

A case that declines at entry asserts `reachedState: <declining state>` and
`trail: { to: <first work state>, count: 0 }`. One whose entry code state raised asserts
`raised: <code>` and `noTraversal: true`. A mock answers a code state's calls too, so
mocking a file an entry check reads changes what the check decides.

## Seed from a real session

A trigger carries only an id. Its payload arrives as variables, and their names and
shapes live in the host's call site and in sessions that already ran. Read one instead
of inventing a payload:

```bash
archmax sessions               # ids, status, state and variable names
archmax sessions <id>          # one session's variables, each with its value and lock
```

A host that writes artifacts keeps the same record at
`sessions/<id>/artifacts/variables.json`. Take the newest session whose `trigger` matches
the case's, then map its variables:

| Recorded entry | Goes to |
| --- | --- |
| `trigger` | the case's `trigger: { id }` |
| any other locked entry | `variables:`, the trigger's payload |
| an unlocked entry | nothing: the agent set it, so assert it with `variables: { expect }` |

Never copy the whole store. A seed is locked, so seeding a name the agent sets hides a
missing `archmax_set_variables` call and makes the agent's own write fail.

With no session to read, the `${{…}}` references and `requires` lists in
`workflow.yaml`, and the host's `createAgent({ variables })` and `deliver` calls, name
what a trigger supplies. To produce a session, run one:
`archmax run <workflow> "<prompt>" --variables '{"email":"ann@example.com"}'`.

## Running cases

`archmax test <workflow>` runs the suite one case at a time; `tests.caseTimeoutMs`
bounds each. A workflow with `disabled: true` runs no cases: the suite is reported
skipped and exits 0. To run the same suite against your own agent, use `runTests` on
`@archmax-ai/harness/testing`
([`backend-integration.md`](backend-integration.md#cases-against-your-agent)).
