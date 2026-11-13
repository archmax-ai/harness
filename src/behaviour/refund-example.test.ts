/**
 * The README's example, run as written: `examples/refund`'s workflow, its
 * code-state script and its host tools, with a scripted model standing in for
 * the agent and the grader. When this fails, the README or the docs quickstart
 * is wrong.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { StructuredTool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { isRuntimeNote, runtimeNoteKind } from "../index.js";
import {
  advanceTo,
  assemble,
  freshSessionId,
  ScriptedModel,
  type ScriptedTurn,
} from "./support.js";

const ROOT = resolve(import.meta.dirname, "../../examples/refund");

/** The example's own `lookup_customer` and `send_email`. */
async function hostTools(): Promise<StructuredTool[]> {
  const tools = (await import(pathToFileURL(join(ROOT, "tools.js")).href)) as Record<
    string,
    StructuredTool
  >;
  return [tools.lookupCustomer!, tools.sendEmail!];
}

/** The agent's turns in `decide`: look the customer up, record the decision, draft the email, advance. */
function decide(email: string, decision: string, body: string): ScriptedTurn[] {
  return [
    { tool: "lookup_customer", args: { email } },
    { tool: "archmax_set_variables", args: { variables: { decision } } },
    { tool: "write_file", args: { file_path: "scratchpad/email.md", content: body } },
    advanceTo("check-decision", `the refund is ${decision} and the email is drafted`),
  ];
}

async function run(email: string, agentTurns: ScriptedTurn[]) {
  const agentModel = new ScriptedModel(agentTurns);
  const grader = new ScriptedModel([
    advanceTo("send", "polite, states the decision, names the order"),
  ]);
  const { agent } = await assemble(ROOT, {
    workflow: "refund",
    model: agentModel,
    graderModel: grader,
    params: { tools: await hostTools() },
  });
  const outcome = await agent.workflow.send(freshSessionId(), {
    message: "Hi, I'd like a refund for my last order.",
    variables: { email },
  });
  return { outcome, grader };
}

describe("the README's refund example", () => {
  it("approves a delivered order's refund: decide, check, grade, send", async () => {
    const body = "Hi Ann, your refund for order ORD-1001 is approved.";
    const { outcome } = await run("ann@example.com", [
      ...decide("ann@example.com", "approved", body),
      { tool: "send_email", args: { to: "ann@example.com", body } },
      { reply: "The email was sent." },
    ]);

    expect(outcome.kind).toBe("completed");
    expect(outcome.auditTrail.map((step) => `${step.kind}:${step.to}`)).toEqual([
      "trigger:decide",
      "agent:check-decision",
      "code:review-email",
      "grader:send",
    ]);
  });

  it("sends a decision the policy contradicts back before anyone grades it", async () => {
    // Bob's order has only shipped: the check refuses an approval.
    const body = "Hi Bob, your refund for order ORD-1002 is denied: it has not been delivered yet.";
    const { outcome, grader } = await run("bob@example.com", [
      ...decide("bob@example.com", "approved", "Hi Bob, your refund is approved."),
      ...decide("bob@example.com", "denied", body),
      { tool: "send_email", args: { to: "bob@example.com", body } },
      { reply: "The email was sent." },
    ]);

    expect(outcome.kind).toBe("completed");
    expect(outcome.auditTrail.map((step) => `${step.kind}:${step.to}`)).toEqual([
      "trigger:decide",
      "agent:check-decision",
      "code:decide",
      "agent:check-decision",
      "code:review-email",
      "grader:send",
    ]);
    expect(outcome.auditTrail[2]?.reason).toBe(
      "Order ORD-1002 is shipped, so the refund must be denied.",
    );
    // The agent reads the reason as the check wrote it, one sentence and one full stop.
    const notes = outcome.messages
      .filter((m) => isRuntimeNote(m) && runtimeNoteKind(m) === "code")
      .map((m) => String((m as { content?: unknown }).content));
    expect(notes).toContain(
      "[code] 'check-decision' moved the run to 'decide': Order ORD-1002 is shipped, so the refund must be denied. " +
        "You are now in 'decide'.",
    );
    // Only the corrected email reached the grader.
    expect(grader.calls).toHaveLength(1);
  });

  it.each(["README.md", "docs/src/content/docs/getting-started/quickstart.md"])(
    "is exactly the code %s shows",
    (page) => {
      const shown = readFileSync(resolve(ROOT, "../..", page), "utf8");
      for (const [label, path] of [
        ["yaml\n# workflows/refund/workflow.yaml", "workflows/refund/workflow.yaml"],
        [
          "js\n// workflows/refund/scripts/check-decision.js",
          "workflows/refund/scripts/check-decision.js",
        ],
        ["js\n// tools.js", "tools.js"],
        ["js\n// index.js", "index.js"],
      ] as const) {
        const start = shown.indexOf("```" + label + "\n");
        expect(start, `${page} shows ${path}`).toBeGreaterThanOrEqual(0);
        const body = shown.slice(
          start + label.length + 4,
          shown.indexOf("\n```", start + label.length + 4) + 1,
        );
        expect(body, path).toBe(readFileSync(join(ROOT, path), "utf8"));
      }
    },
  );
});
