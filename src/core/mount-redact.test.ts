import { describe, expect, it } from "vitest";
import { redactHiddenMounts } from "./mount-redact.js";
import type { MountPrefixes } from "./zones.js";

/** Two governed mounts (one nested), one ungoverned, plus a file mount. */
const MOUNTS: MountPrefixes = {
  dirs: ["skills", "reference", "catalogs/eu"],
  files: ["AGENTS.md"],
  writable: [],
  governed: ["reference", "catalogs/eu"],
  unsearchable: [],
};

const redact = (text: string, enabled: string[], forbidden: string[] = []) =>
  redactHiddenMounts(text, { enabled, forbidden }, MOUNTS);

describe("redactHiddenMounts", () => {
  it("drops a hidden governed mount from the workspace root listing", () => {
    const listing = [
      "/skills (directory)",
      "/reference (directory)",
      "/catalogs (directory)",
      "/scratchpad (directory)",
      "/AGENTS.md (120 bytes)",
    ].join("\n");
    // `catalogs` itself is no mount — the mount is `catalogs/eu` — so the
    // parent directory entry stays and only the mount's own paths are filtered.
    expect(redact(listing, ["reference"])).toBe(
      [
        "/skills (directory)",
        "/reference (directory)",
        "/catalogs (directory)",
        "/scratchpad (directory)",
        "/AGENTS.md (120 bytes)",
      ].join("\n"),
    );
    expect(redact(listing, [])).toBe(
      [
        "/skills (directory)",
        "/catalogs (directory)",
        "/scratchpad (directory)",
        "/AGENTS.md (120 bytes)",
      ].join("\n"),
    );
  });

  it("drops a nested mount's own entry where the state does not have it", () => {
    const listing = ["/catalogs/eu (directory)", "/catalogs/uk (directory)"].join("\n");
    expect(redact(listing, [])).toBe("/catalogs/uk (directory)");
    expect(redact(listing, ["catalogs/eu"])).toBe(listing);
  });

  it("keeps only reachable mounts in a glob result", () => {
    const globbed = [
      "/reference/rates.csv",
      "/catalogs/eu/skus.csv",
      "/catalogs/uk/skus.csv",
      "/scratchpad/draft.csv",
    ].join("\n");
    expect(redact(globbed, ["catalogs/eu"])).toBe(
      ["/catalogs/eu/skus.csv", "/catalogs/uk/skus.csv", "/scratchpad/draft.csv"].join("\n"),
    );
  });

  it("drops a hidden mount's grep matches with their header", () => {
    const grepped = [
      "/reference/rates.csv:",
      "  3: EUR,1.08",
      "",
      "/catalogs/eu/skus.csv:",
      "  7: SKU-1,eu",
      "",
      "/scratchpad/notes.md:",
      "  1: draft",
    ].join("\n");
    // The matched *content* must not survive its filename.
    expect(redact(grepped, ["catalogs/eu"])).toBe(
      ["/catalogs/eu/skus.csv:", "  7: SKU-1,eu", "", "/scratchpad/notes.md:", "  1: draft"].join(
        "\n",
      ),
    );
  });

  it("leaves an ungoverned mount alone, whatever the enabled set says", () => {
    const listing = ["/skills/order-data (directory)", "/skills/README.md (12 bytes)"].join("\n");
    expect(redact(listing, [])).toBe(listing);
  });

  it("drops an ungoverned mount a state forbids", () => {
    const listing = ["/skills/order-data (directory)", "/scratchpad/x.md (1 bytes)"].join("\n");
    expect(redact(listing, [], ["skills"])).toBe("/scratchpad/x.md (1 bytes)");
  });

  it("drops a governed mount a forbid names even where a grant enabled it", () => {
    const listing = ["/reference/rates.csv", "/scratchpad/x.md"].join("\n");
    expect(redact(listing, ["reference"], ["reference"])).toBe("/scratchpad/x.md");
  });

  it("returns the text unchanged when nothing is hidden", () => {
    const listing = "/scratchpad/x.md (1 bytes)";
    const open: MountPrefixes = { ...MOUNTS, governed: [] };
    expect(redactHiddenMounts(listing, { enabled: [], forbidden: [] }, open)).toBe(listing);
    // Identity, not a rebuilt copy: every governed mount is reachable here.
    expect(redact(listing, ["reference", "catalogs/eu"])).toBe(listing);
  });

  it("handles an empty result and a table with no mounts", () => {
    expect(redact("", [])).toBe("");
    const none: MountPrefixes = { dirs: [], files: [], writable: [], governed: [], unsearchable: [] };
    expect(redactHiddenMounts("/x (1 bytes)", { enabled: [], forbidden: [] }, none)).toBe(
      "/x (1 bytes)",
    );
  });

  it("drops a hidden file mount by exact path, not by prefix", () => {
    const governedFile: MountPrefixes = { ...MOUNTS, governed: ["AGENTS.md"] };
    const listing = ["/AGENTS.md (120 bytes)", "/AGENTS.md.bak (118 bytes)"].join("\n");
    expect(redactHiddenMounts(listing, { enabled: [], forbidden: [] }, governedFile)).toBe(
      "/AGENTS.md.bak (118 bytes)",
    );
  });
});
