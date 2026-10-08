import { describe, expect, it } from "vitest";
import type { BackendProtocolV2 } from "deepagents";
import { mountSubtree } from "./path-mapping.js";

/** Records the paths it was asked for and echoes them back in result paths. */
function recordingBackend() {
  const seen: string[] = [];
  const backend: BackendProtocolV2 = {
    ls: (path) => {
      seen.push(path);
      return { files: [{ path: `${path.replace(/\/$/, "")}/child.txt` }, { path: "/elsewhere/x" }] };
    },
    read: (filePath) => {
      seen.push(filePath);
      return { content: filePath };
    },
    readRaw: (filePath) => {
      seen.push(filePath);
      return {
        data: {
          content: filePath,
          mimeType: "text/plain",
          created_at: "2026-01-01T00:00:00.000Z",
          modified_at: "2026-01-01T00:00:00.000Z",
        },
      };
    },
    grep: (_pattern, path) => {
      seen.push(String(path));
      return { matches: [{ path: `${String(path).replace(/\/$/, "")}/hit.txt`, line: 1, text: "x" }] };
    },
    glob: (_pattern, path) => {
      seen.push(String(path));
      return { files: [{ path: `${String(path).replace(/\/$/, "")}/match.txt` }] };
    },
    write: (filePath) => {
      seen.push(filePath);
      return { path: filePath, filesUpdate: null };
    },
    edit: (filePath) => {
      seen.push(filePath);
      return { path: filePath, filesUpdate: null, occurrences: 1 };
    },
  };
  return { backend, seen };
}

describe("mountSubtree with a static prefix", () => {
  it("maps inbound paths and strips the prefix from result paths", async () => {
    const { backend, seen } = recordingBackend();
    const mounted = mountSubtree(backend, "skills");

    expect(await mounted.ls("/refund")).toEqual({
      files: [{ path: "/refund/child.txt" }, { path: "/elsewhere/x" }],
    });
    expect(seen).toEqual(["/skills/refund"]);

    expect(await mounted.write("/refund/SKILL.md", "x")).toMatchObject({
      path: "/refund/SKILL.md",
    });
    expect(await mounted.edit("/refund/SKILL.md", "a", "b")).toMatchObject({
      path: "/refund/SKILL.md",
    });
    expect(await mounted.grep("x", "/refund")).toEqual({
      matches: [{ path: "/refund/hit.txt", line: 1, text: "x" }],
    });
    expect(await mounted.glob("**/*.md", "/refund")).toEqual({
      files: [{ path: "/refund/match.txt" }],
    });
  });

  it("round-trips: a listed path is readable as listed", async () => {
    const { backend } = recordingBackend();
    const mounted = mountSubtree(backend, "skills");
    const listed = (await mounted.ls("/refund")).files?.[0].path as string;
    // The inner backend echoes the path it received, so a clean round trip
    // means the read landed on the prefixed form of the listed path.
    expect((await mounted.read(listed)).content).toBe("/skills/refund/child.txt");
  });

  it("handles the mount root and relative spellings", async () => {
    const { backend, seen } = recordingBackend();
    const mounted = mountSubtree(backend, "/skills/");
    await mounted.ls("/");
    await mounted.ls("");
    await mounted.read("refund/SKILL.md");
    expect(seen).toEqual(["/skills", "/skills", "skills/refund/SKILL.md"]);
  });

  it("leaves result paths outside the prefix untouched", async () => {
    const { backend } = recordingBackend();
    const mounted = mountSubtree(backend, "skills");
    const files = (await mounted.ls("/refund")).files ?? [];
    expect(files.map((f) => f.path)).toContain("/elsewhere/x");
  });

  it("passes optional search paths through when no prefix applies", async () => {
    const { backend, seen } = recordingBackend();
    const mounted = mountSubtree(backend, () => undefined);
    await mounted.grep("x", null);
    await mounted.glob("*", undefined);
    expect(seen).toEqual(["null", "undefined"]);
  });

  it("hands grep's match cap to the store", async () => {
    const { backend } = recordingBackend();
    const caps: unknown[] = [];
    const grep = backend.grep.bind(backend);
    backend.grep = (pattern, path, glob, maxCount) => {
      caps.push(maxCount);
      return grep(pattern, path, glob, maxCount);
    };
    const mounted = mountSubtree(backend, "skills");
    await mounted.grep("x", "/refund", null, 2);
    await mountSubtree(backend, "", { readOnly: true }).grep("x", "/refund", null, 3);
    expect(caps).toEqual([2, 3]);
  });
});

describe("mountSubtree with a dynamic prefix", () => {
  it("applies the prefix resolved per call, in both directions", async () => {
    const { backend, seen } = recordingBackend();
    let bound: string | undefined;
    const mounted = mountSubtree(backend, () => bound);

    bound = "session-1";
    expect((await mounted.ls("/output")).files?.[0].path).toBe("/output/child.txt");
    bound = "session-2";
    await mounted.ls("/output");
    bound = undefined;
    await mounted.ls("/output");

    expect(seen).toEqual(["/session-1/output", "/session-2/output", "/output"]);
  });

  it("honors a passthrough predicate for already-qualified paths", async () => {
    const { backend, seen } = recordingBackend();
    const mounted = mountSubtree(backend, () => "session-1", {
      passthrough: (rel, prefix) => rel === prefix || rel.startsWith(`${prefix}/`) || rel.startsWith("_specs/"),
    });

    await mounted.read("/session-1/checkpoints/cp-1.json");
    await mounted.read("/_specs/abc.json");
    await mounted.read("/output/answer.json");

    expect(seen).toEqual([
      "/session-1/checkpoints/cp-1.json",
      "/_specs/abc.json",
      "/session-1/output/answer.json",
    ]);
  });

  it("does not strip a passthrough path from result paths", async () => {
    const { backend } = recordingBackend();
    const mounted = mountSubtree(backend, () => "session-1", {
      passthrough: (rel, prefix) => rel.startsWith(`${prefix}/`),
    });
    const res = await mounted.write("/session-1/checkpoints/cp-1.json", "{}");
    expect(res.path).toBe("/session-1/checkpoints/cp-1.json");
  });
});

describe("mountSubtree raw-byte transfer", () => {
  /** A backend whose raw transfer records the paths it was handed and echoes them. */
  function transferBackend() {
    const { backend, seen } = recordingBackend();
    const uploaded: Array<[string, Uint8Array]> = [];
    const full: BackendProtocolV2 = {
      ...backend,
      downloadFiles: (paths) => {
        seen.push(...paths);
        return paths.map((path) => ({ path, content: new Uint8Array([1, 2]), error: null }));
      },
      uploadFiles: (files) => {
        uploaded.push(...files);
        return files.map(([path]) => ({ path, error: null }));
      },
    };
    return { backend: full, seen, uploaded };
  }

  it("maps paths in and out of downloads and uploads", async () => {
    const { backend, seen, uploaded } = transferBackend();
    const mounted = mountSubtree(backend, "skills");

    expect(await mounted.downloadFiles(["/refund/a.png"])).toEqual([
      { path: "/refund/a.png", content: new Uint8Array([1, 2]), error: null },
    ]);
    expect(seen).toEqual(["/skills/refund/a.png"]);

    expect(await mounted.uploadFiles!([["/refund/b.png", new Uint8Array([3])]])).toEqual([
      { path: "/refund/b.png", error: null },
    ]);
    expect(uploaded.map(([path]) => path)).toEqual(["/skills/refund/b.png"]);
  });

  it("refuses every upload on a read-only mount without delegating", async () => {
    const { backend, uploaded } = transferBackend();
    const mounted = mountSubtree(backend, "", { readOnly: true });

    expect(
      await mounted.uploadFiles!([
        ["/a.png", new Uint8Array([1])],
        ["/b.txt", new Uint8Array([2])],
      ]),
    ).toEqual([
      { path: "/a.png", error: "permission_denied" },
      { path: "/b.txt", error: "permission_denied" },
    ]);
    expect(uploaded).toEqual([]);
    // Reads stay open on a read-only mount.
    expect((await mounted.downloadFiles(["/a.png"]))[0]?.error).toBeNull();
  });

  it("keeps the protocol's optional methods optional when the wrapped backend lacks them", async () => {
    const { backend, seen } = recordingBackend();
    const mounted = mountSubtree(backend, "skills");

    // A download is answered through `readRaw`, never a throw: a feature check
    // that finds `downloadFiles` can rely on it.
    expect(await mounted.downloadFiles(["/refund/SKILL.md"])).toEqual([
      { path: "/refund/SKILL.md", content: new TextEncoder().encode("/skills/refund/SKILL.md"), error: null },
    ]);
    expect(seen).toEqual(["/skills/refund/SKILL.md"]);
    // No upload channel to forward: the method is absent, not a stand-in that throws.
    expect(mounted.uploadFiles).toBeUndefined();
    expect(await mounted.delete("/refund/SKILL.md")).toEqual({
      error: "Cannot delete 'refund/SKILL.md': the store serving it cannot delete.",
    });
  });

  it("refuses a text download it cannot hand over unchanged", async () => {
    const lossy: BackendProtocolV2 = {
      ...recordingBackend().backend,
      readRaw: () => ({ data: { content: "caf\uFFFD", mimeType: "text/plain", created_at: "", modified_at: "" } }),
    };
    expect(await mountSubtree(lossy, "").downloadFiles(["/latin1.txt"])).toEqual([
      { path: "/latin1.txt", content: null, error: "permission_denied" },
    ]);
  });

  it("answers a download of a missing file with file_not_found", async () => {
    const missing: BackendProtocolV2 = { ...recordingBackend().backend, readRaw: () => ({ error: "File '/x' not found" }) };
    expect(await mountSubtree(missing, "skills").downloadFiles(["/x"])).toEqual([
      { path: "/x", content: null, error: "file_not_found" },
    ]);
  });
});
