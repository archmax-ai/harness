# testing Specification

## Purpose

Define the case engine behind `archmax test` and `@archmax-ai/harness/testing`: declarative YAML cases under
`workflows/<slug>/tests/`, each one conversation on one session of a workflow-governed agent. A case
declares its start conditions (trigger, variables, seeded workspace files, tool mocks) and one flat
list of steps in which actions and assertions are peers; the engine drives the agent host-side,
evaluates every assertion against the turn it follows, grades with a model where asked, and returns
verdicts and an exit code as data. No sandbox is involved in running a case.

## Requirements

### Requirement: Case discovery

The engine SHALL discover cases under `workflows/<slug>/tests/` by recursively collecting files ending in `.test.yaml` or `.test.yml` through the authoring backend, sorted by path, one case per file, the case id being the file path relative to the tests directory minus that extension. Anything else in the directory — fixture files, notes, a `*.test.js` — is not a case and is ignored without a diagnostic; a missing tests directory is an empty suite. Every discovered file is parsed up front: a file that fails to parse is reported as a failed case carrying the schema message, never thrown past the suite. `runTests` keeps only case files whose path contains `filter` and reports the pre-filter count as `discovered`, so a caller can tell a filter that matched nothing from an empty suite.

#### Scenario: Cases discovered and identified

- **WHEN** `tests/` holds `happy.test.yaml`, `refunds/veto.test.yml`, `notes.md` and `legacy.test.js`
- **THEN** discovery yields exactly the two YAML files, sorted, with ids `happy` and `refunds/veto`

#### Scenario: Unparseable file is a failed case

- **WHEN** a discovered file is not a YAML mapping or violates the case schema
- **THEN** its result has a `failed` verdict whose first failure and `error` carry the schema message, and the other cases still run

#### Scenario: Filter applied

- **WHEN** `runTests` is given `filter: "other"`
- **THEN** only case files whose path contains `other` run, `discovered` still counts every case file, and an empty selection returns before any agent is built

### Requirement: A case is one YAML document

A case SHALL be a YAML mapping with a mandatory `title` (a single line of at most `CASE_TITLE_MAX_LENGTH` = 60 characters) and a mandatory `description` (at most `CASE_DESCRIPTION_MAX_LENGTH` = 200 characters), both measured and stored on whitespace-collapsed text so folded and literal blocks of the same prose score alike, and MAY carry `skip` (a non-empty reason string), `trigger`, `variables`, `workspace`, `mocks` and `steps`. A case carries no version of its own. Unknown top-level keys SHALL be rejected with a message naming the unknown key and listing the known ones; every rejection names the file and the offending location.

#### Scenario: Missing or over-long prose rejected

- **WHEN** a case omits `title` or `description`, gives a multi-line `title`, or exceeds either budget
- **THEN** parsing fails with a message naming the field, its budget and the measured length where applicable

#### Scenario: Unknown top-level key rejected

- **WHEN** a case declares `version: "2"` or `bogus: true`
- **THEN** parsing fails naming the key and the known top-level keys

#### Scenario: Skipped case

- **WHEN** a case declares `skip: "pending fixture"`
- **THEN** its result is `skipped` with `skipReason` set, no records, no `sessionId`, and no turn is driven

### Requirement: Steps are a flat list of actions and assertions

`steps` SHALL be one flat, sequential list of single-key mappings in which actions and assertions are peers: an action is `send` (a non-empty user message), `decide` (`{ to, comment? }`) or `deliver` (`{ trigger, variables? }`), and every other known key is an assertion. Each assertion evaluates against the view of the nearest action above it; an assertion with no preceding action is a schema error directing the author to put an action before it. A step with zero or several keys, or an unknown key, is rejected with a message listing the known actions and assertions. Unknown keys inside any step's mapping are rejected. A `/pattern/flags` string anywhere a matcher or reply token is accepted compiles to a regular expression, and a malformed one is a static error rather than a literal. `deliver.variables` names are checked against the variable-name shape at parse time.

#### Scenario: Assertions bind to the nearest action

- **WHEN** a case declares `send`, a `reply` assertion, `decide`, then `succeeded: true`
- **THEN** `reply` evaluates against the send's view and `succeeded` against the decide's view

#### Scenario: Assertion before any action rejected

- **WHEN** a case's first step is `- succeeded: true`
- **THEN** parsing fails at `steps[0]` naming the assertion and asking for a `send`, `decide` or `deliver` before it

#### Scenario: Unknown step key rejected

- **WHEN** a step declares `reachedstate: done`
- **THEN** parsing fails naming `reachedstate` and listing the known actions and assertions

### Requirement: Case-declared trigger

A case MAY declare `trigger: { id }` (no other keys), and every `send` of the case SHALL run under that trigger — there is no per-step trigger, so a follow-up message cannot restart the session from a different start state. The id SHALL be resolved against the workflow machine when the session opens, before any step: an unknown id fails the case with `UnknownTriggerError`, even when the case has no steps, and never falls back to the manual trigger. A case with no `trigger` runs under the runtime's default, the manual trigger. The arrival remains observable in the trail as a `kind: "trigger"` step whose `reason` is the id.

#### Scenario: Declared trigger starts every turn

- **WHEN** a case declares `trigger: { id: report_requested }` and sends two messages
- **THEN** both turns enter the state declaring that trigger and `triggerArrival: report_requested` holds after each

#### Scenario: Unknown trigger fails before any step

- **WHEN** a case declares `trigger: { id: does_not_exist }`
- **THEN** the case fails with an error naming the id and the workflow's declared triggers, and every assertion step is `not-executed`

### Requirement: Case-level variable seeds

A case MAY declare a top-level `variables:` mapping; each name SHALL match the variable-name shape (lowercase letters, digits and underscores, starting with a letter) or parsing fails naming it. The seeds are supplied with every `send` of the case as host seeds, so the runtime stores them locked exactly as a production host seed: a `${{…}}` guard reference resolves from them, a `requires:` gate is satisfied by them, hook scripts observe them, the model cannot rewrite them, and a `variables` assertion sees them as locked. This is how a case supplies a trigger-started workflow's payload, since `trigger` carries only an id.

#### Scenario: Seed observed as locked

- **WHEN** a case seeds `from_email: "a@b.com"` and asserts `variables: { expect: { from_email: "a@b.com" }, locked: { from_email: true } }`
- **THEN** both records pass

#### Scenario: Invalid name rejected

- **WHEN** a case seeds a variable named `From-Email`
- **THEN** parsing fails naming the required shape

### Requirement: Case-declared workspace files

A case MAY declare `workspace: { "<path>": <entry> }`, seeded into the case's session before any step through the target's `sessions.seed` handle. An entry is inline content — a string written verbatim, any other value written as pretty-printed JSON — or the single-key mapping `{ from: <tests/-relative path> }`, whose file is read through the authoring backend and written byte-for-byte. A `from:` path that is absolute, empty, or escapes the tests directory via `..`, or that names a missing file, SHALL fail the case before any step. Paths are classified through the assembly's mount table: only agent-visible session paths (root-level files such as `trigger.json` and `scratchpad/…`) are seedable, every path is checked before any is written, and a target whose sessions handle has no `seed` operation SHALL be refused with an error naming the missing handle. A case with no `workspace` runs against any workflow-governed target.

#### Scenario: Inline and file-sourced entries land before the first step

- **WHEN** a case declares `workspace: { trigger.json: { company: Acme }, scratchpad/notes.md: { from: shared/notes.md } }`
- **THEN** the session holds `trigger.json` as JSON and `scratchpad/notes.md` as the fixture's bytes before the first action runs

#### Scenario: Escaping or missing fixture rejected

- **WHEN** an entry declares `from: ../secret.txt` or `from: shared/missing.json`
- **THEN** the case fails before any step with an error naming the reference, and every assertion step is `not-executed`

#### Scenario: Disallowed seed path rejected

- **WHEN** an entry's path classifies outside the seedable session zones
- **THEN** the seed handle rejects it naming the path and its zone, and nothing is written

### Requirement: Declarative tool mocks

A case MAY declare `mocks:` as a list of `{ tool, whenInput?, result }` entries. A mock matches a call by tool name and, when `whenInput` is given, by partial match against the call's arguments; the first matching mock in declaration order wins, so a narrower entry declared earlier shadows a broader one. A string `result` is the tool's payload verbatim and any other value is JSON-serialized. The mocks ride each driven `send` in the run configuration and SHALL intercept both agent-initiated tool calls (the tool-mock middleware) and the calls scripts make through `tools.*` (the PTC gateway), so a mock means one thing whoever makes the call.

#### Scenario: Agent call mocked

- **WHEN** a case mocks `crm_lookup` with `whenInput: { email: "a@acme.test" }` and the model calls it with that email
- **THEN** the call settles with the mocked result and the real tool never runs

#### Scenario: Script call mocked

- **WHEN** the driven agent runs a script calling `tools.readFile(...)` with input matching a `read_file` mock
- **THEN** the script receives the mocked result

### Requirement: Mocks require a target that can intercept them

Before anything runs, a case declaring `mocks:` SHALL be refused unless the target's `toolMocks` capability is `true` — stamped at assembly when `createToolMockMiddleware()` (the middleware named `ToolMockMiddleware`) is in the agent's middleware list — with an error naming the middleware, so a case never executes with partial interception (scripts mocked, the agent's own calls real). The refusal is checked before seeding or driving; every assertion step is then `not-executed`. A case with no mocks runs against any workflow-governed target.

#### Scenario: Un-interceptable mocks refused

- **WHEN** a case with `mocks:` runs against a caller-built target without the tool-mock middleware
- **THEN** the case fails before the agent runs, naming `createToolMockMiddleware()` and the `toolMocks` capability

### Requirement: Delegation mocks are served by the dispatcher

A mock keyed by a delegation tool's own name (`archmax_workflow_<slug>`) SHALL be served by the sub-workflow dispatcher, not at the generic tool seam, which steps aside for that name: the dispatch still emits its events and records its `sub-workflow` trail step, so `ranWorkflow` sees it, and only the child run is skipped. Matching is against the call's resolved arguments. The mock is held to the target's contract: a `result` carrying `error` fails the call as a real failure would; when the target's `manual` trigger declares `returns`, the mock's `result.returns` must supply every declared name or the call fails with `missing-return`; otherwise a string result or `{ message }` is the closing message.

#### Scenario: Mocked dispatch is on the record

- **WHEN** a case mocks `archmax_workflow_enrich-order` and the agent calls it
- **THEN** no child session runs, the trail carries a `sub-workflow` step for `enrich-order` with status `ok`, and `ranWorkflow: { workflow: enrich-order }` passes

#### Scenario: Mock omitting a declared return fails the call

- **WHEN** the target declares `returns: [enrichment_file, delayed]` and the mock supplies only `enrichment_file`
- **THEN** the mocked call fails with `missing-return` naming `delayed`

### Requirement: Host-side interpretation on one session per case

The engine SHALL interpret a case on the host: it opens one session for the case (validating the trigger, then seeding variables and files), then walks the steps in order. `send` drives `agent.workflow.send(sessionId, { message, trigger?, variables? })` with the case's mocks and abort signal in the run configuration, and the runtime decides the disposition — a fresh turn, a reply to a session parked at a human state (which stays parked), or a delivery of the case's trigger to a session parked for input; `decide` resumes a session parked for a decision along `to` with an optional `comment`; `deliver` resumes a session parked for input with `{ trigger: { id }, variables? }`, any id being deliverable. Each action's settled `Outcome` becomes the view later assertions read: the messages, audit trail and variables, plus `parked`, the park channel and the parked state when the turn parked. A `decide` or `deliver` against a session that is not parked on that channel SHALL fail as it fails a host — the thrown error terminates the case — never silently start a new turn. A second `send` is a second turn on the same session.

#### Scenario: Send to a decision-parked session replies in place

- **WHEN** a turn parks at a human state and a later step declares `send: "any news?"`
- **THEN** the session stays parked awaiting the decision and the following assertions see a view that is parked on `decision` and carries the agent's reply

#### Scenario: Deliver to a session that is not awaiting input dies

- **WHEN** a case declares `deliver: { trigger: email_reply }` after a turn that completed
- **THEN** the case terminates with the runtime's not-parked error as its `error`, and the remaining assertion steps are `not-executed`

#### Scenario: A park's handoff message is the reply

- **WHEN** a `send` ends in a park and the next step declares `reply: { includes: "under review" }`
- **THEN** the assertion evaluates against the handoff message the runtime produced for the park

### Requirement: Structural assertions read the session's trail and park

The engine SHALL evaluate these assertions from the view's audit trail and park state: `succeeded: true` (the turn neither parked nor recorded a failed tool call; a governance rejection is not a failure); `parked: true` (parked on either channel), `parked: decision` / `parked: input` (pinning the channel) or `parked: { channel?, state? }` (pinning the channel and/or the state the session parked in — which `reachedState` cannot express, since a park commits no transition); `reachedState: <slug>` (a committed trail step of any kind but `trigger` has `to` equal to the slug, so a vetoed entry never "reaches" the state); `noTraversal: true` (every trail step is a trigger arrival); `triggerArrival: <id>` (a `trigger` step carries that id as its `reason`, including one delivered into a park); `trail: { to?, kind?, reason?, count }` (at least one field, and the number of steps matching every given field equals `count`).

#### Scenario: Park pinned to channel and state

- **WHEN** a turn parks via `archmax_wait` in `clarify`
- **THEN** `parked: input` and `parked: { channel: input, state: clarify }` pass, while `parked: decision` and `parked: { state: review }` fail with the pinned fields in their detail

#### Scenario: Vetoed entry commits no transition

- **WHEN** the start state's `before` hook vetoes the turn
- **THEN** `noTraversal: true` passes and `reachedState: <start state>` fails

#### Scenario: Trail counting

- **WHEN** a refine loop entered `refund-review` twice and a step declares `trail: { to: refund-review, count: 2 }`
- **THEN** the assertion passes, and its detail reports the expected and observed counts on a miss

### Requirement: The `variables` assertion

`variables: { expect, path?, locked? }` SHALL produce one record per expected name: failed with detail `(not set)` when the variable is absent; when `path` gives a dotted path for the name (`items.0.sku`; a negative index such as `items.-1.sku` counts from the end), the addressed value is compared and an unresolvable path fails with `(path does not resolve)`; otherwise the stored value is compared to the expected one by deep equality, a mismatch reporting both values. When `locked` names the variable, a further record checks the stored lock flag.

#### Scenario: Structured value addressed

- **WHEN** a case asserts `variables: { expect: { sku: "A-1" }, path: { sku: items.0.sku } }`
- **THEN** only `items[0].sku` of the stored value is compared

#### Scenario: Lock state asserted

- **WHEN** a case asserts `locked: { customer_id: true }` for a variable the model set unlocked
- **THEN** the lock record fails naming both states

### Requirement: Content assertions read the transcript and tool calls

The engine SHALL evaluate `reply: { includes?, excludes? }` (at least one, each a token or list of tokens; a plain token is a substring, a `/pattern/flags` token a regex) against the whole assistant transcript of the turn — every completed assistant message joined, not only the final reply — producing one `reply.includes` / `reply.excludes` record per token; `calledTool: { name, input? }` (some recorded call has that name and its arguments partially match `input`); `notCalledTool` (no such call); `blockedTool` (a matching call was made and governance rejected it — distinct from a call that never happened and from a tool that ran and errored); `usedNoTools: true` (the turn recorded no tool calls); and `ranWorkflow: { workflow, status?, count? }` (the trail's `sub-workflow` steps for that slug with `status`, default `ok`: at least one, or exactly `count`). Tool-call matching compares the arguments as the transcript records them — a `${{name}}` reference in reference form, not its resolved value.

#### Scenario: Reply tokens over the whole turn

- **WHEN** a turn says "Looking into it", calls a tool, then parks with "This is with a reviewer"
- **THEN** `reply: { includes: ["Looking", "/reviewer/i"], excludes: ["ORD-2001"] }` produces three records, all passing

#### Scenario: Blocked is not merely uncalled

- **WHEN** the agent's `read_file` of a refund-policy path was refused by governance
- **THEN** `blockedTool: { name: read_file, input: { file_path: "/refund-policy/" } }` passes, `calledTool` with the same input passes, and `notCalledTool` fails

#### Scenario: Assertion states the reference the model emitted

- **WHEN** the model calls `send_reply({ body: "ref ${{order_id}}" })`
- **THEN** `calledTool: { name: send_reply, input: { body: "ref ${{order_id}}" } }` passes

### Requirement: One partial-match vocabulary

`calledTool`/`notCalledTool`/`blockedTool` `input` and a mock's `whenInput` SHALL share the `partialMatch` vocabulary: a mapping matches when every declared key is present and matches, nested mappings partially at every depth; an array matches element-wise with equal length; a `/pattern/flags` string is a regex tested against the stringified observed value; every other scalar and `null` match by strict equality.

#### Scenario: Nested partial match with a regex

- **WHEN** an assertion declares `input: { file_path: "/orders\\.json$/", options: { limit: 5 } }`
- **THEN** it matches a call whose `file_path` ends in `orders.json`, whose `options.limit` is 5, and which carries other keys at either depth

### Requirement: The `grade` assertion

`grade: { closedQA, atLeast }` (`atLeast` in `[0, 1]`) SHALL ask the grader to score the turn against the criterion and record `kind: "grade.closedQA"`, `threshold: atLeast`, the score clamped to `[0, 1]`, and a detail carrying the criterion and the grader's reason. The record's status is `passed` when the score is at or above `atLeast` and `failed` otherwise; the grader's own boolean is never read, so a record cannot contradict the verdict computed from its score. A grading error records score 0 with the error in its detail. Without a configured grader the record fails with a detail directing the author to declare `tests: { judge: ... }` in `workflow.yaml`. There is no `judge:` step: like any unknown step key, it fails the case document's parse.

#### Scenario: Threshold decides

- **WHEN** the grader returns `{ score: 0.6, pass: true }` against `atLeast: 0.7`
- **THEN** the record is `failed` with score 0.6 and the case verdict is `failed`, listing `(score 0.6 < 0.7)`

#### Scenario: Grader unavailable

- **WHEN** a case declares `grade` and the workflow declares no `tests.judge`
- **THEN** the record is `failed` with score 0 and a detail naming the fix

#### Scenario: A judge step is unknown

- **WHEN** a case declares a `judge:` step
- **THEN** the document fails to parse with an unknown-step error

### Requirement: The grader and its evidence

The grader SHALL be the model factory's `judge` role (default: the env-configured model) handed the environment with `tests.judge.model` and `tests.judge.modelOptions` (`temperature`, `maxTokens`; any other key fails the spec load) applied over it; the environment is loaded lazily so a factory carrying its own credentials needs no `ARCHMAX_*` variables. Its evidence is derived from the same view the step's other assertions read: the turn's final reply, and a chronological record of every assistant message, runtime note (`[runtime:<kind>]`) and tool call with name, input, output and status (`completed`, `failed`, `rejected`, `pending`) — a mocked call appearing with its mocked output. The final reply is not repeated in the record when it closed the turn. Each rendered input, output or message is capped at `MAX_VALUE_CHARS` (800) with a marker naming the dropped characters; the record is capped at `MAX_RECORD_CHARS` (12000), dropping the oldest entries first behind one marker naming how many were omitted; an empty record says so explicitly; the reply is never capped. The prompt labels the two sections and instructs the model that a criterion about what the user was told is met only by the reply while one about behaviour may be met by the record, asks for JSON `{ score, pass, reason }` with a 1–3 sentence reason, and tolerates prose or fences around the JSON by taking the first balanced `{...}` block that parses; when none parses the grader is asked once more for JSON only, and if that also fails the score is 0 with the reason "grader returned no readable JSON verdict".

#### Scenario: A person's decision is evidence

- **WHEN** a refund was approved by `decide` and the next turn is graded on "the refund was approved by a person"
- **THEN** the prompt carries the `[runtime:decision]` note and the final reply in its own section, and no `archmax_note` tool call

#### Scenario: Oversized evidence elided visibly

- **WHEN** a tool output exceeds 800 characters and the record exceeds 12000
- **THEN** the output is truncated with a `…(+N chars)` marker, the oldest entries are dropped behind an omission marker, and the reply reaches the grader whole

#### Scenario: One retry then zero

- **WHEN** the grader answers with unparseable text twice
- **THEN** the record scores 0 and the case continues

### Requirement: Assertion records are step-attributed and status-bearing

Every `AssertionRecord` SHALL carry `kind`, `status` (`passed`, `failed` or `not-executed`), `threshold` (the `atLeast` of a grade, else `null`), an optional `score` and `detail`, and `step`: the zero-based index in `steps` of the assertion that produced it — the same index the schema's `steps[i]` locations use. Records are attributed at construction, so a `reply` with several tokens stamps every record with its own step; action steps produce no records. A `not-executed` record is one per un-run assertion step, never expanded into the records it would have produced.

#### Scenario: Records grouped by step

- **WHEN** `steps[1]` is `reply: { includes: [a, b], excludes: [c] }` and `steps[3]` is `succeeded: true`
- **THEN** three records carry `step: 1`, one carries `step: 3`, and none carries 0 or 2

### Requirement: A failed structural assertion halts the case

A failed `succeeded`, `parked`, `reachedState`, `trail`, `noTraversal`, `triggerArrival` or `variables` record SHALL stop the case: no further action is driven, no further assertion is evaluated, and every later assertion step is reported `not-executed`. A failed content assertion (`reply`, `calledTool`, `notCalledTool`, `blockedTool`, `usedNoTools`, `ranWorkflow`, `grade`) does not halt. A halt is a verdict, not a case-level error: the result has no `error` field.

#### Scenario: Halt after a failed state assertion

- **WHEN** `reachedState` fails at step 2 and steps 3–6 hold a `send` and three assertions
- **THEN** no further message is sent, the three assertions are `not-executed` with their own indices, and `error` is unset

#### Scenario: Content failure continues

- **WHEN** a `reply` token is missing at step 1
- **THEN** the remaining steps still drive and evaluate

### Requirement: A case that dies still reports what it established

When a case terminates before its steps are exhausted for a reason other than a halt — a refused start (bad trigger, failed seed, un-interceptable mocks), an action that throws, or the wall-clock budget — the result SHALL carry the terminating message as `error`, a `failed` verdict whose failures list that message first and then the failures reduced from the records already produced, those records, and one `not-executed` record per assertion step that did not run. A case exceeding `tests.caseTimeoutMs` (default 120000 ms) is abandoned, the abort signal the engine passes with each turn is triggered so the in-flight turn does not keep spending under the next case, and the error names the budget key; the records produced before the deadline are kept.

#### Scenario: Records survive a failed action

- **WHEN** assertions at steps 1–6 evaluated and the action at step 7 throws
- **THEN** the verdict is `failed` with the throw first, the six records are reported with their indices, and later assertions are `not-executed`

#### Scenario: Timeout

- **WHEN** a case runs past `caseTimeoutMs`
- **THEN** its result's `error` names `tests.caseTimeoutMs`, the abort signal fires, and the un-run assertions are `not-executed`

### Requirement: Verdict reduction and exit code

`reduceVerdict(records)` SHALL return `{ status: "failed", failures }` when any record has `status: "failed"` — each failure labelled `kind: detail`, a graded miss adding `(score s < atLeast)` — and `{ status: "passed", failures: [] }` otherwise; `not-executed` records contribute nothing. There is no severity tier that records a failure without failing the case and no flag that changes which failures count. `CaseStatus` is `passed | failed | skipped`, `skipped` being set by `runCase` for a `skip` case. `exitCodeForVerdict` maps `failed` to 1 and anything else to 0; `RunTestsResult.exitCode` is 1 when any case's verdict maps to 1.

#### Scenario: Only a graded miss

- **WHEN** a case's only failed record is a grade at 0.5 against `atLeast: 0.7`
- **THEN** the verdict is `failed` with one failure ending in `(score 0.5 < 0.7)` and the suite exit code is 1

#### Scenario: All passing or skipped

- **WHEN** every case is `passed` or `skipped`
- **THEN** the suite exit code is 0

### Requirement: Suite configuration in the spec's `tests:` block

Suite configuration SHALL be read from the workflow spec's optional `tests:` block — `maxConcurrency`, `caseTimeoutMs` and `judge: { model?, modelOptions? }` — with no configuration file. A `maxConcurrency` above 1 SHALL make `runTests` throw, stating that cases run sequentially and the field must be 1 or absent, rather than being accepted and silently run in sequence. The grader is wired only when `tests.judge` is present.

#### Scenario: Concurrency rejected

- **WHEN** `workflow.yaml` declares `tests: { maxConcurrency: 4 }`
- **THEN** `runTests` throws before discovering cases

#### Scenario: Grader wired from the block

- **WHEN** `workflow.yaml` declares `tests: { judge: {} }`
- **THEN** `grade` steps are scored by the model factory's `judge` role

### Requirement: A disabled workflow's suite is skipped

When the spec declares `disabled`, `runTests` SHALL run nothing and return `{ results: [], exitCode: 0, discovered: 0, skipped: "disabled" }` — decided from the spec it already reads, before any discovery, and not by bypassing the runtime's disabled gate. `SuiteSkip` is the type of that reason, so a caller can tell a skipped suite from an empty one.

#### Scenario: Retiring a workflow does not fail CI

- **WHEN** cases are run for a workflow declaring `disabled: true`
- **THEN** no case runs, `skipped` is `"disabled"` and the exit code is 0

### Requirement: The authoring backend the suite is read from

`runTests` SHALL read the spec, the case documents and their `from:` fixtures through the backend given as `authoring` — the same option `createAgent` takes — and otherwise through a filesystem backend over the resolved `rootDir`. When `authoring` is supplied, no workspace context is composed from `rootDir` at all, so a host whose authored tree lives outside the filesystem needs no local root for defaults the engine never reads.

#### Scenario: Suite read from the host's store

- **WHEN** a host supplies `authoring` serving `workflows/<slug>/tests/stored.test.yaml` and the local root holds a different tests directory
- **THEN** the stored case is the one discovered and run, and its `from:` fixtures resolve against the same backend

#### Scenario: Filesystem default unchanged

- **WHEN** `authoring` is omitted
- **THEN** the suite is read from `<rootDir>/workflows/<slug>/`, as `archmax test` does

### Requirement: The agent under test

`runTests` SHALL drive every case against one target: `createTarget` given as a built agent whose `workflow` is present, or as a factory receiving `{ workflow, rootDir (resolved), onEvent? }`; absent, `createCaseTarget({ workflow, rootDir, onEvent, sandboxRuntime, modelFactory })` builds one with `createAgent`, always wiring `createToolMockMiddleware()`. `assertWorkflowGovernedTarget` SHALL refuse a target without `agent.workflow`, and `runTests` re-checks a supplied target on the same terms before the first case. `sandboxRuntime` and `modelFactory` are forwarded to the agent under test (the factory also supplies the grader); a case document itself never runs in the sandbox. Each case's session id is `sessionIdForCase(file)` when given, else `test-default-<runId>-<file with / replaced by ->`; `onCaseStart(file, sessionId)` fires before the case runs and `onCaseResult(result)` after, the id is reported on `CaseResult.sessionId`, and the session is disposed when the case ends. Everything the engine reads — spec, cases, fixtures — comes through the authoring backend, which is never served to the model.

#### Scenario: Caller-built target

- **WHEN** the caller passes a factory building a workflow-governed agent with its own host tools and the tool-mock middleware
- **THEN** every case runs against it, the default target is not built, and declared mocks bind through it

#### Scenario: Target without a workflow refused

- **WHEN** the supplied target has no `workflow` surface
- **THEN** `runTests` throws before any case, with the same message `createCaseTarget` raises

#### Scenario: Caller names the session

- **WHEN** `sessionIdForCase` returns `case-<file>`
- **THEN** the case drives that session, `onCaseStart` receives it, and `CaseResult.sessionId` reports it

### Requirement: The `@archmax-ai/harness/testing` surface returns data

The subpath SHALL export `runTests`, `discoverCases(authoring, testsDir)`, `runCase({ discovered, agent, authoring, testsDir, sessionId, grade?, caseTimeoutMs? })`, `reduceVerdict`, `exitCodeForVerdict`, `assertWorkflowGovernedTarget`, `createCaseTarget`, `parseCaseDocument(file, source, testsDir)`, `serializeCaseDocument(doc)`, `CASE_TITLE_MAX_LENGTH`, `CASE_DESCRIPTION_MAX_LENGTH`, `CaseSchemaError`, `createToolMockMiddleware` and `partialMatch`, with the types `CaseResult`, `AssertionRecord`, `AssertionStatus`, `CaseVerdict`, `CaseStatus`, `RunTestsOptions`, `RunTestsResult`, `SuiteSkip`, `DiscoveredCase`, `RunCaseOptions`, `CaseTargetOptions`, `CaseDocument`, `CaseStep`, `CaseExpectation`, `CaseTriggerDecl` and `CaseWorkspaceEntry`. `serializeCaseDocument` SHALL be the inverse of `parseCaseDocument`: YAML in the grammar's key order (`title`, `description`, `skip`, `trigger`, `variables`, `workspace`, `mocks`, `steps`), reply tokens in their `/pattern/flags` spelling, and `parse(serialize(doc))` deep-equal to `doc` for every document the grammar accepts; comments are not preserved. The engine prints nothing of its own: results are data for the CLI's test view or a host reporter. A `CaseResult` carries `id`, `title`, `description`, `sessionId?`, `verdict`, `records`, `skipReason?` and `error?`.

#### Scenario: Host runs a suite in CI

- **WHEN** a host calls `runTests({ workflow, rootDir, createTarget, onCaseResult })`
- **THEN** it receives every `CaseResult` as it settles and a `RunTestsResult` with `results`, `exitCode` and `discovered`, and nothing is written to the console by the engine

#### Scenario: Host parses a case itself

- **WHEN** a host calls `parseCaseDocument` on a well-formed document
- **THEN** it receives the `CaseDocument` with collapsed `title`/`description`, normalized `mocks`, and `steps` split into actions and assertions

#### Scenario: Host writes a case back

- **WHEN** a host edits a parsed `CaseDocument` and calls `serializeCaseDocument` on it
- **THEN** parsing the result yields a document deep-equal to the edited one, with the keys in the grammar's order
