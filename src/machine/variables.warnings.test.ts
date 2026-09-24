import { describe, expect, it } from "vitest";
import {
  buildSeededVariables,
  InvalidVariableNameError,
  unguaranteedReferenceWarnings,
} from "./variables.js";
import { WorkflowMachine } from "./machine.js";
import { guardReferences } from "./allow.js";
import { declaredVariableNames } from "./triggers.js";
import type { MachineSpec } from "./types.js";

function machineWith(states: MachineSpec["states"], extra: Partial<MachineSpec> = {}) {
  return WorkflowMachine.fromSpec({ states, ...extra } as MachineSpec);
}

const guardOn = (glob: string, requires?: string[]) =>
  machineWith({
    work: {
      triggers: { manual: null },
      ...(requires ? { requires } : {}),
      tools: { allow: [{ tool: "send_reply", args: { to: [glob] } }] },
      transitions: [{ to: "done", description: "Test edge to done." }],
    },
    done: {},
  });

describe("buildSeededVariables", () => {
  it("locks every seed", () => {
    expect(buildSeededVariables({ from_email: "a@b.c" })).toEqual({
      from_email: { value: "a@b.c", locked: true },
    });
  });

  it("stores a structured seed whole", () => {
    const value = { region: "eu", items: [{ sku: "A-1" }] };
    expect(buildSeededVariables({ account: value })).toEqual({
      account: { value, locked: true },
    });
  });

  it("seeds the reserved title unlocked, alone among seeds", () => {
    expect(buildSeededVariables({ title: "Inbound refund", from_email: "a@b.c" })).toEqual({
      title: { value: "Inbound refund", locked: false },
      from_email: { value: "a@b.c", locked: true },
    });
  });

  it("is empty when nothing is seeded", () => {
    expect(buildSeededVariables(undefined)).toEqual({});
  });

  it("rejects an invalid variable name", () => {
    expect(() => buildSeededVariables({ "From-Email": "x" })).toThrow(InvalidVariableNameError);
  });
});

describe("unguaranteedReferenceWarnings", () => {
  it("says nothing when a seed supplies the reference", () => {
    const warnings = unguaranteedReferenceWarnings(
      guardOn("${{from_email}}"),
      buildSeededVariables({ from_email: "a@b.c" }),
    );
    expect(warnings).toEqual([]);
  });

  it("says nothing when a state requires the reference", () => {
    expect(unguaranteedReferenceWarnings(guardOn("${{case_id}}", ["case_id"]), {})).toEqual([]);
  });

  it("says nothing for the built-in trigger", () => {
    expect(unguaranteedReferenceWarnings(guardOn("${{trigger}}"), {})).toEqual([]);
  });

  // `title` is reserved but *not* guaranteed: the agent writes it, so a guard
  // binding to it genuinely rests on the agent's behaviour and the author is told.
  it("still warns for the built-in title, which the harness never sets", () => {
    const [warning, ...rest] = unguaranteedReferenceWarnings(guardOn("${{title}}"), {});
    expect(rest).toEqual([]);
    expect(warning).toContain("title");
  });

  it("says nothing once a state requires the title", () => {
    expect(unguaranteedReferenceWarnings(guardOn("${{title}}", ["title"]), {})).toEqual([]);
  });

  it("warns when nothing guarantees the reference", () => {
    const [warning, ...rest] = unguaranteedReferenceWarnings(guardOn("${{case_id}}"), {});
    expect(rest).toEqual([]);
    expect(warning).toContain("case_id");
    expect(warning).toContain("send_reply");
    expect(warning).toContain("requires");
  });

  it("explains that the guard then rests on the agent", () => {
    const [warning] = unguaranteedReferenceWarnings(guardOn("${{case_id}}"), {});
    expect(warning).toContain("archmax_set_variables");
  });

  it("adds the every-state note for an allow_always reference", () => {
    const machine = machineWith(
      { work: { triggers: { manual: null }, transitions: [{ to: "done", description: "Test edge to done." }] }, done: {} },
      { tools: { allow_always: [{ tool: "send_reply", args: { to: ["${{case_id}}"] } }] } },
    );
    const [warning] = unguaranteedReferenceWarnings(machine, {});
    expect(warning).toContain("every state");
  });

  it("reports each distinct reference once", () => {
    const machine = machineWith({
      work: {
        triggers: { manual: null },
        tools: {
          allow: [
            { tool: "send_reply", args: { to: ["${{a}}"] } },
            { tool: "write_file", args: { file_path: ["output/${{b}}/**"] } },
          ],
        },
        transitions: [{ to: "done", description: "Test edge to done." }],
      },
      done: {},
    });
    expect(unguaranteedReferenceWarnings(machine, {})).toHaveLength(2);
  });
});

describe("machine variable accessors", () => {
  it("reads a state's requires", () => {
    expect(guardOn("${{a}}", ["a", "b"]).requiredVariables("work")).toEqual(["a", "b"]);
  });

  it("reads an empty requires when absent", () => {
    expect(guardOn("${{a}}").requiredVariables("work")).toEqual([]);
  });

  it("collects every required name across states", () => {
    const machine = machineWith({
      a: { triggers: { manual: null }, requires: ["x"], transitions: [{ to: "b", description: "Test edge to b." }] },
      b: { requires: ["y"] },
    });
    expect([...declaredVariableNames(machine.spec)].sort()).toEqual(["x", "y"]);
  });

  it("finds references in state and allow_always entries", () => {
    const machine = machineWith(
      {
        work: {
          triggers: { manual: null },
          tools: { allow: [{ tool: "send_reply", args: { to: ["${{a}}"] } }] },
          transitions: [{ to: "done", description: "Test edge to done." }],
        },
        done: {},
      },
      { tools: { allow_always: [{ tool: "x", args: { y: ["${{b}}"] } }] } },
    );
    const refs = guardReferences(machine.spec);
    expect(refs.map((r) => r.reference.name).sort()).toEqual(["a", "b"]);
    // `allow_always` binds in every state, so it carries no single state slug.
    expect(refs.find((r) => r.reference.name === "b")?.state).toBeNull();
    expect(refs.find((r) => r.reference.name === "a")?.state).toBe("work");
  });
});

describe("tool disclosure", () => {
  it("discloses both variable tools by default", () => {
    const disclosed = machineWith({ a: { triggers: { manual: null } } }).disclosedTools("a");
    expect(disclosed.has("archmax_get_variables")).toBe(true);
    expect(disclosed.has("archmax_set_variables")).toBe(true);
  });

  it("discloses them in a state with a narrowing allow list", () => {
    const disclosed = guardOn("${{a}}").disclosedTools("work");
    expect(disclosed.has("archmax_get_variables")).toBe(true);
    expect(disclosed.has("archmax_set_variables")).toBe(true);
  });

  it("discloses them in a terminal state, where archmax_advance is withheld", () => {
    const machine = machineWith({ a: { triggers: { manual: null } } });
    const disclosed = machine.disclosedTools("a");
    expect(disclosed.has("archmax_advance")).toBe(false);
    expect(disclosed.has("archmax_get_variables")).toBe(true);
  });

  it("still lets tools.forbid_always withhold one", () => {
    const machine = WorkflowMachine.fromSpec({
      states: { a: { triggers: { manual: null } } },
      tools: { forbid_always: ["archmax_set_variables"] },
    } as MachineSpec);
    const disclosed = machine.disclosedTools("a");
    expect(disclosed.has("archmax_set_variables")).toBe(false);
    expect(disclosed.has("archmax_get_variables")).toBe(true);
  });
});

describe("argument-constraint disclosure", () => {
  it("renders the resolved value, not the placeholder", () => {
    const lines = guardOn("${{from_email}}").describeArgConstraints("work", {
      from_email: { value: "a@b.c", locked: true },
    });
    expect(lines.join("\n")).toContain("a@b.c");
    expect(lines.join("\n")).not.toContain("${{from_email}}");
  });

  it("renders a path reference resolved", () => {
    const lines = guardOn("${{sender.email}}").describeArgConstraints("work", {
      sender: { value: { email: "a@b.c" }, locked: true },
    });
    expect(lines.join("\n")).toContain("a@b.c");
  });

  it("marks an unresolved reference rather than showing a bare placeholder", () => {
    const rendered = guardOn("${{from_email}}").describeArgConstraints("work", {}).join("\n");
    expect(rendered).toContain("unresolved");
    expect(rendered).toContain("from_email");
  });

  it("leaves a constraint without references unchanged", () => {
    expect(guardOn("a@b.c").describeArgConstraints("work", {})).toEqual([
      "- send_reply: to must match 'a@b.c'",
    ]);
  });
});
