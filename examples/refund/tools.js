import { tool } from "langchain";
import { z } from "zod";

const customers = {
  "ann@example.com": { name: "Ann", order: { id: "ORD-1001", status: "delivered" } },
  "bob@example.com": { name: "Bob", order: { id: "ORD-1002", status: "shipped" } },
};

export const lookupCustomer = tool(async ({ email }) => JSON.stringify(customers[email] ?? null), {
  name: "lookup_customer",
  description: "Look up a customer and their latest order by email address.",
  schema: z.object({ email: z.string() }),
});

export const sendEmail = tool(
  async ({ to, body }) => {
    console.log(`To ${to}:\n${body}`);
    return "sent";
  },
  {
    name: "send_email",
    description: "Send an email to the customer.",
    schema: z.object({ to: z.string(), body: z.string() }),
  },
);
