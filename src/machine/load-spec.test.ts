import { describe, expect, it } from "vitest";
import type { BackendProtocolV2 } from "deepagents";
import { Workspace } from "../core/workspace.js";
import { loadMachineSpec, type WorkflowSpecPaths } from "./load-spec.js";
import { WorkflowMachine } from "./machine.js";
import { stateTriggerIds } from "./triggers.js";

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

const PATHS: WorkflowSpecPaths = {
  workflowYaml: "workflow.yaml",
  workflow: "WORKFLOW.md",
};

const FRONTMATTER_MD = `---
states:
  a:
    triggers: { manual: }
    transitions:
      - to: done
        description: Test edge to done.
  done: {}
---
Overview.
`;

const VALID_YAML = `states:
  a:
    triggers: { manual: }
    transitions:
      - to: done
        description: Test edge to done.
  done: {}
`;

describe("loadMachineSpec (v2 layout)", () => {
  it("loads workflow.yaml as the machine and WORKFLOW.md as prose", async () => {
    const ws = workspaceWith({
      "/workflow.yaml": VALID_YAML,
      "/WORKFLOW.md": "Prose addendum.\n",
    });
    const result = await loadMachineSpec(ws, PATHS);
    expect(result.usable).toBe(true);
    expect(result.specFile).toBe("workflow.yaml");
    expect(Object.keys(result.spec?.states ?? {})).toEqual(["a", "done"]);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(result.body.trim()).toBe("Prose addendum.");
  });

  it("loads without a WORKFLOW.md at all (prose optional)", async () => {
    const ws = workspaceWith({ "/workflow.yaml": VALID_YAML });
    const result = await loadMachineSpec(ws, PATHS);
    expect(result.usable).toBe(true);
    expect(result.body).toBe("");
  });

  it("rejects a sibling WORKFLOW.md with frontmatter (competing machines)", async () => {
    const ws = workspaceWith({
      "/workflow.yaml": VALID_YAML,
      "/WORKFLOW.md": FRONTMATTER_MD,
    });
    const result = await loadMachineSpec(ws, PATHS);
    expect(result.usable).toBe(false);
    expect(result.issues.map((i) => i.kind)).toContain("competing-machines");
  });

  it("fails closed on a malformed workflow.yaml", async () => {
    const ws = workspaceWith({ "/workflow.yaml": "- just\n- a list\n" });
    const result = await loadMachineSpec(ws, PATHS);
    expect(result.usable).toBe(false);
    expect(result.spec).toBeNull();
    expect(result.issues.map((i) => i.kind)).toEqual(["not-a-mapping"]);
  });

});

describe("loadMachineSpec (no workflow.yaml)", () => {
  it("reports a missing workflow when nothing is present", async () => {
    const ws = workspaceWith({});
    const result = await loadMachineSpec(ws, PATHS);
    expect(result.usable).toBe(false);
    expect(result.spec).toBeNull();
    expect(result.issues.map((i) => i.kind)).toEqual(["missing"]);
  });

  it("treats a prose-only WORKFLOW.md (no frontmatter) as missing", async () => {
    const ws = workspaceWith({ "/WORKFLOW.md": "no frontmatter here" });
    const result = await loadMachineSpec(ws, PATHS);
    expect(result.issues.map((i) => i.kind)).toEqual(["missing"]);
  });

  it("flags missing states in workflow.yaml, keeping the spec object", async () => {
    const ws = workspaceWith({ "/workflow.yaml": "title: Incomplete\n" });
    const result = await loadMachineSpec(ws, PATHS);
    expect(result.usable).toBe(false);
    expect(result.issues.map((i) => i.kind)).toContain("schema");
    expect(result.issues.find((i) => i.kind === "schema")?.field).toBe("states");
  });

  it("loads a spec that declares the root title", async () => {
    const ws = workspaceWith({
      "/workflow.yaml": "title: Order lookup\nstates:\n  only:\n    triggers: { manual: }\n",
    });
    const result = await loadMachineSpec(ws, PATHS);
    expect(result.usable).toBe(true);
    expect(result.spec?.title).toBe("Order lookup");
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("loads a spec that declares the root instructions", async () => {
    const ws = workspaceWith({
      "/workflow.yaml":
        "instructions: |\n  Cite evidence before answering.\nstates:\n  only:\n    triggers: { manual: }\n",
    });
    const result = await loadMachineSpec(ws, PATHS);
    expect(result.usable).toBe(true);
    expect(result.spec?.instructions).toBe("Cite evidence before answering.\n");
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  // The removal is scoped to the spec root — an edge's `description` is still its
  // semantic routing guidance.
  it("leaves transition descriptions alone", async () => {
    const ws = workspaceWith({
      "/workflow.yaml":
        "states:\n  only:\n    triggers: { manual: }\n    transitions:\n" +
        "      - to: done\n        description: the question is answered\n  done:\n    instructions: stop\n",
    });
    const result = await loadMachineSpec(ws, PATHS);
    expect(result.usable).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(result.spec?.states?.only?.transitions?.[0]?.description).toBe(
      "the question is answered",
    );
  });

  it("flags a spec with states but no declared start state", async () => {
    const ws = workspaceWith({
      "/workflow.yaml": "states:\n  only:\n    instructions: do it\n",
    });
    const result = await loadMachineSpec(ws, PATHS);
    expect(result.usable).toBe(false);
    expect(result.spec).not.toBeNull();
    expect(result.issues.map((i) => i.message).join("\n")).toContain("no start state");
  });

});

/**
 * A host may keep its authoring UI's own state in `workflow.yaml`, keyed by the
 * slugs the spec defines. Strictness closed the root to it; the `metadata` slot
 * reopens exactly that much, and this is the spec that must load.
 */
describe("loadMachineSpec (host metadata)", () => {
  const WITH_EDITOR = `title: T
runtime: { engine: archmax-harness, version: "2" }
metadata:
  nodes:
    a: { x: 1, y: 2 }
  edges:
    "a->done": { x: 12, y: -8 }
states:
  a:
    triggers: { manual: }
    transitions:
      - to: done
        description: Test edge to done.
  done: {}
`;

  it("loads a spec carrying an metadata block, unchanged", async () => {
    const ws = workspaceWith({ "/workflow.yaml": WITH_EDITOR });
    const result = await loadMachineSpec(ws, PATHS);
    expect(result.usable).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(result.spec?.metadata).toEqual({
      nodes: { a: { x: 1, y: 2 } },
      edges: { "a->done": { x: 12, y: -8 } },
    });
  });
});

describe("loadMachineSpec (a trigger's declaration)", () => {
  /** A one-state spec whose `chat` trigger declares whatever the case is about. */
  const specWith = (declaration: string): Workspace => {
    const body = declaration.replace(/^(?=.)/gm, "    ");
    return workspaceWith({
      "/workflow.yaml": `states:\n  intake:\n    triggers:\n      chat:\n${body}`,
    });
  };

  const errors = (result: Awaited<ReturnType<typeof loadMachineSpec>>): string[] =>
    result.issues.filter((i) => i.severity === "error").map((i) => i.message);

  it("loads a declaration carrying the host-resolved keys", async () => {
    const result = await loadMachineSpec(
      specWith(
        "    session: triggers.-1.threadId\n    message: triggers.-1.text\n" +
          "    connection: acme-oidc\n",
      ),
      PATHS,
    );
    expect(errors(result)).toEqual([]);
    expect(result.usable).toBe(true);
  });

  it("accepts message: false without parsing it as a path", async () => {
    const result = await loadMachineSpec(specWith("    message: false\n"), PATHS);
    expect(errors(result)).toEqual([]);
    expect(result.usable).toBe(true);
    expect(result.spec?.states.intake?.triggers?.chat?.message).toBe(false);
  });

  it("reports a malformed message path as a session path's twin", async () => {
    const result = await loadMachineSpec(specWith('    message: "${{triggers.-1.text}}"\n'), PATHS);
    expect(result.usable).toBe(false);
    expect(errors(result)).toEqual([
      "workflow.yaml: 'states.intake.triggers.chat.message': write the bare path, not a '${{…}}' reference " +
        "(e.g. 'conversation_id').",
    ]);
  });

  it("reports a connection that is not a slug", async () => {
    const result = await loadMachineSpec(specWith('    connection: ""\n'), PATHS);
    expect(result.usable).toBe(false);
    expect(errors(result).join("\n")).toContain(
      "'states.intake.triggers.chat.connection': must be a non-empty string naming an access connection",
    );
  });

  // A host decoration the SDK does not know is not a reason to take down every
  // run of the workflow: the machine is fully determined without it.
  it("warns on an unknown declaration key and still loads", async () => {
    const result = await loadMachineSpec(
      specWith("    session: conversation_id\n    nonsense: 1\n"),
      PATHS,
    );
    expect(result.usable).toBe(true);
    expect(errors(result)).toEqual([]);
    const warning = result.lint.find((i) => i.field === "states.intake.triggers.chat");
    expect(warning?.kind).toBe("lint");
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain("declares unknown key 'nonsense', which the SDK ignores");
  });

  it("loads a declared signature and stops calling either key unknown", async () => {
    const result = await loadMachineSpec(
      specWith("    requires: [order_id]\n    returns: [enrichment_file]\n"),
      PATHS,
    );
    expect(errors(result)).toEqual([]);
    expect(result.usable).toBe(true);
    expect(result.lint.filter((i) => i.field === "states.intake.triggers.chat")).toEqual([]);
  });

  // Unlike an unknown host key, a malformed signature takes the spec down: it is
  // a contract the runtime would otherwise enforce, and one it cannot read
  // governs nothing at the very boundary it was written for.
  it("fails closed on a malformed signature", async () => {
    const result = await loadMachineSpec(specWith('    returns: ["Order Summary"]\n'), PATHS);
    expect(result.usable).toBe(false);
    expect(errors(result)).toEqual([
      "workflow.yaml: 'states.intake.triggers.chat.returns.0': 'Order Summary' is not a valid run-variable " +
        "name. Use lowercase letters, digits and underscores, starting with a letter (e.g. 'order_id').",
    ]);
  });

  it("fails closed on a signature that is not a list", async () => {
    const result = await loadMachineSpec(specWith("    requires: order_id\n"), PATHS);
    expect(result.usable).toBe(false);
    expect(errors(result).join("\n")).toContain(
      "'states.intake.triggers.chat.requires': must be a list of run-variable names",
    );
  });

  it("fails closed on the reserved trigger variable as a return", async () => {
    const result = await loadMachineSpec(specWith("    returns: [trigger]\n"), PATHS);
    expect(result.usable).toBe(false);
    expect(errors(result).join("\n")).toContain("is the built-in trigger variable");
  });

  it("fails closed on the reserved title variable as a return", async () => {
    const result = await loadMachineSpec(specWith("    returns: [title]\n"), PATHS);
    expect(result.usable).toBe(false);
    expect(errors(result).join("\n")).toContain("is the built-in title variable");
  });

  // The other half of the rule: a signature may *require* either built-in.
  it("accepts the title variable as a requirement", async () => {
    const result = await loadMachineSpec(specWith("    requires: [title]\n"), PATHS);
    expect(result.usable).toBe(true);
  });

  // The declaration sits on the state it enters, so `entry:` has nothing left to
  // name — and a loose object that swallowed it would start the run elsewhere.
  it("refuses an 'entry' key, naming the state the declaration sits on", async () => {
    const result = await loadMachineSpec(specWith("    entry: ghost\n"), PATHS);
    expect(result.usable).toBe(false);
    expect(errors(result).join("\n")).toContain("'states.intake.triggers.chat.entry'");
    expect(errors(result).join("\n")).toContain("IS its entry state");
  });

  it("refuses a 'name' key, naming the key the declaration sits under", async () => {
    const result = await loadMachineSpec(specWith("    name: slack-message\n"), PATHS);
    expect(result.usable).toBe(false);
    expect(errors(result).join("\n")).toContain("'states.intake.triggers.chat.name'");
    expect(errors(result).join("\n")).toContain("IS the trigger id");
  });
});

describe("loadMachineSpec — delegation and sub-workflow settings", () => {
  const DELEGATING = `states:
  start:
    triggers: { manual: }
    tools:
      allow:
        - archmax_workflow_enrich-account
    transitions:
      - to: done
        description: Test edge to done.
  done: {}
`;

  it("loads a state that may call a sibling workflow", async () => {
    const ws = workspaceWith({ "/workflow.yaml": DELEGATING });
    const result = await loadMachineSpec(ws, PATHS);
    expect(result.usable).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  // `settings.sub_workflows` is no longer part of `workflow.yaml`: how far a run
  // may multiply itself is the dispatcher's configuration, not a property of the
  // machine — a workflow does not know how deeply someone else will delegate to
  // it. The key is now unrecognized, and the strict schema says so by name.
  it("rejects the removed sub_workflows settings block, naming the key", async () => {
    const ws = workspaceWith({
      "/workflow.yaml": `settings:
  sub_workflows:
    max_depth: 2
${DELEGATING}`,
    });
    const result = await loadMachineSpec(ws, PATHS);
    expect(result.usable).toBe(false);
    expect(result.issues.map((i) => i.kind)).toContain("schema");
    expect(result.issues.map((i) => i.message).join("\n")).toMatch(
      /'settings'.*Unrecognized key: "sub_workflows"/s,
    );
  });

  /** The delegating spec with `manual` declaring whatever the case is about. */
  const delegatingWith = (declaration: string): Workspace =>
    workspaceWith({
      "/workflow.yaml": DELEGATING.replace(
        "    triggers: { manual: }\n",
        `    triggers:\n      manual:\n${declaration}`,
      ),
    });

  it("accepts a session path on the manual trigger", async () => {
    const result = await loadMachineSpec(
      delegatingWith("        session: conversation_id\n"),
      PATHS,
    );
    expect(result.usable).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("accepts a message path on the manual trigger", async () => {
    const result = await loadMachineSpec(
      delegatingWith("        message: triggers.-1.body\n"),
      PATHS,
    );
    expect(result.usable).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("accepts a manual trigger that declares nothing at all", async () => {
    const result = await loadMachineSpec(delegatingWith(""), PATHS);
    expect(result.usable).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("loadMachineSpec (a state's triggers mapping)", () => {
  const specWith = (triggers: string): Workspace =>
    workspaceWith({
      "/workflow.yaml": `states:\n  intake:\n    triggers: ${triggers}\n    transitions:\n      - to: done\n        description: Test edge to done.\n  done: {}\n`,
    });

  const errors = (result: Awaited<ReturnType<typeof loadMachineSpec>>): string[] =>
    result.issues.filter((i) => i.severity === "error").map((i) => i.message);

  it("loads a mapping as a start state for every id it names", async () => {
    const result = await loadMachineSpec(specWith("{ manual: , email-received: }"), PATHS);
    expect(errors(result)).toEqual([]);
    expect(result.usable).toBe(true);
    const machine = WorkflowMachine.fromSpec(result.spec!);
    expect(machine.startStateForTrigger("manual")).toBe("intake");
    expect(machine.startStateForTrigger("email-received")).toBe("intake");
  });

  it("reads the ids in declaration order", async () => {
    const result = await loadMachineSpec(specWith("{ manual: , email-received: }"), PATHS);
    expect(stateTriggerIds(result.spec!.states.intake!)).toEqual(["manual", "email-received"]);
  });

  it("counts a mapping-declared start state as a start state", async () => {
    const result = await loadMachineSpec(specWith("{ email-received: }"), PATHS);
    expect(errors(result)).toEqual([]);
  });

  // An empty mapping declares no trigger, so nothing starts the workflow — the
  // same diagnostic as a spec whose states declare no `triggers:` at all.
  it("fails closed on an empty mapping", async () => {
    const result = await loadMachineSpec(specWith("{}"), PATHS);
    expect(result.usable).toBe(false);
    expect(errors(result).join("\n")).toContain("Workflow has no start state");
  });

  it("fails closed on a declaration that is not a mapping", async () => {
    const result = await loadMachineSpec(specWith("[manual]"), PATHS);
    expect(result.usable).toBe(false);
    expect(errors(result).join("\n")).toContain("must be a mapping of trigger id to its declaration");
  });

  it("fails closed on a value that is neither a declaration nor empty", async () => {
    const result = await loadMachineSpec(specWith("{ manual: 3 }"), PATHS);
    expect(result.usable).toBe(false);
    expect(errors(result).join("\n")).toContain("states.intake.triggers.manual");
  });

  // A malformed mapping is an error, not a reason to stop inspecting: `validate`
  // reads the same parsed spec to report everything else wrong with it.
  it("keeps the parsed spec inspectable when a mapping is malformed", async () => {
    const result = await loadMachineSpec(specWith("{ manual: 3 }"), PATHS);
    expect(result.spec?.states?.intake).toBeDefined();
  });
});
