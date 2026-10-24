import { createAgent } from "@archmax-ai/harness";
import { lookupCustomer, sendEmail } from "./tools.js";

const agent = await createAgent({
  workflow: "refund",
  tools: [lookupCustomer, sendEmail],
  workspace: { rootDir: import.meta.dirname },
});

const outcome = await agent.workflow.send("ticket-1001", {
  message: "Hi, I'd like a refund for my last order.",
  variables: { email: "ann@example.com" },
});

console.log(outcome.kind); // "completed"
console.log(outcome.auditTrail.map((step) => `${step.kind} → ${step.to}`).join("\n"));
