# Cases — the `*.test.yaml` grammar

Load this when writing or fixing a case. Worked examples for every shape
(mocks, human decisions, triggered starts, fixtures):
[`hook-and-test-scripts.md`](hook-and-test-scripts.md) Part 2.

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
| `mocks` | `[{ tool, whenInput?, result }]` — intercepts agent and script calls alike (partial-input match) |
| `steps` | one flat list; actions and assertions are peers; an assertion evaluates against the nearest action above it |

Actions: `send: "<message>"` (a new turn; against a parked run, a reply-only
message that leaves it parked), `decide: { to, comment? }`,
`deliver: { trigger, variables? }`.

Assertions (**structural** ones halt the case when they miss; later steps are
reported `not-executed`): `succeeded: true`ˢ · `parked: true | decision | input | { channel?, state? }`ˢ ·
`reachedState: <slug>`ˢ (a committed non-trigger trail step) ·
`trail: { to?, kind?, reason?, count }`ˢ (`kind`: trigger/agent/human/on_error) ·
`noTraversal: true`ˢ · `triggerArrival: <id>`ˢ ·
`reply: { includes?, excludes? }` (token or list; `"/regex/flags"` strings are regexes; matched against the whole turn's assistant text) ·
`calledTool` / `notCalledTool` / `blockedTool: { name, input? }` (partial input; `blockedTool` = governance refused it — the assertion that tests a guard) ·
`ranWorkflow: { workflow, status?, count? }` · `usedNoTools: true` (whole conversation) ·
`variables: { expect, path?, locked? }` · `grade: { closedQA, atLeast }` (LLM grades the reply plus the tool record; `atLeast` is a hard bar; needs `tests.judge`).

Put the structural assertion right after the action that should satisfy it,
before content assertions that only make sense in that state:

```yaml
