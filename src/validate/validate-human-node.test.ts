import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateWorkflow } from "./validate.js";

let root: string;

function writeWorkflow(spec: string): void {
  const dir = join(root, "workflows", "wf");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workflow.yaml"), `${spec.trim()}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "human-node-validate-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("validateWorkflow — human nodes", () => {
  it("flags a human node missing instructions", async () => {
    writeWorkflow(
      [
        "states:",
        "  a:",
        "    triggers: { manual: }",
        "    transitions: [{ to: review, description: hand off }]",
        "  review:",
        "    type: human",
        "    transitions: [{ to: done, description: approve }]",
        "  done: {}",
      ].join("\n"),
    );

    const result = await validateWorkflow({ workflow: "wf", rootDir: root });
    expect(result.valid).toBe(false);
    expect(
      result.diagnostics.some(
        (d) => d.severity === "error" && /Human state 'review' must declare 'instructions'/.test(d.message),
      ),
    ).toBe(true);
  });

  // A human node's button labels are its transition descriptions, so they are
  // guaranteed by the strict schema rather than checked here: one rule for every
  // state, and the spec does not load without them.
  it("rejects a human node whose transitions lack descriptions, in the schema", async () => {
    writeWorkflow(
      [
        "states:",
        "  a:",
        "    triggers: { manual: }",
        "    transitions: [{ to: review, description: hand off }]",
        "  review:",
        "    type: human",
        "    instructions: Approve the decision.",
        "    transitions: [{ to: done }]",
        "  done: {}",
      ].join("\n"),
    );

    const result = await validateWorkflow({ workflow: "wf", rootDir: root });
    expect(result.valid).toBe(false);
    const diagnostic = result.diagnostics.find(
      (d) => d.field === "states.review.transitions.0.description",
    );
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.message).toContain("must be a non-empty string");
  });

  it("flags a human node with two transitions of the same labeled type", async () => {
    writeWorkflow(
      [
        "states:",
        "  a:",
        "    triggers: { manual: }",
        "    transitions: [{ to: review, description: hand off }]",
        "  review:",
        "    type: human",
        "    instructions: Approve the decision.",
        "    transitions:",
        "      - { to: done, type: approve, description: Approve and close. }",
        "      - { to: also, type: approve, description: Approve differently. }",
        "  done: {}",
        "  also: {}",
      ].join("\n"),
    );

    const result = await validateWorkflow({ workflow: "wf", rootDir: root });
    expect(result.valid).toBe(false);
    expect(
      result.diagnostics.some(
        (d) =>
          d.severity === "error" &&
          /declares 2 'approve' transitions/.test(d.message),
      ),
    ).toBe(true);
  });

  it("flags an unknown transition type", async () => {
    writeWorkflow(
      [
        "states:",
        "  a:",
        "    triggers: { manual: }",
        "    transitions: [{ to: review, description: hand off }]",
        "  review:",
        "    type: human",
        "    instructions: Approve the decision.",
        "    transitions: [{ to: done, type: escalate, description: Escalate it. }]",
        "  done: {}",
      ].join("\n"),
    );

    const result = await validateWorkflow({ workflow: "wf", rootDir: root });
    expect(result.valid).toBe(false);
    expect(
      result.diagnostics.some(
        (d) => d.severity === "error" && /unknown type 'escalate'/.test(d.message),
      ),
    ).toBe(true);
  });

  it("flags an unknown node type", async () => {
    writeWorkflow(
      [
        "states:",
        "  a:",
        "    triggers: { manual: }",
        "    type: robot",
        "    transitions: [{ to: done, description: go }]",
        "  done: {}",
      ].join("\n"),
    );

    const result = await validateWorkflow({ workflow: "wf", rootDir: root });
    expect(result.valid).toBe(false);
    expect(
      result.diagnostics.some(
        (d) => d.severity === "error" && /unknown state type 'robot'/.test(d.message),
      ),
    ).toBe(true);
  });

  it("accepts a well-formed human node", async () => {
    writeWorkflow(
      [
        "states:",
        "  a:",
        "    triggers: { manual: }",
        "    instructions: Prepare the decision.",
        "    transitions: [{ to: review, description: hand off }]",
        "  review:",
        "    type: human",
        "    instructions: Approve or refine the recorded decision.",
        "    transitions:",
        "      - { to: done, type: approve, description: Approve the decision. }",
        "      - { to: a, type: refine, description: Send it back for refinement. }",
        "  done: {}",
      ].join("\n"),
    );

    const result = await validateWorkflow({ workflow: "wf", rootDir: root });
    const humanErrors = result.diagnostics.filter(
      (d) => d.severity === "error" && /human state/i.test(d.message),
    );
    expect(humanErrors).toEqual([]);
  });
});

describe("validateWorkflow — human nodes that cannot do what they declare", () => {
  const errors = (result: { diagnostics: { severity: string; message: string }[] }, re: RegExp) =>
    result.diagnostics.filter((d) => d.severity === "error" && re.test(d.message));

  // A decision routes the run *out* of the node. A self-targeted edge is offered
  // to the reviewer as a button and then has nowhere to go, so the runtime ends
  // the run instead of routing — the review a person asked to continue is over.
  it("flags a human node transition that targets the node itself", async () => {
    writeWorkflow(
      [
        "states:",
        "  a:",
        "    triggers: { manual: }",
        "    transitions: [{ to: review, description: hand off }]",
        "  review:",
        "    type: human",
        "    instructions: Approve the decision.",
        "    transitions:",
        "      - { to: done, type: approve, description: Approve it. }",
        "      - { to: review, type: refine, description: Look at it again. }",
        "  done: {}",
      ].join("\n"),
    );

    const result = await validateWorkflow({ workflow: "wf", rootDir: root });
    expect(result.valid).toBe(false);
    expect(errors(result, /Human state 'review' declares a transition to itself/)).toHaveLength(1);
  });

  // A human node never ran a hook, and now no state does: a leftover slot is the
  // unrecognized key it is, on a human node exactly as on any other state.
  it.each(["before", "after"] as const)("refuses a leftover '%s:' on a human node as an unrecognized key", async (phase) => {
    writeWorkflow(
      [
        "states:",
        "  a:",
        "    triggers: { manual: }",
        "    transitions: [{ to: review, description: hand off }]",
        "  review:",
        "    type: human",
        "    instructions: Approve the decision.",
        `    ${phase}: { rubric: { instructions: review it } }`,
        "    transitions: [{ to: done, type: approve, description: Approve it. }]",
        "  done: {}",
      ].join("\n"),
    );

    const result = await validateWorkflow({ workflow: "wf", rootDir: root });
    expect(result.valid).toBe(false);
    const found = errors(result, new RegExp(`Unrecognized key: "${phase}"`));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ field: "states.review" });
  });

  // What a hook on the reviewed state used to check is a grader in front of the
  // human node now: an ordinary state on the graph, which validates clean.
  it("accepts a grader in front of a human node", async () => {
    writeWorkflow(
      [
        "instructions: Draft, grade, then approve.",
        "states:",
        "  a:",
        "    triggers: { manual: }",
        "    instructions: Draft the reply.",
        "    transitions: [{ to: grade, description: The draft is ready. }]",
        "  grade:",
        "    type: grader",
        "    instructions: Approve a polite reply; send anything else back with the fix.",
        "    transitions:",
        "      - { to: review, description: The reply is polite. }",
        "      - { to: a, description: The reply needs another pass. }",
        "  review:",
        "    type: human",
        "    instructions: Approve the decision.",
        "    transitions: [{ to: done, type: approve, description: Approve it. }]",
        "  done: {}",
      ].join("\n"),
    );

    const result = await validateWorkflow({ workflow: "wf", rootDir: root });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
