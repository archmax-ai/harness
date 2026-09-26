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

  it("routes a delivered rejection through the same failure", () => {
    const { code } = capture(() =>
      printOutcome(style, machine, "s1", outcome({ kind: "rejected", disposition: "deliver", status: "rejected" })),
    );
    expect(code).toBe(1);
  });
});
