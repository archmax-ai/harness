---
title: Quickstart
description: Build a four-state refund workflow with a code-state check and a grader, and run it from your own code.
sidebar:
  order: 2
---

This page builds a refund desk in four states and runs it from a short Node program. The agent
decides the refund and drafts the email to the customer. A script checks the decision against the
refund policy, a grader checks the email, and the agent sends it.

The complete example is in
[`examples/refund/`](https://github.com/archmax-ai/harness/tree/main/examples/refund):

```text
refund/
├── index.js                          # your program: creates the agent and starts a session
├── tools.js                          # the host tools: your systems
└── workflows/refund/
    ├── workflow.yaml                 # the process, enforced
    └── scripts/check-decision.js     # the policy check
```

## Install

```bash
npm install @archmax-ai/harness langchain zod
```

`langchain` and `zod` are for the two host tools. Put the model's endpoint in a `.env` next to
`index.js`, which is the workspace root here:

```bash
ARCHMAX_API_BASE_URL=https://api.example.com/v1
ARCHMAX_API_KEY=...
ARCHMAX_MODEL=...
```

[Installation](/getting-started/installation/) covers Node, the CLI and every model setting.

## The workflow

```yaml
# workflows/refund/workflow.yaml
title: Refund request
instructions: Decide only from what lookup_customer returns; never guess an order.

states:
  decide:
    triggers:
      manual:
        requires: [email]
    tools:
      allow: [lookup_customer]
    instructions: >-
      Look the customer up with lookup_customer, using the `email` variable. A
      refund is approved only when their order is delivered; otherwise it is
      denied. Record the decision with archmax_set_variables as `decision`
      (approved or denied), write the email to the customer in
      scratchpad/email.md, then advance to check-decision. If you are sent
      back, fix what the note says and advance again.
    transitions:
      - to: check-decision
        description: The decision is recorded and the email is drafted.

  check-decision:
    type: code
    script: scripts/check-decision.js
    tools:
      allow: [lookup_customer]
    transitions:
      - to: review-email
        description: The decision matches the refund policy.
      - to: decide
        description: The decision contradicts the refund policy.

  review-email:
    type: grader
    instructions: >-
      Read scratchpad/email.md and the `decision` variable. Approve the email
      when it is polite, states the decision plainly and names the order.
      Otherwise send it back, saying exactly what to change.
    transitions:
      - to: send
        description: The email is ready to send.
      - to: decide
        description: The email needs changes.

  send:
    tools:
      allow: [send_email]
    instructions: >-
      Send scratchpad/email.md to the customer at `email` with send_email, then
      say in one sentence that it was sent.
```

Each state is one step of the process. The agent sees only the step it is in: that state's
instructions, its tools and the transitions out of it. It moves on by calling `archmax_advance`,
and the runtime refuses any edge the state does not declare. Every transition carries a
`description`, because that sentence is all the agent learns about the edge.

A few lines carry most of the governance:

- **`requires: [email]`** on the `manual` trigger. A session that starts without an `email`
  variable is refused before any model call.
- **`tools.allow`** grants each host tool where it belongs. `decide` and `check-decision` may look
  a customer up. Only `send` may send an email, so no email leaves before the check and the grader
  have passed it.
- **No transitions on `send`.** A state with none is terminal: the session ends when the agent
  finishes there.

The file tools that write `scratchpad/email.md` and read it back need no grant. A workflow that
declares no `tools.allow_always` has the [default tools](/guides/workflow-machine/#tool-governance)
in every state.

## The check

`check-decision` is a **code state**. When the session enters it, the runtime runs its script,
with no model call:

```js
// workflows/refund/scripts/check-decision.js
/** A refund is due only for a delivered order: any other decision goes back to the agent. */
export default async function ({ variables, tools }) {
  const customer = JSON.parse(await tools.lookup_customer({ email: variables.email }));
  const order = customer?.order;
  const due = order?.status === "delivered" ? "approved" : "denied";

  if (variables.decision === due) {
    await tools.archmax_advance({
      to: "review-email",
      reason: `The refund is ${due}, as the policy requires.`,
    });
  } else {
    await tools.archmax_advance({
      to: "decide",
      reason: `Order ${order?.id ?? "(none)"} is ${order?.status ?? "unknown"}, so the refund must be ${due}.`,
    });
  }
}
```

The script looks the customer up itself rather than trusting what the agent reported, and it moves
the session the way the agent does, with `archmax_advance`. Its `tools` hold exactly its own
state's surface, so it can call `lookup_customer` only because `check-decision` grants it.

The policy lives in code, so it holds whatever the model says.

## The grader

`review-email` is a **grader state**. The runtime runs an isolated subagent whose criteria are the
state's `instructions`. It reads `scratchpad/email.md` and the `decision` variable with its own
state's tools, then approves the email onward to `send` or sends it back to `decide` with what to
change.

The agent never sees those criteria, or the grader's edges. Standing in `decide`, it sees one line
for the edge into `check-decision`, marked `(code)`, with its description.

## The host tools

`lookup_customer` and `send_email` are your systems, passed to the agent as ordinary LangChain
tools:

```js
// tools.js
import { tool } from "langchain";
import { z } from "zod";

const customers = {
  "ann@example.com": { name: "Ann", order: { id: "ORD-1001", status: "delivered" } },
  "bob@example.com": { name: "Bob", order: { id: "ORD-1002", status: "shipped" } },
};

export const lookupCustomer = tool(async ({ email }) => JSON.stringify(customers[email] ?? null), {
  name: "lookup_customer",
  description: "Look up a customer and their latest order by email address.",
  schema: z.object({ email: z.string() }),
});

export const sendEmail = tool(
  async ({ to, body }) => {
    console.log(`To ${to}:\n${body}`);
    return "sent";
  },
  {
    name: "send_email",
    description: "Send an email to the customer.",
    schema: z.object({ to: z.string(), body: z.string() }),
  },
);
```

Passing a tool to `createAgent` does not grant it. A state reaches a host tool only where a grant
names it, here each state's `tools.allow`.

## Run it

```js
// index.js
import { createAgent } from "@archmax-ai/harness";
import { lookupCustomer, sendEmail } from "./tools.js";

const agent = await createAgent({
  workflow: "refund",
  tools: [lookupCustomer, sendEmail],
  workspace: { rootDir: import.meta.dirname },
});

const outcome = await agent.workflow.send("ticket-1001", {
  message: "Hi, I'd like a refund for my last order.",
  variables: { email: "ann@example.com" },
});

console.log(outcome.kind); // "completed"
console.log(outcome.auditTrail.map((step) => `${step.kind} → ${step.to}`).join("\n"));
```

```bash
node index.js
```

`createAgent` loads `workflows/refund/workflow.yaml` from the workspace root and fails closed: a
missing or invalid spec throws a `WorkflowLoadError`, so every agent you get back is governed.

`agent.workflow.send` runs one turn of the session `ticket-1001`. The `variables` are the
session's input, here the `email` the trigger requires.

## What the trail shows

```text
completed
trigger → decide
agent → check-decision
code → review-email
grader → send
```

The **trail** records every move and who made it:

| Step | What happened |
| --- | --- |
| `trigger → decide` | The `manual` trigger opened the session in its entry state. |
| `agent → check-decision` | The agent recorded `approved`, drafted the email and advanced. |
| `code → review-email` | The script confirmed that order `ORD-1001` is delivered. |
| `grader → send` | The grader approved the email, and the agent sent it. |

`outcome.kind` says how the turn ended:

- `completed`: the session finished its work.
- `parked`: it waits on a person or an event.
- `failed`: the agent, a grader or a code state called `archmax_raise` because the work cannot be
  done.
- `rejected`: governance or the runtime stopped it, such as a start without `email`.

`outcome.reply` holds what the agent wrote during the turn.

Sessions are durable. They live under `sessions/` in the workspace root, so a second `send` with
the same id continues the same conversation. See [sessions](/guides/sessions/).

## When the decision is wrong

Bob's order has only shipped, so the policy denies his refund. Run the session with
`bob@example.com`, and suppose the agent approves it anyway. `check-decision` sends the session
back to `decide`, and the trail shows the round trip:

```text
trigger → decide
agent → check-decision
code → decide
agent → check-decision
code → review-email
grader → send
```

The `code → decide` step carries the script's reason:

```text
Order ORD-1002 is shipped, so the refund must be denied.
```

The agent reads that reason as a runtime note when it is back in `decide`. It records `denied`,
rewrites the email and advances again. The grader only ever reads the corrected email.

A grader send-back works the same way: the agent reads the grader's reason and fixes the email.
Neither loop has a round limit of its own; the turn's recursion limit is the backstop. To give up
after a few rounds, see [counting rounds](/guides/automated-states/#counting-rounds).

## Validate it

`archmax validate` checks a workflow with no model calls. It runs the same kernel the session runs
under, so a state that grants a tool it also forbids fails here, before a session does. From the
example's directory:

```bash
npx archmax validate refund
```

## The CLI and the reference workspace

The refund workflow runs from your code, because its two tools exist only in your program. A
workflow that needs only the harness's own tools runs from the CLI as well. The reference
workspace,
[`examples/customer-support/`](https://github.com/archmax-ai/harness/tree/main/examples/customer-support),
is one. It has a router, a human review, code states, a grader and a suite of cases:

```bash
npx archmax run order-lookup "Which orders are delayed for Acme?" --root examples/customer-support
npx archmax test order-lookup --root examples/customer-support
```

See [using the CLI](/guides/cli/).

## Where to go next

- [The workflow machine](/guides/workflow-machine/): states, transitions and tool governance.
- [Grader and code states](/guides/automated-states/): the checks the runtime runs itself.
- [Human states](/guides/workflow-machine/#human-in-the-loop-states): a person picks the edge.
- [Triggers](/guides/triggers/): typed inputs and returns, and files.
- [Testing workflows](/guides/testing/): cases for `archmax test`.
- [Public API](/reference/public-api/): `createAgent`, outcomes and events.
