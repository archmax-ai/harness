import { describe, expect, it } from "vitest";
import { parseMachineSpec } from "../machine/spec-schema.js";
import { WorkflowMachine } from "../machine/machine.js";
import type { VariableStore } from "../machine/variables.js";
import { checkReturns, type ReturnsCheckInput } from "./returns-check.js";
import { missingReturnsNote, RETURNS_NOTE_VARIABLE, returnsRejection } from "./signature-checks.js";

const machine = WorkflowMachine.fromSpec({
  states: {
    work: {
      triggers: {
        manual: { returns: ["corrected_invoice_number", "description"] },
        typed: { returns: [{ name: "total", type: "number" }] },
        bare: null,
      },
    },
  },
});

const store = (values: Record<string, unknown>): VariableStore =>
  Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value, locked: false }]));

const check = (input: Partial<ReturnsCheckInput> = {}) =>
  checkReturns(machine, { trigger: "manual", state: "work", store: store({}), child: false, ...input });

describe("checkReturns", () => {
  it("completes a session that set every return, and one whose trigger declares none", () => {
    expect(check({ store: store({ corrected_invoice_number: "INV-1", description: "ok" }) })).toEqual({
      verdict: "complete",
    });
    expect(check({ trigger: "bare" })).toEqual({ verdict: "complete" });
    expect(check({ trigger: undefined })).toEqual({ verdict: "complete" });
  });

  it("completes a child that left returns unset: its caller gets what it set and a note", () => {
    expect(check({ child: true, store: store({ corrected_invoice_number: "INV-1" }) })).toEqual({
      verdict: "complete",
    });
  });

  it("rejects a top-level session that left returns unset, with the reason it always gave", () => {
    const shortStore = store({ corrected_invoice_number: "INV-1" });
    expect(check({ store: shortStore })).toEqual({
      verdict: "reject",
      reason: returnsRejection(machine, "manual", "work", shortStore),
    });
  });

  it("rejects a mistyped return, a child's included: a wrong-typed value is never handed on", () => {
    const wrong = store({ total: "twelve" });
    for (const child of [false, true]) {
      const verdict = check({ trigger: "typed", store: wrong, child });
      expect(verdict).toMatchObject({ verdict: "reject", reason: expect.stringContaining("'total'") });
    }
  });
});

describe("the note a caller gets", () => {
  it("names every return the child left unset", () => {
    expect(missingReturnsNote(["description"])).toBe(
      "Not all return variables were set by the sub-workflow: 'description' was not set.",
    );
    expect(missingReturnsNote(["a", "b"])).toBe(
      "Not all return variables were set by the sub-workflow: 'a', 'b' were not set.",
    );
  });

  it("is a name no trigger may declare in its returns", () => {
    const spec = {
      states: { work: { triggers: { manual: { returns: [RETURNS_NOTE_VARIABLE] } } } },
    };
    const parsed = parseMachineSpec(spec);
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).toContain(`'${RETURNS_NOTE_VARIABLE}' is reserved in 'returns'`);
  });
});
