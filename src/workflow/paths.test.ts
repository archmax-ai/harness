import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKFLOW,
  PLATFORM_PROMPT_PATH,
  runArtifactPaths,
  sessionPaths,
  specSnapshotPath,
  workflowPaths,
} from "./paths.js";

describe("constants", () => {
  it("exports the expected values", () => {
    expect(DEFAULT_WORKFLOW).toBe("order-lookup");
    expect(PLATFORM_PROMPT_PATH).toBe(".platform/system/GRAPH_STATE.md");
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
      hooksDir: "workflows/order-lookup/hooks",
    });
  });

  it("interpolates any workflow name", () => {
    expect(workflowPaths("refund-review").workflow).toBe("workflows/refund-review/WORKFLOW.md");
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
