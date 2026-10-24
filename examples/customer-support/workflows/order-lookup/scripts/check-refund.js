/**
 * Refund policy check — the agent may not hand a refund the policy forbids to
 * the reviewer.
 *
 * Re-derives the refund decision from the order database instead of trusting
 * the one the agent wrote. Reads the recorded ticket from scratchpad/refund.json
 * ({ orderId, decision }), then reads skills/order-data/assets/orders.json —
 * this state enables the `order-data` skill — and looks the order id up,
 * case-insensitively, against each record's `id`.
 *
 * Policy: a refund is "approved" only when the order exists with status
 * delivered or delayed; an unknown order (or a null orderId) and any other
 * status must be "denied".
 *
 * Advances to `refund-review` when the recorded decision matches the derived
 * one. Otherwise sends the session back to `refund-request` with a reason that
 * names the fix — the ticket missing or unparseable, `decision` not exactly
 * "approved" or "denied", or the decision contradicting the policy — and, once
 * it has sent it back twice (counted on the trail), escalates instead. An order
 * database that cannot be read is thrown: the state fails and routes to its
 * `on_error`.
 */
import { defineCodeState } from "@archmax-ai/harness/sandbox";

/** How many times this check may send a decision back before it escalates. */
const MAX_SEND_BACKS = 2;

export default defineCodeState(async ({ trail, tools }) => {
  const sentBack = trail.filter((step) => step.kind === "code" && step.to === "refund-request").length;
  const sendBack = (reason) =>
    sentBack >= MAX_SEND_BACKS
      ? tools.archmax_advance({
          to: "escalation",
          reason: `The refund decision still fails the policy check after ${sentBack} corrections: ${reason}`,
        })
      : tools.archmax_advance({ to: "refund-request", reason });

  let refund;
  try {
    refund = JSON.parse(await tools.read_file({ file_path: "scratchpad/refund.json" }));
  } catch (e) {
    return sendBack(
      `scratchpad/refund.json could not be read or parsed (${e && e.message ? e.message : String(e)}) - ` +
        `write it as a JSON object with "orderId" and "decision", then advance again`,
    );
  }

  const decision = refund && typeof refund === "object" ? refund.decision : undefined;
  if (decision !== "approved" && decision !== "denied") {
    return sendBack(
      `scratchpad/refund.json "decision" must be exactly "approved" or "denied"; got ${JSON.stringify(decision)}`,
    );
  }

  const orders = JSON.parse(await tools.read_file({ file_path: "skills/order-data/assets/orders.json" }));
  if (!Array.isArray(orders)) throw new Error("skills/order-data/assets/orders.json is not a list of orders");

  const wanted = typeof refund.orderId === "string" ? refund.orderId.trim().toLowerCase() : "";
  const order = orders.find((o) => o && typeof o.id === "string" && o.id.trim().toLowerCase() === wanted);
  const derived = order && ["delivered", "delayed"].includes(order.status) ? "approved" : "denied";
  const found = order ? `status "${order.status}"` : "not found in the order database";
  console.log(
    `Refund policy check - orderId ${JSON.stringify(refund.orderId)} (${found}); derived "${derived}", recorded "${decision}"`,
  );

  if (decision === derived) {
    return tools.archmax_advance({
      to: "refund-review",
      reason: `The recorded decision "${decision}" for order ${JSON.stringify(refund.orderId)} (${found}) matches the refund policy.`,
    });
  }

  const why = !order
    ? "it does not exist in the order database"
    : derived === "approved"
      ? `its status is "${order.status}"`
      : `its status "${order.status}" is not delivered or delayed`;
  return sendBack(
    `Policy requires "${derived}" for order ${JSON.stringify(refund.orderId)} because ${why}, ` +
      `but the recorded decision is "${decision}" - update scratchpad/refund.json to decision: "${derived}", ` +
      `correct what you told the customer, and advance again`,
  );
});
