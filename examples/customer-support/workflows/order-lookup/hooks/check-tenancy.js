/**
 * Tenancy gate — a requester may only reach their own company's orders.
 *
 * The data-leak guard: a valid Acme requester must not be able to pull Globex's
 * orders. Binds the requester's email (the first one in the first user message)
 * to the customers whose orders carry it in skills/order-data/assets/orders.json,
 * then checks the request against every other customer two ways: the request
 * names another customer by name, or it references an order id (`ORD-…`) owned
 * by another customer. Matching is case-insensitive; the name match is an
 * illustrative substring match on free text.
 *
 * Vetoes with the customers or order ids the requester reached for when either
 * check finds one; otherwise ok. Runs after check-requester.js in the same hook
 * list, so a missing or unknown email never gets this far — and if the order
 * database cannot be read, this hook vetoes too (fail-closed).
 */
export default async function hook({ messages, tools }) {
  let orders;
  try {
    orders = JSON.parse(await tools.readFile({ file_path: "skills/order-data/assets/orders.json" }));
    if (!Array.isArray(orders)) throw new Error("not an array");
  } catch {
    return veto("Could not load skills/order-data/assets/orders.json - unable to check tenancy.");
  }

  const request = messages.find((m) => m.role === "user")?.text ?? "";
  const email = ((request.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/) ?? [])[0] ?? "").toLowerCase();
  const own = new Set(
    orders
      .filter((o) => typeof o.email === "string" && o.email.toLowerCase() === email)
      .map((o) => String(o.customer)),
  );

  const lower = request.toLowerCase();
  const foreignByName = [...new Set(orders.map((o) => String(o.customer)))].filter(
    (name) => !own.has(name) && lower.includes(name.toLowerCase()),
  );
  const referenced = new Set((request.match(/\bORD-\d+\b/gi) ?? []).map((id) => id.toUpperCase()));
  const foreignById = orders
    .filter((o) => referenced.has(String(o.id).toUpperCase()) && !own.has(String(o.customer)))
    .map((o) => String(o.id));

  if (foreignByName.length > 0 || foreignById.length > 0) {
    const detail = (foreignByName.length > 0 ? foreignByName : foreignById).join(", ");
    console.log(`Vetoed: "${email}" (authorized for ${[...own].join(", ")}) reached for ${detail}.`);
    return veto(
      `The email address "${email}" is not authorized to access orders for ${detail}. You may only view orders for your own account.`,
    );
  }

  return ok();
}
