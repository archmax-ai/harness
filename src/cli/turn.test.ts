import { afterEach, describe, expect, it, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { WorkflowMachine } from "../machine/machine.js";
import type { DecideOutcome, Outcome } from "../sessions/resume.js";
import { createStyle } from "./style.js";
import { printOutcome, printResumed } from "./turn.js";

const style = createStyle({ env: { NO_COLOR: "1" } });
const machine = WorkflowMachine.fromSpec({ states: { start: { triggers: { manual: null } } } });

/** Capture both streams around one printer call. */
function capture(print: () => number): { code: number; stdout: string; stderr: string } {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const code = print();
  return {
    code,
    stdout: log.mock.calls.map((c) => String(c[0])).join("\n"),
    stderr: error.mock.calls.map((c) => String(c[0])).join("\n"),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const settled = (over: Partial<DecideOutcome>): DecideOutcome => ({
  reparked: false,
  reply: "",
  messages: [],
  auditTrail: [],
  ...over,
});

describe("printResumed", () => {
  it("reports a rejected resume as a failure with its reason, never as done", () => {
    const { code, stdout, stderr } = capture(() =>
      printResumed(
        style,
        "s1",
        "decided",
        settled({
          status: "rejected",
          workflowState: "done",
          rejected: "Completed in state 'done' without setting 'total'.",
          reply: "Refunded.",
        }),
      ),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("✖ rejected");
    expect(stderr).toContain("Session s1 was rejected in the 'done' state: Completed in state 'done' without setting 'total'.");
    expect(stderr).not.toContain("decided");
    expect(stdout).toBe("Refunded.");
  });

  it("still reports a completed resume, exit 0", () => {
    const { code, stdout, stderr } = capture(() =>
      printResumed(style, "s1", "delivered", settled({ status: "completed", messages: [new AIMessage("All set.")] })),
    );
    expect(code).toBe(0);
    expect(stderr).toContain("✔ delivered");
    expect(stdout).toBe("All set.");
  });

  it("reports a resume that ended in a raise as a failure with its code, exit 1", () => {
    const { code, stdout, stderr } = capture(() =>
      printResumed(
        style,
        "s1",
        "delivered",
        settled({
          status: "failed",
          workflowState: "lookup",
          exit: { success: false, code: "orders-unavailable", reason: "The orders API is down." },
          reply: "I could not reach the orders system.",
        }),
      ),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("✖ failed");
    expect(stderr).toContain(
      "Session s1 failed in the 'lookup' state with code 'orders-unavailable': The orders API is down.",
    );
    expect(stderr).not.toContain("delivered");
    expect(stdout).toBe("I could not reach the orders system.");
  });

  it("treats a re-park as a success", () => {
    const { code } = capture(() =>
      printResumed(style, "s1", "decided", settled({ reparked: true, parkedChannel: "decision", state: "review" })),
    );
    expect(code).toBe(0);
  });
});

describe("printOutcome", () => {
  const outcome = (over: Partial<Outcome>): Outcome => ({
    kind: "completed",
    disposition: "turn",
    reply: "",
    messages: [],
    auditTrail: [],
    variables: {},
    ...over,
  });

  it("reports a rejected turn with its reason and exits 1", () => {
    const { code, stdout, stderr } = capture(() =>
      printOutcome(
        style,
        machine,
        "s1",
        outcome({ kind: "rejected", status: "rejected", state: "start", rejected: "Refusing to start: no." }),
      ),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("Session s1 was rejected in the 'start' state: Refusing to start: no.");
    expect(stderr).not.toContain("answer");
    expect(stdout).toBe("");
  });

  it("reports a completed turn as an answer, exit 0", () => {
    const { code, stdout, stderr } = capture(() =>
      printOutcome(style, machine, "s1", outcome({ status: "completed", reply: "Hello." })),
    );
    expect(code).toBe(0);
    expect(stderr).toContain("✔ answer");
    expect(stdout).toBe("Hello.");
  });

  it("reports a turn the agent ended with a raise as a failure, never an answer, exit 1", () => {
    const { code, stdout, stderr } = capture(() =>
      printOutcome(
        style,
        machine,
        "s1",
        outcome({
          kind: "failed",
          status: "failed",
          state: "start",
          exit: { success: false, code: "orders-unavailable", reason: "The orders API is down." },
          reply: "I could not reach the orders system.",
        }),
      ),
    );
    // The agent's code is reported, never used as the process's exit code.
    expect(code).toBe(1);
    expect(stderr).toContain("✖ failed");
    expect(stderr).toContain("Session s1 failed in the 'start' state with code 'orders-unavailable': The orders API is down.");
    expect(stderr).not.toContain("answer");
    expect(stdout).toBe("I could not reach the orders system.");
  });

  it("routes a delivered failure through the same report", () => {
    const { code, stderr } = capture(() =>
      printOutcome(
        style,
        machine,
        "s1",
        outcome({
          kind: "failed",
          disposition: "deliver",
          status: "failed",
          state: "start",
          exit: { success: false, code: "x", reason: "y" },
        }),
      ),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("with code 'x': y");
  });

  it("routes a delivered rejection through the same failure", () => {
    const { code } = capture(() =>
      printOutcome(style, machine, "s1", outcome({ kind: "rejected", disposition: "deliver", status: "rejected" })),
    );
    expect(code).toBe(1);
  });
});
