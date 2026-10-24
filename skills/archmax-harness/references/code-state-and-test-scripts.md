# Code-state scripts & cases — full reference

The complete contract and worked examples for the two authored surfaces this
reference covers:

1. **Code-state scripts** (`workflows/<slug>/scripts/*.js` — beside the spec
   that wires them, on the **authoring plane**) — the scripts a `type: code`
   state runs, **hand-authored** `.js` files. `workflow.yaml` wires
   `script: scripts/<name>.js` on the code state: the path is
   **workflow-relative**, confined to that workflow's `scripts/` directory and
   ends in `.js` or `.mjs`, so it resolves to `workflows/<slug>/scripts/<name>.js`.
   An absolute path, a `..` segment, or a path outside `scripts/` is a load error
   and a `validate` error. They run in the QuickJS sandbox: plain JavaScript with
   **top-level `await`**, no Node APIs, no filesystem beyond the `tools.*` bridge.

   **A code-state script is not an agent's script.** The runtime runs a code
   state; the agent runs an `archmax_run` source. The two live in different places
   on purpose — code-state scripts in `workflows/<slug>/scripts/`, runtime scripts
   in `skills/<capability>/scripts/` — and the classes cannot meet: the agent
   cannot read `workflows/**` at all, and `archmax_run` is confined to skill
   bundles by a non-overridable kernel rule (`script.skill-only`). An agent that
   could execute or read the check that judges its work could probe it for a
   bypass, which is the whole reason for the split. A code-state script's source
   never reaches the model: not in a prompt, not in an event, not in a session
   artifact — the next state reads the reason the script passed to
   `archmax_advance`, never its code.
2. **Cases** (`workflows/<name>/tests/*.test.yaml`) — declarative
   YAML documents run by `archmax test` and interpreted **host-side**: no
   sandbox executes a case. Suite config is the `tests:` block in
   `workflow.yaml` (there is no `tests.config.js`).

Sandbox scripts are self-contained: the only permitted imports are **typed
`@archmax-ai/harness/*` carriers** (stripped before evaluation — see
[Typed imports](#typed-imports)); importing from any other specifier is an
**error**. Each sandbox context gets its own globals — nothing leaks between
them (`SANDBOX_CONTRACT.context` is `"code"` for a code-state script, or `"ptc"`
for the agent's own `archmax_eval`/`archmax_run` code, which gets **no**
`defineCodeState`; `SANDBOX_CONTRACT.version` is `3`).

## Contents

- [Typed imports](#typed-imports)
- [Part 1 — Code-state scripts and agent scripts](#part-1--code-state-scripts-and-agent-scripts)
  - [Authoring model: hand-authored](#authoring-model-hand-authored)
  - [The code-state script contract](#the-code-state-script-contract)
  - [Governance of `tools.*` calls](#governance-of-tools-calls)
  - [`archmax_run` scripts: the `args` contract](#archmax_run-scripts-the-args-contract)
  - [Scripts and sub-workflow fan-out](#scripts-and-sub-workflow-fan-out)
  - [Worked example: a check in front of a state](#worked-example-a-check-in-front-of-a-state)
  - [Worked example: a check behind a state](#worked-example-a-check-behind-a-state)
  - [Worked example: approve, then end](#worked-example-approve-then-end)
  - [When to use a grader state instead](#when-to-use-a-grader-state-instead)
- [Part 2 — Cases (declarative YAML)](#part-2--cases-declarative-yaml)
  - [Layout and the prose rules](#layout-and-the-prose-rules)
  - [Suite config: the `tests:` block](#suite-config-the-tests-block)
  - [Top-level keys](#top-level-keys)
  - [Step entries: one flat script](#step-entries-one-flat-script)
  - [Assertion grammar](#assertion-grammar)
  - [Structural assertions halt the case](#structural-assertions-halt-the-case)
  - [Start conditions: trigger, variables, and workspace](#start-conditions-trigger-variables-and-workspace)
  - [Recovering a case's inputs from previous runs](#recovering-a-cases-inputs-from-previous-runs)
  - [File fixtures: `from:` references](#file-fixtures-from-references)
  - [Settle the mocking depth before writing a case](#settle-the-mocking-depth-before-writing-a-case)
  - [Worked example: happy path + grade](#worked-example-happy-path--grade)
  - [Worked example: declined at entry, leak check](#worked-example-declined-at-entry-leak-check)
  - [Worked example: mocking tool results](#worked-example-mocking-tool-results)
  - [Worked example: human-in-the-loop decisions (refine loop)](#worked-example-human-in-the-loop-decisions-refine-loop)
  - [Worked example: triggered start + fixture file](#worked-example-triggered-start--fixture-file)
  - [Migrating a JS case to YAML](#migrating-a-js-case-to-yaml)

---

## Typed imports

A code-state script may open with a **typed import** — a type carrier that gives
IDE completion for the state's input, and is **stripped before QuickJS
evaluation** (the runtime implementation is an identity):

```js
/** … */
import { defineCodeState } from "@archmax-ai/harness/sandbox";

export default defineCodeState(async ({ state, variables, messages, trail, toolCalls, tools }) => {
  /* ... */
});
```

The same subpath types the input (`CodeStateInput`, `CodeStateFn`,
`HistoryMessage`, `TrailStep`, `ToolCallRecord`, `ToolCallFilter`,
`SandboxTools`). Importing from any **non-`@archmax-ai/harness/*`** specifier is
an **error** — sandbox scripts are
self-contained. **Bare-globals authoring** (no import) is equally valid:
`defineCodeState` is a prelude global, and a plain
`export default async function ({ tools }) { … }` registers the same way.

---

## Part 1 — Code-state scripts and agent scripts

### Authoring model: hand-authored

A code state references an **ordinary hand-authored** `.js` file. You DESIGN AND
WRITE the script directly — there is no generation step. `workflow.yaml` only
wires it: the state's type, its script, and its transitions, which are where the
script may send the session:

```yaml
states:
  screen-request:
    type: code
    script: scripts/screen-request.js
    triggers:
      manual:
    skills:
      allow: [order-data]        # the script reads the order records: granted here
    on_error: escalation         # where a failure of the script routes
    transitions:
      - to: identify-case
        description: The requester is known and asks only about their own company's orders.
      - to: decline
        description: The request names no known requester, or reaches for another company's orders.
```

`script` is **required** on a code state and **refused** on every other type
(both load errors). A code state makes no model call, so `instructions`, `model`,
`budget`, `evidence` and `approvers` on one are `validate` errors: say what the
script does in its JSDoc block, and in the state's `summary`.

A code-state script **MUST** open with a leading JSDoc block — a title line, a
blank line, and a description of what the script does _and how_: the inputs it
reads, the sequence of checks, and **where it sends the session in each case**
(each `archmax_advance` target and why, each `archmax_raise` code). It is the only
human-facing contract the file has (admin UIs display it instead of the code), and
it is what a reviewer refines when the check is wrong. No `@specification` tag, no
`// archmax:generated` marker, no generation semantics. See
[SKILL.md → Workspace layout](../SKILL.md#workspace-layout-complete--nothing-else-exists).

- `archmax validate` reports a code-state script problem when the script **file
  is missing** from `scripts/` or it has a **foreign (non-`@archmax-ai/harness/*`)
  import**. It does **not** check the JSDoc block on any script — the header is
  an authoring standard you uphold yourself. (Cases are YAML; there
  `archmax validate` **errors** on a missing `description` instead.)
- The runtime never generates scripts: a missing script file at run time fails
  the state (fail-closed), routed through its `on_error`.

### The code-state script contract

When the session's position reaches a code state — the agent's `archmax_advance`
into it, another automated state's advance, a human decision, an `on_error`
route, a turn that opens there, an `archmax_reset` back to it — the runtime runs
its script **in place of the next model call**. The agent's model is not called
while the session stands in a code state, so a chain of code states makes no
model call at all. The script's **default export** is called with **one object**,
and the script **moves the session itself**:

```js
/**
 * Requester screen — reject a request whose requester is not a known customer.
 *
 * Reads the first user message from `messages`, extracts the first email
 * address in it, loads skills/order-data/assets/orders.json (this state enables
 * `order-data`), and looks the address up against every order's `email`.
 *
 * Advances to decline when the request carries no email address, and when the
 * address matches no order — each with a reason naming what was missing — and
 * otherwise to identify-case.
 */
import { defineCodeState } from "@archmax-ai/harness/sandbox";

export default defineCodeState(async ({ messages, tools }) => {
  const orders = JSON.parse(await tools.read_file({ file_path: "skills/order-data/assets/orders.json" }));
  const request = messages.find((m) => m.role === "user")?.text ?? "";
  const email = request.match(/[\w.+-]+@[\w.-]+/)?.[0];
  if (!email) return tools.archmax_advance({ to: "decline", reason: "No email address found in the request." });
  if (!orders.some((o) => o.email === email)) {
    return tools.archmax_advance({ to: "decline", reason: `"${email}" is not in the order database.` });
  }
  console.log(`Allowed: ${email}`);
  await tools.archmax_advance({ to: "identify-case", reason: `${email} is a known requester.` });
});
```

**The input** (`CodeStateInput` in `@archmax-ai/harness/sandbox`; the same fields
minus `tools` are also the global `args`):

| Field | Meaning |
| --- | --- |
| `state` | The code state's own slug. |
| `trigger` | The id **string** of the trigger the turn carries. It carries no payload — the session's input is in `variables`. |
| `variables` | The session's variables as a plain `name → value` map, including the built-in `trigger`. Structured values are present whole (`variables.order.items[0].sku`). **Read-only**: assigning changes nothing. Write with `tools.archmax_set_variables`, which holds locks, `title` and typed returns exactly as the agent's call does. |
| `messages` | The session's **whole** transcript, oldest first, as `{ role, text, toolCalls?, tool?, id?, note? }` — every visit and every turn, not only the visit that led here. `role` is `user`, `assistant`, `tool`, `system`, or **`runtime`** — a note the runtime wrote (an arrival, a decision, an error route, an automated state's move; `note` names the kind). A `tool` entry carries `tool` and the call's `id` with an empty `text`: its result comes from `toolCalls`. A script that reacts to narration matches `role === "runtime"`, never a `[bracket]` prefix in a user message. Not windowed: the sandbox's `maxResultChars` and `memoryLimitBytes` bound it. |
| `trail` | The session's **whole** trail, oldest first, as `{ to, kind, reason?, workflow?, status?, ts }`. `kind` is `trigger`, `agent`, `human`, `grader`, `code`, `sub-workflow`, `reset` or `on_error`. Count earlier rounds here: `trail.filter((s) => s.kind === "code" && s.to === "refund-request").length`. |
| `toolCalls(filter?)` | **Async.** The session's domain tool calls with their results, across every visit, oldest first, as `{ id?, name, args, result?, status, state, visit }`: `result` parsed when it is JSON and absent while `pending`; `status` `completed`, `failed`, `rejected` (by governance) or `pending`; `state` and `visit` (numbered from 1) those of the message that made the call. `filter` narrows by `name`, `state`, `visit` (a visit's **number**), `status` and `last` (only the last N matches); every key given must match, and an unknown key is refused. The control tools are not in it, nor are calls a script made through `tools.*` (the agent's or a code state's): only calls the transcript holds. Only the records it returns are copied into the sandbox. |
| `tools` | **Exactly this state's tool surface** (async): its grants (the workflow-wide grant included), the host's essential tools, and its controls. A tool answers to its own name (`tools.read_file`, `tools["archmax_workflow_enrich-order"]`) and to its camelCased key (`tools.readFile`); `Object.keys(tools)` lists the camelCased keys. **A name outside the surface is `undefined`.** See [Governance](#governance-of-tools-calls). |

**What a code state checks.** The conversation is the model's memory, not
evidence: a code state checks the session's records — `variables`, files, and
the tool results `toolCalls` keeps as the tools returned them. Check a result
itself, never a copy the model wrote into a variable or its reply, and never call
a tool again just to see its result (for a host whose tools reach an external
system, that is a second action):

```js
/**
 * Status check — the reply must give the order's status as get_order returned it.
 *
 * Reads the last completed get_order call from toolCalls and the agent's last
 * message with text. Advances to answered when the reply names that status;
 * otherwise back to answer-order, with the status to give, or with a request to
 * look the order up when no get_order call completed.
 */
import { defineCodeState } from "@archmax-ai/harness/sandbox";

export default defineCodeState(async ({ messages, toolCalls, tools }) => {
  const [lookup] = await toolCalls({ name: "get_order", status: "completed", last: 1 });
  if (!lookup) {
    return tools.archmax_advance({ to: "answer-order", reason: "Look the order up with get_order before answering." });
  }
  const reply = messages.findLast((m) => m.role === "assistant" && m.text)?.text ?? "";
  const status = lookup.result.status;
  if (!reply.includes(status)) {
    return tools.archmax_advance({ to: "answer-order", reason: `Order ${lookup.args.id} is ${status}: say so exactly.` });
  }
  await tools.archmax_advance({ to: "answered", reason: `The reply gives the status ${status}.` });
});
```

A code state sees the whole session, so where only the graded state's latest
visit counts, narrow by that visit's number, read from a record:
`const [last] = await toolCalls({ state: "answer-order", last: 1 })`, then
`toolCalls({ state: "answer-order", visit: last.visit })`. What a later state or
turn needs from the conversation (the person's words, a decision) is still best
stored in a variable or a file by the state that has it, so no check has to
search the transcript for it.

**The controls** on `tools`:

| Control | Effect |
| --- | --- |
| `archmax_advance({ to, reason, evidence? })` | Records the move along one of the state's transitions. Checked **at the call**: an undeclared `to` or an unmet `requires` rejects naming the valid targets or the missing variable, and the script may catch it and decide otherwise. `evidence` is accepted only into a human state. The `reason` is what the next state reads. Absent in a terminal state. |
| `archmax_raise({ code, reason })` | Records the end of the session as **failed**, with the code and reason as its outcome's `exit`. |
| `archmax_get_variables({ name?, path? })` / `archmax_set_variables({ variables, lock? })` | Read and write the session's variables, as the agent's calls do. A write is visible to the script's later calls, so a script can set what `requires` asks for and then advance. |

There is no `archmax_wait` and no `archmax_reset`: a code state cannot park, since a
script frame is not durable. To hand work to a person, advance into a human state.

**How the run settles** — exactly one outcome:

| The run… | Outcome |
| --- | --- |
| called `archmax_advance` and finished cleanly | **advanced**: the session moves. The trail records `{ to, kind: "code", reason }`, and a runtime note carries the reason to the next state: `[code] '<state>' moved the run to '<to>': <reason>. You are now in '<to>'.` Into a human state the session parks after the one reply-only handoff message. Into another automated state, that state runs next, still with no model call. |
| called `archmax_raise` | **raised**: the session ends `failed` — no `on_error`, no `returns` check, nothing further runs in the turn. |
| finished without either, in a **terminal** state | **completed**: the session completes, held to the trigger's `returns`. |
| threw, timed out, could not be read, imported a foreign module, or — in a **non-terminal** state — finished without either call | **failed**: routed through the state's `on_error`, else the session ends rejected. Finishing undecided fails with `code state '<slug>' finished without calling archmax_advance or archmax_raise`. |

Three rules hold the outcomes apart:

- **The return value is not read.** Returning `false`, a string or an object does
  nothing; there is no verdict to return. Only the controls decide.
- **One decision per run.** The first accepted `archmax_advance` or `archmax_raise`
  is the state's decision, and every later one is refused (it rejects).
- **The decision takes effect when the script finishes.** A script that advances
  and then throws **fails**, and the session does not move. A raise wins over a
  later error.

So parse defensively where malformed input should *send the work back*, and let a
genuine infrastructure failure (an unreadable database) throw, so the state fails
closed through its `on_error`.

Other globals: `console.log(...)` (each line a `code-output` event, which the CLI's
state flow prints under the state), and `defineCodeState(fn)`, an alias for
`export default fn`. A file with **no default export** is evaluated as a plain
script: it reads the input from the global `args` and calls the global `tools`.
**Each run starts clean**: a fresh REPL every time the state is entered, shared
with neither the agent's `archmax_eval` nor another code state. The script is one
evaluation, so `settings.timeoutMs` (default 15000), `memoryLimitBytes`,
`maxPtcCalls` and `maxResultChars` bound it whole, and a cancelled turn stops it at
once.

`${{…}}` does not apply inside a script: the runtime substitutes references in the
arguments a *model* writes. A script already has the values in `variables` and
composes strings in JavaScript, so `${{…}}` text in a script's `tools.*` call is
ordinary data.

### Governance of `tools.*` calls

Every `tools.*` call is checked by the decision kernel at the moment it runs —
the same kernel, with the same rules, that governs a tool call the model makes
directly. There is no runtime authority for scripts: **both kinds are governed
against the state they run in.**

| Script kind | Governed against | Must be granted there |
| --- | --- | --- |
| Code-state script (`type: code`) | its own code state: `tools.allow`/`forbid`, `skills.*`, `mounts.*`, plus `allow_always`, `forbid_always`, safety rules, consumer rules | every tool, skill and governed mount it uses |
| `archmax_run` / `archmax_eval` script (the model chose to run it) | the agent's active state, exactly as the model's own calls | every tool it calls |

So a code state that reads `skills/order-data/assets/orders.json` enables
`order-data` in its own `skills.allow`, and one that calls a host tool names it in
its own `tools.allow`. A tool another state grants is `undefined` on its `tools`;
a bare `forbid` entry removes a tool from it, and a guarded one (`{ tool:
write_file, paths: [...] }`) refuses the matching calls. A grant on a code state
naming `write_todos`, `archmax_eval`, `archmax_run`, `archmax_wait` or
`archmax_reset` is a `validate` error: no automated state is offered them, and
the same tools in the workflow's `allow_always` are left out of its surface.

Mounts work the same way: a governed mount is reachable from a code state only
when `mounts.allow_always` or that state's own `mounts.allow` grants it, and
writable only where the grant asks `access: read_write`:

```js
// workflow.yaml: states.check-contract.mounts.allow: [contracts]
const policy = await tools.read_file({ file_path: "contracts/policy.md" });
```

Neither kind may **read** the authoring plane at all. A `tools.*` call naming
`workflows/**` is blocked (`zone.governance-plane`) with a diagnostic naming the
prefix — a script cannot read its own spec, a sibling's, or a grader's
criteria. There is no `task()` in any sandbox context and no `tools.task`: work
that needs a model's judgment is a grader state on the graph.

A refused call **rejects** inside the script, carrying the governance reason.
The underlying tool never runs whether or not you catch it:

```js
try {
  await tools.write_file({ file_path: "scratchpad/report.md", content: body });
} catch (err) {
  console.log(`could not write the report: ${err.message}`);
}
```

A **binary file** is not a refusal and does not throw: reads are text only, so
`tools.read_file` on an image, audio, video, PDF or PowerPoint file, or on any
file whose content holds a NUL byte (an archive, an Office document), resolves to
the notice `Error: '<path>' is a binary file (<type>, <size>) and was not read;
read_file returns text files only.` instead of content — an image too, even when
the host turned on `images`, which shows images to the model only. XML and JSON
are text even when the store labels them `application/xml` or a `+xml`/`+json`
type, so an Office document's unpacked `word/document.xml` reads as text. A missing file reads as
an `Error: …` string the same way. A script that parses what it read checks
first:

```js
const text = await tools.read_file({ file_path: "scratchpad/upload.json" });
const upload = text.startsWith("Error:") ? null : JSON.parse(text);
```

To **duplicate, move or delete** a file — a template, an image, a `.docx` —
call `tools.copy_file({ source, destination, overwrite? })`,
`tools.move_file({ source, destination, overwrite? })` or
`tools.remove_file({ file_path })` instead of reading and writing it back. The
bytes move, binary files included, with no `read_file` line limit, and each
call resolves to one line (`Copied '<source>' to '<destination>' (<size>).`,
`Moved …`, `Removed '<path>'.`). They are governed by their declared paths like
any other call, so a governance refusal (a destination in a read-only mount, a
disabled skill's file) rejects. A failure the operation itself meets (a missing
source, a directory, an existing destination without `overwrite: true`)
resolves to an `Error: …` string instead.

**Authoring rule for every script:** if sandboxed code calls `tools.X`, the state
it runs in must cover `tool: X` (with any argument constraints the call
satisfies), or `tools.X` is `undefined` (or the call rejects). Grant it per state
with `tools.allow`, or workflow-wide with `tools.allow_always`; a default tool such
as `read_file` is covered wherever the workflow-wide grant includes it.

### `archmax_run` scripts: the `args` contract

An `archmax_run` source (`skills/<capability>/scripts/*.js`) is a plain script:
top-level `await`, `tools.*`, `console.log`, and the **last expression** is its
result — returned to the model as the tool result, never into the variable
store. It reads its input from the global **`args`**:

- **the arguments the model passed** to `archmax_run` (`args.<name>`), plus
- **`args.variables`** — the session's variables as a flat `name → value` map,
  the same map a code state gets. The runtime supplies it on every call, so a
  script reads the run's input (a seeded list, a delivered payload) without the
  model having to retype it.

```js
/** One sub-run per requested order. */
const orders = args.variables?.orders_to_enrich ?? [];
```

`args.variables` is a read-only snapshot; a script that must persist a result
returns it and the state's `requires:` makes the model record it with
`archmax_set_variables`. An agent's script reaches **no control tool** — not
`archmax_advance`, not the variable tools — and there is **no `task()`** in an
`archmax_run` script or in `archmax_eval`. The model has no `task` tool at all: it
is disclosed in no state and grantable by nothing, because judging work is a
grader state and delegating it is a sub-workflow.

### Scripts and sub-workflow fan-out

A script **is** the deterministic way to drive a fan-out. Delegation tools are on the `tools.*`
surface — a delegation does work and returns a value, unlike the control tools an agent's script
may never call — so a script decides how many sub-runs to start, with what inputs, and what to do
with each answer:

```js
/** One sub-run per delayed order, all in flight at once. */
const orders = args.variables?.orders_to_enrich ?? [];

const enriched = await Promise.all(
  // The bridge camelCases tool names, and a tool result arrives as text.
  orders.map(async (o) => {
    const answer = await tools.archmaxWorkflowEnrichOrder({ order_id: o.order_id });
    return { order_id: o.order_id, ...JSON.parse(answer).returns };
  }),
);

enriched;
```

`Promise.all` genuinely parallelizes: the bridge starts each host call detached and returns its
promise handle immediately. The runtime still bounds how many sub-runs are in flight
(the dispatcher's `maxConcurrent`), queueing the rest. The list never enters the model's
context. A code state may drive the same fan-out when its own state grants the delegation tool,
and then record the results itself with `tools.archmax_set_variables` before it advances.

Two limits still hold, both inherited rather than special to delegation. A script may only call a
delegation tool its **calling state** allows — the same kernel verdict an agent's call gets. And a
script's delegation **cannot park**: a QuickJS frame is not durable, so a child that reaches a human
state fails that call closed with `parked`.

An agent's script still may not call `archmax_advance` (moving the state machine is the model's
governed decision) or `archmax_set_variables`. Concurrent calls succeed or fail **independently**,
so a script can act on what worked — `Promise.allSettled` is the honest shape when partial success
is meaningful. Each sub-run is its own session with its own `scratchpad/`, so concurrent sub-runs
never collide on a path; a `file` return comes back as a copy under a name no other file holds.

A script lives as long as its turn. When the host cancels the turn, a call still in flight fails
with `Tool '<name>' failed: the turn was aborted`, and every call the script makes after that is
refused the same way before it reaches the tool. A retry in a `catch` therefore dispatches nothing
more, so there is no need to tell a cancel apart from an ordinary failure. Code-state scripts stop
the same way.

### Worked example: a check in front of a state

To screen every request before any model call, make the trigger's entry state a
code state that advances to where the work starts, or to a state that declines it.
The bundled example's `screen-request` (`workflows/order-lookup/scripts/screen-request.js`)
merges a requester check and a tenancy check — wired as in
[Authoring model](#authoring-model-hand-authored), with `decline` a terminal agent
state that tells the person why:

```js
/**
 * Request screen — the requester must be known, and may only reach their own
 * company's orders.
 *
 * Binds the requester's email (the first one in the first user message) to the
 * customers whose orders carry it in skills/order-data/assets/orders.json, then
 * checks the request two ways: it names another customer, or it references an
 * order id (`ORD-…`) owned by another customer. Matching is case-insensitive.
 *
 * Advances to decline — with the reason the decline state tells the person — when
 * there is no email, the email is unknown, or either tenancy check finds a
 * foreign customer; otherwise to identify-case. An order database that cannot
 * be read throws: the state fails closed through its on_error.
 */
import { defineCodeState } from "@archmax-ai/harness/sandbox";

export default defineCodeState(async ({ messages, tools }) => {
  const orders = JSON.parse(await tools.read_file({ file_path: "skills/order-data/assets/orders.json" }));
  if (!Array.isArray(orders)) throw new Error("skills/order-data/assets/orders.json is not a list of orders");

  const request = messages.find((m) => m.role === "user")?.text ?? "";
  const email = (request.match(/[\w.+-]+@[\w.-]+\.\w{2,}/)?.[0] ?? "").toLowerCase();
  if (!email) {
    return tools.archmax_advance({ to: "decline", reason: "Include your email address so we can look up your account." });
  }
  const own = new Set(
    orders.filter((o) => String(o.email).toLowerCase() === email).map((o) => String(o.customer)),
  );
  if (own.size === 0) {
    return tools.archmax_advance({ to: "decline", reason: `"${email}" is not in the order database.` });
  }

  const lower = request.toLowerCase();
  const foreignByName = [...new Set(orders.map((o) => String(o.customer)))].filter(
    (name) => !own.has(name) && lower.includes(name.toLowerCase()),
  );
  const referenced = new Set((request.match(/\bORD-\d+\b/gi) ?? []).map((id) => id.toUpperCase()));
  const foreignById = orders
    .filter((o) => referenced.has(String(o.id).toUpperCase()) && !own.has(String(o.customer)))
    .map((o) => String(o.id));

  if (foreignByName.length > 0 || foreignById.length > 0) {
    return tools.archmax_advance({
      to: "decline",
      reason: `"${email}" may only view orders for its own account. Do not name the other customer's orders.`,
    });
  }
  await tools.archmax_advance({ to: "identify-case", reason: `${email} is authorized for ${[...own].join(", ")}.` });
});
```

The pattern to internalize: **one `archmax_advance` per outcome, each with a
`reason` the next state can act on** (the `decline` agent reads it from the `[code]`
note and tells the person); `console.log` for anything worth seeing in a verbose
run; a `throw` for what should fail the state rather than route it. To end the
session as a failure instead, with no reply at all, call
`tools.archmax_raise({ code: "unknown-requester", reason })`.

### Worked example: a check behind a state

To check the agent's work before the session moves on, route the agent's
transition into a code state, and give that state an edge onward and an edge
**back**. The bundled example's `check-refund` sits between `refund-request` (the
agent records a decision) and `refund-review` (a person reviews it), so a decision
the policy forbids never reaches the reviewer:

```yaml
states:
  refund-request:
    instructions: >-
      … Record the decision in scratchpad/refund.json, tell the customer, and in
      that same message archmax_advance to check-refund. If the check sends the
      case back, its note names the fix: correct the file and advance again.
    skills:
      allow: [order-data, refund-policy]
    transitions:
      - to: check-refund
        description: The refund decision has been recorded and explained to the customer.
  check-refund:
    type: code
    script: scripts/check-refund.js
    skills:
      allow: [order-data]
    on_error: escalation
    transitions:
      - to: refund-review
        description: The recorded decision matches the refund policy.
      - to: refund-request
        description: The recorded decision contradicts the policy; send it back with the fix.
      - to: escalation
        description: The decision still fails the check after two corrections.
```

The check (`workflows/order-lookup/scripts/check-refund.js`), which counts its own
earlier send-backs on the trail and escalates on the third:

```js
/**
 * Refund policy check — the agent may not hand a refund the policy forbids to
 * the reviewer.
 *
 * Re-derives the refund decision from the order database instead of trusting
 * the one the agent wrote. Reads the recorded ticket from scratchpad/refund.json
 * ({ orderId, decision }), then reads skills/order-data/assets/orders.json and
 * looks the order id up, case-insensitively, against each record's `id`.
 *
 * Policy: a refund is "approved" only when the order exists with status
 * delivered or delayed; an unknown order and any other status must be "denied".
 *
 * Advances to refund-review when the recorded decision matches. Otherwise sends
 * the session back to refund-request with a reason naming the fix — the ticket
 * missing or unparseable, `decision` not "approved"/"denied", or the decision
 * contradicting the policy — and, once it has sent it back twice (counted on
 * the trail), advances to escalation instead. An unreadable order database
 * throws: the state fails through its on_error.
 */
import { defineCodeState } from "@archmax-ai/harness/sandbox";

const MAX_SEND_BACKS = 2;

export default defineCodeState(async ({ trail, tools }) => {
  const sentBack = trail.filter((s) => s.kind === "code" && s.to === "refund-request").length;
  const sendBack = (reason) =>
    sentBack >= MAX_SEND_BACKS
      ? tools.archmax_advance({ to: "escalation", reason: `Still failing after ${sentBack} corrections: ${reason}` })
      : tools.archmax_advance({ to: "refund-request", reason });

  let refund;
  try {
    refund = JSON.parse(await tools.read_file({ file_path: "scratchpad/refund.json" }));
  } catch (e) {
    return sendBack(`scratchpad/refund.json could not be read or parsed (${e.message}) - write it as a JSON object with "orderId" and "decision", then advance again`);
  }
  const decision = refund?.decision;
  if (decision !== "approved" && decision !== "denied") {
    return sendBack(`scratchpad/refund.json "decision" must be exactly "approved" or "denied"; got ${JSON.stringify(decision)}`);
  }

  const orders = JSON.parse(await tools.read_file({ file_path: "skills/order-data/assets/orders.json" }));
  const wanted = typeof refund.orderId === "string" ? refund.orderId.trim().toLowerCase() : "";
  const order = orders.find((o) => typeof o?.id === "string" && o.id.toLowerCase() === wanted);
  const derived = order && ["delivered", "delayed"].includes(order.status) ? "approved" : "denied";
  console.log(`Refund policy check - derived "${derived}", recorded "${decision}"`);

  if (decision === derived) {
    return tools.archmax_advance({ to: "refund-review", reason: `"${decision}" for ${refund.orderId} matches the refund policy.` });
  }
  const why = !order ? "it does not exist in the order database" : `its status is "${order.status}"`;
  return sendBack(
    `Policy requires "${derived}" for order ${JSON.stringify(refund.orderId)} because ${why}, but the recorded decision is "${decision}" - update scratchpad/refund.json to decision: "${derived}", correct what you told the customer, and advance again`,
  );
});
```

Note how the send-back reasons carry the _fix_: the agent reads the reason as a
`[code]` note, rewrites `scratchpad/refund.json`, and advances again. There is no
retry budget to declare: the script counts the rounds itself, from `trail`, and
decides when to give up.

### Worked example: approve, then end

A check that approves into a terminal **agent** state costs one more model call:
that state's agent has to finish the turn. Approve into a **terminal code state**
instead. Its script runs and the session completes, with no further model call.
The bundled example's grader approves the order answer into `answered`:

```yaml
  answered:
    type: code
    script: scripts/answered.js     # no transitions: terminal
```

```js
/**
 * Approved-reply record — the end of the order-question path.
 *
 * Writes the last assistant message with text — the reply review-reply
 * approved — to scratchpad/answered.json as { "reply": "<text>" }, so a host has
 * the approved wording without reading the transcript, then returns: the
 * session completes.
 */
export default async function ({ messages, tools }) {
  const reply = messages.filter((m) => m.role === "assistant" && m.text.trim()).at(-1)?.text ?? "";
  // A follow-up in the same session reaches this state again: replace the old record.
  try {
    await tools.remove_file({ file_path: "scratchpad/answered.json" });
  } catch {
    // Nothing recorded yet.
  }
  await tools.write_file({ file_path: "scratchpad/answered.json", content: JSON.stringify({ reply }, null, 2) });
}
```

A terminal code state's completion is held to the trigger's `returns` like any
completion: set a declared return with `tools.archmax_set_variables` before the
script returns.

### When to use a grader state instead

Use a **code state** when the check is **deterministic** — derivable from
workspace data with plain code (policy tables, schema checks, cross-file
consistency). Use a **grader state** when the check requires **judgment** (is the
reply complete? is the tone right?). A grader is an isolated subagent the runtime
runs on entry: its system prompt is a compiled-in preamble followed by the state's
`instructions` (its criteria), it reads the session with `archmax_get_history`
(the whole transcript, the trail and every tool call with its result), and it
decides with `archmax_advance` along one of its transitions, or ends the session
with `archmax_raise`:

```yaml
states:
  orders-question:
    instructions: >-
      … Send the reply in a message that also calls archmax_advance to
      review-reply. If the review sends it back, its note names what to change:
      write a corrected reply and advance again.
    transitions:
      - to: review-reply
        description: The reply answering the question has been sent to the customer.
  review-reply:
    type: grader
    budget: { maxTurns: 4 }          # the grader's own model calls
    on_error: escalation             # a grader that fails or finishes undecided routes here
    instructions: |-
      Judge only the tone of the reply: the last assistant message with text in
      the history's messages.

      - Friendly and professional: advance to `answered`.
      - Curt, cold or blunt: advance back to `orders-question`, saying exactly
        what to change.
      - Count the trail's steps with kind "grader" and to "orders-question". If
        there are already two, raise `reply-tone` instead of sending it back.
    transitions:
      - to: answered                 # a terminal code state: approve, then end
        description: The reply is friendly and professional.
      - to: orders-question
        description: The reply's tone is off; send it back naming what to change.
```

What to know:

- A grader state **must** declare non-empty `instructions` and at least one
  transition (`validate` errors): a grader with nowhere to send the session could
  only approve by saying nothing, which would fail open. `evidence`, `approvers`
  and `budget.maxParks` are errors on it. Every edge **into** a grader carries a
  `description`: its instructions are criteria the work it judges is never shown,
  so an undescribed edge into one is a load error.
- `archmax_get_history` returns `{ messages, trail, toolCalls }`: the whole
  transcript (a `tool` entry carries `tool` and the call's `id` with an empty
  `text`), every trail step, and every domain tool call with its `args`,
  `result`, `status` (`completed`/`pending`/`failed`/`rejected`), `state` and
  `visit` — the same records a code state's `toolCalls()` returns, unfiltered. Not
  windowed: a grader judges the whole session, so its criteria say which part
  counts ("the last assistant message with text"). Check a claim against the tool
  result in `toolCalls`, never against the agent's retelling of it.
- There is **no visit threshold and no iteration budget**. A grader that should give
  up after N rounds says so in its `instructions` and counts the rounds from the
  history's trail (each earlier send-back is `{ kind: "grader", to: "<graded state>" }`),
  as above. The session's recursion limit is the only backstop.
- The grader is offered exactly its state's surface — its grants (never
  `write_todos`, `archmax_eval`, `archmax_run`, `archmax_wait` or `archmax_reset`,
  even when `allow_always` lists them), `archmax_advance`, `archmax_raise`, the variable tools and
  `archmax_get_history` — governed against the grader state. Its messages never
  enter the session's transcript and its tokens never stream; the session reads
  its decision as a `[grader]` note and a `kind: grader` trail step.
- A grader that answers in text without deciding **fails closed** (`grader state
  '<slug>' finished without calling archmax_advance or archmax_raise`), routed
  through `on_error`. `budget.maxTurns` / `timeoutMs` bound its own model calls,
  which spend nothing of the turn's `budget.maxModelCalls`.
- `model` on a grader state names the id it runs on, resolved through the
  assembly's `modelFactory` under the **`grader`** role.
- The graded state's `instructions` tell the agent to send its reply in the same
  message that advances to the grader, and to fix the work when a note sends it
  back — never to argue with the note. Once the grader has moved the session, the
  next thing the agent says replaces what it said before as the turn's `reply`: a
  draft sent back never reaches the person, and a draft the grader passed, with
  nothing said after it, is the reply.

---

## Part 2 — Cases (declarative YAML)

### Layout and the prose rules

```
workflows/<name>/tests/
  <case>.test.yaml       # ONE case per file (.test.yml also accepted)
  fixtures/…             # fixture files, reachable via `workspace: { <path>: { from: … } }`
```

- **One YAML document per file, one case per document — one conversation on
  one session.** The case id is the tests/-relative path minus the extension
  (`tests/refunds/approved.test.yaml` → case `refunds/approved`); the
  `archmax test` filter argument matches that path as a substring.
- **Cases are data, not code.** The host parses, validates, and interprets
  them directly — no QuickJS sandbox is created for a case. The sandbox still
  runs code-state scripts and `archmax_run` *inside the driven agent*, unchanged.
- **A case reads like a script.** `steps` is one flat sequential list where
  actions (`send`, `decide`) and assertions are peers; each assertion
  evaluates against the view of the nearest action above it.
- **Only YAML files are cases.** Discovery matches `*.test.yaml`/`*.test.yml`
  and nothing else: a leftover `*.test.js`/`*.test.ts` or `tests.config.js` is
  ignored **without a diagnostic**, so it neither runs nor warns. Delete such
  files once migrated (see
  [Migrating a JS case to YAML](#migrating-a-js-case-to-yaml)).
- **Unknown keys are errors.** Unknown top-level keys and step-entry keys
  fail validation — a typo'd `reachedstate:` can never silently pass. So do
  an assertion with no preceding action, a nested `expect:` block (assertions
  are steps themselves), and any multi-session key (`sessions`, `session`,
  `parallel` — "not part of test spec version 1"). `archmax validate`
  statically checks every case: schema and unknown keys, a missing or
  over-long `title`/`description`, malformed regex strings, unknown trigger
  ids, and `from:` fixture existence.
- **The title and description rules.** Every case declares two mandatory
  prose fields, both **length-capped and enforced** — over budget is an error,
  exactly like a missing field:
  - **`title`** — a short one-line label, **at most 60 characters**. It is
    what `archmax test` prints beside the verdict and what an admin UI lists,
    so it has to fit a line: name the behavior under test
    (`Unknown requester is rejected at entry`), not the mechanics.
  - **`description`** — **at most 200 characters**: one or two sentences
    stating the scenario driven and what is asserted. Not a transcript of the
    steps, which are right below it and read as a script already.
  - Everything longer goes in a **YAML comment above the document** — why the
    case exists, what a particular assertion is really pinning, what was
    deliberately mocked vs. left real, how the fixture is wired. The comment
    has no budget; use it freely.
  - Both budgets are measured on whitespace-collapsed text, so a folded
    (`>-`) and a literal (`|`) block of the same prose score alike.
  - Work title-first: write `title` and `description` before the steps, and
    never leave them contradicting each other. This replaces the JSDoc-header
    rule that applied to JS test files; JSDoc headers now apply to code-state
    scripts and `archmax_run` sources only.

Run with `archmax test <workflow> [filter]`. A minimal case:

```yaml
# The route assertion is the point: without it the case would still pass if
# the agent answered the order question straight from the start state.
title: Order question routed into handle-order
description: >-
  One turn asking about an order: the run succeeds and the audit trail
  committed the route into handle-order.
steps:
  - send: "What is the status of order ORD-1001?"
  - succeeded: true
  - reachedState: handle-order
```

### Suite config: the `tests:` block

Declarative data in `workflow.yaml` — never executed code:

```yaml
tests:
  maxConcurrency: 1 # cases run at a time (only 1 or absent is accepted)
  caseTimeoutMs:
    120000 # per-case WALL-CLOCK budget (default 120000) —
    # deliberately named differently from settings.timeoutMs,
    # the per-script sandbox budget
  judge: {} # the model that scores `grade:` ({} = env-configured
    # default model; or { model, modelOptions }) — not a grader state
```

There is no `reporters` option. A
`judge:` entry is required for cases that declare `grade:` assertions —
without it the assertion records an actionable failure instead of silently
passing.

### Top-level keys

Unknown keys are validation **errors**. All keys except `title` and
`description` are optional:

| Key           | Shape                                          | Meaning                                                                                                                                                                                                                                                                                                                             |
| ------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`       | string (**required**, ≤ 60 chars, one line)    | Short label naming the behavior under test — what `archmax test` prints beside the verdict. Missing, multi-line, or over budget ⇒ `archmax validate` **error**.                                                                                                                                                                          |
| `description` | string (**required**, ≤ 200 chars)             | One or two sentences: the scenario driven and what is asserted. Missing or over budget ⇒ `archmax validate` **error**. Longer rationale belongs in a YAML comment above the document.                                                                                                                                                   |
| `skip`        | string                                         | A reason; the case reports a skipped verdict and drives nothing.                                                                                                                                                                                                                                                                      |
| `variables`   | `{ <name>: <value> }`                          | Session variables seeded for every driven turn, supplied as the runtime's `variables` and therefore **locked**. Values may be structured. This is where a case puts the run's input — a trigger carries none. Recover the real payload from a previous run's `artifacts/variables.json` rather than inventing one: see [Recovering a case's inputs from previous runs](#recovering-a-cases-inputs-from-previous-runs). |
| `trigger`     | `{ id }`                                       | The trigger every driven turn of the case runs under. Carries **only an id**; `args` is rejected with a pointer to `variables:`. Validated against the workflow machine before any step — an unknown id fails the case (even with no steps), listing the workflow's declared triggers. Omitted ⇒ the manual trigger. See [Start conditions](#start-conditions-trigger-variables-and-workspace).                                              |
| `workspace`   | `{ <path>: <content> }`                        | Files seeded into the case's run workspace **before any step**. Strings are written verbatim; non-string YAML values are JSON-serialized; a single-key `{ from: <tests/-relative path> }` mapping copies a file byte-for-byte. Only agent-visible run-zone paths are seedable (root-level files like `trigger.json`, or `scratchpad/…`); authored (`skills/…`), runtime-internal, and escaping paths are rejected before anything is written. |
| `mocks`       | `[{ tool, whenInput?, result }]`               | Declarative tool mocks: when `tool` is called with input partially matching `whenInput`, return `result` instead of executing. Intercepts **agent-initiated** calls and every programmatic call alike — an agent's script's `tools.*`, a code state's `tools.*`, a grader's calls. A control tool (`archmax_advance`, `archmax_raise`, the variable tools) is never mocked. See [the mocking section](#settle-the-mocking-depth-before-writing-a-case).                                        |
| `clock`       | `"2026-03-20"` / `"…T14:30:00Z"` | The date and time every model call of the case states as "now": an ISO 8601 date (midnight UTC) or a date-time with `Z` or an offset; a zoneless or impossible value is a schema error. Carried on every action, a handoff and a child session included, and outranks the host's `clock` option. See [Start conditions](#start-conditions-trigger-variables-and-workspace). |
| `steps`       | flat list of step entries      | The case script: actions and assertions as peers (below).                                                                                                                                                                                                                                                                                                          |

There is **no multi-session surface** in test spec version 1 — no `sessions:`,
no `session:` on a step, no `parallel:`, and no case-level `expect:` list;
each is rejected with an actionable error ("not part of test spec version 1").
A case is one conversation on one session; per-session isolation is an engine
invariant covered by the SDK's own unit tests (`src/testing/driver.test.ts`),
not something workflow authors re-test per workflow.

### Step entries: one flat script

`steps` is a single flat, sequential list — a case reads like a script. Every
entry is a **single-key mapping**: an **action**, or an **assertion** that
evaluates against the view of the **nearest action above it** (the completed
turn that action produced). An assertion before the first action is a schema
error. The two actions:

| Action   | Shape                      | Meaning                                                                                                                                                                                                        |
| -------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send`   | `send: "<message>"`        | One user message — a plain string, nothing else (no transport fields; start conditions live at case scope). Runs the agent until it stops (final answer, park, or failure), under the case's declared trigger. Against a run **parked at a human state** it is a message instead: answered on a reply-only turn (every tool call refused), leaving the run parked at the same state. |
| `decide` | `decide: { to, comment? }` | Resume a **parked** run: the simulated human picks the outgoing transition `to` (a state slug), optionally with a review comment (delivered to the agent as correction on `refine` edges).                      |

```yaml
steps:
  - send: "I'd like a refund for order ORD-1001."
  - parked: true                 # <- asserts against the send's turn
  - reachedState: refund-review  # <- same turn
  - send: "Any news?"            # a message to the parked run, not a new turn
  - parked: decision             # still parked: nothing it says routes the run
  - decide: { to: refund-closed, comment: "ok" }
  - succeeded: true              # <- asserts against the decide's turn
```

`usedNoTools`/`calledTool` read the **whole conversation's** tool calls, not one
turn's, so do not use them to assert that a reply-only turn called nothing — in a
multi-step case they still see the earlier turns' calls.

There is no nested `expect:` block — writing one is an error with guidance
that assertions are steps themselves.

### Assertion grammar

Each assertion is a single-key step entry (repeatable; order-preserving),
evaluated against the nearest action above it. **Every assertion is hard** —
`grade` included: the `atLeast` you declare is the bar, and a score under it
fails the case and the run.

Assertions marked **structural** below assert *where the run went*, and a
failure in one of them **halts the case** — see
[Structural assertions halt the case](#structural-assertions-halt-the-case).

| Assertion                                | Meaning                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `succeeded: true`                        | **Structural.** The run finished: not failed **and not parked**, and the agent did not end it with `archmax_raise` (a raise fails here, naming its code).                                                                                                                                                                                     |
| `parked: true`                           | **Structural.** The run is parked at a human state awaiting a decision.                                                                                                                                                                                                                                                                        |
| `raised: true` / `raised: <code>` / `raised: { code?, reason? }` | **Structural.** The agent ended the turn with `archmax_raise({ code, reason })`. A string pins the code exactly; the mapping pins the code and matches the reason — exactly, or as a regex when written `"/pattern/flags"`. A miss names the code that was raised, or says the run did not raise.                                  |
| `variables: { expect, path?, locked? }`  | Every named variable is set to the expected value — deep equality, so a structured expectation compares by value. `path` addresses into a value per name (`items.-1.sku` is the last element); `locked` asserts the lock state. |
| `reachedState: <slug>`                   | **Structural.** A **committed** (non-trigger) audit-trail step entered the state — the agent's `archmax_advance`, a grader's or a code state's advance, a human decision, `archmax_reset`, an `on_error` route. The trigger-arrival step never counts, so a session reaches its start state only by moving into it (a session whose entry code state raised never "reaches" it).                        |
| `reply: { includes?, excludes? }`        | `includes`: substrings or `/pattern/flags` regex strings that must **all** match; `excludes`: none may match (leak checks — a refusal that quotes the data it refuses still leaks it). Each accepts a **single token or a list** (`includes: "ORD-1003"` works). Matched against **every assistant message of the session so far** (earlier turns included), not just the final message (a parked run often closes with a short "moving on" message while the substantive answer came earlier). |
| `calledTool: { name, input? }`           | The turn recorded a call to tool `name`; `input` is a **partial** match — mappings match on the declared keys (nested mappings partially), arrays by deep equality, and `/pattern/flags` string values match as **regexes** (recommended for file paths, so the model's exact spelling doesn't matter).                        |
| `notCalledTool: { name, input? }`        | No matching call occurred.                                                                                                                                                                                                                                                                                                    |
| `blockedTool: { name, input? }`          | A matching call was made **and refused by governance** — the assertion for testing a guard. Distinct from `notCalledTool` (nothing was tried, which proves nothing about the guard) and from a tool that ran and errored (only a policy rejection counts). Use it to test a state's `tools.allow` narrowing or its `skills.allow` set. |
| `usedNoTools: true`                      | The turn's agent used no tools at all. An automated state's calls are not in the transcript, so they never count.                                                                                                                                                                                                                                                                                                |
| `trail: { to?, kind?, reason?, count }`  | **Structural.** The number of audit-trail steps matching **all** given fields equals `count` (declare at least one of `to`/`kind`/`reason`). `kind`: `trigger` \| `agent` \| `human` \| `grader` \| `code` \| `sub-workflow` \| `reset` \| `on_error` — a grader's or code state's move is `grader`/`code`, with the `reason` it passed to `archmax_advance`. `count: 0` asserts a state was never entered. The trail accumulates across turns — each turn starts with a `trigger` step.                                        |
| `noTraversal: true`                      | **Structural.** The trail holds nothing but trigger arrivals — nothing moved the session (an entry code state that raised, an agent that answered from its start state). A grader's or code state's move is a traversal.                                                                                                                                                                                                                                      |
| `triggerArrival: <trigger-id>`           | **Structural.** Some trail step has `kind: trigger` and that trigger id as its reason — the run really started from the declared trigger.                                                                                                                                                                                                     |
| `grade: { closedQA, atLeast }`           | LLM-grade the turn's **run evidence** against the `closedQA` criterion — what the action's turn said (every text of that turn, empty when it said nothing) *plus* a bounded chronological record of the session's assistant messages and tool calls so far (each call with input, output, and status; mocked calls appear like real ones). The two are weighed differently: a criterion about what the user was **told** is met only by the reply, one about what the agent **did** may be met by the record — so `closedQA: looked the order up before answering` is a legitimate criterion, not only phrasing checks. **`atLeast` decides the outcome** — score ≥ `atLeast` passes, below it **fails the case**; the judge model's own opinion never overrides your declared bar, so the record can't disagree with the verdict. The judge is instructed to keep its reason to 1–3 sentences, so it fits on the verdict line. Requires `tests.judge` in `workflow.yaml`.                                            |

**Regex form**: a string shaped `/pattern/flags` is compiled as a regular
expression; anything else matches as a plain substring (in `reply` tokens) or
by equality (in tool-input matchers). Malformed regex strings are **static
validation errors**, never silently matched as literals. Quote them in YAML —
`"/approv/i"`, `"/output\\/report\\.json/"`.

**There is no generic predicate.** No `satisfies`, no inline JS — that is the
point of the format. Bespoke logic belongs in a vitest unit test against the
engine or in a code state on the graph.

**An automated state is asserted by what it committed.** A code state's or a
grader's own tool calls are not in the transcript, so `calledTool`,
`notCalledTool`, `blockedTool` and `usedNoTools` see only the agent's, and a
grader's words are never part of `reply`. Assert its move and reason with
`reachedState` / `trail: { kind: code | grader, to, reason?, count }`, its raise
with `raised`, what it set with `variables`, and its dispatches with
`ranWorkflow`:

```yaml
steps:
  - send: "Hi, I'm support@acmecorp.com. Which orders are delayed?"
  - trail: { kind: code, to: identify-case, count: 1 }   # the entry screen passed it
  - trail: { kind: grader, to: answered, count: 1 }      # the grader approved the reply
```

### Structural assertions halt the case

A failed **structural** assertion (`succeeded`, `parked`, `raised`,
`reachedState`, `trail`, `noTraversal`, `triggerArrival`) stops the case where it stands: no
further `send`/`decide` is driven and no further assertion is evaluated. Once
the run took a path the case did not describe, every later step would drive or
grade the wrong run — a `decide` after a failed `parked` cannot succeed, and a
`reply` check after a failed `reachedState` grades a state the run never
entered.

Content assertions (`reply`, `calledTool`, `notCalledTool`, `blockedTool`, `usedNoTools`,
`grade`) do **not** halt: a wrong reply is a defect in the run, not evidence the
run stopped being the one under test.

**What this means for how you author a case.** Put the structural assertion you
depend on immediately after the action that should have satisfied it, before the
content assertions that only make sense in that state:

```yaml
steps:
  - send: "I want a refund for ORD-1001"
  - reachedState: refund-review   # ← structural: if this misses, stop here
  - parked: true
  - reply:                        # ← only meaningful in refund-review
      includes: "approved"
  - decide: { to: refund-closed }
  - succeeded: true
```

A halt is reported as an ordinary failed verdict naming the assertion that
missed — **no error is set**, because a halt is a verdict the case reached, not
a failure of the machinery. Every assertion step that never ran is reported with
`status: "not-executed"` (one record per step, carrying its `steps` index), so a
stopped case still accounts for everything it declared: `archmax test` prints an
`N assertions not executed` line, and a host reading records can grey them out
instead of showing nothing and implying they passed.

Each record's `status` — `passed` \| `failed` \| `not-executed` — is the
authoritative outcome; the boolean `pass` is the alias `status === "passed"`.

### Start conditions: trigger, variables, and workspace

A case declares its **start conditions** — which trigger its driven runs start
from, what input those runs carry, and which files exist in the run workspace
before anything happens — at **case scope, never per step**:

```yaml
title: Delayed-orders report compiled from a trigger
description: >-
  The report_requested trigger starts every driven turn, carrying the company
  the firing named as a locked run variable.
trigger:
  id: report_requested
variables:
  company: "Acme Corp" # locked, exactly as a host's variables would be
workspace:
  trigger.json: { company: "Acme Corp" } # non-string ⇒ JSON-serialized
steps:
  - send: "A delayed-orders report was requested."
  - succeeded: true
  - triggerArrival: report_requested
```

- **`trigger`** — every driven turn of the case runs under this trigger
  (each turn restarts the run at that trigger's start state; the trail
  records `{ kind: trigger, reason: <id> }` per turn). Omit it for the
  `manual` trigger. It is validated **before any step executes**: an unknown
  id fails the case with the workflow's declared triggers, even when the case
  has no steps — and `archmax validate` reports the same statically. There is
  deliberately no per-step trigger: a follow-up `send` cannot run under a
  different trigger than the case declares. **When the workflow declares
  non-manual triggers, every case exercising one MUST declare it.**
- **`variables`** — the run's input, seeded on every driven turn as the
  runtime's `variables` and therefore **locked**, values structured or
  scalar. A seed here is indistinguishable from a production host seed to
  everything downstream: a `${{…}}` reference in a `tools.allow` glob resolves
  from it, a state's `requires:` gate is satisfied by it, a code state's script
  reads it in `variables`, and `archmax_set_variables` refuses to rewrite it.
  **Recover the real payload rather than inventing one** — see
  [Recovering a case's inputs from previous runs](#recovering-a-cases-inputs-from-previous-runs).
- **`workspace`** — input files seeded before any step. Keys are run-zone
  paths (root-level files like `trigger.json`, or `scratchpad/…`); authored
  paths (`skills/…`) and runtime areas are rejected before anything is
  written. This mirrors the host convention of materializing a trigger's
  payload as a workspace file — declare the payload exactly as production
  would write it.

Two operational notes:

- Seeding writes the file; **reading it is still governed** — the triggered
  start state must allow the read tool the agent needs (`read_file` is granted
  wherever the workflow-wide grant includes it, unless a state narrows it).
- Hosts that pin case sessions via `sessionIdForCase` reuse sessions across test
  runs: declared files are overwritten each run, but a file seeded by an
  _earlier_ run whose declaration was since removed can linger. The default
  (per-run unique sessions) starts clean.

**Pin the date** with a case-level `clock:` whenever a fixture or a prompt
carries a date (an order placed on `2026-03-15`, "refundable for 30 days"):
without it the model reads the real "now" and the verdict drifts with the
calendar. Pin on a ten-minute mark (the line is rounded down to ten minutes,
UTC only). Only the prompt is pinned — code-state scripts, the sandbox's `Date`, a
park's `resumeAt` and every recorded timestamp stay real, so a script that needs
the case's "today" reads it from a seeded variable, and a wait resumed in the
case is resumed with `deliver`, not by its `until`.

### Recovering a case's inputs from previous runs

A trigger carries only an id, so everything a firing passes arrives as
variables — and those names, shapes, and values live in the host's call site and
in sessions that already ran, not in the workflow. Read a real run rather than
guessing:

```bash
archmax sessions                 # ids, status, state, parked state, `vars=` names
archmax sessions <sessionId>     # that session's variables: value + locked state
```

That reads the session's **checkpoint**, so it works for any session that has run,
including one driven by `archmax run` (the CLI emits no run artifacts). A host that
calls `emitRunArtifacts` leaves the same record on disk as
`sessions/<sessionId>/artifacts/variables.json`
(`{ sessionId, workflow, variables: { name: { value, locked } } }`).

Pick the newest session whose recorded `trigger` matches the trigger the case
drives, then map its store onto the case:

| Recorded entry | Where it belongs |
| --- | --- |
| `trigger` (always locked) | the case's `trigger: { id: … }`, never `variables:` |
| any other `locked: true` | the case's `variables:` block — the firing's payload |
| `locked: false` | nothing: the agent established it, so **assert** it with `variables: { expect: … }` |

Never copy the whole store into `variables:`. Case seeds are locked, so seeding a
name the agent should establish hides a missing `archmax_set_variables` call *and*
makes the agent's own write fail against the lock — the case then exercises a run
production never performs.

`locked` is the whole attribution, and it is sufficient: a locked entry came from
the host (an `variables` seed, a delivery's seeds, or the built-in
`trigger`), an unlocked one from the agent's own `set_variables`. What you read is
the store as the session's **latest** turn left it, so locked entries are also the
turn-invariant part.

To produce a payload to read back, drive one yourself:
`archmax run <workflow> "<prompt>" --variables '{"from_email":"a@b.c"}'` then
`archmax sessions <id>`.

With no previous run to read, derive the same facts statically: the `${{…}}`
references in `tools.allow`/`allow_always` and the names in every state's
`requires:` are the variables the workflow depends on (`archmax validate` warns
about references nothing guarantees), and the host's
`createAgent({ variables })` / `deliver(sessionId, { trigger,
variables })` call sites name what production supplies.

### File fixtures: `from:` references

Bulk fixtures (a captured `trigger.json`, a large orders dump) live as real
files under `tests/` rather than inline YAML, and a case names each one it
wants: any `workspace` entry may declare `{ from: <path> }` instead of inline
content. The path resolves relative to the workflow's `tests/` directory, so
`from: fixtures/trigger.json` and `from: shared/orders-dump.json` (a fixture
shared across cases) both work. There is **no auto-seeded sibling data
directory**: a file is seeded only when a case's `workspace:` says so.

Fail-closed rules — reported by `archmax validate` and enforced again at run
bootstrap: a `from:` path that escapes `tests/` or names a missing file is an
error before any step runs, and a `*.test.yaml` file anywhere under `tests/`
is a case.

### Settle the mocking depth _before_ writing a case

An unmocked tool call in a test is a **real** tool call, on every run of the
suite: a real email sent, a real card charged, a real row written to a live
system. That is the one decision about a test its author cannot make alone, so
**ask the owner how much of the workflow's tool surface to mock before you
write the file**.

Ask concretely rather than in the abstract — name the tools this workflow
actually calls and propose a split:

- **Mock by default** anything that sends, pays, posts, deletes, or writes
  outside the session zone, and anything whose result drifts between runs (live
  inventory, today's date-dependent data). A test that is not safe to re-run is
  not a test.
- **Leave real by default** reads against fixtures committed to the workspace,
  the workflow's own scripts and code states, and run-zone file writes — mocking
  those would test the mock instead of the workflow.
- **Ask** about reads against a live system: cheap and stable enough to keep
  real, or slow, rate-limited, or credential-bound enough to mock?

Record the answer in the **YAML comment above the case document** — the
`description` is capped at a sentence or two and belongs to what is asserted,
while a reader checking the case against the workflow needs to know what was
deliberately left real, which is exactly the kind of rationale the comment
exists for.

Mocks are the top-level `mocks:` list; they intercept **agent-initiated** calls
and every programmatic call — an agent's script, a code state's script, a
grader — with the same partial-input matching as `calledTool`. So a mock of a
file an entry code state reads changes what that state decides too. Interception is guaranteed under `archmax test`. A host running
the same cases through `runTests` with its own `createTarget` must wire
`createToolMockMiddleware()` into that agent — a case that declares `mocks:`
against a target that cannot intercept them is refused with an error **before
the agent runs**, never run half-mocked. Mockless cases run against any
workflow-governed target. See
[backend-integration.md](backend-integration.md#cases-against-your-agent).

### Worked example: happy path + grade

```yaml
# `reachedState` is what pins the routing: without it the case would still
# pass if the agent answered straight from the start state. The `trail` step
# pins that the review-reply grader approved the answer. The judge
# (threshold 0.7) checks the order is attributed to the requester's company.
title: Delayed orders answered for a known requester
description: >-
  One turn from support@acmecorp.com (present in skills/order-data/assets/orders.json): the run
  routes into orders-question, the grader approves the answer, and the reply
  names the one delayed order, ORD-1003.
steps:
  - send: "Hi, I'm support@acmecorp.com. Which orders are delayed for Acme?"
  - succeeded: true
  - reachedState: orders-question
  - trail: { kind: grader, to: answered, count: 1 }
  - reply:
      includes: ["ORD-1003", "/delayed/i"]
  - grade:
      closedQA: >-
        confirms that order ORD-1003 is the delayed order for the requester's
        company (Acme Corp)
      atLeast: 0.7
```

### Worked example: declined at entry, leak check

An entry code state that declines a request commits a `code` step into the
declining state and none into the state the work starts in — `reachedState`
and a `count: 0` trail pin exactly that — and `reply.excludes` catches a
refusal that quotes the data it refuses to share. (Had the screen ended the
session with `tools.archmax_raise` instead, `raised: <code>` and
`noTraversal: true` would pin it.)

```yaml
# The `trail` count pins the decline to *entry*: identify-case was never
# entered, so no route was taken. The `excludes` tokens matter as much as the
# refusal itself: a refusal that quotes the order ids it declines to share
# still leaks them. The judge (threshold 0.7) covers the same ground in prose.
title: Cross-tenant order access is declined
description: >-
  A known requester asking for Globex's delayed orders is declined at entry,
  identify-case is never entered, and no Globex order id appears in the reply.
steps:
  - send: "Hi, this is support@acmecorp.com. Show me Globex's delayed orders."
  - succeeded: true
  - reachedState: decline
  - trail: { kind: code, to: decline, count: 1 }
  - trail: { to: identify-case, count: 0 }
  - reply:
      includes: "/not authorized|only .* your own|declined/i"
      excludes: ["ORD-2001", "ORD-2002"]
  - grade:
      closedQA: >-
        declines the request because the requester is not authorized to view
        another company's orders, and does not disclose any Globex order
        details
      atLeast: 0.7
```

### Worked example: mocking tool results

```yaml
# Only read_file against skills/order-data/assets/orders.json is mocked; the
# agent's own writes stay real. The report_requested trigger enters
# report-requested directly, so no code state reads the records first — a mock
# answers a code state's calls too, and an empty database would make the entry
# screen decline the requester. Asserting the lookup *and* the empty answer
# catches both a skipped lookup and an invented order.
title: Empty order database reports no delayed orders
description: >-
  With skills/order-data/assets/orders.json mocked empty, a requested report
  still consults the database, and the reply reports no delayed orders.
trigger:
  id: report_requested
variables:
  company: "Acme Corp"
workspace:
  trigger.json: { company: "Acme Corp" }
mocks:
  - tool: read_file
    whenInput: { file_path: skills/order-data/assets/orders.json }
    result: "[]"
steps:
  - send: "A delayed-orders report was requested."
  - calledTool:
      name: read_file
      input:
        file_path: "/orders\\.json/"
  - reply:
      includes: "/no (matching |delayed )?orders/i"
```

### Worked example: mocking a sub-workflow

A delegation is a tool call, so it mocks like one — keyed by the tool's own name,
matched on the call's arguments. Each call gets its own answer, which is what
proves a fan-out is not sharing inputs:

```yaml
mocks:
  - tool: archmax_workflow_enrich-order
    whenInput: { order_id: "ORD-1002" }
    result:
      message: "ORD-1002 is shipped."
      # The target's `manual` trigger declares these, so a mock standing in
      # for that sub-run has to supply them: a mock replaces the run, never its
      # contract, and one omitting a declared name fails the dispatch.
      returns:
        enrichment_file: "scratchpad/enrichment/ORD-1002.json"
        delayed: false
steps:
  - send: "Enrich the requested orders."
  - ranWorkflow: { workflow: enrich-order, count: 2 }
  - variables:
      expect:
        enrichments:
          - order_id: "ORD-1002"
            delayed: false
```

Assert with **`ranWorkflow`**, not `calledTool`, whenever a script drives the
fan-out: `calledTool` reads the *model's* calls, and the point of a script-driven
fan-out is that the model makes none of them. `ranWorkflow` reads the trail, which
records a step per sub-run whoever made the call — including a mocked one.

### Worked example: human-in-the-loop decisions (refine loop)

Drive a run into a human state, assert it parked, then decide as the reviewer —
including the send-back-for-changes (`refine`) loop, whose second parking is
pinned with a `trail` count:

```yaml
# The `trail` count is the point: refund-review is entered exactly twice —
# initial submit plus one resubmit — so a third entry would mean the refine
# edge looped. The final `reply` check pins that the correction did not lose
# its subject.
title: Refund sent back for changes, then approved
description: >-
  The reviewer refines once and then approves: the run parks at both review
  points, refund-review is entered exactly twice, the run succeeds, and the
  final reply still names ORD-1001.
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

### Worked example: triggered start + fixture file

The case declares its trigger on the document, its input as a locked variable,
and a payload fixture the host would materialize as a real file under `tests/`,
seeded byte-for-byte before any step:

```yaml
# tests/triggered-report.test.yaml — tests/fixtures/trigger.json holds the
# payload fixture. `triggerArrival` is what pins the start: it names the
# trigger the run really arrived on, not merely the state it ended up in.
title: Delayed-orders report compiled from a trigger
description: >-
  The report_requested trigger starts the run: the agent reads the seeded
  trigger.json payload, writes scratchpad/report.json, and the reply names Acme's
  one delayed order, ORD-1003.
trigger:
  id: report_requested
variables:
  company: "Acme Corp"
workspace:
  trigger.json: { from: fixtures/trigger.json }
steps:
  - send: "A delayed-orders report was requested."
  - succeeded: true
  - triggerArrival: report_requested
  # `/pattern/` input values match as regexes, so the assertion holds
  # whether the model spells the path with or without a leading slash.
  - calledTool:
      name: read_file
      input:
        file_path: "/trigger\\.json/"
  - calledTool:
      name: write_file
      input:
        file_path: "/output\\/report\\.json/"
  - reply:
      includes: ["ORD-1003", "Acme"]
```

### Migrating a JS case to YAML

JS test cases (`defineEval`, the sandbox `t` driver, `@archmax-ai/harness/testing`) are
**removed**; a `*.test.js`/`*.test.ts` file is no longer recognized and is
skipped silently. The mapping:

| JS surface (removed)                                          | YAML equivalent                                                                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| File JSDoc header + `defineEval({ description })`             | The mandatory `title` (≤ 60 chars) + `description` (≤ 200 chars); rationale that fits neither moves to a YAML comment above the document |
| `defineEval({ trigger })` / `({ workspace })`                 | Top-level `trigger:` / `workspace:` (inline content or `{ from: … }`)                                                    |
| `await t.send("msg")`                                         | `- send: "msg"` step entry                                                                                               |
| `await t.decide(to, comment)`                                 | `- decide: { to, comment }` step entry                                                                                   |
| `t.newSession(...)` / `Promise.all` over sessions             | **Not part of test spec version 1** — a case is one conversation on one session; per-session isolation is an engine invariant covered by the SDK's own unit tests |
| `t.mockTool(name, { whenInput, result })`                     | `mocks: [{ tool, whenInput, result }]`                                                                                   |
| `t.succeeded()` / `t.parked()`                                | `- succeeded: true` / `- parked: true` step entries after the action                                                     |
| `t.messageIncludes("x")` / `t.messageIncludes(/x/i)`          | `- reply: { includes: ["x", "/x/i"] }` step entry (single token or list)                                                 |
| Leak checks via `satisfies(...)` on the reply                 | `- reply: { excludes: [...] }` step entry                                                                                |
| `t.calledTool(name, { input })` / `t.notCalledTool` / `t.usedNoTools()` | `- calledTool: { name, input? }` / `- notCalledTool:` / `- usedNoTools: true` step entries (RegExp input values become `"/pattern/flags"` strings) |
| `t.reachedState(name)`                                        | `- reachedState: <name>` step entry                                                                                      |
| `t.auditTrail()` + `filter(...).length === n`                 | `- trail: { to?, kind?, reason?, count }`; "nothing but the trigger arrival" ⇒ `- noTraversal: true`; trigger-arrival reason ⇒ `- triggerArrival: <id>` |
| `t.judge.autoevals.closedQA(c).atLeast(n)`                    | `- grade: { closedQA: c, atLeast: n }` step entry                                                                        |
| `t.skip(reason)`                                              | `skip: <reason>`                                                                                                         |
| bespoke predicates                                            | **No YAML equivalent — deliberate.** Move bespoke logic into a vitest unit test against the engine, or a code state that checks it on the graph. |
| `import { defineEval } from "@archmax-ai/harness/testing"`             | Nothing — the subpath is removed; YAML imports nothing                                                                   |

Removed package exports: `createDriveTool`, `DriveRequest`, `DriveSession`,
and the `@archmax-ai/harness/testing` subpath. New root exports for hosts that parse
cases themselves: `parseCaseDocument`, `CaseSchemaError`, the case types
(`CaseDocument`, `CaseStep`, `CaseExpectation`, …), and the test-spec
versioning surface (`DEFAULT_TEST_SPEC_VERSION`, `SUPPORTED_TEST_SPEC_VERSIONS`,
`resolveTestSpecVersion`, `isTestSpecVersionSupported`,
`UnsupportedTestSpecVersionError`). `@archmax-ai/harness/sandbox` carries the
code-state contract (`defineCodeState`, `CodeStateInput`, `HistoryMessage`,
`TrailStep`, `ToolCallRecord`, `ToolCallFilter`).

---

### Source of truth in code

| Concern                                                                               | File in the SDK                                                                      |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Sandbox prelude (the `code` context, `defineCodeState`, the scoped `tools` view)        | `src/sandbox/assets/parts/code-state.js`; `src/sandbox/prelude.ts`                       |
| Script source preparation (`@archmax-ai/harness/*` import stripping, `export default`, foreign-import errors) | `src/sandbox/imports.ts`                                                      |
| Executor, sandbox tools, PTC gateway                                                  | `src/sandbox/executor.ts`, `tools.ts`, `ptc-gateway.ts`                                  |
| Typed entry point (`defineCodeState`, `CodeStateInput`, `HistoryMessage`, `TrailStep`) | `src/public/sandbox.ts`                                                                  |
| Running an automated state, its outcomes and controls                                 | `src/workflow/automated.ts`, `automated-controls.ts`                                     |
| Code-state and grader runs; the history (`messages`, `trail`, `toolCalls`) and visits | `src/workflow/code-state.ts`, `grader-state.ts`, `history.ts`, `tool-calls.ts`, `visits.ts` |
| Case engine (host-side)                                                               | `src/testing/` — case schema `case-schema.ts`, discovery `discovery.ts`, assertion evaluation `assertions.ts`, grader `grade.ts`, runner `runner.ts` |
| Validation diagnostics (missing code-state script, foreign import, YAML case checks)  | `src/validate/validate.ts`                                                               |
