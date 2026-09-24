import { describe, expect, it } from "vitest";
import { WorkflowMachine } from "../machine/machine.js";
import type { MountPrefixes } from "../core/mounts.js";
import type { MachineSpec } from "../machine/types.js";
import {
  compileForbiddenMountRules,
  decide,
  isReadOnlyZonePath,
  reduceHookFact,
  type HookFact,
  type ProposedAction,
} from "./kernel.js";

const SPEC: MachineSpec = {
  states: {
    collect: {
      triggers: { manual: null },
      tools: {
        allow: [
          { tool: "read_file", args: { file_path: ["data/*.json"] } },
          { tool: "write_file", args: { file_path: ["output/answer.json"] } },
          { tool: "archmax_advance", args: { to: ["review"] } },
        ],
      },
      transitions: [{ to: "review", description: "Data collected." }],
    },
    review: {
      transitions: [{ to: "done", description: "Reviewed." }],
    },
    done: {},
  },
};

function machine(): WorkflowMachine {
  return WorkflowMachine.fromSpec(SPEC);
}

const okFact: HookFact = { verdict: "ok", reason: "" };
const vetoFact: HookFact = { verdict: "veto", reason: "precondition not met" };

describe("decide — tool-call", () => {
  it("always blocks an unnamespaced eval tool without a warning", () => {
    const v = decide(machine(), { kind: "tool-call", state: "collect", tool: "eval", args: {} });
    expect(v.decision).toBe("block");
    expect(v.warn).toBe(false);
    expect(v.reason).toContain("archmax_eval");
    expect(v.ruleId).toBe("tool.eval");
  });

  it("permits the harness's own interpreter as an essential built-in", () => {
    // `archmax_eval` is not the name the safety rule refuses — the state's
    // essential grant decides it, in a state whose allow list omits it.
    const v = decide(machine(), {
      kind: "tool-call",
      state: "collect",
      tool: "archmax_eval",
      args: { code: "1 + 1" },
    });
    expect(v.decision).toBe("allow");
  });

  it("allows a matched allow entry", () => {
    const v = decide(machine(), {
      kind: "tool-call",
      state: "collect",
      tool: "read_file",
      args: { file_path: "data/orders.json" },
    });
    expect(v.decision).toBe("allow");
  });

  it("blocks a disallowed tool with a descriptive, warn-level message", () => {
    // write_file is essential, but `collect` narrows it to output/answer.json.
    const v = decide(machine(), {
      kind: "tool-call",
      state: "collect",
      tool: "write_file",
      args: { file_path: "output/x.json" },
    });
    expect(v.decision).toBe("block");
    expect(v.warn).toBe(true);
    expect(v.reason).toContain("not allowed in state 'collect'");
    expect(v.reason).toContain("on 'output/x.json'");
  });

  it("blocks an undeclared non-essential tool in a state with no tools block", () => {
    const v = decide(machine(), {
      kind: "tool-call",
      state: "review",
      tool: "web_fetch",
      args: { url: "https://example.com" },
    });
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("tool.not-allowed");
  });

  it("allows essential tools in a state with no tools block (closed default)", () => {
    for (const [tool, args] of [
      ["read_file", { file_path: "data/orders.json" }],
      ["write_file", { file_path: "output/x.json" }],
      ["ls", { path: "." }],
    ] as const) {
      const v = decide(machine(), { kind: "tool-call", state: "review", tool, args });
      expect(v.decision, tool).toBe("allow");
    }
  });

  it("allows write_todos as an essential built-in, with policy the only off-switch", () => {
    // The planning scratchpad is standard equipment: permitted in every state
    // without declaration, like the filesystem surface.
    const call = { kind: "tool-call", state: "collect", tool: "write_todos", args: {} } as const;
    expect(decide(machine(), call).decision).toBe("allow");
    const forbidden = WorkflowMachine.fromSpec({
      ...SPEC,
      tools: { forbid_always: [{ tool: "write_todos" }] },
    });
    expect(decide(forbidden, call).ruleId).toBe("tool.forbidden");
  });
});

describe("read-only authored zone", () => {
  // A state with no `tools` block: the essential write tools are permitted
  // there, so the zone rule must still refuse authored paths.
  const openSpec: MachineSpec = {
    states: {
      edit: { triggers: { manual: null }, transitions: [{ to: "done", description: "done" }] },
      done: {},
    },
  };
  const openMachine = () => WorkflowMachine.fromSpec(openSpec);

  // Which directories are authored is workspace shape, so every authored-zone
  // assertion supplies the workspace's resolved table — the kernel holds none.
  const MOUNTS: MountPrefixes = {
    dirs: ["workflows", "skills", "subagents", "scripts", "data", ".platform"],
    files: ["AGENTS.md"],
    writable: [],
    governed: [],
    unsearchable: [],
  };

  it("classifies authored zones as read-only and the run root as writable", () => {
    for (const p of ["workflows/x/WORKFLOW.md", "skills/s/SKILL.md", "subagents/j/SUBAGENT.md", "scripts/check.js", "data/orders.json", "AGENTS.md", "/workflows/x", ".platform/system/GRAPH_STATE.md"]) {
      expect(isReadOnlyZonePath(p, MOUNTS), p).toBe(true);
    }
    for (const p of ["output/refund.json", "scratchpad/x.txt", "notes.txt", "AGENTS.md.bak", ""]) {
      expect(isReadOnlyZonePath(p, MOUNTS), p).toBe(false);
    }
    // An unmounted directory is run state, not authored — nothing is authored by
    // name alone.
    expect(isReadOnlyZonePath("templates/reply.md", MOUNTS)).toBe(false);
    expect(isReadOnlyZonePath("data/orders.json")).toBe(false);
  });

  it("blocks write_file/edit_file into an authored zone even when the state is open", () => {
    for (const tool of ["write_file", "edit_file"]) {
      const v = decide(
        openMachine(),
        {
          kind: "tool-call",
          state: "edit",
          tool,
          args: { file_path: "workflows/order-lookup/WORKFLOW.md" },
        },
        [],
        MOUNTS,
      );
      expect(v.decision, tool).toBe("block");
      expect(v.ruleId, tool).toBe("zone.read-only");
      expect(v.warn, tool).toBe(true);
      expect(v.reason, tool).toContain("read-only");
    }
  });

  it("allows writes to the output zone", () => {
    const v = decide(openMachine(), {
      kind: "tool-call",
      state: "edit",
      tool: "write_file",
      args: { file_path: "output/refund.json" },
    });
    expect(v.decision).toBe("allow");
  });

  it("blocks harness-internal run areas outright, and offload writes with scratchpad guidance", () => {
    for (const [tool, path, ruleId] of [
      ["read_file", "checkpoints/cp-1.json", "zone.runtime-internal"],
      ["write_file", "checkpoints/cp-1.json", "zone.runtime-internal"],
      ["ls", "artifacts", "zone.runtime-internal"],
      ["read_file", "_specs/hash1.json", "zone.runtime-internal"],
      ["write_file", "large_tool_results/mine.txt", "zone.runtime-managed"],
      ["edit_file", "conversation_history/abc", "zone.runtime-managed"],
    ] as const) {
      const args = tool === "ls" ? { path } : { file_path: path };
      const v = decide(openMachine(), { kind: "tool-call", state: "edit", tool, args });
      expect(v.decision, `${tool} ${path}`).toBe("block");
      expect(v.ruleId, `${tool} ${path}`).toBe(ruleId);
    }
  });

  it("permits reading an offloaded tool result without an allow entry", () => {
    for (const [tool, args] of [
      ["read_file", { file_path: "large_tool_results/call_1.txt" }],
      ["ls", { path: "conversation_history" }],
    ] as const) {
      const v = decide(machine(), { kind: "tool-call", state: "collect", tool, args });
      expect(v.decision, tool).toBe("allow");
      expect(v.ruleId, tool).toBe("tool.offload-read");
    }
  });

  it("does not guard paths that merely resemble a governed area", () => {
    for (const [tool, args] of [
      ["read_file", { file_path: "output/refund.json" }],
      ["write_file", { file_path: "outputs/x.json" }],
      ["write_file", { file_path: "runner/x.json" }],
      ["write_file", { file_path: "checkpointsx/x.json" }],
    ] as const) {
      const v = decide(openMachine(), { kind: "tool-call", state: "edit", tool, args });
      expect(v.decision, `${tool} ${args.file_path}`).toBe("allow");
    }
  });

  it("blocks authored-zone writes disguised with `./`, `.//`, or `..` prefixes (issue #24)", () => {
    for (const p of [
      ".//workflows/order-lookup/workflow.yaml",
      "././AGENTS.md",
      "./skills/../workflows/x/WORKFLOW.md",
    ]) {
      const v = decide(
        openMachine(),
        { kind: "tool-call", state: "edit", tool: "write_file", args: { file_path: p } },
        [],
        MOUNTS,
      );
      expect(v.decision, p).toBe("block");
      expect(v.ruleId, p).toBe("zone.read-only");
    }
  });

  it("does not gate non-write tools that reference authored paths", () => {
    const v = decide(openMachine(), {
      kind: "tool-call",
      state: "edit",
      tool: "read_file",
      args: { file_path: "data/orders.json" },
    });
    expect(v.decision).toBe("allow");
  });
});

describe("scratchpad/ scratch space", () => {
  it("permits scratch read/write under a state allow list that never mentions scratchpad/", () => {
    // The `collect` state narrows read_file to data/*.json and write_file to
    // output/answer.json; the scratch rule still passes scratchpad/ access.
    for (const [tool, args] of [
      ["write_file", { file_path: "scratchpad/staged.csv" }],
      ["edit_file", { file_path: "scratchpad/staged.csv" }],
      ["read_file", { file_path: "/scratchpad/staged.csv" }],
      ["ls", { path: "scratchpad/" }],
    ] as const) {
      const v = decide(machine(), { kind: "tool-call", state: "collect", tool, args });
      expect(v.decision, tool).toBe("allow");
      expect(v.ruleId, tool).toBe("tool.scratchpad");
    }
  });

  it("does not classify `..` traversal out of scratchpad/ as scratch (issue #24)", () => {
    // `scratchpad/../checkpoints/cp-1.json` canonicalizes into a harness-internal
    // area, so it is refused rather than waved through as always-allowed scratch.
    const v = decide(machine(), {
      kind: "tool-call",
      state: "collect",
      tool: "write_file",
      args: { file_path: "scratchpad/../checkpoints/cp-1.json" },
    });
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("zone.runtime-internal");

    // And climbing out into a governed run path leaves it governed by the state.
    const governed = decide(machine(), {
      kind: "tool-call",
      state: "collect",
      tool: "write_file",
      args: { file_path: "scratchpad/../output/other.json" },
    });
    expect(governed.decision).toBe("block");
    expect(governed.ruleId).toBe("tool.not-allowed");
  });

  it("leaves output/ result artifacts governed by the allow list", () => {
    const v = decide(machine(), {
      kind: "tool-call",
      state: "collect",
      tool: "write_file",
      args: { file_path: "output/other.json" },
    });
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("tool.not-allowed");
  });

  it("does not suggest archmax_advance when blocking a tool call in a terminal state", () => {
    const terminalSpec: MachineSpec = {
      states: {
        reply: {
          triggers: { manual: null },
          tools: {
            allow: [{ tool: "reply-email", args: { ccRecipients: "info@archmax.ai" } }],
          },
        },
      },
    };
    const v = decide(WorkflowMachine.fromSpec(terminalSpec), {
      kind: "tool-call",
      state: "reply",
      tool: "reply-email",
      args: {},
    });
    expect(v.decision).toBe("block");
    expect(v.reason).not.toContain("call archmax_advance when ready");
    expect(v.reason).toContain("do not call archmax_advance");
    expect(v.reason).not.toMatch(/Allowed in 'reply':.*archmax_advance/);
  });

  it("does not loosen paths that merely resemble the scratch prefix", () => {
    const v = decide(machine(), {
      kind: "tool-call",
      state: "collect",
      tool: "write_file",
      args: { file_path: "workspace/tmp.csv" },
    });
    expect(v.decision).toBe("block");
  });

  it("stays subordinate to a workflow denial (forbid_always can still block scratch)", () => {
    const policySpec: MachineSpec = {
      ...SPEC,
      tools: { forbid_always: [{ tool: "*", paths: ["scratchpad/**"] }] },
    } as MachineSpec;
    const v = decide(WorkflowMachine.fromSpec(policySpec), {
      kind: "tool-call",
      state: "collect",
      tool: "write_file",
      args: { file_path: "scratchpad/staged.csv" },
    });
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("tool.forbidden");
  });

  it("blocks a dot-prefixed path under a forbidden subtree", () => {
    // A dotfile used to escape `**` entirely, so a path denial was bypassable
    // by writing the one file most worth forbidding (issue #25).
    const policySpec: MachineSpec = {
      ...SPEC,
      tools: { forbid_always: [{ tool: "*", paths: ["scratchpad/**"] }] },
    } as MachineSpec;
    const v = decide(WorkflowMachine.fromSpec(policySpec), {
      kind: "tool-call",
      state: "collect",
      tool: "write_file",
      args: { file_path: "scratchpad/.env" },
    });
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("tool.forbidden");
  });
});

describe("reply-only turns", () => {
  /** Every call is the same call, differing only in whether the run is parked. */
  const call = (tool: string, args: Record<string, unknown> = {}): ProposedAction => ({
    kind: "tool-call",
    state: "collect",
    tool,
    args,
    replyOnly: true,
  });

  it("refuses the harness control tools, which are otherwise always allowed", () => {
    for (const tool of [
      "archmax_advance",
      "archmax_reset",
      "archmax_wait",
      "archmax_get_variables",
      "archmax_set_variables",
    ]) {
      const v = decide(machine(), call(tool, { to: "review" }));
      expect(v.decision, tool).toBe("block");
      expect(v.ruleId, tool).toBe("tool.reply-only");
    }
  });

  it("refuses a tool the state's allow list permits", () => {
    const v = decide(machine(), call("read_file", { file_path: "data/orders.json" }));
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("tool.reply-only");
    expect(v.reason).toContain("parked");
  });

  it("refuses the always-open scratchpad", () => {
    const v = decide(machine(), call("write_file", { file_path: "scratchpad/notes.md" }));
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("tool.reply-only");
  });

  it("refuses an essential built-in", () => {
    expect(decide(machine(), call("write_todos")).ruleId).toBe("tool.reply-only");
  });

  it("refuses a PTC-origin call by the same rule", () => {
    const v = decide(machine(), {
      kind: "tool-call",
      state: "collect",
      tool: "read_file",
      args: { file_path: "data/orders.json" },
      origin: "script",
      replyOnly: true,
    });
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("tool.reply-only");
  });

  it("leaves an ordinary turn in the same state untouched", () => {
    const v = decide(machine(), {
      kind: "tool-call",
      state: "collect",
      tool: "read_file",
      args: { file_path: "data/orders.json" },
    });
    expect(v.decision).toBe("allow");
  });
});

describe("decide — transition", () => {
  it("blocks an undeclared edge with valid targets listed", () => {
    const v = decide(machine(), { kind: "transition", from: "collect", to: "done", hookFacts: [] });
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("transition.no-edge");
    expect(v.reason).toContain("Valid target slugs: review");
  });

  it("allows a declared edge when hooks pass", () => {
    const v = decide(machine(), {
      kind: "transition",
      from: "collect",
      to: "review",
      hookFacts: [okFact],
    });
    expect(v.decision).toBe("allow");
  });

  it("blocks a declared edge when an after hook vetoes", () => {
    const v = decide(machine(), {
      kind: "transition",
      from: "collect",
      to: "review",
      hookFacts: [vetoFact],
    });
    expect(v.decision).toBe("block");
    expect(v.reason).toBe("hook veto: precondition not met");
  });
});

describe("decide — enter-state (before hooks)", () => {
  it("allows when before hooks pass", () => {
    const v = decide(machine(), { kind: "enter-state", state: "review", hookFacts: [okFact] });
    expect(v.decision).toBe("allow");
  });

  it("blocks when a before hook vetoes", () => {
    const v = decide(machine(), { kind: "enter-state", state: "review", hookFacts: [vetoFact] });
    expect(v.decision).toBe("block");
    expect(v.reason).toBe("precondition not met");
  });
});

describe("reduceHookFact — fail closed", () => {
  it("reduces an errored hook fact to a veto carrying the error", () => {
    const v = reduceHookFact({ verdict: "ok", reason: "", error: "boom" }, { phase: "after", veto: true });
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("hook.error");
    expect(v.reason).toBe("boom");
  });

  it("routes a rubric after-veto through rubric messaging and consumes an iteration", () => {
    const v = reduceHookFact(
      { verdict: "correct", reason: "incomplete", rubric: "tone", maxIterations: 1, iterationsUsed: 0 },
      { phase: "after", veto: true, to: "done" },
    );
    expect(v.decision).toBe("block");
    expect(v.reason).toContain("attempt(s) remaining");
    expect(v.correctionConsumed).toBe(true);
  });

  it("does not block a correct verdict outside an after-veto window", () => {
    const v = reduceHookFact(
      { verdict: "correct", reason: "x", rubric: "tone" },
      { phase: "after", veto: false },
    );
    expect(v.decision).toBe("allow");
  });

  it("bills no iteration for a correct verdict refused on an exhausted budget", () => {
    // The refusal grants no retry, so it must not charge for one: charging it
    // pushed the count past the max and cost the state its budget on the next
    // visit (issue #62).
    const v = reduceHookFact(
      { verdict: "correct", reason: "fix it", maxIterations: 1, iterationsUsed: 1 },
      { phase: "after", veto: true, to: "next" },
    );
    expect(v.decision).toBe("block");
    expect(v.reason).toContain("still incomplete after 1 attempt(s)");
    expect(v.correctionConsumed).toBe(false);
    expect(v.budgetExhausted).toBe(true);
  });

  it("bills no iteration for a deliberate veto, and does not call it exhausted", () => {
    const v = reduceHookFact(
      { verdict: "veto", reason: "requester not found", maxIterations: 2, iterationsUsed: 0 },
      { phase: "after", veto: true, to: "next" },
    );
    expect(v.decision).toBe("block");
    expect(v.correctionConsumed).toBe(false);
    expect(v.budgetExhausted).toBe(false);
  });
});

describe("purity", () => {
  it("returns an identical verdict for identical inputs with no side effects", () => {
    const m = machine();
    const action: ProposedAction = {
      kind: "tool-call",
      state: "collect",
      tool: "read_file",
      args: { file_path: "data/orders.json" },
    };
    const frozen = Object.freeze({ ...action });
    const a = decide(m, frozen);
    const b = decide(m, frozen);
    expect(a).toEqual(b);
  });
});

describe("validator/runtime parity", () => {
  // A shared fixture of concrete tool calls exercised by both the kernel and
  // the machine's static allow matching; the validator and runtime both decide
  // through the same kernel, so these must never diverge.
  const fixture: { state: string; tool: string; args: Record<string, unknown> }[] = [
    { state: "collect", tool: "read_file", args: { file_path: "data/orders.json" } },
    { state: "collect", tool: "read_file", args: { file_path: "secret/keys.json" } },
    { state: "collect", tool: "write_file", args: { file_path: "output/x.json" } },
    { state: "collect", tool: "archmax_advance", args: { to: "review" } },
    { state: "collect", tool: "archmax_advance", args: { to: "done" } },
    { state: "review", tool: "write_file", args: { file_path: "output/x.json" } },
    { state: "review", tool: "read_file", args: { file_path: "anything" } },
    { state: "review", tool: "web_fetch", args: { url: "https://example.com" } },
    { state: "review", tool: "write_todos", args: {} },
  ];

  it("kernel tool-call verdicts match the machine's static allow matching", () => {
    const m = machine();
    for (const call of fixture) {
      const kernelAllows =
        decide(m, { kind: "tool-call", state: call.state, tool: call.tool, args: call.args }).decision ===
        "allow";
      const machineAllows = call.tool === "eval" ? false : m.checkAllowed(call.state, call.tool, call.args);
      expect(kernelAllows, `${call.state}/${call.tool}`).toBe(machineAllows);
    }
  });
});

describe("decide — skill governance", () => {
  const SKILLS = [
    { slug: "order-data", prefix: "skills/order-data" },
    { slug: "refund-policy", prefix: "skills/refund-policy" },
  ];
  const MOUNTS: MountPrefixes = { dirs: ["skills"], files: [], writable: [], governed: [], unsearchable: [] };

  const SKILL_SPEC: MachineSpec = {
    skills: { allow_always: [] },
    states: {
      lookup: { triggers: { manual: null }, skills: { allow: ["order-data"] }, transitions: [{ to: "refund", description: "Test edge to refund." }] },
      refund: { skills: { allow: ["refund-policy"] }, transitions: [{ to: "draft", description: "Test edge to draft." }] },
      draft: { skills: { allow: [] } },
      open: {},
    },
  };
  const skillMachine = () => WorkflowMachine.fromSpec(SKILL_SPEC);

  const call = (
    state: string,
    tool: string,
    args: Record<string, unknown>,
    origin?: "agent" | "script" | "lifecycle",
  ) =>
    decide(
      skillMachine(),
      { kind: "tool-call", state, tool, args, ...(origin ? { origin } : {}) },
      [],
      MOUNTS,
      {},
      SKILLS,
    );

  it("permits an enabled skill's bundle with no declaration of any kind", () => {
    const v = call("lookup", "read_file", { file_path: "skills/order-data/assets/orders.json" });
    expect(v.decision).toBe("allow");
  });

  it("permits running an enabled skill's script with no archmax_run entry", () => {
    const v = call("refund", "archmax_run", { file_path: "skills/refund-policy/scripts/check.js" });
    expect(v.decision).toBe("allow");
  });

  it("blocks every path tool on a skill the state does not enable", () => {
    for (const tool of ["read_file", "ls", "glob", "grep", "archmax_run"]) {
      const v = call("lookup", tool, { file_path: "skills/refund-policy/SKILL.md" });
      expect(v.decision, tool).toBe("block");
      expect(v.ruleId, tool).toBe("skill.not-allowed");
      expect(v.warn, tool).toBe(true);
    }
  });

  it("names the skill, the state, and what is enabled instead", () => {
    const v = call("lookup", "read_file", { file_path: "skills/refund-policy/SKILL.md" });
    expect(v.reason).toContain("'refund-policy'");
    expect(v.reason).toContain("state 'lookup'");
    expect(v.reason).toContain("Skills enabled here: order-data.");
  });

  it("says so plainly when a state enables nothing", () => {
    const v = call("draft", "read_file", { file_path: "skills/order-data/SKILL.md" });
    expect(v.decision).toBe("block");
    expect(v.reason).toContain("No skill is enabled in this state.");
  });

  it("refuses a write into a bundle as a read-only authored path, enabled or not", () => {
    for (const state of ["lookup", "draft"]) {
      const v = call(state, "write_file", { file_path: "skills/order-data/assets/orders.json" });
      expect(v.decision, state).toBe("block");
      expect(v.ruleId, state).toBe("zone.read-only");
    }
  });

  it("blocks an edit into a disabled bundle", () => {
    const v = call("lookup", "edit_file", { file_path: "skills/refund-policy/SKILL.md" });
    expect(v.decision).toBe("block");
  });

  it("cannot be dodged with `./`, `//`, or `..` spellings", () => {
    for (const path of [
      "./skills/refund-policy/SKILL.md",
      "/skills//refund-policy/SKILL.md",
      "skills/order-data/../refund-policy/SKILL.md",
    ]) {
      const v = call("lookup", "read_file", { file_path: path });
      expect(v.decision, path).toBe("block");
      expect(v.ruleId, path).toBe("skill.not-allowed");
    }
  });

  it("leaves a path under the source that belongs to no bundle to the zone rules", () => {
    expect(call("draft", "read_file", { file_path: "skills/README.md" }).decision).toBe("allow");
    expect(call("draft", "write_file", { file_path: "skills/README.md" }).ruleId).toBe(
      "zone.read-only",
    );
  });

  it("governs a script's programmatic call, on the model's authority", () => {
    const v = call("lookup", "read_file", { file_path: "skills/refund-policy/SKILL.md" }, "script");
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("skill.not-allowed");
  });

  it("exempts a lifecycle hook, which runs on harness authority", () => {
    const v = call("draft", "read_file", { file_path: "skills/order-data/assets/orders.json" }, "lifecycle");
    expect(v.decision).toBe("allow");
  });

  it("fires for no call when the workspace serves no skills", () => {
    const v = decide(
      skillMachine(),
      { kind: "tool-call", state: "lookup", tool: "read_file", args: { file_path: "skills/refund-policy/SKILL.md" } },
      [],
      MOUNTS,
    );
    expect(v.decision).toBe("allow");
  });

  it("enables nothing in a state that declares no skills block", () => {
    // `open` omits the block while the root enables both: the root list is the
    // ceiling, the state's list is the grant, and there is no grant here.
    for (const slug of ["order-data", "refund-policy"]) {
      const v = call("open", "read_file", { file_path: `skills/${slug}/SKILL.md` });
      expect(v.decision, slug).toBe("block");
      expect(v.ruleId, slug).toBe("skill.not-allowed");
      expect(v.reason, slug).toContain(`'${slug}'`);
      expect(v.reason, slug).toContain("state 'open'");
      expect(v.reason, slug).toContain("No skill is enabled in this state.");
    }
  });

  it("enables nothing in a workflow that declares no surface", () => {
    const machine = WorkflowMachine.fromSpec({ states: { work: {} } });
    for (const slug of ["order-data", "refund-policy"]) {
      const v = decide(
        machine,
        { kind: "tool-call", state: "work", tool: "read_file", args: { file_path: `skills/${slug}/SKILL.md` } },
        [],
        MOUNTS,
        {},
        SKILLS,
      );
      expect(v.decision, slug).toBe("block");
      expect(v.ruleId, slug).toBe("skill.not-allowed");
    }
  });

  it("runs no script at all where no skill is enabled", () => {
    // `script.skill-only` confines `archmax_run` to a bundle, so a state with no
    // enabled skill can execute nothing, whatever its `tools.allow` says.
    const v = call("open", "archmax_run", { file_path: "skills/order-data/scripts/check.js" });
    expect(v.decision).toBe("block");
  });
});

describe("decide — mount governance", () => {
  /**
   * A table with three shapes of mount: two the host governs (one of them a
   * nested key) and one it does not. `scratchpad` is not a mount at all.
   */
  const MOUNTS: MountPrefixes = {
    dirs: ["skills", "reference", "catalogs/eu"],
    files: [],
    writable: [],
    governed: ["reference", "catalogs/eu"],
    unsearchable: [],
  };

  const MOUNT_SPEC: MachineSpec = {
    mounts: { allow_always: [] },
    states: {
      intake: { triggers: { manual: null }, transitions: [{ to: "triage", description: "Test edge to triage." }] },
      triage: { mounts: { allow: ["catalogs/eu"] }, transitions: [{ to: "route", description: "Test edge to route." }] },
      route: { mounts: { forbid: ["skills"] } },
    },
  };
  const mountMachine = () => WorkflowMachine.fromSpec(MOUNT_SPEC);

  const call = (
    state: string,
    tool: string,
    args: Record<string, unknown>,
    origin?: "agent" | "script" | "lifecycle",
  ) =>
    decide(
      mountMachine(),
      { kind: "tool-call", state, tool, args, ...(origin ? { origin } : {}) },
      [],
      MOUNTS,
      {},
      [],
    );

  it("blocks every path tool on a governed mount the state does not have", () => {
    for (const tool of ["read_file", "ls", "glob", "grep"]) {
      const v = call("intake", tool, { file_path: "catalogs/eu/skus.csv" });
      expect(v.decision, tool).toBe("block");
      expect(v.ruleId, tool).toBe("mount.not-allowed");
      expect(v.warn, tool).toBe(true);
    }
  });

  it("leaves archmax_run outside a bundle to `script.skill-only`, mount or not", () => {
    // The earlier safety rule confines execution to a skill bundle, so a data
    // mount is refused for the reason that actually applies to running a file.
    expect(call("intake", "archmax_run", { file_path: "catalogs/eu/run.js" }).ruleId).toBe(
      "script.skill-only",
    );
    expect(call("triage", "archmax_run", { file_path: "catalogs/eu/run.js" }).ruleId).toBe(
      "script.skill-only",
    );
  });

  it("names the mount and says the state does not have it, not that it is missing", () => {
    const v = call("intake", "read_file", { file_path: "catalogs/eu/skus.csv" });
    expect(v.reason).toContain("'catalogs/eu'");
    expect(v.reason).toContain("state 'intake' does not have");
    expect(v.reason).toContain("The path exists");
    expect(v.reason).toContain("This state has no governed mount.");
  });

  it("serves the same mount where a state enables it, and names what is available", () => {
    expect(call("triage", "read_file", { file_path: "catalogs/eu/skus.csv" }).decision).toBe("allow");
    expect(call("triage", "ls", { path: "catalogs/eu" }).decision).toBe("allow");
    const v = call("triage", "read_file", { file_path: "reference/rates.csv" });
    expect(v.ruleId).toBe("mount.not-allowed");
    expect(v.reason).toContain("Mounts available here: catalogs/eu.");
  });

  it("refuses a write into a hidden read-only mount as read-only, the more useful reason", () => {
    for (const state of ["intake", "triage"]) {
      const v = call(state, "write_file", { file_path: "catalogs/eu/skus.csv" });
      expect(v.decision, state).toBe("block");
      expect(v.ruleId, state).toBe("zone.read-only");
      expect(v.reason, state).toContain("'catalogs/eu'");
    }
  });

  /**
   * The second half of a grant: a state that sees a mount may still be refused a
   * write there. Only a mount the host declared writable reaches this branch —
   * the zone rules refuse a write into a host-read-only mount first.
   */
  it("refuses a write into a mount a grant narrowed to reads", () => {
    const WRITABLE: MountPrefixes = {
      dirs: ["shared"],
      files: [],
      writable: ["shared"],
      governed: ["shared"],
      unsearchable: [],
    };
    const machine = WorkflowMachine.fromSpec({
      mounts: { allow_always: ["shared"] },
      states: {
        writes: {},
        reads: { mounts: { allow: [{ mount: "shared", access: "read" }] } },
      },
    });
    const at = (state: string, tool: string) =>
      decide(
        machine,
        { kind: "tool-call", state, tool, args: { file_path: "shared/notes.md" } },
        [],
        WRITABLE,
      );
    expect(at("writes", "write_file").decision).toBe("allow");
    expect(at("reads", "read_file").decision).toBe("allow");
    const v = at("reads", "write_file");
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("mount.read-only");
    expect(v.reason).toContain("'shared'");
    expect(v.reason).toContain("may read but not write");
  });

  it("says zone.read-only, not mount.read-only, for a host-read-only mount", () => {
    // The two are distinguishable on purpose: one is the host's wiring, the
    // other this state's grant, and an author fixes them in different places.
    const v = call("triage", "write_file", { file_path: "catalogs/eu/skus.csv" });
    expect(v.ruleId).toBe("zone.read-only");
  });

  it("leaves an ungoverned mount open in every state without a grant", () => {
    for (const state of ["intake", "triage"]) {
      expect(call(state, "read_file", { file_path: "skills/README.md" }).decision, state).toBe(
        "allow",
      );
    }
  });

  it("subtracts an ungoverned mount where a state forbids it", () => {
    const v = call("route", "read_file", { file_path: "skills/README.md" });
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("mount.forbidden");
    expect(v.reason).toContain("state 'route' forbids");
  });

  it("says a workflow-wide denial denied it, in every state", () => {
    const machine = WorkflowMachine.fromSpec({
      mounts: { allow_always: ["reference"], forbid_always: ["reference"] },
      states: { work: { mounts: { allow: ["reference"] } } },
    });
    const v = decide(
      machine,
      { kind: "tool-call", state: "work", tool: "read_file", args: { file_path: "reference/rates.csv" } },
      [],
      MOUNTS,
    );
    expect(v.ruleId).toBe("mount.forbidden");
    expect(v.reason).toContain("'mounts.forbid_always' denies in every state");
  });

  it("cannot be dodged with `./`, `//`, or `..` spellings", () => {
    for (const path of [
      "./catalogs/eu/skus.csv",
      "/catalogs//eu/skus.csv",
      "reference/../catalogs/eu/skus.csv",
    ]) {
      const v = call("intake", "read_file", { file_path: path });
      expect(v.decision, path).toBe("block");
      expect(v.ruleId, path).toBe("mount.not-allowed");
    }
  });

  it("leaves a path under no mount to the zone rules", () => {
    expect(call("intake", "read_file", { file_path: "catalogs/uk/skus.csv" }).decision).toBe("allow");
    expect(call("intake", "read_file", { file_path: "scratchpad/notes.md" }).decision).toBe("allow");
  });

  it("governs a script's programmatic call, on the model's authority", () => {
    const v = call("intake", "read_file", { file_path: "catalogs/eu/skus.csv" }, "script");
    expect(v.ruleId).toBe("mount.not-allowed");
  });

  /**
   * A hook and a rubric grader run on runtime authority: bound by the
   * workflow-wide denial (which travels as an inherited rule) and not by the
   * state's own surface, exactly as for tools.
   */
  it("exempts a lifecycle hook from the state's surface", () => {
    expect(call("intake", "read_file", { file_path: "catalogs/eu/skus.csv" }, "lifecycle").decision).toBe(
      "allow",
    );
    expect(call("route", "read_file", { file_path: "skills/README.md" }, "lifecycle").decision).toBe(
      "allow",
    );
  });

  it("fires for no call when the table governs nothing and no list forbids", () => {
    const open: MountPrefixes = { ...MOUNTS, governed: [] };
    const v = decide(
      mountMachine(),
      { kind: "tool-call", state: "intake", tool: "read_file", args: { file_path: "catalogs/eu/skus.csv" } },
      [],
      open,
    );
    expect(v.decision).toBe("allow");
  });

  it("hides a governed mount from a workflow that declares no mounts block", () => {
    const machine = WorkflowMachine.fromSpec({ states: { work: {} } });
    const v = decide(
      machine,
      { kind: "tool-call", state: "work", tool: "read_file", args: { file_path: "reference/rates.csv" } },
      [],
      MOUNTS,
    );
    expect(v.ruleId).toBe("mount.not-allowed");
  });
});

describe("compileForbiddenMountRules", () => {
  const MOUNTS: MountPrefixes = {
    dirs: ["reference"],
    files: [],
    writable: [],
    governed: ["reference"],
    unsearchable: [],
  };
  const child = WorkflowMachine.fromSpec({
    mounts: { allow_always: ["reference"] },
    states: { work: {} },
  });

  it("puts an ancestor's mount out of a child's reach, naming the workflow", () => {
    const v = decide(
      child,
      { kind: "tool-call", state: "work", tool: "read_file", args: { file_path: "reference/rates.csv" } },
      compileForbiddenMountRules(["reference"], "order-lookup"),
      MOUNTS,
    );
    expect(v.decision).toBe("block");
    expect(v.ruleId).toBe("mount.forbidden");
    expect(v.reason).toContain("workflow 'order-lookup'");
    expect(v.reason).toContain("mounts.forbid_always");
  });

  it("binds a lifecycle hook too: a workflow-wide denial is not a state surface", () => {
    const v = decide(
      child,
      {
        kind: "tool-call",
        state: "work",
        tool: "read_file",
        args: { file_path: "reference/rates.csv" },
        origin: "lifecycle",
      },
      compileForbiddenMountRules(["reference"], "order-lookup"),
      MOUNTS,
    );
    expect(v.ruleId).toBe("mount.forbidden");
  });

  it("compiles nothing for an empty declaration", () => {
    expect(compileForbiddenMountRules([], "order-lookup")).toEqual([]);
    const v = decide(
      child,
      { kind: "tool-call", state: "work", tool: "read_file", args: { file_path: "reference/rates.csv" } },
      [],
      MOUNTS,
    );
    expect(v.decision).toBe("allow");
  });
});

describe("forbid argument guards resolve like allow argument guards", () => {
  // A denial is only worth writing if it matches. These guard forms are the ones
  // `argsSatisfy` understands on the allow side, so a forbid written the same way
  // must bind the same calls — a denial that silently matches nothing fails open.
  const VARIABLES = { secret_dir: { value: "vault", locked: true } };

  function specWith(entry: Record<string, unknown>, side: "allow" | "forbid"): MachineSpec {
    return {
      ...(side === "forbid" ? { tools: { forbid_always: [entry] } } : {}),
      states: {
        work: {
          triggers: { manual: null },
          // Wide on the forbid side so only the denial decides; the allow side
          // carries the guard itself.
          tools: { allow: [side === "forbid" ? { tool: "write_file" } : entry] },
          transitions: [{ to: "done", description: "Done." }],
        },
        done: {},
      },
    } as unknown as MachineSpec;
  }

  function verdict(spec: MachineSpec, args: Record<string, unknown>) {
    const action: ProposedAction = {
      kind: "tool-call",
      origin: "agent",
      state: "work",
      tool: "write_file",
      args,
    };
    return decide(WorkflowMachine.fromSpec(spec), action, [], undefined, VARIABLES);
  }

  const FORMS = [
    {
      name: "a plain glob",
      args: { file_path: ["vault/**"] },
      call: { file_path: "vault/keys.json" },
    },
    {
      name: "a variable reference",
      args: { file_path: ["${{secret_dir}}/**"] },
      call: { file_path: "vault/keys.json" },
    },
    {
      name: "a dotted argument path",
      args: { "payload.path": ["vault/**"] },
      call: { payload: { path: "vault/keys.json" } },
    },
    {
      name: "a dotted argument path and a variable reference",
      args: { "payload.path": ["${{secret_dir}}/**"] },
      call: { payload: { path: "vault/keys.json" } },
    },
  ];

  for (const form of FORMS) {
    it(`grants on the allow side with ${form.name}`, () => {
      const v = verdict(specWith({ tool: "write_file", args: form.args }, "allow"), form.call);
      expect(v.decision).toBe("allow");
    });

    it(`blocks on the forbid side with ${form.name}`, () => {
      const v = verdict(specWith({ tool: "write_file", args: form.args }, "forbid"), form.call);
      expect(v.decision).toBe("block");
      expect(v.ruleId).toBe("tool.forbidden");
    });
  }

  it("fails closed when a forbid guard's reference cannot be resolved", () => {
    // The allow side denies an unresolvable reference by granting nothing. The
    // denial's mirror image is to match: an unresolved guard must not be the hole
    // a forbidden call slips through.
    const entry = { tool: "write_file", args: { file_path: ["${{missing_var}}/**"] } };
    const v = verdict(specWith(entry, "forbid"), { file_path: "vault/keys.json" });
    expect(v.decision).toBe("block");
  });
});
