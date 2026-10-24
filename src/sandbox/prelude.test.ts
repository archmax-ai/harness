import { describe, expect, it } from "vitest";
import { readPrelude } from "./prelude.js";

/** The verdict vocabulary the retired `lifecycle-hook` context carried. */
const RETIRED_GLOBALS = ["ok", "veto", "correct", "defineHook", "__hookVerdict", "t"];

describe("readPrelude", () => {
  it("gives the PTC context the contract marker and the scoped tools view, nothing else", () => {
    const prelude = readPrelude("ptc", 3);
    expect(prelude).toContain("globalThis.__SANDBOX_VERSION = 3;");
    expect(prelude).toContain('context: "ptc"');
    expect(prelude).toContain('Object.defineProperty(globalThis, "__archmaxScope"');
    expect(prelude).not.toMatch(/\bdefineCodeState\b|__stateDef|\bveto\b|\bdefineHook\b|globalThis\.t\b/);
  });

  it("gives the code context its own marker, defineCodeState and the same scoped tools view", () => {
    const prelude = readPrelude("code", 3);
    expect(prelude).toContain("globalThis.__SANDBOX_VERSION = 3;");
    expect(prelude).toContain('context: "code"');
    expect(prelude).not.toContain('context: "ptc"');
    expect(prelude).toContain("globalThis.defineCodeState = ");
    expect(prelude).toContain('Object.defineProperty(globalThis, "__archmaxScope"');
  });

  it("gives the code context no verdict vocabulary: nothing a script returns is read", () => {
    const prelude = readPrelude("code", 3);
    for (const name of RETIRED_GLOBALS) {
      expect(prelude, name).not.toContain(`globalThis.${name} = `);
    }
  });

  it("installs no compatibility prelude for a superseded vocabulary", () => {
    // Two contexts, two preludes: a source using a retired vocabulary gets no
    // shim, so it throws in the sandbox and fails closed.
    for (const context of ["ptc", "code"] as const) {
      const prelude = readPrelude(context, 3);
      expect(prelude, context).not.toContain("__legacyFailures");
      expect(prelude, context).not.toContain("lifecycle-hook");
    }
  });

  it("defaults to the PTC context at the current sandbox contract", () => {
    expect(readPrelude()).toBe(readPrelude("ptc", 3));
  });
});
