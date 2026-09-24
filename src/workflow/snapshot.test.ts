import { afterEach, describe, expect, it, vi } from "vitest";
import type { MachineSpec } from "../machine/types.js";
import { computeSpecHash } from "./snapshot.js";
import type { BackendProtocolV2 } from "deepagents";
import { Workspace } from "../core/workspace.js";
import { readSpecSnapshot, writeSpecSnapshotIfAbsent } from "./snapshot.js";

const base: MachineSpec = {
  states: {
    a: { triggers: { manual: null }, transitions: [{ to: "b", description: "go" }] },
    b: {},
  },
};

describe("computeSpecHash", () => {
  it("is stable across object key ordering", () => {
    const reordered: MachineSpec = {
      states: {
        b: {},
        a: { transitions: [{ description: "go", to: "b" }], triggers: { manual: null } },
      },
    } as MachineSpec;
    expect(computeSpecHash(reordered)).toBe(computeSpecHash(base));
  });

  it("ignores undefined-valued fields", () => {
    const withUndef = { ...base, settings: undefined } as MachineSpec;
    expect(computeSpecHash(withUndef)).toBe(computeSpecHash(base));
  });

  it("changes when semantic content changes", () => {
    const changed: MachineSpec = {
      states: {
        a: { triggers: { manual: null }, transitions: [{ to: "b", description: "different" }] },
        b: {},
      },
    };
    expect(computeSpecHash(changed)).not.toBe(computeSpecHash(base));
  });

  // The slot exists so an authoring UI can keep its canvas state beside the
  // slugs it is keyed by. Moving a node is not a change to the machine, and a
  // session pinned to a `specHash` must not refuse to resume because of one.
  it("ignores host metadata", () => {
    const placed = { ...base, metadata: { nodes: { a: { x: 0, y: 40 } } } } as MachineSpec;
    const moved = { ...base, metadata: { nodes: { a: { x: 320, y: 40 } } } } as MachineSpec;
    expect(computeSpecHash(placed)).toBe(computeSpecHash(base));
    expect(computeSpecHash(moved)).toBe(computeSpecHash(placed));
  });

  // The literal is the point: normalization must not move the hash of a spec
  // whose text has not changed, or every existing durable session would refuse
  // to resume against an unchanged definition. It moves only when the document
  // does — as it did when a trigger became `triggers: { manual: }` on the state.
  it("pins the hash of the spec's current spelling", () => {
    expect(computeSpecHash(base)).toBe("f007501ce5dfe5c4f39719a81b0265d6");
  });

  // A state's mount governance is part of the machine, not presentation: a
  // session pinned to one spelling keeps the mounts it was started under.
  it("changes when a state's mounts block changes", () => {
    const governed: MachineSpec = {
      states: {
        a: {
          triggers: { manual: null },
          transitions: [{ to: "b", description: "go" }],
          mounts: { allow: ["catalogs/eu"] },
        },
        b: {},
      },
    };
    expect(computeSpecHash(governed)).not.toBe(computeSpecHash(base));
  });

  it("is order-sensitive for arrays (transition sequence is semantic)", () => {
    const swapped: MachineSpec = {
      states: {
        a: {
          triggers: { manual: null },
          transitions: [
            { to: "c", description: "second" },
            { to: "b", description: "first" },
          ],
        },
        b: {},
        c: {},
      },
    };
    const original: MachineSpec = {
      states: {
        a: {
          triggers: { manual: null },
          transitions: [
            { to: "b", description: "first" },
            { to: "c", description: "second" },
          ],
        },
        b: {},
        c: {},
      },
    };
    expect(computeSpecHash(swapped)).not.toBe(computeSpecHash(original));
  });
});

function memoryBackend(files = new Map<string, string>()): { backend: BackendProtocolV2; files: Map<string, string> } {
  const norm = (p: string) => `/${String(p).replace(/^\/+/, "")}`;
  const backend = {
    async readRaw(filePath: string) {
      const content = files.get(norm(filePath));
      return content === undefined
        ? { error: "missing" }
        : { data: { content, mimeType: "application/json", created_at: "", modified_at: "" } };
    },
    async write(filePath: string, content: string) {
      files.set(norm(filePath), content);
      return {};
    },
  } as unknown as BackendProtocolV2;
  return { backend, files };
}

function failingBackend(): BackendProtocolV2 {
  return {
    async readRaw() {
      return { error: "missing" };
    },
    async write() {
      return { error: "disk full" };
    },
  } as unknown as BackendProtocolV2;
}

const spec: MachineSpec = {
  states: { init: { transitions: [] } },
} as unknown as MachineSpec;

describe("writeSpecSnapshotIfAbsent / readSpecSnapshot", () => {
  afterEach(() => vi.restoreAllMocks());

  it("persists the spec on first write for a hash", async () => {
    const { backend, files } = memoryBackend();
    const ws = new Workspace(backend);

    await writeSpecSnapshotIfAbsent(ws, "hash1", spec);

    expect(files.get("/_specs/hash1.json")).toBeDefined();
    expect(JSON.parse(files.get("/_specs/hash1.json")!)).toEqual(spec);
  });

  // The store is content-addressed, and the idempotent-write rule leans on the
  // content being fully determined by the hash. Persisting the authored spec
  // rather than the hashed one would break that: two specs sharing a hash would
  // differ in bytes, and whichever session wrote first would decide the canvas
  // layout every later reader sees.
  it("persists the hashed document, without the presentation metadata", async () => {
    const { backend, files } = memoryBackend();
    const ws = new Workspace(backend);

    await writeSpecSnapshotIfAbsent(ws, "hash1", {
      ...spec,
      metadata: { nodes: { init: { x: 0, y: 40 } } },
    } as MachineSpec);

    expect(JSON.parse(files.get("/_specs/hash1.json")!)).toEqual(spec);
  });

  it("is a no-op when a snapshot for the hash already exists", async () => {
    const { backend, files } = memoryBackend();
    const ws = new Workspace(backend);
    const writeSpy = vi.spyOn(backend, "write");

    await writeSpecSnapshotIfAbsent(ws, "hash1", spec);
    writeSpy.mockClear();
    await writeSpecSnapshotIfAbsent(ws, "hash1", spec);

    expect(writeSpy).not.toHaveBeenCalled();
    expect(files.size).toBe(1);
  });

  it("swallows a write failure when the path already exists (create race)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const files = new Map<string, string>([["/_specs/hash1.json", JSON.stringify(spec)]]);
    const norm = (p: string) => `/${String(p).replace(/^\/+/, "")}`;
    const backend = {
      async readRaw(filePath: string) {
        const content = files.get(norm(filePath));
        return content === undefined
          ? { error: "missing" }
          : { data: { content, mimeType: "application/json", created_at: "", modified_at: "" } };
      },
      async write() {
        return { error: "already exists" };
      },
    } as unknown as BackendProtocolV2;
    const ws = new Workspace(backend);

    // exists() reports true, so the write path is never taken; this exercises
    // the ordinary no-op branch, confirming no warning fires.
    await writeSpecSnapshotIfAbsent(ws, "hash1", spec);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns on an unexpected write failure with no existing snapshot", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ws = new Workspace(failingBackend());

    await writeSpecSnapshotIfAbsent(ws, "hash1", spec);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("hash1");
  });

  it("resolves a known hash to its persisted spec", async () => {
    const { backend } = memoryBackend();
    const ws = new Workspace(backend);
    await writeSpecSnapshotIfAbsent(ws, "hash1", spec);

    await expect(readSpecSnapshot(ws, "hash1")).resolves.toEqual(spec);
  });

  it("resolves an unknown hash to null", async () => {
    const { backend } = memoryBackend();
    const ws = new Workspace(backend);

    await expect(readSpecSnapshot(ws, "unknown")).resolves.toBeNull();
  });
});
