import { describe, expect, it } from "vitest";
import { decide } from "./kernel.js";
import { resolveArguments } from "../machine/variables.js";
import { WorkflowMachine } from "../machine/machine.js";
import type { MachineSpec } from "../machine/types.js";
import type { VariableStore } from "../machine/variables.js";

const entry = (value: unknown, locked = false) => ({ value, locked });

function machineWith(spec: Partial<MachineSpec>): WorkflowMachine {
  return WorkflowMachine.fromSpec({
    states: {
      work: { triggers: { manual: null }, transitions: [{ to: "done", description: "Test edge to done." }] },
      done: {},
    },
    ...spec,
  } as MachineSpec);
}

/** A machine whose `work` state guards `send_reply`'s `to` argument. */
function guarded(glob: string, extra: Partial<MachineSpec> = {}): WorkflowMachine {
  return machineWith({
    states: {
      work: {
        triggers: { manual: null },
        transitions: [{ to: "done", description: "Test edge to done." }],
        tools: { allow: [{ tool: "send_reply", args: { to: [glob] } }] },
      },
      done: {},
    },
    ...extra,
  });
}

const call = (machine: WorkflowMachine, args: Record<string, unknown>, variables: VariableStore) =>
  decide(
    machine,
    { kind: "tool-call", state: "work", tool: "send_reply", args },
    [],
    undefined,
    variables,
  );

describe("guard substitution", () => {
  it("permits the resolved value", () => {
    const verdict = call(guarded("${{from_email}}"), { to: "a@b.c" }, { from_email: entry("a@b.c") });
    expect(verdict.decision).toBe("allow");
  });

  it("blocks a different value", () => {
    const verdict = call(guarded("${{from_email}}"), { to: "x@y.z" }, { from_email: entry("a@b.c") });
    expect(verdict.decision).toBe("block");
    // An ordinary mismatch stays recoverable — the agent can pass another value.
    expect(verdict.terminal).toBeFalsy();
  });

  it("resolves a dotted path into a structured value", () => {
    const vars = { sender: entry({ email: "a@b.c" }) };
    expect(call(guarded("${{sender.email}}"), { to: "a@b.c" }, vars).decision).toBe("allow");
    expect(call(guarded("${{sender.email}}"), { to: "other" }, vars).decision).toBe("block");
  });

  it("resolves an array index, including from the end", () => {
    const vars = { o: entry({ to: ["first@x", "last@x"] }) };
    expect(call(guarded("${{o.to.0}}"), { to: "first@x" }, vars).decision).toBe("allow");
    expect(call(guarded("${{o.to.-1}}"), { to: "last@x" }, vars).decision).toBe("allow");
    expect(call(guarded("${{o.to.-1}}"), { to: "first@x" }, vars).decision).toBe("block");
  });

  it("keeps the surrounding glob's wildcards", () => {
    const machine = machineWith({
      states: {
        work: {
          triggers: { manual: null },
          transitions: [{ to: "done", description: "Test edge to done." }],
          tools: { allow: [{ tool: "write_file", args: { file_path: ["output/${{case_id}}/**"] } }] },
        },
        done: {},
      },
    });
    const vars = { case_id: entry("K-9") };
    const write = (path: string) =>
      decide(
        machine,
        { kind: "tool-call", state: "work", tool: "write_file", args: { file_path: path } },
        [],
        undefined,
        vars,
      );
    expect(write("output/K-9/report.md").decision).toBe("allow");
    expect(write("output/K-1/report.md").decision).toBe("block");
  });

  it("does not let a metacharacter value widen the guard", () => {
    const vars = { from_email: entry("*") };
    expect(call(guarded("${{from_email}}"), { to: "*" }, vars).decision).toBe("allow");
    expect(call(guarded("${{from_email}}"), { to: "anything" }, vars).decision).toBe("block");
  });
});

describe("unresolvable references fail the run", () => {
  const terminalCases: Array<[string, string, VariableStore]> = [
    ["an unset variable", "${{from_email}}", {}],
    ["a missing path", "${{sender.nope}}", { sender: entry({ email: "a" }) }],
    ["a non-scalar result", "${{sender}}", { sender: entry({ email: "a" }) }],
    ["an out-of-range index", "${{o.list.5}}", { o: entry({ list: ["a"] }) }],
    ["a prototype-reaching path", "${{list.length}}", { list: entry(["a", "b"]) }],
  ];

  for (const [label, glob, vars] of terminalCases) {
    it(`is terminal for ${label}`, () => {
      const verdict = call(guarded(glob), { to: "anything" }, vars);
      expect(verdict.decision).toBe("block");
      expect(verdict.terminal).toBe(true);
      expect(verdict.ruleId).toBe("tool.unresolved-variable");
    });
  }

  it("names the reference and the cause", () => {
    const verdict = call(guarded("${{from_email}}"), { to: "x" }, {});
    expect(verdict.reason).toContain("${{from_email}}");
    expect(verdict.reason).toContain("not set");
  });

  it("never matches the literal placeholder", () => {
    const verdict = call(guarded("${{from_email}}"), { to: "${{from_email}}" }, {});
    expect(verdict.decision).toBe("block");
  });

  it("fails closed when no snapshot is supplied at all", () => {
    const verdict = decide(guarded("${{from_email}}"), {
      kind: "tool-call",
      state: "work",
      tool: "send_reply",
      args: { to: "a@b.c" },
    });
    expect(verdict.decision).toBe("block");
    expect(verdict.terminal).toBe(true);
  });

  it("leaves a guard without references unaffected", () => {
    const verdict = call(guarded("a@b.c"), { to: "a@b.c" }, {});
    expect(verdict.decision).toBe("allow");
  });
});

describe("requires gate", () => {
  const machine = machineWith({
    states: {
      work: { triggers: { manual: null }, requires: ["case_id"], transitions: [{ to: "done", description: "Test edge to done." }] },
      done: {},
    },
  });
  const transition = (variables: VariableStore) =>
    decide(machine, { kind: "transition", from: "work", to: "done" }, [], undefined, variables);

  it("blocks the exit while a required variable is unset", () => {
    const verdict = transition({});
    expect(verdict.decision).toBe("block");
    expect(verdict.ruleId).toBe("transition.requires");
    expect(verdict.reason).toContain("case_id");
  });

  it("is recoverable, not terminal", () => {
    expect(transition({}).terminal).toBeFalsy();
  });

  it("permits the exit once set", () => {
    expect(transition({ case_id: entry("K-9") }).decision).toBe("allow");
  });

  it("counts a locked host seed as set", () => {
    expect(transition({ case_id: entry("K-9", true) }).decision).toBe("allow");
  });

  it("runs before the edge check", () => {
    // An undeclared target would block on its own; the gate must win first, so
    // the reason names the variable the state still owes rather than the edge.
    const verdict = decide(
      machine,
      { kind: "transition", from: "work", to: "nowhere" },
      [],
      undefined,
      {},
    );
    expect(verdict.ruleId).toBe("transition.requires");
    expect(verdict.reason).not.toContain("Valid target slugs");
  });
});

describe("variable tools in governance", () => {
  it("permits both tools in a state whose allow list omits them", () => {
    const machine = machineWith({
      states: {
        work: {
          triggers: { manual: null },
          transitions: [{ to: "done", description: "Test edge to done." }],
          tools: { allow: [{ tool: "send_reply" }] },
        },
        done: {},
      },
    });
    for (const tool of ["archmax_get_variables", "archmax_set_variables"]) {
      expect(decide(machine, { kind: "tool-call", state: "work", tool, args: {} }).decision).toBe(
        "allow",
      );
    }
  });

  it("still lets a workflow denial forbid them outright", () => {
    const machine = machineWith({ tools: { forbid_always: [{ tool: "archmax_set_variables" }] } });
    const verdict = decide(machine, {
      kind: "tool-call",
      state: "work",
      tool: "archmax_set_variables",
      args: {},
    });
    expect(verdict.decision).toBe("block");
    expect(verdict.ruleId).toBe("tool.forbidden");
  });
});

describe("a resolved agent argument enters matching as a literal", () => {
  // The boundary substitutes the agent's argument and then the kernel matches
  // it. These pin the composition: whatever a variable holds arrives as data,
  // never as pattern syntax, so interpolation cannot widen the guard it meets.
  const call = (glob: string, raw: string, values: Record<string, unknown>) => {
    const variables: VariableStore = Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, entry(v)]),
    );
    const resolved = resolveArguments({ to: raw }, variables);
    if (!resolved.ok) throw new Error(`unexpected unresolved: ${resolved.detail}`);
    return decide(
      guarded(glob),
      { kind: "tool-call", state: "work", tool: "send_reply", args: resolved.args },
      undefined,
      undefined,
      variables,
    );
  };

  it("permits a reference that resolves to the guarded value", () => {
    expect(call("a@b.c", "${{from_email}}", { from_email: "a@b.c" }).decision).toBe("allow");
  });

  it("permits an interpolated value on both sides of the same variable", () => {
    expect(
      call("${{from_email}}", "${{from_email}}", { from_email: "a@b.c" }).decision,
    ).toBe("allow");
  });

  it("does not let a wildcard value widen the guard", () => {
    expect(call("a@b.c", "${{v}}", { v: "*" }).decision).toBe("block");
  });

  it("does not let a brace-expansion value widen the guard", () => {
    expect(call("a@b.c", "${{v}}", { v: "{a@b.c,evil@x.y}" }).decision).toBe("block");
  });

  it("matches an interpolated value containing glob metacharacters literally", () => {
    expect(call("a+tag@b.co", "${{v}}", { v: "a+tag@b.co" }).decision).toBe("allow");
  });
});

/**
 * A variable substituted as whole segments of a path guard must name a path.
 * An empty value turned `${{dir}}/**` into `**`, and `.`, `/` and `//` did the
 * same after canonicalization, so the guard admitted every path.
 */
describe("guard substitution: a path guard on a value naming no path", () => {
  const pathGuarded = (glob: string, side: "allow" | "forbid" = "allow") =>
    machineWith({
      states: {
        work: {
          triggers: { manual: null },
          transitions: [{ to: "done", description: "Test edge to done." }],
          tools:
            side === "allow"
              ? { allow: [{ tool: "write_file", paths: [glob] }, { tool: "copy_file", paths: [glob] }] }
              : { allow: ["write_file"], forbid: [{ tool: "write_file", paths: [glob] }] },
        },
        done: {},
      },
    });
  const write = (machine: WorkflowMachine, file_path: string, variables: VariableStore) =>
    decide(machine, { kind: "tool-call", state: "work", tool: "write_file", args: { file_path, content: "x" } }, [], undefined, variables);
  const copy = (machine: WorkflowMachine, source: string, variables: VariableStore) =>
    decide(
      machine,
      { kind: "tool-call", state: "work", tool: "copy_file", args: { source, destination: "reports/out.md" } },
      [],
      undefined,
      variables,
    );

  it("grants nothing, locked or not, and stops the run with the reason", () => {
    const machine = pathGuarded("${{dir}}/**");
    for (const value of ["", "/", ".", "//", "./"]) {
      for (const locked of [false, true]) {
        const vars = { dir: entry(value, locked) };
        for (const path of ["other/secret.md", "reports/a.md"]) {
          const v = write(machine, path, vars);
          expect(v.decision, `${JSON.stringify(value)} ${path}`).toBe("block");
          expect(v.ruleId).toBe("tool.unresolved-variable");
          expect(copy(machine, path, vars).decision, `copy ${JSON.stringify(value)} ${path}`).toBe("block");
        }
        expect(write(machine, "other/secret.md", vars).reason).toMatch(/empty path or the workspace root/);
      }
    }
  });

  it("still admits a real directory and only that", () => {
    const machine = pathGuarded("${{dir}}/**");
    const vars = { dir: entry("reports") };
    expect(write(machine, "reports/a.md", vars).decision).toBe("allow");
    expect(write(machine, "other/secret.md", vars).decision).toBe("block");
    expect(copy(machine, "reports/a.md", vars).decision).toBe("allow");
    expect(copy(machine, "other/secret.md", vars).decision).toBe("block");
  });

  it("covers a reference in the middle of the guard and one into a structured value", () => {
    expect(write(pathGuarded("out/${{dir}}/**"), "out/x/a.md", { dir: entry("") }).ruleId).toBe("tool.unresolved-variable");
    expect(write(pathGuarded("${{cfg.dir}}/**"), "other/a.md", { cfg: entry({ dir: "." }) }).ruleId).toBe(
      "tool.unresolved-variable",
    );
  });

  it("leaves a reference inside a segment alone: an empty name there widens nothing", () => {
    const v = write(pathGuarded("reports/${{name}}.md"), "reports/a.md", { name: entry("") });
    expect(v.ruleId).toBe("tool.not-allowed");
    expect(v.terminal).toBeFalsy();
  });

  it("makes a denial match, so it fails closed", () => {
    const machine = pathGuarded("${{dir}}/**", "forbid");
    expect(write(machine, "anything/a.md", { dir: entry("") }).ruleId).toBe("tool.forbidden-here");
    expect(write(machine, "anything/a.md", { dir: entry("secret") }).decision).toBe("allow");
  });

  it("does not touch a text guard, where an empty value is an ordinary value", () => {
    expect(call(guarded("${{from_email}}"), { to: "" }, { from_email: entry("") }).decision).toBe("allow");
  });
});
