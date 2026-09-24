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
