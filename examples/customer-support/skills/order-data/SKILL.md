---
name: order-data
description: >-
  The order records every answer comes from, and the tenancy rule binding a
  requester to the orders they may see.
---

# Order data

Every order this workspace knows about lives in `assets/orders.json`, relative to
this skill — that is `skills/order-data/assets/orders.json` from the workspace
root. It is a JSON array; each record carries `id`, `customer`, `email`,
`status`, `placed`, and `total`.

`status` is one of `processing`, `shipped`, `delivered`, or `delayed`. Quote it
exactly. A `shipped` order has left the warehouse and has **not** been delivered;
do not soften that into "in transit" or imply it arrived.
