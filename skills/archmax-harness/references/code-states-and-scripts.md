# Grader states, code states and scripts

Load this when you write a code state's script, a grader state, or a skill bundle's
`archmax_run` script. The keys each state type takes are in
[`workflow-schema.md`](workflow-schema.md#state-keys).

## Pick the mechanism

| The work | Use |
| --- | --- |
| A deterministic check the graph runs at a fixed point: a screen, a policy check, recording a result | a code state |
| A judgment of work already done: tone, completeness, faithfulness | a grader state |
| Deterministic work the agent decides to run: a calculation, a fan-out | an `archmax_run` script in a skill bundle |
| Work that is a process of its own, or shared by several workflows | a sub-workflow |

The agent cannot call a grader or a code state. It reaches one only by a transition.

## How an automated state runs

A grader or code state runs whenever the session reaches it: the agent's advance,
another automated state's advance, a human decision, an `on_error` route, a turn that
opens there, a reset. It runs in place of the agent's next model call, so a chain of
code states makes no model call at all. A chain that never reaches an agent state, a
human state or a completion ends at the turn's `recursionLimit`, with the session
`failed` (`recursion-limit`).

**What it is offered.** Exactly its own state's surface: its `tools.allow`, the
workflow-wide grant, the host's `essentialTools` and its type's controls
([the table](workflow-schema.md#tool-governance)). It has no `archmax_wait`, so it
cannot park. The kernel decides each call against that state, so grant what a check
reads (a tool, a skill bundle, a mount) on the check's own state.

**How it decides.** `archmax_advance({ to, reason })` is checked at the call: the
transition must exist and the state's `requires` must hold. There is no person to
tell, so its controls take no `message`. The first accepted advance or raise is the
decision, and a later one is refused. The decision takes effect when the state
finishes cleanly.

**How it settles.** Exactly one of:

| Outcome | When | Effect |
| --- | --- | --- |
| advanced | it advanced and finished cleanly | The session moves. The trail records `{ kind: code \| grader, to, reason }`, and the next state reads the reason as a `[code]` or `[grader]` runtime note. A human target parks after its handoff message. |
| raised | it called `archmax_raise` | The session ends `failed` with that code and reason. |
| completed | a terminal state finished without either call | The session completes, held to the trigger's `returns`. |
| failed | it threw, timed out, or (in a non-terminal state) finished without either call | Routed through `on_error`, else the session ends rejected. A raise beats an error; an error discards a recorded advance. |

**The history.** Both types read the session with `archmax_get_history`, which answers
`{ messages, trail }` as JSON: the session as it stood on entry, whole and oldest
first, across every turn.

| Field | Shape |
| --- | --- |
| `messages` | `{ role, text, toolCalls?, tool?, id?, note? }`. `role` is `user`, `assistant`, `tool`, `system` or `runtime` (a runtime note, its kind in `note`). An `assistant` entry lists its calls in `toolCalls` as `{ id?, name, args }`; the `tool` entry with the same `id` carries the result in `text`. |
| `trail` | `{ to, kind, reason?, workflow?, status?, ts }`, where `kind` is `trigger`, `agent`, `human`, `grader`, `code`, `sub-workflow`, `reset` or `on_error`. Count earlier rounds here. |

Check the records, not the agent's retelling of them: a tool's result as the history
carries it, a variable, a file. Never call a tool again just to see its result; for a
tool that acts on an outside system, that is a second action. The history spans every
turn, so take the last match where only the latest round counts. An automated state's
own calls are not in the transcript.

## Code states

A code state runs the file its `script` names. Wire it like the
[skeleton](workflow-schema.md#the-skeleton)'s `check-decision`: the `script`, every tool
the script calls in its own `tools.allow`, and an `on_error`. The script's default
export is called once. It moves the session itself, and the runtime ignores what it
returns. Adapted from
[`examples/refund/`](https://github.com/archmax-ai/harness/tree/main/examples/refund):

```js
/**
 * Refund decision check — the recorded decision must follow the refund policy.
 *
 * Looks the customer up with lookup_customer by the `email` variable. A refund is
 * due ("approved") only when the latest order is delivered, otherwise "denied".
 * Advances to review when `decision` matches; otherwise back to decide,
 * naming the decision the policy requires.
 */
export default async function ({ variables, tools }) {
  const customer = JSON.parse(await tools.lookup_customer({ email: variables.email }));
  const order = customer?.order;
  const due = order?.status === "delivered" ? "approved" : "denied";
  if (variables.decision === due) {
    await tools.archmax_advance({ to: "review", reason: `The refund is ${due}, as the policy requires.` });
  } else {
    await tools.archmax_advance({
      to: "decide",
      reason: `Order ${order?.id ?? "(none)"} is ${order?.status ?? "unknown"}, so the refund must be ${due}.`,
    });
  }
}
```

| Input | Meaning |
| --- | --- |
| `state` | The code state's slug. |
| `trigger` | The current trigger id. Its payload is in `variables`. |
| `variables` | The variables as a read-only `name → value` map, structured values whole. Write with `tools.archmax_set_variables`; the script's later calls see the write. |
| `tools` | The state's tools as async functions, by name (`tools.read_file`, `tools["archmax_workflow_enrich-order"]`) or camelCase (`tools.readFile`). A tool the state does not offer is `undefined`. A call with no argument passes `{}`. A refused call rejects with the reason, which a `try`/`catch` may handle. |

- **The return value is not read.** Only `archmax_advance` and `archmax_raise` decide,
  and every path through a non-terminal state's script must call one.
- **Send work back; throw on infrastructure.** A send-back's `reason` names the fix. A
  throw (an unreadable database) fails the state through `on_error`.
- **One evaluation in a fresh sandbox.** Each entry runs in a fresh QuickJS REPL, with
  top-level `await` and no Node APIs, bounded as a whole by `settings.timeoutMs`
  (default 15000), every tool and sub-workflow call it awaits included.
  `console.log` lines become `code-output` events, which the CLI prints under the
  state.
- **Imports** are limited to `@archmax-ai/harness/*` type carriers, which are stripped
  before evaluation. `import { defineCodeState } from "@archmax-ai/harness/sandbox"`
  types the input (`CodeStateInput`, `SessionHistory`). Any other import fails the
  state. Put imports after the JSDoc block, which must open the file.
- **No references.** `${{…}}` in a script's tool call is plain text: compose strings
  from `variables`.
- **Approve, then end.** A terminal code state completes the session when its script
  returns, with no further model call. Set any declared `returns` with
  `tools.archmax_set_variables` first.
- **Files.** `tools.read_file` returns the raw text of the first 100 lines unless you
  pass a larger `limit`, and answers a missing or binary file with an `Error: …` string
  instead of throwing, so check before you parse. There is no `fs`: copy, move
  and delete through `copy_file`, `move_file` and `remove_file`.

## Grader states

A grader state runs an isolated subagent. Its system prompt is a compiled-in preamble
followed by the state's `instructions`, which are its criteria, and its task lists the
state's transitions. It reads the session only through `archmax_get_history`, and the
work with its own state's tools. It decides with `archmax_advance`, or ends the session
with `archmax_raise`. The [skeleton](workflow-schema.md#the-skeleton)'s `review-email`
is a complete one, give-up rule and `on_error` included.

- Say in the criteria exactly when to take each transition and when to raise. A grader
  that answers in text without deciding fails through `on_error`.
- There is no iteration budget. To give up after N rounds, count the earlier send-backs
  on the trail (`{ kind: grader, to: <graded state> }`) and raise.
- `budget.timeoutMs` bounds its whole run, and a recursion limit of 400 bounds its
  loop, whatever the host sets for the turn. Its `model`, else `settings.model`, is
  resolved under the `grader` model role.
- Its messages never enter the session's transcript, and its tokens never stream. The
  session sees its decision as a trail step and a runtime note. Its model calls are
  `model-usage` events under its state.
- The history is not windowed, so name the part that counts: "the last assistant
  message", "the files `enrichments` names".

## `archmax_run` scripts

An `archmax_run` script, `skills/<slug>/scripts/<x>.js`, is deterministic work the agent
decides to run. It is a plain script with top-level `await`.

| It gets | |
| --- | --- |
| `args` | The arguments the model passed, plus `args.variables`, a read-only snapshot of the variables. |
| `tools` | The calling state's tools, as for a code state, re-scoped at every evaluation. No control tool and no `task`. |
| its result | The value of its last expression, returned to the model as the tool result. |

- **Land the result in a variable.** The result is one tool message, and a script
  cannot set variables. Return structured data and name the variable in the calling
  state's `requires`, so the agent records it with `archmax_set_variables`. Later
  states can then guard on it and quote it as `${{name}}`.
- **Announce it in the bundle's `SKILL.md`.** The `description` says when to run it; the
  body gives its path, its arguments and the variable its result belongs in. A script
  nothing points at is never run.
- **Grant it.** The calling state enables the bundle and allows every tool the script
  calls. Narrow execution with `{ tool: archmax_run, paths: ["skills/<slug>/scripts/**"] }`.
- **Fan out** over a delegation tool with `Promise.all`. Each call runs one child
  session and succeeds or fails on its own, so `Promise.allSettled` keeps the
  successes. When the host cancels the turn, a pending call fails and later calls are
  refused.
