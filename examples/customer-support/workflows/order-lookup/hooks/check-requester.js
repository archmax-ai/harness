/**
 * Requester gate — the request must name a requester the order records know.
 *
 * Deterministic precondition for the whole run. Takes the first user message
 * from `messages`, extracts the first email address in it, then reads
 * skills/order-data/assets/orders.json through the tool bridge and looks the
 * address up, case-insensitively, against every order's `email` field.
 *
 * Vetoes when the order database cannot be loaded or parsed, when the request
 * carries no email address, or when the address matches no order. Otherwise
 * ok, logging the customers the requester is bound to. Whether the request
 * stays inside those customers is the next hook in the list, check-tenancy.js.
 */
export default async function hook({ messages, tools }) {
  let orders;
  try {
    orders = JSON.parse(await tools.readFile({ file_path: "skills/order-data/assets/orders.json" }));
  } catch {
    return veto(
      "Could not load or parse skills/order-data/assets/orders.json - unable to verify the requester.",
    );
  }

  const request = messages.find((m) => m.role === "user")?.text ?? "";
  const email = (request.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/) ?? [])[0];
  if (!email) {
    return veto(
      "No email address found in your request. Please include your email address so we can look up your account.",
    );
  }

  const customers = [
    ...new Set(
      (Array.isArray(orders) ? orders : [])
        .filter((o) => typeof o.email === "string" && o.email.toLowerCase() === email.toLowerCase())
        .map((o) => String(o.customer)),
    ),
  ];
  if (customers.length === 0) {
    return veto(
      `The email address "${email}" is not in the order database. Please check the address and try again.`,
    );
  }

  console.log(`Allowed: "${email}" is recognized (authorized for ${customers.join(", ")}).`);
  return ok();
}
