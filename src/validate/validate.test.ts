import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateWorkflow } from "./validate.js";

/** The repository's reference workspace (not shipped in the package). */
const EXAMPLE_DIR = fileURLToPath(new URL("../../examples/customer-support", import.meta.url));

const tmpRoots: string[] = [];

function makeWorkspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "validate-test-"));
  tmpRoots.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const full = resolve(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

/** A machine spec served as `workflow.yaml` content (pure YAML mapping). */
function workflowFile(yaml: string): string {
  return `${yaml.trim()}\n`;
}

/** A `WORKFLOW.md` that still carries spec frontmatter (competing / removed layout). */
function frontmatterMd(yaml: string): string {
  return `---\n${yaml.trim()}\n---\n\n# Overview\n`;
}

afterEach(() => {
  while (tmpRoots.length) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

describe("validateWorkflow", () => {
  it("reports a valid scaffold for the bundled example", async () => {
    const result = await validateWorkflow({
      rootDir: EXAMPLE_DIR,
      workflow: "order-lookup",
    });
    expect(result.valid).toBe(true);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("errors when neither workflow.yaml nor WORKFLOW.md is found", async () => {
    const root = makeWorkspace({ "AGENTS.md": "# empty" });
    const result = await validateWorkflow({ rootDir: root, workflow: "missing" });
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        file: "workflows/missing/workflow.yaml",
      }),
    ]);
  });

  // The same schema backs load and validate, so the slot the loader accepts must
  // draw no diagnostic here either — a host should not have to choose between a
  // workflow that runs and one that validates.
  it("says nothing about a spec carrying host metadata", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "metadata:",
          "  nodes:",
          "    intake: { x: 0, y: 40 }",
          "states:",
          "  intake:",
          "    triggers: { manual: }",
          "    summary: Answer the mail.",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.diagnostics.map((d) => d.message).join(" | ")).not.toContain("metadata");
    expect(result.valid).toBe(true);
  });

  it("counts a state's own trigger as a start state", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "instructions: Answer the mail.",
          "states:",
          "  intake:",
          "    triggers: { email_received: }",
          "    summary: Answer the mail.",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    // The workflow has a start state, and a case may declare that trigger.
    expect(result.diagnostics.map((d) => d.message).join(" | ")).not.toContain("no start state");
    expect(result.valid).toBe(true);
  });

  it("accepts a case trigger a state declares", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "instructions: Answer the mail.",
          "states:",
          "  intake:",
          "    triggers: { clarify_requested: }",
          "    summary: Ask one question.",
        ].join("\n"),
      ),
      "workflows/p/tests/a.test.yaml": [
        "title: T",
        "description: D",
        "trigger: { id: clarify_requested }",
        "steps:",
        '  - send: "hi"',
        "  - succeeded: true",
      ].join("\n"),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.diagnostics.map((d) => d.message).join(" | ")).not.toContain(
      "which no state of this workflow declares",
    );
  });

  // The declaration sits on its entry state, so a second way to name one is
  // refused rather than reconciled.
  it("errors on an 'entry' key inside a declaration", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  intake: {}",
          "  triage:",
          "    triggers: { email_received: { entry: intake } }",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    const errors = result.diagnostics.map((d) => d.message).join(" | ");
    expect(errors).toContain("'states.triage.triggers.email_received.entry'");
    expect(errors).toContain("IS its entry state");
  });

  it("checks the park budget's shape like the other budget keys", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  poll:",
          "    triggers: { manual: }",
          "    summary: Check the bank, then wait a day.",
          "    budget: { maxParks: 0 }",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((d) => d.message).join(" | ")).toContain(
      "'states.poll.budget.maxParks': must be a positive number",
    );
  });

  it("accepts a positive park budget", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  poll:",
          "    triggers: { manual: }",
          "    summary: Check the bank, then wait a day.",
          "    budget: { maxTurns: 6, maxParks: 5 }",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  // An empty declaration is the normal spelling for an id alone, so there is
  // nothing left to warn about a declaration that "says nothing".
  it("says nothing about an empty declaration beside a signed one", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  intake:",
          "    triggers:",
          "      manual:",
          "      email_reply: { session: conversation_id }",
          "    summary: Ask one question, then wait for the reply.",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    const warnings = result.diagnostics.map((d) => d.message).join(" | ");
    expect(warnings).not.toContain("says nothing");
    expect(warnings).not.toContain("'manual'");
  });

  it("accepts the host-resolved declaration keys silently", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  intake:",
          "    triggers:",
          "      chat: { session: chat.thread_id, message: chat.text, connection: acme-oidc }",
          "      ticket_reopened: { message: false }",
          "    summary: Answer the question.",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    const messages = result.diagnostics.map((d) => d.message).join(" | ");
    expect(messages).not.toContain("'chat'");
    expect(messages).not.toContain("'ticket_reopened'");
  });

  it("errors on a malformed message path or connection", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  intake:",
          "    triggers:",
          '      chat: { message: "${{chat.text}}" }',
          '      mail: { connection: "" }',
          "    summary: Answer the question.",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    const errors = result.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => d.message)
      .join(" | ");
    expect(errors).toContain("'states.intake.triggers.chat.message': write the bare path");
    expect(errors).toContain(
      "'states.intake.triggers.mail.connection': must be a non-empty string",
    );
  });

  // A key the SDK does not define is a host's business: it is reported so the
  // author knows it is ignored, but it does not fail an otherwise valid workflow.
  it("warns rather than errors on an unknown declaration key", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  intake:",
          "    triggers: { chat: { nonsense: 1 } }",
          "    summary: Answer the question.",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(result.diagnostics.map((d) => d.message).join(" | ")).toContain(
      "declares unknown key 'nonsense', which the SDK ignores",
    );
  });

  // A park awaits no declared ids, so there is nothing static to check a delivered
  // trigger against — any id a case delivers is deliverable.
  it("accepts a deliver step naming a trigger the workflow never mentions", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "instructions: Answer the mail.",
          "states:",
          "  intake:",
          "    triggers: { manual: }",
          "    summary: Ask one question, then wait for the reply.",
        ].join("\n"),
      ),
      "workflows/p/tests/a.test.yaml": [
        "title: T",
        "description: D",
        "steps:",
        '  - send: "hi"',
        "  - parked: input",
        "  - deliver: { trigger: something_nobody_declared }",
        "  - succeeded: true",
      ].join("\n"),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(result.diagnostics.map((d) => d.message).join(" | ")).not.toContain("delivers trigger");
  });

  it("errors when a write_file allow entry targets the read-only authored zone", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  edit:",
          "    triggers: { manual: }",
          "    tools:",
          "      allow:",
          "        - { tool: write_file, args: { file_path: [workflows/p/notes.md] } }",
          "    transitions:",
          "      - to: done",
          "        description: done",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    // `workflows/` is no longer an authored mount — it is not routed at all — so
    // the diagnostic is the sharper one: the entry names the authoring plane and
    // therefore does not mean what it reads as.
    expect(
      result.diagnostics.some(
        (d) =>
          d.severity === "error" &&
          /authoring plane \('workflows\/'\)/.test(d.message) &&
          /machine specs, grading rubrics, hook scripts, and test cases/.test(d.message),
      ),
    ).toBe(true);
  });



  it("errors when an allow entry targets a runtime-owned run area", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  edit:",
          "    triggers: { manual: }",
          "    tools:",
          "      allow:",
          "        - { tool: write_file, args: { file_path: ['checkpoints/**'] } }",
          "        - { tool: write_file, args: { file_path: ['large_tool_results/x.txt'] } }",
          "    transitions:",
          "      - to: done",
          "        description: done",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    expect(
      result.diagnostics.filter(
        (d) => d.severity === "error" && /runtime-owned run area/.test(d.message),
      ),
    ).toHaveLength(2);
  });

  describe("inert scratchpad narrowing", () => {
    /** A one-state workflow whose only governance is `entries`. */
    function stateWith(entries: string[]): string {
      return workflowFile(
        [
          "states:",
          "  work:",
          "    triggers: { manual: }",
          "    tools:",
          "      allow:",
          ...entries.map((e) => `        - ${e}`),
          "    transitions:",
          "      - to: done",
          "        description: done",
          "  done: {}",
        ].join("\n"),
      );
    }

    const scratchpadWarnings = (diagnostics: { severity: string; message: string }[]) =>
      diagnostics.filter(
        (d) => d.severity === "warning" && /always-open 'scratchpad\/' area/.test(d.message),
      );

    it("warns when every path of a write entry sits in the always-open area", async () => {
      const root = makeWorkspace({
        "workflows/p/workflow.yaml": stateWith([
          "{ tool: write_file, args: { file_path: ['scratchpad/refund.json'] } }",
        ]),
      });

      const result = await validateWorkflow({ rootDir: root, workflow: "p" });
      const warnings = scratchpadWarnings(result.diagnostics);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain("'work'");
      expect(warnings[0].message).toContain("write_file");
      expect(warnings[0].message).toContain("scratchpad/refund.json");
      expect(warnings[0].message).toContain("permitted in every state");
    });

    it("does not warn for a governed run path", async () => {
      const root = makeWorkspace({
        "workflows/p/workflow.yaml": stateWith([
          "{ tool: write_file, args: { file_path: ['refund.json'] } }",
        ]),
      });

      const result = await validateWorkflow({ rootDir: root, workflow: "p" });
      expect(scratchpadWarnings(result.diagnostics)).toEqual([]);
    });

    it("does not warn when the entry also governs a path outside the working area", async () => {
      const root = makeWorkspace({
        "workflows/p/workflow.yaml": stateWith([
          "{ tool: write_file, args: { file_path: ['scratchpad/notes.md', 'refund.json'] } }",
        ]),
      });

      const result = await validateWorkflow({ rootDir: root, workflow: "p" });
      expect(scratchpadWarnings(result.diagnostics)).toEqual([]);
    });

    it("leaves the workflow valid — the entry is misleading, not wrong", async () => {
      const root = makeWorkspace({
        "workflows/p/workflow.yaml": stateWith([
          "{ tool: edit_file, args: { file_path: ['scratchpad/report.json'] } }",
        ]),
      });

      const result = await validateWorkflow({ rootDir: root, workflow: "p" });
      expect(scratchpadWarnings(result.diagnostics)).toHaveLength(1);
      expect(result.valid).toBe(true);
    });
  });

  it("warns when tools.allow_always names an essential tool (inert entry)", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "tools:",
          "  allow_always:",
          "    - read_file",
          "    - { tool: write_file, args: { file_path: [output/**] } }",
          "    - { tool: archmax_eval, args: { code: ['*'] } }",
          "    - { tool: archmax_run, paths: [skills/gate/scripts/**] }",
          "    - { tool: move_file, paths: [output/**] }",
          "states:",
          "  work:",
          "    triggers: { manual: }",
          "    transitions:",
          "      - to: done",
          "        description: done",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    // Bare essential: redundant. Constrained essential: never enforced.
    expect(
      result.diagnostics.some(
        (d) => d.severity === "warning" && /'read_file'.*redundant/.test(d.message),
      ),
    ).toBe(true);
    expect(
      result.diagnostics.some(
        (d) => d.severity === "warning" && /'write_file'.*never enforced/.test(d.message),
      ),
    ).toBe(true);
    // The interpreter is essential too, so constraining it workflow-wide is
    // inert in the same way — narrow it with a per-state 'tools.allow' entry.
    expect(
      result.diagnostics.some(
        (d) => d.severity === "warning" && /'archmax_eval'.*never enforced/.test(d.message),
      ),
    ).toBe(true);
    // Same for the file-based entry point: a workflow-wide path constraint on
    // it never binds, since the essential grant is consulted first.
    expect(
      result.diagnostics.some(
        (d) => d.severity === "warning" && /'archmax_run'.*never enforced/.test(d.message),
      ),
    ).toBe(true);
    // Non-essential allow_always entries are the intended use — no warning.
    expect(result.diagnostics.some((d) => /move_file/.test(d.message))).toBe(false);
    // Warnings are non-fatal, and a state with no tools block is the ordinary
    // closed default — no diagnostics for it.
    expect(result.valid).toBe(true);
    expect(result.diagnostics.some((d) => /states\.work/.test(d.field ?? ""))).toBe(false);
  });

  it("errors when workflow.yaml is not a YAML mapping", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": "entry: a\nstates:\n  a: {{{ broken\n",
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    expect(result.diagnostics.some((d) => /YAML mapping/i.test(d.message))).toBe(true);
  });

  it("errors when states are missing", async () => {
    const root = makeWorkspace({ "workflows/p/workflow.yaml": workflowFile("title: Incomplete") });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    expect(result.diagnostics.some((d) => d.field === "states")).toBe(true);
  });

  it("errors when a workflow declares no start state (no trigger, no entry)", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        ["states:", "  only:", "    instructions: do the thing"].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    expect(result.diagnostics.some((d) => /no start state/.test(d.message))).toBe(true);
  });

  it("rejects the removed 'final' field", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done:",
          "    final: true",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    // The strict schema names the key.
    expect(result.diagnostics.some((d) => /Unrecognized key: "final"/.test(d.message))).toBe(true);
  });

  it("errors when two states declare the manual trigger", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  a:",
          "    triggers: { manual: }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  b:",
          "    triggers: { manual: }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    expect(result.diagnostics.some((d) => /trigger 'manual'/.test(d.message))).toBe(true);
  });

  it("errors when a manual trigger is claimed beside another on a second state", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  a:",
          "    triggers: { manual: }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  b:",
          "    triggers: { manual: , chat: }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    const message = result.diagnostics.find((d) => /trigger 'manual'/.test(d.message))?.message;
    expect(message).toContain("a");
    expect(message).toContain("b");
  });

  it("errors when a tool trigger is claimed by two states", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  a:",
          "    triggers: { manual: , create_ticket: }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  b:",
          "    triggers: { create_ticket: }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    expect(
      result.diagnostics.some((d) => /trigger 'create_ticket'.*a, b|a, b.*create_ticket/.test(d.message)),
    ).toBe(true);
  });

  it("errors when a host-decorated trigger is claimed by another state", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  a:",
          "    triggers:",
          "      manual:",
          "      slack-message: { type: ap, piece: slack }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  b:",
          "    triggers: { slack-message: }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    expect(
      result.diagnostics.some((d) =>
        /trigger 'slack-message'.*a, b|a, b.*slack-message/.test(d.message),
      ),
    ).toBe(true);
  });

  // One state, two event sources, one behavior — each keyed by its own id.
  it("reports no error for several host-decorated triggers on one state", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  a:",
          "    summary: Intake",
          "    triggers:",
          "      outlook-mail: { type: ap, piece: microsoft-outlook }",
          "      slack-message: { type: ap, piece: slack }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  // A list is several triggers entering *one* state, which is the whole point:
  // nothing about it is ambiguous, so nothing is reported.
  it("reports no ambiguity for one state declaring several triggers", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  a:",
          "    summary: Intake",
          "    triggers: { manual: , create_ticket: }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("surfaces a malformed declaration with the loader's wording", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  a:",
          "    triggers: { manual: 3 }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    expect(
      result.diagnostics.some((d) => /'states.a.triggers.manual'/.test(d.message)),
    ).toBe(true);
  });

  it("errors on an empty triggers mapping by reporting no start state", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  a:",
          "    triggers: {}",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    expect(
      result.diagnostics.some((d) => /Workflow has no start state/.test(d.message)),
    ).toBe(true);
  });

  it("warns when a multi-transition agent state has no 'instructions'", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    transitions:",
          "      - to: a",
          "        description: option a",
          "      - to: b",
          "        description: option b",
          "  a:",
          "    instructions: do a",
          "  b:",
          "    instructions: do b",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(true);
    expect(
      result.diagnostics.some(
        (d) =>
          d.severity === "warning" &&
          d.field === "states.start.instructions" &&
          /outgoing transitions but no 'instructions'/.test(d.message),
      ),
    ).toBe(true);
  });

  it("flags a dangling transition target", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    instructions: read skills/start/SKILL.md",
          "    transitions:",
          "      - to: ghost",
          "        description: Test edge to ghost.",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    expect(result.diagnostics.some((d) => /undefined state 'ghost'/.test(d.message))).toBe(true);
  });

  it("errors on an unsupported runtime contract", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "runtime:",
          "  engine: archmax-harness",
          '  version: "99"',
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    const runtimeError = result.diagnostics.find((d) => d.field === "runtime");
    expect(runtimeError?.severity).toBe("error");
    expect(runtimeError?.message).toContain("archmax-harness@99");
  });

  it("accepts a supported declared runtime contract", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "runtime:",
          "  engine: archmax-harness",
          '  version: "1"',
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.diagnostics.some((d) => d.field === "runtime")).toBe(false);
  });

  it("rejects a bare-string lifecycle hook", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    after: skills/gate/scripts/x.js",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    expect(
      result.diagnostics.some((d) => /must be a \{ script \} or \{ rubric \} entry/.test(d.message)),
    ).toBe(true);
  });




  it("flags an unknown hook kind that is not declared as an extension", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    after: { webhook: approvals/refund }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    expect(result.diagnostics.some((d) => /unknown kind 'webhook'/.test(d.message))).toBe(true);
  });

  it("accepts a custom hook kind declared under extensions.hooks", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "extensions:",
          "  hooks: [webhook]",
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    after: { webhook: approvals/refund }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.diagnostics.some((d) => /unknown kind 'webhook'/.test(d.message))).toBe(false);
  });

  it("reports a hook wired into a skill bundle, naming where hooks live", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    before: { script: skills/gate/scripts/check.js }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
      "skills/gate/scripts/check.js": "export default () => ({ verdict: 'ok' });\n",
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    // The file exists — that is the point. It is in the wrong plane, so the
    // diagnostic has to name the location rather than report it missing.
    const message = result.diagnostics.find((d) => /hook script/.test(d.message))?.message ?? "";
    expect(message).toMatch(/outside 'hooks\/'/);
    expect(message).toMatch(/workflows\/p\/hooks\//);
  });

  it("reports a hook path that climbs out of its workflow", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    before: { script: ../other/hooks/gate.js }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    expect(result.diagnostics.some((d) => /outside 'hooks\//.test(d.message))).toBe(true);
  });

  it("reports an archmax_run entry that grants nothing because it names no bundle", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    tools:",
          "      allow:",
          "        - { tool: archmax_run, args: { file_path: [scratchpad/**] } }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    expect(
      result.diagnostics.some((d) => /outside every skill bundle/.test(d.message)),
    ).toBe(true);
  });

  it("errors on an inline rubric with no instructions", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    after: { rubric: { max_iterations: 2 } }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    expect(
      result.diagnostics.some(
        (d) => d.severity === "error" && d.field === "states.start.after",
      ),
    ).toBe(true);
  });

  it("accepts tagged script and rubric hooks whose targets resolve", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    before: { script: hooks/ok.js }",
          "    after:",
          "      - { rubric: { instructions: judge the tone } }",
          "      - { script: hooks/ok.js }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
      "workflows/p/hooks/ok.js": "export default () => ({ verdict: 'ok' });\n",
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    const hookErrors = result.diagnostics.filter(
      (d) => d.severity === "error" && /hook|rubric/.test(d.message),
    );
    expect(hookErrors).toHaveLength(0);
  });



  it("errors on a state or workflow entry granting task", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "tools:",
          "  allow_always: [task]",
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    tools:",
          "      allow: [task]",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    const notGrantable = result.diagnostics.filter(
      (d) => d.severity === "error" && /not grantable/.test(d.message),
    );
    expect(notGrantable).toHaveLength(2);
  });





  it("rejects a specification-only hook as an unknown kind", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    before: { specification: nothing to run }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(
      result.diagnostics.some(
        (d) => d.severity === "error" && /unknown kind 'specification'/.test(d.message),
      ),
    ).toBe(true);
    expect(result.valid).toBe(false);
  });

  // The sidecar was parsed and never read, so an author relying on it was
  // guiding nobody. Rejected by name, pointing at where a judge's guidance lives.

  it("rejects a removed specification sidecar on a rubric hook as malformed", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    after: { rubric: { instructions: judge it }, specification: be strict }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(
      result.diagnostics.some(
        (d) => d.severity === "error" && /Unrecognized key: "specification"/.test(d.message),
      ),
    ).toBe(true);
    expect(result.valid).toBe(false);
  });

  it("rejects an instructions sidecar on a script hook", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    before: { script: hooks/ok.js, instructions: be strict }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
      "workflows/p/hooks/ok.js": "export default () => ({ verdict: 'ok' });\n",
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(
      result.diagnostics.some(
        (d) => d.severity === "error" && /must be a single-key tagged object/.test(d.message),
      ),
    ).toBe(true);
    expect(result.valid).toBe(false);
  });

  const plainWorkflowYaml = [
    "states:",
    "  start:",
    "    triggers: { manual: }",
    "    transitions:",
    "      - to: done",
    "        description: Test edge to done.",
    "  done: {}",
  ].join("\n");

  it("accepts a well-formed YAML case", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(plainWorkflowYaml),
      "workflows/p/tests/happy.test.yaml": [
        "title: happy path",
        "description: covers the happy path end to end",
        "steps:",
        "  - send: hi",
        "  - succeeded: true",
        "  - reachedState: done",
      ].join("\n"),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.diagnostics.filter((d) => d.file?.includes("happy"))).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("rejects YAML case schema violations: unknown keys and missing description", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(plainWorkflowYaml),
      "workflows/p/tests/typo.test.yaml": [
        "title: typo case",
        "description: typo'd assertion",
        "steps:",
        "  - send: hi",
        "  - reachedstate: done",
      ].join("\n"),
      "workflows/p/tests/nodesc.test.yaml": "title: missing its description\nsteps: []\n",
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    const typo = result.diagnostics.find((d) => /unknown step 'reachedstate'/.test(d.message));
    expect(typo?.severity).toBe("error");
    expect(typo?.file).toBe("workflows/p/tests/typo.test.yaml");
    const nodesc = result.diagnostics.find((d) => /'description' is required/.test(d.message));
    expect(nodesc?.file).toBe("workflows/p/tests/nodesc.test.yaml");
    expect(result.valid).toBe(false);
  });

  // A case file carries no version of its own (`runtime.version` is the one
  // axis), so the key is an unknown key like any other — no bespoke message.
  it("rejects a case-file 'version' key as an unknown-key diagnostic", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(plainWorkflowYaml),
      "workflows/p/tests/future.test.yaml": 'version: "1"\ntitle: future case\ndescription: from the future\n',
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    const error = result.diagnostics.find((d) => /unknown key 'version'/.test(d.message));
    expect(error?.severity).toBe("error");
    expect(result.valid).toBe(false);
  });

  it("rejects a case trigger the workflow machine does not declare", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    transitions:",
          "      - to: report-requested",
          "        description: Test edge to report-requested.",
          "  report-requested:",
          "    triggers: { report_requested: }",
        ].join("\n"),
      ),
      "workflows/p/tests/triggered.test.yaml": [
        "title: declared trigger",
        "description: declared trigger accepted",
        "trigger: { id: report_requested }",
      ].join("\n"),
      "workflows/p/tests/unknown.test.yaml": [
        "title: unknown trigger",
        "description: unknown trigger rejected",
        "trigger: { id: does_not_exist }",
      ].join("\n"),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    const error = result.diagnostics.find((d) => /does_not_exist/.test(d.message));
    expect(error?.severity).toBe("error");
    expect(error?.file).toBe("workflows/p/tests/unknown.test.yaml");
    expect(error?.message).toContain("report_requested");
    expect(
      result.diagnostics.some((d) => d.file === "workflows/p/tests/triggered.test.yaml"),
    ).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("rejects dangling and escaping from: references", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(plainWorkflowYaml),
      "workflows/p/tests/refs.test.yaml": [
        "title: fixture references",
        "description: fixture references",
        "workspace:",
        "  ok.json: { from: shared/ok.json }",
        "  missing.json: { from: shared/missing.json }",
        "  escape.json: { from: ../../secrets.json }",
      ].join("\n"),
      "workflows/p/tests/shared/ok.json": "{}",
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(
      result.diagnostics.some((d) => /shared\/missing\.json' does not exist/.test(d.message)),
    ).toBe(true);
    expect(result.diagnostics.some((d) => /escapes the tests directory/.test(d.message))).toBe(
      true,
    );
    expect(result.diagnostics.some((d) => /shared\/ok\.json/.test(d.message))).toBe(false);
    expect(result.valid).toBe(false);
  });

  // Fixtures are reached only through `from:`; a directory beside the cases is
  // neither a case nor an error, and an escaping `from:` is a diagnostic.
  it("ignores unreferenced directories beside cases and flags an escaping from: path", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(plainWorkflowYaml),
      "workflows/p/tests/alpha.test.yaml": [
        "title: fixtures",
        "description: declares its fixtures",
        "workspace:",
        "  trigger.json: { from: alpha/trigger.json }",
        "  orders.json: { from: ../orders.json }",
      ].join("\n"),
      "workflows/p/tests/alpha/trigger.json": "{}",
      "workflows/p/tests/notes/trigger.json": "{}",
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.diagnostics.some((d) => /notes/.test(d.message))).toBe(false);
    expect(result.diagnostics.some((d) => /escapes the tests directory/.test(d.message))).toBe(true);
    expect(result.valid).toBe(false);
  });

  it("rejects tests.maxConcurrency above 1 as unimplemented, accepting 1", async () => {
    const yamlWith = (n: number) =>
      [
        "tests:",
        `  maxConcurrency: ${n}`,
        "states:",
        "  start:",
        "    triggers: { manual: }",
        "    transitions:",
        "      - to: done",
        "        description: Test edge to done.",
        "  done: {}",
      ].join("\n");

    const rejected = await validateWorkflow({
      rootDir: makeWorkspace({ "workflows/p/workflow.yaml": yamlWith(4) }),
      workflow: "p",
    });
    const error = rejected.diagnostics.find((d) => /maxConcurrency/.test(d.message));
    expect(error?.severity).toBe("error");
    expect(error?.message).toContain("sequentially");
    expect(rejected.valid).toBe(false);

    const accepted = await validateWorkflow({
      rootDir: makeWorkspace({ "workflows/p/workflow.yaml": yamlWith(1) }),
      workflow: "p",
    });
    expect(accepted.diagnostics.some((d) => /maxConcurrency/.test(d.message))).toBe(false);
    expect(accepted.valid).toBe(true);
  });

  it("accepts the v2 two-file layout and rejects competing machines", async () => {
    const yaml = [
      "states:",
      "  start:",
      "    triggers: { manual: }",
      "    transitions:",
      "      - to: done",
      "        description: Test edge to done.",
      "  done: {}",
    ].join("\n");
    const cleanRoot = makeWorkspace({
      "workflows/p/workflow.yaml": yaml,
      "workflows/p/WORKFLOW.md": "# Prose only\n",
    });
    const clean = await validateWorkflow({ rootDir: cleanRoot, workflow: "p" });
    expect(clean.valid).toBe(true);
    expect(clean.diagnostics.some((d) => /single-file layout/.test(d.message))).toBe(false);

    const competingRoot = makeWorkspace({
      "workflows/p/workflow.yaml": yaml,
      "workflows/p/WORKFLOW.md": frontmatterMd("title: other"),
    });
    const competing = await validateWorkflow({ rootDir: competingRoot, workflow: "p" });
    expect(competing.valid).toBe(false);
    expect(
      competing.diagnostics.some((d) => d.severity === "error" && /frontmatter/.test(d.message)),
    ).toBe(true);
  });

  it("rejects a spec-side specification key on a hook", async () => {
    const v2Root = makeWorkspace({
      "workflows/p/workflow.yaml": [
        "states:",
        "  start:",
        "    triggers: { manual: }",
        "    before: { script: hooks/x.js, specification: check it }",
        "    transitions:",
        "      - to: done",
        "        description: Test edge to done.",
        "  done: {}",
      ].join("\n"),
      "workflows/p/hooks/x.js": "console.log('x');\n",
    });
    const v2 = await validateWorkflow({ rootDir: v2Root, workflow: "p" });
    // The removed `specification` sidecar makes the hook a two-key object,
    // which fails kind detection (fail-closed) rather than being ignored.
    expect(
      v2.diagnostics.some((d) => d.severity === "error" && /single-key tagged object/.test(d.message)),
    ).toBe(true);
    expect(v2.valid).toBe(false);
  });

  it("rejects foreign imports in hook scripts", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": [
        "states:",
        "  start:",
        "    triggers: { manual: }",
        "    before: { script: hooks/x.js }",
        "    transitions:",
        "      - to: done",
        "        description: Test edge to done.",
        "  done: {}",
      ].join("\n"),
      "workflows/p/hooks/x.js":
        '/**\n * Checks things.\n */\nimport fs from "node:fs";\nconsole.log(fs);\n',
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    const importErrors = result.diagnostics.filter((d) => /@archmax-ai\/harness\/\*/.test(d.message));
    expect(importErrors.map((d) => d.file)).toEqual(["workflows/p/hooks/x.js"]);
    expect(importErrors.every((d) => d.severity === "error")).toBe(true);
    expect(result.valid).toBe(false);
  });

  it("accepts @archmax-ai/harness typed imports in hook scripts", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": [
        "states:",
        "  start:",
        "    triggers: { manual: }",
        "    before: { script: hooks/x.js }",
        "    transitions:",
        "      - to: done",
        "        description: Test edge to done.",
        "  done: {}",
      ].join("\n"),
      "workflows/p/hooks/x.js":
        '/** Checks it. */\nimport { defineHook } from "@archmax-ai/harness/sandbox";\nexport default defineHook(({ t }) => { t.log("ok"); });\n',
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.diagnostics.filter((d) => /import/.test(d.message))).toHaveLength(0);
  });

  it("treats warnings as non-fatal", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "title: Plain workflow",
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(true);
    // `start` has neither a summary nor a transition description: a warning.
    expect(result.diagnostics.some((d) => d.severity === "warning")).toBe(true);
  });

  it("errors on a malformed root 'instructions' and warns when it is absent", async () => {
    for (const declared of ["instructions: 42", 'instructions: ""']) {
      const root = makeWorkspace({
        "workflows/p/workflow.yaml": workflowFile(
          [declared, "states:", "  start: { triggers: { manual: } }"].join("\n"),
        ),
      });
      const result = await validateWorkflow({ rootDir: root, workflow: "p" });
      const diagnostic = result.diagnostics.find((d) => d.field === "instructions");
      expect(diagnostic?.severity).toBe("error");
      expect(result.valid).toBe(false);
    }

    // Absent is a nudge, not a failure.
    const bare = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        ["states:", "  start: { triggers: { manual: } }"].join("\n"),
      ),
    });
    const warned = await validateWorkflow({ rootDir: bare, workflow: "p" });
    const warning = warned.diagnostics.find((d) => d.field === "instructions");
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain("standing");
    expect(warned.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    // Declared and well-formed → no instructions diagnostic at all.
    const declared = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        ["instructions: Cite an order id.", "states:", "  start: { triggers: { manual: } }"].join("\n"),
      ),
    });
    const clean = await validateWorkflow({ rootDir: declared, workflow: "p" });
    expect(clean.diagnostics.filter((d) => d.field === "instructions")).toHaveLength(0);
  });

  // Run-wide direction is not per-state routing context — the two warnings are
  // independent, so declaring one never silences the other.
  // Root `instructions` are standing prose for every turn; they cannot say when
  // one edge is the right one. The description is the only per-edge routing text
  // the agent gets, so the schema requires it however well the root is written.
  it("requires a description on every transition, whatever the root instructions say", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "instructions: Cite an order id in every answer.",
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    transitions:",
          "      - to: done",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    const diagnostic = result.diagnostics.find(
      (d) => d.field === "states.start.transitions.0.description",
    );
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.message).toContain("only thing the agent is told about this edge");
  });

  it("fails when the workflow slug is not kebab-case", async () => {
    const root = makeWorkspace({
      "workflows/order_lookup/workflow.yaml": workflowFile(
        ["states:", "  start: { triggers: { manual: } }"].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "order_lookup" });
    const errors = result.diagnostics.filter((d) => /Workflow slug/.test(d.message));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.severity).toBe("error");
    expect(errors[0]?.message).toContain("kebab-case");
    expect(errors[0]?.message).toContain("order-lookup");
    expect(result.valid).toBe(false);

    const kebab = makeWorkspace({
      "workflows/order-lookup/workflow.yaml": workflowFile(
        ["states:", "  start: { triggers: { manual: } }"].join("\n"),
      ),
    });
    const clean = await validateWorkflow({ rootDir: kebab, workflow: "order-lookup" });
    expect(clean.diagnostics.some((d) => /Workflow slug/.test(d.message))).toBe(false);
  });

  it("fails when no workflow slug is provided", async () => {
    const root = makeWorkspace({
      "workflows/order-lookup/workflow.yaml": workflowFile(
        ["states:", "  start: { triggers: { manual: } }"].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "   " });
    expect(result.valid).toBe(false);
    const missing = result.diagnostics.find((d) => /No workflow slug provided/.test(d.message));
    expect(missing?.severity).toBe("error");
    expect(missing?.field).toBe("workflow");
  });

  it("fails when a state is declared with an empty slug", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    transitions:",
          "      - to: done",
          "        description: Done.",
          '  "":',
          "    title: No slug at all",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    const empty = result.diagnostics.find((d) => /empty slug/.test(d.message));
    expect(empty?.severity).toBe("error");
    expect(empty?.message).toContain("'title'");
    // Reported as the missing identity, not as a shape violation.
    expect(result.diagnostics.some((d) => /is not a valid slug/.test(d.message))).toBe(false);
  });

  it("requires hyphen-separated kebab-case state slugs", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  Identify Case:", // capitals and a space
          "    triggers: { manual: }",
          "    transitions:",
          "      - to: snake_case",
          "        description: Underscore.",
          "      - to: -leading",
          "        description: Leading hyphen.",
          "      - to: double--hyphen",
          "        description: Doubled hyphen.",
          "      - to: identify-case-2",
          "        description: Valid.",
          "  snake_case: {}",
          "  -leading: {}",
          "  double--hyphen: {}",
          "  identify-case-2: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    const offenders = result.diagnostics
      .filter((d) => /is not a valid slug/.test(d.message))
      .map((d) => d.field);
    // Every non-kebab spelling is rejected; the kebab-case slug (with a digit
    // segment) is the only one accepted.
    expect(offenders.sort()).toEqual([
      "states.-leading",
      "states.Identify Case",
      "states.double--hyphen",
      "states.snake_case",
    ]);
    const first = result.diagnostics.find((d) => d.field === "states.Identify Case");
    expect(first?.message).toContain("kebab-case");
    expect(first?.message).toContain("'title'");
  });

  it("rejects a non-string state title without excusing missing routing context", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    title: 42",
          "    transitions:",
          "      - to: done",
          "        description: Test edge to done.",
          "  done: {}",
        ].join("\n"),
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    expect(
      result.diagnostics.some(
        (d) => d.field === "states.start.title" && /must be a non-empty string/.test(d.message),
      ),
    ).toBe(true);
  });
});

describe("run-variable validation", () => {
  const validateSpec = async (spec: string) =>
    validateWorkflow({
      rootDir: makeWorkspace({ "workflows/p/workflow.yaml": workflowFile(spec) }),
      workflow: "p",
    });

  it("reports a guard reference no state requires as needing a seed", async () => {
    const result = await validateSpec(`
title: P
states:
  a:
    triggers: { manual: }
    tools:
      allow:
        - { tool: send_reply, args: { to: ["\${{case_id}}"] } }
`);
    const warning = result.diagnostics.find((d) => /case_id/.test(d.message));
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toMatch(/variables/);
  });

  it("says nothing when a state requires the referenced variable", async () => {
    const result = await validateSpec(`
title: P
states:
  a:
    triggers: { manual: }
    requires: [case_id]
    tools:
      allow:
        - { tool: send_reply, args: { to: ["\${{case_id}}"] } }
`);
    expect(result.diagnostics.some((d) => /case_id/.test(d.message))).toBe(false);
  });

  // The reserved `title` is not exempt: unlike `trigger`, nothing but the agent
  // sets it, so a guard binding to it does rest on the agent having done so.
  it("still warns for the built-in title, which the harness never sets", async () => {
    const result = await validateSpec(`
title: P
states:
  a:
    triggers: { manual: }
    tools:
      allow:
        - { tool: send_reply, args: { to: ["\${{title}}"] } }
`);
    const warning = result.diagnostics.find((d) => /'\$\{\{title\}\}'/.test(d.message));
    expect(warning?.severity).toBe("warning");
  });

  it("says nothing for the built-in trigger", async () => {
    const result = await validateSpec(`
title: P
states:
  a:
    triggers: { manual: }
    tools:
      allow:
        - { tool: send_reply, args: { to: ["\${{trigger}}"] } }
`);
    expect(result.diagnostics.some((d) => /trigger\}\}/.test(d.message))).toBe(false);
  });

  it("errors on a malformed reference", async () => {
    const result = await validateSpec(`
title: P
states:
  a:
    triggers: { manual: }
    tools:
      allow:
        - { tool: send_reply, args: { to: ["\${{}}"] } }
`);
    expect(
      result.diagnostics.some(
        (d) => d.severity === "error" && /valid variable reference/.test(d.message),
      ),
    ).toBe(true);
  });

  it("errors on an invalid name in requires", async () => {
    const result = await validateSpec(`
title: P
states:
  a:
    triggers: { manual: }
    requires: ["Case.Id"]
`);
    expect(
      result.diagnostics.some((d) => d.severity === "error" && /Case\.Id/.test(d.message)),
    ).toBe(true);
  });

  it("warns on a duplicated requires entry", async () => {
    const result = await validateSpec(`
title: P
states:
  a:
    triggers: { manual: }
    requires: [x, x]
`);
    expect(result.diagnostics.some((d) => d.severity === "warning" && /twice/.test(d.message))).toBe(
      true,
    );
  });

  it("adds the every-state note for an allow_always reference", async () => {
    const result = await validateSpec(`
title: P
tools:
  allow_always:
    - { tool: x, args: { y: ["\${{v}}"] } }
states:
  a:
    triggers: { manual: }
`);
    expect(result.diagnostics.some((d) => /every state/.test(d.message))).toBe(true);
  });
});

/** Every diagnostic's message, joined — the shape most of these assert against. */
const messages = (result: { diagnostics: { message: string }[] }): string =>
  result.diagnostics.map((d) => d.message).join(" | ");

describe("validateWorkflow — delegation tool references", () => {
  const caller = (allow: string) =>
    [
      "states:",
      "  start:",
      "    triggers: { manual: }",
      "    tools:",
      "      allow:",
      `        - ${allow}`,
      "    transitions: []",
    ].join("\n");

  const delegatable = ["states:", "  work:", "    triggers: { manual: }"].join("\n");

  it("reports a target that does not exist", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": caller("archmax_workflow_absent"),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(messages(result)).toMatch(/allows 'archmax_workflow_absent'.*is missing/s);
  });

  // A caller enters where a host would, so the check is whether the target has a
  // `manual` entry at all — not whether it opted in to being called.
  it("reports a target with no manual entry", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": caller("archmax_workflow_enrich"),
      // Startable by a host firing `enrichment_requested`, but nothing else has a
      // state to enter.
      "workflows/enrich/workflow.yaml":
        "states:\n  work:\n    triggers: { enrichment_requested: }\n",
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(messages(result)).toMatch(/declares no 'manual' trigger/);
  });

  it("accepts a target whose only declaration is its manual entry", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": caller("archmax_workflow_enrich"),
      "workflows/enrich/workflow.yaml": "states:\n  work:\n    triggers: { manual: }\n",
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(messages(result)).not.toMatch(/archmax_workflow_enrich/);
  });

  it("reports a malformed target slug where it was declared", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": caller("archmax_workflow_Enrich_Order"),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(messages(result)).toMatch(/not hyphen-separated kebab-case/);
  });

  it("reports a self-reference over the allow graph", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": caller("archmax_workflow_p"),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(messages(result)).toMatch(/already running in this chain/);
  });

  it("reports mutual recursion over the allow graph", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": caller("archmax_workflow_b"),
      "workflows/b/workflow.yaml": [
        "states:",
        "  start:",
        "    triggers: { manual: }",
        "    tools:",
        "      allow:",
        "        - archmax_workflow_p",
        "    transitions: []",
      ].join("\n"),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(messages(result)).toMatch(/p → b → p/);
  });

  it("accepts a well-formed delegation", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": caller("archmax_workflow_enrich"),
      "workflows/enrich/workflow.yaml": delegatable,
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  // A `manual` entry is what makes a workflow runnable, so one nothing calls is
  // the ordinary case — a root workflow — not something unreachable.
  it("says nothing about a runnable workflow no allow list names", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": caller("read_file"),
      "workflows/enrich/workflow.yaml": delegatable,
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(messages(result)).not.toMatch(/enrich/);
  });

});

describe("disabled workflow diagnostics", () => {
  const base = [
    "instructions: Answer the question.",
    "states:",
    "  start:",
    "    triggers: { manual: }",
    "    transitions:",
    "      - to: done",
    "        description: Answered.",
    "  done: {}",
  ].join("\n");

  const validateSpec = async (yaml: string) => {
    const root = makeWorkspace({ "workflows/p/workflow.yaml": workflowFile(yaml) });
    return validateWorkflow({ rootDir: root, workflow: "p" });
  };

  it("warns that a disabled workflow starts no turns, and stays valid", async () => {
    const result = await validateSpec(`disabled: true\n${base}`);
    expect(result.valid).toBe(true);
    const warning = result.diagnostics.find((d) => d.field === "disabled");
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain("starts no new turns");
    // The drain rule, where the author is reading about the flag.
    expect(warning?.message).toContain("decided, replied to and delivered to");
  });

  it("says nothing when the flag is absent or false", async () => {
    for (const yaml of [base, `disabled: false\n${base}`]) {
      const result = await validateSpec(yaml);
      expect(result.diagnostics.filter((d) => d.field === "disabled")).toEqual([]);
    }
  });

  // The runtime reads the key fail-closed, so a typo *stops* the workflow — the
  // opposite of what whoever typed it meant.
  it("errors on a non-boolean value, naming what it does instead", async () => {
    const result = await validateSpec(`disabled: "no"\n${base}`);
    expect(result.valid).toBe(false);
    const error = result.diagnostics.find((d) => d.field === "disabled");
    expect(error?.severity).toBe("error");
    expect(error?.message).toContain("must be a boolean");
    expect(error?.message).toContain("fail-closed");
  });

  it("keeps reporting everything else about a disabled workflow", async () => {
    const result = await validateSpec(
      ["disabled: true", "instructions: Go.", "states:", "  start:", "    triggers: { manual: }", "    transitions:", "      - to: nowhere", "        description: Off the graph."].join("\n"),
    );
    expect(result.valid).toBe(false);
    expect(result.diagnostics.some((d) => d.message.includes("nowhere"))).toBe(true);
    expect(result.diagnostics.some((d) => d.field === "disabled")).toBe(true);
  });

  it("warns on a state that allows a disabled delegation target", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        [
          "instructions: Delegate the enrichment.",
          "states:",
          "  start:",
          "    triggers: { manual: }",
          "    tools:",
          "      allow:",
          "        - archmax_workflow_enrich-order",
          "    transitions: []",
        ].join("\n"),
      ),
      "workflows/enrich-order/workflow.yaml": workflowFile(
        ["disabled: true", "instructions: Enrich.", "states:", "  enrich:", "    triggers: { manual: }"].join("\n"),
      ),
    });

    const result = await validateWorkflow({ rootDir: root, workflow: "p" });

    // A warning, not an error: the caller's spec is not wrong, and assembly
    // still binds the tool.
    expect(result.valid).toBe(true);
    const warning = result.diagnostics.find((d) => d.message.includes("enrich-order") && d.severity === "warning");
    expect(warning?.message).toContain("is disabled");
    expect(warning?.message).toContain("refused at runtime");
    expect(warning?.message).toContain("state 'start' allows 'archmax_workflow_enrich-order'");
  });
});

describe("skill governance validation", () => {
  const skillFile = (name: string, description = "What it does.") =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

  const bundles = {
    "skills/order-data/SKILL.md": skillFile("order-data", "The order records."),
    "skills/refund-policy/SKILL.md": skillFile("refund-policy", "When to refund."),
    "skills/order-enrichment/SKILL.md": skillFile("order-enrichment", "Fan-out enrichment."),
  };

  const validateWith = async (yaml: string, extra: Record<string, string> = {}) =>
    validateWorkflow({
      rootDir: makeWorkspace({
        "workflows/p/workflow.yaml": workflowFile(yaml),
        ...bundles,
        ...extra,
      }),
      workflow: "p",
    });

  const errors = (result: Awaited<ReturnType<typeof validateWorkflow>>) =>
    result.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
  const warnings = (result: Awaited<ReturnType<typeof validateWorkflow>>) =>
    result.diagnostics.filter((d) => d.severity === "warning").map((d) => d.message);

  it("passes a scaffold whose grants and denials all resolve", async () => {
    const result = await validateWith(`
skills:
  allow_always: [order-data]
  forbid_always: [order-enrichment]
states:
  lookup:
    triggers: { manual: }
    skills:
      allow: [refund-policy]
    transitions: [{ to: refund, description: refund needed }]
  refund:
    skills:
      forbid: [order-data]
`);
    expect(errors(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("errors on a slug no source provides, under every key", async () => {
    for (const [yaml, field] of [
      ["skills:\n  allow_always: [order-datta]\nstates:\n  lookup: { triggers: { manual: } }", "skills.allow_always"],
      ["skills:\n  forbid_always: [order-datta]\nstates:\n  lookup: { triggers: { manual: } }", "skills.forbid_always"],
      [
        "states:\n  lookup:\n    triggers: { manual: }\n    skills:\n      forbid: [order-datta]",
        "states.lookup.skills.forbid",
      ],
    ] as const) {
      const result = await validateWith(yaml);
      expect(result.valid).toBe(false);
      const bad = result.diagnostics.find((d) => d.severity === "error");
      expect(bad?.field).toBe(field);
      expect(bad?.message).toContain("which no source provides");
      expect(bad?.message).toContain("order-data, order-enrichment, refund-policy");
    }
  });

  it("reports no ceiling error: a state's list is a grant", async () => {
    const result = await validateWith(`
skills:
  allow_always: [order-data]
states:
  lookup:
    triggers: { manual: }
    skills:
      allow: [refund-policy]
`);
    expect(errors(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("errors on a path-shaped or glob-shaped entry", async () => {
    const result = await validateWith(`
skills:
  allow_always: ["skills/order-data/**"]
states:
  lookup: { triggers: { manual: } }
`);
    expect(result.valid).toBe(false);
    expect(errors(result).join("\n")).toContain("is not a skill slug");
  });

  it("errors on a non-string entry and a non-list list", async () => {
    const bad = await validateWith(`
skills:
  allow_always: [7]
states:
  lookup: { triggers: { manual: } }
`);
    expect(errors(bad).join("\n")).toContain("not a skill slug: 7");

    const scalar = await validateWith(`
states:
  lookup:
    triggers: { manual: }
    skills:
      allow: order-data
`);
    expect(errors(scalar).join("\n")).toContain("must be a list of skill slugs");
  });

  it("errors on a bundle whose SKILL.md name disagrees with its directory", async () => {
    const result = await validateWith(
      `
states:
  lookup: { triggers: { manual: } }
`,
      { "skills/order-data/SKILL.md": skillFile("order_data", "The order records.") },
    );
    expect(result.valid).toBe(false);
    expect(errors(result).join("\n")).toContain("should match directory name 'order-data'");
  });

  it("errors on a tools.allow entry that can only match a skill the state does not enable", async () => {
    const result = await validateWith(`
skills:
  allow_always: [order-data]
states:
  lookup:
    triggers: { manual: }
    tools:
      allow:
        - { tool: archmax_run, args: { file_path: ["skills/order-enrichment/scripts/**"] } }
`);
    expect(result.valid).toBe(false);
    expect(errors(result).join("\n")).toContain(
      "allows 'archmax_run' on 'skills/order-enrichment/scripts/**', which can only match inside skill 'order-enrichment'",
    );
  });

  it("errors on an entry inside a bundle the state's own forbid removes", async () => {
    const result = await validateWith(`
skills:
  allow_always: [order-enrichment]
states:
  lookup:
    triggers: { manual: }
    skills:
      forbid: [order-enrichment]
    tools:
      allow:
        - { tool: archmax_run, args: { file_path: ["skills/order-enrichment/scripts/**"] } }
`);
    expect(result.valid).toBe(false);
    expect(errors(result).join("\n")).toContain("can only match inside skill 'order-enrichment'");
  });

  it("accepts an entry that narrows within an enabled skill", async () => {
    const result = await validateWith(`
skills:
  allow_always: [order-enrichment]
states:
  lookup:
    triggers: { manual: }
    tools:
      allow:
        - { tool: archmax_run, args: { file_path: ["skills/order-enrichment/scripts/**"] } }
`);
    expect(errors(result)).toEqual([]);
  });

  it("leaves a pattern spanning several bundles to the runtime", async () => {
    const result = await validateWith(`
skills:
  allow_always: [order-data]
states:
  lookup:
    triggers: { manual: }
    tools:
      allow:
        - { tool: archmax_run, args: { file_path: ["skills/**"] } }
`);
    expect(errors(result)).toEqual([]);
  });

  it("warns when a later source shadows an earlier slug", async () => {
    // Both sources sit under the mounted `skills/` directory: a skill source has
    // to be *readable* through the workspace, and only mounted paths are.
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile("states:\n  lookup: { triggers: { manual: } }"),
      "skills/base/order-data/SKILL.md": skillFile("order-data", "Base."),
      "skills/local/order-data/SKILL.md": skillFile("order-data", "Local."),
    });
    const result = await validateWorkflow({
      rootDir: root,
      workflow: "p",
      skills: ["skills/base/", "skills/local/"],
    });
    expect(warnings(result).join("\n")).toContain("shadows the one at skills/base/order-data");
  });

  it("errors on every declared slug when the workspace provides no skills", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": workflowFile(
        "skills:\n  allow_always: [order-data]\nstates:\n  lookup: { triggers: { manual: } }",
      ),
    });
    const result = await validateWorkflow({ rootDir: root, workflow: "p" });
    expect(result.valid).toBe(false);
    expect(errors(result).join("\n")).toContain("(the workspace provides none)");
  });

  it("warns once when a workflow declares no root block in a workspace with bundles", async () => {
    // The shape that used to inherit the whole registry: told once, naming what
    // it cannot reach — not once per bundle, since another workflow may own them.
    const result = await validateWith(`
states:
  lookup: { triggers: { manual: } }
`);
    expect(result.valid).toBe(true);
    const found = result.diagnostics.filter((d) => d.field === "skills");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("declares no root 'skills' block");
    expect(found[0]?.message).toContain("order-data, order-enrichment, refund-policy");
    expect(found[0]?.message).toContain("'skills: { allow_always: [] }'");
  });

  it("says nothing when a workflow states outright what it grants workflow-wide", async () => {
    const result = await validateWith(`
skills:
  allow_always: []
states:
  lookup: { triggers: { manual: } }
`);
    expect(result.valid).toBe(true);
    expect(result.diagnostics.filter((d) => d.field?.startsWith("skills"))).toEqual([]);
  });

  it("says nothing about the bundles another workflow owns", async () => {
    // The registry is workspace-wide; enablement is per workflow.
    const result = await validateWith(`
skills:
  allow_always: [order-data]
states:
  lookup: { triggers: { manual: } }
`);
    expect(result.diagnostics.filter((d) => d.field?.startsWith("skills"))).toEqual([]);
  });

  it("warns that a state entry the workflow already grants everywhere is inert", async () => {
    const result = await validateWith(`
skills:
  allow_always: [order-data]
states:
  lookup:
    triggers: { manual: }
    skills:
      allow: [order-data, refund-policy]
`);
    expect(result.valid).toBe(true);
    const found = result.diagnostics
      .filter((d) => d.field === "states.lookup.skills.allow")
      .map((d) => d.message);
    expect(found.join("\n")).toContain(
      "State 'lookup' enables skill 'order-data', which 'skills.allow_always' already enables in every state",
    );
    expect(found.join("\n")).not.toContain("'refund-policy'");
  });

  it("warns that an empty state list subtracts nothing, and names what does", async () => {
    const result = await validateWith(`
skills:
  allow_always: [order-data]
states:
  route:
    triggers: { manual: }
    skills:
      allow: []
`);
    expect(result.valid).toBe(true);
    const found = result.diagnostics.find((d) => d.field === "states.route.skills.allow");
    expect(found?.message).toContain("reads like a deny but subtracts nothing");
    expect(found?.message).toContain("'skills: { forbid: [...] }' is what subtracts");
  });

  it("warns when a workflow-wide skill denial cancels a grant", async () => {
    const result = await validateWith(`
skills:
  allow_always: [order-data]
  forbid_always: [order-data]
states:
  lookup: { triggers: { manual: } }
`);
    expect(result.valid).toBe(true);
    const found = result.diagnostics.find((d) => d.field === "skills.forbid_always");
    expect(found?.message).toContain("a denial beats every grant, so the grant reaches nothing");
  });

  it("warns when a state both enables and forbids one skill", async () => {
    const result = await validateWith(`
skills:
  allow_always: []
states:
  lookup:
    triggers: { manual: }
    skills:
      allow: [order-data]
      forbid: [order-data]
`);
    expect(result.valid).toBe(true);
    expect(warnings(result).join("\n")).toContain(
      "State 'lookup' both enables and forbids skill 'order-data'",
    );
  });

  it("warns when a state's forbid has nothing to subtract", async () => {
    const result = await validateWith(`
skills:
  allow_always: []
states:
  lookup:
    triggers: { manual: }
    skills:
      forbid: [refund-policy]
`);
    expect(result.valid).toBe(true);
    const found = result.diagnostics.find((d) => d.field === "states.lookup.skills.forbid");
    expect(found?.message).toContain("which nothing enables here");
  });

  it("says nothing about an empty state list when the workflow grants nothing always-on", async () => {
    const result = await validateWith(`
skills:
  allow_always: []
states:
  route:
    triggers: { manual: }
    skills:
      allow: []
`);
    expect(result.diagnostics.filter((d) => d.field?.includes("skills"))).toEqual([]);
  });
});

describe("tool denial validation", () => {
  const validateWith = async (yaml: string) =>
    validateWorkflow({
      rootDir: makeWorkspace({ "workflows/p/workflow.yaml": workflowFile(yaml) }),
      workflow: "p",
    });
  const errors = (result: Awaited<ReturnType<typeof validateWorkflow>>) =>
    result.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);

  it("errors on a state grant the workflow denies in every state", async () => {
    const result = await validateWith(`
tools:
  forbid_always: [web_fetch]
states:
  lookup:
    triggers: { manual: }
    tools:
      allow: [web_fetch]
`);
    expect(result.valid).toBe(false);
    expect(errors(result).join("\n")).toContain(
      "allows 'web_fetch', which 'tools.forbid_always' denies in every state",
    );
  });

  it("errors on a state that allows and forbids the same tool", async () => {
    const result = await validateWith(`
states:
  lookup:
    triggers: { manual: }
    tools:
      allow: [web_fetch]
      forbid: [web_fetch]
`);
    expect(result.valid).toBe(false);
    expect(errors(result).join("\n")).toContain("allows 'web_fetch' and forbids it in the same state");
  });

  it("errors when the workflow denies the only way a state can move", async () => {
    const result = await validateWith(`
tools:
  forbid_always: [archmax_advance]
states:
  lookup:
    triggers: { manual: }
    transitions: [{ to: done, description: finished }]
  done:
`);
    expect(result.valid).toBe(false);
    expect(errors(result).join("\n")).toContain(
      "denies 'archmax_advance', the only way a state moves",
    );
  });

  it("accepts that denial in a workflow with nowhere to move", async () => {
    const result = await validateWith(`
tools:
  forbid_always: [archmax_advance]
states:
  only:
    triggers: { manual: }
`);
    expect(errors(result)).toEqual([]);
  });

  it("accepts a wildcard denial and rejects a wildcard grant", async () => {
    const denial = await validateWith(`
tools:
  forbid_always: [{ tool: "*", paths: ["logs/**"] }]
states:
  lookup: { triggers: { manual: } }
`);
    expect(errors(denial)).toEqual([]);

    const grant = await validateWith(`
tools:
  allow_always: [{ tool: "*", paths: ["logs/**"] }]
states:
  lookup: { triggers: { manual: } }
`);
    expect(grant.valid).toBe(false);
    expect(errors(grant).join("\n")).toMatch(/wildcard|'\*'/);
  });
});

/**
 * The mounts diagnostics that need the host's resolved table: which names it
 * carries, and which of them it governs. The document-only lints (a name at
 * both levels, an empty state list, a forbid the workflow-wide denial covers)
 * live in `lint-spec.test.ts` and reach here through the loader's findings.
 */
describe("validateWorkflow — mount governance", () => {
  /** A backend stand-in: only the resolved mount keys reach validation. */
  const stub = () => ({ ls: () => ({ files: [] }) }) as never;

  /** `reference` and `catalogs/eu` governed read-only, `shared` governed writable. */
  const TABLE = {
    "/skills/": stub(),
    "/AGENTS.md": stub(),
    "/reference/": { backend: stub(), governed: true },
    "/catalogs/eu/": { backend: stub(), governed: true },
    "/shared/": { backend: stub(), readOnly: false, governed: true },
  };

  const validateWith = async (yaml: string, mounts: Record<string, never | object> = TABLE) => {
    const root = makeWorkspace({
      "AGENTS.md": "# workspace",
      "workflows/p/workflow.yaml": workflowFile(yaml),
    });
    return validateWorkflow({
      rootDir: root,
      workflow: "p",
      mounts: mounts as never,
    });
  };

  const errors = (result: Awaited<ReturnType<typeof validateWorkflow>>) =>
    result.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
  const mountDiags = (result: Awaited<ReturnType<typeof validateWorkflow>>) =>
    result.diagnostics.filter((d) => (d.field ?? "").includes("mounts"));

  it("errors on a name the table does not carry, naming the mounts it does", async () => {
    const result = await validateWith(`
mounts:
  allow_always: [refrence]
states:
  lookup: { triggers: { manual: } }
`);
    expect(result.valid).toBe(false);
    const message = errors(result).join("\n");
    expect(message).toContain("names mount 'refrence'");
    expect(message).toContain("skills, reference, catalogs/eu, shared, AGENTS.md");
  });

  it("errors on an unknown name under every key, addressed at the key that named it", async () => {
    const result = await validateWith(`
mounts:
  forbid_always: [ghost]
states:
  lookup:
    triggers: { manual: }
    mounts:
      allow: [phantom]
      forbid: [specter]
`);
    expect(result.diagnostics.filter((d) => d.severity === "error").map((d) => d.field)).toEqual([
      "mounts.forbid_always",
      "states.lookup.mounts.allow",
      "states.lookup.mounts.forbid",
    ]);
  });

  it("warns that a grant on an ungoverned mount grants nothing", async () => {
    const result = await validateWith(`
mounts:
  allow_always: [skills]
states:
  lookup: { triggers: { manual: } }
`);
    expect(result.valid).toBe(true);
    const found = mountDiags(result).find((d) => d.field === "mounts.allow_always");
    expect(found?.severity).toBe("warning");
    expect(found?.message).toContain("does not declare governed");
    expect(found?.message).toContain("visible in every state already");
    expect(found?.message).toContain("reference, catalogs/eu, shared");
  });

  it("warns that read_write on a mount the host serves read-only opens nothing", async () => {
    const result = await validateWith(`
mounts:
  allow_always: [{ mount: reference, access: read_write }]
states:
  lookup: { triggers: { manual: } }
`);
    expect(result.valid).toBe(true);
    const found = mountDiags(result).find((d) => d.message.includes("read_write"));
    expect(found?.severity).toBe("warning");
    expect(found?.message).toContain("serves read-only");
    expect(found?.message).toContain("readOnly: false");
  });

  it("says nothing about read_write on a mount the host serves writable", async () => {
    const result = await validateWith(`
mounts:
  allow_always: [{ mount: shared, access: read_write }]
states:
  lookup: { triggers: { manual: } }
`);
    expect(mountDiags(result)).toEqual([]);
  });

  it("warns that a forbid on a mount nothing enables here governs nothing", async () => {
    const result = await validateWith(`
mounts:
  allow_always: []
states:
  route:
    triggers: { manual: }
    mounts:
      forbid: [reference]
`);
    expect(result.valid).toBe(true);
    const found = mountDiags(result).find((d) => d.field === "states.route.mounts.forbid");
    expect(found?.message).toContain("nothing enables here");
  });

  it("says nothing when the forbid actually subtracts an always-on grant", async () => {
    const result = await validateWith(`
mounts:
  allow_always: [reference]
states:
  route:
    triggers: { manual: }
    mounts:
      forbid: [reference]
`);
    expect(mountDiags(result)).toEqual([]);
  });

  it("says nothing about a forbid on an ungoverned mount, which really does subtract", async () => {
    const result = await validateWith(`
mounts:
  allow_always: []
states:
  route:
    triggers: { manual: }
    mounts:
      forbid: [skills]
`);
    expect(mountDiags(result)).toEqual([]);
  });

  it("warns once when a workflow declares no root block in a workspace that governs mounts", async () => {
    const result = await validateWith(`
states:
  lookup: { triggers: { manual: } }
`);
    expect(result.valid).toBe(true);
    const found = mountDiags(result).filter((d) => d.field === "mounts");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("declares no root 'mounts' block");
    expect(found[0]?.message).toContain("reference, catalogs/eu, shared");
    expect(found[0]?.message).toContain("'mounts: { allow_always: [] }'");
  });

  it("is silenced by any root block, an empty always-on list included", async () => {
    const result = await validateWith(`
mounts:
  allow_always: []
states:
  lookup: { triggers: { manual: } }
`);
    expect(mountDiags(result)).toEqual([]);
  });

  it("says nothing at all when the table governs no mount", async () => {
    const result = await validateWith(
      `
states:
  lookup: { triggers: { manual: } }
`,
      { "/skills/": stub(), "/AGENTS.md": stub() },
    );
    expect(mountDiags(result)).toEqual([]);
  });

  it("warns that a path grant under a mount the state cannot see reaches nothing", async () => {
    const result = await validateWith(`
mounts:
  allow_always: []
states:
  route:
    triggers: { manual: }
    tools:
      allow:
        - { tool: read_file, paths: ["reference/rates.csv"] }
  lookup:
    mounts:
      allow: [reference]
    tools:
      allow:
        - { tool: read_file, paths: ["reference/rates.csv"] }
`);
    expect(result.valid).toBe(true);
    const found = result.diagnostics.filter((d) => d.field === "states.route.tools.allow");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("warning");
    expect(found[0]?.message).toContain("can only match inside mount 'reference'");
    expect(found[0]?.message).toContain("reaches nothing");
    // The state that enables the mount draws none.
    expect(result.diagnostics.filter((d) => d.field === "states.lookup.tools.allow")).toEqual([]);
  });

  it("reports nothing for a clean mounts block over this table", async () => {
    const result = await validateWith(`
mounts:
  allow_always: [reference, { mount: shared, access: read }]
states:
  triage:
    triggers: { manual: }
    mounts:
      allow: [catalogs/eu]
  route:
    mounts:
      forbid: [reference]
`);
    expect(result.valid).toBe(true);
    expect(mountDiags(result)).toEqual([]);
  });
});
