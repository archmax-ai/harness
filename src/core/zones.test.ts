import { describe, expect, it } from "vitest";
import {
  classifyWorkspacePath,
  isReservedRootName,
  mountNameOf,
  SESSION_OPEN_DIR,
  sessionAreaNames,
} from "./zones.js";
import type { MountPrefixes } from "./mounts.js";

/** The mount keys a conventional workspace resolves to. */
const MOUNTS: MountPrefixes = {
  dirs: ["workflows", "skills", "subagents", "scripts", "data", ".platform"],
  files: ["AGENTS.md"],
  writable: [],
  governed: [],
  unsearchable: [],
};

describe("classifyWorkspacePath", () => {
  it("classifies authored mounts and root files", () => {
    expect(classifyWorkspacePath("skills/refund/SKILL.md", MOUNTS)).toBe("authored");
    expect(classifyWorkspacePath("workflows/order-lookup/workflow.yaml", MOUNTS)).toBe("authored");
    expect(classifyWorkspacePath("data/orders.json", MOUNTS)).toBe("authored");
    expect(classifyWorkspacePath(".platform/system/GRAPH_STATE.md", MOUNTS)).toBe("authored");
    expect(classifyWorkspacePath("AGENTS.md", MOUNTS)).toBe("authored");
  });

  it("does not treat a lookalike of an authored root file as authored", () => {
    expect(classifyWorkspacePath("AGENTS.md.bak", MOUNTS)).toBe("run");
  });

  /**
   * A nested key is a read-only authored zone exactly as a single-segment one
   * is, and a sibling under the same first segment is not.
   */
  it("classifies a nested mount name as authored and its sibling as run", () => {
    const nested: MountPrefixes = {
      dirs: ["catalogs/eu"],
      files: [],
      writable: [],
      governed: [],
      unsearchable: [],
    };
    expect(classifyWorkspacePath("catalogs/eu/skus.csv", nested)).toBe("authored");
    expect(classifyWorkspacePath("catalogs/uk/skus.csv", nested)).toBe("run");
    expect(classifyWorkspacePath("catalogs", nested)).toBe("run");
  });

  it("lets the longest mount name decide the write posture", () => {
    // `/catalogs/` read-only with a writable `/catalogs/scratch/` inside it.
    const overlapping: MountPrefixes = {
      dirs: ["catalogs", "catalogs/scratch"],
      files: [],
      writable: ["catalogs/scratch"],
      governed: [],
      unsearchable: [],
    };
    expect(classifyWorkspacePath("catalogs/eu/skus.csv", overlapping)).toBe("authored");
    expect(classifyWorkspacePath("catalogs/scratch/draft.csv", overlapping)).toBe("run");
  });

  it("does not classify a writable mount as authored", () => {
    // A writable mount's paths are governed like run paths, not read-only.
    const withWritable: MountPrefixes = { dirs: ["memories"], files: [], writable: ["memories"], governed: [], unsearchable: [] };
    expect(classifyWorkspacePath("memories/notes.md", withWritable)).toBe("run");
  });

  it("classifies nothing as authored without a mount table", () => {
    // A caller probing the kernel in isolation: authored read-only enforcement
    // rests on the mounts themselves, so run-state classification is safe.
    for (const p of ["skills/refund/SKILL.md", "data/orders.json", "AGENTS.md"]) {
      expect(classifyWorkspacePath(p), p).toBe("run");
    }
  });

  it("classifies an unmounted directory as run state", () => {
    expect(classifyWorkspacePath("notes/today.md", MOUNTS)).toBe("run");
  });

  it("classifies run areas", () => {
    expect(classifyWorkspacePath("output/answer.json")).toBe("run");
    expect(classifyWorkspacePath("scratchpad/notes.txt")).toBe("run-open");
    expect(classifyWorkspacePath("large_tool_results/call_1.txt")).toBe("run-offload");
    expect(classifyWorkspacePath("conversation_history/session.md")).toBe("run-offload");
    expect(classifyWorkspacePath("checkpoints/cp-1.json")).toBe("run-internal");
    expect(classifyWorkspacePath("artifacts/graph.json")).toBe("run-internal");
    expect(classifyWorkspacePath("_specs/abc.json")).toBe("run-internal");
    expect(classifyWorkspacePath("report.md")).toBe("run");
  });

  it("classifies equivalent spellings identically", () => {
    for (const spelling of ["/data/orders.json", "./data/orders.json", "//data//orders.json", "data/./orders.json"]) {
      expect(classifyWorkspacePath(spelling, MOUNTS)).toBe("authored");
    }
    expect(classifyWorkspacePath("./scratchpad/x", MOUNTS)).toBe("run-open");
    expect(classifyWorkspacePath("/skills/", MOUNTS)).toBe("authored");
  });

  it("resolves traversal before classifying", () => {
    // Climbing out of the scratchpad is not scratchpad access.
    expect(classifyWorkspacePath("scratchpad/../checkpoints/cp-1.json")).toBe("run-internal");
    expect(classifyWorkspacePath("scratchpad/../output/x")).toBe("run");
    expect(classifyWorkspacePath("output/../../secrets")).toBe("escapes");
    expect(classifyWorkspacePath("../secrets")).toBe("escapes");
  });

  it("classifies the root itself", () => {
    expect(classifyWorkspacePath("")).toBe("root");
    expect(classifyWorkspacePath("/")).toBe("root");
    expect(classifyWorkspacePath("./")).toBe("root");
  });
});

describe("isReservedRootName", () => {
  it("reserves the framework's run areas with no mount table", () => {
    for (const name of sessionAreaNames()) {
      expect(isReservedRootName(name), name).toBe(true);
    }
    // Authored names are workspace shape: not reserved until a table says so.
    expect(isReservedRootName("skills")).toBe(false);
    expect(isReservedRootName("skills", MOUNTS)).toBe(true);
    expect(isReservedRootName("AGENTS.md", MOUNTS)).toBe(true);
  });

  it("covers authored mounts, authored root files, and run areas", () => {
    for (const name of [
      "skills",
      "data",
      "workflows",
      ".platform",
      "AGENTS.md",
      "checkpoints",
      "artifacts",
      "_specs",
      "large_tool_results",
      "conversation_history",
      SESSION_OPEN_DIR,
    ]) {
      expect(isReservedRootName(name, MOUNTS), name).toBe(true);
    }
  });

  it("does not reserve `output` — the framework owns no such area", () => {
    expect(isReservedRootName("output")).toBe(false);
    expect(isReservedRootName("output", MOUNTS)).toBe(false);
  });

  it("leaves ordinary session ids usable", () => {
    expect(isReservedRootName("session-1", MOUNTS)).toBe(false);
    expect(isReservedRootName("skills-review", MOUNTS)).toBe(false);
  });

  /**
   * A nested mount reserves its own first segment: a session folder named
   * `catalogs` would route `catalogs/eu/…` into the mount instead of the run.
   */
  it("reserves the first segment of a nested mount name", () => {
    const nested: MountPrefixes = {
      dirs: ["catalogs/eu"],
      files: ["config/app.json"],
      writable: [],
      governed: [],
      unsearchable: [],
    };
    expect(isReservedRootName("catalogs", nested)).toBe(true);
    expect(isReservedRootName("config", nested)).toBe(true);
    expect(isReservedRootName("catalog", nested)).toBe(false);
  });
});

/** A mount key of several segments is an ordinary mount, matched by longest prefix. */
describe("mountNameOf", () => {
  const NESTED: MountPrefixes = {
    dirs: ["catalogs", "catalogs/eu", "reference"],
    files: ["AGENTS.md"],
    writable: [],
    governed: [],
    unsearchable: [],
  };

  it("returns the longest matching name", () => {
    expect(mountNameOf("catalogs/eu/skus.csv", NESTED)).toBe("catalogs/eu");
    expect(mountNameOf("catalogs/uk/skus.csv", NESTED)).toBe("catalogs");
    expect(mountNameOf("catalogs/eu", NESTED)).toBe("catalogs/eu");
  });

  it("matches a single-segment name and an exact file mount", () => {
    expect(mountNameOf("reference/rates.csv", NESTED)).toBe("reference");
    expect(mountNameOf("AGENTS.md", NESTED)).toBe("AGENTS.md");
    expect(mountNameOf("AGENTS.md.bak", NESTED)).toBeNull();
  });

  it("returns null for a path under no mount, and for a lookalike prefix", () => {
    expect(mountNameOf("scratchpad/notes.md", NESTED)).toBeNull();
    expect(mountNameOf("references/rates.csv", NESTED)).toBeNull();
    expect(mountNameOf("reference/rates.csv")).toBeNull();
  });
});
