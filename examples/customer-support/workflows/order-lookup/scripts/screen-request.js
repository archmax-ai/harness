/**
 * Request screen — the requester must be known, and may only reach their own
 * company's orders.
 *
 * The entry state of every conversation, run before any model call. Takes the
 * first user message from the session's history, extracts the first email address in it,
 * then reads skills/order-data/assets/orders.json — this state enables the
 * `order-data` skill, so the read is granted like any other — and binds the
 * address, case-insensitively, to the customers whose orders carry it.
 *
 * Declines (advances to `decline`, whose agent tells the person why) when the
 * request carries no email address, when the address matches no order, or when
 * the request names another customer or references one of another customer's
 * order ids (`ORD-…`). Otherwise advances to `identify-case`. An order database
 * that cannot be read is thrown: the state fails closed, and nothing is looked
 * up or disclosed.
 */
import { defineCodeState } from "@archmax-ai/harness/sandbox";

export default defineCodeState(async ({ tools }) => {
  const { messages } = JSON.parse(await tools.archmax_get_history());
  const orders = JSON.parse(await tools.read_file({ file_path: "skills/order-data/assets/orders.json" }));
  if (!Array.isArray(orders)) throw new Error("skills/order-data/assets/orders.json is not a list of orders");

  const request = messages.find((m) => m.role === "user")?.text ?? "";
  const email = (request.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/) ?? [])[0];
  if (!email) {
    return tools.archmax_advance({
      to: "decline",
      reason:
        "No email address found in the request. Ask them to include their email address so their account can be looked up.",
    });
  }

  const own = new Set(
    orders
      .filter((o) => typeof o.email === "string" && o.email.toLowerCase() === email.toLowerCase())
      .map((o) => String(o.customer)),
  );
  if (own.size === 0) {
    return tools.archmax_advance({
      to: "decline",
      reason: `The email address "${email}" is not in the order database. Ask them to check the address and try again.`,
    });
  }

  const lower = request.toLowerCase();
  const foreignByName = [...new Set(orders.map((o) => String(o.customer)))].filter(
    (name) => !own.has(name) && lower.includes(name.toLowerCase()),
  );
  const referenced = new Set((request.match(/\bORD-\d+\b/gi) ?? []).map((id) => id.toUpperCase()));
  const foreignById = orders
    .filter((o) => referenced.has(String(o.id).toUpperCase()) && !own.has(String(o.customer)))
    .map((o) => String(o.id));
  if (foreignByName.length > 0 || foreignById.length > 0) {
    console.log(`Declined: "${email}" (authorized for ${[...own].join(", ")}) reached for another customer.`);
    return tools.archmax_advance({
      to: "decline",
      reason:
        `The email address "${email}" is not authorized to access another customer's orders; they may ` +
        `only view orders for their own account. Do not name the other customer's orders.`,
    });
  }

  console.log(`Allowed: "${email}" is recognized (authorized for ${[...own].join(", ")}).`);
  return tools.archmax_advance({
    to: "identify-case",
    reason: `The requester ${email} is known and authorized for ${[...own].join(", ")}.`,
  });
});
