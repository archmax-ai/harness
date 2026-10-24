---
title: Code interpreter
description: Sandboxed QuickJS code execution with archmax_eval, archmax_run, programmatic tool calling, and code states' scripts.
sidebar:
  order: 7
---

When a workflow is present, the runtime wires up a QuickJS sandbox. `archmax_eval`,
`archmax_run` and the scripts of [code states](/guides/automated-states/#code-states)
all run in the **same sandbox**. What differs is who chose to run the code, and
which state's tools it reaches.

[Cases](/guides/testing/) are declarative YAML, interpreted
host-side. The sandbox reaches a case through the scripts and code states of the
agent it drives.

## Two entry points, one sandbox

| Tool | Source of the code | Governance |
| --- | --- | --- |
| `archmax_eval` | inline, written by the model | a default tool; granted wherever the workflow-wide grant includes it |
| `archmax_run` | an authored **file** in a skill bundle | a default tool; narrow the paths per state (`tools.allow`) |

Both evaluate in the same REPL session for a run. A helper a script file defines
is therefore in scope for a later `archmax_eval` call. Both get:

- **Programmatic tool calling (PTC)**, under the `tools` namespace with
  camelCased names: `await tools.readFile({ file_path: "skills/order-data/assets/orders.json" })`.
  A tool's own name reaches the same function (`tools.read_file`,
  `tools["archmax_workflow_enrich-order"]`), which is how a model tends to
  write it; the listing names only the camelCased ones.
  It holds **the active state's tools**: the ones the model's own tool list
  carries in that state, without the runtime's controls and the two sandbox
  tools. The view is re-scoped at the start of every evaluation, so after an
  `archmax_advance` the next `Object.keys(tools)` shows the new state's tools.
  `tools` stays one object for the whole REPL session, so a helper or a
  `const t = tools` from an earlier call reads the current state too, and a
  script that overwrites `tools` gets it back at its next evaluation. A tool the
  state does not offer is **`undefined`** under either spelling, and
  `"name" in tools` is false: calling it throws a `TypeError` the script can
  catch, no tool event is emitted, and the tool never runs. Test for a tool with
  `typeof tools.lookupOrder === "function"` before relying on it. A tool's result
  arrives as text:
  `tools.readFile` resolves to the file's content, or, for a binary file, to the
  notice `Error: '<path>' is a binary file (…) and was not read; …` (an image
  included, even with the `images` option on, which shows images to the model
  only; see
  [the workspace](/guides/workflow-machine/#mount-governance)), so check before
  you `JSON.parse` it. To duplicate, move or delete a file, call
  `tools.copyFile({ source, destination })`, `tools.moveFile(…)` or
  `tools.removeFile({ file_path })` rather than reading and writing it back: the
  bytes move, binary files included, without paging through `readFile`'s line
  limit, and each resolves to one line (`Copied …`, `Moved …`, `Removed …`, or
  `Error: …`).
- **`console.*` capture** and REPL state that persists across calls.
- The last expression is returned to the model.

There is no `task()` global in any sandbox context, code states' scripts
included, and `tools.task` is `undefined`. A step that needs a model's judgement
is a [grader state](/guides/automated-states/#grader-states) on the graph.

### What an `archmax_run` script receives

The script reads its input as the global `args`: **the arguments the model passed,
plus `args.variables`**. `args.variables` holds the session's variables as a flat
`name → value` map, exactly as a code state's script receives them. A script
therefore reads the session's input without the model having to retype it:

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

### A script lives as long as its turn

When a host cancels a turn by aborting the `signal` it passed to `send`, every
script of that turn stops. That covers `archmax_eval`, `archmax_run` and code
states' scripts, in the session and in the child sessions it dispatched:

- The evaluation ends with an error at once, not at `timeoutMs`.
- A `tools.*` call still pending fails with
  `Tool '<name>' failed: the turn was aborted`.
- A call the script makes after that is refused the same way, before it reaches
  the tool. A retry in a `catch` therefore starts nothing, and no sub-workflow is
  dispatched under a cancelled turn.

## Governance

`archmax_eval` is one of the **default tools**. A workflow that does not declare
`tools.allow_always` grants it in every agent and human state, and a workflow that
declares the list grants it wherever the list, or a state's own `tools.allow`,
names it. Granting it broadly is safe because evaluated code reaches exactly what
the state already permits (see the PTC rule below). The sandbox adds computation
over a state's surface. A grader or code state is never offered either sandbox
tool, even where `allow_always` lists it, and a `tools.allow` entry naming one on
such a state is an `archmax validate` error.

`archmax_run` is a default tool for the same reason. A script is a file the state could
already read, and running it reaches what an inline `archmax_eval` of the same
source reaches.

Which authored files a state may execute is still a real governance question.
Answer it by *narrowing*, the way you would narrow `write_file`. A state's own
entry wins over the workflow-wide grant:

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
- A **code state's script** cannot be run by the agent either. It lives on the
  authoring plane (`workflows/<slug>/scripts/`). The runtime runs it when the
  session enters its code state, and the agent can neither read nor execute it.
  See [The authoring plane](/guides/authoring-plane/).

An entry naming paths outside every bundle (`["**"]`, `["scratchpad/**"]`) grants
nothing, and `archmax validate` reports it as inert. A state that declares no entry
may run any bundled script its enabled skills expose.

Every PTC call sandboxed code makes is **also** governed, individually, at the
moment it runs, against the state it runs for. No script runs on any wider
authority.

Take `tools.writeFile(...)` from inside `skills/orders/scripts/lookup.js`, or from
an inline `archmax_eval` snippet. It is checked against the active state exactly as
a `write_file` tool call from the model would be: same allow list, same argument
constraints, same `tools.forbid_always`, same safety rules. So governing
`archmax_run` by path decides *which files may run*, and what a file may do once it
runs stays with the state.

To close the sandbox for a whole workflow, deny both tools in
[`tools.forbid_always`](/reference/machine-spec/#toolsforbid_always--toolsforbid-denial).
Workflow denials are evaluated ahead of the per-state defaults, so a denial there
outranks any grant. In a workflow that declares `tools.allow_always`, leaving both
tools out of the list (and out of every state's `tools.allow`) withholds the
sandbox too.

An `allow_always` entry constraining `archmax_run`
(`{ tool: archmax_run, paths: ["skills/orders/scripts/**"] }`) is an ordinary
grant. It binds in every state that does not name the tool itself.

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
`tool-called`/`tool-result`). Each carries `origin: "script"`, a code state's
script calls included. That is how the CLI renders them as
`read_file skills/order-data/assets/orders.json via script`.

## Code states' scripts

`archmax_eval` and `archmax_run` run code the **model** chose to run. A
[code state](/guides/automated-states/#code-states) runs code the **workflow**
ships: when the session enters a state declaring `type: code`, the runtime runs
the file its `script` names, `workflows/<slug>/scripts/<file>.js`, with no model
call.

The script's default export is called with one object, and it moves the session
itself:

```js
// workflows/order-lookup/scripts/screen-request.js
/**
 * Request screen.
 *
 * Finds the requester's email in the first user message and looks it up in
 * skills/order-data/assets/orders.json. Advances to identify-case for a known
 * requester, and to decline, with the reason, otherwise.
 */
import { defineCodeState } from "@archmax-ai/harness/sandbox";

export default defineCodeState(async ({ messages, tools }) => {
  const orders = JSON.parse(await tools.read_file({ file_path: "skills/order-data/assets/orders.json" }));
  const request = messages.find((m) => m.role === "user")?.text ?? "";
  const email = request.match(/[\w.+-]+@[\w.-]+/)?.[0];
  if (email && orders.some((o) => o.email === email)) {
    await tools.archmax_advance({ to: "identify-case", reason: `${email} is a known requester` });
  } else {
    await tools.archmax_advance({ to: "decline", reason: "the request names no known requester" });
  }
});
```

It shares the sandbox, the PTC bridge and the quotas with the agent's scripts,
with these differences:

- **Its own REPL.** Each run evaluates in a fresh REPL, shared with neither the
  agent's `archmax_eval` nor another code state, and released when the run
  settles.
- **Its own state's tools.** `tools` is the code state's surface: its own and the
  workflow-wide grants, and `archmax_advance`, `archmax_raise`,
  `archmax_get_variables` and `archmax_set_variables`. Each call is governed
  against the code state with `origin: "script"`, so the state has to enable
  whatever bundle or mount the script reads. A tool outside the surface is
  `undefined`.
- **Its input.** `{ state, trigger, variables, messages, trail, toolCalls, tools }`:
  the session's whole transcript and trail, and `toolCalls(filter?)`, which
  resolves to the session's tool calls with their results, as the tools returned
  them. A file with no default export reads the same input from the global `args`.
- **No return value.** The session moves only through `tools.archmax_advance` or
  `tools.archmax_raise`. A refused call rejects and can be caught. A script that
  throws, or a non-terminal one that finishes without deciding, fails the state.
- **Console lines are events.** Each line logged is a `code-output` event, between
  `code-start` and `code-result`.

The whole contract is in [grader and code states](/guides/automated-states/).

## Typed sandbox imports

A code state's script may import its authoring types from the SDK:

```js
import { defineCodeState } from "@archmax-ai/harness/sandbox";
/** @typedef {import("@archmax-ai/harness/sandbox").CodeStateInput} CodeStateInput */
```

The import is a pure type carrier for IDE completion. The line is stripped before
QuickJS evaluates the file, and inside the sandbox the names come from the
prelude.

The sandbox accepts `@archmax-ai/harness/*` specifiers. Any other import is an
**error**, reported by `archmax validate` and refused at execution. Authoring
against the bare globals, with no import line at all, stays valid.

## Description frontmatter

Every authored code file (code states' scripts and `archmax_run` scripts) opens with a plain
leading JSDoc block (`/** ... */`): a **title** line, a blank line, then a
**description** in prose. It is the code-file analogue of `workflow.yaml`'s
`description`, and admin UIs display it instead of the code. It has no bearing on
runtime behavior.

Write the description deep enough to review on its own. Cover what the code does
*and how it does it*: the inputs it reads, the sequence of checks, and each
outcome it can produce. For a code state, that means the condition behind each
transition it advances to and each raise. Go past a one-line label.

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
