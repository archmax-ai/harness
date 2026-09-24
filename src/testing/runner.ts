/**
 * Running a suite of cases.
 *
 * Three steps, each its own exported function: {@link discoverCases} finds and
 * parses the case files, {@link runCase} drives one against the agent under
 * test, and {@link runTests} wires the two together with suite configuration.
 * The **verdict** a case settles to and the **contract** a target must satisfy
 * live here too, because nothing else reads them.
 *
 * The runner returns data and prints nothing: the CLI's test view is the
 * renderer, and a host reporter reads the same `CaseResult`s.
 *
 * What is deliberately *not* here is `createCaseTarget` — see `target.ts`. The
 * runner reaches its target through that builder and a host replaces it, so
 * folding it in would make the seam unreplaceable in fact rather than in type.
 */
import type { BackendProtocolV2 } from "deepagents";
import type { Agent, WorkflowSurface } from "../agent.js";
import { createCaseTarget } from "./target.js";
import type { WorkflowEventHandler } from "../core/events.js";
import type { SandboxRuntime } from "../sandbox/runtime.js";
import { resolveWorkspaceRoot, type ModelFactory } from "../env.js";
import { createWorkspaceContext } from "../core/workspace-context.js";
import { Workspace } from "../core/workspace.js";
import { workflowPaths } from "../workflow/paths.js";
import { loadMachineSpec } from "../machine/load-spec.js";
import { specDisabled, type WorkflowTestsConfig } from "../machine/types.js";
import { createJudgeModel, gradeClosedQA } from "./grade.js";
import {
  CaseSchemaError,
  normalizeFixturePath,
  parseCaseDocument,
  type CaseDocument,
  type CaseWorkspaceEntry,
} from "./case-schema.js";
import { listCaseFiles } from "./discovery.js";
import type { GradeFn } from "./assertions.js";
import { executeCase, notExecutedRecords } from "./interpreter.js";

/**
 * The outcome of one assertion. `not-executed` is a first-class case, not an
 * absence: a case that stopped early still accounts for the assertion steps it
 * never reached.
 */
export type AssertionStatus = "passed" | "failed" | "not-executed";

export interface AssertionRecord {
  kind: string;
  /**
   * The `atLeast` bar a `grade` assertion had to clear, `null` for every other
   * kind. Descriptive only — it is rendered beside the score; whether the
   * record failed is already decided in `status`.
   */
  threshold: number | null;
  /**
   * The assertion's outcome — the single authoritative one, computed by the
   * engine and the field verdict reduction keys off. A `grade` record takes its
   * status from the case's declared `atLeast` threshold, so it can never
   * contradict the verdict computed from the same score.
   */
  status: AssertionStatus;
  /** A `grade` record's score; absent for deterministic assertions. */
  score?: number;
  detail?: string;
  /**
   * Zero-based index, in the case document's flat `steps` list, of the
   * assertion step that produced this record — the same index the case schema
   * uses in its `steps[i]` error locations. Values are sparse with respect to
   * `steps`: action steps produce no records.
   */
  step: number;
}

export type CaseStatus = "passed" | "failed" | "skipped";

export interface CaseVerdict {
  status: CaseStatus;
  failures: string[];
}

/**
 * Reduce recorded assertions to a verdict. Every failed record fails its case —
 * there is no severity tier that records a failure without failing. A `grade`
 * miss reads as a failure like any other, with its score beside the bar it
 * missed. Every branch keys off `status`: with `not-executed` records present,
 * "did not pass" and "failed" are different things.
 */
export function reduceVerdict(records: AssertionRecord[]): CaseVerdict {
  const failures: string[] = [];
  for (const r of records) {
    if (r.status !== "failed") continue;
    const label = r.detail ? `${r.kind}: ${r.detail}` : r.kind;
    failures.push(
      r.threshold != null ? `${label} (score ${r.score ?? 0} < ${r.threshold})` : label,
    );
  }
  return failures.length > 0 ? { status: "failed", failures } : { status: "passed", failures: [] };
}

/** Map a verdict to a process exit code. */
export function exitCodeForVerdict(verdict: CaseVerdict): number {
  return verdict.status === "failed" ? 1 : 0;
}

/**
 * The one contract a case target must satisfy, wherever it came from. Cases
 * drive the agent through the workflow graph (and may resume human states), so
 * the target must be workflow-governed. Both the default target builder and
 * `runTests` enforce this, so a caller-supplied target is refused on the same
 * terms as one the SDK built.
 */
export function assertWorkflowGovernedTarget(
  agent: Agent,
  workflow: string,
): asserts agent is Agent & { workflow: WorkflowSurface } {
  if (!agent.workflow) {
    throw new Error(
      `Case target '${workflow}' has no workflow machine; cases require a workflow-governed agent.`,
    );
  }
}

export interface RunTestsOptions {
  workflow: string;
  rootDir?: string;
  /**
   * Backend serving the **authored governance plane** this suite reads — the
   * machine spec, the case documents under `workflows/<slug>/tests/`, and the
   * fixtures their `from:` entries name. The same option `createAgent` takes,
   * and for the same reason: a host whose authored tree lives in a store rather
   * than on local disk has nothing under `<rootDir>/workflows/`, so discovery
   * over a filesystem root would find no cases at all and report an empty suite
   * rather than a missing one.
   *
   * Defaults to a filesystem backend over the resolved root — what `archmax test`
   * uses, and what a host keeps when its cases really are files on disk. A host
   * that supplies this also supplies its own `createTarget`: the two describe
   * the same authored content, one to read the suite from and one to run it.
   */
  authoring?: BackendProtocolV2;
  /** Only run case files whose workspace-relative path contains this substring. */
  filter?: string;
  /** Forwarded to the workflow agent under test for lifecycle diagnostics. */
  onEvent?: WorkflowEventHandler;
  /**
   * Reporter callback invoked before each case file runs, with the session id
   * the case will drive — so a live renderer can show only that session's events.
   */
  onCaseStart?: (file: string, sessionId: string) => void;
  /** Reporter callback invoked with each case result as it completes. */
  onCaseResult?: (result: CaseResult) => void;
  /**
   * Script-execution backend forwarded to the agent under test (its lifecycle
   * hooks and `archmax_run` sources). Case documents themselves are YAML
   * interpreted on the host — no sandbox is involved in running them.
   */
  sandboxRuntime?: SandboxRuntime;
  /** Model factory forwarded to the agent under test and the grading model. */
  modelFactory?: ModelFactory;
  /**
   * The agent under test — an already-built workflow-governed runtime, or a
   * factory that builds one. Defaults to `createCaseTarget({ workflow,
   * rootDir, onEvent, sandboxRuntime, modelFactory })`.
   *
   * A host that assembles its own workflow agent supplies it here rather than
   * describing it through options; the case protocol stays the runtime's, the
   * agent stays the caller's. A supplied target owns its whole assembly, which
   * includes the mocks: a case that declares `mocks:` against a target without
   * the tool-mock middleware is refused before the agent runs (see
   * `toolMocks`). In the factory form, `rootDir` is the
   * *resolved* workspace root.
   */
  createTarget?:
    | Agent & { workflow: WorkflowSurface }
    | ((ctx: {
        workflow: string;
        rootDir: string;
        onEvent?: WorkflowEventHandler;
      }) => Promise<Agent & { workflow: WorkflowSurface }>);
  /**
   * Names the agent session a case runs on, given the case file's
   * workspace-relative path. Defaults to `test-default-<runId>-<file>`. A case
   * is one conversation on one session, which is what lets a host correlate a
   * case's checkpoints, artifacts, and token usage with its own records — the
   * chosen id is reported back on `CaseResult.sessionId`.
   */
  sessionIdForCase?: (file: string) => string;
}

export interface CaseResult {
  id: string;
  /** The case's short label — what reporters print beside the verdict. */
  title?: string;
  description?: string;
  /** The session the case ran on; absent when nothing ran (skipped, or unparseable). */
  sessionId?: string;
  verdict: CaseVerdict;
  records: AssertionRecord[];
  /** Why the case was skipped (`verdict.status === "skipped"`). */
  skipReason?: string;
  /** The terminating error of a case that died rather than halted. */
  error?: string;
}

/**
 * Why a suite ran no cases although its workflow loaded: `disabled` means the
 * workflow declares itself out of service — "not run" rather than "nothing to run".
 */
export type SuiteSkip = "disabled";

export interface RunTestsResult {
  results: CaseResult[];
  exitCode: number;
  /** How many case files the suite holds, before `filter` — so a filter that matched nothing can say so. */
  discovered: number;
  /** Set when the suite was skipped rather than run (see {@link SuiteSkip}). */
  skipped?: SuiteSkip;
}

/** One discovered case file: parsed, or the parse error that failed it. */
export interface DiscoveredCase {
  file: string;
  doc?: CaseDocument;
  parseError?: string;
}

const DEFAULT_CASE_TIMEOUT_MS = 120_000;

/**
 * Find and parse a suite's case files. Every file is parsed up front so a suite
 * never half-runs against an unreadable file: a schema violation becomes that
 * case's failed result rather than a thrown error.
 */
export async function discoverCases(
  authoring: Workspace,
  testsDir: string,
): Promise<DiscoveredCase[]> {
  const discovered: DiscoveredCase[] = [];
  for (const file of await listCaseFiles(authoring, testsDir)) {
    const source = await authoring.readText(file);
    if (source == null) {
      discovered.push({ file, parseError: `missing test file '${file}'` });
      continue;
    }
    try {
      discovered.push({ file, doc: parseCaseDocument(file, source, testsDir) });
    } catch (err) {
      if (!(err instanceof CaseSchemaError)) throw err;
      discovered.push({ file, parseError: err.message });
    }
  }
  return discovered;
}

/**
 * Reject when a case's execution exceeds its wall-clock budget, and abort the
 * run behind it: a timed-out case that kept executing would go on spending
 * tokens and emitting events under the next case's rendering.
 */
async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(`${label} timed out after ${ms}ms (tests.caseTimeoutMs)`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Materialize a case's seed files: inline workspace entries pass through
 * (strings verbatim, non-strings JSON-serialized by the seed handle) and
 * `from:` references are read from the tests directory. A missing fixture or
 * an escaping path fails here — before any step runs.
 */
async function materializeSeeds(
  authoring: Workspace,
  testsDir: string,
  doc: CaseDocument,
): Promise<Record<string, unknown>> {
  const seeds: Record<string, unknown> = {};
  for (const [path, entry] of Object.entries(doc.workspace) as Array<
    [string, CaseWorkspaceEntry]
  >) {
    if (entry.source === "inline") {
      seeds[path] = entry.content;
      continue;
    }
    const fixture = normalizeFixturePath(entry.from, doc.file);
    const content = await authoring.readText(`${testsDir}/${fixture}`);
    if (content == null) {
      throw new Error(
        `workspace entry '${path}' references 'from: ${entry.from}', but '${testsDir}/${fixture}' does not exist`,
      );
    }
    seeds[path] = content;
  }
  return seeds;
}

export interface RunCaseOptions {
  discovered: DiscoveredCase;
  agent: Agent & { workflow: WorkflowSurface };
  authoring: Workspace;
  testsDir: string;
  /** The agent session this case runs its conversation on. */
  sessionId: string;
  grade?: GradeFn;
  caseTimeoutMs?: number;
}

/**
 * Drive one case against the agent under test and settle its result. Never
 * throws for a case's own failure — a died case reports its terminating error
 * first, then whatever its already-evaluated records had missed, then the
 * steps that never ran as `not-executed`.
 */
export async function runCase(opts: RunCaseOptions): Promise<CaseResult> {
  const { discovered, agent, authoring, testsDir, sessionId } = opts;
  if (discovered.parseError !== undefined) {
    return {
      id: discovered.file,
      verdict: { status: "failed", failures: [discovered.parseError] },
      records: [],
      error: discovered.parseError,
    };
  }
  const doc = discovered.doc as CaseDocument;
  const head = { id: doc.id, title: doc.title, description: doc.description };

  if (doc.skip !== undefined) {
    return {
      ...head,
      verdict: { status: "skipped", failures: [] },
      records: [],
      skipReason: doc.skip,
    };
  }

  // Every record the case produces lands here as it is produced, and this is
  // the only source the result reads — so the timeout path (which lets go of
  // the `executeCase` promise) still reports what the case established.
  const produced: AssertionRecord[] = [];
  const failed = (message: string): CaseResult => {
    const recorded = new Set(produced.map((r) => r.step));
    const records = [...produced, ...notExecutedRecords(doc, (step) => recorded.has(step))];
    return {
      ...head,
      sessionId,
      verdict: { status: "failed", failures: [message, ...reduceVerdict(records).failures] },
      records,
      error: message,
    };
  };

  const controller = new AbortController();
  try {
    const seeds = await materializeSeeds(authoring, testsDir, doc);
    const outcome = await withTimeout(
      executeCase({
        doc,
        seeds,
        agent,
        sessionId,
        signal: controller.signal,
        onRecord: (record) => produced.push(record),
        ...(opts.grade ? { grade: opts.grade } : {}),
      }),
      opts.caseTimeoutMs ?? DEFAULT_CASE_TIMEOUT_MS,
      `case '${doc.id}'`,
      () => controller.abort(new Error(`case '${doc.id}' timed out`)),
    );
    if (outcome.error !== undefined) return failed(outcome.error);
    return { ...head, sessionId, verdict: reduceVerdict(produced), records: [...produced] };
  } catch (err) {
    return failed((err as Error).message);
  } finally {
    // Hermetic by session isolation: each case drives its own session, so its
    // `scratchpad/…` files resolve per session — no cleanup between files.
    agent.dispose(sessionId);
  }
}

/** Discover and run a workflow's cases. */
export async function runTests(opts: RunTestsOptions): Promise<RunTestsResult> {
  const { workflow, filter } = opts;
  const paths = workflowPaths(workflow);
  const { testsDir } = paths;
  // Every file this function reads — the spec, the suite config, the case
  // documents, their `from:` fixtures — lives on the authoring backend under
  // `workflows/<slug>/`. The agent driven by a case reaches none of it.
  // Without `authoring` only a root is given, so one is always resolved
  // (explicit, or the documented zero-config cwd) and the authoring plane is the
  // filesystem under it. With `authoring` the whole context is skipped rather
  // than built and half-used: its other members — the mount table, the session
  // store — are the agent's, and the agent here is the host's own target. A
  // host whose authored tree is a store would otherwise have to invent a local
  // `rootDir` for filesystem defaults nothing reads.
  const filesystem =
    opts.authoring === undefined ? createWorkspaceContext({ rootDir: opts.rootDir }) : undefined;
  const authoring =
    opts.authoring !== undefined ? new Workspace(opts.authoring) : filesystem!.authoring;
  // Only the default target builder reads this; a host supplying `authoring`
  // supplies its target too, so the cwd fallback here is never what runs.
  const workspaceRoot = filesystem?.rootDir ?? resolveWorkspaceRoot(opts.rootDir);

  // Suite configuration is declarative data in the spec (`tests:` block).
  const { spec } = await loadMachineSpec(authoring, paths);
  const config: WorkflowTestsConfig = spec?.tests ?? {};

  // A disabled workflow runs nothing — including here. Skipped rather than
  // failed, with a zero exit code: retiring a workflow must not turn CI red.
  if (specDisabled(spec)) return { results: [], exitCode: 0, discovered: 0, skipped: "disabled" };

  // Case concurrency is not implemented; a declared `maxConcurrency` above 1
  // fails loudly rather than being accepted and then silently run sequentially.
  if ((config.maxConcurrency ?? 1) > 1) {
    throw new Error(
      `'tests.maxConcurrency' is ${config.maxConcurrency}, but case concurrency is not ` +
        `implemented — cases run sequentially. Set it to 1 or remove the field.`,
    );
  }

  const all = await discoverCases(authoring, testsDir);
  const selected = filter ? all.filter((c) => c.file.includes(filter)) : all;
  // Nothing to run — say so before assembling an agent (and before needing a
  // model at all); the caller decides whether an empty selection is an error.
  if (selected.length === 0) return { results: [], exitCode: 0, discovered: all.length };

  const agent =
    typeof opts.createTarget === "function"
      ? await opts.createTarget({
          workflow,
          rootDir: workspaceRoot,
          ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
        })
      : (opts.createTarget ??
        (await createCaseTarget({
          workflow,
          rootDir: workspaceRoot,
          onEvent: opts.onEvent,
          ...(opts.sandboxRuntime ? { sandboxRuntime: opts.sandboxRuntime } : {}),
          ...(opts.modelFactory ? { modelFactory: opts.modelFactory } : {}),
        })));
  // Re-checked here rather than trusted from the builder: a caller-supplied
  // target has passed through no such gate, and a misconfigured host should
  // fail on its first move instead of midway through a suite.
  assertWorkflowGovernedTarget(agent, workflow);

  // The grading model is wired only when the spec declares one; a `grade:`
  // step without it records an actionable failure.
  let grade: GradeFn | undefined;
  if (config.judge !== undefined) {
    const model = createJudgeModel(config, opts.modelFactory);
    grade = (criteria, evidence) => gradeClosedQA(model, criteria, evidence);
  }

  const runId = `test-run-${Date.now()}`;
  const results: CaseResult[] = [];
  for (const discovered of selected) {
    const sessionId =
      opts.sessionIdForCase?.(discovered.file) ??
      `test-default-${runId}-${discovered.file.replace(/\//g, "-")}`;
    opts.onCaseStart?.(discovered.file, sessionId);
    const result = await runCase({
      discovered,
      agent,
      authoring,
      testsDir,
      sessionId,
      ...(grade ? { grade } : {}),
      ...(config.caseTimeoutMs !== undefined ? { caseTimeoutMs: config.caseTimeoutMs } : {}),
    });
    results.push(result);
    opts.onCaseResult?.(result);
  }

  const exitCode = results.some((r) => exitCodeForVerdict(r.verdict) !== 0) ? 1 : 0;
  return { results, exitCode, discovered: all.length };
}
