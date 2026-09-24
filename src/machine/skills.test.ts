import { describe, expect, it } from "vitest";
import type { BackendProtocolV2 } from "deepagents";
import { Workspace } from "../core/workspace.js";
import { WorkflowMachine } from "./machine.js";

const SPEC_PATHS = { workflowYaml: "workflow.yaml", workflow: "WORKFLOW.md" };

/** Every skill the registry discovered, in the order discovery found them. */
const AVAILABLE = ["order-data", "refund-policy", "order-enrichment"];

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

describe("skill resolution", () => {
  it("enables nothing when nothing grants a skill", async () => {
    const machine = await machineFor(`
states:
  lookup:
    triggers: { manual: }
`);
    expect(machine.spec.skills).toBeUndefined();
    expect(machine.workflowAlwaysSkills(AVAILABLE)).toEqual([]);
    expect(machine.enabledSkills("lookup", AVAILABLE)).toEqual([]);
  });

  it("lets each state carry its own grant when the workflow grants none", async () => {
    const machine = await machineFor(`
skills:
  allow_always: []
states:
  lookup:
    triggers: { manual: }
    skills:
      allow: [order-data, refund-policy]
  refund-review:
    skills:
      allow: [refund-policy]
`);
    expect(machine.enabledSkills("lookup", AVAILABLE)).toEqual(["order-data", "refund-policy"]);
    expect(machine.enabledSkills("refund-review", AVAILABLE)).toEqual(["refund-policy"]);
  });

  it("treats an absent block exactly as an empty list", async () => {
    const machine = await machineFor(`
skills:
  allow_always: []
states:
  says-nothing:
    triggers: { manual: }
  declares-none:
    skills:
      allow: []
`);
    // The two are still distinguishable in the document — and mean the same
    // thing, the way an absent `tools.allow` and an empty one do.
    expect(machine.spec.states["says-nothing"]?.skills?.allow).toBeUndefined();
    expect(machine.spec.states["declares-none"]?.skills?.allow).toEqual([]);
    expect(machine.enabledSkills("says-nothing", AVAILABLE)).toEqual([]);
    expect(machine.enabledSkills("declares-none", AVAILABLE)).toEqual([]);
  });

  it("drops a declared slug the registry does not provide", async () => {
    const machine = await machineFor(`
skills:
  allow_always: [order-data, ghost-skill]
states:
  lookup:
    triggers: { manual: }
    skills:
      allow: [ghost-skill]
`);
    expect(machine.workflowAlwaysSkills(AVAILABLE)).toEqual(["order-data"]);
    expect(machine.enabledSkills("lookup", AVAILABLE)).toEqual(["order-data"]);
  });

  it("enables nothing when the registry is empty, whatever is declared", async () => {
    const machine = await machineFor(`
skills:
  allow_always: [order-data]
states:
  lookup:
    triggers: { manual: }
`);
    expect(machine.enabledSkills("lookup", [])).toEqual([]);
  });

  it("refuses to load entries that are not slug strings", async () => {
    // One mis-authored line is a load failure, reported by name, rather than a
    // silently narrowed surface.
    await expect(
      machineFor(`
skills:
  allow_always:
    - order-data
    - 7
states:
  lookup:
    triggers: { manual: }
`),
    ).rejects.toThrow();
    await expect(
      machineFor(`
states:
  lookup:
    triggers: { manual: }
    skills:
      forbid: "order-data"
`),
    ).rejects.toThrow();
  });

  it("refuses to load the retired root ceiling", async () => {
    // One skills model: a root `allow` is an unrecognized key, not a ceiling.
    // The diagnostic's wording is asserted in the schema suite.
    await expect(
      machineFor(`
skills:
  allow: [order-data]
states:
  lookup:
    triggers: { manual: }
`),
    ).rejects.toThrow();
  });

  it("resolves an unknown state to nothing, like any state with no list", async () => {
    const machine = await machineFor(`
skills:
  allow_always: []
states:
  lookup:
    triggers: { manual: }
`);
    expect(machine.enabledSkills("no-such-state", AVAILABLE)).toEqual([]);
  });

  it("orders the enabled set by declaration, stably", async () => {
    const machine = await machineFor(`
skills:
  allow_always: [refund-policy]
states:
  lookup:
    triggers: { manual: }
    skills:
      allow: [order-data]
`);
    // The state's own grant first, then the workflow's — declaration order
    // within each half, so a rendered section is byte-stable.
    expect(machine.enabledSkills("lookup", AVAILABLE)).toEqual(["order-data", "refund-policy"]);
  });
});

describe("skill resolution: the always-on grant", () => {
  it("enables a root 'allow_always' slug in a state that declares no block", async () => {
    const machine = await machineFor(`
skills:
  allow_always: [order-data]
states:
  lookup:
    triggers: { manual: }
  review: {}
`);
    expect(machine.workflowAlwaysSkills(AVAILABLE)).toEqual(["order-data"]);
    expect(machine.enabledSkills("lookup", AVAILABLE)).toEqual(["order-data"]);
    expect(machine.enabledSkills("review", AVAILABLE)).toEqual(["order-data"]);
  });

  it("adds a state's list to the always-on grant, the state's slugs first", async () => {
    const machine = await machineFor(`
skills:
  allow_always: [order-data]
states:
  lookup:
    triggers: { manual: }
  review:
    skills:
      allow: [refund-policy]
`);
    expect(machine.enabledSkills("review", AVAILABLE)).toEqual(["refund-policy", "order-data"]);
    // The state's grant reaches that state only.
    expect(machine.enabledSkills("lookup", AVAILABLE)).toEqual(["order-data"]);
  });

  it("enables a slug named at both levels once", async () => {
    const machine = await machineFor(`
skills:
  allow_always: [order-data]
states:
  lookup:
    triggers: { manual: }
    skills:
      allow: [order-data, refund-policy]
`);
    expect(machine.enabledSkills("lookup", AVAILABLE)).toEqual(["order-data", "refund-policy"]);
  });

  it("makes state lists the whole grant when 'allow_always' is empty", async () => {
    const machine = await machineFor(`
skills:
  allow_always: []
states:
  lookup:
    triggers: { manual: }
    skills:
      allow: [order-data]
  review: {}
`);
    expect(machine.workflowAlwaysSkills(AVAILABLE)).toEqual([]);
    // Present, so the additive model is in force: no ceiling to climb past.
    expect(machine.enabledSkills("lookup", AVAILABLE)).toEqual(["order-data"]);
    expect(machine.enabledSkills("review", AVAILABLE)).toEqual([]);
  });

  it("subtracts nothing when a state declares an empty list", async () => {
    const machine = await machineFor(`
skills:
  allow_always: [order-data]
states:
  route:
    triggers: { manual: }
    skills:
      allow: []
`);
    expect(machine.enabledSkills("route", AVAILABLE)).toEqual(["order-data"]);
  });

  it("drops a slug the registry does not provide, under either key", async () => {
    const machine = await machineFor(`
skills:
  allow_always: [order-data, order-enrichment]
states:
  lookup:
    triggers: { manual: }
    skills:
      allow: [refund-policy]
`);
    expect(machine.workflowAlwaysSkills(["order-data"])).toEqual(["order-data"]);
    expect(machine.enabledSkills("lookup", ["order-data"])).toEqual(["order-data"]);
  });

  it("grants a state's own list even when the root block is empty", async () => {
    const machine = await machineFor(`
skills: {}
states:
  lookup:
    triggers: { manual: }
    skills:
      allow: [order-data]
`);
    // A state's list is a grant, not a narrowing of something else.
    expect(machine.workflowAlwaysSkills(AVAILABLE)).toEqual([]);
    expect(machine.enabledSkills("lookup", AVAILABLE)).toEqual(["order-data"]);
  });
});

describe("skill resolution: denial", () => {
  it("lets a state's forbid subtract from the workflow's grant", async () => {
    const machine = await machineFor(`
skills:
  allow_always: [order-data, refund-policy]
states:
  route:
    triggers: { manual: }
    skills:
      forbid: [order-data]
  work: {}
`);
    expect(machine.enabledSkills("route", AVAILABLE)).toEqual(["refund-policy"]);
    // A state's denial is its own: the next state keeps the whole grant.
    expect(machine.enabledSkills("work", AVAILABLE)).toEqual(["order-data", "refund-policy"]);
  });

  it("beats a state's own allow", async () => {
    const machine = await machineFor(`
skills:
  allow_always: []
states:
  route:
    triggers: { manual: }
    skills:
      allow: [order-data]
      forbid: [order-data]
`);
    expect(machine.enabledSkills("route", AVAILABLE)).toEqual([]);
  });

  it("puts a workflow-wide denial out of reach of every state", async () => {
    const machine = await machineFor(`
skills:
  allow_always: [order-data]
  forbid_always: [refund-policy]
states:
  lookup:
    triggers: { manual: }
    skills:
      allow: [refund-policy]
  work: {}
`);
    expect(machine.workflowForbiddenSkills()).toEqual(["refund-policy"]);
    expect(machine.enabledSkills("lookup", AVAILABLE)).toEqual(["order-data"]);
    expect(machine.enabledSkills("work", AVAILABLE)).toEqual(["order-data"]);
  });

  it("reports which level denied a slug, and lists both without duplicates", async () => {
    const machine = await machineFor(`
skills:
  forbid_always: [order-data]
states:
  route:
    triggers: { manual: }
    skills:
      forbid: [order-data, refund-policy]
`);
    expect(machine.skillDenial("route", "order-data")).toBe("workflow");
    expect(machine.skillDenial("route", "refund-policy")).toBe("state");
    expect(machine.skillDenial("route", "order-enrichment")).toBeUndefined();
    expect(machine.forbiddenSkills("route")).toEqual(["order-data", "refund-policy"]);
  });

  it("is inert for a slug the registry does not provide", async () => {
    const machine = await machineFor(`
skills:
  allow_always: [order-data]
  forbid_always: [ghost-skill]
states:
  lookup:
    triggers: { manual: }
`);
    expect(machine.enabledSkills("lookup", AVAILABLE)).toEqual(["order-data"]);
  });
});
