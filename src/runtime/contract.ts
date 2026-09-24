import type { RuntimeMetadata } from "../machine/types.js";

/**
 * A workflow runtime contract: the authoring/runtime semantics a workspace
 * expects. This is a coarse, stable axis (`"1"`, `"2"`, …) and is intentionally
 * **not** the npm package version — patch/minor implementation releases must not
 * force workflow authors to bump their `WORKFLOW.md`.
 */
export interface RuntimeContract {
  engine: string;
  version: string;
}

/**
 * A {@link RuntimeContract} plus whether it was declared or defaulted, and the
 * two surfaces the version implies.
 *
 * `sandbox` and `testFormat` are **derived, never declared**. They used to be
 * three independent vocabularies — a `runtime.version` in the spec, a sandbox
 * contract version, and a per-file `version` in `*.test.yaml` — describing one
 * fact: which release of the authoring surface a workspace targets. Three
 * vocabularies could disagree; one cannot.
 */
export interface ResolvedRuntimeContract extends RuntimeContract {
  source: "declared" | "defaulted";
  /** Sandbox script contract implied by this runtime version. */
  sandbox: number;
  /** Offline test-case format implied by this runtime version. */
  testFormat: string;
}

/**
 * What each supported runtime version implies for the surfaces that used to
 * version themselves.
 *
 * Sandbox 2 = hooks are default-export functions returning `ok()` / `veto()` /
 * `correct()`,
 * plus typed `@archmax-ai/harness/*` import stripping. The test-case format has not
 * changed across runtime versions, which is exactly why it did not need an axis
 * of its own.
 *
 * This table is the single source of the supported set — adding a runtime
 * version is one entry here.
 */
const CONTRACT_SURFACES: Readonly<Record<string, { sandbox: number; testFormat: string }>> = {
  "1": { sandbox: 1, testFormat: "1" },
  "2": { sandbox: 2, testFormat: "1" },
};

/** The sandbox script contract applied when nothing resolves a runtime version. */
export const DEFAULT_SANDBOX_VERSION = CONTRACT_SURFACES["2"]!.sandbox;

/**
 * The execution contexts the runtime assembles a prelude for. The vocabulary
 * survived the contract merge; the list of them did not, because nothing
 * enumerated it — a context is always named, never iterated.
 */
export type SandboxContext = "lifecycle-hook" | "ptc";

/** The runtime engine this package implements. */
export const RUNTIME_ENGINE = "archmax-harness";

/** Default contract version applied when metadata is omitted. */
export const DEFAULT_RUNTIME_VERSION = "1";

/** The contract resolved for workspaces that omit `runtime` metadata. */
export const DEFAULT_RUNTIME_CONTRACT: RuntimeContract = {
  engine: RUNTIME_ENGINE,
  version: DEFAULT_RUNTIME_VERSION,
};

/**
 * The explicit set of runtime contracts the installed runtime supports.
 * Version 2 identifies the v2 authoring contract (two-file `workflow.yaml` /
 * `WORKFLOW.md` layout, declarative `tests:` block, typed sandbox imports,
 * verdict-returning hook functions). Load behavior is
 * layout-driven, not version-driven — the version is declarative metadata for
 * support checking, validation, and docs. Version 1 remains supported.
 */
export const SUPPORTED_RUNTIME_CONTRACTS: readonly RuntimeContract[] = Object.keys(
  CONTRACT_SURFACES,
).map((version) => ({ engine: RUNTIME_ENGINE, version }));

/** Render a contract as `engine@version` for messages and artifacts. */
export function formatRuntimeContract(contract: RuntimeContract): string {
  return `${contract.engine}@${contract.version}`;
}

/**
 * Resolve a workflow's runtime contract from optional declared metadata. Omitted
 * metadata (or metadata with neither `engine` nor `version`) resolves to the
 * default contract with `source: "defaulted"`.
 */
export function resolveRuntimeContract(metadata?: RuntimeMetadata | null): ResolvedRuntimeContract {
  if (!metadata || (metadata.engine === undefined && metadata.version === undefined)) {
    return {
      ...DEFAULT_RUNTIME_CONTRACT,
      source: "defaulted",
      ...surfacesFor(DEFAULT_RUNTIME_VERSION),
    };
  }
  const declaredEngine = metadata.engine !== undefined ? String(metadata.engine) : RUNTIME_ENGINE;
  const version =
    metadata.version !== undefined ? String(metadata.version) : DEFAULT_RUNTIME_VERSION;
  return { engine: declaredEngine, version, source: "declared", ...surfacesFor(version) };
}

/**
 * The surfaces a version implies, falling back to the default's for a version
 * outside the table. Resolution stays total on purpose: an unsupported version
 * is reported by {@link isRuntimeContractSupported} and thrown by assembly, so
 * this function must not also throw — a diagnostic path that needs to *name* an
 * unsupported contract has to be able to resolve it first.
 */
function surfacesFor(version: string): { sandbox: number; testFormat: string } {
  return CONTRACT_SURFACES[version] ?? CONTRACT_SURFACES[DEFAULT_RUNTIME_VERSION]!;
}

/** Whether a contract is in the installed runtime's supported set. */
export function isRuntimeContractSupported(contract: RuntimeContract): boolean {
  return SUPPORTED_RUNTIME_CONTRACTS.some(
    (supported) => supported.engine === contract.engine && supported.version === contract.version,
  );
}

/**
 * Diagnostic-friendly support check. Returns `null` when the contract is
 * supported, otherwise an actionable message naming the requested contract and
 * the supported set.
 */
export function unsupportedRuntimeContractMessage(contract: RuntimeContract): string | null {
  if (isRuntimeContractSupported(contract)) return null;
  const supported = SUPPORTED_RUNTIME_CONTRACTS.map(formatRuntimeContract).join(", ");
  return `Unsupported runtime contract '${formatRuntimeContract(contract)}'. Supported: ${supported}.`;
}

/** Thrown by assembly when a workflow declares an unsupported contract. */
export class UnsupportedRuntimeContractError extends Error {
  readonly requested: RuntimeContract;
  readonly supported: readonly RuntimeContract[];

  constructor(
    requested: RuntimeContract,
    supported: readonly RuntimeContract[] = SUPPORTED_RUNTIME_CONTRACTS,
  ) {
    super(
      `Unsupported runtime contract '${formatRuntimeContract(requested)}'. ` +
        `Supported: ${supported.map(formatRuntimeContract).join(", ")}.`,
    );
    this.name = "UnsupportedRuntimeContractError";
    this.requested = requested;
    this.supported = supported;
  }
}
