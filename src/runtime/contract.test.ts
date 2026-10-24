import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_CONTRACT,
  DEFAULT_RUNTIME_VERSION,
  DEFAULT_SANDBOX_VERSION,
  RUNTIME_ENGINE,
  SUPPORTED_RUNTIME_CONTRACTS,
  UnsupportedRuntimeContractError,
  isRuntimeContractSupported,
  resolveRuntimeContract,
  unsupportedRuntimeContractMessage,
} from "./contract.js";

describe("resolveRuntimeContract", () => {
  it("resolves declared engine and version", () => {
    const contract = resolveRuntimeContract({ engine: "archmax-harness", version: "3" });
    expect(contract).toEqual({
      engine: "archmax-harness",
      version: "3",
      source: "declared",
      sandbox: 3,
      testFormat: "1",
    });
  });

  it("coerces a numeric version to a string", () => {
    const contract = resolveRuntimeContract({ version: 3 });
    expect(contract.version).toBe("3");
    expect(contract.source).toBe("declared");
    expect(isRuntimeContractSupported(contract)).toBe(true);
  });

  it("defaults omitted metadata to contract 3", () => {
    expect(DEFAULT_RUNTIME_VERSION).toBe("3");
    expect(DEFAULT_RUNTIME_CONTRACT).toEqual({ engine: RUNTIME_ENGINE, version: "3" });
    for (const metadata of [undefined, null, {}]) {
      expect(resolveRuntimeContract(metadata)).toEqual({
        engine: RUNTIME_ENGINE,
        version: "3",
        source: "defaulted",
        sandbox: 3,
        testFormat: "1",
      });
    }
  });

  it("fills an omitted half from the default", () => {
    expect(resolveRuntimeContract({ engine: RUNTIME_ENGINE })).toMatchObject({
      version: "3",
      source: "declared",
    });
    expect(resolveRuntimeContract({ version: "3" })).toMatchObject({
      engine: RUNTIME_ENGINE,
      source: "declared",
    });
  });
});

describe("runtime contract support", () => {
  it("supports contract 3 and nothing else", () => {
    expect(SUPPORTED_RUNTIME_CONTRACTS).toEqual([{ engine: RUNTIME_ENGINE, version: "3" }]);
  });

  it("accepts a supported contract", () => {
    const contract = resolveRuntimeContract({ engine: RUNTIME_ENGINE, version: "3" });
    expect(isRuntimeContractSupported(contract)).toBe(true);
    expect(unsupportedRuntimeContractMessage(contract)).toBeNull();
  });

  // The hook contract is retired: a workspace declaring it is refused rather
  // than half-run, naming the one contract that is left.
  it.each(["1", "2"])("refuses the retired contract %s, naming the supported set", (version) => {
    const contract = resolveRuntimeContract({ engine: RUNTIME_ENGINE, version });
    expect(isRuntimeContractSupported(contract)).toBe(false);
    const message = unsupportedRuntimeContractMessage(contract);
    expect(message).toContain(`archmax-harness@${version}`);
    expect(message).toContain("Supported: archmax-harness@3.");
  });

  it("rejects an unsupported engine", () => {
    const contract = resolveRuntimeContract({ engine: "other-runtime", version: "3" });
    expect(isRuntimeContractSupported(contract)).toBe(false);
    const message = unsupportedRuntimeContractMessage(contract);
    expect(message).toContain("other-runtime@3");
    expect(message).toContain("archmax-harness@3");
  });

  it("rejects an unsupported version", () => {
    const contract = resolveRuntimeContract({ engine: RUNTIME_ENGINE, version: "99" });
    expect(isRuntimeContractSupported(contract)).toBe(false);
    expect(unsupportedRuntimeContractMessage(contract)).toContain("archmax-harness@99");
  });

  it("UnsupportedRuntimeContractError carries requested and supported contracts", () => {
    const requested = { engine: RUNTIME_ENGINE, version: "2" };
    const err = new UnsupportedRuntimeContractError(requested);
    expect(err.requested).toEqual(requested);
    expect(err.supported).toEqual(SUPPORTED_RUNTIME_CONTRACTS);
    expect(err.message).toContain("archmax-harness@2");
    expect(err.message).toContain("Supported: archmax-harness@3.");
  });
});

/**
 * One axis. The sandbox script contract and the offline test-case format used to
 * version themselves, in vocabularies that could contradict both each other and
 * the workflow they described. They are now derived from `runtime.version`.
 */
describe("derived surfaces", () => {
  it("derives the sandbox contract from the runtime version", () => {
    expect(resolveRuntimeContract({ version: "3" }).sandbox).toBe(3);
    expect(DEFAULT_SANDBOX_VERSION).toBe(3);
  });

  it("derives the test-case format from the runtime version", () => {
    expect(resolveRuntimeContract({ version: "3" }).testFormat).toBe("1");
  });

  // Resolution stays total so a diagnostic can name an unsupported contract;
  // refusing it is `isRuntimeContractSupported`'s job, not the resolver's.
  it("resolves an unsupported version rather than throwing, and reports it unsupported", () => {
    const contract = resolveRuntimeContract({ version: "42" });
    expect(contract.version).toBe("42");
    // The surfaces fall back to the default's, so a diagnostic path stays total.
    expect(contract.sandbox).toBe(DEFAULT_SANDBOX_VERSION);
    expect(isRuntimeContractSupported(contract)).toBe(false);
    expect(unsupportedRuntimeContractMessage(contract)).toContain("archmax-harness@42");
  });
});
