---
title: Code interpreter
description: Sandboxed QuickJS code execution with archmax_eval, archmax_run, programmatic tool calling, and code states' scripts.
sidebar:
  order: 7
---

When a workflow is present, the runtime wires up a QuickJS sandbox. `archmax_eval`, `archmax_run`
and the scripts of [code states](/guides/automated-states/#code-states) all run in it. What differs
is who chose to run the code, and which state's tools it reaches.

[Cases](/guides/testing/) are declarative YAML, interpreted on the host. They reach the sandbox
only through the scripts and code states of the session they drive.

## Two entry points, one sandbox

| Tool | Source of the code | Governance |
| --- | --- | --- |
| `archmax_eval` | inline, written by the model | a default tool; granted wherever the workflow-wide grant includes it |
| `archmax_run` | an authored **file** in a skill bundle | a default tool; narrow the paths per state (`tools.allow`) |

Both evaluate in the session's one REPL, so a helper a script file defines is in scope for a later
`archmax_eval` call. REPL state persists across calls, `console.*` output is captured, and the last
expression is returned to the model.

### Calling tools from a script

A script calls tools through the `tools` namespace, **programmatic tool calling** (PTC):

```js
const orders = JSON.parse(await tools.readFile({ file_path: "skills/order-data/assets/orders.json" }));
```

- **Two spellings.** A tool answers to its camelCased key (`tools.readFile`) and to its own name
  (`tools.read_file`, `tools["archmax_workflow_enrich-order"]`), which is how a model tends to write
  it. `Object.keys(tools)` lists the camelCased keys.
- **The active state's tools.** `tools` holds the tools the model's own tool list carries in that
  state, without the runtime's controls and the two sandbox tools. The view is scoped again at the
  start of every evaluation, so after an `archmax_advance` the next `Object.keys(tools)` shows the
  new state's tools. `tools` stays one object for the whole REPL session, so a helper or a
  `const t = tools` from an earlier call reads the current state too, and a script that overwrites
  `tools` gets it back at its next evaluation.
- **Anything else is `undefined`.** A tool the state does not offer is `undefined` under either
  spelling, and `"name" in tools` is false. Calling it throws a `TypeError` the script can catch;
  no tool event is emitted, and the tool never runs. Test for a tool with
  `typeof tools.lookupOrder === "function"` before relying on it.
- **Arguments and results.** A call with no argument is made with `{}`, so `tools.ls()` needs none.
  A result arrives as text. For a binary file, `tools.readFile` resolves to the notice
  `Error: '<path>' is a binary file (…) and was not read; …`, an image included even with the
  `images` option on (see [text only](/guides/workflow-machine/#text-only)), so check before you
  `JSON.parse` it.
- **Moving files.** To duplicate, move or delete a file, call
  `tools.copyFile({ source, destination })`, `tools.moveFile(…)` or `tools.removeFile({ file_path })`
  rather than reading and writing it back. The bytes move, binary files included, without paging
  through `readFile`'s line limit, and each call resolves to one line (`Copied …`, `Moved …`,
  `Removed …` or `Error: …`).

There is no `task()` global in any sandbox context, code states' scripts included, and `tools.task`
is `undefined`. A step that needs a model's judgement is a
[grader state](/guides/automated-states/#grader-states) on the graph.

### What an `archmax_run` script receives

The script reads its input as the global `args`: **the arguments the model passed, plus
`args.variables`**, the session's variables as a flat `name → value` map. A script therefore reads
the session's input without the model having to retype it:

```js
/** One sub-run per order in `orders_to_enrich`. */
const orders = args.variables?.orders_to_enrich ?? [];
const results = await Promise.all(
  orders.map((o) => tools.archmaxWorkflowEnrichOrder({ order_id: o.order_id })),
);
results;
```

`args.variables` is a read-only snapshot, and the variable tools are not in `tools`, so a script
cannot write the store. It returns a value instead, and the model records it with
`archmax_set_variables`; a state's `requires:` makes that mandatory.

`${{…}}` is not substituted inside a script's `tools.*` calls. The script already holds the values
and composes strings in JavaScript, so such text is passed to the tool verbatim. The call is still
governed exactly as the model's own would be, and a state's `${{name}}` argument guard resolves
against the session's variables: a script passing the literal value the guard names is admitted,
and any other value is blocked.

`archmax_run` reads its source **through the configured backend**, so authored scripts run against
whatever backend the runtime is configured with, a remote one included. Configure the sandbox with
`settings` in `workflow.yaml`:

```yaml
settings:
  timeoutMs: 15000
```

### A script lives as long as its turn

When a host cancels a turn by aborting the `signal` it passed to `send`, every script of that turn
stops: `archmax_eval`, `archmax_run` and code states' scripts, in the session and in the child
sessions it dispatched.

- The evaluation ends with an error at once, not at `timeoutMs`.
- A `tools.*` call still pending fails with `Tool '<name>' failed: the turn was aborted`.
- A call the script makes after that is refused the same way, before it reaches the tool. A retry
  in a `catch` therefore starts nothing, and no sub-workflow is dispatched under a cancelled turn.

## Governance

`archmax_eval` is one of the **default tools**. A workflow that does not declare
`tools.allow_always` grants it in every agent and human state, and a workflow that declares the
list grants it wherever the list, or a state's own `tools.allow`, names it. Granting it broadly is
safe because evaluated code reaches exactly what the state already permits: the sandbox adds
computation over a state's surface, not reach. `archmax_run` is a default tool for the same reason.
A script is a file the state could already read, and running it reaches what an inline
`archmax_eval` of the same source reaches.

A grader or code state is never offered either sandbox tool, even where `allow_always` lists it,
and a `tools.allow` entry naming one on such a state is an `archmax validate` error.

Which authored files a state may execute is still a real governance question. Answer it by
*narrowing*, the way you would narrow `write_file`; a state's own entry wins over the workflow-wide
grant:

```yaml
states:
  orders-question:
    tools:
      allow:
        # only these scripts may run in this state
        - { tool: archmax_run, args: { file_path: ["skills/orders/scripts/lookup-*.js"] } }
```

**`archmax_run` executes only scripts inside a skill bundle.** A non-overridable kernel rule
(`script.skill-only`) enforces that ahead of workflow `policy`, consumer rules and the per-state
allow list, so a state's entry *narrows* within the bundles. Two consequences:

- A script the agent writes into `scratchpad/` cannot be run.
- A **code state's script** cannot be run by the agent either. It lives on the authoring plane
  (`workflows/<slug>/scripts/`): the runtime runs it when the session enters its code state, and
  the agent can neither read nor execute it. See [the authoring plane](/guides/authoring-plane/).

An entry naming paths outside every bundle (`["**"]`, `["scratchpad/**"]`) grants nothing, and
`archmax validate` reports it as inert. A state that declares no entry may run any bundled script
its enabled skills expose. An `allow_always` entry constraining `archmax_run`
(`{ tool: archmax_run, paths: ["skills/orders/scripts/**"] }`) is an ordinary grant, binding in
every state that does not name the tool itself.

Every PTC call sandboxed code makes is **also** governed, individually, at the moment it runs,
against the state it runs for. `tools.writeFile(...)` from `skills/orders/scripts/lookup.js`, or
from an inline `archmax_eval` snippet, is checked exactly as a `write_file` call from the model
would be: same allow list, same argument constraints, same `tools.forbid_always`, same safety rules.
So governing `archmax_run` by path decides *which files may run*, and what a file may do once it
runs stays with the state.

A refused call throws inside the sandbox, with the governance reason in its message
(`[workflow] BLOCKED: …`), so a script can catch it. The block holds whether or not the script
catches it: the underlying tool never runs. Blocked and allowed PTC calls both surface on the event
stream (`tool-blocked`, `tool-called`/`tool-result`), each with `origin: "script"`, a code state's
calls included. That is how the CLI renders them as
`read_file skills/order-data/assets/orders.json via script`.

To close the sandbox for a whole workflow, deny both tools in
[`tools.forbid_always`](/reference/machine-spec/#toolsforbid_always--toolsforbid-denial).
Workflow denials are evaluated ahead of the per-state defaults, so a denial there outranks any
grant. In a workflow that declares `tools.allow_always`, leaving both tools out of the list, and out
of every state's `tools.allow`, withholds the sandbox too.

A tool named bare `eval` (upstream's default name for an interpreter, or a host tool claiming it)
stays blocked by a non-overridable safety rule.

## Code states' scripts

`archmax_eval` and `archmax_run` run code the **model** chose to run. A
[code state](/guides/automated-states/#code-states) runs code the **workflow** ships: when the
session enters a state declaring `type: code`, the runtime runs the file its `script` names,
`workflows/<slug>/scripts/<file>.js`, with no model call.

It shares the sandbox, the PTC bridge and the quotas with the agent's scripts, with these
differences:

- **Its own REPL.** Each run evaluates in a fresh REPL, shared with neither the agent's
  `archmax_eval` nor another code state, and released when the run settles.
- **Its own state's tools.** `tools` is the code state's surface: its own and the workflow-wide
  grants, plus `archmax_advance`, `archmax_raise`, `archmax_get_variables`, `archmax_set_variables`
  and `archmax_get_history`. Each call is governed against the code state, so the state has to
  enable whatever bundle or mount the script reads.
- **Its input.** The default export receives `{ state, trigger, variables, tools }`, and reads the
  session itself with `tools.archmax_get_history()`.
- **No return value.** The session moves only through `tools.archmax_advance` or
  `tools.archmax_raise`. A script that throws, or a non-terminal one that finishes without
  deciding, fails the state.
- **Console lines are events.** Each line logged is a `code-output` event, between `code-start` and
  `code-result`.

The contract and an example are in [the script contract](/guides/automated-states/#the-script-contract).

## Typed sandbox imports

A code state's script may import its authoring types from the SDK:

```js
import { defineCodeState } from "@archmax-ai/harness/sandbox";
/** @typedef {import("@archmax-ai/harness/sandbox").CodeStateInput} CodeStateInput */
```

The import is a type carrier for IDE completion. The line is stripped before QuickJS evaluates the
file, and inside the sandbox the names come from the prelude. The sandbox accepts
`@archmax-ai/harness/*` specifiers. Any other import is an **error**, reported by
`archmax validate` and refused at execution. A script with no import line at all is just as valid.

## Description frontmatter

Every authored code file, a code state's script or an `archmax_run` script, opens with a plain
leading JSDoc block (`/** ... */`): a **title** line, a blank line, then a **description** in prose.
Admin UIs display it instead of the code, and it has no bearing on runtime behavior.

Write the description deep enough to review on its own. Cover what the code does *and how*: the
inputs it reads, the sequence of checks, and each outcome it can produce. For a code state, that
means the condition behind each transition it advances to and each raise. Write prose a person can
refine like a specification, then make the code follow, and update the block before you change the
code.

There are no special tags. The extractor truncates the description at the first `@tag` line, so
keep the title and body above any tag. `archmax validate` does not check the block; it is an
authoring convention. Consumers extract it with the exported
[`parseCodeDescription`](/reference/public-api/#parsecodedescription-code-description-frontmatter)
helper.

## The working area

Each session gets **one** isolated, agent-visible working area at `scratchpad/…`, beside the
runtime's offload areas and its internal checkpoints and artifacts. On the filesystem default it is
a directory per session under `<root>/sessions/<sessionId>/scratchpad/`, addressed without the
session id. Everything a session produces goes here: staged CSVs, unzipped payloads, files handed
between scripts, and the artifacts a state is asked to write.

`scratchpad/` is readable and writable in **every** state, with no per-state `allow` entry, by the
file tools the state is granted. An entry naming a path inside the area does not narrow where within
it a write may land, and `archmax validate` warns when you author one. When the write itself must be
governed, name an ordinary session path: any path outside the reserved areas is matched against the
state's `tools.allow`.

The working area lasts as long as the session, with no separate retention setting.
