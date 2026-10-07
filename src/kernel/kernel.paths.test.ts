import { describe, expect, it } from "vitest";
import type { MountPrefixes } from "../core/mounts.js";
import { WorkflowMachine } from "../machine/machine.js";
import { resolveToolPaths, ToolPathsError } from "../machine/tool-paths.js";
import type { MachineSpec } from "../machine/types.js";
import { compileForbiddenMountRules, decide, type GovernanceRule } from "./kernel.js";

/**
 * Every path rule reads the tool's declared path arguments, with each one's
 * access: a host tool, a runtime file operation and a Deep Agents built-in are
 * governed by the same table, and a call naming several paths is refused when
 * any one is.
 */

const MOUNTS: MountPrefixes = {
  dirs: ["skills", "contracts", "shared"],
  files: ["AGENTS.md"],
  writable: ["contracts", "shared"],
  governed: ["contracts", "shared"],
  unsearchable: [],
};
const SKILLS = [
  { slug: "order-data", prefix: "skills/order-data" },
  { slug: "billing", prefix: "skills/billing" },
];

/** Host tools as the platform registers them: always on, with declared paths. */
const HOST_ESSENTIAL = ["get_markdown", "archive_file"];
const HOST_PATHS = resolveToolPaths({
  get_markdown: { path: "read" },
  archive_file: { source: "remove", destination: "write" },
});

const edge = (to: string) => [{ to, description: `Test edge to ${to}.` }];
const SPEC: MachineSpec = {
  skills: { allow_always: ["order-data"] },
  mounts: { allow_always: [] },
  states: {
    intake: {
      triggers: { manual: null },
      mounts: { allow: ["contracts", "shared"] },
      transitions: edge("reply"),
    },
    reply: { mounts: { allow: [{ mount: "shared", access: "read" }] }, transitions: edge("done") },
    done: {},
  },
};

function call(
  state: string,
  tool: string,
  args: Record<string, unknown>,
  opts: { spec?: MachineSpec; rules?: GovernanceRule[]; origin?: "agent" | "script" | "lifecycle" } = {},
) {
  const machine = WorkflowMachine.fromSpec(opts.spec ?? SPEC, HOST_ESSENTIAL, HOST_PATHS);
  return decide(
    machine,
    { kind: "tool-call", state, tool, args, ...(opts.origin ? { origin: opts.origin } : {}) },
    opts.rules ?? [],
    MOUNTS,
    {},
    SKILLS,
  );
}

describe("declared paths: a host tool", () => {
  it("is refused a governed mount the state was not given", () => {
    expect(call("intake", "get_markdown", { path: "contracts/policy.docx" }).decision).toBe("allow");
    const v = call("reply", "get_markdown", { path: "contracts/policy.docx" });
    expect(v).toMatchObject({ decision: "block", ruleId: "mount.not-allowed" });
    expect(v.reason).toContain("'get_markdown' on 'contracts/policy.docx'");
  });

  it("is refused a write or remove under a mount the state may only read, and allowed a read", () => {
    expect(call("reply", "get_markdown", { path: "shared/notes.md" }).decision).toBe("allow");
    const write = call("reply", "archive_file", { source: "scratchpad/a.md", destination: "shared/a.md" });
    expect(write).toMatchObject({ decision: "block", ruleId: "mount.read-only" });
    expect(write.reason).toContain("'archive_file' on 'shared/a.md' (destination)");
    const remove = call("reply", "archive_file", { source: "shared/a.md", destination: "scratchpad/a.md" });
    expect(remove).toMatchObject({ decision: "block", ruleId: "mount.read-only" });
    expect(remove.reason).toContain("(source)");
  });

  it("is refused a skill bundle the state does not enable", () => {
    expect(call("intake", "get_markdown", { path: "skills/order-data/SKILL.md" }).decision).toBe("allow");
    expect(call("intake", "get_markdown", { path: "skills/billing/SKILL.md" }).ruleId).toBe("skill.not-allowed");
  });

  it("is refused the read-only authored zone and the runtime's own areas for a mutation", () => {
    expect(call("intake", "archive_file", { source: "scratchpad/a", destination: "AGENTS.md" }).ruleId).toBe(
      "zone.read-only",
    );
    expect(call("intake", "archive_file", { source: "skills/order-data/x", destination: "scratchpad/x" }).ruleId).toBe(
      "zone.read-only",
    );
    expect(call("intake", "get_markdown", { path: "checkpoints/cp-1.json" }).ruleId).toBe("zone.runtime-internal");
    expect(call("intake", "archive_file", { source: "large_tool_results/r", destination: "scratchpad/r" }).ruleId).toBe(
      "zone.runtime-managed",
    );
    expect(call("intake", "get_markdown", { path: "large_tool_results/r" })).toMatchObject({
      decision: "allow",
      ruleId: "tool.offload-read",
    });
  });

  it("is bound by an inherited mount denial on any of its paths", () => {
    const [inherited] = compileForbiddenMountRules(["contracts"], "parent");
    const v = call(
      "intake",
      "archive_file",
      { source: "scratchpad/a", destination: "contracts/a" },
      { rules: [inherited!] },
    );
    expect(v).toMatchObject({ decision: "block", ruleId: "mount.forbidden" });
    expect(v.reason).toContain("workflow 'parent'");
  });

  it("is governed the same way from a script, and bound by the safety rules from a hook", () => {
    expect(call("reply", "get_markdown", { path: "contracts/x" }, { origin: "script" }).ruleId).toBe("mount.not-allowed");
    expect(call("reply", "get_markdown", { path: "contracts/x" }, { origin: "lifecycle" }).decision).toBe("allow");
    expect(
      call("reply", "archive_file", { source: "scratchpad/a", destination: "AGENTS.md" }, { origin: "lifecycle" }).ruleId,
    ).toBe("zone.read-only");
  });

  it("has no path rules without a declaration", () => {
    const machine = WorkflowMachine.fromSpec(SPEC, ["undeclared"]);
    const v = decide(
      machine,
      { kind: "tool-call", state: "reply", tool: "undeclared", args: { path: "contracts/x" } },
      [],
      MOUNTS,
    );
    expect(v.decision).toBe("allow");
  });
});

describe("declared paths: the runtime's file operations", () => {
  it("open the scratchpad to a copy, a move and a removal in every state", () => {
    for (const state of ["intake", "reply", "done"]) {
      expect(call(state, "copy_file", { source: "scratchpad/a", destination: "scratchpad/b" }).ruleId).toBe(
        "tool.scratchpad",
      );
      expect(call(state, "move_file", { source: "scratchpad/a", destination: "scratchpad/b" }).ruleId).toBe(
        "tool.scratchpad",
      );
      expect(call(state, "remove_file", { file_path: "scratchpad/a" }).ruleId).toBe("tool.scratchpad");
    }
  });

  it("copy out of a read-only mount, but neither move out of one nor copy into one", () => {
    expect(call("intake", "copy_file", { source: "skills/order-data/t.md", destination: "scratchpad/t.md" }).decision).toBe(
      "allow",
    );
    const into = call("intake", "copy_file", { source: "scratchpad/t.md", destination: "skills/order-data/t.md" });
    expect(into).toMatchObject({ decision: "block", ruleId: "zone.read-only" });
    expect(into.reason).toContain("'copy_file' on 'skills/order-data/t.md' (destination)");
    const out = call("intake", "move_file", { source: "skills/order-data/t.md", destination: "scratchpad/t.md" });
    expect(out).toMatchObject({ decision: "block", ruleId: "zone.read-only" });
    expect(out.reason).toContain("(source)");
    expect(call("intake", "remove_file", { file_path: "skills/order-data/t.md" }).ruleId).toBe("zone.read-only");
  });

  it("copy out of a governed mount only where the state was given it", () => {
    expect(call("intake", "copy_file", { source: "contracts/p.docx", destination: "scratchpad/p.docx" }).decision).toBe(
      "allow",
    );
    expect(call("reply", "copy_file", { source: "contracts/p.docx", destination: "scratchpad/p.docx" }).ruleId).toBe(
      "mount.not-allowed",
    );
  });

  it("are refused by a path denial on either side", () => {
    const spec: MachineSpec = { ...SPEC, tools: { forbid_always: [{ tool: "*", paths: ["secrets/**"] }] } };
    const out = call("intake", "copy_file", { source: "secrets/key.pem", destination: "scratchpad/k" }, { spec });
    expect(out).toMatchObject({ decision: "block", ruleId: "tool.forbidden" });
    expect(out.reason).toContain("paths=secrets/**");
    expect(call("intake", "copy_file", { source: "scratchpad/k", destination: "secrets/k" }, { spec }).ruleId).toBe(
      "tool.forbidden",
    );
    expect(call("intake", "get_markdown", { path: "secrets/k" }, { spec }).ruleId).toBe("tool.forbidden");
    expect(call("intake", "copy_file", { source: "scratchpad/a", destination: "scratchpad/b" }, { spec }).decision).toBe(
      "allow",
    );
  });

  it("are narrowed by a paths entry only when every path matches", () => {
    const spec: MachineSpec = {
      ...SPEC,
      states: {
        ...SPEC.states,
        intake: { ...SPEC.states.intake, tools: { allow: [{ tool: "copy_file", paths: ["skills/**", "reports/**"] }] } },
      },
    };
    expect(call("intake", "copy_file", { source: "skills/order-data/t", destination: "reports/t" }, { spec }).decision).toBe(
      "allow",
    );
    expect(call("intake", "copy_file", { source: "skills/order-data/t", destination: "drafts/t" }, { spec }).ruleId).toBe(
      "tool.not-allowed",
    );
  });

  it("can be closed by name", () => {
    const spec: MachineSpec = {
      ...SPEC,
      states: { ...SPEC.states, intake: { ...SPEC.states.intake, tools: { forbid: ["copy_file"] } } },
    };
    expect(call("intake", "copy_file", { source: "scratchpad/a", destination: "scratchpad/b" }, { spec }).ruleId).toBe(
      "tool.forbidden-here",
    );
    expect(call("intake", "write_file", { file_path: "scratchpad/b" }, { spec }).decision).toBe("allow");
  });
});

describe("declared paths: the built-ins", () => {
  it("read a built-in's path through its alias, as the tool itself does", () => {
    // Deep Agents' read_file takes `path` when `file_path` is absent.
    expect(call("intake", "read_file", { path: "checkpoints/cp-1.json" }).ruleId).toBe("zone.runtime-internal");
    expect(call("intake", "write_file", { path: "skills/order-data/x" }).ruleId).toBe("zone.read-only");
    expect(call("reply", "ls", { path: "contracts" }).ruleId).toBe("mount.not-allowed");
  });

  it("match a paths guard on ls, glob and grep against their own path argument", () => {
    const spec: MachineSpec = {
      ...SPEC,
      states: { ...SPEC.states, intake: { ...SPEC.states.intake, tools: { allow: [{ tool: "grep", paths: ["reports/**"] }] } } },
    };
    expect(call("intake", "grep", { pattern: "x", path: "reports/q3" }, { spec }).decision).toBe("allow");
    expect(call("intake", "grep", { pattern: "x", path: "drafts" }, { spec }).ruleId).toBe("tool.not-allowed");
  });
});

describe("resolveToolPaths", () => {
  it("refuses a declaration for a built-in tool, an unknown access, and an empty declaration", () => {
    expect(() => resolveToolPaths({ read_file: { file_path: "read" } })).toThrow(ToolPathsError);
    expect(() => resolveToolPaths({ copy_file: { source: "read" } })).toThrow(/built-in/);
    expect(() => resolveToolPaths({ fetch: { url: "download" as never } })).toThrow(/access 'download'/);
    expect(() => resolveToolPaths({ fetch: {} })).toThrow(/no path argument/);
  });
});
