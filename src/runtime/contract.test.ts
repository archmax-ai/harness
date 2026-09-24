import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_VERSION,
  RUNTIME_ENGINE,
  UnsupportedRuntimeContractError,
  isRuntimeContractSupported,
  resolveRuntimeContract,
  unsupportedRuntimeContractMessage,
} from "./contract.js";

describe("resolveRuntimeContract", () => {
  it("resolves declared engine and version", () => {
    const contract = resolveRuntimeContract({ engine: "archmax-harness", version: "1" });
    expect(contract).toEqual({
      engine: "archmax-harness",
      version: "1",
      source: "declared",
      sandbox: 1,
      testFormat: "1",
    });
  });

  it("supports the v2 authoring contract alongside v1", () => {
    const v2 = resolveRuntimeContract({ engine: "archmax-harness", version: "2" });
    expect(isRuntimeContractSupported(v2)).toBe(true);
    expect(isRuntimeContractSupported(resolveRuntimeContract({ version: "1" }))).toBe(true);
    expect(isRuntimeContractSupported(resolveRuntimeContract({ version: "3" }))).toBe(false);
  });

  it("coerces a numeric version to a string", () => {
    const contract = resolveRuntimeContract({ version: 1 });
    expect(contract.version).toBe("1");
    expect(contract.source).toBe("declared");
  });

  it("defaults omitted metadata to the legacy-compatible contract", () => {
    expect(resolveRuntimeContract(undefined)).toEqual({
      engine: RUNTIME_ENGINE,
      version: DEFAULT_RUNTIME_VERSION,
      source: "defaulted",
      sandbox: 1,
      testFormat: "1",
    });
    expect(resolveRuntimeContract({})).toEqual({
      engine: RUNTIME_ENGINE,
      version: DEFAULT_RUNTIME_VERSION,
      source: "defaulted",
      sandbox: 1,
      testFormat: "1",
    });
  });
});

describe("runtime contract support", () => {
  it("accepts a supported contract", () => {
    const contract = resolveRuntimeContract({ engine: RUNTIME_ENGINE, version: "1" });
    expect(isRuntimeContractSupported(contract)).toBe(true);
    expect(unsupportedRuntimeContractMessage(contract)).toBeNull();
  });

  it("rejects an unsupported engine", () => {
    const contract = resolveRuntimeContract({ engine: "other-runtime", version: "1" });
    expect(isRuntimeContractSupported(contract)).toBe(false);
    const message = unsupportedRuntimeContractMessage(contract);
    expect(message).toContain("other-runtime@1");
    expect(message).toContain("archmax-harness@1");
  });

  it("rejects an unsupported version", () => {
    const contract = resolveRuntimeContract({ engine: RUNTIME_ENGINE, version: "99" });
    expect(isRuntimeContractSupported(contract)).toBe(false);
    expect(unsupportedRuntimeContractMessage(contract)).toContain("archmax-harness@99");
  });

  it("UnsupportedRuntimeContractError carries requested and supported contracts", () => {
    const requested = { engine: RUNTIME_ENGINE, version: "99" };
    const err = new UnsupportedRuntimeContractError(requested);
    expect(err.requested).toEqual(requested);
    expect(err.supported.length).toBeGreaterThan(0);
    expect(err.message).toContain("archmax-harness@99");
  });
});

/**
 * One axis. The sandbox script contract and the offline test-case format used to
 * version themselves, in vocabularies that could contradict both each other and
 * the workflow they described. They are now derived from `runtime.version`.
 */
describe("derived surfaces", () => {
  it("derives the sandbox contract from the runtime version", () => {
    expect(resolveRuntimeContract({ version: "1" }).sandbox).toBe(1);
    expect(resolveRuntimeContract({ version: "2" }).sandbox).toBe(2);
  });

  it("derives the test-case format from the runtime version", () => {
    expect(resolveRuntimeContract({ version: "1" }).testFormat).toBe("1");
    expect(resolveRuntimeContract({ version: "2" }).testFormat).toBe("1");
  });

  // Resolution stays total so a diagnostic can name an unsupported contract;
  // refusing it is `isRuntimeContractSupported`'s job, not the resolver's.
  it("resolves an unsupported version rather than throwing, and reports it unsupported", () => {
    const contract = resolveRuntimeContract({ version: "42" });
    expect(contract.version).toBe("42");
    expect(isRuntimeContractSupported(contract)).toBe(false);
    expect(unsupportedRuntimeContractMessage(contract)).toContain("archmax-harness@42");
  });
});
