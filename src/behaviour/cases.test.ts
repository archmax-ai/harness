/**
 * Offline test cases through `@archmax-ai/harness/testing`: `runTests` discovers a
 * workflow's `tests/*.test.yaml`, drives each as one conversation, evaluates its
 * assertions, and serves declared tool mocks. Exercised against a temp workflow
 * with a scripted model and a caller-built target carrying a host tool.
 */
import { afterEach, describe, expect, it } from "vitest";
import { tool } from "langchain";
import { z } from "zod";
import type { StructuredTool } from "@langchain/core/tools";
import { contentToString, createAgent, createMemorySessionStore, type Agent, type WorkflowSurface } from "../index.js";
import {
  createToolMockMiddleware,
  parseCaseDocument,
  runTests,
  type AssertionRecord,
  type CaseResult,
} from "../public/testing.js";
import { AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseChatModelCallOptions } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { AGENTS_MD, cleanupWorkspaces, linearSpec, makeWorkspace, ScriptedModel, type ScriptedTurn } from "./support.js";

/** A grading model that scores every criterion 1 and keeps the prompts it was shown. */
class GraderModel extends BaseChatModel<BaseChatModelCallOptions> {
  readonly prompts: string[] = [];
  constructor() {
    super({});
  }
  _llmType(): string {
    return "archmax-behaviour-grader";
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.prompts.push(messages.map((m) => contentToString(m.content)).join("\n"));
    const text = '{"score": 1, "pass": true, "reason": "graded"}';
    return { generations: [{ text, message: new AIMessage({ content: text }) }] };
  }
}

afterEach(cleanupWorkspaces);

const failures = (records: AssertionRecord[]) =>
  records.filter((r) => r.status === "failed").map((r) => (r.detail ? `${r.kind}: ${r.detail}` : r.kind));

/** A host CRM tool that must never actually run in these cases. */
function crmLookup(): StructuredTool {
  return tool(
    async () => {
      throw new Error("the real CRM must not be called");
    },
    {
      name: "crm_lookup",
      description: "Look up a customer.",
      schema: z.object({ email: z.string() }),
    },
  ) as unknown as StructuredTool;
}

const WORKFLOW = linearSpec({
  states: {
    start: { triggers: { manual: null }, tools: { allow: ["crm_lookup"] }, transitions: [{ to: "done", description: "Test edge to done." }] },
    done: {},
  },
});

const CASE = `
title: Lookup then answer
description: The agent looks the customer up, moves on, and names the company in its reply.
mocks:
  - tool: crm_lookup
    whenInput: { email: "a@acme.test" }
    result: { company: "Acme", tier: "gold" }
steps:
  - send: "Who is a@acme.test?"
  - calledTool: { name: crm_lookup, input: { email: "a@acme.test" } }
  - calledTool: { name: archmax_advance, input: { to: done } }
  - reachedState: done
  - reply:
      includes: ["Acme"]
      excludes: ["Globex"]
  - trail: { to: done, count: 1 }
  - succeeded: true
`;

/** Run the cases under `root` with a scripted model, on a caller-built target. */
async function run(root: string, turns: ScriptedTurn[], filter?: string) {
  const model = new ScriptedModel(turns);
  const results: CaseResult[] = [];
  const outcome = await runTests({
    workflow: "w",
    rootDir: root,
    ...(filter ? { filter } : {}),
    onCaseResult: (r) => results.push(r),
    createTarget: async ({ workflow, rootDir, onEvent }) =>
      (await createAgent({
        workflow,
        model: model as unknown as BaseChatModel,
        tools: [crmLookup()],
        middleware: [createToolMockMiddleware()],
        onEvent,
        workspace: { rootDir, sessionStore: createMemorySessionStore() },
      })) as Agent & { workflow: WorkflowSurface },
  });
  return { ...outcome, reported: results, model };
}

describe("runTests", () => {
  it("passes a case whose actions and assertions all hold, serving the tool mock", async () => {
    const root = makeWorkspace({
      "AGENTS.md": AGENTS_MD,
      "workflows/w/workflow.yaml": WORKFLOW,
      "workflows/w/tests/lookup.test.yaml": CASE,
    });
    const { results, reported, model } = await run(root, [
      { tool: "crm_lookup", args: { email: "a@acme.test" } },
      { tool: "archmax_advance", args: { to: "done", reason: "looked up" } },
      { reply: "That is Acme, a gold-tier customer." },
    ]);

    expect(results).toHaveLength(1);
    expect(reported).toHaveLength(1);
    const [result] = results;
    expect(failures(result!.records)).toEqual([]);
    expect(result!.verdict.status).toBe("passed");
    expect(result!.records.map((r) => r.kind)).toEqual(
      expect.arrayContaining(["calledTool", "reachedState", "reply.includes", "reply.excludes", "trail", "succeeded"]),
    );
    // The mock stood in for the tool: the real one throws, and the run passed.
    expect(model.issued.map((c) => c.name)).toEqual(["crm_lookup", "archmax_advance"]);
  });

  it("fails the reply assertion when the reply does not include the expected token", async () => {
    const root = makeWorkspace({
      "AGENTS.md": AGENTS_MD,
      "workflows/w/workflow.yaml": WORKFLOW,
      "workflows/w/tests/lookup.test.yaml": CASE,
    });
    const { results } = await run(root, [
      { tool: "crm_lookup", args: { email: "a@acme.test" } },
      { tool: "archmax_advance", args: { to: "done", reason: "looked up" } },
      { reply: "That is Globex." },
    ]);
    const [result] = results;
    expect(result!.verdict.status).toBe("failed");
    expect(failures(result!.records).some((f) => f.startsWith("reply.includes"))).toBe(true);
    // The other assertions still hold and are reported individually.
    expect(result!.records.find((r) => r.kind === "reachedState")?.status).toBe("passed");
  });

  it("fails reachedState and calledTool when the agent never moved", async () => {
    const root = makeWorkspace({
      "AGENTS.md": AGENTS_MD,
      "workflows/w/workflow.yaml": WORKFLOW,
      "workflows/w/tests/lookup.test.yaml": CASE,
    });
    const { results } = await run(root, [{ reply: "Acme." }]);
    const failed = failures(results[0]!.records);
    expect(failed.some((f) => f.startsWith("reachedState"))).toBe(true);
    expect(failed.some((f) => f.startsWith("calledTool"))).toBe(true);
  });

  it("discovers only *.test.yaml files and honours the filter", async () => {
    const root = makeWorkspace({
      "AGENTS.md": AGENTS_MD,
      "workflows/w/workflow.yaml": WORKFLOW,
      "workflows/w/tests/lookup.test.yaml": CASE,
      "workflows/w/tests/other.test.yaml": CASE.replace("Lookup then answer", "Other"),
      "workflows/w/tests/ignored.test.js": "module.exports = {};",
      "workflows/w/tests/notes.md": "# not a case\n",
    });
    const { results } = await run(
      root,
      [
        { tool: "crm_lookup", args: { email: "a@acme.test" } },
        { tool: "archmax_advance", args: { to: "done", reason: "looked up" } },
        { reply: "Acme." },
      ],
      "other",
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("other");
    expect(results[0]!.title).toBe("Other");
  });

  it("shows the grader the runtime's notes — a human decision is evidence, not a hidden tool call", async () => {
    // A refund that a person approved at a human state: without the runtime note
    // in the evidence, a grader sees only the agent's messages and judges the
    // refund still pending review.
    const root = makeWorkspace({
      "AGENTS.md": AGENTS_MD,
      "workflows/w/workflow.yaml": linearSpec({
        tests: { judge: {} },
        states: {
          start: { triggers: { manual: null }, transitions: [{ to: "review", description: "Test edge to review." }] },
          review: { type: "human", transitions: [{ to: "approved", type: "approve", description: "Test edge to approved." }] },
          approved: {},
        },
      }),
      "workflows/w/tests/approve.test.yaml": [
        "title: Approve",
        "description: A person approves the refund and the agent closes it.",
        "steps:",
        "  - send: refund please",
        "  - reachedState: review",
        "  - decide: { to: approved, comment: looks right }",
        "  - reachedState: approved",
        "  - grade: { closedQA: The refund was approved by a person and the run continued., atLeast: 0.5 }",
      ].join("\n"),
    });
    const agentModel = new ScriptedModel([
      { tool: "archmax_advance", args: { to: "review", reason: "needs a person" } },
      { reply: "This is with a reviewer now." },
      { reply: "The refund is approved and closed." },
    ]);
    const grader = new GraderModel();
    const { results } = await runTests({
      workflow: "w",
      rootDir: root,
      modelFactory: (role) => (role === "judge" ? grader : agentModel) as unknown as BaseChatModel,
    });
    expect(results).toHaveLength(1);
    expect(failures(results[0]!.records)).toEqual([]);
    expect(grader.prompts).toHaveLength(1);
    const shown = grader.prompts[0]!;
    expect(shown).toMatch(/\[runtime:decision\] \[decision\] A human selected approve → 'approved'.*looks right/);
    expect(shown).not.toContain("archmax_note");
    expect(shown).toContain("Final reply to the user:\nThe refund is approved and closed.");
  });

  it("runs each case on its own session with the default target", async () => {
    // No caller-built target: `runTests` assembles one from the workspace with
    // the model factory, and the case's mocks still bind through it.
    const root = makeWorkspace({
      "AGENTS.md": AGENTS_MD,
      "workflows/w/workflow.yaml": linearSpec(),
      "workflows/w/tests/plain.test.yaml": [
        "title: Plain",
        "description: The agent advances and answers.",
        "steps:",
        "  - send: go",
        "  - reachedState: done",
        "  - reply: { includes: [answered] }",
      ].join("\n"),
    });
    const model = new ScriptedModel([
      { tool: "archmax_advance", args: { to: "done", reason: "go" } },
      { reply: "answered" },
    ]);
    const sessionIds: string[] = [];
    const { results } = await runTests({
      workflow: "w",
      rootDir: root,
      modelFactory: () => model as unknown as BaseChatModel,
      sessionIdForCase: (file) => {
        const id = `case-${file.replace(/\W/g, "-")}`;
        sessionIds.push(id);
        return id;
      },
    });
    expect(results[0]!.verdict.status).toBe("passed");
    expect(sessionIds).toHaveLength(1);
  });
});

describe("parseCaseDocument", () => {
  it("parses a well-formed case into actions and assertions", () => {
    const doc = parseCaseDocument("workflows/w/tests/lookup.test.yaml", CASE, "workflows/w/tests");
    expect(doc.title).toBe("Lookup then answer");
    expect(doc.mocks).toEqual([
      { name: "crm_lookup", whenInput: { email: "a@acme.test" }, result: { company: "Acme", tier: "gold" } },
    ]);
    expect(doc.steps.filter((s) => s.kind === "action")).toHaveLength(1);
    expect(doc.steps.filter((s) => s.kind !== "action").length).toBeGreaterThanOrEqual(5);
  });

  it("fails closed on an unknown key inside a case", () => {
    const bad = `${CASE}\nbogus: true\n`;
    expect(() => parseCaseDocument("workflows/w/tests/bad.test.yaml", bad, "workflows/w/tests")).toThrow(/bogus/);
  });
});
