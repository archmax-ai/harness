# Cases — the `*.test.yaml` grammar

Load this when writing or fixing a case. Worked examples for every shape
(mocks, human decisions, triggered starts, fixtures):
[`code-state-and-test-scripts.md`](code-state-and-test-scripts.md) Part 2.

## Keys, actions, assertions

One YAML document per `tests/<case>.test.yaml`; the case id is the
tests-relative path minus the extension (the `test` filter is a substring of
it). Host-interpreted; no sandbox runs a case. **Unknown keys are errors.**

| Key | Shape |
| --- | --- |
| `title` | required, ≤ 60 chars, one line: the behaviour under test |
| `description` | required, ≤ 200 chars: scenario driven + what is asserted; longer rationale in a YAML comment above |
| `skip` | a reason; reports skipped |
| `trigger` | `{ id }` only — the trigger every turn runs under (default `manual`); unknown id fails the case |
| `variables` | `{ name: value }` seeded and **locked** every turn — the firing's payload; never seed what the agent must establish (assert it with `variables:` instead) |
| `workspace` | `{ <run path>: content }` — strings verbatim, other YAML → JSON, `{ from: <tests-relative path> }` copies a file; only run-zone paths (`trigger.json`, `scratchpad/…`) |
| `mocks` | `[{ tool, whenInput?, result }]` — intercepts the agent's, its scripts', code states' and graders' calls alike (partial-input match); a control tool (`archmax_*`) is never mocked |
| `clock` | ISO 8601 date (`2026-03-20`) or date-time with `Z`/offset — the "now" every model call of the case states; pin it whenever fixtures or prompts carry dates. Prompt only: scripts, the sandbox and recorded timestamps stay real |
| `steps` | one flat list; actions and assertions are peers; an assertion evaluates against the nearest action above it |

Actions: `send: "<message>"` (a new turn; against a parked run, a reply-only
message that leaves it parked), `decide: { to, comment? }`,
`deliver: { trigger, variables? }`.

Assertions (**structural** ones halt the case when they miss; later steps are
reported `not-executed`): `succeeded: true`ˢ (the action's outcome is `completed` — not parked, raised, failed or rejected; a failed or blocked tool call the turn recovered from does not fail it, and a miss says why) · `parked: true | decision | input | { channel?, state? }`ˢ ·
`raised: true | <code> | { code?, reason? }`ˢ (the agent ended the turn with `archmax_raise`; code exact, reason exact or `"/regex/flags"`) ·
`reachedState: <slug>`ˢ (a committed non-trigger trail step, an automated state's move included) ·
`trail: { to?, kind?, reason?, count }`ˢ (`kind`: trigger/agent/human/grader/code/sub-workflow/reset/on_error; `count: 0` = never entered) ·
`noTraversal: true`ˢ (nothing moved; a code or grader move is a traversal) · `triggerArrival: <id>`ˢ ·
`reply: { includes?, excludes? }` (token or list; `"/regex/flags"` strings are regexes; matched against every assistant message of the session so far, earlier turns included) ·
`calledTool` / `notCalledTool` / `blockedTool: { name, input? }` (partial input; `blockedTool` = governance refused it — the assertion that tests a guard; the agent's calls only) ·
`ranWorkflow: { workflow, status?, count? }` (whoever dispatched) · `usedNoTools: true` (whole conversation, the agent's calls only) ·
`variables: { expect, path?, locked? }` · `grade: { closedQA, atLeast }` (LLM grades what the action's turn said plus the session's tool record so far; `atLeast` is a hard bar; needs `tests.judge`).

Put the structural assertion right after the action that should satisfy it,
before content assertions that only make sense in that state:

```yaml
steps:
  - send: "I want a refund for ORD-1001"
  - reachedState: refund-review   # structural: if this misses, the case stops here
  - parked: true
  - reply:
      includes: "approved"
  - decide: { to: refund-closed }
  - succeeded: true
```

**Grader and code states are asserted by what they committed.** Their own tool
calls are not in the transcript (`calledTool`, `usedNoTools` never see them) and a
grader's words are never the `reply`. Pin the move and its reason with `trail`,
a raise with `raised`, a write with `variables`:

```yaml
steps:
  - send: "Hi, I'm support@acmecorp.com. Which orders are delayed?"
  - trail: { kind: code, to: identify-case, count: 1 }        # the entry screen passed it
```

```yaml
trigger: { id: enrichment_requested }                         # the enrichment path
variables: { orders_to_enrich: [{ order_id: "ORD-1002" }, { order_id: "ORD-1003" }] }
steps:
  - send: "Enrich the requested orders."
  - trail: { kind: grader, to: enrich-order, count: 0 }          # no send-back
  - trail: { kind: grader, to: enrichment-reported, count: 1 }   # the grader approved
```

A case that declines at entry asserts `reachedState: <declining state>` plus
`trail: { to: <first work state>, count: 0 }`; one whose entry code state raised
asserts `raised: <code>` and `noTraversal: true`.
