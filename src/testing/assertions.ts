/**
 * Host-side evaluation of a case's assertions against a driven turn's
 * {@link SessionView}. Every assertion the case format offers is a hard failure —
 * including `grade`, whose declared `atLeast` is the author's bar, not a note —
 * so a record's `status` is the only thing verdict reduction and the CLI's
 * test view need to read.
 */
import type { SessionView, ToolCallFact } from "../workflow/session-view.js";
import type { TrailStep } from "../workflow/state.js";
import type { AssertionRecord } from "./runner.js";
import type { CaseExpectation, ReplyToken } from "./case-schema.js";
import { deepEqual, partialMatch } from "../core/match.js";
import { judgeEvidenceFromView, type JudgeEvidence, type JudgeResult } from "./grade.js";
import { resolvePath } from "../machine/variables.js";

/** Scores one closed-QA criterion (wired to the suite's grading model). */
export type GradeFn = (criteria: string, evidence: JudgeEvidence) => Promise<JudgeResult>;

/**
 * The **structural** assertions: the ones that assert where the session went.
 * Once one of them fails, every later step would drive or grade a session the
 * case no longer describes — a `decide` after a failed `parked` cannot succeed,
 * and a `reply` check after a failed `reachedState` grades the wrong state's
 * output — so a failure here halts the case.
 *
 * The content assertions (`reply`, `calledTool`, `notCalledTool`, `usedNoTools`,
 * `grade`) are deliberately absent: a wrong reply is a defect in the turn, not
 * evidence that the session stopped being the one under test.
 */
const STRUCTURAL_ASSERTS: ReadonlySet<CaseExpectation["assert"]> = new Set([
  "succeeded",
  "parked",
  "reachedState",
  "trail",
  "noTraversal",
  "triggerArrival",
  "variables",
] satisfies Array<CaseExpectation["assert"]>);

/** Whether a failure of this assertion kind halts the rest of the case. */
export function haltsCaseOnFailure(assert: CaseExpectation["assert"]): boolean {
  return STRUCTURAL_ASSERTS.has(assert);
}

/**
 * Describe an assertion step that never ran. One record per step, never one per
 * token: an un-run `reply` with three tokens would have produced three records,
 * but the engine did not run it and does not invent outcomes it never computed.
 */
export function notExecutedRecord(expect: CaseExpectation, step: number): AssertionRecord {
  return {
    kind: expect.assert,
    threshold: expect.assert === "grade" ? expect.atLeast : null,
    status: "not-executed",
    step,
  };
}

/**
 * Every assistant message in the view, newest last. Reply assertions match
 * against this whole transcript rather than only the final reply: a session
 * that parks at a human state often closes with a short "moving on" message
 * while the substantive answer came one message earlier.
 */
function assistantTranscript(view: SessionView): string {
  const parts: string[] = [];
  for (const e of view.events) {
    if (e.type === "message.completed" && e.data && e.data.message) {
      parts.push(String(e.data.message));
    }
  }
  if (parts.length === 0 && view.reply) parts.push(String(view.reply));
  return parts.join("\n");
}

function tokenMatches(token: ReplyToken, text: string): boolean {
  return token.regex ? token.regex.test(text) : text.includes(token.raw);
}

function matchesToolCall(
  calls: ToolCallFact[],
  name: string,
  input: Record<string, unknown> | undefined,
  status?: ToolCallFact["status"],
): boolean {
  return calls.some(
    (c) =>
      c.name === name &&
      (status === undefined || c.status === status) &&
      (input === undefined || partialMatch(input, c.input)),
  );
}

function trailOf(view: SessionView): TrailStep[] {
  return Array.isArray(view.auditTrail) ? view.auditTrail : [];
}

/**
 * Evaluate one turn's expectations. `step` is the index, in the case
 * document's flat `steps` list, of the step these entries came from; every
 * record produced here is stamped with it, so attribution never depends on
 * how many records an expectation happens to emit. The optional `grade`
 * scores `grade` entries; when absent (no `tests.judge` in workflow.yaml), a
 * grade entry records an actionable failure instead of silently passing.
 */
export async function evaluateExpectations(
  entries: readonly CaseExpectation[],
  view: SessionView,
  step: number,
  grade?: GradeFn,
): Promise<AssertionRecord[]> {
  const records: AssertionRecord[] = [];
  const trail = trailOf(view);

  // Closes over `step`, so it is the single place a deterministic record is
  // built and there is no way to build one without its step or its status.
  const gate = (kind: string, pass: boolean, detail?: string): AssertionRecord => ({
    kind,
    threshold: null,
    status: pass ? "passed" : "failed",
    step,
    ...(detail !== undefined ? { detail } : {}),
  });

  for (const entry of entries) {
    switch (entry.assert) {
      case "succeeded":
        records.push(gate("succeeded", !view.failed && !view.parked));
        break;
      case "parked":
        // A bare `parked` accepts either channel; a pinned one must match the
        // channel — and, when named, the state — the session actually suspended in.
        records.push(
          gate(
            "parked",
            view.parked &&
              (entry.channel === undefined || view.parkedChannel === entry.channel) &&
              (entry.state === undefined || view.state === entry.state),
            [entry.channel, entry.state].filter(Boolean).join(" in ") || undefined,
          ),
        );
        break;
      case "reachedState":
        // Committed transitions only (any kind except `trigger`): the arrival
        // step is recorded before the entry state's `before` gate runs, so a
        // vetoed-entry session never "reaches" the state the gate refused.
        records.push(
          gate(
            "reachedState",
            trail.some((s) => s.kind !== "trigger" && s.to === entry.state),
            entry.state,
          ),
        );
        break;
      case "reply": {
        const transcript = assistantTranscript(view);
        for (const token of entry.includes) {
          records.push(gate("reply.includes", tokenMatches(token, transcript), token.raw));
        }
        for (const token of entry.excludes) {
          records.push(gate("reply.excludes", !tokenMatches(token, transcript), token.raw));
        }
        break;
      }
      case "calledTool":
        records.push(
          gate("calledTool", matchesToolCall(view.toolCalls, entry.name, entry.input), entry.name),
        );
        break;
      case "notCalledTool":
        records.push(
          gate(
            "notCalledTool",
            !matchesToolCall(view.toolCalls, entry.name, entry.input),
            entry.name,
          ),
        );
        break;
      case "blockedTool":
        // Refused by governance — the run view separates a policy rejection
        // from a tool that ran and failed, so a case can assert the guard fired
        // rather than infer it from an absence (which is what `notCalledTool`
        // measures: an agent that never reached for the thing tested nothing).
        records.push(
          gate(
            "blockedTool",
            matchesToolCall(view.toolCalls, entry.name, entry.input, "rejected"),
            entry.name,
          ),
        );
        break;
      case "usedNoTools":
        records.push(gate("usedNoTools", view.toolCalls.length === 0));
        break;
      case "ranWorkflow": {
        // Read from the trail, not from tool calls: a script's delegation never
        // appears among the model's calls, and the trail's `sub-workflow` step
        // is the session's whole durable record of the dispatch either way.
        const matching = trail.filter(
          (s) =>
            s.kind === "sub-workflow" &&
            s.workflow === entry.workflow &&
            (s.status ?? "ok") === entry.status,
        );
        const ok =
          entry.count === undefined ? matching.length > 0 : matching.length === entry.count;
        records.push(
          gate(
            "ranWorkflow",
            ok,
            `${entry.workflow} (${entry.status}${entry.count === undefined ? "" : `, ${matching.length}/${entry.count}`})`,
          ),
        );
        break;
      }
      case "trail": {
        const matching = trail.filter(
          (s) =>
            (entry.to === undefined || s.to === entry.to) &&
            (entry.stepKind === undefined || s.kind === entry.stepKind) &&
            (entry.reason === undefined || s.reason === entry.reason),
        );
        const wanted = [
          ...(entry.to !== undefined ? [`to=${entry.to}`] : []),
          ...(entry.stepKind !== undefined ? [`kind=${entry.stepKind}`] : []),
          ...(entry.reason !== undefined ? [`reason=${entry.reason}`] : []),
        ].join(" ");
        records.push(
          gate(
            "trail",
            matching.length === entry.count,
            `${wanted} expected ${entry.count}, saw ${matching.length}`,
          ),
        );
        break;
      }
      case "noTraversal":
        // A veto at entry leaves nothing but trigger-arrival steps.
        records.push(
          gate(
            "noTraversal",
            trail.every((s) => s.kind === "trigger"),
            "no committed transitions",
          ),
        );
        break;
      case "triggerArrival":
        records.push(
          gate(
            "triggerArrival",
            trail.some((s) => s.kind === "trigger" && s.reason === entry.trigger),
            entry.trigger,
          ),
        );
        break;
      case "variables": {
        for (const [name, expected] of Object.entries(entry.expect)) {
          const stored = view.variables?.[name];
          const path = entry.path?.[name];
          const label = path ? `${name}.${path}` : name;
          if (stored === undefined) {
            records.push(gate("variables", false, `${label} (not set)`));
            continue;
          }
          const actual = path ? resolvePath(stored.value, path.split(".")) : stored.value;
          if (path && actual === undefined) {
            records.push(gate("variables", false, `${label} (path does not resolve)`));
            continue;
          }
          const matched = deepEqual(actual, expected);
          records.push(
            gate(
              "variables",
              matched,
              matched
                ? label
                : `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
            ),
          );
          const wantLocked = entry.locked?.[name];
          if (wantLocked !== undefined) {
            records.push(
              gate(
                "variables",
                stored.locked === wantLocked,
                `${name} locked=${wantLocked} (actual ${stored.locked})`,
              ),
            );
          }
        }
        break;
      }
      case "grade": {
        const record: AssertionRecord = {
          kind: "grade.closedQA",
          threshold: entry.atLeast,
          status: "failed",
          score: 0,
          detail: entry.closedQA,
          step,
        };
        if (!grade) {
          record.detail = `${entry.closedQA} (grading model unavailable: declare 'tests: { judge: ... }' in workflow.yaml)`;
        } else {
          try {
            // The grader scores the turn's evidence — its final reply plus the
            // chronological record of what it did to get there — built from the
            // same view every other assertion on this step reads, so a `grade`
            // and a `calledTool` here can never disagree about what happened.
            const result = await grade(entry.closedQA, judgeEvidenceFromView(view));
            record.score = Math.max(0, Math.min(1, Number(result.score ?? 0)));
            if (result.reason) record.detail = `${entry.closedQA}: ${result.reason}`;
          } catch (err) {
            record.detail = `${entry.closedQA}: ${(err as Error).message}`;
          }
        }
        // The case author's declared bar decides, not the grading model's own
        // boolean: `atLeast` is what the verdict compares against, so deciding
        // the record any other way lets a record contradict the verdict shown
        // beside it. A miss fails the case like any other assertion.
        record.status = (record.score ?? 0) >= entry.atLeast ? "passed" : "failed";
        records.push(record);
        break;
      }
    }
  }

  return records;
}
