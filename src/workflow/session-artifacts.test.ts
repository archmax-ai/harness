import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendProtocolV2 } from "deepagents";
import { Workspace } from "../core/workspace.js";
import {
  writeRunArtifacts,
  type SerializedGraph,
  type Trajectory,
} from "./session-artifacts.js";

function recordingBackend(sink: Record<string, string>): BackendProtocolV2 {
  return {
    async write(filePath: string, content: string) {
      sink[filePath] = content;
      return { path: filePath, filesUpdate: null };
    },
  } as unknown as BackendProtocolV2;
}

function failingBackend(): BackendProtocolV2 {
  return {
    async write() {
      return { error: "disk full" };
    },
  } as unknown as BackendProtocolV2;
}

const graph: SerializedGraph = {
  nodes: ["init", "identify_case"],
  edges: [{ source: "init", target: "identify_case", conditional: true }],
  entry: "identify_case",
  finals: ["done"],
  mermaid: "graph TD;\n",
};

describe("writeRunArtifacts", () => {
  afterEach(() => vi.restoreAllMocks());

  const trajectory: Trajectory = {
    sessionId: "r1",
    workflow: "order-lookup",
    finalAnswer: "done",
    segments: [],
  };

  it("writes graph.json, graph.mmd, and trajectory.json under the run dir", async () => {
    const sink: Record<string, string> = {};
    const ws = new Workspace(recordingBackend(sink));

    const runDir = await writeRunArtifacts(ws, "order-lookup", "r1", { graph, trajectory });

    expect(runDir).toBe("r1/artifacts");
    expect(Object.keys(sink).sort()).toEqual([
      "/r1/artifacts/graph.json",
      "/r1/artifacts/graph.mmd",
      "/r1/artifacts/trajectory.json",
    ]);
    expect(JSON.parse(sink["/r1/artifacts/graph.json"]!).entry).toBe("identify_case");
  });

  it("writes metadata.json with the resolved runtime contract and package version", async () => {
    const sink: Record<string, string> = {};
    const ws = new Workspace(recordingBackend(sink));

    await writeRunArtifacts(ws, "order-lookup", "r9", {
      graph,
      trajectory,
      metadata: {
        runtimeContract: { engine: "archmax-harness", version: "1", source: "declared", sandbox: 1, testFormat: "1" },
        packageVersion: "1.2.3",
      },
    });

    const metaRaw = sink["/r9/artifacts/metadata.json"];
    expect(metaRaw).toBeDefined();
    const meta = JSON.parse(metaRaw!);
    expect(meta.runtimeContract).toEqual({
      engine: "archmax-harness",
      version: "1",
      source: "declared",
      sandbox: 1,
      testFormat: "1",
    });
    expect(meta.packageVersion).toBe("1.2.3");
    expect(meta.workflow).toBe("order-lookup");
    expect(meta.sessionId).toBe("r9");
  });

  it("omits metadata.json when no metadata is supplied", async () => {
    const sink: Record<string, string> = {};
    const ws = new Workspace(recordingBackend(sink));
    await writeRunArtifacts(ws, "order-lookup", "r1", { graph, trajectory });
    expect(sink["/r1/artifacts/metadata.json"]).toBeUndefined();
  });

  it("writes trail.json with the supplied audit trail steps", async () => {
    const sink: Record<string, string> = {};
    const ws = new Workspace(recordingBackend(sink));

    const steps = [
      { to: "identify_case", kind: "trigger" as const, ts: 1 },
      { to: "refund_request", kind: "agent" as const, reason: "refund ask", ts: 2 },
      { to: "refund_closed", kind: "human" as const, reason: "looks correct", ts: 3 },
    ];
    await writeRunArtifacts(ws, "order-lookup", "r1", { graph, trajectory, trail: steps });

    const raw = sink["/r1/artifacts/trail.json"];
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual({
      sessionId: "r1",
      workflow: "order-lookup",
      steps,
    });
  });

  it("omits trail.json when no trail is supplied", async () => {
    const sink: Record<string, string> = {};
    const ws = new Workspace(recordingBackend(sink));
    await writeRunArtifacts(ws, "order-lookup", "r1", { graph, trajectory });
    expect(sink["/r1/artifacts/trail.json"]).toBeUndefined();
  });

  it("writes variables.json with each variable's value and lock state", async () => {
    const sink: Record<string, string> = {};
    const ws = new Workspace(recordingBackend(sink));

    await writeRunArtifacts(ws, "order-lookup", "r1", {
      graph,
      trajectory,
      variables: {
        // Host-established (a seed, a delivery, or the built-in trigger)…
        trigger: { value: "email_received", locked: true },
        from_email: { value: "a@b.c", locked: true },
        // …beside what the agent established itself.
        case_id: { value: "K-9", locked: false },
      },
    });

    const raw = sink["/r1/artifacts/variables.json"];
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual({
      sessionId: "r1",
      workflow: "order-lookup",
      variables: {
        trigger: { value: "email_received", locked: true },
        from_email: { value: "a@b.c", locked: true },
        case_id: { value: "K-9", locked: false },
      },
    });
  });

  it("writes a structured value whole", async () => {
    const sink: Record<string, string> = {};
    const ws = new Workspace(recordingBackend(sink));

    const order = { id: 7, items: [{ sku: "A-1" }, { sku: "B-2" }] };
    await writeRunArtifacts(ws, "order-lookup", "r1", {
      graph,
      trajectory,
      variables: { order: { value: order, locked: true }, tags: { value: ["x"], locked: false } },
    });

    const parsed = JSON.parse(sink["/r1/artifacts/variables.json"]!);
    expect(parsed.variables.order.value).toEqual(order);
    expect(parsed.variables.tags.value).toEqual(["x"]);
  });

  it("drops in-flight merge markers rather than recording them as run state", async () => {
    const sink: Record<string, string> = {};
    const ws = new Workspace(recordingBackend(sink));

    await writeRunArtifacts(ws, "order-lookup", "r1", {
      graph,
      trajectory,
      variables: {
        from_email: { value: "a@b.c", locked: true, reseed: true },
        case_id: { value: "K-9", locked: false },
      },
    });

    expect(JSON.parse(sink["/r1/artifacts/variables.json"]!).variables).toEqual({
      from_email: { value: "a@b.c", locked: true },
      case_id: { value: "K-9", locked: false },
    });
  });

  it("writes an empty store, because empty and absent are different facts", async () => {
    const sink: Record<string, string> = {};
    const ws = new Workspace(recordingBackend(sink));

    await writeRunArtifacts(ws, "order-lookup", "r1", { graph, trajectory, variables: {} });

    expect(JSON.parse(sink["/r1/artifacts/variables.json"]!)).toEqual({
      sessionId: "r1",
      workflow: "order-lookup",
      variables: {},
    });
  });

  it("omits variables.json when no store is supplied", async () => {
    const sink: Record<string, string> = {};
    const ws = new Workspace(recordingBackend(sink));
    await writeRunArtifacts(ws, "order-lookup", "r1", { graph, trajectory });
    expect(sink["/r1/artifacts/variables.json"]).toBeUndefined();
  });

  it("is best-effort about variables too: a write failure warns and returns null", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ws = new Workspace(failingBackend());

    const runDir = await writeRunArtifacts(ws, "order-lookup", "r1", {
      graph,
      trajectory,
      variables: { from_email: { value: "a@b.c", locked: true } },
    });

    expect(runDir).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("is best-effort: a write failure warns and returns null", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ws = new Workspace(failingBackend());

    const runDir = await writeRunArtifacts(ws, "order-lookup", "r1", { graph, trajectory });

    expect(runDir).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("disk full");
  });
});
