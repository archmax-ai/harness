# Hook scripts and `archmax_run` scripts — contracts

Load this when writing a `workflows/<slug>/hooks/*.js` gate or a
`skills/<cap>/scripts/*.js` source. Worked examples and the sandbox details:
[`hook-and-test-scripts.md`](hook-and-test-scripts.md) Part 1.

## Hook script contract

Default-export function; its return value is the verdict. Verdict helpers are
globals (typed import optional: `import { ok, veto, correct } from "@archmax-ai/harness/sandbox";`,
placed below the JSDoc; no other import is allowed).

```js
/**
 * Requester gate — the request must name a requester the order records know.
 *
 * Reads the first user message, extracts the first email address, loads
 * skills/order-data/assets/orders.json through the bridge and matches the
 * address against every record's `email`, case-insensitively.
 *
 * Vetoes when the file cannot be parsed, no address is present, or none
 * matches — each with the reason. Otherwise ok.
 */
export default async function hook({ state, phase, trigger, variables, messages, tools, from, to, reason }) {
  let orders;
  try { orders = JSON.parse(await tools.readFile({ file_path: "skills/order-data/assets/orders.json" })); }
  catch { return veto("Could not load skills/order-data/assets/orders.json."); }
  const text = messages.find((m) => m.role === "user")?.text ?? "";
  const email = text.match(/[\w.+-]+@[\w.-]+\.\w{2,}/)?.[0];
  if (!email) return veto("Include your email address so we can look up your account.");
  if (!orders.some((o) => o.email?.toLowerCase() === email.toLowerCase())) return veto(`"${email}" is not in the order database.`);
  return ok();
}
```

| Input | Meaning |
| --- | --- |
| `state`, `phase` | state slug; `"before"` or `"after"` |
| `trigger` | trigger id string (payload is in `variables`) |
| `variables` | read-only `name → value` map incl. `trigger`; structured values whole |
| `messages` | last 24 messages, newest last, `{ role, text, toolCalls? }`; roles `user`/`assistant`/`tool`/`system`/`runtime` (a runtime note; match `role === "runtime"`, never a `[bracket]`) |
| `from`, `to`, `reason` | `after` only: the attempted transition and the agent's reason |
| `tools` | async camelCased bridge: `tools.readFile`, `tools.writeFile`, `tools.archmaxWorkflowEnrichOrder(...)`; no variable tools, no `task` |

| Return | Effect |
| --- | --- |
| `ok()`, nothing, `true`/number/string | proceed |
| `veto(reason)` | block; the reason is shown to the agent — make it actionable |
| `correct(reason)` | `after` only: retry with the reason, within `max_iterations` |
| `false` | veto ("precondition not met") |
| any other object, a throw | veto with keys/error named — never silently ok |

`console.log` goes to the trail. A file with no default export uses its
completion value as the verdict. Parse inputs defensively; turn a failure that
should not block into an explicit `ok()`.

## `archmax_run` script contract

`skills/<cap>/scripts/<x>.js`: plain script, top-level `await`, `tools.*`,
`console.log`; the **last expression** is the tool result. Input is the global
`args`: the arguments the model passed plus `args.variables` (read-only snapshot).
No `archmax_advance`, `archmax_set_variables` or `task`. Fan-out shape:

```js
/** One sub-run per requested order, all in flight at once; returns [{ order_id, ...returns }]. */
const orders = args.variables?.orders_to_enrich ?? [];
await Promise.all(orders.map(async (o) => {
  const answer = await tools.archmaxWorkflowEnrichOrder({ order_id: o.order_id });
  return { order_id: o.order_id, ...JSON.parse(answer).returns };
}));
```

The calling state must allow every tool the script calls (here
`archmax_workflow_enrich-order`).

**Return into a variable.** A script's result reaches the model as one tool
message and no further — it is not written to the variable store, and a script
cannot write there itself. Return structured data and name the variable in the
calling state's `requires:`; the model then records it with
`archmax_set_variables`, which is what makes it survive the state, guard a
`tools.allow` glob, and be quotable downstream as `${{name}}` instead of retyped.
A result worth computing is worth naming.
