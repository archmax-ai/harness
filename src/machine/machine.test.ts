import { describe, expect, it } from "vitest";
import type { BackendProtocolV2 } from "deepagents";
import { Workspace } from "../core/workspace.js";
import { afterHookLabel } from "../lifecycle/hook-shape.js";
import { WorkflowMachine } from "./machine.js";
import { MANUAL_TRIGGER, stateTriggerIds } from "./triggers.js";
import type { MachineSpec } from "./types.js";

const SPEC_PATHS = { workflowYaml: "workflow.yaml", workflow: "WORKFLOW.md" };

/** A machine spec served as `workflow.yaml` content (pure YAML mapping). */
function fm(yaml: string): string {
  return `${yaml.trim()}\n`;
}

const MACHINE_YAML = `
states:
  identify_case:
    triggers: { manual: }
    before: { script: hooks/check.js }
    tools:
      allow:
        - { tool: archmax_advance, args: { to: ["orders_question"] } }
    transitions:
      - to: orders_question
        description: User is asking about orders or shipping.
  orders_question:
    after: { subagent: judge }
    transitions:
      - to: done
        description: User has been answered.
  general_question:
    tools:
      allow:
        - { tool: write_file, args: { file_path: ["output/answer.json"] } }
    transitions:
      - to: done
        description: The question has been answered.
  open_state:
    transitions: []
  done:
`;

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

async function loadMachine(extra: Record<string, string> = {}) {
  const ws = workspaceWith({ "/workflow.yaml": fm(MACHINE_YAML), ...extra });
  const machine = await WorkflowMachine.load(ws, SPEC_PATHS);
  if (!machine) throw new Error("machine failed to load");
  return machine;
}

describe("WorkflowMachine.load", () => {
  it("returns null when the spec is absent", async () => {
    expect(await WorkflowMachine.load(workspaceWith({}), SPEC_PATHS)).toBeNull();
  });

  it("returns null when the file has no frontmatter", async () => {
    const ws = workspaceWith({ "/WORKFLOW.md": "# Just a heading\n\nNo frontmatter here.\n" });
    expect(await WorkflowMachine.load(ws, SPEC_PATHS)).toBeNull();
  });

  it("preserves declared runtime metadata", async () => {
    const yaml = `
runtime:
  engine: archmax-harness
  version: "1"
states:
  s:
    triggers: { manual: }
`;
    const ws = workspaceWith({ "/workflow.yaml": fm(yaml) });
    const m = (await WorkflowMachine.load(ws, SPEC_PATHS))!;
    expect(m.spec.runtime).toEqual({ engine: "archmax-harness", version: "1" });
  });

  it("preserves the legacy engine id verbatim for resolution to normalize", async () => {
    const yaml = `
runtime:
  engine: deep-agent-harness
  version: "1"
states:
  s:
    triggers: { manual: }
`;
    const ws = workspaceWith({ "/workflow.yaml": fm(yaml) });
    const m = (await WorkflowMachine.load(ws, SPEC_PATHS))!;
    expect(m.spec.runtime).toEqual({ engine: "deep-agent-harness", version: "1" });
  });

  it("loads successfully when runtime metadata is absent", async () => {
    const m = await loadMachine();
    expect(m.spec.runtime).toBeUndefined();
  });
});

describe("WorkflowMachine graph queries", () => {
  it("derives settings, hooks, and states", async () => {
    const m = await loadMachine();
    expect(m.entry).toBe("identify_case");
    expect(m.harnessSettings.timeoutMs).toBe(15_000);
    expect(m.lifecycleHooks().identify_case.before).toEqual([{ script: "hooks/check.js" }]);
    expect(m.lifecycleHooks().orders_question.after).toEqual([{ subagent: "judge" }]);
    expect(Object.keys(m.spec.states)).toEqual([
      "identify_case",
      "orders_question",
      "general_question",
      "open_state",
      "done",
    ]);
    expect(m.isTerminal("done")).toBe(true);
    expect(m.isTerminal("open_state")).toBe(true);
    expect(m.isTerminal("orders_question")).toBe(false);
  });

  it("derives start states from triggers, with legacy entry as manual", async () => {
    // The MACHINE_YAML fixture uses `entry: identify_case` and no triggers, so
    // the entry state is treated as the `manual` start state (back-compat).
    const m = await loadMachine();
    expect(m.startStateForTrigger(MANUAL_TRIGGER)).toBe("identify_case");
    expect(m.startStateForTrigger("manual")).toBe("identify_case");
    expect(m.startStateForTrigger("nope")).toBeUndefined();
    expect(m.startStates()).toEqual([{ trigger: "manual", state: "identify_case" }]);
  });

  it("reads declared triggers (manual + tool) over a legacy entry", () => {
    const spec = {
      entry: "ignored",
      states: {
        identify: { triggers: { manual: null }, transitions: [{ to: "answer", description: "Test edge to answer." }] },
        on_email: { triggers: { email_received: null }, transitions: [{ to: "answer", description: "Test edge to answer." }] },
        answer: {},
        ignored: {},
      },
    };
    const m = WorkflowMachine.fromSpec(spec);
    expect(m.startStateForTrigger(MANUAL_TRIGGER)).toBe("identify");
    expect(m.startStateForTrigger("email_received")).toBe("on_email");
    expect(m.startStates()).toEqual([
      { trigger: "manual", state: "identify" },
      { trigger: "email_received", state: "on_email" },
    ]);
  });

  /**
   * One entry for every ingress: the CLI, a host firing, and a delegation all
   * ask `startStateForTrigger(MANUAL_TRIGGER)`, and there is no second accessor
   * answering it differently for one of them.
   */
  it("answers both ingresses from one lookup", () => {
    const m = WorkflowMachine.fromSpec({
      states: { enrich: { triggers: { manual: { requires: ["order_id"], returns: ["summary"] } } } },
    } as unknown as MachineSpec);

    expect(m.startStateForTrigger(MANUAL_TRIGGER)).toBe("enrich");
    expect(m.entry).toBe(m.startStateForTrigger(MANUAL_TRIGGER));
    // And the signature both ingresses are held to is the one declaration.
    expect(m.requiresForTrigger(MANUAL_TRIGGER)).toEqual(["order_id"]);
    expect(m.returnsForTrigger(MANUAL_TRIGGER)).toEqual(["summary"]);
  });

  it("reports no entry for a machine only a host trigger can start", () => {
    const m = WorkflowMachine.fromSpec({
      states: { enrich: { triggers: { enrichment_requested: null } } },
    } as unknown as MachineSpec);

    expect(m.startStateForTrigger(MANUAL_TRIGGER)).toBeUndefined();
    expect(m.startStateForTrigger("enrichment_requested")).toBe("enrich");
  });

  // A host's own decoration rides inside the declaration; the key is still the id.
  it("keeps a host-decorated declaration keyed by its trigger id", () => {
    const spec = {
      states: {
        start: {
          triggers: {
            "outlook-mail": { type: "activepieces", piece: "microsoft-outlook", event: "newEmail" },
          },
          transitions: [{ to: "answer", description: "Test edge to answer." }],
        },
        identify: { triggers: { manual: null }, transitions: [{ to: "answer", description: "Test edge to answer." }] },
        answer: {},
      },
    };
    const m = WorkflowMachine.fromSpec(spec);
    expect(m.startStateForTrigger("outlook-mail")).toBe("start");
    expect(m.startStateForTrigger(MANUAL_TRIGGER)).toBe("identify");
    expect(m.startStates()).toEqual([
      { trigger: "outlook-mail", state: "start" },
      { trigger: "manual", state: "identify" },
    ]);
  });

  it("treats every id in a state's trigger list as a start trigger for it", () => {
    const spec: MachineSpec = {
      states: {
        intake: { triggers: { manual: null, "email-received": null }, transitions: [{ to: "answer", description: "Test edge to answer." }] },
        answer: {},
      },
    };
    const m = WorkflowMachine.fromSpec(spec);
    expect(m.startStateForTrigger(MANUAL_TRIGGER)).toBe("intake");
    expect(m.startStateForTrigger("email-received")).toBe("intake");
    expect(m.startStates()).toEqual([
      { trigger: "manual", state: "intake" },
      { trigger: "email-received", state: "intake" },
    ]);
  });

  it("reports the trigger ids a state declares, in declaration order", () => {
    const spec: MachineSpec = {
      states: {
        nightly: {
          triggers: { manual: null, scheduled: { schedule: "0 9 * * *" } as never },
          transitions: [{ to: "answer", description: "Test edge to answer." }],
        },
        answer: {},
      },
    };
    expect(stateTriggerIds(spec.states.nightly!)).toEqual(["manual", "scheduled"]);
    expect(stateTriggerIds(spec.states.answer!)).toEqual([]);
  });

  it("permits only essential tools when a state has no tools block (closed default)", async () => {
    const m = await loadMachine();
    expect(m.checkAllowed("open_state", "ls", {})).toBe(true);
    expect(m.checkAllowed("open_state", "grep", { pattern: "x" })).toBe(true);
    // The interpreter is part of that surface: evaluated code reaches only what
    // the state already permits, so running it is not itself a privilege.
    expect(m.checkAllowed("open_state", "archmax_eval", { code: "1 + 1" })).toBe(true);
    // Running an authored *file* is part of the same surface: an undeclared
    // state may execute any script, and a state entry narrows that grant.
    expect(m.checkAllowed("open_state", "archmax_run", { file_path: "scripts/x.js" })).toBe(true);
    expect(m.checkAllowed("open_state", "web_fetch", { url: "https://x" })).toBe(false);
  });

  it("allows essentials, blocks undeclared non-essentials in allow states", async () => {
    const m = await loadMachine();
    expect(m.checkAllowed("identify_case", "ls", {})).toBe(true);
    expect(m.checkAllowed("identify_case", "archmax_eval", { code: "1 + 1" })).toBe(true);
    expect(m.checkAllowed("identify_case", "archmax_run", { file_path: "scripts/x.js" })).toBe(true);
    expect(m.checkAllowed("identify_case", "web_fetch", { url: "https://x" })).toBe(false);
  });

  it("treats both sandbox entry points as always-on essentials in every state", () => {
    const states = {
      // An allow block that says nothing about the interpreter.
      s: { tools: { allow: ["web_fetch"] }, transitions: [{ to: "done", description: "Test edge to done." }] },
      done: {},
    };
    const m = WorkflowMachine.fromSpec({ states });
    for (const state of ["s", "done"]) {
      expect(m.checkAllowed(state, "archmax_eval", { code: "1 + 1" })).toBe(true);
      expect(m.disclosedTools(state).has("archmax_eval")).toBe(true);
      expect(m.describeAllowed(state)).toContain("archmax_eval");
      // The file-based entry point rides on the same grant.
      expect(m.checkAllowed(state, "archmax_run", { file_path: "scripts/x.js" })).toBe(true);
      expect(m.disclosedTools(state).has("archmax_run")).toBe(true);
    }
  });

  it("lets a state narrow the essential archmax_run grant to scoped files", () => {
    const m = WorkflowMachine.fromSpec({
      states: {
        s: {
          tools: { allow: [{ tool: "archmax_run", paths: ["scripts/**"] }] },
          transitions: [{ to: "done", description: "Test edge to done." }],
        },
        done: {},
      },
    });
    expect(m.checkAllowed("s", "archmax_run", { file_path: "scripts/x.js" })).toBe(true);
    expect(m.checkAllowed("s", "archmax_run", { file_path: "scratchpad/x.js" })).toBe(false);
    // `done` narrows nothing, so the unconstrained essential grant stands there.
    expect(m.checkAllowed("done", "archmax_run", { file_path: "scratchpad/x.js" })).toBe(true);
  });

  it("lets tools.forbid_always close the interpreter workflow-wide", () => {
    const m = WorkflowMachine.fromSpec({
      tools: { forbid_always: [{ tool: "archmax_eval" }] },
      states: { s: { triggers: { manual: null } as const } },
    });
    // The essential grant is a per-state default; a denial outranks it (the
    // kernel evaluates both denial stages ahead of the state's tools rule).
    expect(m.disclosedTools("s").has("archmax_eval")).toBe(false);
  });

  it("treats write_todos as an always-on essential in every state and profile", () => {
    const states = {
      s: { tools: { allow: ["read_file"] }, transitions: [{ to: "done", description: "Test edge to done." }] },
      done: {},
    };
    // Standard equipment, like the filesystem surface: no opt-in, nothing to
    // withhold, and the same answer in a terminal state.
    for (const m of [WorkflowMachine.fromSpec({ states })]) {
      for (const state of ["s", "done"]) {
        expect(m.checkAllowed(state, "write_todos", {})).toBe(true);
        expect(m.disclosedTools(state).has("write_todos")).toBe(true);
        expect(m.describeAllowed(state)).toContain("write_todos");
      }
    }
  });

  it("never treats task as essential, whatever the workflow declares", () => {
    // `task` is the runtime's own dispatch for grading rubrics. Registered
    // rubrics make the tool exist in the assembled list, but nothing puts it in
    // front of the model: disclosure withholds it and the kernel refuses it.
    const machine = WorkflowMachine.fromSpec({
      rubrics: { tone: { instructions: "judge the tone" } },
      states: { start: { triggers: { manual: null }, after: { rubric: "tone" } } },
    } as never);
    expect(machine.disclosedTools("start").has("task")).toBe(false);
  });

  it("discloses a conditional built-in in exactly the state that grants it", () => {
    const m = WorkflowMachine.fromSpec({
      states: {
        s: { tools: { allow: ["task"] }, transitions: [{ to: "done", description: "Test edge to done." }] },
        done: {},
      },
    });
    expect(m.disclosedTools("s").has("task")).toBe(true);
    expect(m.disclosedTools("done").has("task")).toBe(false);
  });

  it("always allows archmax_advance regardless of target (edge check gates the target)", async () => {
    const m = await loadMachine();
    // Static governance no longer scopes archmax_advance; any target is permitted
    // here and the transition edge check rejects undeclared targets separately.
    expect(m.checkAllowed("identify_case", "archmax_advance", { to: "orders_question" })).toBe(true);
    expect(m.checkAllowed("identify_case", "archmax_advance", { to: "done" })).toBe(true);
    expect(m.checkAllowed("general_question", "archmax_advance", { to: "done" })).toBe(true);
  });

  it("treats host-declared essentialTools as always-on (disclosed and permitted everywhere)", () => {
    const spec = {
      states: {
        // A terminal state with no tools block: only essentials are open.
        answer: { triggers: { manual: null } as const },
      },
    };
    const m = WorkflowMachine.fromSpec(spec, ["get_markdown", "move_file"]);

    // Permitted in a state that declares nothing, exactly like a built-in.
    expect(m.checkAllowed("answer", "get_markdown", { path: "a.pdf" })).toBe(true);
    expect(m.checkAllowed("answer", "move_file", { source: "a", destination: "b" })).toBe(true);
    // An undeclared, non-essential tool is still closed by default.
    expect(m.checkAllowed("answer", "download", { url: "https://x" })).toBe(false);

    // Disclosed to the model alongside the built-in surface.
    const disclosed = m.disclosedTools("answer");
    expect(disclosed.has("get_markdown")).toBe(true);
    expect(disclosed.has("move_file")).toBe(true);
    expect(disclosed.has("download")).toBe(false);
    expect(disclosed.has("read_file")).toBe(true);

    // Surfaced in the human/agent-facing allow description.
    expect(m.describeAllowed("answer")).toContain("get_markdown");
  });

  it("keeps the essential set unchanged when no essentialTools are declared", () => {
    const spec = { states: { answer: { triggers: { manual: null } as const } } };
    const m = WorkflowMachine.fromSpec(spec);
    expect(m.checkAllowed("answer", "get_markdown", { path: "a.pdf" })).toBe(false);
    expect(m.disclosedTools("answer").has("get_markdown")).toBe(false);
    expect(m.disclosedTools("answer").has("read_file")).toBe(true);
  });

  it("allows any args when an allow entry omits args", async () => {
    const yaml = `
states:
  s:
    triggers: { manual: }
    tools:
      allow: [ls]
`;
    const ws = workspaceWith({ "/workflow.yaml": fm(yaml) });
    const m = (await WorkflowMachine.load(ws, SPEC_PATHS))!;
    expect(m.checkAllowed("s", "ls", { any: "thing" })).toBe(true);
  });

  it("resolves transitions and their descriptions", async () => {
    const m = await loadMachine();
    expect(m.getTransition("identify_case", "orders_question")).toBeDefined();
    expect(m.transitionTargets("identify_case")).toEqual(["orders_question"]);
    const route = m.getTransition("identify_case", "orders_question");
    expect(route?.description).toContain("orders");

    expect(m.getTransition("general_question", "done")).toBeDefined();
  });

  it("exposes per-state instructions when declared", async () => {
    const yaml = `
states:
  a:
    triggers: { manual: }
    instructions: "Read skills/a/SKILL.md and answer."
    transitions:
      - to: done
        description: finish
  b:
    transitions:
      - to: done
        description: finish
  done:
`;
    const ws = workspaceWith({ "/workflow.yaml": fm(yaml) });
    const m = (await WorkflowMachine.load(ws, SPEC_PATHS))!;
    expect(m.spec.states.a?.instructions).toBe("Read skills/a/SKILL.md and answer.");
    expect(m.spec.states.b?.instructions).toBeUndefined();
    expect(m.spec.states.missing?.instructions).toBeUndefined();
  });

  it("exposes a state's title when declared, keyed by slug", async () => {
    const yaml = `
states:
  a:
    triggers: { manual: }
    title: "Do the thing"
    transitions:
      - to: done
        description: finish
  done: {}
`;
    const ws = workspaceWith({ "/workflow.yaml": fm(yaml) });
    const m = (await WorkflowMachine.load(ws, SPEC_PATHS))!;
    expect(m.spec.states.a?.title).toBe("Do the thing");
    // Untitled and unknown states both have no title; the slug stays the identity.
    expect(m.spec.states.done?.title).toBeUndefined();
    expect(m.spec.states["Do the thing"]).toBeUndefined();
    expect(Object.keys(m.spec.states)).toEqual(["a", "done"]);
  });
});

describe("WorkflowMachine lifecycle hook normalization", () => {
  const YAML = `
states:
  a:
    triggers: { manual: }
    before:
      - { script: hooks/check.js }
      - { subagent: precheck }
    after: { script: hooks/after.js }
    transitions:
      - to: b
        description: go
  b:
    transitions: []
  done:
`;

  async function load() {
    const ws = workspaceWith({ "/workflow.yaml": fm(YAML) });
    const m = await WorkflowMachine.load(ws, SPEC_PATHS);
    if (!m) throw new Error("machine failed to load");
    return m;
  }

  it("preserves an ordered list of before hooks", async () => {
    const m = await load();
    expect(m.lifecycleHooks().a.before).toEqual([
      { script: "hooks/check.js" },
      { subagent: "precheck" },
    ]);
  });

  it("wraps a single after hook in a one-element list", async () => {
    const m = await load();
    expect(m.lifecycleHooks().a.after).toEqual([{ script: "hooks/after.js" }]);
  });

  it("labels tagged script and subagent hooks", () => {
    expect(afterHookLabel({ script: "hooks/x.js" })).toBe("hooks/x.js");
    expect(afterHookLabel({ subagent: "judge" })).toBe("subagent:judge");
  });
});

describe("WorkflowMachine allow-only governance and allow_always", () => {
  const YAML = `
tools:
  allow_always:
    - read_file
    - { tool: move_file, paths: ["output/**"] }
    - { tool: write_file, args: { file_path: ["output/**"] } }
states:
  constrained:
    triggers: { manual: }
    tools:
      allow:
        - { tool: read_file, args: { file_path: ["skills/**"] } }
        - { tool: archmax_run, paths: ["scripts/**"] }
    transitions:
      - to: done
        description: go
  done:
`;

  async function load() {
    const ws = workspaceWith({ "/workflow.yaml": fm(YAML) });
    const m = await WorkflowMachine.load(ws, SPEC_PATHS);
    if (!m) throw new Error("machine failed to load");
    return m;
  }

  it("permits allow_always non-essential tools not mentioned by an allow state", async () => {
    const m = await load();
    // move_file is not essential and not in `constrained`'s allow list, but
    // allow_always grants it for output/**.
    expect(m.checkAllowed("constrained", "move_file", { file_path: "output/x.json" })).toBe(true);
    expect(m.checkAllowed("constrained", "move_file", { file_path: "other/x.json" })).toBe(false);
  });

  it("lets a state narrow the file-based sandbox tool it declares", async () => {
    const m = await load();
    // `constrained` declares archmax_run for scripts/**, which narrows the
    // essential grant there; `done` declares nothing, so it keeps the grant.
    expect(m.checkAllowed("constrained", "archmax_run", { file_path: "scripts/x.js" })).toBe(true);
    expect(m.checkAllowed("constrained", "archmax_run", { file_path: "other/x.js" })).toBe(false);
    expect(m.checkAllowed("done", "archmax_run", { file_path: "other/x.js" })).toBe(true);
    // The interpreter, essential too, is open in both.
    expect(m.checkAllowed("done", "archmax_eval", { code: "1 + 1" })).toBe(true);
  });

  it("treats an allow_always constraint on an essential tool as inert", async () => {
    const m = await load();
    // write_file is essential; the essential grant passes before allow_always
    // is consulted, so the output/** constraint there does not bind.
    expect(m.checkAllowed("constrained", "write_file", { file_path: "output/x.json" })).toBe(true);
    expect(m.checkAllowed("constrained", "write_file", { file_path: "notes/x.json" })).toBe(true);
  });

  it("lets a per-state allow constraint override the essential grant", async () => {
    const m = await load();
    // read_file is essential (and in allow_always) but the state constrains it
    // to skills/** — the narrower state entry wins.
    expect(m.checkAllowed("constrained", "read_file", { file_path: "skills/a.md" })).toBe(true);
    expect(m.checkAllowed("constrained", "read_file", { file_path: "data/orders.json" })).toBe(false);
  });

  it("permits essentials but not undeclared non-essentials in a no-tools state", async () => {
    const m = await load();
    expect(m.checkAllowed("done", "ls", {})).toBe(true);
    expect(m.checkAllowed("done", "write_file", { file_path: "anywhere/x.json" })).toBe(true);
    expect(m.checkAllowed("done", "web_fetch", { url: "https://x" })).toBe(false);
  });

  it("describes a no-tools state as the essential surface it enforces", async () => {
    const m = await load();
    const text = m.describeAllowed("done");
    expect(text).toContain("ls");
    expect(text).toContain("read_file");
    expect(text).toContain("move_file(file_path=output/**)");
    // The planning scratchpad and the interpreter are part of the essential
    // surface everywhere, and `done` narrows neither.
    expect(text).toContain("write_todos");
    expect(text).toContain("archmax_eval");
    expect(text).not.toContain("archmax_eval(");
    // `archmax_run` is declared in `constrained` only, so it is absent here.
    expect(text).not.toContain("archmax_run(");
    expect(text).not.toContain("(all tools)");
    // `done` is terminal, so archmax_advance can never succeed there.
    expect(text).not.toContain("archmax_advance");
    // The allow_always write_file constraint is inert (essential wins first).
    expect(text).not.toContain("write_file(file_path=output/**)");
  });

  it("describes an allow state from the same entries it enforces", async () => {
    const m = await load();
    const text = m.describeAllowed("constrained");
    expect(text).toContain("read_file(file_path=skills/**)");
    expect(text).toContain("write_todos");
    expect(text).toContain("archmax_advance");
    // write_file is essential and not narrowed by the state, so it renders
    // unconstrained; the inert allow_always constraint is not presented.
    expect(text).toContain("write_file");
    expect(text).not.toContain("write_file(file_path=output/**)");
  });

  it("describes the argument constraints that bind in an allow state", async () => {
    const m = await load();
    const lines = m.describeArgConstraints("constrained");
    // The state's own arg-constrained entry.
    expect(lines).toContain("- read_file: file_path must match 'skills/**'");
    // An allow_always arg-constrained grant that binds (non-essential, not mentioned).
    expect(lines).toContain("- move_file: file_path must match 'output/**'");
    // The state's own entry granting the file-based sandbox tool binds too.
    expect(lines).toContain("- archmax_run: file_path must match 'scripts/**'");
    // The inert allow_always constraint on an essential tool is not presented.
    expect(lines.join("\n")).not.toContain("write_file");
  });

  it("describes only binding allow_always constraints in a no-tools state", async () => {
    const m = await load();
    const lines = m.describeArgConstraints("done");
    // `constrained`'s archmax_run entry is that state's, not the workflow's.
    expect(lines).toEqual(["- move_file: file_path must match 'output/**'"]);
  });

  it("returns no argument constraints when none are declared", async () => {
    const yaml = `
states:
  s:
    triggers: { manual: }
    tools:
      allow: [ls, web_fetch]
`;
    const ws = workspaceWith({ "/workflow.yaml": fm(yaml) });
    const m = (await WorkflowMachine.load(ws, SPEC_PATHS))!;
    expect(m.describeArgConstraints("s")).toEqual([]);
  });

  it("lists every allowed value of a multi-glob argument constraint", async () => {
    const yaml = `
states:
  s:
    triggers: { manual: }
    tools:
      allow:
        - { tool: move_email, args: { destinationFolderId: ["AQMkFolderA=", "AQMkFolderB="] } }
`;
    const ws = workspaceWith({ "/workflow.yaml": fm(yaml) });
    const m = (await WorkflowMachine.load(ws, SPEC_PATHS))!;
    expect(m.describeArgConstraints("s")).toEqual([
      "- move_email: destinationFolderId must match one of: 'AQMkFolderA=', 'AQMkFolderB='",
    ]);
  });

  it("discloses essentials, allow_always, state entries, and archmax_advance per state", async () => {
    const m = await load();
    const constrained = m.disclosedTools("constrained");
    expect(constrained.has("read_file")).toBe(true);
    expect(constrained.has("archmax_run")).toBe(true);
    expect(constrained.has("ls")).toBe(true);
    expect(constrained.has("archmax_advance")).toBe(true);
    expect(constrained.has("web_fetch")).toBe(false);

    const done = m.disclosedTools("done");
    expect(done.has("archmax_advance")).toBe(false);
    // Essentials are disclosed even in a terminal state.
    expect(done.has("write_todos")).toBe(true);
  });

  it("never discloses a tool tools.forbid_always denies", () => {
    const m = WorkflowMachine.fromSpec({
      tools: { forbid_always: [{ tool: "archmax_run" }] },
      states: {
        s: { tools: { allow: ["archmax_run", "web_fetch"] }, transitions: [{ to: "done", description: "Test edge to done." }] },
        done: {},
      },
    });
    const disclosed = m.disclosedTools("s");
    expect(disclosed.has("archmax_run")).toBe(false);
    expect(disclosed.has("web_fetch")).toBe(true);
  });

  it("hides a tool the active state denies, and only there", () => {
    const m = WorkflowMachine.fromSpec({
      tools: { allow_always: [{ tool: "web_fetch" }] },
      states: {
        route: { tools: { forbid: [{ tool: "web_fetch" }] }, transitions: [{ to: "work", description: "Test edge to work." }] },
        work: { transitions: [{ to: "done", description: "Test edge to done." }] },
        done: {},
      },
    });
    expect(m.disclosedTools("route").has("web_fetch")).toBe(false);
    expect(m.disclosedTools("work").has("web_fetch")).toBe(true);
    expect(m.describeAllowed("route")).not.toContain("web_fetch");
  });

  it("keeps a guarded denial disclosed, because it denies only some calls", () => {
    const m = WorkflowMachine.fromSpec({
      tools: {
        allow_always: [{ tool: "write_file" }],
        forbid_always: [{ tool: "write_file", paths: ["logs/**"] }],
      },
      states: { s: { triggers: { manual: null } as const } },
    });
    // Name-level disclosure, argument enforcement at call time — the same rule
    // the grant side follows for a guarded allow entry.
    expect(m.disclosedTools("s").has("write_file")).toBe(true);
  });

  it("reports which level denies a skill, for the refusal's reason", () => {
    const m = WorkflowMachine.fromSpec({
      skills: { allow_always: ["orders"], forbid_always: ["secrets"] },
      states: {
        route: { skills: { forbid: ["orders"] }, transitions: [{ to: "done", description: "Test edge to done." }] },
        done: {},
      },
    });
    expect(m.skillDenial("route", "secrets")).toBe("workflow");
    expect(m.skillDenial("route", "orders")).toBe("state");
    expect(m.skillDenial("done", "orders")).toBeUndefined();
    expect(m.forbiddenSkills("route")).toEqual(["secrets", "orders"]);
  });

});


describe("delegation targets", () => {
  const withAllow = (allow: string) =>
    fm(`
title: Delegating
states:
  triage:
    triggers: { manual: }
    tools:
${allow}
    transitions:
      - to: done
        description: Done.
  open_state:
    transitions: []
  done:
`);

  const load = async (yaml: string) => {
    const machine = await WorkflowMachine.load(
      workspaceWith({ "/workflow.yaml": yaml }),
      SPEC_PATHS,
    );
    if (!machine) throw new Error("machine failed to load");
    return machine;
  };

  it("reads targets off a state's allow list and off allow_always", async () => {
    const machine = await load(
      fm(`
title: Delegating
tools:
  allow_always:
    - archmax_workflow_audit
states:
  triage:
    triggers: { manual: }
    tools:
      allow:
        - read_file
        - archmax_workflow_enrich-order
    transitions: []
`),
    );
    expect(machine.delegationTargets().sort()).toEqual(["audit", "enrich-order"]);
  });

  it("resolves nothing for a workflow that names no target", async () => {
    const machine = await load(withAllow("      allow:\n        - read_file"));
    expect(machine.delegationTargets()).toEqual([]);
  });

  it("gives a state that names no target none", async () => {
    // Nothing special about delegation here: the surface is closed by default,
    // so a state that names no target may call none.
    const machine = await load(
      fm(`
title: Delegating
states:
  triage:
    triggers: { manual: }
    tools:
      allow:
        - archmax_workflow_enrich-order
    transitions:
      - to: open_state
        description: Continue.
  open_state:
    transitions: []
`),
    );
    expect(machine.delegationTargets("triage")).toEqual(["enrich-order"]);
    expect(machine.delegationTargets("open_state")).toEqual([]);
  });

  it("grants an allow_always target to every state", async () => {
    const machine = await load(
      fm(`
title: Delegating
tools:
  allow_always:
    - archmax_workflow_audit
states:
  triage:
    triggers: { manual: }
    transitions: []
`),
    );
    expect(machine.delegationTargets("triage")).toEqual(["audit"]);
  });

  it("discloses and permits a delegation tool the state names", async () => {
    const machine = await load(
      withAllow("      allow:\n        - archmax_workflow_enrich-order"),
    );
    // No rule of its own: it is disclosed and enforced by exactly the mechanism
    // every other named non-essential tool is.
    expect(machine.disclosedTools("triage").has("archmax_workflow_enrich-order")).toBe(true);
    expect(machine.checkAllowed("triage", "archmax_workflow_enrich-order", {})).toBe(true);
  });

  it("blocks a delegation tool a state does not name", async () => {
    const machine = await load(withAllow("      allow:\n        - read_file"));
    expect(machine.disclosedTools("triage").has("archmax_workflow_enrich-order")).toBe(false);
    expect(machine.checkAllowed("triage", "archmax_workflow_enrich-order", {})).toBe(false);
    // Not rescued by the always-allowed or essential sets, which is what keeps
    // the closed-by-default rule sufficient here.
    expect(machine.checkAllowed("open_state", "archmax_workflow_enrich-order", {})).toBe(false);
  });

  it("keeps a denied delegation tool undisclosed", async () => {
    const machine = await load(
      fm(`
title: Delegating
tools:
  forbid_always:
    - archmax_workflow_enrich-order
states:
  triage:
    triggers: { manual: }
    tools:
      allow:
        - archmax_workflow_enrich-order
    transitions: []
`),
    );
    expect(machine.disclosedTools("triage").has("archmax_workflow_enrich-order")).toBe(false);
  });

  it("moves the spec hash when the target set changes", async () => {
    const before = await load(withAllow("      allow:\n        - read_file"));
    const after = await load(
      withAllow("      allow:\n        - read_file\n        - archmax_workflow_enrich-order"),
    );
    expect(after.specHash).not.toBe(before.specHash);
  });
});

describe("WorkflowMachine.disabled", () => {
  const states = { a: { triggers: { [MANUAL_TRIGGER]: null }, transitions: [] } };

  it("reports a spec with no `disabled` key as enabled", () => {
    expect(WorkflowMachine.fromSpec({ states }).disabled).toBe(false);
  });

  it("reads `disabled: false` as enabled", () => {
    expect(WorkflowMachine.fromSpec({ states, disabled: false }).disabled).toBe(false);
  });

  it("reads `disabled: true` as disabled", () => {
    expect(WorkflowMachine.fromSpec({ states, disabled: true }).disabled).toBe(true);
  });

  it("reads an explicit null as enabled — the key is declared and cleared", () => {
    const spec = { states, disabled: null } as unknown as MachineSpec;
    expect(WorkflowMachine.fromSpec(spec).disabled).toBe(false);
  });

  // Fail-closed: a switch whose purpose is to stop turns reads an
  // uninterpretable value as *stopped*. `validate` reports the value itself.
  it.each([
    ["a string", "no"],
    ["the string 'false'", "false"],
    ["a number", 0],
    ["a mapping", { reason: "retired" }],
    ["a list", ["retired"]],
  ])("reads %s as disabled", (_label, value) => {
    const spec = { states, disabled: value } as unknown as MachineSpec;
    expect(WorkflowMachine.fromSpec(spec).disabled).toBe(true);
  });

  it("is still a usable machine — the flag is not a load failure", async () => {
    const warnings: string[] = [];
    const machine = await WorkflowMachine.load(
      workspaceWith({ "/workflow.yaml": fm(`disabled: true\n${MACHINE_YAML}`) }),
      SPEC_PATHS,
      (event) => {
        if (event.type === "warning") warnings.push(event.message);
      },
    );
    expect(machine).not.toBeNull();
    // Reported, not refused: the flag is a lint warning on the load.
    expect(warnings.some((w) => w.includes("is disabled"))).toBe(true);
    expect(machine?.disabled).toBe(true);
    expect(machine?.startStateForTrigger(MANUAL_TRIGGER)).toBe("identify_case");
  });

  it("moves the spec hash, so a run records which definition it ran under", () => {
    expect(WorkflowMachine.fromSpec({ states, disabled: true }).specHash).not.toBe(
      WorkflowMachine.fromSpec({ states }).specHash,
    );
  });
});

describe("the model a state runs on", () => {
  const spec: MachineSpec = {
    settings: { model: "small-model" },
    states: {
      triage: { triggers: { [MANUAL_TRIGGER]: null }, transitions: [{ to: "draft", description: "Test edge to draft." }] },
      draft: { model: "large-model", transitions: [{ to: "done", description: "Test edge to done." }] },
      done: {},
    },
  };

  it("reads the state's id, then the workflow's", () => {
    const machine = WorkflowMachine.fromSpec(spec);
    expect(machine.modelFor("draft")).toBe("large-model");
    expect(machine.modelFor("triage")).toBe("small-model");
  });

  it("leaves the choice to the assembly when neither position names one", () => {
    const machine = WorkflowMachine.fromSpec({ states: spec.states });
    expect(machine.modelFor("draft")).toBe("large-model");
    expect(machine.modelFor("triage")).toBeUndefined();
  });

  it("lists every distinct declared id, the workflow's first", () => {
    expect(WorkflowMachine.fromSpec(spec).declaredModels()).toEqual([
      "small-model",
      "large-model",
    ]);
    expect(WorkflowMachine.fromSpec({ states: { a: {} } }).declaredModels()).toEqual([]);
  });

  it("moves the spec hash, because a declared model changes what runs", () => {
    expect(WorkflowMachine.fromSpec(spec).specHash).not.toBe(
      WorkflowMachine.fromSpec({ states: spec.states }).specHash,
    );
  });
});
