---
title: Quickstart
description: Run the bundled customer-support workflow from the CLI and from code.
sidebar:
  order: 2
---

The archmax harness bundles a complete reference workspace, `examples/customer-support/`.
Watch a governed workflow run there before authoring your own.

## Run from the CLI

```bash
# Run a named workflow with a custom prompt
archmax run order-lookup "Which orders are delayed for Acme?"

# Point at any workspace root with --root (default: current directory)
archmax run order-lookup "..." --root ./my-workspace

# In a workspace with exactly one workflow, the slug may be omitted
archmax run "Which orders are delayed for Acme?" --root ./my-workspace
```

`run` prints a session header and a live, colorized state flow to `stderr`.
The final answer goes to `stdout`. So `archmax run ... > answer.txt` captures
just the answer:

```text
◆ order-lookup
  directory  examples/customer-support
  model      anthropic/claude-sonnet-4.6

● identify-case
    › before workflows/order-lookup/hooks/check-requester.js
    ✔ before ok
    │ This is an order status question, so I'll route to `orders-question`.
✔ identify-case → orders-question

● orders-question
    › after rubric
    ✔ after ok — the reply is warm, well-organized, and helpful
    │ Here is a summary of all orders for Acme Corp:
    │ ...
✔ orders-question → done
```

The example implements a small router. `identify-case` leads to one of four paths:

- `orders-question` for questions about orders
- `refund-request` for refunds, returns and cancellations
- `general-question` for everything else
- `clarify` for an order question that needs one identifying detail first

Order answers come from `skills/order-data/assets/orders.json`, and an `after`
script re-checks refund decisions and can veto the transition. `refund-request`
also demonstrates a `budget.maxTurns` limit and an `on_error` route to a terminal
`escalation` state. Each state's guidance lives inline in its `instructions`.

## Use as a library

```ts
import { createAgent } from "@archmax-ai/harness";

// Defaults: env-configured model + FilesystemBackend over the current directory.
// Point rootDir at your own workspace, or at a checkout of examples/customer-support.
const agent = await createAgent({
  workflow: "order-lookup",
  workspace: { rootDir: "./examples/customer-support" },
});

// One call for every way into a session — a turn, a decision, a reply, a delivery.
const outcome = await agent.workflow!.send("session-1", {
  message: "Which orders are delayed for Acme?",
});
console.log(outcome.kind, outcome.state, outcome.reply);
agent.dispose("session-1");
```

`agent.invoke` and `agent.stream` work too, exactly as on a Deep Agent. The
session id goes in as `configurable.thread_id`.

`createAgent` **fails closed**. A missing or invalid `workflow.yaml` throws a
`WorkflowLoadError` during assembly, so every agent you get back is governed.

## Where to go next

- Understand the [workflow machine](/guides/workflow-machine/):
  states, transitions, tool governance, and lifecycle hooks.
- Validate your own scaffold without model calls:
  `archmax validate <workflow> --root ./my-workspace` (see the
  [CLI guide](/guides/cli/)).
- Write [cases](/guides/testing/) for your workflow and run them with `archmax test`.
