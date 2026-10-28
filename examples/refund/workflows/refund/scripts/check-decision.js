/**
 * Refund decision check — the recorded decision must follow the refund policy.
 *
 * Looks the customer up with lookup_customer by the `email` variable. A refund is
 * due ("approved") only when their order is delivered, otherwise "denied".
 * Advances to review-email when `decision` matches; otherwise back to decide,
 * naming the order, its status and the decision the policy requires.
 */
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
