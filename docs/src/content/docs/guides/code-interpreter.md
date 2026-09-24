---
title: Code interpreter
description: Sandboxed QuickJS code execution with archmax_eval, archmax_run, programmatic tool calling, and lifecycle hooks.
sidebar:
  order: 7
---

When a workflow is present, the runtime wires up a QuickJS sandbox. `archmax_eval`,
`archmax_run` and lifecycle hooks all run in the **same sandbox**. What differs is
who chose to run the code, and on whose authority.

[Cases](/guides/testing/) are declarative YAML, interpreted
host-side. The sandbox reaches a case through the hooks and scripts of the agent
it drives.

## Two entry points, one sandbox

| Tool | Source of the code | Governance |
| --- | --- | --- |
| `archmax_eval` | inline, written by the model | always-on; every state has it |
| `archmax_run` | an authored **file** in a skill bundle | always-on; narrow the paths per state (`tools.allow`) |

Both evaluate in the same REPL session for a run. A helper a script file defines
is therefore in scope for a later `archmax_eval` call. Both get:

- **Programmatic tool calling (PTC)**, under the `tools` namespace with
  camelCased names: `await tools.readFile({ file_path: "skills/order-data/assets/orders.json" })`.
  It exposes every agent tool except the runtime's own controls, both sandbox
  tools among them.
- **`console.*` capture** and REPL state that persists across calls.
- The last expression is returned to the model.

There is no `task()` global in any sandbox context, hook scripts included.
Dispatching a grading rubric is the runtime's own job, through the framework
`task` tool that a safety rule keeps out of the agent's reach.

### What an `archmax_run` script receives

The script reads its input as the global `args`: **the arguments the model passed,
plus `args.variables`**. `args.variables` holds the session's variables as a flat
`name → value` map, exactly as a hook receives them. A script therefore reads the
run's input without the model having to retype it:

```js
/** One sub-run per order in `orders_to_enrich`. */
const orders = args.variables?.orders_to_enrich ?? [];
const results = await Promise.all(
  orders.map((o) => tools.archmaxWorkflowEnrichOrder({ order_id: o.order_id })),
);
results;
```

`args.variables` is a read-only snapshot. The variable tools are excluded from
PTC, so a script cannot write the store. It returns a value instead, and the
model records it with `archmax_set_variables`. A state's `requires:` is what makes
that mandatory.

`${{…}}` is not substituted inside a script's `tools.*` calls. The script already
holds the values and composes strings in JavaScript, so such text in an argument
is passed to the tool verbatim. The call is still governed exactly as the model's
own would be.

A state's `${{name}}` argument guard resolves against the run's variables. So a
script passing the literal value the guard names is admitted, and any other value
is blocked.

`archmax_run` reads its source **through the configured backend**. Authored
scripts therefore run against whatever backend the runtime is configured with, a
remote one included.

Configure the sandbox via `settings` in `workflow.yaml`:

```yaml
settings:
  timeoutMs: 15000
```

## Governance

`archmax_eval` is **always on**: every state has it without declaring it. That is
safe because evaluated code reaches exactly what the state already permits (see
the PTC rule below). The sandbox adds computation over a state's surface.

`archmax_run` is always on for the same reason. A script is a file the state could
already read, and running it reaches what an inline `archmax_eval` of the same
source reaches.

Which authored files a state may execute is still a real governance question.
Answer it by *narrowing*, the way you would narrow `write_file`. A state's own
entry wins over the always-on grant:

```yaml
states:
  orders-question:
    tools:
      allow:
        # only these scripts may run in this state
        - { tool: archmax_run, args: { file_path: ["skills/orders/scripts/lookup-*.js"] } }
```

**`archmax_run` executes only scripts inside a skill bundle.** A non-overridable
kernel rule (`script.skill-only`) enforces that ahead of workflow `policy`,
consumer rules, and the per-state allow list. A state's entry therefore
*narrows* within the bundles. Two consequences:

- A script the agent writes into `scratchpad/` cannot be run.
- A **lifecycle hook** cannot be run by the agent either. Hooks live on the
  authoring plane (`workflows/<slug>/hooks/`). The runtime runs them, and the
  agent can neither read nor execute them. See
  [The authoring plane](/guides/authoring-plane/).

An entry naming paths outside every bundle (`["**"]`, `["scratchpad/**"]`) grants
nothing, and `archmax validate` reports it as inert. A state that declares no entry
may run any bundled script its enabled skills expose.

Every PTC call sandboxed code makes is **also** governed, individually, at the
moment it runs. That code runs on the model's authority.

Take `tools.writeFile(...)` from inside `skills/orders/scripts/lookup.js`, or from
an inline `archmax_eval` snippet. It is checked against the active state exactly as
a `write_file` tool call from the model would be: same allow list, same argument
constraints, same `tools.forbid_always`, same safety rules. So governing
`archmax_run` by path decides *which files may run*, and what a file may do once it
runs stays with the state.

To close the sandbox for a whole workflow, deny both tools in
[`tools.forbid_always`](/reference/machine-spec/#toolsforbid_always--toolsforbid-denial).
Workflow denials are evaluated ahead of the per-state defaults, so a denial there
outranks the always-on grant.

An `allow_always` entry constraining `archmax_eval` is **inert**. Always-on tools
are permitted everywhere, and a per-state entry is what narrows them.
`archmax validate` warns about it.

A tool named bare `eval` (upstream's default name for an interpreter, or a host
tool claiming it) stays blocked by a non-overridable safety rule.

A refused call throws inside the sandbox, so a script can handle it:

```js
try {
  await tools.writeFile({ file_path: "scratchpad/report.md", content: body });
} catch (err) {
  // err.message carries the governance reason, e.g. "[workflow] BLOCKED: …"
}
```

The block is fail-closed whether or not the script catches it: the underlying
tool never runs.

Blocked and allowed PTC calls both surface on the event stream (`tool-blocked`,
`tool-called`/`tool-result`). Each carries `origin: "script"`, or `"lifecycle"`
for a hook. That is how the CLI renders them as
`read_file skills/order-data/assets/orders.json via lifecycle hook`.

## Lifecycle hooks

`archmax_run` lets the **model** choose to run a script. `before`/`after` hooks
belong to the **runtime**, which runs them deterministically at fixed points in
the graph. They use the same sandbox and the same PTC bridge.

A hook runs on the runtime's authority, so the active state's `allow` list does
**not** narrow its `tools.*` calls. A hook usually needs evidence the state
itself withholds. Everything else still binds:

- the non-overridable safety rules, a write into the read-only authored zone
  among them
- the workflow's `tools.forbid_always`
- any consumer governance rules

A hook is a JavaScript file whose default export is an async function. It is
called with **one object** and answers with a **verdict**:

```js
// workflows/order-lookup/hooks/check-requester.js
/** Vetoes a request from a requester the order records do not know. */
export default async function hook({ state, phase, trigger, variables, messages, tools }) {
  const orders = JSON.parse(await tools.readFile({ file_path: "skills/order-data/assets/orders.json" }));
  const request = messages.find((m) => m.role === "user")?.text ?? "";
  const email = request.match(/[\w.+-]+@[\w.-]+/)?.[0];
  if (!email) return veto("No email address found in your request.");
  if (!orders.some((o) => o.email === email)) return veto(`"${email}" is not in the order database.`);
  return ok();
}
```

The input (`HookInput` in `@archmax-ai/harness/sandbox`; also available as the global `args`):

| Field | Meaning |
| --- | --- |
| `state`, `phase` | The state whose hook is running, and `"before"` or `"after"`. |
| `trigger` | The trigger id the run started from. The run's input arrives in `variables`. |
| `variables` | The session's variables as a plain `name → value` map, including the built-in `trigger`. Read-only. |
| `messages` | The recent transcript, newest last, as `{ role, text, toolCalls? }` objects. `role` is `user`, `assistant`, `tool` (with `tool: <name>`), `system`, or `runtime`. A `runtime` entry is a note the runtime wrote (an arrival, a decision, an error route), and `note` says which kind. |
| `from`, `to`, `reason` | `after` hooks on an advance: the transition being attempted and the agent's reason. |
| `tools` | The PTC bridge, camelCased: `tools.readFile({ file_path })`. |

The verdict helpers are globals:

| Verdict | Effect |
| --- | --- |
| `ok()` | Proceed. Returning nothing means the same. |
| `veto(reason)` | Block, with the reason shown to the agent. |
| `correct(reason)` | `after` hooks only: hand the state back for another attempt, bounded by the hook's `max_iterations`. |

Any other value is no verdict, and vetoes fail-closed. Hooks are **fail-closed**
throughout: one that throws, or whose file is missing, vetoes with the error as
the reason. If a script can fail for reasons that should *not* block the
transition, catch the error and return `ok()`.

A script that wants a model verdict gets a `rubric:` hook declared beside it in
the same list, and the runtime dispatches that one.

`defineHook(fn)` is an alias for `export default fn`. A file with no default
export is evaluated as a plain script, and its completion value is the verdict.
So `orders.length ? ok() : veto("no orders")` on the last line works too.

A bare `false` is read as a veto, with the reason `precondition not met`. The
transcript is `messages`; there is no other view of the session.

## Typed sandbox imports

Hook files may import their authoring types from the SDK:

```js
import { ok, veto, correct, defineHook } from "@archmax-ai/harness/sandbox";
```

The import is a pure type carrier for IDE completion. The line is stripped before
QuickJS evaluates the file, and inside the sandbox the names come from the
prelude.

The sandbox accepts `@archmax-ai/harness/*` specifiers. Any other import is an
**error**, reported by `archmax validate` and refused at execution. Authoring
against the bare globals, with no import line at all, stays valid.

## Description frontmatter

Every authored code file (hooks and `archmax_run` scripts) opens with a plain
leading JSDoc block (`/** ... */`): a **title** line, a blank line, then a
**description** in prose. It is the code-file analogue of `workflow.yaml`'s
`description`, and admin UIs display it instead of the code. It has no bearing on
runtime behavior.

Write the description deep enough to review on its own. Cover what the code does
*and how it does it*: the inputs it reads, the sequence of checks, and each
outcome it can produce. For a hook, that means the condition behind every `ok`,
`correct` and `veto`. Go past a one-line label.

Write prose a human can refine like a specification, then make the code follow.
Update the block before you change the code, so the two stay in step.

There are no special tags. The extractor truncates the description at the
first `@tag` line, so keep the title and body above any tag.

`archmax validate` does not check the block, so it stands as an authoring
convention. (Cases carry a mandatory `description` key, which their schema does
enforce.) Consumers extract the block with the exported
[`parseCodeDescription`](/reference/public-api/#parsecodedescription-code-description-frontmatter)
helper.

## The working area

Each session gets **one** isolated, agent-visible working area at `scratchpad/…`.
It sits alongside the runtime's offload areas and the runtime-internal checkpoints
and artifacts.

On disk it is a local directory per session under
`<root>/sessions/<sessionId>/scratchpad/`, gitignored, and addressed without the
session id. Everything a run produces goes here: staged CSVs, unzipped payloads,
files handed between scripts, and the artifacts a state is asked to write.

`scratchpad/**` reads and writes are permitted in **every** state, with no
per-state `allow` entry. An entry naming a path inside the area does not narrow
where within it a write may land, and `archmax validate` warns when you author
one.

When the write itself must be governed, name an ordinary run path. Any run-root
path outside the reserved areas is matched against the state's `tools.allow`.

The working area persists for as long as the rest of the run, with no separate
retention setting.
