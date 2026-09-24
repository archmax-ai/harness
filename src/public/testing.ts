/**
 * `@archmax-ai/harness/testing` — the case engine behind `archmax test`.
 *
 * A subpath of its own so a production import never pulls in test machinery: a
 * host that builds cases programmatically, drives a suite in CI, or mocks tools
 * imports here, and everything else imports the root.
 *
 * Cases are declarative YAML documents interpreted **host-side** — no sandbox
 * is involved. See the testing guide.
 */

export {
  /** Discover and run a workflow's cases. */
  runTests,
  /** Find and parse a suite's case files. */
  discoverCases,
  /** Drive one discovered case against an agent under test. */
  runCase,
  /** Reduce a case's assertion records to a verdict. */
  reduceVerdict,
  /** The process exit code a verdict implies. */
  exitCodeForVerdict,
  /** Refuse a target that is not workflow-governed, on the runner's own terms. */
  assertWorkflowGovernedTarget,
} from "../testing/runner.js";

export type {
  /** One case's outcome. */
  CaseResult,
  /** A single assertion's record. */
  AssertionRecord,
  /** Whether an assertion passed, failed, or never ran. */
  AssertionStatus,
  /** A case's settled verdict. */
  CaseVerdict,
  /** A verdict's status: passed, failed, or skipped. */
  CaseStatus,
  /** Options for {@link runTests}. */
  RunTestsOptions,
  /** What {@link runTests} returns. */
  RunTestsResult,
  /** Why a whole suite ran no cases. */
  SuiteSkip,
  /** A parsed (or unparseable) case file, as {@link discoverCases} reports it. */
  DiscoveredCase,
  /** Options for {@link runCase}. */
  RunCaseOptions,
} from "../testing/runner.js";

/** Build the agent under test. Replaceable via `runTests({ createTarget })`. */
export { createCaseTarget } from "../testing/target.js";
export type { CaseTargetOptions } from "../testing/target.js";

export {
  /** Parse one case document, for a host that builds or validates cases itself. */
  parseCaseDocument,
  /** The inverse: a case document back to YAML, in the grammar's key order. */
  serializeCaseDocument,
  /** The prose-length bounds a case's `title` and `description` are held to. */
  CASE_TITLE_MAX_LENGTH,
  CASE_DESCRIPTION_MAX_LENGTH,
  /** A structural problem in a case document. */
  CaseSchemaError,
} from "../testing/case-schema.js";

export type {
  /** A parsed case. */
  CaseDocument,
  /** One entry of a case's flat `steps` list. */
  CaseStep,
  /** A declarative assertion. */
  CaseExpectation,
  /** A declared trigger start condition. */
  CaseTriggerDecl,
  /** One seeded workspace file. */
  CaseWorkspaceEntry,
} from "../testing/case-schema.js";

/** Middleware that intercepts declared tool mocks, for a caller-built target. */
export { createToolMockMiddleware } from "../testing/mock-middleware.js";

/** The partial-match vocabulary shared by `calledTool.input` assertions and `whenInput` mocks. */
export { partialMatch } from "../core/match.js";
