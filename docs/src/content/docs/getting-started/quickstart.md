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
archmax run order-lookup "Hi, I'm support@acmecorp.com. Which orders are delayed for Acme?"

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

● screen-request
    › code scripts/screen-request.js
    › archmax_get_history via script
    › read_file skills/order-data/assets/orders.json via script
      Allowed: "support@acmecorp.com" is recognized (authorized for Acme Corp).
    → The requester support@acmecorp.com is known and authorized for Acme Corp.
✔ screen-request → identify-case

● identify-case
    → The user is asking which of their orders are delayed.
✔ identify-case → orders-question

● orders-question
    › read_file skills/order-data/assets/orders.json
    │ Hi! For Acme Corp, one order is delayed: ORD-1003, placed on 2026-03-15 …
✔ orders-question → orders-question
```

The example implements a small router. `screen-request`, a code state, checks
the requester against the order records before any model call, and declines a
request from an unknown requester or one reaching for another company's orders.
`identify-case` then leads to one of four paths:

- `orders-question` for questions about orders
- `refund-request` for refunds, returns and cancellations
- `general-question` for everything else
- `clarify` for an order question that needs one identifying detail first

Order answers come from `skills/order-data/assets/orders.json`, and a live
answer ends where it is given: `orders-question` is terminal. Refund decisions
pass the `check-refund` code state, which re-derives the policy before a person
reviews them. A delayed-orders report, started by the `report_requested` trigger
with no person waiting on it, passes the `review-report` grader state, which
checks it against the order records and approves it into `report-delivered` or
sends it back with what to fix. `refund-request` also demonstrates a
`budget.maxTurns` limit and an `on_error` route to a terminal `escalation` state.
Each state's guidance lives inline in its `instructions`.

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
  message: "Hi, I'm support@acmecorp.com. Which orders are delayed for Acme?",
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
  states, transitions and tool governance, and the
  [grader and code states](/guides/automated-states/) the runtime runs itself.
- Validate your own scaffold without model calls:
  `archmax validate <workflow> --root ./my-workspace` (see the
  [CLI guide](/guides/cli/)).
- Write [cases](/guides/testing/) for your workflow and run them with `archmax test`.
