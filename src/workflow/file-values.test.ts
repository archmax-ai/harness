import { describe, expect, it } from "vitest";
import type { MountPrefixes } from "../core/mounts.js";
import { compileForbiddenMountRules } from "../kernel/kernel.js";
import { WorkflowMachine } from "../machine/machine.js";
import type { MachineSpec } from "../machine/types.js";
import { fileGovernance, fileValueCheck, runtimeReadDenial, type FileGovernance } from "./file-values.js";
import { fileValueIssues } from "./signature-checks.js";

const MOUNTS: MountPrefixes = {
  dirs: ["skills", "reference"],
  files: ["AGENTS.md"],
  writable: [],
  governed: ["reference"],
  unsearchable: [],
};
const SKILLS = [{ slug: "billing", prefix: "skills/billing" }];

const SPEC: MachineSpec = {
  mounts: { allow_always: ["reference"] },
  states: { work: { triggers: { manual: null } } },
};

/** What the workspace holds, as the probe reports it. */
const ENTRIES: Record<string, "file" | "directory"> = {
  "scratchpad/attachments/invoice.pdf": "file",
  "scratchpad/attachments": "directory",
  "skills/billing/assets/template.pdf": "file",
  "reference/salaries.pdf": "file",
  "checkpoints/cp-1.json": "file",
};

function governance(spec: MachineSpec = SPEC, policyRules: FileGovernance["policyRules"] = []): FileGovernance {
  return fileGovernance({
    machine: WorkflowMachine.fromSpec(spec),
    policyRules,
    mountPrefixes: MOUNTS,
    skills: SKILLS,
    kind: async (path) => ENTRIES[path] ?? "missing",
  });
}

const FILE = [{ name: "doc", type: "file" as const }];
const issuesFor = (value: unknown, gov = governance()) =>
  fileValueIssues(FILE, { doc: value }, fileValueCheck(gov, "work", {}));

describe("fileValueIssues", () => {
  it("passes a session file and an authored file the session may read", async () => {
    expect(await issuesFor("scratchpad/attachments/invoice.pdf")).toEqual([]);
    expect(await issuesFor("/scratchpad/attachments/invoice.pdf")).toEqual([]);
    expect(await issuesFor("skills/billing/assets/template.pdf")).toEqual([]);
  });

  it("names a path with nothing at it, and a folder", async () => {
    expect(await issuesFor("scratchpad/attachments/missing.pdf")).toEqual([
      {
        kind: "invalid",
        name: "doc",
        type: "file",
        found: "string",
        message: "'doc' must name a file, but nothing is at 'scratchpad/attachments/missing.pdf'",
      },
    ]);
    const [folder] = await issuesFor("scratchpad/attachments");
    expect(folder?.message).toBe("'doc' must name a file, but 'scratchpad/attachments' is a folder");
  });

  it("refuses a runtime-internal path, whatever is there", async () => {
    const [issue] = await issuesFor("checkpoints/cp-1.json");
    expect(issue?.message).toMatch(/^'doc' names 'checkpoints\/cp-1\.json', which this session may not read: /);
  });

  it("refuses a path under a mount the workflow forbids", async () => {
    const spec: MachineSpec = { ...SPEC, mounts: { allow_always: ["reference"], forbid_always: ["reference"] } };
    const [issue] = await issuesFor("reference/salaries.pdf", governance(spec));
    expect(issue?.message).toMatch(/^'doc' names 'reference\/salaries\.pdf', which this session may not read: /);
    expect(issue?.message).toContain("'mounts.forbid_always' denies in every state");
  });

  it("refuses a path under a governed mount the workflow grants in no state", async () => {
    const spec: MachineSpec = { states: { work: { triggers: { manual: null } } } };
    const [issue] = await issuesFor("reference/salaries.pdf", governance(spec));
    expect(issue?.message).toMatch(/^'doc' names 'reference\/salaries\.pdf', which this session may not read: /);
    expect(issue?.message).toContain("no grant of this workflow names");
  });

  it("passes a path under a governed mount another state of the workflow grants", async () => {
    const spec: MachineSpec = {
      states: {
        work: { triggers: { manual: null }, transitions: [{ to: "review", description: "Test edge." }] },
        review: { mounts: { allow: ["reference"] } },
      },
    };
    expect(await issuesFor("reference/salaries.pdf", governance(spec))).toEqual([]);
  });

  it("refuses a path under a mount an ancestor forbids, as a child inherits it", async () => {
    const inherited = compileForbiddenMountRules(["reference"], "root");
    const [issue] = await issuesFor("reference/salaries.pdf", governance(SPEC, inherited));
    expect(issue?.message).toContain("root");
  });

  it("leaves a malformed or unset value, and other types, to the pure rule", async () => {
    expect(await issuesFor("scratchpad/")).toEqual([]);
    expect(await issuesFor(42)).toEqual([]);
    expect(await fileValueIssues([{ name: "doc", type: "string" }], { doc: "x" }, fileValueCheck(governance(), "work", {}))).toEqual([]);
    expect(await fileValueIssues(FILE, {}, fileValueCheck(governance(), "work", {}))).toEqual([]);
  });
});

describe("runtimeReadDenial", () => {
  it("decides on runtime authority: a state's allow list does not bind it", () => {
    const spec: MachineSpec = {
      states: { work: { triggers: { manual: null }, tools: { allow: [{ tool: "read_file", paths: ["scratchpad/**"] }] } } },
    };
    expect(runtimeReadDenial(governance(spec), "work", "skills/billing/assets/template.pdf", {})).toBeUndefined();
  });
});
