import { describe, expect, it } from "vitest";
import type { MountPrefixes } from "../core/mounts.js";
import { compileForbiddenMountRules } from "../kernel/kernel.js";
import { WorkflowMachine } from "../machine/machine.js";
import type { SignatureEntry } from "../machine/signature.js";
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

describe("fileValueIssues and maxSize", () => {
  /** The sizes the probe reports; a path it does not know has no size it can tell. */
  const SIZES: Record<string, number> = {
    "scratchpad/attachments/invoice.pdf": 1000,
    "skills/billing/assets/template.pdf": 2000,
  };
  const sized = (sizes: Record<string, number> = SIZES): FileGovernance => ({
    ...governance(),
    size: async (path) => sizes[path],
  });
  const check = (entry: Omit<SignatureEntry, "name">, value: string, gov = sized()) =>
    fileValueIssues([{ name: "doc", ...entry }], { doc: value }, fileValueCheck(gov, "work", {}));

  it("passes a file at or under its limit", async () => {
    expect(await check({ type: "file", maxSize: 1000 }, "scratchpad/attachments/invoice.pdf")).toEqual([]);
    expect(await check({ type: "file", maxSize: 1001 }, "scratchpad/attachments/invoice.pdf")).toEqual([]);
  });

  it("refuses a file over its limit, naming the variable and the limit", async () => {
    expect(await check({ type: "file", maxSize: 1000 }, "skills/billing/assets/template.pdf")).toEqual([
      { kind: "invalid", name: "doc", type: "file", found: "string", rule: "maxSize", message: "'doc' must be at most 1 KB" },
    ]);
    const [issue] = await check({ type: "file", maxSize: 999 }, "scratchpad/attachments/invoice.pdf");
    expect(issue?.message).toBe("'doc' must be at most 999 bytes");
  });

  it("fails closed when the size cannot be told", async () => {
    const [issue] = await check({ type: "file", maxSize: 10_000_000 }, "scratchpad/attachments/invoice.pdf", sized({}));
    expect(issue).toMatchObject({ rule: "maxSize" });
    expect(issue?.message).toBe(
      "'doc' must be at most 10 MB, but the size of 'scratchpad/attachments/invoice.pdf' cannot be told",
    );
    // Without a size probe at all, the limit cannot be met either.
    const [unprobed] = await check({ type: "file", maxSize: 10 }, "scratchpad/attachments/invoice.pdf", governance());
    expect(unprobed).toMatchObject({ rule: "maxSize" });
  });

  it("reports a missing file before its size, and a broken accept rule not at all", async () => {
    const [missing, ...rest] = await check({ type: "file", maxSize: 1 }, "scratchpad/attachments/missing.pdf");
    expect(rest).toEqual([]);
    expect(missing?.message).toBe("'doc' must name a file, but nothing is at 'scratchpad/attachments/missing.pdf'");
    // The pure rule reports the extension; the file check adds nothing for the entry.
    expect(await check({ type: "file", accept: [".pdf"], maxSize: 1 }, "scratchpad/attachments/missing.png")).toEqual([]);
  });

  it("asks for no size when the entry declares no maxSize", async () => {
    let asked = false;
    const gov: FileGovernance = { ...governance(), size: async () => ((asked = true), 1) };
    expect(await check({ type: "file" }, "scratchpad/attachments/invoice.pdf", gov)).toEqual([]);
    expect(asked).toBe(false);
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
