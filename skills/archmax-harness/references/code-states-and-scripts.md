# Code-state scripts and `archmax_run` scripts — contracts

Load this when writing a `workflows/<slug>/scripts/*.js` code-state script or a
`skills/<cap>/scripts/*.js` source. Worked examples, graders and the sandbox details:
[`code-state-and-test-scripts.md`](code-state-and-test-scripts.md) Part 1.

## Code-state script contract

A `type: code` state runs its `script: scripts/<file>.js` on entry, with no model
call. The default export is called once with the state's input and **moves the
session itself**; its return value is never read. The typed import is optional
(`import { defineCodeState } from "@archmax-ai/harness/sandbox";`, placed below the
JSDoc; no other import is allowed).

```js
/**
 * Request screen — the request must name a requester the order records know.
 *
 * Reads the first user message from the session's history, extracts the first
 * email address, reads skills/order-data/assets/orders.json (this state enables
 * `order-data`) and matches the address against every record's `email`,
 * case-insensitively.
 *
 * Advances to identify-case when it matches; otherwise to decline, with a reason
 * naming what was missing. An unreadable order database throws, so the state
 * fails through its on_error.
 */
import { defineCodeState } from "@archmax-ai/harness/sandbox";

export default defineCodeState(async ({ tools }) => {
  const { messages } = JSON.parse(await tools.archmax_get_history());
  const orders = JSON.parse(await tools.read_file({ file_path: "skills/order-data/assets/orders.json" }));
  const text = messages.find((m) => m.role === "user")?.text ?? "";
  const email = text.match(/[\w.+-]+@[\w.-]+\.\w{2,}/)?.[0];
  if (!email) return tools.archmax_advance({ to: "decline", reason: "The request names no email address." });
  if (!orders.some((o) => o.email?.toLowerCase() === email.toLowerCase())) {
    return tools.archmax_advance({ to: "decline", reason: `"${email}" is not in the order database.` });
  }
  await tools.archmax_advance({ to: "identify-case", reason: `${email} is a known requester.` });
});
```

| Input | Meaning |
| --- | --- |
| `state` | the code state's own slug |
| `trigger?` | the turn's trigger id string (its payload is in `variables`) |
| `variables` | read-only `name → value` map incl. `trigger`; structured values whole; write with `tools.archmax_set_variables` |
| `tools` | **exactly this state's surface**, async, by own name or camelCase (`tools.read_file`, `tools.readFile`): its grants (the workflow-wide grant included, minus `write_todos`, `archmax_eval`, `archmax_run`), the host's essential tools, and the controls `archmax_advance` (absent when terminal), `archmax_raise`, `archmax_get_variables`, `archmax_set_variables`, `archmax_get_history` — the same set a grader gets. Anything else is `undefined`; a call with no argument passes `{}` |

**The session's history** is read, not passed in:
`const { messages, trail } = JSON.parse(await tools.archmax_get_history())` — the
same `SessionHistory` a grader reads, the session as it stood when the state was
entered, whole and oldest first.

| Field | Meaning |
| --- | --- |
| `messages` | the **whole** transcript, `{ role, text, toolCalls?, tool?, id?, note? }`; roles `user`/`assistant`/`tool`/`system`/`runtime` (a runtime note, `note` naming its kind; match `role === "runtime"`, never a `[bracket]`). An `assistant` entry lists the calls it made in `toolCalls` (`{ id?, name, args }`); the `tool` entry whose `id` matches carries the tool's name in `tool` and its result in `text` (`JSON.parse` it when the tool returns JSON) |
| `trail` | the whole trail, `{ to, kind, reason?, workflow?, status?, ts }`; `kind` is `trigger`/`agent`/`human`/`grader`/`code`/`sub-workflow`/`reset`/`on_error` — count rounds here |

| The script… | Effect |
| --- | --- |
| calls `tools.archmax_advance({ to, reason })` and finishes | the session moves; `reason` reaches the next state as a `[code]` runtime note and the trail as a `kind: code` step |
| calls `tools.archmax_raise({ code, reason })` | the session ends `failed` with that code and reason |
| finishes without either, in a terminal state | the session completes, held to the trigger's `returns` |
| finishes without either, in a non-terminal state | **fails**: `code state '<slug>' finished without calling archmax_advance or archmax_raise` → `on_error` |
| throws, times out (`settings.timeoutMs`), imports a foreign module, or its file is missing | fails → `on_error` (else the session ends rejected); a recorded advance is discarded, a raise still stands |

A refused call **rejects** with governance's reason, and a `try`/`catch` can
handle it: a blocked tool, an `archmax_advance` to an undeclared target, or one
made while the state's `requires` are unmet. The first accepted advance or raise is
the state's decision; a later one is refused. A write with `archmax_set_variables`
is visible to the script's later calls, so it can set what `requires` names and
then advance. Each run starts in a fresh REPL; `console.log` lines become
`code-output` events. A file with no default export runs as a plain script, reading
the same input from the global `args` and calling the global `tools`.

**Governance is the state's own.** Every `tools.*` call is decided against the code
state, exactly as the agent's calls are: grant what the script reads or calls in
*that* state's `skills.allow` / `mounts.allow` / `tools.allow`; its `forbid`,
`forbid_always` and the safety rules bind it. A code state is never offered
`write_todos`, `archmax_eval`, `archmax_run`, `archmax_wait`, `archmax_reset` or
`task`, even when the workflow's `tools.allow_always` lists one (naming one in its
own `tools.allow` is a `validate` error). Neither script kind can read `workflows/**`.

## `archmax_run` script contract

`skills/<cap>/scripts/<x>.js`: plain script, top-level `await`, `tools.*`,
`console.log`; the **last expression** is the tool result. Input is the global
`args`: the arguments the model passed plus `args.variables` (read-only snapshot).
No control tool and no `task` is on its `tools`. Fan-out shape:

```js
/** One sub-run per requested order, all in flight at once; returns [{ order_id, ...returns }]. */
const orders = args.variables?.orders_to_enrich ?? [];
await Promise.all(orders.map(async (o) => {
  const answer = await tools.archmaxWorkflowEnrichOrder({ order_id: o.order_id });
  return { order_id: o.order_id, ...JSON.parse(answer).returns };
}));
```

The calling state must allow every tool the script calls (here
`archmax_workflow_enrich-order`). A script's `tools` holds exactly the calling
state's tools, re-scoped at every evaluation (so after an advance the same REPL
holds the next state's); a tool the state does not offer is `undefined`, and a call
the state's guards refuse rejects with governance's reason. The listing is
camelCased, but a tool's own name reaches the same function
(`tools["archmax_workflow_enrich-order"]`, `tools.read_file`).

**Return into a variable.** A script's result reaches the model as one tool
message and no further — it is not written to the variable store, and a script
cannot write there itself. Return structured data and name the variable in the
calling state's `requires:`; the model then records it with
`archmax_set_variables`, which is what makes it survive the state, guard a
`tools.allow` glob, and be quotable downstream as `${{name}}` instead of retyped.
A result worth computing is worth naming.
