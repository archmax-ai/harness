import { describe, expect, it } from "vitest";
import { lintSpec } from "./lint-spec.js";
import type { MachineSpec } from "./types.js";

/** A spec the schema accepts, so the lint is the only thing under test. */
function specWith(overrides: Partial<MachineSpec>): MachineSpec {
  return {
    instructions: "Stand-in guidance.",
    states: {
      triage: { triggers: { manual: null }, transitions: [{ to: "done", description: "Test edge to done." }] },
      done: {},
    },
    ...overrides,
  };
}

describe("a state's model", () => {
  it("warns when it repeats the workflow's, because it changes nothing", () => {
    const findings = lintSpec(
      specWith({
        settings: { model: "small-model" },
        states: {
          triage: { triggers: { manual: null }, model: "small-model", transitions: [{ to: "done", description: "Test edge to done." }] },
          done: {},
        },
      }),
    );
    const warning = findings.find((f) => f.field === "states.triage.model");
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain("small-model");
    expect(warning?.message).toContain("changes nothing");
  });

  it("says nothing when it names a different id, or when only one position declares one", () => {
    const different = lintSpec(
      specWith({
        settings: { model: "small-model" },
        states: {
          triage: { triggers: { manual: null }, model: "large-model", transitions: [{ to: "done", description: "Test edge to done." }] },
          done: {},
        },
      }),
    );
    expect(different.filter((f) => f.field === "states.triage.model")).toEqual([]);

    const stateOnly = lintSpec(
      specWith({
        states: {
          triage: { triggers: { manual: null }, model: "large-model", transitions: [{ to: "done", description: "Test edge to done." }] },
          done: {},
        },
      }),
    );
    expect(stateOnly.filter((f) => f.field === "states.triage.model")).toEqual([]);
  });
});

/**
 * The mounts lints that need only the document — the table-dependent ones (a
 * name the workspace does not mount, a grant on an ungoverned mount) belong to
 * `validate`, which has the resolved table to check against.
 */
describe("mount governance lints", () => {
  const withMounts = (spec: Partial<MachineSpec>) => lintSpec(specWith(spec));
  const at = (findings: ReturnType<typeof lintSpec>, field: string) =>
    findings.filter((f) => f.field === field);

  it("warns when a workflow-wide denial covers a grant", () => {
    const findings = withMounts({
      mounts: { allow_always: ["reference"], forbid_always: ["reference"] },
    });
    const warning = at(findings, "mounts.forbid_always")[0];
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain("'reference'");
    expect(warning?.message).toContain("reaches nothing");
  });

  it("warns when a state's grant is the one a workflow-wide denial covers", () => {
    const findings = withMounts({
      mounts: { forbid_always: ["reference"] },
      states: {
        triage: {
          triggers: { manual: null },
          mounts: { allow: [{ mount: "reference" }] },
          transitions: [{ to: "done", description: "Test edge to done." }],
        },
        done: {},
      },
    });
    expect(at(findings, "mounts.forbid_always")).toHaveLength(1);
  });

  it("warns that an empty state list subtracts nothing, and names what does", () => {
    const findings = withMounts({
      mounts: { allow_always: ["reference", "catalogs/eu"] },
      states: {
        triage: {
          triggers: { manual: null },
          mounts: { allow: [] },
          transitions: [{ to: "done", description: "Test edge to done." }],
        },
        done: {},
      },
    });
    const warning = at(findings, "states.triage.mounts.allow")[0];
    expect(warning?.message).toContain("reads like a deny");
    expect(warning?.message).toContain("reference, catalogs/eu");
    expect(warning?.message).toContain("mounts: { forbid: [...] }");
  });

  it("warns when a state repeats the workflow's grant unchanged", () => {
    const findings = withMounts({
      mounts: { allow_always: ["reference"] },
      states: {
        triage: {
          triggers: { manual: null },
          mounts: { allow: ["reference"] },
          transitions: [{ to: "done", description: "Test edge to done." }],
        },
        done: {},
      },
    });
    const warning = at(findings, "states.triage.mounts.allow")[0];
    expect(warning?.message).toContain("already");
    expect(warning?.message).toContain("grants nothing");
  });

  /**
   * The one case where naming a mount at both levels is not redundant: the
   * state is taking away the write the workflow gave.
   */
  it("says nothing when the state entry narrows the workflow's access to reads", () => {
    const findings = withMounts({
      mounts: { allow_always: [{ mount: "shared", access: "read_write" }] },
      states: {
        triage: {
          triggers: { manual: null },
          mounts: { allow: [{ mount: "shared", access: "read" }] },
          transitions: [{ to: "done", description: "Test edge to done." }],
        },
        done: {},
      },
    });
    expect(at(findings, "states.triage.mounts.allow")).toEqual([]);
  });

  /** A bare grant asks for no write, so the state's `read_write` is what lets the workflow write there. */
  it("says nothing when the state entry asks to write a mount the workflow grants bare", () => {
    const findings = withMounts({
      mounts: { allow_always: ["shared"] },
      states: {
        triage: {
          triggers: { manual: null },
          mounts: { allow: [{ mount: "shared", access: "read_write" }] },
          transitions: [{ to: "done", description: "Test edge to done." }],
        },
        done: {},
      },
    });
    expect(at(findings, "states.triage.mounts.allow")).toEqual([]);
  });

  it("warns when a state both enables and forbids one mount", () => {
    const findings = withMounts({
      states: {
        triage: {
          triggers: { manual: null },
          mounts: { allow: ["reference"], forbid: ["reference"] },
          transitions: [{ to: "done", description: "Test edge to done." }],
        },
        done: {},
      },
    });
    const warning = at(findings, "states.triage.mounts.allow")[0];
    expect(warning?.message).toContain("both enables and forbids");
  });

  it("reports nothing for a clean mounts block", () => {
    const findings = withMounts({
      mounts: { allow_always: ["reference"], forbid_always: ["catalogs/uk"] },
      states: {
        triage: {
          triggers: { manual: null },
          mounts: { allow: ["catalogs/eu"], forbid: ["reference"] },
          transitions: [{ to: "done", description: "Test edge to done." }],
        },
        done: {},
      },
    });
    expect(findings.filter((f) => (f.field ?? "").includes("mounts"))).toEqual([]);
  });

  it("reports nothing for a spec with no mounts block at all", () => {
    expect(withMounts({}).filter((f) => (f.field ?? "").includes("mounts"))).toEqual([]);
  });
});

describe("an owned variable the host supplies", () => {
  it("warns when a trigger requires a variable a state owns", () => {
    const diagnostics = lintSpec(
      specWith({
        states: {
          triage: {
            triggers: { manual: { requires: ["order_id"] } },
            locks: ["order_id"],
            transitions: [{ to: "done", description: "Test edge to done." }],
          },
          done: {},
        },
      }),
    );
    expect(diagnostics.map((d) => d.message)).toContainEqual(expect.stringContaining("which state 'triage' owns in 'locks'"));
  });
});

/**
 * Keys a state's type never reads, and a grader that could not decide: the
 * runtime tolerates both and `validate` fails, the pattern human states already
 * follow. An automated state (a grader or a code state) is never offered the
 * planning list, the sandbox entry points, parking or resetting, so a grant
 * naming one is an error too.
 */
describe("automated states", () => {
  type StateDecl = MachineSpec["states"][string];
  const lintState = (state: StateDecl) =>
    lintSpec(
      specWith({
        states: {
          triage: { triggers: { manual: null }, instructions: "Route it.", transitions: [{ to: "check", description: "Drafted." }] },
          check: state,
          done: {},
        },
      }),
    );
  const errorsAt = (findings: ReturnType<typeof lintSpec>, field: string) =>
    findings.filter((f) => f.severity === "error" && f.field === field);
  const CODE: StateDecl = {
    type: "code",
    script: "scripts/check.js",
    transitions: [{ to: "done", description: "The check passed." }],
  };
  const GRADER: StateDecl = {
    type: "grader",
    instructions: "Judge the tone.",
    transitions: [{ to: "done", description: "The tone is right." }],
  };

  it("reports nothing for a clean code state and a clean grader", () => {
    expect(lintState(CODE).filter((f) => f.severity === "error")).toEqual([]);
    expect(
      lintState({ ...GRADER, model: "large-model", budget: { timeoutMs: 30_000 } }).filter(
        (f) => f.severity === "error",
      ),
    ).toEqual([]);
  });

  it.each<[string, StateDecl, string]>([
    ["instructions", { instructions: "Check the refund." }, "makes no model call"],
    ["model", { model: "large-model" }, "makes no model call"],
    ["budget", { budget: { timeoutMs: 3000 } }, "settings.timeoutMs"],
    ["evidence", { evidence: ["scratchpad/refund.json"] }, "human state's decision record"],
    ["approvers", { approvers: ["finance"] }, "human state's decision record"],
  ])("errors on a code state declaring '%s'", (key, extra, why) => {
    const [finding, ...rest] = errorsAt(lintState({ ...CODE, ...extra }), `states.check.${key}`);
    expect(rest).toEqual([]);
    expect(finding?.message).toContain(`Code state 'check' declares '${key}', which a code state never reads`);
    expect(finding?.message).toContain(why);
  });

  it.each([
    ["absent", undefined],
    ["blank", "  \n "],
  ])("errors on a grader whose instructions are %s", (_label, instructions) => {
    const [finding] = errorsAt(lintState({ ...GRADER, instructions }), "states.check.instructions");
    expect(finding?.message).toContain("Grader state 'check' must declare 'instructions'");
  });

  it("errors on a grader with no transition, which could only approve by silence", () => {
    const [finding] = errorsAt(lintState({ ...GRADER, transitions: [] }), "states.check.transitions");
    expect(finding?.message).toContain("Grader state 'check' must declare at least one transition");
    expect(finding?.message).toContain("approve by silence");
  });

  it.each<[string, StateDecl]>([
    ["evidence", { evidence: ["scratchpad/reply.md"] }],
    ["approvers", { approvers: ["support-lead"] }],
  ])("errors on a grader declaring '%s'", (key, extra) => {
    const [finding] = errorsAt(lintState({ ...GRADER, ...extra }), `states.check.${key}`);
    expect(finding?.message).toContain(`Grader state 'check' declares '${key}', which a grader never reads`);
  });

  it("errors on a grader's park budget, and only that budget key", () => {
    const findings = lintState({ ...GRADER, budget: { timeoutMs: 30_000, maxParks: 2 } });
    const [finding] = errorsAt(findings, "states.check.budget.maxParks");
    expect(finding?.message).toContain("a grader cannot park");
    expect(findings.filter((f) => f.severity === "error")).toHaveLength(1);
  });

  it.each(["write_todos", "archmax_eval", "archmax_run", "archmax_wait", "archmax_reset"])(
    "errors on an automated state granting '%s', at the entry",
    (tool) => {
      for (const [type, base] of [
        ["code", CODE],
        ["grader", GRADER],
      ] as const) {
        const findings = lintState({ ...base, tools: { allow: ["read_file", { tool }] } });
        const [finding, ...rest] = errorsAt(findings, "states.check.tools.allow.1");
        expect(rest).toEqual([]);
        expect(finding?.message).toContain(`State 'check' is a ${type} state, which is never offered '${tool}'`);
        expect(errorsAt(findings, "states.check.tools.allow.0")).toEqual([]);
      }
    },
  );

  it("leaves an agent state's grant of those tools alone", () => {
    const findings = lintState({
      tools: { allow: ["write_todos", "archmax_eval", { tool: "archmax_run", paths: ["skills/**"] }, "archmax_wait"] },
      transitions: [{ to: "done", description: "Done." }],
    });
    expect(findings.filter((f) => (f.field ?? "").startsWith("states.check.tools.allow") && f.severity === "error")).toEqual(
      [],
    );
  });

  // A routing decision without guidance is an agent's problem: a grader and a
  // human state require instructions already, and a code state's script decides.
  it("warns about several transitions without instructions on an agent state only", () => {
    const twoEdges = [
      { to: "done", description: "Approved." },
      { to: "triage", description: "Send it back." },
    ];
    const warningsAt = (findings: ReturnType<typeof lintSpec>) =>
      findings.filter(
        (f) => f.severity === "warning" && f.field === "states.check.instructions" && /outgoing transitions/.test(f.message),
      );
    expect(warningsAt(lintState({ transitions: twoEdges }))).toHaveLength(1);
    expect(warningsAt(lintState({ ...CODE, transitions: twoEdges }))).toEqual([]);
    expect(warningsAt(lintState({ ...GRADER, instructions: undefined, transitions: twoEdges }))).toEqual([]);
  });
});
