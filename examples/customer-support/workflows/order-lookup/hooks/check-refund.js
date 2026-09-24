/**
 * Refund policy gate — the agent may not record a refund the policy forbids.
 *
 * Re-derives the refund decision from the order database instead of trusting
 * the one the agent wrote. Reads the recorded ticket from scratchpad/refund.json
 * ({ orderId, decision }), then reads skills/order-data/assets/orders.json and
 * looks the order id up, case-insensitively, against each record's `id`.
 *
 * Policy: a refund is "approved" only when the order exists with status
 * delivered or delayed; an unknown order (or a null orderId) and any other
 * status must be "denied".
 *
 * Vetoes, each with a reason that names the fix, when: the ticket file is
 * missing or not valid JSON; `decision` is not exactly "approved" or "denied";
 * the order database cannot be read; or the recorded decision contradicts the
 * derived one. Otherwise ok, having logged the derived expectation against the
 * recorded decision.
 */
export default async function hook({ tools }) {
  let refund;
  try {
    refund = JSON.parse(await tools.readFile({ file_path: "scratchpad/refund.json" }));
  } catch (e) {
    return veto(
      `scratchpad/refund.json could not be read or parsed (${e && e.message ? e.message : String(e)}) - ` +
        `write it as a JSON object with "orderId" and "decision" before leaving this state`,
    );
  }

  const decision = refund && typeof refund === "object" ? refund.decision : undefined;
  if (decision !== "approved" && decision !== "denied") {
    return veto(
      `scratchpad/refund.json "decision" must be exactly "approved" or "denied"; got ${JSON.stringify(decision)}`,
    );
  }

  let orders;
  try {
    orders = JSON.parse(await tools.readFile({ file_path: "skills/order-data/assets/orders.json" }));
    if (!Array.isArray(orders)) throw new Error("not an array");
  } catch {
    return veto(
      "skills/order-data/assets/orders.json could not be read - the order database must be accessible to validate the refund decision",
    );
  }

  const wanted = typeof refund.orderId === "string" ? refund.orderId.trim().toLowerCase() : "";
  const order = orders.find((o) => o && typeof o.id === "string" && o.id.trim().toLowerCase() === wanted);
  const derived = order && ["delivered", "delayed"].includes(order.status) ? "approved" : "denied";
  const found = order ? `status "${order.status}"` : "not found in the order database";
  console.log(
    `Refund policy check - orderId ${JSON.stringify(refund.orderId)} (${found}); derived "${derived}", recorded "${decision}"`,
  );

  if (decision === derived) return ok();

  const why = !order
    ? "it does not exist in the order database"
    : derived === "approved"
      ? `its status is "${order.status}"`
      : `its status "${order.status}" is not delivered or delayed`;
  return veto(
    `Policy requires "${derived}" for order ${JSON.stringify(refund.orderId)} because ${why}, ` +
      `but the recorded decision is "${decision}" - update scratchpad/refund.json to decision: "${derived}"`,
  );
}
