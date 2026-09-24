# Hook scripts & cases — full reference

The complete contract and worked examples for the two authored surfaces this
reference covers:

1. **Lifecycle hook scripts** (`workflows/<slug>/hooks/*.js` — beside the spec
   that wires them, on the **authoring plane**) — deterministic `before`/`after`
   gates, **hand-authored** `.js` files. `workflow.yaml` wires
   `{ script: hooks/<name>.js }`: the path is **workflow-relative** and confined
   to that workflow's `hooks/` directory, so it resolves to
   `workflows/<slug>/hooks/<name>.js`. An absolute path, a `..` climb, or a path
   outside `hooks/` is a load error and a `validate` error. They run in the
   QuickJS sandbox: plain JavaScript with **top-level `await`**, no State APIs, no
   filesystem beyond the `tools.*` bridge.

   **A hook script is not a runtime script.** The runtime runs a hook; the agent
   runs an `archmax_run` source. The two live in different places on purpose —
   hooks in `workflows/<slug>/hooks/`, runtime scripts in
   `skills/<capability>/scripts/` — and the classes cannot meet: the agent
   cannot read `workflows/**` at all, and `archmax_run` is confined to skill
   bundles by a non-overridable kernel rule (`script.skill-only`). An agent that
   could execute its own guard could probe it for a bypass, which is the whole
   reason for the split. A hook's source also never reaches the model: not in a
   prompt, not in an event, not in a session artifact — a veto reports its
   verdict and reason, never its code.
2. **Cases** (`workflows/<name>/tests/*.test.yaml`) — declarative
   YAML documents run by `archmax test` and interpreted **host-side**: no
   sandbox executes a case. Suite config is the `tests:` block in
   `workflow.yaml` (there is no `tests.config.js`).

Sandbox scripts are self-contained: the only permitted imports are **typed
`@archmax-ai/harness/*` carriers** (stripped before evaluation — see
[Typed imports](#typed-imports)); importing from any other specifier is an
**error**. Each sandbox context gets its own globals — nothing leaks between
them (`SANDBOX_CONTRACT.context` is `"lifecycle-hook"` for a hook, or `"ptc"`
for the agent's own `archmax_eval`/`archmax_run` code, which gets **no** hook
vocabulary at all; `SANDBOX_CONTRACT.version` is `2`).

## Contents

- [Typed imports](#typed-imports)
- [Part 1 — Lifecycle hook scripts](#part-1--lifecycle-hook-scripts)
  - [Authoring model: hand-authored](#authoring-model-hand-authored)
  - [The hook contract](#the-hook-contract)
  - [Governance of `tools.*` calls](#governance-of-tools-calls)
  - [`archmax_run` scripts: the `args` contract](#archmax_run-scripts-the-args-contract)
  - [Scripts and sub-workflow fan-out](#scripts-and-sub-workflow-fan-out)
  - [Worked example: a `before` gate](#worked-example-a-before-gate)
  - [Worked example: an `after` policy check](#worked-example-an-after-policy-check)
  - [When to use a grading rubric instead](#when-to-use-a-grading-rubric-instead)
- [Part 2 — Cases (declarative YAML)](#part-2--cases-cases-declarative-yaml)
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
  - [Worked example: veto, leak check, `noTraversal`](#worked-example-veto-leak-check-notraversal)
  - [Worked example: mocking tool results](#worked-example-mocking-tool-results)
  - [Worked example: human-in-the-loop decisions (refine loop)](#worked-example-human-in-the-loop-decisions-refine-loop)
  - [Worked example: triggered start + fixture file](#worked-example-triggered-start--fixture-file)
  - [Migrating a JS case to YAML](#migrating-a-js-case-to-yaml)

---

## Typed imports

A hook script may open with a **typed import** — a type carrier that gives IDE
completion for the hook input and the verdict helpers, and is **stripped before
QuickJS evaluation** (the runtime implementation is an identity):

```js
import { ok, veto, correct } from "@archmax-ai/harness/sandbox";
/** … */
export default async function hook({ state, variables, messages, tools }) {
  /* ... */
}
```

Importing from any **non-`@archmax-ai/harness/*`** specifier is an **error** — sandbox
scripts are self-contained. **Bare-globals authoring** (no import) is equally
valid: `ok`, `veto`, `correct` and `defineHook` are prelude globals.

---

## Part 1 — Lifecycle hook scripts

### Authoring model: hand-authored

A script hook references an **ordinary hand-authored** `.js` file. You DESIGN
AND WRITE the script directly — there is no generation step. `workflow.yaml`
only wires the hook, one or a list run in order (the first veto stops the list):

```yaml
states:
  identify-case:
    triggers:
      manual:
    before:
      - script: hooks/check-requester.js
      - script: hooks/check-tenancy.js
```

A hook script **MUST** open with a leading JSDoc block — a title line, a blank
line, and a description of what the check does _and how_: the inputs it reads,
the sequence of checks, and the condition producing **each** verdict. It is the
only human-facing contract the file has (admin UIs display it instead of the
code), and it is what a reviewer refines when the gate is wrong. No
`@specification` tag, no `// archmax:generated` marker, no generation semantics.
See [SKILL.md → Code files are description-first](../SKILL.md#code-files-are-description-first).

The `specification` sidecar in `workflow.yaml` is **not a recognized key**:
`{ script: x.js, specification: … }` is a malformed two-key hook and a
validation **error**.

- `archmax validate` reports a hook-script problem only when the script **file
  is missing** or it has a **foreign (non-`@archmax-ai/harness/*`) import**. It does
  **not** check the JSDoc block on any script — the header is an authoring
  standard you uphold yourself. (Cases are YAML; there `archmax validate`
  **errors** on a missing `description` instead.)
- The runtime never generates scripts: a missing script file at run time
  errors and vetoes (fail-closed).

### The hook contract

A hook is a **default-export function**. The runtime calls it with **one
object** and reads its **return value** as the verdict:

```js
/**
 * Requester gate — reject a run whose requester is not a known customer.
 *
 * Reads the first user message from `messages`, extracts the first email
 * address in it, loads skills/order-data/assets/orders.json through the tool
 * bridge, and looks the address up against every order's `email`.
 *
 * Vetoes when the request carries no email address, and when the address
 * matches no order — each with a reason naming what was missing. Otherwise ok.
 */
export default async function hook({ state, phase, trigger, variables, messages, tools }) {
  const orders = JSON.parse(await tools.readFile({ file_path: "skills/order-data/assets/orders.json" }));
  const request = messages.find((m) => m.role === "user")?.text ?? "";
  const email = request.match(/[\w.+-]+@[\w.-]+/)?.[0];
  if (!email) return veto("No email address found in your request.");
  if (!orders.some((o) => o.email === email)) return veto(`"${email}" is not in the order database.`);
  console.log(`Allowed: ${email}`);
  return ok();
}
```

**The input** (`HookInput` in `@archmax-ai/harness/sandbox`; the same fields minus
`tools` are also the global `args`):

| Field | Meaning |
| --- | --- |
| `state`, `phase` | The state whose hook is running; `"before"` or `"after"`. |
| `trigger` | The trigger **id string** the run started from. It carries no payload — the run's input is in `variables`. |
| `variables` | The run's variables as a plain `name → value` map, including the built-in `trigger`. Structured values are present whole (`variables.order.items[0].sku`). **Read-only**: assigning changes nothing, and the variable tools are absent from `tools.*` — a hook that could write variables would be editing the governance inputs of the state it judges. |
| `messages` | The recent transcript (last 24 messages), newest last, as `{ role, text, toolCalls? }`. `role` is `user`, `assistant`, `tool` (with `tool: <name>`), `system`, or **`runtime`** — a note the runtime wrote (an arrival, a decision, an error route, a completion check; `note` names the kind). A hook that reacts to narration matches `role === "runtime"`, never a `[bracket]` prefix in a user message. |
| `from`, `to`, `reason` | Present on `after` hooks: the transition the agent is attempting (`reason` is the agent's `archmax_advance` reason). |
| `tools` | The privileged tool-call bridge (async), camelCased: `await tools.readFile({ file_path: "skills/order-data/assets/orders.json" })` → file text. See [Governance](#governance-of-tools-calls). |

**The verdict** — the three helpers are globals:

| Return | Effect |
| --- | --- |
| `ok()` (or nothing) | Proceed. |
| `veto(reason)` | Block. `before`: entry to the state (for a start state, the whole run). `after`: the `archmax_advance` transition, or the completion of a terminal state. The reason is shown to the agent — make it precise and actionable. |
| `correct(reason)` | **`after` hooks only**: the agent gets another attempt with the reason as correction, bounded by the hook-level `max_iterations` sidecar (`after: { script: hooks/review.js, max_iterations: 2 }`; default 0 — a `correct` with no budget is a hard veto). The budget is counted per hook, so a passing sibling hook does not reset it, and a `correct` refused on a spent budget consumes nothing. A `before` `correct` is treated as a veto and is a validation error. |
| `false` | A veto (`"precondition not met"`) — the shorthand for `return isAuthorized(x)`. |
| any other object | A **veto**, with the object's keys named in the reason. A hook's return value *is* its verdict, so a misspelled `verdict` or a shape like `{ ok: false, reason }` is a verdict got wrong; reading it as `ok` would silently permit what the hook meant to block. |
| `true`, a number, a string | Proceed — a non-object says nothing about the verdict, including a bare body's incidental completion value. |

A hook that **throws** — or whose file is missing — **vetoes** with the error
as the reason (fail-closed). Parse JSON defensively (`try`/`catch`) and turn
malformed inputs into a `veto` with a good message instead of letting them
throw; conversely, if a failure should *not* block, catch it and return `ok()`.

Other globals: `console.log(...)` (captured into the trail; shown in verbose
runs), and `defineHook(fn)`, an alias
for `export default fn`. A file with **no default export** is evaluated as a
plain script and its **completion value** is the verdict, so a short gate can be
`orders.length ? ok() : veto("no orders")` on its last line.

`${{…}}` does not apply inside a hook: the runtime substitutes references in the
arguments the *model* writes. A hook already has the values in `variables` and
composes strings in JavaScript, so `${{…}}` text in a hook's `tools.*` call is
ordinary data.

### Governance of `tools.*` calls

Every `tools.*` call is checked by the decision kernel at the moment it runs —
the same kernel, with the same rules, that governs a tool call the model makes
directly. What differs is only _whose authority_ the script runs on:

| Script kind                                     | The state's own governance (`tools.allow`, `tools.forbid`, `skills.*`) | Safety rules, workflow-wide `forbid_always`, consumer rules |
| ----------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| Lifecycle hook (`before:`/`after:`)             | **Not applied** — a gate must read evidence the state never grants, and a state's denial does not reach it either | Applied |
| `archmax_run` script (the model chose to run it) | **Applied** — it runs on the model's authority                          | Applied |

A hook runs on **runtime authority**: outside the active state's tool surface in
*both* directions. So a hook may
`await tools.readFile({ file_path: "skills/order-data/assets/orders.json" })`
even in a state whose `allow` list never mentions `read_file`, one that enables
no skill at all, and one whose `tools.forbid` names the very tool it calls — while
the workflow's `tools.forbid_always` and `skills.forbid_always` bind it like
anything else, and no script of either kind may write into the read-only authored
zone.

Neither kind may **read** the authoring plane at all. A `tools.*` call naming
`workflows/**` is blocked (`zone.governance-plane`) with a
diagnostic naming the prefix — a hook cannot read its own spec, a sibling's, or
the criteria of the rubric declared in it. There is no `task()` in any sandbox
context: a script that wants a model verdict gets a `rubric` hook declared beside
it
instead.

A refused call **throws** inside the script, carrying the governance reason.
The underlying tool never runs whether or not you catch it:

```js
try {
  await tools.writeFile({ file_path: "scratchpad/report.md", content: body });
} catch (err) {
  console.log(`could not write the report: ${err.message}`);
}
```

**Authoring rule for `archmax_run` scripts:** if sandboxed code calls `tools.X`,
the state's `allow` list must cover `tool: X` (with any argument constraints the
script's call satisfies), or the call is blocked. Grant it per state with
`tools.allow`, or workflow-wide with `tools.allow_always`. Lifecycle hooks need
no such grant.

### `archmax_run` scripts: the `args` contract

An `archmax_run` source (`skills/<capability>/scripts/*.js`) is a plain script:
top-level `await`, `tools.*`, `console.log`, and the **last expression** is its
result — returned to the model as the tool result, never into the variable
store. It reads its input from the global **`args`**:

- **the arguments the model passed** to `archmax_run` (`args.<name>`), plus
- **`args.variables`** — the session's variables as a flat `name → value` map,
  the same map a hook gets. The runtime supplies it on every call, so a script
  reads the run's input (a seeded list, a delivered payload) without the model
  having to retype it.

```js
/** One sub-run per requested order. */
const orders = args.variables?.orders_to_enrich ?? [];
```

`args.variables` is a read-only snapshot; a script that must persist a result
returns it and the state's `requires:` makes the model record it with
`archmax_set_variables`. There is **no `task()`** in an `archmax_run` script or in
`archmax_eval`. The model has no `task` tool at all: it is disclosed in no state
and grantable by nothing, because a rubric grades the agent rather than serving it.

### Scripts and sub-workflow fan-out

A script **is** the deterministic way to drive a fan-out. Delegation tools are on the `tools.*`
surface — a delegation does work and returns a value, unlike the control tools a script may never
call — so a script decides how many sub-runs to start, with what inputs, and what to do with each
answer:

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
context.

Two limits still hold, both inherited rather than special to delegation. A script may only call a
delegation tool its **calling state** allows — the same kernel verdict an agent's call gets. And a
script's delegation **cannot park**: a QuickJS frame is not durable, so a child that reaches a human
state fails that call closed with `parked`.

Scripts still may not call `archmax_advance` (moving the state machine is the model's governed
decision) or `archmax_set_variables`. Concurrent calls succeed or fail **independently**, so a script
can act on what worked — `Promise.allSettled` is the honest shape when partial success is
meaningful. Give each sub-run its own output path: they share one run zone.

### Worked example: a `before` gate

The tenancy half of the bundled example's entry gate
(`workflows/order-lookup/hooks/check-tenancy.js`), the second hook in
`identify-case`'s `before` list — so a missing or unknown email has already been
vetoed by `check-requester.js` before this runs:

```js
/**
 * Tenancy gate — a requester may only reach their own company's orders.
 *
 * Binds the requester's email (the first one in the first user message) to the
 * customers whose orders carry it in skills/order-data/assets/orders.json, then
 * checks the request two ways: it names another customer, or it references an
 * order id (`ORD-…`) owned by another customer. Matching is case-insensitive.
 *
 * Vetoes with the customers or order ids the requester reached for when either
 * check finds one; otherwise ok. If the order database cannot be read, vetoes
 * too (fail-closed).
 */
export default async function hook({ messages, tools }) {
  let orders;
  try {
    orders = JSON.parse(await tools.readFile({ file_path: "skills/order-data/assets/orders.json" }));
    if (!Array.isArray(orders)) throw new Error("not an array");
  } catch {
    return veto("Could not load skills/order-data/assets/orders.json - unable to check tenancy.");
  }

  const request = messages.find((m) => m.role === "user")?.text ?? "";
  const email = (request.match(/[\w.+-]+@[\w.-]+\.\w{2,}/)?.[0] ?? "").toLowerCase();
  const own = new Set(
    orders.filter((o) => String(o.email).toLowerCase() === email).map((o) => String(o.customer)),
  );

  const lower = request.toLowerCase();
  const foreignByName = [...new Set(orders.map((o) => String(o.customer)))].filter(
    (name) => !own.has(name) && lower.includes(name.toLowerCase()),
  );
  const referenced = new Set((request.match(/\bORD-\d+\b/gi) ?? []).map((id) => id.toUpperCase()));
  const foreignById = orders
    .filter((o) => referenced.has(String(o.id).toUpperCase()) && !own.has(String(o.customer)))
    .map((o) => String(o.id));

  if (foreignByName.length > 0 || foreignById.length > 0) {
    const detail = (foreignByName.length > 0 ? foreignByName : foreignById).join(", ");
    return veto(
      `The email address "${email}" is not authorized to access orders for ${detail}. You may only view orders for your own account.`,
    );
  }
  return ok();
}
```

The pattern to internalize: **one `return veto(reason)` per veto condition,
each with a human-readable reason that names the fix**; `console.log` for
anything worth seeing in a verbose run; `return ok()` at the end.

### Worked example: an `after` policy check

An `after` hook re-derives policy deterministically so the agent can never
record a decision the policy forbids. Wiring (on `refund-request` in the
bundled example's `workflow.yaml`):

```yaml
after:
  script: hooks/check-refund.js
```

The check (`workflows/order-lookup/hooks/check-refund.js`):

```js
/**
 * Refund policy gate — the agent may not record a refund the policy forbids.
 *
 * Re-derives the refund decision from the order database instead of trusting
 * the one the agent wrote. Reads the recorded ticket from scratchpad/refund.json
 * ({ orderId, decision }), then reads skills/order-data/assets/orders.json and
 * looks the order id up, case-insensitively, against each record's `id`.
 *
 * Policy: a refund is "approved" only when the order exists with status
 * delivered or delayed; an unknown order and any other status must be "denied".
 *
 * Vetoes, each with a reason that names the fix, when: the ticket file is
 * missing or not valid JSON; `decision` is not exactly "approved" or "denied";
 * the order database cannot be read; or the recorded decision contradicts the
 * derived one. Otherwise ok.
 */
export default async function hook({ tools }) {
  let refund;
  try {
    refund = JSON.parse(await tools.readFile({ file_path: "scratchpad/refund.json" }));
  } catch (e) {
    return veto(
      `scratchpad/refund.json could not be read or parsed (${e.message}) - write it as a JSON object with "orderId" and "decision" before leaving this state`,
    );
  }

  const decision = refund?.decision;
  if (decision !== "approved" && decision !== "denied") {
    return veto(`scratchpad/refund.json "decision" must be exactly "approved" or "denied"; got ${JSON.stringify(decision)}`);
  }

  let orders;
  try {
    orders = JSON.parse(await tools.readFile({ file_path: "skills/order-data/assets/orders.json" }));
  } catch {
    return veto("skills/order-data/assets/orders.json could not be read - the order database must be accessible to validate the refund decision");
  }

  const wanted = typeof refund.orderId === "string" ? refund.orderId.trim().toLowerCase() : "";
  const order = orders.find((o) => typeof o?.id === "string" && o.id.toLowerCase() === wanted);
  const derived = order && ["delivered", "delayed"].includes(order.status) ? "approved" : "denied";
  console.log(`Refund policy check - derived "${derived}", recorded "${decision}"`);

  if (decision === derived) return ok();
  const why = !order
    ? "it does not exist in the order database"
    : derived === "approved"
      ? `its status is "${order.status}"`
      : `its status "${order.status}" is not delivered or delayed`;
  return veto(
    `Policy requires "${derived}" for order ${JSON.stringify(refund.orderId)} because ${why}, but the recorded decision is "${decision}" - update scratchpad/refund.json to decision: "${derived}"`,
  );
}
```

Note how the veto reasons carry the _fix_: the agent reads the reason,
rewrites `scratchpad/refund.json`, and retries the transition.

### When to use a grading rubric instead

Use a `script:` hook when the check is **deterministic** — derivable from
workspace data with plain code (policy tables, schema checks, cross-file
consistency). Use a `rubric:` hook when the check requires **judgment**
(is the reply complete? is the tone right?):

```yaml
states:
  orders-question:
    after:
      - rubric:
          max_iterations: 2     # `correct` verdicts allowed before a hard veto
          instructions: |-
            You review the agent's final reply about the user's orders...
            Return { "verdict": "ok" | "correct" | "veto", "reason": "..." }.
```

A rubric may return `correct` — the agent gets another attempt with the
grader's reason as correction, budgeted by its own `max_iterations`. Script hooks
get the exact same flow when they return `correct(reason)` under a
`max_iterations` sidecar. A rubric whose response cannot be parsed
into a verdict **fails closed** (veto with a snippet of the raw output). A rubric
receives a compact JSON payload (`userRequest`, `history`, `state`, `phase`) —
its `instructions` are written against that, not against a hook's `messages`.

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
  runs lifecycle hooks and `archmax_run` *inside the driven agent*, unchanged.
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
    rule that applied to JS test files; JSDoc headers now apply to hook
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
  judge: {} # grader settings ({} = env-configured default model;
    # or { model, modelOptions })
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
| `mocks`       | `[{ tool, whenInput?, result }]`               | Declarative tool mocks: when the driven agent calls `tool` with input partially matching `whenInput`, return `result` instead of executing. Intercepts **agent-initiated and PTC** (script `tools.*`) calls alike. See [the mocking section](#settle-the-mocking-depth-before-writing-a-case).                                        |
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
| `send`   | `send: "<message>"`        | One user message — a plain string, nothing else (no transport fields; start conditions live at case scope). Runs the agent until it stops (final answer, park, or failure), under the case's declared trigger. Against a run **parked at a human state** it is a message instead: answered on a tool-free turn, leaving the run parked at the same state. |
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
| `succeeded: true`                        | **Structural.** The run finished: not failed **and not parked**.                                                                                                                                                                                                                                                                              |
| `parked: true`                           | **Structural.** The run is parked at a human state awaiting a decision.                                                                                                                                                                                                                                                                        |
| `variables: { expect, path?, locked? }`  | Every named variable is set to the expected value — deep equality, so a structured expectation compares by value. `path` addresses into a value per name (`items.-1.sku` is the last element); `locked` asserts the lock state. |
| `reachedState: <slug>`                   | **Structural.** A **committed** (non-trigger) audit-trail step entered the state — agent `archmax_advance`, human decision, `archmax_reset`, or `on_error` route. The trigger-arrival step never counts (it is recorded before the entry state's `before` gate runs, so a vetoed-entry run never "reaches" its start state).                        |
| `reply: { includes?, excludes? }`        | `includes`: substrings or `/pattern/flags` regex strings that must **all** match; `excludes`: none may match (leak checks — a refusal that quotes the data it refuses still leaks it). Each accepts a **single token or a list** (`includes: "ORD-1003"` works). Matched against the turn's **whole assistant transcript**, not just the final message (a parked run often closes with a short "moving on" message while the substantive answer came earlier). |
| `calledTool: { name, input? }`           | The turn recorded a call to tool `name`; `input` is a **partial** match — mappings match on the declared keys (nested mappings partially), arrays by deep equality, and `/pattern/flags` string values match as **regexes** (recommended for file paths, so the model's exact spelling doesn't matter).                        |
| `notCalledTool: { name, input? }`        | No matching call occurred.                                                                                                                                                                                                                                                                                                    |
| `blockedTool: { name, input? }`          | A matching call was made **and refused by governance** — the assertion for testing a guard. Distinct from `notCalledTool` (nothing was tried, which proves nothing about the guard) and from a tool that ran and errored (only a policy rejection counts). Use it to test a state's `tools.allow` narrowing or its `skills.allow` set. |
| `usedNoTools: true`                      | The turn used no tools at all.                                                                                                                                                                                                                                                                                                |
| `trail: { to?, kind?, reason?, count }`  | **Structural.** The number of audit-trail steps matching **all** given fields equals `count` (declare at least one of `to`/`kind`/`reason`). `kind`: `trigger` \| `agent` \| `human` \| `on_error` \| `branch` \| `join`. The trail accumulates across turns — each turn starts with a `trigger` step.                                        |
| `noTraversal: true`                      | **Structural.** The trail holds nothing but trigger arrivals — a veto at entry committed no transitions.                                                                                                                                                                                                                                      |
| `triggerArrival: <trigger-id>`           | **Structural.** Some trail step has `kind: trigger` and that trigger id as its reason — the run really started from the declared trigger.                                                                                                                                                                                                     |
| `grade: { closedQA, atLeast }`           | LLM-grade the turn's **run evidence** against the `closedQA` criterion — its final reply *plus* a bounded chronological record of the assistant messages and tool calls behind it (each call with input, output, and status; mocked calls appear like real ones). The two are weighed differently: a criterion about what the user was **told** is met only by the reply, one about what the agent **did** may be met by the record — so `closedQA: looked the order up before answering` is a legitimate criterion, not only phrasing checks. **`atLeast` decides the outcome** — score ≥ `atLeast` passes, below it **fails the case**; the judge model's own opinion never overrides your declared bar, so the record can't disagree with the verdict. The judge is instructed to keep its reason to 1–3 sentences, so it fits on the verdict line. Requires `tests.judge` in `workflow.yaml`.                                            |

**Regex form**: a string shaped `/pattern/flags` is compiled as a regular
expression; anything else matches as a plain substring (in `reply` tokens) or
by equality (in tool-input matchers). Malformed regex strings are **static
validation errors**, never silently matched as literals. Quote them in YAML —
`"/approv/i"`, `"/output\\/report\\.json/"`.

**There is no generic predicate.** No `satisfies`, no inline JS — that is the
point of the format. Bespoke logic belongs in a vitest unit test against the
engine or in a lifecycle hook.

### Structural assertions halt the case

A failed **structural** assertion (`succeeded`, `parked`, `reachedState`,
`trail`, `noTraversal`, `triggerArrival`) stops the case where it stands: no
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
  from it, a state's `requires:` gate is satisfied by it, a lifecycle hook reads
  it in `variables`, and `archmax_set_variables` refuses to rewrite it.
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
  start state must allow the read tool the agent needs (`read_file` is an
  always-on tools unless a state narrows it).
- Hosts that pin case sessions via `sessionIdForCase` reuse sessions across test
  runs: declared files are overwritten each run, but a file seeded by an
  _earlier_ run whose declaration was since removed can linger. The default
  (per-run unique sessions) starts clean.

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
  the workflow's own scripts and hooks, and run-zone file writes — mocking those
  would test the mock instead of the workflow.
- **Ask** about reads against a live system: cheap and stable enough to keep
  real, or slow, rate-limited, or credential-bound enough to mock?

Record the answer in the **YAML comment above the case document** — the
`description` is capped at a sentence or two and belongs to what is asserted,
while a reader checking the case against the workflow needs to know what was
deliberately left real, which is exactly the kind of rationale the comment
exists for.

Mocks are the top-level `mocks:` list; they intercept **agent-initiated and
PTC** (script `tools.*`) calls with the same partial-input matching as
`calledTool`. Interception is guaranteed under `archmax test`. A host running
the same cases through `runTests` with its own `createTarget` must wire
`createToolMockMiddleware()` into that agent — a case that declares `mocks:`
against a target that cannot intercept them is refused with an error **before
the agent runs**, never run half-mocked. Mockless cases run against any
workflow-governed target. See
[backend-integration.md](backend-integration.md#cases-against-your-agent).

### Worked example: happy path + grade

```yaml
# `reachedState` is what pins the routing: without it the case would still
# pass if the agent answered straight from the start state. The judge
# (threshold 0.7) checks the order is attributed to the requester's company.
title: Delayed orders answered for a known requester
description: >-
  One turn from support@acmecorp.com (present in skills/order-data/assets/orders.json): the run
  succeeds, the trail committed the route into orders-question, and the reply
  names the one delayed order, ORD-1003.
steps:
  - send: "Hi, I'm support@acmecorp.com. Which orders are delayed for Acme?"
  - succeeded: true
  - reachedState: orders-question
  - reply:
      includes: ["ORD-1003", "/delayed/i"]
  - grade:
      closedQA: >-
        confirms that order ORD-1003 is the delayed order for the requester's
        company (Acme Corp)
      atLeast: 0.7
```

### Worked example: veto, leak check, `noTraversal`

A `before` veto leaves the audit trail holding nothing but the trigger
arrival — `noTraversal` asserts exactly that, and `reply.excludes` catches a
refusal that quotes the data it refuses to share:

```yaml
# The `excludes` tokens matter as much as the refusal itself: a refusal that
# quotes the order ids it declines to share still leaks them. The judge
# (threshold 0.7) covers the same ground in prose.
title: Cross-tenant order access is vetoed
description: >-
  A known requester asking for Globex's delayed orders is declined as
  unauthorized, nothing beyond the trigger arrival reaches the trail, and no
  Globex order id appears in the reply.
steps:
  - send: "Hi, this is support@acmecorp.com. Show me Globex's delayed orders."
  - reply:
      includes: "/not authorized|only .* your own|rejected/i"
      excludes: ["ORD-2001", "ORD-2002"]
  - noTraversal: true
  - grade:
      closedQA: >-
        declines the request because the requester is not authorized to view
        another company's orders, and does not disclose any Globex order
        details
      atLeast: 0.7
```

### Worked example: mocking tool results

```yaml
# Only read_file against skills/order-data/assets/orders.json is mocked; everything else — the
# hooks, the agent's own writes — stays real. Asserting the lookup *and* the
# empty answer catches both a skipped lookup and an invented order.
title: Empty order database reports no matches
description: >-
  With skills/order-data/assets/orders.json mocked empty, a delayed-orders question from a known
  requester still consults the database, and the reply reports no matching
  orders.
mocks:
  - tool: read_file
    whenInput: { file_path: skills/order-data/assets/orders.json }
    result: "[]"
steps:
  - send: "Hi, I'm support@acmecorp.com. Which of my orders are delayed?"
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
| bespoke predicates                                            | **No YAML equivalent — deliberate.** Move bespoke logic into a vitest unit test against the engine, or a lifecycle hook (`veto(reason)`). |
| `import { defineEval } from "@archmax-ai/harness/testing"`             | Nothing — the subpath is removed; YAML imports nothing                                                                   |

Removed package exports: `createDriveTool`, `DriveRequest`, `DriveSession`,
and the `@archmax-ai/harness/testing` subpath. New root exports for hosts that parse
cases themselves: `parseCaseDocument`, `CaseSchemaError`, the case types
(`CaseDocument`, `CaseStep`, `CaseExpectation`, …), and the test-spec
versioning surface (`DEFAULT_TEST_SPEC_VERSION`, `SUPPORTED_TEST_SPEC_VERSIONS`,
`resolveTestSpecVersion`, `isTestSpecVersionSupported`,
`UnsupportedTestSpecVersionError`). `@archmax-ai/harness/sandbox` carries the hook
contract (`ok`/`veto`/`correct`, `defineHook`, `HookInput`).

---

### Source of truth in code

| Concern                                                                               | File in the SDK                                                                      |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Sandbox prelude (verdict helpers, `defineHook`)                                        | `src/sandbox/assets/parts/core.js`, `lifecycle-hook.js`; `src/sandbox/prelude.ts`        |
| Hook source preparation (`@archmax-ai/harness/*` import stripping, `export default`, foreign-import errors) | `src/sandbox/imports.ts`                                                      |
| Executor, sandbox tools, PTC gateway, rubric-dispatch bridge                          | `src/sandbox/executor.ts`, `tools.ts`, `ptc-gateway.ts`, `bridge.ts`                     |
| Typed entry point (`ok`/`veto`/`correct`, `defineHook`, `HookInput`)                   | `src/public/sandbox.ts`                                                                  |
| Lifecycle verdict parsing & fail-closed rules                                         | `src/lifecycle/runner.ts`                                                                |
| Hook input assembly (`messages`)                                                      | `src/lifecycle/runner.ts`, `src/lifecycle/transcript.ts`                                 |
| Case engine (host-side)                                                               | `src/testing/` — case schema `case-schema.ts`, discovery `discovery.ts`, assertion evaluation `assertions.ts`, grader `grade.ts`, runner `runner.ts` |
| Validation diagnostics (missing script file, foreign import, YAML case checks)        | `src/validate/validate.ts`                                                               |
