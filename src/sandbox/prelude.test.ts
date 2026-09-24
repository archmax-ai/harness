import { describe, expect, it } from "vitest";
import { readPrelude } from "./prelude.js";

describe("readPrelude", () => {
  it("gives the PTC context the contract marker and nothing else", () => {
    const prelude = readPrelude("ptc", 2);
    expect(prelude).toContain('globalThis.__SANDBOX_VERSION = 2;');
    expect(prelude).toContain('context: "ptc"');
    expect(prelude).not.toMatch(/\bveto\b|\bdefineHook\b|globalThis\.t\b/);
  });

  it("gives the hook context the verdict helpers, defineHook and the reducer", () => {
    const prelude = readPrelude("lifecycle-hook", 2);
    expect(prelude).toContain('context: "lifecycle-hook"');
    for (const name of ["ok", "veto", "correct", "defineHook", "__hookVerdict"]) {
      expect(prelude).toContain(`globalThis.${name} = `);
    }
    // The retired `t` vocabulary has no prelude at all.
    expect(prelude).not.toContain("globalThis.t = ");
  });

  it("installs no compatibility prelude for a superseded vocabulary", () => {
    // Two contexts, two preludes: a hook source using a retired vocabulary gets
    // no shim, so there is nothing for a deprecation to warn about.
    const hook = readPrelude("lifecycle-hook", 2);
    expect(hook).not.toContain("__legacyFailures");
    expect(hook).toContain("globalThis.veto");
  });
});
