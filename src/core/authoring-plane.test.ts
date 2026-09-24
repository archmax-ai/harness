/**
 * The authoring plane is unreachable from a run.
 *
 * These are the tests the security argument rests on, so they assert the
 * *structure* rather than a policy: the agent's composite has no route to
 * `workflows/**`, which is why no rule, grant, or custom
 * governance can serve either.
 * A test that only checked "the kernel blocks it" would still pass if someone
 * later mounted the plane and relied on the rule — so the reads here go through
 * the agent workspace directly, below governance, where a route either exists or
 * does not.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemBackend, type BackendProtocolV2 } from "deepagents";
import { WorkflowMachine } from "../machine/machine.js";
import type { MachineSpec } from "../machine/types.js";
import { decide, type GovernanceRule } from "../kernel/kernel.js";
import { RUN_TOOL } from "../machine/tool-names.js";
import type { SkillPrefixes } from "./skills.js";
import { MountCollisionError } from "./mounts.js";
import { AuthoringBackendExposedError, createWorkspaceContext } from "./workspace-context.js";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A workspace with both planes populated: a governed workflow, a judge, a skill bundle. */
function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "plane-"));
  roots.push(root);
  const files: Record<string, string> = {
    "workflows/p/workflow.yaml": "runtime: { engine: archmax-harness, version: '2' }\nstates:\n  start: {}\n",
    "workflows/order-lookup/workflow.yaml":
      "rubrics:\n  tone:\n    instructions: judge the tone\n    max_iterations: 2\nstates:\n  start: {}\n",
    "workflows/p/WORKFLOW.md": "# prose addendum\n",
    "workflows/p/hooks/gate.js": "export default () => ok();\n",
    "workflows/p/tests/a.test.yaml": "description: a case\nsteps: []\n",
    "workflows/other/workflow.yaml": "states:\n  start: {}\n",
    "skills/cap/SKILL.md": "---\nname: cap\ndescription: a capability\n---\n\nbody\n",
    "skills/cap/scripts/run.js": "export default () => 1;\n",
    "AGENTS.md": "persona\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

function stubBackend(): BackendProtocolV2 {
  return new FilesystemBackend({ rootDir: mkdtempSync(join(tmpdir(), "stub-")), virtualMode: true });
}

describe("the governance plane is not part of the agent workspace", () => {
  it("serves the spec to the harness and nothing to the agent", async () => {
    const { workspace, authoring } = createWorkspaceContext({ rootDir: makeWorkspace() });

    expect(await authoring.readText("workflows/p/workflow.yaml")).toContain("states:");
    expect(await workspace.readText("workflows/p/workflow.yaml")).toBeNull();
  });

  it("hides a sibling workflow's spec, the prose, the hooks, and the cases alike", async () => {
    const { workspace } = createWorkspaceContext({ rootDir: makeWorkspace() });

    // Everything a run could learn about how it is governed, or graded.
    expect(await workspace.readText("workflows/other/workflow.yaml")).toBeNull();
    expect(await workspace.readText("workflows/p/WORKFLOW.md")).toBeNull();
    expect(await workspace.readText("workflows/p/hooks/gate.js")).toBeNull();
    expect(await workspace.readText("workflows/p/tests/a.test.yaml")).toBeNull();
  });

  it("lists nothing under the plane, whatever spelling is used", async () => {
    const { workspace } = createWorkspaceContext({ rootDir: makeWorkspace() });

    expect(await workspace.listDir("workflows")).toEqual([]);
    expect(await workspace.listDir("./workflows/")).toEqual([]);
    expect(await workspace.listDir("workflows/p/hooks")).toEqual([]);
  });

  it("omits the plane from the agent-visible root listing", async () => {
    const { workspace } = createWorkspaceContext({ rootDir: makeWorkspace() });

    const names = (await workspace.listDir("")).map((e) => e.path.replace(/^\/+|\/+$/g, ""));
    // What the workspace *does* serve is still there — the plane simply is not a
    // thing the agent can see the existence of, let alone read.
    expect(names).toContain("skills");
    expect(names).not.toContain("workflows");
  });

  it("still serves the agent workspace normally", async () => {
    const { workspace } = createWorkspaceContext({ rootDir: makeWorkspace() });

    expect(await workspace.readText("skills/cap/scripts/run.js")).toContain("export default");
    expect(await workspace.readText("AGENTS.md")).toContain("persona");
  });
});

describe("a grader's criteria are not part of the agent workspace", () => {
  it("keeps the rubric in the spec, which the agent cannot read", async () => {
    const { workspace, authoring } = createWorkspaceContext({ rootDir: makeWorkspace() });

    // A grading rubric is declared in `workflow.yaml`, so the one route that
    // does not exist protects the criteria and the iteration budget together —
    // exactly the facts an agent could otherwise play against.
    expect(await authoring.readText("workflows/order-lookup/workflow.yaml")).toContain("rubrics:");
    expect(await workspace.readText("workflows/order-lookup/workflow.yaml")).toBeNull();
  });

  it("treats the retired prefix as ordinary content", async () => {
    // `subagents/` is no longer on the plane: nothing in the runtime reads it,
    // so it is neither refused as a mount nor hidden from a listing.
    const { workspace } = createWorkspaceContext({
      rootDir: makeWorkspace(),
      mounts: { "/subagents/": stubBackend() },
    });
    expect(await workspace.listDir("subagents")).toEqual([]);
  });
});

describe("the plane cannot be mounted back in", () => {
  it("refuses a mount that would serve it", () => {
    expect(() =>
      createWorkspaceContext({
        rootDir: makeWorkspace(),
        mounts: { "/workflows/": stubBackend() },
      }),
    ).toThrow(MountCollisionError);
  });

  it("names the option to use instead", () => {
    expect(() =>
      createWorkspaceContext({ rootDir: makeWorkspace(), mounts: { "/workflows/": stubBackend() } }),
    ).toThrow(/authoring/);
  });

  it("describes what the prefix it refused holds", () => {
    // The plane holds one prefix now, and the diagnostic still describes that
    // prefix's own content rather than "the authoring plane" in the abstract.
    expect(() =>
      createWorkspaceContext({ rootDir: makeWorkspace(), mounts: { "/workflows/": stubBackend() } }),
    ).toThrow(/machine specs, grading rubrics, hook scripts, and test cases/);
  });

  it("refuses a writable mount served by the authoring backend", () => {
    const shared = stubBackend();
    expect(() =>
      createWorkspaceContext({
        rootDir: makeWorkspace(),
        authoring: shared,
        mounts: { "/shared/": { backend: shared, readOnly: false } },
      }),
    ).toThrow(AuthoringBackendExposedError);
  });

  it("allows a read-only mount to share the authoring backend", () => {
    // Safe, and common: a single authored tree serving both. The mount has no
    // route to `workflows/**` either, so nothing leaks through it.
    const shared = stubBackend();
    expect(() =>
      createWorkspaceContext({
        rootDir: makeWorkspace(),
        authoring: shared,
        mounts: { "/shared/": shared },
      }),
    ).not.toThrow();
  });
});

const SPEC: MachineSpec = {
  // The bundle is enabled explicitly: these tests are about the authoring plane
  // and `script.skill-only`, so the skill rule must not be what refuses first.
  skills: { allow_always: ["cap"] },
  states: {
    work: {
      tools: { allow: [{ tool: "read_file", args: { file_path: ["**"] } }] },
      skills: { allow: ["cap"] },
      transitions: [{ to: "done", description: "Test edge to done." }],
    },
    done: {},
  },
};
const SKILLS: SkillPrefixes = [{ slug: "cap", prefix: "skills/cap" }];

function verdict(
  tool: string,
  filePath: string,
  origin: "agent" | "script" | "lifecycle" = "agent",
  rules: GovernanceRule[] = [],
) {
  return decide(
    WorkflowMachine.fromSpec(SPEC),
    { kind: "tool-call", state: "work", tool, args: { file_path: filePath }, origin },
    rules,
    { dirs: ["skills"], files: ["AGENTS.md"], writable: [], governed: [], unsearchable: [] },
    {},
    SKILLS,
  );
}

describe("a script naming the plane is told why", () => {
  it("blocks a PTC read of the plane", () => {
    const v = verdict("read_file", "workflows/other/workflow.yaml", "script");
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("zone.governance-plane");
  });

  it("blocks a lifecycle PTC read of the plane", () => {
    expect(verdict("read_file", "workflows/p/hooks/gate.js", "lifecycle").ruleId).toBe(
      "zone.governance-plane",
    );
  });

  it("cannot be relaxed by a custom rule that allows everything", () => {
    const allowAll: GovernanceRule = () => ({ decision: "allow", ruleId: "custom.allow" });
    expect(verdict("read_file", "workflows/p/workflow.yaml", "script", [allowAll]).ruleId).toBe(
      "zone.governance-plane",
    );
  });

  it("blocks a script read of a sibling spec, naming that prefix", () => {
    const v = verdict("read_file", "workflows/other/workflow.yaml", "script");
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("zone.governance-plane");
    expect(v.reason).toContain("workflows/");
    expect(v.reason).toContain("grading rubrics");
  });

  it("blocks a lifecycle read of a spec", () => {
    // A hook is the very thing that dispatches a rubric; it still gets the name,
    // never the document declaring it.
    expect(verdict("read_file", "workflows/other/workflow.yaml", "lifecycle").ruleId).toBe(
      "zone.governance-plane",
    );
  });

  it("leaves a script's ordinary skill read alone", () => {
    expect(verdict("read_file", "skills/cap/SKILL.md", "script").decision).toBe("allow");
  });

  it("leaves an agent read to resolve as an absence rather than a refusal", () => {
    // The agent gets silence, not a lecture: there is no route, so there is
    // nothing to refuse. The block above exists for script authors, who would
    // otherwise debug an empty read.
    expect(verdict("read_file", "workflows/p/workflow.yaml", "agent").decision).toBe("allow");
  });
});

describe("archmax_run executes only skill-bundled scripts", () => {
  it("permits a script inside a bundle", () => {
    expect(verdict(RUN_TOOL, "skills/cap/scripts/run.js").decision).toBe("allow");
  });

  it("blocks a script the agent wrote into its own working area", () => {
    const v = verdict(RUN_TOOL, "scratchpad/exploit.js");
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("script.skill-only");
  });

  it("blocks a hook script — the agent may not run its own guard", () => {
    expect(verdict(RUN_TOOL, "workflows/p/hooks/gate.js").ruleId).toBe("script.skill-only");
  });

  it("is not widened by a state that grants everything", () => {
    // The plausible authoring mistake this rule exists for.
    const wide = WorkflowMachine.fromSpec({
      states: {
        work: { tools: { allow: [{ tool: RUN_TOOL, args: { file_path: ["**"] } }] } },
      },
    });
    const v = decide(
      wide,
      {
        kind: "tool-call",
        state: "work",
        tool: RUN_TOOL,
        args: { file_path: "scratchpad/exploit.js" },
      },
      [],
      { dirs: ["skills"], files: [], writable: [], governed: [], unsearchable: [] },
      {},
      SKILLS,
    );
    expect(v.ruleId).toBe("script.skill-only");
  });

  it("is not widened by a custom rule", () => {
    const allowAll: GovernanceRule = () => ({ decision: "allow", ruleId: "custom.allow" });
    expect(verdict(RUN_TOOL, "scratchpad/exploit.js", "agent", [allowAll]).ruleId).toBe(
      "script.skill-only",
    );
  });

  it("binds a script's own PTC call to the same rule", () => {
    expect(verdict(RUN_TOOL, "scratchpad/exploit.js", "script").ruleId).toBe("script.skill-only");
  });

  it("follows the resolved registry, not a literal skills/ prefix", () => {
    // A workspace serving its bundles from somewhere else is confined correctly.
    const v = decide(
      WorkflowMachine.fromSpec(SPEC),
      {
        kind: "tool-call",
        state: "work",
        tool: RUN_TOOL,
        args: { file_path: "capabilities/cap/scripts/run.js" },
      },
      [],
      { dirs: ["capabilities"], files: [], writable: [], governed: [], unsearchable: [] },
      {},
      [{ slug: "cap", prefix: "capabilities/cap" }],
    );
    expect(v.decision).toBe("allow");
  });

  it("blocks everything when no bundle is registered", () => {
    // With no skills there is no legal script, which is the honest answer rather
    // than an accidental opening.
    const v = decide(
      WorkflowMachine.fromSpec(SPEC),
      { kind: "tool-call", state: "work", tool: RUN_TOOL, args: { file_path: "skills/x.js" } },
      [],
      { dirs: ["skills"], files: [], writable: [], governed: [], unsearchable: [] },
      {},
      [],
    );
    expect(v.ruleId).toBe("script.skill-only");
  });

  it("leaves inline evaluation alone", () => {
    const v = decide(WorkflowMachine.fromSpec(SPEC), {
      kind: "tool-call",
      state: "work",
      tool: "archmax_eval",
      args: { code: "1 + 1" },
    });
    expect(v.decision).toBe("allow");
  });
});
