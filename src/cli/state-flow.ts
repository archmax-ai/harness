/**
 * The CLI's renderer of the typed event stream — the **state flow** — with two
 * entry points:
 *
 * - {@link createStateFlowRenderer}: the live, colorized trail `archmax run`
 *   writes to `stderr`, one line per lifecycle event, append-only.
 * - {@link createTestView}: what `archmax test` builds on top of it — a fresh
 *   trail per case under a dimmed case header, a styled verdict line per case,
 *   and the closing summary.
 *
 * The trail uses two indentation tiers so a session reads as a hierarchy:
 * state changes (`state-enter`, `state-leave`) sit at the outer margin, and
 * what happened *inside* a state (hooks, tool calls, the agent's own text,
 * quoted) is indented beneath it. Lifecycle phases are colour-coded — `before`
 * in blue, `after` in magenta. Assembly-time and high-frequency telemetry
 * events are dropped to keep the trail readable.
 */
import { isChildSessionOf } from "../sessions/scope.js";
import { originLabel, type WorkflowEventInput } from "../core/events.js";
import { ADVANCE_TOOL } from "../machine/tool-names.js";
import { exitCodeForVerdict, type CaseResult, type SuiteSkip } from "../testing/runner.js";
import { createStyle, icons, type Style } from "./style.js";

export interface StateFlowWriter {
  write(chunk: string): unknown;
}

export interface StateFlowRenderer {
  /** Accepts events with or without a `level` (the renderer keys off `type`). */
  onEvent(event: WorkflowEventInput): void;
}

/** Indentation for per-state action lines (hooks, agent text). */
const ACTION_INDENT = "    ";
/** Deeper indentation for output nested under an action (e.g. script stdout). */
const OUTPUT_INDENT = "      ";
/** Indentation for failure details nested under a verdict line. */
const DETAIL_INDENT = "      ";
/** Indentation for the summary's named case lists. */
const LIST_INDENT = "  ";

/**
 * Build a renderer that writes an append-only, hierarchical state flow to
 * `stream`. Assembly-time events (`interpreter-enabled`,
 * `hooks-summary`, `graph-topology`, `workflow-reset`) are ignored — the CLI
 * prints its own session header. The `advance` event only renders the agent's
 * one-sentence `reason` (the target itself is shown by the following `state-leave`).
 */
export function createStateFlowRenderer(
  stream: StateFlowWriter,
  styleOverride?: Style,
): StateFlowRenderer {
  const s = styleOverride ?? createStyle();
  const phaseColor = (phase: "before" | "after") => (phase === "before" ? s.blue : s.magenta);
  const write = (line: string) => stream.write(`${line}\n`);
  const writeAgentText = (text: string) => {
    for (const line of text.split("\n")) write(`${ACTION_INDENT}${s.gray(icons.quote)} ${line}`);
  };

  return {
    onEvent(event: WorkflowEventInput) {
      // Everything a *child session* emits is folded into its dispatch lines:
      // a sub-workflow shares its caller's event handler, so rendering its
      // states inline would read as the parent walking into a machine it never
      // entered. The dispatch's own start/result lines say what ran.
      if ((event as { subWorkflowDispatchId?: string }).subWorkflowDispatchId) {
        if (event.type !== "sub-workflow-start" && event.type !== "sub-workflow-result") return;
      }
      switch (event.type) {
        case "state-enter":
          write("");
          write(`${s.cyan(icons.inProgress)} ${s.bold(event.state)}`);
          break;
        case "state-leave":
          write(
            `${s.green(icons.check)} ${event.state} ${s.dim(icons.arrow)} ${s.cyan(event.next)}`,
          );
          break;
        case "state-error-routed":
          write(
            `${s.yellow(icons.warn)} ${event.state} ${s.dim(icons.arrow)} ${s.yellow(event.to)} ` +
              s.dim(`(on_error: ${event.reason})`),
          );
          break;
        case "hook-start":
          write(
            `${ACTION_INDENT}${phaseColor(event.phase)(`${icons.bullet} ${event.phase}`)} ${s.dim(event.label)}`,
          );
          break;
        case "hook-output":
          write(`${OUTPUT_INDENT}${s.dim(event.line)}`);
          break;
        case "hook-passed":
          write(`${ACTION_INDENT}${s.green(icons.check)} ${s.dim(`${event.phase} passed`)}`);
          break;
        case "hook-verdict": {
          const missing = event.missing?.length ? ` (missing: ${event.missing.join(", ")})` : "";
          const mark =
            event.verdict === "ok"
              ? s.green(icons.check)
              : event.verdict === "veto"
                ? s.red(icons.cross)
                : s.yellow(icons.inProgress);
          write(
            `${ACTION_INDENT}${mark} ${phaseColor(event.phase)(event.phase)} ` +
              `${s.dim(`${event.verdict} — ${event.reason}${missing}`)}`,
          );
          break;
        }
        case "hook-rejected":
          write(
            `${ACTION_INDENT}${s.red(icons.cross)} ${s.red(`${event.phase} rejected`)} ${s.dim(event.reason)}`,
          );
          break;
        case "tool-called":
          // The transition tool is reported by the state lines and the advance
          // reason, so its call would be the same event twice.
          if (event.tool === ADVANCE_TOOL) break;
          write(
            `${ACTION_INDENT}${s.gray(icons.bullet)} ${s.dim(event.tool)}` +
              `${event.detail ? ` ${s.gray(event.detail)}` : ""}` +
              `${event.origin ? s.gray(` via ${originLabel(event.origin)}`) : ""}`,
          );
          break;
        case "tool-blocked":
          write(
            `${ACTION_INDENT}${s.yellow(`${icons.warn} blocked ${event.tool}`)} ` +
              `${s.dim(`(not allowed in ${event.state}${event.origin ? `, from a ${originLabel(event.origin)}` : ""})`)}`,
          );
          break;
        case "agent-text":
          writeAgentText(event.text);
          break;
        case "advance":
          if (event.reason?.trim())
            write(`${ACTION_INDENT}${s.dim(`${icons.arrow} ${event.reason.trim()}`)}`);
          break;
        case "parked": {
          // Both park channels render here; naming which one a reader is
          // looking at is the whole point of the channel on the event.
          const input = event.awaiting === "input";
          const label = input ? "awaiting input" : "awaiting human decision";
          const why = input && event.reason?.trim() ? ` — ${event.reason.trim()}` : "";
          const due = input && event.resumeAt ? ` (due ${event.resumeAt})` : "";
          write(
            `${ACTION_INDENT}${s.yellow(`${icons.warn} ${label}`)} ` +
              `${s.dim(`${input ? "in" : "at"} ${event.state}${why}${due}`)}`,
          );
          break;
        }
        // A state's delegations render as nested activity, not as trail steps
        // of their own: the session has not moved — one state is running whole
        // workflows inside itself, which a reader needs to see as *depth*.
        case "sub-workflow-start":
          write(
            `${ACTION_INDENT}${s.cyan(icons.inProgress)} ${s.dim(`sub-workflow ${event.workflow}`)}` +
              `${event.depth > 1 ? s.gray(` (depth ${event.depth})`) : ""}`,
          );
          break;
        case "sub-workflow-result":
          if (event.status === "parked") {
            write(
              `${ACTION_INDENT}${s.yellow(icons.warn)} ` +
                `${s.dim(`sub-workflow ${event.workflow} parked — the session suspends with it`)}`,
            );
          } else if (event.status === "ok") {
            write(
              `${ACTION_INDENT}${s.green(icons.check)} ${s.dim(`sub-workflow ${event.workflow} (${event.durationMs}ms)`)}`,
            );
          } else {
            write(
              `${ACTION_INDENT}${s.red(icons.cross)} ${s.red(`sub-workflow ${event.workflow} failed`)} ` +
                `${s.dim(event.reason ?? "")}`,
            );
          }
          break;
        case "decided":
          write(`${ACTION_INDENT}${s.green(icons.check)} ${s.dim(`decision -> ${event.to}`)}`);
          break;
        // The conversation continuing while parked. Only the inbound side
        // renders: the reply arrives as `agent-text` like anything else the
        // model says, and showing it twice would read as two replies.
        case "park-message":
          if (event.direction === "inbound") {
            write(
              `${ACTION_INDENT}${s.yellow(icons.arrow)} ${s.dim(`message to the parked session at ${event.state}`)}`,
            );
            writeAgentText(event.text);
          }
          break;
        case "delivered":
          write(
            `${ACTION_INDENT}${s.green(icons.check)} ${s.dim(`${event.trigger} delivered, resuming ${event.state}`)}`,
          );
          break;
        case "warning":
          write(`${s.yellow(`${icons.warn} [${event.scope}]`)} ${s.dim(event.message)}`);
          break;
        case "workflow-reset":
        case "interpreter-enabled":
        case "hooks-summary":
        case "graph-topology":
        case "agent-text-delta":
        case "tool-result":
        case "rubric-start":
        case "rubric-result":
        case "model-usage":
        case "prompt-shaping":
          // Lifecycle summaries and high-frequency (GUI-oriented) telemetry.
          break;
      }
    },
  };
}

export interface TestView {
  /**
   * Reporter hook for `RunTestsOptions.onCaseStart`: dimmed case header + fresh
   * trail. Given the case's session id, the trail shows only that session's
   * events (and its child sessions'), so a run that outlives its case cannot
   * paint under the next case's heading.
   */
  onCaseStart(file: string, sessionId?: string): void;
  /** Reporter hook for `RunTestsOptions.onCaseResult`: styled verdict line with details. */
  onCaseResult(result: CaseResult): void;
  /** Workflow event hook: forwards to the current case's state-flow renderer. */
  onEvent(event: WorkflowEventInput): void;
  /** Closing overview: counts plus named failed/passed/skipped lists. */
  renderSummary(results: CaseResult[]): void;
  /**
   * The whole suite was skipped rather than run — a disabled workflow runs
   * nothing. One line in place of the summary, never a failure.
   */
  renderSuiteSkipped(workflow: string, reason: SuiteSkip): void;
}

/** One line naming a case and its outcome — the same shape in the per-case verdict and the summary. */
export function caseVerdictLine(s: Style, result: CaseResult): string {
  const title = result.title ? ` ${s.dim(`— ${result.title}`)}` : "";
  switch (result.verdict.status) {
    case "passed":
      return `${s.green(icons.check)} ${result.id}${title}`;
    case "skipped":
      return `${s.yellow(icons.pending)} ${result.id}${title}${result.skipReason ? ` ${s.dim(`(${result.skipReason})`)}` : ""}`;
    case "failed":
      return `${s.red(icons.cross)} ${result.id}${title}`;
  }
}

/**
 * Build the `archmax test` view writing to `stream` (normally `process.stderr`).
 * Each case gets its own state-flow renderer so trails from sequential cases
 * never share state.
 */
export function createTestView(stream: StateFlowWriter, styleOverride?: Style): TestView {
  const s = styleOverride ?? createStyle();
  const write = (line: string) => stream.write(`${line}\n`);
  let stateFlow: StateFlowRenderer | null = null;
  let currentSession: string | undefined;

  return {
    onCaseStart(file, sessionId) {
      currentSession = sessionId;
      stateFlow = createStateFlowRenderer(stream, s);
      write("");
      write(s.dim(`${icons.diamond} case ${file}`));
    },

    onCaseResult(result) {
      write("");
      write(caseVerdictLine(s, result));
      for (const failure of result.verdict.failures)
        write(`${DETAIL_INDENT}${s.red(icons.cross)} ${s.dim(failure)}`);
      // A grade is otherwise invisible when it passes — only failures print —
      // so print every graded record that ran, passing or not. An un-run one
      // has no score, and `0 / 0.7` would read as a grade of zero; those are
      // covered by the not-executed count below.
      for (const graded of result.records.filter(
        (r) => r.threshold != null && r.status !== "not-executed",
      )) {
        const mark = graded.status === "passed" ? s.green(icons.check) : s.yellow(icons.warn);
        write(
          `${DETAIL_INDENT}${mark} ${s.dim(`${graded.kind} ${graded.score ?? 0} / ${graded.threshold}`)}`,
        );
      }
      // Without this, a halted case's remaining assertions read as if they had passed.
      const notExecuted = result.records.filter((r) => r.status === "not-executed").length;
      if (notExecuted > 0) {
        const line = `${notExecuted} ${notExecuted === 1 ? "assertion" : "assertions"} not executed`;
        write(`${DETAIL_INDENT}${s.yellow(icons.pending)} ${s.dim(line)}`);
      }
    },

    onEvent(event) {
      // An event bound to another session belongs to a case that already ended
      // (a timed-out run still winding down); it is not this case's trail.
      const bound = (event as { sessionId?: string }).sessionId;
      if (
        currentSession &&
        bound &&
        bound !== currentSession &&
        !isChildSessionOf(bound, currentSession)
      ) {
        return;
      }
      // Events can arrive before the first case (agent assembly); give them a
      // renderer too so e.g. warnings are not dropped.
      stateFlow ??= createStateFlowRenderer(stream, s);
      stateFlow.onEvent(event);
    },

    renderSuiteSkipped(workflow, reason) {
      const why = reason === "disabled" ? "the workflow is disabled" : reason;
      write("");
      write(
        `${s.yellow(icons.pending)} ${s.bold("suite skipped")} ${s.dim(`— ${why} (${workflow}); no case ran`)}`,
      );
    },

    renderSummary(results) {
      const skipped = results.filter((r) => r.verdict.status === "skipped");
      // Failed-ness reuses the exit-code semantics, so the summary and the
      // process agree by construction.
      const failed = results.filter(
        (r) => r.verdict.status !== "skipped" && exitCodeForVerdict(r.verdict) !== 0,
      );
      const passed = results.filter((r) => !skipped.includes(r) && !failed.includes(r));

      write("");
      write(
        `${s.cyan(s.bold(`${icons.diamond} summary`))} ` +
          s.dim(`${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`),
      );
      if (results.length > 0 && failed.length === 0 && skipped.length === 0) {
        write(`${LIST_INDENT}${s.green(icons.check)} all ${results.length} case(s) passed`);
        return;
      }
      const name = (r: CaseResult) => (r.title ? `${r.id} ${s.dim(`— ${r.title}`)}` : r.id);
      for (const r of failed) write(`${LIST_INDENT}${s.red(icons.cross)} ${name(r)}`);
      for (const r of passed) write(`${LIST_INDENT}${s.green(icons.check)} ${name(r)}`);
      for (const r of skipped) write(`${LIST_INDENT}${s.yellow(icons.pending)} ${name(r)}`);
    },
  };
}
