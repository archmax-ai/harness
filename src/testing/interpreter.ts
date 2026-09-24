/**
 * Host-side interpretation of one parsed case document: open the case's
 * session with its start conditions, then walk the flat step list — actions
 * (`send`, `decide`, `deliver`) drive the agent through `workflow.send`, and each
 * assertion evaluates against the view of the nearest action above it. No sandbox is involved —
 * the QuickJS sandbox serves only lifecycle hooks and the agent's own sandbox
 * tools inside the driven agent.
 *
 * A case that dies partway is still reported: termination is returned as an
 * `error` on the outcome, next to the records the case had already produced,
 * so the steps that passed before it are never thrown away.
 */
import type { Agent, WorkflowSurface } from "../agent.js";
import type { SessionView } from "../workflow/session-view.js";
import { isWorkflowToolName } from "../machine/tool-names.js";
import {
  evaluateExpectations,
  haltsCaseOnFailure,
  notExecutedRecord,
  type GradeFn,
} from "./assertions.js";
import type { CaseAction, CaseDocument } from "./case-schema.js";
import {
  DEFAULT_SESSION_ID,
  createSessionEngine,
  unDelegatableMocksMessage,
  unInterceptableMocksMessage,
} from "./driver.js";
import type { AssertionRecord } from "./runner.js";

export interface ExecuteCaseOptions {
  /** Aborts the runs the case drives (the case's wall-clock budget). */
  signal?: AbortSignal;
  doc: CaseDocument;
  /** Seed files, `from:` references already materialized by the runner. */
  seeds: Record<string, unknown>;
  agent: Agent & { workflow: WorkflowSurface };
  /** The runtime session id for this case (caller-nameable via `sessionIdForCase`). */
  sessionId: string;
  grade?: GradeFn;
  /**
   * Invoked with each assertion record as it is produced — observe-only; the
   * record objects are the same ones returned in the outcome. A caller that
   * may stop waiting on this promise (the runner abandons it at the case's
   * wall-clock deadline) uses this to hold the records produced before it let
   * go, which the return value can no longer deliver.
   */
  onRecord?: (record: AssertionRecord) => void;
}

export interface ExecuteCaseOutcome {
  records: AssertionRecord[];
  /**
   * Set when the case terminated before its steps were exhausted: a failed
   * `send`/`decide`, a refused start (bad trigger, failed seed,
   * un-interceptable mocks). The records produced before that point are still
   * returned alongside it — a case's failure is reported as data, not by
   * throwing past what it already established.
   */
  error?: string;
}

/**
 * Describe every assertion step a case did not account for, as `not-executed`
 * records. The one place un-run steps are built, so the three ways a case can
 * stop early — a structural halt, a thrown action, and the runner's wall-clock
 * timeout — cannot drift apart in what they report.
 */
export function notExecutedRecords(
  doc: CaseDocument,
  alreadyAccountedFor: (step: number) => boolean,
): AssertionRecord[] {
  const out: AssertionRecord[] = [];
  for (const [index, step] of doc.steps.entries()) {
    if (step.kind !== "assert" || alreadyAccountedFor(index)) continue;
    out.push(notExecutedRecord(step.expect, index));
  }
  return out;
}

/**
 * Why a case's declared mocks cannot be honoured by this target, or `null`.
 * Checked once, before anything runs: a mock-declaring case never executes
 * with partial interception — and never seeds or drives first.
 */
function mockRefusal(doc: CaseDocument, agent: Agent & { workflow: WorkflowSurface }): string | null {
  if (doc.mocks.length === 0) return null;
  // Without the tool-mock middleware, declared mocks would intercept only
  // scripts' PTC calls while the agent's own calls hit real tools. Absence of
  // the capability field (a hand-rolled runtime) counts as "cannot intercept".
  if (agent.toolMocks !== true) return unInterceptableMocksMessage(doc.mocks.length);
  // A delegation mock stands in for a whole other governed machine: without a
  // governed assembly to dispatch one, the mock is inert.
  if (doc.mocks.some((mock) => isWorkflowToolName(mock.name)) && !agent.workflow) {
    return unDelegatableMocksMessage();
  }
  return null;
}

/** Execute one case document against the agent under test. */
export async function executeCase(opts: ExecuteCaseOptions): Promise<ExecuteCaseOutcome> {
  const { doc, seeds, agent, sessionId, grade, onRecord } = opts;
  const engine = createSessionEngine({
    agent,
    defaultSessionId: sessionId,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const records: AssertionRecord[] = [];
  const collect = (produced: readonly AssertionRecord[]): void => {
    for (const record of produced) {
      records.push(record);
      onRecord?.(record);
    }
  };
  const notExecutedFrom = (from: number): AssertionRecord[] =>
    notExecutedRecords(doc, (step) => step < from);

  const refused = mockRefusal(doc, agent);
  if (refused) return { records, error: refused };

  // The step the loop is currently attempting, so the catch below knows where
  // execution stopped. -1 until the first step: a throw from `engine.open`
  // leaves every assertion step un-run.
  let attemptedStep = -1;

  try {
    // Start conditions apply before any step: a bad trigger declaration or a
    // failed workspace seed fails the case even when it has no steps.
    await engine.open(DEFAULT_SESSION_ID, {
      ...(doc.trigger !== undefined ? { trigger: doc.trigger } : {}),
      ...(doc.variables !== undefined ? { variables: doc.variables } : {}),
      files: seeds,
    });

    // The schema guarantees every assertion follows an action, so `view` is
    // always set by the time an assertion evaluates.
    let view: SessionView | null = null;
    for (const [index, step] of doc.steps.entries()) {
      attemptedStep = index;
      if (step.kind === "action") {
        view = await runAction(step.action);
        continue;
      }
      const produced = await evaluateExpectations([step.expect], view as SessionView, index, grade);
      collect(produced);

      // A failed structural assertion means the session is no longer the one
      // this case describes, so driving it further grades the wrong session.
      // Stop, and account for the steps that will not run.
      if (haltsCaseOnFailure(step.expect.assert) && produced.some((r) => r.status === "failed")) {
        collect(notExecutedFrom(index + 1));
        break;
      }
    }
  } catch (err) {
    collect(notExecutedFrom(attemptedStep + 1));
    return { records, error: (err as Error).message };
  }

  return { records };

  async function runAction(action: CaseAction): Promise<SessionView> {
    if (action.action === "send") return engine.send(DEFAULT_SESSION_ID, action.message, doc.mocks);
    if (action.action === "deliver")
      return engine.deliver(DEFAULT_SESSION_ID, action.trigger, action.variables);
    return engine.decide(DEFAULT_SESSION_ID, action.to, action.comment);
  }
}
