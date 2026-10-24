## MODIFIED Requirements

### Requirement: Case-level variable seeds

A case MAY declare a top-level `variables:` mapping; each name SHALL match the variable-name shape (lowercase letters, digits and underscores, starting with a letter) or parsing fails naming it. The seeds are supplied with every `send` of the case as host seeds, so the runtime stores them locked exactly as a production host seed: a `${{…}}` guard reference resolves from them, a `requires:` gate is satisfied by them, code-state scripts and graders observe them, the model cannot rewrite them, and a `variables` assertion sees them as locked. This is how a case supplies a trigger-started workflow's payload, since `trigger` carries only an id.

#### Scenario: Seed observed as locked

- **WHEN** a case seeds `from_email: "a@b.com"` and asserts `variables: { expect: { from_email: "a@b.com" }, locked: { from_email: true } }`
- **THEN** both records pass

#### Scenario: Invalid name rejected

- **WHEN** a case seeds a variable named `From-Email`
- **THEN** parsing fails naming the required shape

#### Scenario: A code state reads a seed

- **WHEN** a case seeds `from_email: "a@b.com"` and the workflow's entry state is a code state
- **THEN** its script receives `from_email` in its `variables`, and its `archmax_set_variables` of
  `from_email` is refused as a write to a locked variable

### Requirement: Declarative tool mocks

A case MAY declare `mocks:` as a list of `{ tool, whenInput?, result }` entries. A mock matches a call by tool name and, when `whenInput` is given, by partial match against the call's arguments; the first matching mock in declaration order wins, so a narrower entry declared earlier shadows a broader one. A string `result` is the tool's payload verbatim and any other value is JSON-serialized. The mocks ride each driven `send` in the run configuration and SHALL intercept both agent-initiated tool calls (the tool-mock middleware) and every call the PTC gateway governs — the calls an agent's script makes through `tools.*`, the calls a code state's script makes through `tools.*`, and a grader's calls — so a mock means one thing whoever makes the call.

#### Scenario: Agent call mocked

- **WHEN** a case mocks `crm_lookup` with `whenInput: { email: "a@acme.test" }` and the model calls it with that email
- **THEN** the call settles with the mocked result and the real tool never runs

#### Scenario: Script call mocked

- **WHEN** the driven agent runs a script calling `tools.readFile(...)` with input matching a `read_file` mock
- **THEN** the script receives the mocked result

#### Scenario: Code state call mocked

- **WHEN** a code state's script calls `tools.crm_lookup({ email: "a@acme.test" })` and the case
  mocks `crm_lookup` with `whenInput: { email: "a@acme.test" }`
- **THEN** the script receives the mocked result and the real tool never runs

#### Scenario: Grader call mocked

- **WHEN** a grader calls `read_file` with input matching a `read_file` mock
- **THEN** the grader is answered with the mocked result and the real tool never runs

### Requirement: Structural assertions read the session's trail and park

The engine SHALL evaluate these assertions from the view's audit trail, park state and exit record: `succeeded: true` (the turn neither parked, nor ended with `archmax_raise`, nor recorded a failed tool call; a governance rejection is not a failure); `parked: true` (parked on either channel), `parked: decision` / `parked: input` (pinning the channel) or `parked: { channel?, state? }` (pinning the channel and/or the state the session parked in — which `reachedState` cannot express, since a park commits no transition); `raised: true` (the turn ended with `archmax_raise`), `raised: <code>` (pinning the exit code exactly) or `raised: { code?, reason? }` (pinning the code exactly and/or matching the reason with the one partial-match vocabulary, a `/pattern/flags` string included); `reachedState: <slug>` (a committed trail step of any kind but `trigger` has `to` equal to the slug, so a session reaches its start state only by moving into it, never by its trigger arrival); `noTraversal: true` (every trail step is a trigger arrival); `triggerArrival: <id>` (a `trigger` step carries that id as its `reason`, including one delivered into a park); `trail: { to?, kind?, reason?, count }` (at least one field, `kind` compared exactly with a step's kind, and the number of steps matching every given field equals `count`). An `raised` mapping with neither field, or an `raised` value of any other shape, SHALL be a schema error.

These assertions SHALL read an automated state's outcome as they read the agent's. A grader's or a code state's move commits a trail step of kind `grader` or `code` (see `automated-states`), beside the kinds `trigger`, `agent`, `human`, `sub-workflow`, `reset` and `on_error`: `reachedState` reaches its target, `trail` matches it by `kind: grader` or `kind: code` and by the `reason` the state passed to `archmax_advance`, and `noTraversal` counts it as a traversal. A raise by a grader or a code state ends the session as the agent's raise does, so `raised` reads its code and reason and `succeeded` fails.

#### Scenario: Park pinned to channel and state

- **WHEN** a turn parks via `archmax_wait` in `clarify`
- **THEN** `parked: input` and `parked: { channel: input, state: clarify }` pass, while `parked: decision` and `parked: { state: review }` fail with the pinned fields in their detail

#### Scenario: Vetoed entry commits no transition

- **WHEN** the start state is a code state screening the request, and its script refuses it with
  `tools.archmax_raise({ code: "not-a-customer", reason: "The sender is not a customer." })`
- **THEN** `noTraversal: true` and `raised: not-a-customer` pass, while
  `reachedState: <start state>` and `succeeded: true` fail

#### Scenario: An automated state's move is a traversal

- **WHEN** the entry code state `screen-request` advances to `identify-case` with the reason
  `requester verified`
- **THEN** `reachedState: identify-case` and
  `trail: { kind: code, to: identify-case, reason: "requester verified", count: 1 }` pass, and
  `noTraversal: true` fails

#### Scenario: A grader's send-backs are counted

- **WHEN** the grader state `review-reply` sends the session back to `orders-question` twice and then
  approves to `answered`
- **THEN** `trail: { kind: grader, to: orders-question, count: 2 }` and
  `trail: { kind: grader, to: answered, count: 1 }` pass

#### Scenario: Trail counting

- **WHEN** a refine loop entered `refund-review` twice and a step declares `trail: { to: refund-review, count: 2 }`
- **THEN** the assertion passes, and its detail reports the expected and observed counts on a miss

#### Scenario: Raise pinned to its code

- **WHEN** a turn ends with `archmax_raise({ code: "orders-unavailable", reason: "The orders API is down." })`
- **THEN** `raised: true`, `raised: orders-unavailable` and `raised: { reason: "/api is down/i" }`
  pass, while `raised: order-not-found` and `succeeded: true` fail with the observed code in their
  detail

#### Scenario: No raise

- **WHEN** a turn completes without `archmax_raise`
- **THEN** `raised: true` fails, with a detail saying the session did not raise

### Requirement: Content assertions read the transcript and tool calls

The engine SHALL evaluate `reply: { includes?, excludes? }` (at least one, each a token or list of tokens; a plain token is a substring, a `/pattern/flags` token a regex) against the whole assistant transcript of the turn — every completed assistant message joined, not only the final reply — producing one `reply.includes` / `reply.excludes` record per token; `calledTool: { name, input? }` (some recorded call has that name and its arguments partially match `input`); `notCalledTool` (no such call); `blockedTool` (a matching call was made and governance rejected it — distinct from a call that never happened and from a tool that ran and errored); `usedNoTools: true` (the turn recorded no tool calls); and `ranWorkflow: { workflow, status?, count? }` (the trail's `sub-workflow` steps for that slug with `status`, default `ok`: at least one, or exactly `count`, whoever dispatched — the agent, a script, a code state or a grader). Tool-call matching compares the arguments as the transcript records them — a `${{name}}` reference in reference form, not its resolved value.

`reply` and the tool-call assertions (`calledTool`, `notCalledTool`, `blockedTool`, `usedNoTools`) SHALL read the session's transcript and nothing else, so they see the session's agent's own messages and tool calls. An automated state's calls are not in the transcript (see `automated-states`): a code state's script calls its tools through `tools.*`, as an agent's script does, and a grader's messages and calls stay in its isolated context. These assertions SHALL NOT count them, so a turn whose only tool calls were an automated state's passes `usedNoTools: true`. A runtime note, the `grader` and `code` kinds included, is neither a tool call nor part of the reply. What an automated state did SHALL be asserted from what it committed: its move and its reason in the trail (`reachedState`, `trail`), its raise (`raised`), the variables it set (`variables`) and its dispatches (`ranWorkflow`).

#### Scenario: Reply tokens over the whole turn

- **WHEN** a turn says "Looking into it", calls a tool, then parks with "This is with a reviewer"
- **THEN** `reply: { includes: ["Looking", "/reviewer/i"], excludes: ["ORD-2001"] }` produces three records, all passing

#### Scenario: Blocked is not merely uncalled

- **WHEN** the agent's `read_file` of a refund-policy path was refused by governance
- **THEN** `blockedTool: { name: read_file, input: { file_path: "/refund-policy/" } }` passes, `calledTool` with the same input passes, and `notCalledTool` fails

#### Scenario: Assertion states the reference the model emitted

- **WHEN** the model calls `send_reply({ body: "ref ${{order_id}}" })`
- **THEN** `calledTool: { name: send_reply, input: { body: "ref ${{order_id}}" } }` passes

#### Scenario: A code state's calls are not the agent's

- **WHEN** an entry code state's script calls `tools.read_file(...)` and advances to an agent state
  whose model answers without calling a tool
- **THEN** `usedNoTools: true` passes and `calledTool: { name: read_file }` fails, while
  `trail: { kind: code, count: 1 }` passes

#### Scenario: A grader's words are not the reply

- **WHEN** a grader calls `archmax_get_history`, writes "the tone is curt" in text and sends the
  session back with a correction, and the agent then answers without repeating those words
- **THEN** `reply: { includes: "the tone is curt" }` and `calledTool: { name: archmax_get_history }`
  fail, and `trail: { kind: grader, count: 1 }` passes

#### Scenario: A code state's dispatch is on the record

- **WHEN** a code state's script calls `tools.archmaxWorkflowEnrichOrder({ order_id })` and the
  child completes
- **THEN** `ranWorkflow: { workflow: enrich-order }` passes, and `calledTool` with the delegation
  tool's name fails
