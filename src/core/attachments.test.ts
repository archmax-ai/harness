import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attachmentName, baseName, createSessionFiles, isPlainFileName, placeAttachment } from "./attachments.js";
import { workspaceEntryKind } from "./file-operations.js";
import { createWorkspaceContext, type WorkspaceContext } from "./workspace-context.js";

/** Bytes that are not UTF-8, so only an exact-byte channel can carry them. */
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0xfe, 0x00, 0x80, 0x0a]);

function withSession<T>(fn: (root: string, ctx: WorkspaceContext) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "archmax-attachments-"));
  const ctx = createWorkspaceContext({ rootDir: root });
  return ctx.sessionZone.sessionScoped("s1", () => fn(root, ctx)).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe("attachmentName", () => {
  const taken = (...names: string[]) => new Set(names);

  it("keeps a free name", () => {
    expect(attachmentName(taken(), "report.pdf")).toBe("report.pdf");
  });

  it("counts up before the last extension, taking the lowest free number", () => {
    expect(attachmentName(taken("report.pdf", "report-1.pdf"), "report.pdf")).toBe("report-2.pdf");
    expect(attachmentName(taken("report.pdf", "report-2.pdf"), "report.pdf")).toBe("report-1.pdf");
    expect(attachmentName(taken("archive.tar.gz"), "archive.tar.gz")).toBe("archive.tar-1.gz");
  });

  it("puts the suffix at the end of a name with no extension or a leading dot only", () => {
    expect(attachmentName(taken("notes"), "notes")).toBe("notes-1");
    expect(attachmentName(taken(".env"), ".env")).toBe(".env-1");
  });
});

describe("isPlainFileName and baseName", () => {
  it("accepts one plain segment only", () => {
    expect(isPlainFileName("invoice.pdf")).toBe(true);
    expect(isPlainFileName(".env")).toBe(true);
    for (const bad of ["", ".", "..", "a/b.pdf", "../invoice.pdf", "a\\b.pdf", "in\0voice.pdf"]) {
      expect(isPlainFileName(bad), bad).toBe(false);
    }
  });

  it("takes the last segment of a path", () => {
    expect(baseName("scratchpad/inbox/invoice.pdf")).toBe("invoice.pdf");
    expect(baseName("/report")).toBe("report");
  });
});

describe("placeAttachment", () => {
  it("writes the exact bytes under the file's own name", () =>
    withSession(async (root, { backend }) => {
      expect(await placeAttachment(backend, "s1", "invoice.pdf", PDF)).toEqual({
        path: "scratchpad/attachments/invoice.pdf",
      });
      expect(readFileSync(join(root, "sessions", "s1", "scratchpad", "attachments", "invoice.pdf"))).toEqual(PDF);
      expect(await workspaceEntryKind(backend, "scratchpad/attachments/invoice.pdf")).toBe("file");
      expect(await workspaceEntryKind(backend, "scratchpad/attachments")).toBe("directory");
      expect(await workspaceEntryKind(backend, "scratchpad/attachments/missing.pdf")).toBe("missing");
    }));

  it("never overwrites: a second placement of one name takes the next suffix", () =>
    withSession(async (root, { backend }) => {
      await placeAttachment(backend, "s1", "report.pdf", Buffer.from("first"));
      const second = await placeAttachment(backend, "s1", "report.pdf", Buffer.from("second"));
      expect(second).toEqual({ path: "scratchpad/attachments/report-1.pdf" });
      const dir = join(root, "sessions", "s1", "scratchpad", "attachments");
      expect(readFileSync(join(dir, "report.pdf"), "utf8")).toBe("first");
      expect(readFileSync(join(dir, "report-1.pdf"), "utf8")).toBe("second");
    }));

  it("gives concurrent placements into one session distinct names", () =>
    withSession(async (root, { backend }) => {
      const placed = await Promise.all(
        ["a", "b", "c"].map((body) => placeAttachment(backend, "s1", "report.pdf", Buffer.from(body))),
      );
      const paths = placed.map((p) => ("path" in p ? p.path : p.error));
      expect(new Set(paths)).toEqual(
        new Set([
          "scratchpad/attachments/report.pdf",
          "scratchpad/attachments/report-1.pdf",
          "scratchpad/attachments/report-2.pdf",
        ]),
      );
      const dir = join(root, "sessions", "s1", "scratchpad");
      const bodies = paths.map((p) => readFileSync(join(dir, p.slice("scratchpad/".length)), "utf8"));
      expect(bodies).toEqual(["a", "b", "c"]);
    }));

  it("refuses a name that is not one plain file name, writing nothing", () =>
    withSession(async (_root, { backend }) => {
      expect(await placeAttachment(backend, "s1", "../x.pdf", PDF)).toEqual({
        error: "Cannot place '../x.pdf': it is not a plain file name.",
      });
      expect(await workspaceEntryKind(backend, "scratchpad/attachments")).toBe("missing");
    }));
});

describe("createSessionFiles", () => {
  it("places into and reads from another session while the caller's turn is bound", () =>
    withSession(async (root, { backend, sessionZone }) => {
      const files = createSessionFiles(backend, (id, fn) => sessionZone.sessionScoped(id, fn));
      const child = "s1~1";
      expect(await files.place(child, "invoice.pdf", PDF)).toEqual({ path: "scratchpad/attachments/invoice.pdf" });
      // Bound to the caller, yet the file landed in the child's folder, not the caller's.
      expect(readFileSync(join(root, "sessions", child, "scratchpad", "attachments", "invoice.pdf"))).toEqual(PDF);
      expect(await workspaceEntryKind(backend, "scratchpad/attachments/invoice.pdf")).toBe("missing");
      expect(await files.kind(child, "scratchpad/attachments/invoice.pdf")).toBe("file");
      const read = await files.read(child, "scratchpad/attachments/invoice.pdf");
      expect("bytes" in read && Buffer.from(read.bytes)).toEqual(PDF);
      expect(sessionZone.boundSessionId()).toBe("s1");
    }));
});
