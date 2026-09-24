---
name: refund-policy
description: >-
  When a refund may be approved, and the gate that re-derives the decision from
  the order records.
---

# Refund policy

A refund is **approved** only when the order exists and its status is
`delivered` or `delayed`.

It is **denied** when the status is `shipped` or `processing` — the order has not
arrived yet, so the customer should cancel or wait — and when no matching order
exists at all.

Explain the decision with the order id, the order's exact status, and one
sentence a customer can understand.

## The gate

The refund state's `after` hook re-checks this policy before the run may leave
it. The hook reads the recorded decision back from `scratchpad/refund.json`,
re-derives the policy from `skills/order-data/assets/orders.json`, and vetoes the
transition when the two disagree. The recorded decision has to match the policy,
not merely sound like it.

The hook's own source is not in this bundle and is not readable from a run: it
lives on the authoring plane, in `workflows/order-lookup/hooks/`, and the harness
runs it. What ships in a skill bundle is the other kind of script — the ones the
agent itself runs with `archmax_run`.
