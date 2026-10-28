import { describe, expect, it } from "vitest";
import {
  PLATFORM_PROMPT_PATH,
  resolveCodeScript,
  runArtifactPaths,
  SCRIPTS_DIR,
  sessionPaths,
  specSnapshotPath,
  workflowPaths,
} from "./paths.js";

describe("constants", () => {
  it("exports the expected values", () => {
    expect(PLATFORM_PROMPT_PATH).toBe(".platform/system/GRAPH_STATE.md");
    expect(SCRIPTS_DIR).toBe("scripts");
  });
});

describe("workflowPaths", () => {
  it("produces workspace-relative paths for a named workflow", () => {
    expect(workflowPaths("order-lookup")).toEqual({
      platformPrompt: ".platform/system/GRAPH_STATE.md",
      agentsPrompt: "AGENTS.md",
      workflowYaml: "workflows/order-lookup/workflow.yaml",
      workflow: "workflows/order-lookup/WORKFLOW.md",
      testsDir: "workflows/order-lookup/tests",
      scriptsDir: "workflows/order-lookup/scripts",
    });
  });

  it("interpolates any workflow name", () => {
    expect(workflowPaths("refund-review").workflow).toBe("workflows/refund-review/WORKFLOW.md");
  });
});

describe("resolveCodeScript", () => {
  it("resolves a workflow-relative script under the workflow's scripts/", () => {
    expect(resolveCodeScript("order-lookup", "scripts/check-refund.js")).toEqual({
      ok: true,
      path: "workflows/order-lookup/scripts/check-refund.js",
    });
    expect(resolveCodeScript("order-lookup", " ./scripts/checks/screen.mjs ")).toEqual({
      ok: true,
      path: "workflows/order-lookup/scripts/checks/screen.mjs",
    });
  });

  it("accepts a climb that stays inside scripts/", () => {
    expect(resolveCodeScript("w", "scripts/a/../b.js")).toEqual({ ok: true, path: "workflows/w/scripts/b.js" });
  });

  it("refuses an empty path, an absolute path and the directory itself", () => {
    expect(resolveCodeScript("w", "  ")).toEqual({ ok: false, reason: "the code state's script path is empty" });
    const absolute = resolveCodeScript("w", "/workflows/w/scripts/a.js");
    expect(absolute.ok ? "" : absolute.reason).toMatch(/is an absolute path/);
    const directory = resolveCodeScript("w", "scripts/");
    expect(directory.ok ? "" : directory.reason).toMatch(/names the 'scripts\/' directory, not a file/);
  });

  // Confined to the workflow's own `scripts/`, so a code state's script is never
  // a file the agent's `archmax_run` could execute, nor another workflow's.
  it("refuses a path that leaves scripts/", () => {
    for (const declared of ["hooks/check.js", "../other/scripts/a.js", "scripts/../../x.js", "skills/s/run.js"]) {
      const resolved = resolveCodeScript("w", declared);
      expect(resolved.ok, declared).toBe(false);
      expect(resolved.ok ? "" : resolved.reason).toContain("resolves outside 'scripts/'");
    }
  });
});

describe("sessionPaths", () => {
  it("lays out a session's run folder session-qualified, with no run prefix", () => {
    expect(sessionPaths("session-1")).toEqual({
      base: "session-1",
      checkpointsDir: "session-1/checkpoints",
      artifactsDir: "session-1/artifacts",
      scratchpadDir: "session-1/scratchpad",
      largeToolResultsDir: "session-1/large_tool_results",
      conversationHistoryDir: "session-1/conversation_history",
    });
  });
});

describe("runArtifactPaths", () => {
  it("places observability artifacts under the session's artifacts dir", () => {
    expect(runArtifactPaths("session-1")).toEqual({
      runDir: "session-1/artifacts",
      graphJson: "session-1/artifacts/graph.json",
      graphMermaid: "session-1/artifacts/graph.mmd",
      trajectoryJson: "session-1/artifacts/trajectory.json",
      metadataJson: "session-1/artifacts/metadata.json",
      trailJson: "session-1/artifacts/trail.json",
      variablesJson: "session-1/artifacts/variables.json",
    });
  });

  it("agrees with sessionPaths on the artifacts dir", () => {
    expect(runArtifactPaths("t").runDir).toBe(sessionPaths("t").artifactsDir);
  });
});

describe("specSnapshotPath", () => {
  it("addresses the shared, session-agnostic snapshot prefix", () => {
    expect(specSnapshotPath("abc123")).toBe("_specs/abc123.json");
  });
});
