import { describe, expect, it } from "vitest";
import type { BackendProtocolV2 } from "deepagents";
import { Workspace } from "../core/workspace.js";
import { WorkflowMachine } from "./machine.js";

const SPEC_PATHS = { workflowYaml: "workflow.yaml", workflow: "WORKFLOW.md" };

/**
 * The mount names the host declared **governed**, in table order. An ungoverned
 * mount is deliberately absent: the resolution only ever answers for governed
 * names, because an ungoverned mount is visible in every state without a grant.
 */
const GOVERNED = ["reference", "catalogs/eu", "catalogs/uk"];

/** The resolved table those names come from: `shared` is the writable one. */
const PREFIXES = {
  dirs: ["reference", "catalogs/eu", "catalogs/uk", "shared", "skills"],
  files: [],
  writable: ["shared"],
  governed: ["reference", "catalogs/eu", "catalogs/uk", "shared"],
  unsearchable: [],
};

async function machineFor(yaml: string) {
  const backend = {
    async readRaw(filePath: string) {
      if (filePath.replace(/^\/+/, "") !== "workflow.yaml") return { error: "missing" };
      return {
        data: { content: `${yaml.trim()}\n`, mimeType: "text/plain", created_at: "", modified_at: "" },
      };
    },
  } as unknown as BackendProtocolV2;
  const machine = await WorkflowMachine.load(new Workspace(backend), SPEC_PATHS);
  if (!machine) throw new Error("machine failed to load");
  return machine;
}

describe("mount resolution", () => {
  it("enables no governed mount when nothing grants one", async () => {
    const machine = await machineFor(`
states:
  lookup:
    triggers: { manual: }
`);
    expect(machine.spec.mounts).toBeUndefined();
    expect(machine.workflowAlwaysMounts(GOVERNED)).toEqual([]);
    expect(machine.enabledMounts("lookup", GOVERNED)).toEqual([]);
    expect(machine.forbiddenMounts("lookup")).toEqual([]);
  });

  it("reaches a state that names nothing through allow_always", async () => {
    const machine = await machineFor(`
mounts:
  allow_always: [reference]
states:
  lookup:
    triggers: { manual: }
`);
    expect(machine.enabledMounts("lookup", GOVERNED)).toEqual(["reference"]);
  });

  it("adds a state's own grant to the always-on one", async () => {
    const machine = await machineFor(`
mounts:
  allow_always: [reference]
states:
  triage:
    triggers: { manual: }
    mounts:
      allow: [catalogs/eu]
  intake:
`);
    // Declaration order: the state's own list first, then the workflow's.
    expect(machine.enabledMounts("triage", GOVERNED)).toEqual(["catalogs/eu", "reference"]);
    expect(machine.enabledMounts("intake", GOVERNED)).toEqual(["reference"]);
  });

  it("names a mount at both levels once", async () => {
    const machine = await machineFor(`
mounts:
  allow_always: [reference]
states:
  lookup:
    triggers: { manual: }
    mounts:
      allow: [reference]
`);
    expect(machine.enabledMounts("lookup", GOVERNED)).toEqual(["reference"]);
  });

  it("drops a declared name the table does not govern", async () => {
    // An ungoverned mount needs no grant, so a grant naming one adds nothing to
    // the enabled set (and `validate` reports the entry inert).
    const machine = await machineFor(`
mounts:
  allow_always: [reference, skills]
states:
  lookup:
    triggers: { manual: }
    mounts:
      allow: [skills]
`);
    expect(machine.workflowAlwaysMounts(GOVERNED)).toEqual(["reference"]);
    expect(machine.enabledMounts("lookup", GOVERNED)).toEqual(["reference"]);
  });

  it("enables nothing when the table governs nothing, whatever is declared", async () => {
    const machine = await machineFor(`
mounts:
  allow_always: [reference]
states:
  lookup:
    triggers: { manual: }
`);
    expect(machine.enabledMounts("lookup", [])).toEqual([]);
  });

  it("treats an absent block exactly as an empty list", async () => {
    const machine = await machineFor(`
mounts:
  allow_always: []
states:
  says-nothing:
    triggers: { manual: }
  declares-none:
    mounts:
      allow: []
`);
    expect(machine.spec.states["says-nothing"]?.mounts).toBeUndefined();
    expect(machine.spec.states["declares-none"]?.mounts?.allow).toEqual([]);
    expect(machine.enabledMounts("says-nothing", GOVERNED)).toEqual([]);
    expect(machine.enabledMounts("declares-none", GOVERNED)).toEqual([]);
  });

  it("enables nothing for a state the spec does not declare", async () => {
    const machine = await machineFor(`
mounts:
  allow_always: [reference]
states:
  lookup:
    triggers: { manual: }
`);
    // A state slug nothing declares carries no grant of its own; the always-on
    // list is the whole answer, as it is for skills.
    expect(machine.enabledMounts("no-such-state", GOVERNED)).toEqual(["reference"]);
  });
});

describe("mount denial", () => {
  it("subtracts an always-on grant in the state that forbids it", async () => {
    const machine = await machineFor(`
mounts:
  allow_always: [reference, catalogs/eu]
states:
  route:
    triggers: { manual: }
    mounts:
      forbid: [reference]
  lookup:
`);
    expect(machine.enabledMounts("route", GOVERNED)).toEqual(["catalogs/eu"]);
    expect(machine.enabledMounts("lookup", GOVERNED)).toEqual(["reference", "catalogs/eu"]);
    expect(machine.forbiddenMounts("route")).toEqual(["reference"]);
    expect(machine.mountDenial("route", "reference")).toBe("state");
  });

  /**
   * An ungoverned mount is not in the enabled set at all — it is visible without
   * one — so a `forbid` naming it is reported by `forbiddenMounts`, which is
   * what the kernel consults for a mount no grant governs.
   */
  it("reports a forbid on an ungoverned mount", async () => {
    const machine = await machineFor(`
states:
  route:
    triggers: { manual: }
    mounts:
      forbid: [skills]
`);
    expect(machine.forbiddenMounts("route")).toEqual(["skills"]);
    expect(machine.mountDenial("route", "skills")).toBe("state");
    expect(machine.enabledMounts("route", GOVERNED)).toEqual([]);
  });

  it("beats a state's own grant with forbid_always, and says which level denied", async () => {
    const machine = await machineFor(`
mounts:
  allow_always: [reference]
  forbid_always: [reference]
states:
  triage:
    triggers: { manual: }
    mounts:
      allow: [reference, catalogs/eu]
`);
    expect(machine.enabledMounts("triage", GOVERNED)).toEqual(["catalogs/eu"]);
    expect(machine.workflowForbiddenMounts()).toEqual(["reference"]);
    expect(machine.mountDenial("triage", "reference")).toBe("workflow");
    expect(machine.mountDenial("triage", "catalogs/eu")).toBeUndefined();
  });

  it("lists denials workflow-wide first, each in declaration order", async () => {
    const machine = await machineFor(`
mounts:
  forbid_always: [catalogs/uk, reference]
states:
  route:
    triggers: { manual: }
    mounts:
      forbid: [catalogs/eu, reference]
`);
    // The workflow's list first, then what the state adds; the name both levels
    // carry appears once.
    expect(machine.forbiddenMounts("route")).toEqual([
      "catalogs/uk",
      "reference",
      "catalogs/eu",
    ]);
  });

  it("keeps the enabled set in declaration order, not sorted", async () => {
    const machine = await machineFor(`
mounts:
  allow_always: [catalogs/uk, reference]
states:
  triage:
    triggers: { manual: }
    mounts:
      allow: [catalogs/eu]
`);
    expect(machine.enabledMounts("triage", GOVERNED)).toEqual([
      "catalogs/eu",
      "catalogs/uk",
      "reference",
    ]);
  });
});

/**
 * A grant's second half: which states see a mount, and what they may do there.
 * The host's `readOnly` posture is the ceiling — `read_write` cannot open a
 * read-only mount — so this key's work is narrowing a writable one.
 */
describe("mount access", () => {
  it("takes the host's posture when a grant names no access", async () => {
    const machine = await machineFor(`
mounts:
  allow_always: [shared, reference]
states:
  work:
    triggers: { manual: }
`);
    expect(machine.mountWritable("work", "shared", PREFIXES)).toBe(true);
    expect(machine.mountWritable("work", "reference", PREFIXES)).toBe(false);
  });

  it("narrows a writable mount to reads where a grant says so", async () => {
    const machine = await machineFor(`
mounts:
  allow_always: [shared]
states:
  read-only-here:
    triggers: { manual: }
    mounts:
      allow: [{ mount: shared, access: read }]
  writes-here:
    mounts:
      allow: [{ mount: shared, access: read_write }]
`);
    expect(machine.mountWritable("read-only-here", "shared", PREFIXES)).toBe(false);
    expect(machine.mountWritable("writes-here", "shared", PREFIXES)).toBe(true);
    // Still enabled either way: access is not visibility.
    expect(machine.enabledMounts("read-only-here", PREFIXES.governed)).toEqual(["shared"]);
  });

  it("lets the workflow narrow a mount for every state", async () => {
    const machine = await machineFor(`
mounts:
  allow_always: [{ mount: shared, access: read }]
states:
  work:
    triggers: { manual: }
`);
    expect(machine.mountWritable("work", "shared", PREFIXES)).toBe(false);
  });

  /**
   * Read-only is a restriction, so it behaves like every other restriction
   * here: whichever level asks for it gets it, and no narrower level widens it
   * back.
   */
  it("does not let a state widen a workflow-wide narrowing", async () => {
    const machine = await machineFor(`
mounts:
  allow_always: [{ mount: shared, access: read }]
states:
  work:
    triggers: { manual: }
    mounts:
      allow: [{ mount: shared, access: read_write }]
`);
    expect(machine.mountWritable("work", "shared", PREFIXES)).toBe(false);
  });

  it("cannot open a mount the host serves read-only", async () => {
    const machine = await machineFor(`
mounts:
  allow_always: [{ mount: reference, access: read_write }]
states:
  work:
    triggers: { manual: }
`);
    expect(machine.mountWritable("work", "reference", PREFIXES)).toBe(false);
  });

  it("gives an ungoverned mount the host's posture, with no grant to qualify", async () => {
    const machine = await machineFor(`
states:
  work:
    triggers: { manual: }
`);
    const ungoverned = { ...PREFIXES, governed: [] };
    expect(machine.mountWritable("work", "shared", ungoverned)).toBe(true);
    expect(machine.mountWritable("work", "skills", ungoverned)).toBe(false);
  });
});
