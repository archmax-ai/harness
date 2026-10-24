import { tool } from "langchain";
import { z } from "zod";

const customers = {
  "ann@example.com": { name: "Ann Lee", order: { id: "ORD-1001", status: "delivered", total: 49.9 } },
  "bob@example.com": { name: "Bob Ruiz", order: { id: "ORD-1002", status: "shipped", total: 120 } },
};

/** Your system of record. Here, a table. */
export const lookupCustomer = tool(async ({ email }) => JSON.stringify(customers[email] ?? null), {
  name: "lookup_customer",
  description: "Look up a customer and their latest order by email address.",
  schema: z.object({ email: z.string() }),
});

/** Your mail system. Here, the console. */
export const sendEmail = tool(
  async ({ to, body }) => {
    console.log(`\n--- email to ${to} ---\n${body}\n`);
    return "sent";
  },
  {
    name: "send_email",
    description: "Send an email to the customer.",
    schema: z.object({ to: z.string(), body: z.string() }),
  },
);
