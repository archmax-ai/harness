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
