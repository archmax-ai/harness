import { describe, expect, it } from "vitest";
import type { SessionView } from "../workflow/session-view.js";
import type { TrailStep } from "../workflow/state.js";
import { evaluateExpectations, haltsCaseOnFailure, notExecutedRecord } from "./assertions.js";
import { parseCaseDocument, type CaseExpectation } from "./case-schema.js";

const FILE = "workflows/w/tests/case.test.yaml";

/** Parse assertion steps through the real schema so grammar and evaluation stay in lockstep. */
function expectations(yaml: string): CaseExpectation[] {
  const doc = parseCaseDocument(
    FILE,
    `title: t\ndescription: x\nsteps:\n  - send: probe\n${yaml}`,
    "workflows/w/tests",
  );
  return doc.steps.flatMap((s) => (s.kind === "assert" ? [s.expect] : []));
}

function view(overrides: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: "default",
    reply: "",
    failed: false,
    parked: false,
    events: [],
    toolCalls: [],
    auditTrail: [],
    variables: {},
    ...overrides,
  };
}

function trailStep(to: string, kind: TrailStep["kind"], reason?: string): TrailStep {
  return { to, kind, ...(reason !== undefined ? { reason } : {}), ts: 0 };
}

/**
 * The helper's document opens with `send` at `steps[0]`, so the assertions it
 * parses live at `steps[1]` onward — 1 is the step every record here is
 * attributed to.
 */
const STEP = 1;

async function evaluate(yaml: string, v: SessionView) {
  return evaluateExpectations(expectations(yaml), v, STEP);
}

describe("evaluateExpectations status assertions", () => {
  it("succeeded passes only when neither failed nor parked", async () => {
    expect((await evaluate("  - succeeded: true", view()))[0]?.status).toBe("passed");
    expect((await evaluate("  - succeeded: true", view({ parked: true })))[0]?.status).toBe(
      "failed",
    );
    expect((await evaluate("  - succeeded: true", view({ failed: true })))[0]?.status).toBe(
      "failed",
    );
  });

  it("parked pins the channel and the state when asked to", async () => {
    const parked = view({ parked: true, parkedChannel: "input", state: "clarify" });
    expect(
      (await evaluate("  - parked: { channel: input, state: clarify }", parked))[0]?.status,
    ).toBe("passed");
    // The state matters: a park elsewhere is a different flow.
    expect((await evaluate("  - parked: { state: answer }", parked))[0]?.status).toBe("failed");
    expect((await evaluate("  - parked: decision", parked))[0]?.status).toBe("failed");
  });

  it("parked mirrors the view flag", async () => {
    expect((await evaluate("  - parked: true", view({ parked: true })))[0]?.status).toBe("passed");
    expect((await evaluate("  - parked: true", view()))[0]?.status).toBe("failed");
  });
});

describe("evaluateExpectations reply assertions", () => {
  const transcriptView = view({
    reply: "moving on",
    events: [
      { type: "message.completed", data: { message: "Order ORD-1003 is delayed." } },
      { type: "message.completed", data: { message: "moving on" } },
    ],
  });

  it("includes matches substrings and regexes across the whole transcript", async () => {
    const records = await evaluate(
      `  - reply:\n      includes: ["ORD-1003", "/delayed/i"]`,
      transcriptView,
    );
    expect(records.map((r) => r.status)).toEqual(["passed", "passed"]);
    expect(records.map((r) => r.kind)).toEqual(["reply.includes", "reply.includes"]);
  });

  it("excludes fails when a leaked token appears anywhere in the transcript", async () => {
    const records = await evaluate(
      `  - reply:\n      excludes: ["ORD-1003", "ORD-2001"]`,
      transcriptView,
    );
    expect(records[0]).toMatchObject({
      kind: "reply.excludes",
      status: "failed",
      detail: "ORD-1003",
    });
    expect(records[1]).toMatchObject({ status: "passed", detail: "ORD-2001" });
  });

  it("falls back to the reply when no completed-message events exist", async () => {
    const records = await evaluate(
      `  - reply:\n      includes: ["hello"]`,
      view({ reply: "hello world" }),
    );
    expect(records[0]?.status).toBe("passed");
  });

  // The mapping a consumer relies on: an expectation's fan-out never dilutes
  // attribution — one step in, that step on every record out.
  it("attributes every record of a multi-record expectation to its step", async () => {
    const yaml =
      `  - reply:\n      includes: ["ORD-1003", "/delayed/i"]\n` + `      excludes: ["ORD-2001"]`;
    const records = await evaluateExpectations(expectations(yaml), transcriptView, 7);
    expect(records.map((r) => r.kind)).toEqual([
      "reply.includes",
      "reply.includes",
      "reply.excludes",
    ]);
    expect(records.map((r) => r.step)).toEqual([7, 7, 7]);
  });
});

describe("evaluateExpectations tool assertions", () => {
  const toolView = view({
    toolCalls: [
      { name: "read_file", input: { file_path: "trigger.json" }, status: "completed" },
      { name: "write_file", input: { file_path: "output/report.json" }, status: "completed" },
    ],
  });

  it("calledTool matches by name and partial input", async () => {
    const records = await evaluate(
      `  - calledTool:\n      name: read_file\n      input: { file_path: trigger.json }`,
      toolView,
    );
    expect(records[0]).toMatchObject({ kind: "calledTool", status: "passed", detail: "read_file" });

    const wrongInput = await evaluate(
      `  - calledTool:\n      name: read_file\n      input: { file_path: other.json }`,
      toolView,
    );
    expect(wrongInput[0]?.status).toBe("failed");
  });

  it("matches /pattern/flags input values as regexes", async () => {
    const slashView = view({
      toolCalls: [
        { name: "read_file", input: { file_path: "/trigger.json" }, status: "completed" },
      ],
    });
    const records = await evaluate(
      `  - calledTool:\n      name: read_file\n      input: { file_path: "/trigger\\\\.json/" }`,
      slashView,
    );
    expect(records[0]?.status).toBe("passed");

    const literal = await evaluate(
      `  - calledTool:\n      name: read_file\n      input: { file_path: trigger.json }`,
      slashView,
    );
    expect(literal[0]?.status).toBe("failed");
  });

  it("notCalledTool and usedNoTools", async () => {
    expect(
      (await evaluate(`  - notCalledTool:\n      name: delete_file`, toolView))[0]?.status,
    ).toBe("passed");
    expect((await evaluate(`  - notCalledTool:\n      name: read_file`, toolView))[0]?.status).toBe(
      "failed",
    );
    expect((await evaluate("  - usedNoTools: true", view()))[0]?.status).toBe("passed");
    expect((await evaluate("  - usedNoTools: true", toolView))[0]?.status).toBe("failed");
  });

  describe("blockedTool", () => {
    const blockedView = view({
      toolCalls: [
        {
          name: "read_file",
          input: { file_path: "skills/refund-policy/SKILL.md" },
          status: "rejected",
        },
        { name: "read_file", input: { file_path: "scratchpad/notes.md" }, status: "completed" },
        { name: "write_file", input: { file_path: "scratchpad/a.json" }, status: "failed" },
      ],
    });

    it("passes when a matching call was refused by governance", async () => {
      const records = await evaluate(
        `  - blockedTool:\n      name: read_file\n      input: { file_path: "/refund-policy/" }`,
        blockedView,
      );
      expect(records[0]).toMatchObject({
        kind: "blockedTool",
        status: "passed",
        detail: "read_file",
      });
    });

    it("fails when the matching call succeeded", async () => {
      const records = await evaluate(
        `  - blockedTool:\n      name: read_file\n      input: { file_path: scratchpad/notes.md }`,
        blockedView,
      );
      expect(records[0]?.status).toBe("failed");
    });

    it("fails when the call never happened, unlike notCalledTool", async () => {
      expect(
        (await evaluate(`  - blockedTool:\n      name: delete_file`, blockedView))[0]?.status,
      ).toBe("failed");
      expect(
        (await evaluate(`  - notCalledTool:\n      name: delete_file`, blockedView))[0]?.status,
      ).toBe("passed");
    });

    it("does not count a tool that ran and errored", async () => {
      expect(
        (await evaluate(`  - blockedTool:\n      name: write_file`, blockedView))[0]?.status,
      ).toBe("failed");
    });
  });
});

describe("evaluateExpectations trail assertions", () => {
  const trailView = view({
    auditTrail: [
      trailStep("identify-case", "trigger", "manual"),
      trailStep("refund-request", "agent"),
      trailStep("refund-review", "agent"),
      trailStep("refund-request", "human", "refine"),
      trailStep("refund-review", "agent"),
    ],
  });

  it("reachedState counts committed transitions only, never the trigger arrival", async () => {
    expect((await evaluate("  - reachedState: refund-review", trailView))[0]?.status).toBe(
      "passed",
    );
    expect((await evaluate("  - reachedState: identify-case", trailView))[0]?.status).toBe(
      "failed",
    );
  });

  it("trail counts steps matching all declared fields", async () => {
    const records = await evaluate(
      `  - trail:\n      to: refund-review\n      count: 2`,
      trailView,
    );
    expect(records[0]?.status).toBe("passed");
    expect(records[0]?.detail).toContain("expected 2, saw 2");

    const wrong = await evaluate(`  - trail:\n      to: refund-review\n      count: 3`, trailView);
    expect(wrong[0]?.status).toBe("failed");

    const byKind = await evaluate(
      `  - trail:\n      kind: human\n      reason: refine\n      count: 1`,
      trailView,
    );
    expect(byKind[0]?.status).toBe("passed");
  });

  it("noTraversal passes only when the trail holds trigger arrivals at most", async () => {
    const vetoed = view({ auditTrail: [trailStep("identify-case", "trigger", "manual")] });
    expect((await evaluate("  - noTraversal: true", vetoed))[0]?.status).toBe("passed");
    expect((await evaluate("  - noTraversal: true", trailView))[0]?.status).toBe("failed");
    expect((await evaluate("  - noTraversal: true", view()))[0]?.status).toBe("passed");
  });

  it("triggerArrival matches a trigger step's reason", async () => {
    const triggered = view({
      auditTrail: [trailStep("report-requested", "trigger", "report_requested")],
    });
    expect((await evaluate("  - triggerArrival: report_requested", triggered))[0]?.status).toBe(
      "passed",
    );
    expect((await evaluate("  - triggerArrival: manual", triggered))[0]?.status).toBe("failed");
  });
});

describe("evaluateExpectations judge assertions", () => {
  const judgeYaml = `  - grade:\n      closedQA: confirms the refund\n      atLeast: 0.7`;

  it("records a threshold record from the judge result", async () => {
    const records = await evaluateExpectations(
      expectations(judgeYaml),
      view({ reply: "your refund is approved" }),
      STEP,
      async (criteria, evidence) => {
        expect(criteria).toBe("confirms the refund");
        expect(evidence.reply).toBe("your refund is approved");
        return { score: 0.9, status: "passed", reason: "clearly approved" };
      },
    );
    expect(records[0]).toMatchObject({
      kind: "grade.closedQA",
      threshold: 0.7,
      status: "passed",
      score: 0.9,
      step: STEP,
    });
    expect(records[0]?.detail).toContain("clearly approved");
  });

  // Built from the same view every other assertion on the step reads, so a
  // `judge` and a `calledTool` here can never disagree about what the run did.
  it("hands the judge the turn's tool record, not only its reply", async () => {
    const graded = view({
      reply: "ORD-1001 ships tomorrow.",
      events: [
        { type: "message.completed", data: { message: "Looking it up." } },
        { type: "tool.called", data: { name: "read_file" } },
        { type: "message.completed", data: { message: "ORD-1001 ships tomorrow." } },
      ],
      toolCalls: [
        {
          name: "read_file",
          input: { file_path: "data/orders.json" },
          output: { id: "ORD-1001" },
          status: "completed",
        },
      ],
    });

    await evaluateExpectations(expectations(judgeYaml), graded, STEP, async (_c, evidence) => {
      expect(evidence.reply).toBe("ORD-1001 ships tomorrow.");
      expect(evidence.record).toEqual([
        { kind: "message", text: "Looking it up." },
        {
          kind: "tool",
          name: "read_file",
          input: { file_path: "data/orders.json" },
          output: { id: "ORD-1001" },
          status: "completed",
        },
      ]);
      return { score: 1, status: "passed" };
    });
  });

  // The declared `atLeast` is what the verdict compares against, so it has to
  // be what the record says too — otherwise a record reads passed beside
  // a verdict that counted it a miss, which is exactly what a UI cannot render.
  it("decides by the declared threshold, not the judge's own boolean", async () => {
    const records = await evaluateExpectations(
      expectations(judgeYaml),
      view({ reply: "maybe approved" }),
      STEP,
      async () => ({ score: 0.6, pass: true, reason: "partially" }),
    );
    expect(records[0]).toMatchObject({ status: "failed", score: 0.6 });
  });

  it("passes a score exactly at the threshold", async () => {
    const records = await evaluateExpectations(expectations(judgeYaml), view(), STEP, async () => ({
      score: 0.7,
      pass: false,
    }));
    expect(records[0]).toMatchObject({ status: "passed" });
  });

  it("fails actionably when no judge is configured", async () => {
    const records = await evaluateExpectations(expectations(judgeYaml), view(), STEP);
    expect(records[0]?.status).toBe("failed");
    expect(records[0]?.status).toBe("failed");
    expect(records[0]?.score).toBe(0);
    expect(records[0]?.detail).toContain("grading model unavailable");
  });

  it("captures judge errors as failures rather than escaping", async () => {
    const records = await evaluateExpectations(expectations(judgeYaml), view(), STEP, async () => {
      throw new Error("model unreachable");
    });
    expect(records[0]?.status).toBe("failed");
    expect(records[0]?.status).toBe("failed");
    expect(records[0]?.detail).toContain("model unreachable");
  });
});

describe("haltsCaseOnFailure", () => {
  it("covers exactly the structural assertions", () => {
    const structural = ["succeeded", "parked", "reachedState", "trail", "noTraversal"] as const;
    for (const a of [...structural, "triggerArrival"] as const) {
      expect(haltsCaseOnFailure(a)).toBe(true);
    }
    for (const a of ["reply", "calledTool", "notCalledTool", "usedNoTools", "grade"] as const) {
      expect(haltsCaseOnFailure(a)).toBe(false);
    }
  });
});

describe("notExecutedRecord", () => {
  it("describes an un-run gate assertion", () => {
    expect(notExecutedRecord({ assert: "reachedState", state: "done" }, 4)).toEqual({
      kind: "reachedState",
      threshold: null,
      status: "not-executed",
      step: 4,
    });
  });

  it("carries the judge's declared threshold", () => {
    expect(notExecutedRecord({ assert: "grade", closedQA: "x", atLeast: 0.7 }, 2)).toMatchObject({
      kind: "grade",
      threshold: 0.7,
      status: "not-executed",
    });
  });
});

describe("variables assertion", () => {
  const run = (yaml: string, variables: SessionView["variables"]) =>
    evaluate(yaml, view({ variables }));

  it("passes when the value matches", async () => {
    const records = await run("  - variables:\n      expect:\n        company: Acme\n", {
      company: { value: "Acme", locked: false },
    });
    expect(records.every((r) => r.status === "passed")).toBe(true);
  });

  it("fails naming expected and actual", async () => {
    const records = await run("  - variables:\n      expect:\n        company: Acme\n", {
      company: { value: "Globex", locked: false },
    });
    expect(records[0]?.status).toBe("failed");
    expect(records[0]?.detail).toContain("Acme");
    expect(records[0]?.detail).toContain("Globex");
  });

  it("fails an unset variable explicitly", async () => {
    const records = await run("  - variables:\n      expect:\n        company: Acme\n", {});
    expect(records[0]?.status).toBe("failed");
    expect(records[0]?.detail).toContain("not set");
  });

  it("compares a structured value deeply", async () => {
    const records = await run(
      '  - variables:\n      expect:\n        order: { items: [{ sku: "A-1" }] }\n',
      { order: { value: { items: [{ sku: "A-1" }] }, locked: false } },
    );
    expect(records[0]?.status).toBe("passed");
  });

  it("addresses a path, including from the end of an array", async () => {
    const value = { items: [{ sku: "A-1" }, { sku: "B-2" }] };
    const records = await run(
      '  - variables:\n      expect:\n        order: "B-2"\n      path:\n        order: "items.-1.sku"\n',
      { order: { value, locked: false } },
    );
    expect(records[0]?.status).toBe("passed");
  });

  it("fails a path that does not resolve", async () => {
    const records = await run(
      '  - variables:\n      expect:\n        order: "x"\n      path:\n        order: "nope"\n',
      { order: { value: { id: 1 }, locked: false } },
    );
    expect(records[0]?.status).toBe("failed");
    expect(records[0]?.detail).toContain("does not resolve");
  });

  it("checks the locked flag when asked", async () => {
    const records = await run(
      "  - variables:\n      expect:\n        company: Acme\n      locked:\n        company: true\n",
      { company: { value: "Acme", locked: false } },
    );
    expect(records.some((r) => r.status === "failed" && /locked/.test(String(r.detail)))).toBe(
      true,
    );
  });
});

describe("evaluateExpectations ranWorkflow assertions", () => {
  const dispatchStep = (workflow: string, status: "ok" | "error"): TrailStep => ({
    to: "enrich",
    kind: "sub-workflow",
    workflow,
    status,
    ts: 1,
  });

  const delegatingView = view({
    auditTrail: [
      trailStep("enrich", "trigger", "manual"),
      dispatchStep("enrich-account", "ok"),
      dispatchStep("enrich-account", "ok"),
      dispatchStep("score-risk", "error"),
    ],
  });

  it("passes when the turn dispatched the named workflow successfully", async () => {
    const records = await evaluate("  - ranWorkflow: { workflow: enrich-account }", delegatingView);
    expect(records[0]?.status).toBe("passed");
  });

  it("fails when the named workflow was never dispatched", async () => {
    const records = await evaluate("  - ranWorkflow: { workflow: nothing-ran }", delegatingView);
    expect(records[0]?.status).toBe("failed");
  });

  it("distinguishes a failed dispatch from a successful one", async () => {
    expect(
      (await evaluate("  - ranWorkflow: { workflow: score-risk }", delegatingView))[0]?.status,
    ).toBe("failed");
    expect(
      (
        await evaluate("  - ranWorkflow: { workflow: score-risk, status: error }", delegatingView)
      )[0]?.status,
    ).toBe("passed");
  });

  it("counts dispatches when a count is declared", async () => {
    expect(
      (await evaluate("  - ranWorkflow: { workflow: enrich-account, count: 2 }", delegatingView))[0]
        ?.status,
    ).toBe("passed");
    expect(
      (await evaluate("  - ranWorkflow: { workflow: enrich-account, count: 1 }", delegatingView))[0]
        ?.status,
    ).toBe("failed");
  });
});
