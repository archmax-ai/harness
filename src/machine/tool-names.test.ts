import { describe, expect, it } from "vitest";
import type { BackendProtocolV2 } from "deepagents";
import { Workspace } from "../core/workspace.js";
import { normalizeAllowEntry } from "./allow.js";
import { ALWAYS_ALLOWED_TOOLS, WorkflowMachine } from "./machine.js";
import {
  ADVANCE_TOOL,
  AGENT_ONLY_TOOLS,
  AUTOMATED_STATE_CONTROL_TOOLS,
  DEFAULT_TOOLS,
  GET_HISTORY_TOOL,
  GET_VARIABLES_TOOL,
  HARNESS_CONTROL_TOOLS,
  isReservedToolName,
  ARCHMAX_TOOL_PREFIX,
  EVAL_TOOL,
  RAISE_TOOL,
  RESET_TOOL,
  RUN_TOOL,
  SET_VARIABLES_TOOL,
  WAIT_TOOL,
  isWorkflowToolName,
  workflowSlugFromToolName,
  workflowToolName,
} from "./tool-names.js";

const SPEC_PATHS = { workflowYaml: "workflow.yaml", workflow: "WORKFLOW.md" };


function workspaceWith(files: Record<string, string>): Workspace {
  const norm = (p: string) => `/${p.replace(/^\/+/, "")}`;
  const backend = {
    async readRaw(filePath: string) {
      const content = files[norm(filePath)];
      return content === undefined
        ? { error: "missing" }
        : { data: { content, mimeType: "text/plain", created_at: "", modified_at: "" } };
    },
  } as unknown as BackendProtocolV2;
  return new Workspace(backend);
}

async function machineFrom(yaml: string): Promise<WorkflowMachine> {
  const ws = workspaceWith({ "/workflow.yaml": `${yaml.trim()}\n` });
  const machine = await WorkflowMachine.load(ws, SPEC_PATHS);
  if (!machine) throw new Error("machine failed to load");
  return machine;
}

describe("harness control tool names", () => {
  it("namespaces every harness-owned control tool", () => {
    for (const tool of HARNESS_CONTROL_TOOLS) {
      expect(isReservedToolName(tool)).toBe(true);
      expect(tool.startsWith(ARCHMAX_TOOL_PREFIX)).toBe(true);
    }
  });

  it("leaves a name that merely resembles a control tool alone", () => {
    expect(isReservedToolName("read_file")).toBe(false);
    expect(isReservedToolName("advance_state")).toBe(false);
  });

  it("permits every agent control in an agent state regardless of its allow list", () => {
    for (const tool of HARNESS_CONTROL_TOOLS) {
      // Both sandbox entry points are governed like ordinary tools: they are
      // default tools, granted like any other: a denial outranks the grant and
      // a state's own entry can narrow it.
      if (tool === RUN_TOOL || tool === EVAL_TOOL) continue;
      // The history is a grader's control, offered in no other state type.
      if (tool === GET_HISTORY_TOOL) continue;
      expect(ALWAYS_ALLOWED_TOOLS.has(tool)).toBe(true);
    }
  });

  // Reserved, so no host tool can shadow it, and a control, so no agent script
  // can reach it through the PTC surface.
  it("reserves archmax_get_history as a control tool, outside the agent's set", () => {
    expect(GET_HISTORY_TOOL).toBe("archmax_get_history");
    expect(HARNESS_CONTROL_TOOLS.has(GET_HISTORY_TOOL)).toBe(true);
    expect(isReservedToolName(GET_HISTORY_TOOL)).toBe(true);
    expect(ALWAYS_ALLOWED_TOOLS.has(GET_HISTORY_TOOL)).toBe(false);
  });
});

/**
 * An automated state — a grader or a code state alike — moves, fails, keeps the
 * session's variables and reads its history; it never parks or resets.
 */
describe("the automated-state control set", () => {
  it("is advance, raise, the variable tools and the history", () => {
    expect([...AUTOMATED_STATE_CONTROL_TOOLS].sort()).toEqual(
      [ADVANCE_TOOL, GET_HISTORY_TOOL, GET_VARIABLES_TOOL, RAISE_TOOL, SET_VARIABLES_TOOL].sort(),
    );
    expect(AUTOMATED_STATE_CONTROL_TOOLS.has(WAIT_TOOL)).toBe(false);
    expect(AUTOMATED_STATE_CONTROL_TOOLS.has(RESET_TOOL)).toBe(false);
  });

  it("names every automated control among the harness's controls", () => {
    for (const tool of AUTOMATED_STATE_CONTROL_TOOLS) expect(HARNESS_CONTROL_TOOLS.has(tool)).toBe(true);
  });

  it("withholds the planning list and both sandbox entry points from automated states", () => {
    expect([...AGENT_ONLY_TOOLS].sort()).toEqual([EVAL_TOOL, RUN_TOOL, "write_todos"].sort());
    // Each is a default tool of an agent: what an automated state loses, not what
    // nobody had.
    for (const tool of AGENT_ONLY_TOOLS) expect(DEFAULT_TOOLS.has(tool)).toBe(true);
  });
});

describe("disclosure under the namespace", () => {
  const YAML = `
states:
  work:
    triggers: { manual: }
    tools:
      allow:
        - { tool: archmax_run, paths: ["scripts/**"] }
    transitions:
      - to: done
        description: Work is finished.
      - to: review
        description: The work needs grading.
  review:
    type: grader
    instructions: Judge the work.
    transitions:
      - to: work
        description: Send it back.
  done: {}
`;

  it("discloses the control tools under their namespaced names", async () => {
    const machine = await machineFrom(YAML);
    const disclosed = machine.disclosedTools("work");
    expect(disclosed.has(ADVANCE_TOOL)).toBe(true);
    expect(disclosed.has(RESET_TOOL)).toBe(true);
    expect(disclosed.has(GET_VARIABLES_TOOL)).toBe(true);
    expect(disclosed.has(SET_VARIABLES_TOOL)).toBe(true);
    expect(disclosed.has(RUN_TOOL)).toBe(true);
    // The interpreter is a default tool — disclosed without any declaration here.
    expect(disclosed.has(EVAL_TOOL)).toBe(true);
    // The history is a grader's alone.
    expect(disclosed.has(GET_HISTORY_TOOL)).toBe(false);
  });

  it("discloses archmax_get_history in a grader state, under its namespaced name", async () => {
    const machine = await machineFrom(YAML);
    const disclosed = machine.disclosedTools("review");
    expect(disclosed.has(GET_HISTORY_TOOL)).toBe(true);
    expect(disclosed.has(ADVANCE_TOOL)).toBe(true);
    expect(disclosed.has(RESET_TOOL)).toBe(false);
    expect(disclosed.has(WAIT_TOOL)).toBe(false);
  });

  it("keeps framework built-ins un-namespaced", async () => {
    const machine = await machineFrom(YAML);
    const disclosed = machine.disclosedTools("work");
    for (const tool of ["read_file", "write_file", "edit_file", "ls", "glob", "grep"]) {
      expect(disclosed.has(tool)).toBe(true);
    }
  });

  it("withholds the advance tool in a terminal state but keeps reset", async () => {
    const machine = await machineFrom(YAML);
    const disclosed = machine.disclosedTools("done");
    expect(disclosed.has(ADVANCE_TOOL)).toBe(false);
    expect(disclosed.has(RESET_TOOL)).toBe(true);
  });
});

describe("namespaced names in authored governance", () => {
  it("governs a control tool from its allow entry", async () => {
    const machine = await machineFrom(`
states:
  work:
    triggers: { manual: }
    tools:
      allow:
        - { tool: archmax_run, paths: ["scripts/**"] }
`);
    expect(machine.checkAllowed("work", RUN_TOOL, { file_path: "scripts/x.js" })).toBe(true);
    expect(machine.checkAllowed("work", RUN_TOOL, { file_path: "other/x.js" })).toBe(false);
  });

  it("withholds a control tool named by tools.forbid_always", async () => {
    const machine = await machineFrom(`
tools:
  forbid_always: ["archmax_set_variables"]
states:
  work:
    triggers: { manual: }
`);
    expect(machine.disclosedTools("work").has(SET_VARIABLES_TOOL)).toBe(false);
    expect(normalizeAllowEntry("archmax_set_variables").tool).toBe(SET_VARIABLES_TOOL);
  });

  it("blocks the call at the kernel too", async () => {
    const { compileForbidRules } = await import("../kernel/kernel.js");
    const [rule] = compileForbidRules([{ tool: RUN_TOOL }], { scope: "workflow" });
    const verdict = rule!(
      { kind: "tool-call", tool: RUN_TOOL, args: {}, state: "work" } as never,
      {} as never,
    );
    expect(verdict?.decision).toBe("block");
  });
});

describe("delegation tool names", () => {
  it("round-trips a slug through the name and back", () => {
    expect(workflowToolName("enrich-order")).toBe("archmax_workflow_enrich-order");
    expect(workflowSlugFromToolName("archmax_workflow_enrich-order")).toBe("enrich-order");
  });

  it("resolves nothing for a name that is not a delegation tool", () => {
    for (const name of ["read_file", ADVANCE_TOOL, "archmax_workflow", "workflow_enrich-order"]) {
      expect(workflowSlugFromToolName(name)).toBeUndefined();
      expect(isWorkflowToolName(name)).toBe(false);
    }
  });

  it("resolves a malformed remainder rather than ignoring the entry", () => {
    // Shape is the caller's diagnostic to raise, against the declaration that
    // named it — silently treating this as an ordinary tool would lose it.
    expect(workflowSlugFromToolName("archmax_workflow_Enrich_Order")).toBe("Enrich_Order");
  });

  it("is reserved but is not a control tool", () => {
    const name = workflowToolName("enrich-order");
    expect(isReservedToolName(name)).toBe(true);
    // Not a control tool: it does work and returns a value, so a script may call
    // it. Every name in the control set is excluded from the PTC surface.
    expect(HARNESS_CONTROL_TOOLS.has(name)).toBe(false);
  });
});
