import { describe, expect, it } from "vitest";
import { createStateFlowRenderer } from "./state-flow.js";
import { createStyle, icons } from "./style.js";

class FakeStream {
  chunks: string[] = [];
  write(chunk: string) {
    this.chunks.push(chunk);
  }
}

describe("createStateFlowRenderer", () => {
  it("renders a linear path as an append-only trail", () => {
    const stream = new FakeStream();
    const renderer = createStateFlowRenderer(stream, createStyle({ isTTY: false }));

    renderer.onEvent({ type: "workflow-reset", entry: "first" });
    renderer.onEvent({ type: "state-enter", state: "first" });
    renderer.onEvent({ type: "state-leave", state: "first", next: "second" });
    renderer.onEvent({ type: "state-enter", state: "second" });
    renderer.onEvent({ type: "state-leave", state: "second", next: "done" });

    const output = stream.chunks.join("");
    expect(output).toContain("first");
    expect(output).toContain("second");
    expect(output).toContain("done");
    expect(output.indexOf("first")).toBeLessThan(output.indexOf("second"));
  });

  it("appends a revisited state again rather than collapsing it", () => {
    const stream = new FakeStream();
    const renderer = createStateFlowRenderer(stream, createStyle({ isTTY: false }));

    renderer.onEvent({ type: "state-enter", state: "review" });
    renderer.onEvent({ type: "state-leave", state: "review", next: "revise" });
    renderer.onEvent({ type: "state-enter", state: "review" });
    renderer.onEvent({ type: "state-leave", state: "review", next: "done" });

    const enterLines = stream.chunks.filter(
      (c) => c.includes("review") && c.includes(icons.inProgress),
    );
    expect(enterLines.length).toBe(2);
  });

  it("ignores non-state-flow events", () => {
    const stream = new FakeStream();
    const renderer = createStateFlowRenderer(stream, createStyle({ isTTY: false }));

    renderer.onEvent({ type: "interpreter-enabled" });
    renderer.onEvent({ type: "skills-loaded", names: ["a"] });

    expect(stream.chunks).toEqual([]);
  });

  it("renders without ANSI codes when color is suppressed", () => {
    const stream = new FakeStream();
    const renderer = createStateFlowRenderer(stream, createStyle({ isTTY: false }));

    renderer.onEvent({ type: "state-enter", state: "first" });
    renderer.onEvent({ type: "state-leave", state: "first", next: "done" });

    const output = stream.chunks.join("");
    expect(output).not.toContain("\x1b[");
  });

  it("indents per-node actions beneath the node-change lines", () => {
    const stream = new FakeStream();
    const renderer = createStateFlowRenderer(stream, createStyle({ isTTY: false }));

    renderer.onEvent({ type: "state-enter", state: "first" });
    renderer.onEvent({ type: "hook-start", state: "first", phase: "before", label: "check.js" });

    const nodeLine = stream.chunks.find((c) => c.includes(icons.inProgress))!;
    const actionLine = stream.chunks.find((c) => c.includes("before"))!;
    const leadingSpaces = (line: string) => line.match(/^ */)![0].length;
    expect(leadingSpaces(actionLine)).toBeGreaterThan(leadingSpaces(nodeLine));
  });

  it("renders hook phases, verdicts, and rejections", () => {
    const stream = new FakeStream();
    const renderer = createStateFlowRenderer(stream, createStyle({ isTTY: false }));

    renderer.onEvent({ type: "hook-start", state: "s", phase: "before", label: "check.js" });
    renderer.onEvent({ type: "hook-passed", state: "s", phase: "before" });
    renderer.onEvent({
      type: "hook-verdict",
      state: "s",
      phase: "after",
      label: "judge",
      verdict: "ok",
      reason: "looks good",
    });
    renderer.onEvent({ type: "hook-rejected", state: "s", phase: "after", reason: "missing data" });

    const output = stream.chunks.join("");
    expect(output).toContain("before");
    expect(output).toContain("after");
    expect(output).toContain("looks good");
    expect(output).toContain("missing data");
  });

  it("prints the advance reason indented under the node, without a target", () => {
    const stream = new FakeStream();
    const renderer = createStateFlowRenderer(stream, createStyle({ isTTY: false }));

    renderer.onEvent({ type: "state-enter", state: "orders-question" });
    renderer.onEvent({
      type: "advance",
      from: "orders-question",
      to: "done",
      reason: "order lookup is complete",
    });
    renderer.onEvent({ type: "state-leave", state: "orders-question", next: "done" });

    const reasonLine = stream.chunks.find((c) => c.includes("order lookup is complete"))!;
    expect(reasonLine).toBeDefined();
    const nodeLine = stream.chunks.find((c) => c.includes(icons.inProgress))!;
    const leadingSpaces = (line: string) => line.match(/^ */)![0].length;
    expect(leadingSpaces(reasonLine)).toBeGreaterThan(leadingSpaces(nodeLine));
  });

  it("renders a transition once, folding away the advance tool's own call", () => {
    // The runtime emits the pair for every governed call, this one included.
    // Whether a human-readable trail shows it is the renderer's call: the state
    // lines and the reason already say the run moved.
    const stream = new FakeStream();
    const renderer = createStateFlowRenderer(stream, createStyle({ isTTY: false }));

    renderer.onEvent({ type: "state-enter", state: "orders-question" });
    renderer.onEvent({
      type: "tool-called",
      state: "orders-question",
      tool: "archmax_advance",
      callId: "a1",
      args: { to: "done", reason: "order lookup is complete" },
    });
    renderer.onEvent({
      type: "advance",
      from: "orders-question",
      to: "done",
      reason: "order lookup is complete",
      callId: "a1",
    });
    renderer.onEvent({ type: "state-leave", state: "orders-question", next: "done" });

    const output = stream.chunks.join("");
    expect(output).not.toContain("archmax_advance");
    expect(output).toContain("order lookup is complete");
  });

  it("still renders the other intercepted workflow tools", () => {
    const stream = new FakeStream();
    const renderer = createStateFlowRenderer(stream, createStyle({ isTTY: false }));

    renderer.onEvent({ type: "state-enter", state: "collect" });
    renderer.onEvent({
      type: "tool-called",
      state: "collect",
      tool: "archmax_set_variables",
      callId: "s1",
      args: { variables: { product: "strawberries" } },
    });
    renderer.onEvent({
      type: "tool-called",
      state: "collect",
      tool: "archmax_wait",
      callId: "w1",
      args: { reason: "waiting for the customer" },
    });

    const output = stream.chunks.join("");
    expect(output).toContain("archmax_set_variables");
    expect(output).toContain("archmax_wait");
  });

  it("emits nothing for an advance event without a reason", () => {
    const stream = new FakeStream();
    const renderer = createStateFlowRenderer(stream, createStyle({ isTTY: false }));

    renderer.onEvent({ type: "advance", from: "a", to: "b" });

    expect(stream.chunks).toEqual([]);
  });

  it("quotes the agent's own text line by line", () => {
    const stream = new FakeStream();
    const renderer = createStateFlowRenderer(stream, createStyle({ isTTY: false }));

    renderer.onEvent({ type: "agent-text", state: "s", text: "line one\nline two" });

    const quoted = stream.chunks.filter((c) => c.includes(icons.quote));
    expect(quoted.length).toBe(2);
    expect(quoted[0]).toContain("line one");
    expect(quoted[1]).toContain("line two");
  });

  it("renders a blocked tool as an indented warning", () => {
    const stream = new FakeStream();
    const renderer = createStateFlowRenderer(stream, createStyle({ isTTY: false }));

    renderer.onEvent({ type: "state-enter", state: "identify-case" });
    renderer.onEvent({
      type: "tool-blocked",
      state: "identify-case",
      tool: "read_file",
      reason: "[workflow] BLOCKED: 'read_file' ...",
    });

    const nodeLine = stream.chunks.find((c) => c.includes(icons.inProgress))!;
    const blockedLine = stream.chunks.find((c) => c.includes(icons.warn))!;
    const leadingSpaces = (line: string) => line.match(/^ */)![0].length;
    expect(blockedLine).toContain("blocked read_file");
    expect(blockedLine).not.toContain("[workflow]");
    expect(leadingSpaces(blockedLine)).toBeGreaterThan(leadingSpaces(nodeLine));
  });

  it("renders an allowed tool call indented with its detail", () => {
    const stream = new FakeStream();
    const renderer = createStateFlowRenderer(stream, createStyle({ isTTY: false }));

    renderer.onEvent({ type: "state-enter", state: "orders-question" });
    renderer.onEvent({
      type: "tool-called",
      state: "orders-question",
      tool: "read_file",
      detail: "data/orders.json",
    });

    const nodeLine = stream.chunks.find((c) => c.includes(icons.inProgress))!;
    const toolLine = stream.chunks.find((c) => c.includes("read_file"))!;
    const leadingSpaces = (line: string) => line.match(/^ */)![0].length;
    expect(toolLine).toContain("read_file");
    expect(toolLine).toContain("data/orders.json");
    expect(leadingSpaces(toolLine)).toBeGreaterThan(leadingSpaces(nodeLine));
  });

  it("renders warning events with their scope", () => {
    const stream = new FakeStream();
    const renderer = createStateFlowRenderer(stream, createStyle({ isTTY: false }));

    renderer.onEvent({
      type: "warning",
      scope: "workflow",
      message: "invalid machine spec at WORKFLOW.md",
      level: "warn",
    });

    const output = stream.chunks.join("");
    expect(output).toContain("[workflow]");
    expect(output).toContain("invalid machine spec at WORKFLOW.md");
  });

  it("ignores assembly-time summary events", () => {
    const stream = new FakeStream();
    const renderer = createStateFlowRenderer(stream, createStyle({ isTTY: false }));

    renderer.onEvent({ type: "hooks-summary", summary: "a(before)" });
    renderer.onEvent({ type: "graph-topology", topology: "START -> a" });

    expect(stream.chunks).toEqual([]);
  });

  it("colors before and after phases differently", () => {
    const stream = new FakeStream();
    const renderer = createStateFlowRenderer(stream, createStyle({ isTTY: true, env: {} }));

    renderer.onEvent({ type: "hook-start", state: "s", phase: "before", label: "a" });
    renderer.onEvent({ type: "hook-start", state: "s", phase: "after", label: "b" });

    const before = stream.chunks.find((c) => c.includes("before"))!;
    const after = stream.chunks.find((c) => c.includes("after"))!;
    expect(before).toContain("\x1b[34m"); // blue
    expect(after).toContain("\x1b[35m"); // magenta
  });
});

describe("sub-workflow rendering", () => {
  const render = (
    events: Parameters<ReturnType<typeof createStateFlowRenderer>["onEvent"]>[0][],
  ) => {
    const stream = new FakeStream();
    const renderer = createStateFlowRenderer(stream, createStyle({ isTTY: false }));
    for (const event of events) renderer.onEvent(event);
    return stream.chunks.join("");
  };

  it("nests a dispatch under the delegating state rather than as its own step", () => {
    const output = render([
      { type: "state-enter", state: "enrich" },
      {
        type: "sub-workflow-start",
        state: "enrich",
        workflow: "enrich-account",
        dispatchId: "d1",
        depth: 1,
      },
      {
        type: "sub-workflow-result",
        state: "enrich",
        workflow: "enrich-account",
        dispatchId: "d1",
        status: "ok",
        durationMs: 120,
      },
      { type: "state-leave", state: "enrich", next: "done" },
    ]);

    expect(output).toContain("sub-workflow enrich-account");
    expect(output).toContain("120ms");
    // Indented: the run has not moved, one state is running a workflow inside itself.
    expect(output).toMatch(/\n {4}\S[^\n]*sub-workflow enrich-account/);
  });

  // Both contract breaches reach the trail through the ordinary failure reason,
  // so the run view names the variable at fault rather than "sub-workflow failed".
  it("names the variables behind a contract breach", () => {
    const refused = render([
      { type: "state-enter", state: "enrich" },
      {
        type: "sub-workflow-start",
        state: "enrich",
        workflow: "enrich-order",
        dispatchId: "d1",
        depth: 1,
      },
      {
        type: "sub-workflow-result",
        state: "enrich",
        workflow: "enrich-order",
        dispatchId: "d1",
        status: "error",
        durationMs: 1,
        reason:
          "Refusing to run sub-workflow 'enrich-order': it requires 'order_id', which this " +
          "dispatch does not supply.",
      },
    ]);
    expect(refused).toContain("sub-workflow enrich-order failed");
    expect(refused).toContain("requires 'order_id'");
  });

  it("reports the returned names on a successful dispatch event", () => {
    const output = render([
      { type: "state-enter", state: "enrich" },
      {
        type: "sub-workflow-start",
        state: "enrich",
        workflow: "enrich-order",
        dispatchId: "d1",
        depth: 1,
      },
      {
        type: "sub-workflow-result",
        state: "enrich",
        workflow: "enrich-order",
        dispatchId: "d1",
        status: "ok",
        durationMs: 12,
        returns: ["enrichment_file", "delayed"],
      },
    ]);
    expect(output).toContain("sub-workflow enrich-order");
  });

  it("shows a failed dispatch with its reason", () => {
    const output = render([
      { type: "state-enter", state: "enrich" },
      {
        type: "sub-workflow-start",
        state: "enrich",
        workflow: "enrich-account",
        dispatchId: "d1",
        depth: 1,
      },
      {
        type: "sub-workflow-result",
        state: "enrich",
        workflow: "enrich-account",
        dispatchId: "d1",
        status: "error",
        durationMs: 5,
        reason: "the judge vetoed it",
      },
    ]);

    expect(output).toContain("failed");
    expect(output).toContain("the judge vetoed it");
  });

  it("names the depth once a dispatch is nested more than one deep", () => {
    const output = render([
      {
        type: "sub-workflow-start",
        state: "enrich",
        workflow: "score-risk",
        dispatchId: "d2",
        depth: 2,
      },
    ]);
    expect(output).toContain("depth 2");
  });

  it("renders each concurrent dispatch of a fan-out", () => {
    const output = render([
      { type: "state-enter", state: "enrich" },
      {
        type: "sub-workflow-start",
        state: "enrich",
        workflow: "enrich-account",
        dispatchId: "d1",
        depth: 1,
      },
      {
        type: "sub-workflow-start",
        state: "enrich",
        workflow: "enrich-account",
        dispatchId: "d2",
        depth: 1,
      },
      {
        type: "sub-workflow-result",
        state: "enrich",
        workflow: "enrich-account",
        dispatchId: "d1",
        status: "ok",
        durationMs: 10,
      },
      {
        type: "sub-workflow-result",
        state: "enrich",
        workflow: "enrich-account",
        dispatchId: "d2",
        status: "ok",
        durationMs: 12,
      },
    ]);

    expect(output.match(/sub-workflow enrich-account/g)).toHaveLength(4);
  });
});

describe("a sub-run's own events do not read as the parent moving", () => {
  const render = (
    events: Parameters<ReturnType<typeof createStateFlowRenderer>["onEvent"]>[0][],
  ) => {
    const stream = new FakeStream();
    const renderer = createStateFlowRenderer(stream, createStyle({ isTTY: false }));
    for (const event of events) renderer.onEvent(event);
    return stream.chunks.join("");
  };

  it("omits the child's states, which the parent never entered", () => {
    const output = render([
      { type: "state-enter", state: "enrich" },
      {
        type: "sub-workflow-start",
        state: "enrich",
        workflow: "enrich-account",
        dispatchId: "d1",
        depth: 1,
      },
      // Emitted by the child graph, tagged with the dispatch it belongs to.
      { type: "state-enter", state: "plan", subWorkflowDispatchId: "d1" },
      { type: "state-leave", state: "plan", next: "write", subWorkflowDispatchId: "d1" },
      {
        type: "sub-workflow-result",
        state: "enrich",
        workflow: "enrich-account",
        dispatchId: "d1",
        status: "ok",
        durationMs: 9,
      },
      { type: "state-leave", state: "enrich", next: "done" },
    ] as never);

    expect(output).not.toContain("plan");
    expect(output).not.toContain("write");
    expect(output).toContain("enrich");
    expect(output).toContain("sub-workflow enrich-account");
  });

  it("still renders the parent's own states", () => {
    const output = render([
      { type: "state-enter", state: "route" },
      { type: "state-leave", state: "route", next: "enrich" },
    ]);
    expect(output).toContain("route");
  });
});

// ---------------------------------------------------------------------------
// The test view built on the renderer

import type { AssertionRecord, AssertionStatus, CaseResult } from "../testing/runner.js";
import { createTestView } from "./state-flow.js";

const plain = createStyle({ isTTY: false });

function result(overrides: Partial<CaseResult> & Pick<CaseResult, "id">): CaseResult {
  return { verdict: { status: "passed", failures: [] }, records: [], ...overrides };
}

function gateRecord(o: { kind: string; status: AssertionStatus; step?: number }): AssertionRecord {
  return { kind: o.kind, threshold: null, status: o.status, step: o.step ?? 1 };
}

function gradeRecord(o: {
  score: number;
  threshold: number;
  status: AssertionStatus;
  step?: number;
}): AssertionRecord {
  return {
    kind: "grade.closedQA",
    threshold: o.threshold,
   
    status: o.status,
    score: o.score,
    step: o.step ?? 1,
  };
}

describe("createTestView per-case rendering", () => {
  it("renders two sequential cases as independent trails under their own headers", () => {
    const stream = new FakeStream();
    const view = createTestView(stream, plain);

    view.onCaseStart("workflows/order-lookup/tests/alpha.test.yaml");
    view.onEvent({ type: "state-enter", state: "identify-case" });
    view.onEvent({ type: "state-leave", state: "identify-case", next: "done" });
    view.onCaseResult(result({ id: "alpha" }));

    view.onCaseStart("workflows/order-lookup/tests/beta.test.yaml");
    view.onEvent({ type: "state-enter", state: "identify-case" });

    const output = stream.chunks.join("");
    const alphaHeader = output.indexOf("case workflows/order-lookup/tests/alpha.test.yaml");
    const betaHeader = output.indexOf("case workflows/order-lookup/tests/beta.test.yaml");
    expect(alphaHeader).toBeGreaterThanOrEqual(0);
    expect(betaHeader).toBeGreaterThan(alphaHeader);

    const enters = stream.chunks.filter(
      (c) => c.includes(icons.inProgress) && c.includes("identify-case"),
    );
    expect(enters).toHaveLength(2);
    expect(output.indexOf("identify-case")).toBeLessThan(betaHeader);
    expect(output.lastIndexOf("identify-case")).toBeGreaterThan(betaHeader);
  });

  it("renders verdict lines with the shared icons and indented failure details", () => {
    const stream = new FakeStream();
    const view = createTestView(stream, plain);

    view.onCaseResult(result({ id: "alpha", title: "passes" }));
    view.onCaseResult(
      result({
        id: "beta",
        title: "fails",
        verdict: { status: "failed", failures: ["expected refund", "missing order id"] },
      }),
    );
    view.onCaseResult(
      result({ id: "gamma", skipReason: "no judge", verdict: { status: "skipped", failures: [] } }),
    );

    const lines = stream.chunks.join("").split("\n");
    expect(lines).toContain(`${icons.check} alpha — passes`);
    expect(lines).toContain(`${icons.cross} beta — fails`);
    expect(lines).toContain(`      ${icons.cross} expected refund`);
    expect(lines).toContain(`      ${icons.cross} missing order id`);
    expect(lines).toContain(`${icons.pending} gamma (no judge)`);
  });

  // A grade is a scored outcome, and only failures printed before — so a grade
  // that passed at 0.9 left no trace at all in the output.
  it("prints every grade record with its score and threshold, passing included", () => {
    const stream = new FakeStream();
    const view = createTestView(stream, plain);

    view.onCaseResult(
      result({
        id: "alpha",
        records: [
          gradeRecord({ score: 0.9, threshold: 0.7, status: "passed" }),
          gradeRecord({ score: 0.4, threshold: 0.7, status: "failed", step: 3 }),
        ],
      }),
    );

    const lines = stream.chunks.join("").split("\n");
    expect(lines).toContain(`      ${icons.check} grade.closedQA 0.9 / 0.7`);
    expect(lines).toContain(`      ${icons.warn} grade.closedQA 0.4 / 0.7`);
  });

  it("omits an un-run grade from the score lines, counting it as un-run instead", () => {
    const stream = new FakeStream();
    const view = createTestView(stream, plain);

    view.onCaseResult(
      result({
        id: "alpha",
        verdict: { status: "failed", failures: ["parked"] },
        records: [
          gateRecord({ kind: "parked", status: "failed", step: 1 }),
          gradeRecord({ score: 0, threshold: 0.7, status: "not-executed", step: 3 }),
        ],
      }),
    );

    const output = stream.chunks.join("");
    expect(output).not.toContain("0 / 0.7");
    expect(output).toContain(`${icons.pending} 1 assertion not executed`);
  });

  it("counts un-run assertions so a halted case does not read as fully passed", () => {
    const stream = new FakeStream();
    const view = createTestView(stream, plain);

    view.onCaseResult(
      result({
        id: "alpha",
        verdict: { status: "failed", failures: ["reachedState: refund-review"] },
        records: [
          gateRecord({ kind: "reachedState", status: "failed", step: 1 }),
          gateRecord({ kind: "reply", status: "not-executed", step: 3 }),
          gateRecord({ kind: "succeeded", status: "not-executed", step: 4 }),
        ],
      }),
    );

    expect(stream.chunks.join("")).toContain(`${icons.pending} 2 assertions not executed`);
  });

  it("prints neither line for a case with no grade and nothing un-run", () => {
    const stream = new FakeStream();
    const view = createTestView(stream, plain);
    view.onCaseResult(
      result({ id: "alpha", records: [gateRecord({ kind: "succeeded", status: "passed" })] }),
    );
    const output = stream.chunks.join("");
    expect(output).not.toContain("grade");
    expect(output).not.toContain("not executed");
  });
});

describe("createTestView summary", () => {
  const mixed: CaseResult[] = [
    result({ id: "a" }),
    result({ id: "b" }),
    result({ id: "c" }),
    result({ id: "d", verdict: { status: "failed", failures: ["boom"] } }),
    result({ id: "e", verdict: { status: "skipped", failures: [] } }),
  ];

  it("prints counts and names failed, passed, and skipped cases", () => {
    const stream = new FakeStream();
    createTestView(stream, plain).renderSummary(mixed);

    const output = stream.chunks.join("");
    expect(output).toContain("3 passed, 1 failed, 1 skipped");
    expect(output).toContain(`${icons.cross} d`);
    expect(output).toContain(`${icons.check} a`);
    expect(output).toContain(`${icons.pending} e`);
  });

  it("states all cases passed when nothing failed or was skipped", () => {
    const stream = new FakeStream();
    createTestView(stream, plain).renderSummary([result({ id: "a" }), result({ id: "b" })]);
    const output = stream.chunks.join("");
    expect(output).toContain("2 passed, 0 failed, 0 skipped");
    expect(output).toContain("all 2 case(s) passed");
  });

  // A missed grade threshold is a failed case like any other — there is no
  // flag left that reclassifies it, so the summary and the exit code agree.
  it("counts a case that failed only on a grade threshold among the failures", () => {
    const stream = new FakeStream();
    createTestView(stream, plain).renderSummary([
      result({
        id: "grade-miss",
        verdict: { status: "failed", failures: ["grade.closedQA: confirms it (score 0.5 < 0.7)"] },
      }),
    ]);
    expect(stream.chunks.join("")).toContain("0 passed, 1 failed, 0 skipped");
  });

  it("emits no ANSI codes when color is suppressed and some when it is enabled", () => {
    const quiet = new FakeStream();
    const view = createTestView(quiet, createStyle({ env: { NO_COLOR: "1" }, isTTY: true }));
    view.onCaseStart("workflows/order-lookup/tests/alpha.test.yaml");
    view.onEvent({ type: "state-enter", state: "identify-case" });
    view.onCaseResult(result({ id: "alpha", verdict: { status: "failed", failures: ["boom"] } }));
    view.renderSummary([result({ id: "alpha" })]);
    expect(quiet.chunks.join("")).not.toContain("\x1b[");

    const loud = new FakeStream();
    createTestView(loud, createStyle({ env: {}, isTTY: true })).onCaseResult(
      result({ id: "alpha" }),
    );
    expect(loud.chunks.join("")).toContain("\x1b[");
  });

  it("says why a suite was skipped and names the workflow, without a pass/fail summary", () => {
    const stream = new FakeStream();
    createTestView(stream, plain).renderSuiteSkipped("retired", "disabled");
    const out = stream.chunks.join("");
    expect(out).toContain("suite skipped");
    expect(out).toContain("the workflow is disabled");
    expect(out).toContain("retired");
    expect(out).toContain("no case ran");
    expect(out).not.toContain("summary");
    expect(out).not.toContain(icons.cross);
  });
});
