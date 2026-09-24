import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { Workspace } from "../core/workspace.js";
import { loadMachineSpec } from "./load-spec.js";
import { validateSpec } from "./validate-spec.js";

const GOOD = `
instructions: Be brief.
states:
  start:
    triggers: { manual: }
    transitions:
      - to: done
        description: Finish.
  done: {}
`;

describe("validateSpec", () => {
  it("accepts a valid document and returns the typed spec", () => {
    const out = validateSpec(parseYaml(GOOD));
    expect(out.ok).toBe(true);
    expect(out.spec?.states.done).toBeDefined();
    expect(out.schema).toEqual([]);
    expect(out.diagnostics).toEqual(out.lint);
  });

  it("reports a misspelled state key as an error at the key's path, not as one refusal", () => {
    const out = validateSpec(parseYaml(GOOD.replace("  done: {}", "  done: { modle: gpt }")));
    expect(out.ok).toBe(false);
    expect(out.spec).toBeUndefined();
    expect(out.schema).toHaveLength(1);
    expect(out.schema[0]).toMatchObject({ severity: "error", field: "states.done" });
    expect(out.schema[0]?.message).toMatch(/modle/);
  });

  it("reports a blank transition description where an editor can show it", () => {
    const out = validateSpec(parseYaml(GOOD.replace("description: Finish.", 'description: "  "')));
    expect(out.ok).toBe(false);
    expect(out.schema.map((d) => d.field)).toEqual(["states.start.transitions.0.description"]);
  });

  it("keeps the typed spec beside a document-level error so the lint still runs", () => {
    const out = validateSpec(
      parseYaml(GOOD.replace("to: done", "to: nowhere").replace("instructions: Be brief.\n", "")),
    );
    expect(out.ok).toBe(false);
    expect(out.spec).toBeDefined();
    expect(out.schema.map((d) => d.field)).toEqual(["states.start.transitions.0.to"]);
    // The lint ran over the typed spec: the missing top-level instructions are reported.
    expect(out.lint.map((d) => d.field)).toContain("instructions");
    expect(out.diagnostics).toEqual([...out.schema, ...out.lint]);
  });

  it("is total: a non-mapping yields issues, never a throw", () => {
    expect(validateSpec(null).ok).toBe(false);
    expect(validateSpec("nope").ok).toBe(false);
    expect(validateSpec([]).schema.length).toBeGreaterThan(0);
  });

  /**
   * The loader reports exactly these findings, so an editor showing
   * `validateSpec` inline and `archmax validate` cannot disagree about a document.
   */
  it("reports what loadMachineSpec reports, field for field", async () => {
    const yaml = GOOD.replace("to: done", "to: nowhere").replace("  done: {}", "  done: { modle: 1 }");
    const workspace = {
      readText: async (path: string) => (path.endsWith("workflow.yaml") ? yaml : null),
    } as unknown as Workspace;
    const loaded = await loadMachineSpec(workspace, {
      workflowYaml: "workflows/w/workflow.yaml",
      workflow: "workflows/w/WORKFLOW.md",
    });
    const pure = validateSpec(parseYaml(yaml));
    const loaderFindings = [...loaded.issues, ...loaded.lint].map((i) => ({ field: i.field, severity: i.severity, tail: i.message }));
    expect(loaderFindings.map((f) => f.field)).toEqual(pure.diagnostics.map((d) => d.field));
    for (const [i, finding] of loaderFindings.entries()) {
      expect(finding.severity).toBe(pure.diagnostics[i]!.severity);
      expect(finding.tail.endsWith(pure.diagnostics[i]!.message)).toBe(true);
    }
    expect(loaded.usable).toBe(pure.ok);
  });
});
