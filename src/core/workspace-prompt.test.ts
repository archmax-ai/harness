import { describe, it, expect } from "vitest";
import { renderWorkspaceZones } from "./workspace-prompt.js";
import { MOUNTS_SECTION_HEADING, renderMountsSection } from "./mount-prompt.js";
import { resolveMounts } from "./mounts.js";
import { defaultMounts } from "./mounts.js";
import { NO_MOUNTS } from "./zones.js";

/** The prefixes a conventional filesystem workspace resolves to. */
function conventionalPrefixes() {
  return resolveMounts(defaultMounts("/ws")).prefixes;
}

describe("renderWorkspaceZones", () => {
  it("names exactly the mounts the resolved table serves", () => {
    const section = renderWorkspaceZones(conventionalPrefixes());

    expect(section).toContain("`skills/`");
    expect(section).toContain("`AGENTS.md`");
    // Each mount carries its own posture: the name is what the agent addresses.
    expect(line(section, "`skills/`")).toContain("read-only");
    expect(line(section, "`AGENTS.md`")).toContain("read-only");
    // Neither authoring-plane prefix is a mount, so the prompt cannot advertise
    // one — not the spec that governs the run, not the judge that grades it.
    expect(section).not.toContain("`workflows/`");
    expect(section).not.toContain("`subagents/`");
  });

  it("cannot advertise a directory the table does not declare", () => {
    // The `hitl/` bug: prose that outlived the mount. Rendering from the table
    // makes it unrepresentable rather than fixed once.
    const section = renderWorkspaceZones(conventionalPrefixes());

    for (const retired of ["hitl/", "scripts/", "data/", "output/"]) {
      expect(section).not.toContain(retired);
    }
  });

  it("describes the working area and the offload areas", () => {
    const section = renderWorkspaceZones(NO_MOUNTS);

    expect(section).toContain("`scratchpad/`");
    expect(section).toContain("`large_tool_results/`");
    expect(section).toContain("`conversation_history/`");
    expect(section).toContain("cannot write there");
  });

  it("omits dot-prefixed mounts, which carry harness inputs rather than authored content", () => {
    const section = renderWorkspaceZones(conventionalPrefixes());

    expect(section).not.toContain(".platform");
  });

  it("marks each mount read-only or read/write", () => {
    const { prefixes } = resolveMounts({
      "/skills/": fakeBackend(),
      "/shared/": { backend: fakeBackend(), readOnly: false },
    });

    const section = renderWorkspaceZones(prefixes);

    expect(line(section, "`skills/`")).toBe("  - **`skills/`** — read-only");
    expect(line(section, "`shared/`")).toBe("  - **`shared/`** — read/write");
    // Permission, not a caution: a writable mount the host wired is a place to
    // write, and the wording must not push the agent back into `scratchpad/`.
    expect(section).toContain("write there when the work belongs outside this run");
    expect(section).toContain("checked against the active state's tool rules");
    expect(section).toContain("A `read-only` mount refuses writes");
  });

  it("says nothing about writing to a mount when every mount is read-only", () => {
    const section = renderWorkspaceZones(resolveMounts({ "/skills/": fakeBackend() }).prefixes);

    expect(section).toContain("A `read-only` mount refuses writes");
    expect(section).not.toContain("read/write");
  });

  it("renders no mount bullets for a workspace with no mounts", () => {
    const section = renderWorkspaceZones(NO_MOUNTS);

    expect(section).not.toContain("**Mounts**");
    // The run's own areas and per-state governance are still described.
    expect(section).toContain("`scratchpad/`");
    expect(section).toContain("Any other path in the root");
  });

  /**
   * A governed mount is reachable only from the states a `mounts` list enables,
   * so naming it here — in the cacheable prefix — would advertise in every state
   * a directory most states cannot read.
   */
  it("names no governed mount, and points at the volatile block instead", () => {
    const { prefixes } = resolveMounts({
      "/skills/": fakeBackend(),
      "/reference/": { backend: fakeBackend(), governed: true },
      "/catalogs/eu/": { backend: fakeBackend(), governed: true },
    });

    const section = renderWorkspaceZones(prefixes);

    expect(section).not.toContain("`reference/`");
    expect(section).not.toContain("`catalogs/eu/`");
    expect(line(section, "`skills/`")).toContain("read-only");
    expect(section).toContain("Some mounts are given per state");
    expect(section).toContain("Mounts available in this state");
  });

  it("says nothing about per-state mounts when the table governs none", () => {
    expect(renderWorkspaceZones(conventionalPrefixes())).not.toContain(
      "Some mounts are given per state",
    );
    expect(renderWorkspaceZones(NO_MOUNTS)).not.toContain("Some mounts are given per state");
  });

  it("renders no mount bullets when every mount of the table is governed", () => {
    const { prefixes } = resolveMounts({
      "/reference/": { backend: fakeBackend(), governed: true },
      "/shared/": { backend: fakeBackend(), readOnly: false, governed: true },
    });

    const section = renderWorkspaceZones(prefixes);

    expect(section).not.toContain("**Mounts**");
    expect(section).toContain("Some mounts are given per state");
  });

  it("marks an unsearchable mount browse-only and explains the posture once", () => {
    const prefixes = resolveMounts({
      "/skills/": fakeBackend(),
      "/contracts/": { backend: fakeBackend(), searchable: false },
      "/shared/": { backend: fakeBackend(), readOnly: false, searchable: false },
    }).prefixes;
    const section = renderWorkspaceZones(prefixes);

    expect(line(section, "`contracts/`")).toBe("  - **`contracts/`** — read-only, browse only");
    expect(line(section, "`shared/`")).toBe("  - **`shared/`** — read/write, browse only");
    expect(line(section, "`skills/`")).toBe("  - **`skills/`** — read-only");
    expect(section).toContain("A `browse only` mount is listed and read, never searched");
  });

  it("renders a table without the flag exactly as before", () => {
    const prefixes = resolveMounts({ "/skills/": fakeBackend(), "/AGENTS.md": fakeBackend() }).prefixes;
    const section = renderWorkspaceZones(prefixes);

    expect(section).not.toContain("browse only");
    // The same table, spelled with the flag at its default, is the same text.
    const explicit = resolveMounts({
      "/skills/": { backend: fakeBackend(), searchable: true },
      "/AGENTS.md": fakeBackend(),
    }).prefixes;
    expect(renderWorkspaceZones(explicit)).toBe(section);
  });

  it("is byte-stable for a given table, so it stays in the cacheable static block", () => {
    const a = renderWorkspaceZones(conventionalPrefixes());
    const b = renderWorkspaceZones(conventionalPrefixes());

    expect(a).toBe(b);
  });

  it("orders mount names deterministically regardless of table order", () => {
    const one = resolveMounts({
      "/skills/": fakeBackend(),
      "/templates/": fakeBackend(),
    }).prefixes;
    const other = resolveMounts({
      "/templates/": fakeBackend(),
      "/skills/": fakeBackend(),
    }).prefixes;

    expect(renderWorkspaceZones(one)).toBe(renderWorkspaceZones(other));
  });
});

/** Whichever line of the section contains `needle`. */
function line(section: string, needle: string): string {
  const found = section.split("\n").find((l) => l.includes(needle));
  expect(found, `no line containing ${needle}`).toBeDefined();
  return found as string;
}

/**
 * A backend stand-in: `renderWorkspaceZones` reads only the resolved mount
 * *keys*, so nothing here is ever called.
 */
function fakeBackend() {
  return {} as never;
}

describe("renderMountsSection search posture", () => {
  const prefixes = () =>
    resolveMounts({
      "/reference/": { backend: fakeBackend(), governed: true },
      "/contracts/": { backend: fakeBackend(), governed: true, searchable: false },
    }).prefixes;

  it("marks an unsearchable mount browse-only on its own line only", () => {
    const section = renderMountsSection(["contracts", "reference"], prefixes(), () => false)!;

    expect(section).toContain(`## ${MOUNTS_SECTION_HEADING}`);
    expect(line(section, "`contracts/`")).toContain("Browse only: list and read it directly.");
    expect(line(section, "`reference/`")).not.toContain("Browse only");
  });

  it("renders a table without the flag exactly as before", () => {
    const plain = resolveMounts({ "/reference/": { backend: fakeBackend(), governed: true } }).prefixes;
    const section = renderMountsSection(["reference"], plain, () => false)!;

    expect(section).not.toContain("Browse only");
    expect(line(section, "`reference/`")).toBe(
      "- **`reference/`** — read-only — read it freely, writes there are blocked.",
    );
  });
});
