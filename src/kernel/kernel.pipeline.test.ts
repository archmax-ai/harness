import { describe, expect, it } from "vitest";
import { WorkflowMachine } from "../machine/machine.js";
import type { MountPrefixes } from "../core/mounts.js";
import type { MachineSpec } from "../machine/types.js";
import { compileForbidRules, decide, type GovernanceRule } from "./kernel.js";

function machineOf(spec: MachineSpec): WorkflowMachine {
  return WorkflowMachine.fromSpec(spec);
}

const OPEN_SPEC: MachineSpec = {
  states: { work: { transitions: [{ to: "done", description: "Test edge to done." }] }, done: {} },
};

/** The authored zone this suite's workspace resolves to. */
const MOUNTS: MountPrefixes = { dirs: ["skills", "workflows", "data"], files: ["AGENTS.md"], writable: [], governed: [], unsearchable: [] };

describe("governance rule pipeline", () => {
  it("lets a custom rule block a call the state would otherwise permit", () => {
    const machine = machineOf(OPEN_SPEC);
    const blockWebFetch: GovernanceRule = (action) =>
      action.kind === "tool-call" && action.tool === "web_fetch"
        ? { decision: "block", ruleId: "custom.web", reason: "domain not allowed" }
        : null;
    const verdict = decide(
      machine,
      { kind: "tool-call", state: "work", tool: "web_fetch", args: {} },
      [blockWebFetch],
    );
    expect(verdict.decision).toBe("block");
    expect(verdict.ruleId).toBe("custom.web");
  });

  it("does not let a custom rule bypass a safety rule (read-only zone)", () => {
    const machine = machineOf(OPEN_SPEC);
    const allowEverything: GovernanceRule = () => ({ decision: "allow", ruleId: "custom.allow" });
    const verdict = decide(
      machine,
      { kind: "tool-call", state: "work", tool: "write_file", args: { file_path: "skills/x.md" } },
      [allowEverything],
      MOUNTS,
    );
    expect(verdict.decision).toBe("block");
    expect(verdict.ruleId).toBe("zone.read-only");
  });

  it("does not let a custom rule bypass the inline-eval safety rule", () => {
    const machine = machineOf(OPEN_SPEC);
    const allowEverything: GovernanceRule = () => ({ decision: "allow", ruleId: "custom.allow" });
    const verdict = decide(
      machine,
      { kind: "tool-call", state: "work", tool: "eval", args: {} },
      [allowEverything],
    );
    expect(verdict.ruleId).toBe("tool.eval");
  });
});

describe("compileForbidRules", () => {
  it("returns no rules when nothing is denied", () => {
    expect(compileForbidRules(undefined, { scope: "workflow" })).toEqual([]);
    expect(compileForbidRules([], { scope: "workflow" })).toEqual([]);
  });

  it("blocks a forbidden tool in every state regardless of per-state allow", () => {
    const machine = machineOf({
      tools: { forbid_always: [{ tool: "execute" }] },
      states: {
        work: { triggers: { manual: null }, tools: { allow: [{ tool: "execute" }] }, transitions: [{ to: "done", description: "Test edge to done." }] },
        done: {},
      },
    });
    const verdict = decide(machine, { kind: "tool-call", state: "work", tool: "execute", args: {} });
    expect(verdict.decision).toBe("block");
    expect(verdict.ruleId).toBe("tool.forbidden");
  });

  it("blocks a write to a forbidden path in every state", () => {
    const machine = machineOf({
      tools: { forbid_always: [{ tool: "write_file", paths: ["logs/**"] }] },
      states: { work: { transitions: [{ to: "done", description: "Test edge to done." }] }, done: {} },
    });
    const verdict = decide(machine, {
      kind: "tool-call",
      state: "work",
      tool: "write_file",
      args: { file_path: "logs/audit.txt" },
    });
    expect(verdict.decision).toBe("block");
    expect(verdict.ruleId).toBe("tool.forbidden");
  });

  it("denies every tool on a path when the entry names the tool '*'", () => {
    const machine = machineOf({
      tools: { forbid_always: [{ tool: "*", paths: ["secrets/**"] }] },
      states: { work: { tools: { allow: [{ tool: "read_file" }] }, transitions: [{ to: "done", description: "Test edge to done." }] }, done: {} },
    });
    for (const tool of ["read_file", "write_file", "ls"]) {
      const verdict = decide(machine, {
        kind: "tool-call",
        state: "work",
        tool,
        // A dot-prefixed segment is covered, as every governance glob is.
        args: { file_path: "secrets/.env" },
      });
      expect(verdict.decision).toBe("block");
      expect(verdict.ruleId).toBe("tool.forbidden");
    }
  });

  it("scopes a state's forbid to that state, beating its own allow", () => {
    const machine = machineOf({
      tools: { allow_always: [{ tool: "write_file" }] },
      states: {
        route: {
          triggers: { manual: null },
          tools: { allow: [{ tool: "write_file" }], forbid: [{ tool: "write_file" }] },
          transitions: [{ to: "work", description: "Test edge to work." }],
        },
        work: { transitions: [{ to: "done", description: "Test edge to done." }] },
        done: {},
      },
    });
    const here = decide(machine, {
      kind: "tool-call",
      state: "route",
      tool: "write_file",
      args: { file_path: "scratchpad/x.txt" },
    });
    expect(here.decision).toBe("block");
    expect(here.ruleId).toBe("tool.forbidden-here");
    // The next state keeps the workflow's grant: a state's denial is its own.
    expect(
      decide(machine, {
        kind: "tool-call",
        state: "work",
        tool: "write_file",
        args: { file_path: "scratchpad/x.txt" },
      }).decision,
    ).toBe("allow");
  });

  it("denies only the calls a guarded entry matches", () => {
    const machine = machineOf({
      tools: { allow_always: [{ tool: "write_file" }], forbid_always: [{ tool: "write_file", paths: ["logs/**"] }] },
      states: { work: { transitions: [{ to: "done", description: "Test edge to done." }] }, done: {} },
    });
    expect(
      decide(machine, { kind: "tool-call", state: "work", tool: "write_file", args: { file_path: "logs/a.txt" } })
        .ruleId,
    ).toBe("tool.forbidden");
    expect(
      decide(machine, {
        kind: "tool-call",
        state: "work",
        tool: "write_file",
        args: { file_path: "scratchpad/a.txt" },
      }).decision,
    ).toBe("allow");
  });

  it("leaves non-matching calls to the per-state defaults", () => {
    const machine = machineOf({
      tools: { forbid_always: [{ tool: "write_file", paths: ["logs/**"] }] },
      states: { work: { transitions: [{ to: "done", description: "Test edge to done." }] }, done: {} },
    });
    // open state, path not forbidden → allowed
    const verdict = decide(machine, {
      kind: "tool-call",
      state: "work",
      tool: "write_file",
      args: { file_path: "output/ok.txt" },
    });
    expect(verdict.decision).toBe("allow");
  });
});

describe("tool-call origin", () => {
  const GATED_SPEC: MachineSpec = {
    states: {
      work: { triggers: { manual: null }, tools: { allow: [{ tool: "read_file" }] }, transitions: [{ to: "done", description: "Test edge to done." }] },
      done: {},
    },
  };

  it("governs a script call exactly like the same agent call", () => {
    const machine = machineOf(GATED_SPEC);
    const args = { file_path: "data/orders.json" };
    const agent = decide(
      machine,
      { kind: "tool-call", state: "work", tool: "write_file", args },
      [],
      MOUNTS,
    );
    const script = decide(
      machine,
      { kind: "tool-call", state: "work", tool: "write_file", args, origin: "script" },
      [],
      MOUNTS,
    );
    expect(script).toEqual(agent);
    expect(script.decision).toBe("block");
  });

  it("skips the per-state allow list for a lifecycle call", () => {
    const machine = machineOf(GATED_SPEC);
    // `web_fetch` is outside the state's allow list and not an essential
    // built-in: refused for the agent, permitted for a hook running on
    // harness authority.
    const args = { url: "https://example.test" };
    expect(
      decide(machine, { kind: "tool-call", state: "work", tool: "web_fetch", args }).decision,
    ).toBe("block");
    const lifecycle = decide(machine, {
      kind: "tool-call",
      state: "work",
      tool: "web_fetch",
      args,
      origin: "lifecycle",
    });
    expect(lifecycle.decision).toBe("allow");
  });

  it("skips a state's argument constraints for a lifecycle call", () => {
    const machine = machineOf({
      states: {
        work: { triggers: { manual: null }, tools: { allow: [{ tool: "write_file", args: { file_path: ["output/a.md"] } }] } },
      },
    });
    const args = { file_path: "output/b.md" };
    expect(
      decide(machine, { kind: "tool-call", state: "work", tool: "write_file", args }).ruleId,
    ).toBe("tool.not-allowed");
    expect(
      decide(machine, { kind: "tool-call", state: "work", tool: "write_file", args, origin: "lifecycle" })
        .decision,
    ).toBe("allow");
  });

  it("still binds a lifecycle call to the non-overridable safety rules", () => {
    const machine = machineOf(GATED_SPEC);
    const verdict = decide(
      machine,
      {
        kind: "tool-call",
        state: "work",
        tool: "write_file",
        args: { file_path: "skills/x.md" },
        origin: "lifecycle",
      },
      [],
      MOUNTS,
    );
    expect(verdict.decision).toBe("block");
    expect(verdict.ruleId).toBe("zone.read-only");
  });

  it("still binds a lifecycle call to the workflow's own denials", () => {
    const machine = machineOf({
      tools: {
        forbid_always: [{ tool: "web_fetch" }, { tool: "write_file", paths: ["logs/**"] }],
      },
      states: { work: { triggers: { manual: null }, tools: { allow: [{ tool: "read_file" }] } } },
    });
    const forbiddenTool = decide(machine, {
      kind: "tool-call",
      state: "work",
      tool: "web_fetch",
      args: {},
      origin: "lifecycle",
    });
    expect(forbiddenTool.ruleId).toBe("tool.forbidden");
    const forbiddenPath = decide(machine, {
      kind: "tool-call",
      state: "work",
      tool: "write_file",
      args: { file_path: "logs/audit.txt" },
      origin: "lifecycle",
    });
    expect(forbiddenPath.ruleId).toBe("tool.forbidden");
  });

  it("still binds a lifecycle call to consumer rules", () => {
    const machine = machineOf(GATED_SPEC);
    const blockLs: GovernanceRule = (action) =>
      action.kind === "tool-call" && action.tool === "ls"
        ? { decision: "block", ruleId: "custom.ls", reason: "no listing" }
        : null;
    const verdict = decide(
      machine,
      { kind: "tool-call", state: "work", tool: "ls", args: {}, origin: "lifecycle" },
      [blockLs],
    );
    expect(verdict.ruleId).toBe("custom.ls");
  });

  it("exposes the origin to consumer rules", () => {
    const machine = machineOf(OPEN_SPEC);
    const seen: (string | undefined)[] = [];
    const record: GovernanceRule = (action) => {
      if (action.kind === "tool-call") seen.push(action.origin);
      return null;
    };
    for (const origin of [undefined, "script", "lifecycle"] as const) {
      decide(
        machine,
        {
          kind: "tool-call",
          state: "work",
          tool: "read_file",
          args: {},
          ...(origin ? { origin } : {}),
        },
        [record],
      );
    }
    expect(seen).toEqual([undefined, "script", "lifecycle"]);
  });
});

describe("skill rule precedence", () => {
  const SKILLS = [
    { slug: "order-data", prefix: "skills/order-data" },
    { slug: "order-enrichment", prefix: "skills/order-enrichment" },
  ];
  /** One state enabling one of the two skills, with a deliberately wide grant. */
  const SPEC: MachineSpec = {
    skills: { allow_always: [] },
    tools: { allow_always: [{ tool: "read_file", args: { file_path: ["skills/**"] } }] },
    states: {
      work: {
        skills: { allow: ["order-data"] },
        tools: { allow: [{ tool: "archmax_run", args: { file_path: ["skills/**"] } }] },
      },
    },
  };
  const disabled = "skills/order-enrichment/scripts/enrich.js";

  const verdict = (tool: string, path: string, rules: GovernanceRule[] = []) =>
    decide(
      machineOf(SPEC),
      { kind: "tool-call", state: "work", tool, args: { file_path: path } },
      rules,
      MOUNTS,
      {},
      SKILLS,
    );

  it("is not widened by a state's own wildcard path entry", () => {
    const v = verdict("archmax_run", disabled);
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("skill.not-allowed");
  });

  it("is not widened by a workflow-level allow_always grant", () => {
    const v = verdict("read_file", "skills/order-enrichment/SKILL.md");
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("skill.not-allowed");
  });

  it("is not widened by a consumer rule that allows everything", () => {
    const allowEverything: GovernanceRule = () => ({ decision: "allow", ruleId: "custom.allow" });
    const v = verdict("read_file", "skills/order-enrichment/SKILL.md", [allowEverything]);
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("skill.not-allowed");
  });

  it("still lets a state entry narrow within the enabled set", () => {
    // `archmax_run` is narrowed to `skills/**`, so an enabled bundle's script runs…
    expect(verdict("archmax_run", "skills/order-data/scripts/lookup.js").decision).toBe("allow");
    // …and a scratch script does not, despite `archmax_run` being essential. The
    // state's entry would refuse it anyway, but `script.skill-only` gets there
    // first and says the more useful thing: not "this state disallows it" but
    // "a script outside a skill bundle is never runnable".
    const v = verdict("archmax_run", "scratchpad/x.js");
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("script.skill-only");
  });

  it("is still bound by a workflow denial of the tool", () => {
    const machine = machineOf({ ...SPEC, tools: { ...SPEC.tools, forbid_always: [{ tool: "read_file" }] } });
    const v = decide(
      machine,
      {
        kind: "tool-call",
        state: "work",
        tool: "read_file",
        args: { file_path: "skills/order-data/SKILL.md" },
      },
      [],
      MOUNTS,
      {},
      SKILLS,
    );
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("tool.forbidden");
  });
});

describe("mount rule precedence", () => {
  /** `catalogs/eu` is governed; `data` is not. */
  const GOVERNING: MountPrefixes = {
    dirs: ["skills", "workflows", "data", "catalogs/eu"],
    files: ["AGENTS.md"],
    writable: [],
    governed: ["catalogs/eu"],
    unsearchable: [],
  };
  /** A state with a deliberately wide grant over the mount it cannot see. */
  const SPEC: MachineSpec = {
    mounts: { allow_always: [] },
    tools: { allow_always: [{ tool: "read_file", args: { file_path: ["catalogs/**"] } }] },
    states: { work: { tools: { allow: [{ tool: "grep", args: { path: ["catalogs/**"] } }] } } },
  };
  const hidden = "catalogs/eu/skus.csv";

  const verdict = (tool: string, path: string, rules: GovernanceRule[] = []) =>
    decide(
      machineOf(SPEC),
      { kind: "tool-call", state: "work", tool, args: { file_path: path } },
      rules,
      GOVERNING,
    );

  it("is not widened by a state's own wildcard path entry", () => {
    const v = verdict("grep", hidden);
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("mount.not-allowed");
  });

  it("is not widened by a workflow-level allow_always grant", () => {
    const v = verdict("read_file", hidden);
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("mount.not-allowed");
  });

  it("is not widened by a consumer rule that allows everything", () => {
    const allowEverything: GovernanceRule = () => ({ decision: "allow", ruleId: "custom.allow" });
    const v = verdict("read_file", hidden, [allowEverything]);
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("mount.not-allowed");
  });

  it("is still bound by a workflow denial of the tool where the mount is enabled", () => {
    const machine = machineOf({
      mounts: { allow_always: ["catalogs/eu"] },
      tools: { forbid_always: [{ tool: "read_file" }] },
      states: { work: {} },
    });
    const v = decide(
      machine,
      { kind: "tool-call", state: "work", tool: "read_file", args: { file_path: hidden } },
      [],
      GOVERNING,
    );
    expect(v.ruleId).toBe("tool.forbidden");
  });

  it("opens the mount without widening a state entry that narrows within it", () => {
    // Enabling a mount says which routes this state may reach, not which paths
    // inside them a narrowed grant permits: a `tools.allow` entry still binds.
    const machine = machineOf({
      mounts: { allow_always: ["catalogs/eu"] },
      states: {
        work: { tools: { allow: [{ tool: "read_file", args: { file_path: ["catalogs/eu/skus.csv"] } }] } },
      },
    });
    const call = (path: string) =>
      decide(
        machine,
        { kind: "tool-call", state: "work", tool: "read_file", args: { file_path: path } },
        [],
        GOVERNING,
      );
    expect(call(hidden).decision).toBe("allow");
    expect(call("catalogs/eu/prices.csv").ruleId).toBe("tool.not-allowed");
  });
});
