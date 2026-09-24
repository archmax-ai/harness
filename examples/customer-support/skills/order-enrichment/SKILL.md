---
name: order-enrichment
description: >-
  How several orders get enriched at once: one sub-run each, dispatched by a
  script rather than by the model.
---

# Order enrichment

Enrichment is delegated: the `enrich-order` workflow enriches exactly one order
per run, and a caller fans out by calling it once per order.

The fan-out is a script, not a graph node. `scripts/enrich-orders.js` —
`skills/order-enrichment/scripts/enrich-orders.js` from the workspace root —
reads the `orders_to_enrich` run variable, calls
`archmax_workflow_enrich-order` once per entry, awaits them together, and returns
one `{ order_id, enrichment_file, delayed }` object per order.

Run it with `archmax_run` and record what it returns as the `enrichments`
variable. Do not enrich anything by hand, and do not call the enrichment
workflow yourself — the script decides how many calls to make, so the list never
has to enter the model's context.
