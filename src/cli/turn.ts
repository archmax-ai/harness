/**
 * One turn on a session, as the CLI drives it, and how its outcome is reported:
 * the reply or the park on stdout, the resume hints on stderr. `run` sends a
 * turn through `agent.workflow.send`; `decide` / `reply` / `deliver` each
 * resume one, and every outcome is described the same way.
 */
import type { Agent, WorkflowSurface } from "../agent.js";
import type { TriggerInput } from "../machine/triggers.js";
import type { DecideOutcome, Outcome, ReplyOutcome } from "../sessions/resume.js";
import type { ParkChannel, PendingDecision, PendingInput } from "../workflow/state.js";
import type { WorkflowMachine } from "../machine/machine.js";
import { lastAgentText } from "../core/messages.js";
import { formatUsage, hasUsage, type UsageTracker } from "../core/usage.js";
import { icons, type Style } from "./style.js";
import { CliError, err, out } from "./command.js";
import { isKnown } from "./bootstrap.js";

/** Token usage on stderr — never a row of zeros, never on stdout. */
export function printUsageFooter(style: Style, usage: UsageTracker, sessionId?: string): void {
  const totals = usage.totals(sessionId);
  if (!hasUsage(totals)) return;
  err("");
  err(`${style.dim("tokens")}     ${formatUsage(totals)}`);
}

type Transition = { to: string; description?: string; type?: string };

/** The context a person needs to decide a parked human state, from the spec — nothing is rendered to a file. */
export function printDecisionContext(
  machine: WorkflowMachine,
  state: string,
  transitions: Transition[],
  evidence?: string[],
  write = out,
): void {
  const declared = machine.spec.states[state];
  const instructions = declared?.instructions?.trim();
  if (instructions) write(`  Instructions: ${instructions}`);
  if (declared?.approvers?.length) write(`  Approvers: ${declared.approvers.join(", ")}`);
  const paths = evidence ?? declared?.evidence ?? [];
  if (paths.length) write(`  Evidence: ${paths.join(", ")}`);
  for (const t of transitions) {
    write(
      `  ${t.type && t.type !== "none" ? `[${t.type}] ` : ""}${t.to}${t.description ? ` — ${t.description}` : ""}`,
    );
  }
}

const decideHint = (sessionId: string) =>
  `Decide it with:\n  archmax decide ${sessionId} --to <state> [--comment "why"]\n` +
  `  archmax reply ${sessionId} "<message>"   (answer without deciding)`;
const deliverHint = (sessionId: string) =>
  `Resume it with:\n  archmax deliver ${sessionId} --trigger <id> [--variables '{"…":"…"}']`;

/** A session that stopped again, on whichever channel — and what resumes *that* channel. */
function printReparked(
  style: Style,
  sessionId: string,
  channel: ParkChannel | undefined,
  state: string | undefined,
): void {
  const where = state ? `'${state}'` : "its current state";
  if (channel === "input") {
    err(style.yellow(style.bold(`${icons.warn} awaiting input`)));
    out(`Session ${sessionId} parked again in the ${where} state.`);
    err(deliverHint(sessionId));
  } else {
    err(style.yellow(style.bold(`${icons.warn} awaiting human decision`)));
    out(`Session ${sessionId} parked at the ${where} human state.`);
    err(decideHint(sessionId));
  }
}

/**
 * A session that ended rejected: why, on stderr, and whatever it last said on
 * stdout. Governance said no, so the command failed — never an answer.
 */
function printRejected(style: Style, sessionId: string, state: string | undefined, reason?: string, reply?: string): void {
  err(style.red(style.bold(`${icons.cross} rejected`)));
  err(`Session ${sessionId} was rejected${state ? ` in the '${state}' state` : ""}${reason ? `: ${reason}` : "."}`);
  if (reply) out(reply);
}

/** Report a resume's result. Returns the exit code: 1 when the session ended rejected. */
export function printResumed(style: Style, sessionId: string, verb: string, outcome: DecideOutcome): number {
  err("");
  if (outcome.reparked) return (printReparked(style, sessionId, outcome.parkedChannel, outcome.state), 0);
  if (outcome.status === "rejected") {
    printRejected(style, sessionId, outcome.workflowState, outcome.rejected, outcome.reply);
    return 1;
  }
  err(style.green(style.bold(`${icons.check} ${verb}`)));
  out(lastAgentText(outcome.messages) || `Session ${sessionId} resumed (state=${outcome.workflowState ?? "?"}).`);
  return 0;
}

export function printReply(style: Style, sessionId: string, outcome: ReplyOutcome): void {
  err("");
  err(style.green(style.bold(`${icons.check} replied`)));
  out(outcome.reply || "(the session had nothing to say)");
  err("");
  err(
    style.yellow(
      `Session ${sessionId} is still parked at the '${outcome.state}' human state — a decision is pending.`,
    ),
  );
}

/** What a park said as it handed over is this turn's result, above the park report. */
function printParkMessage(style: Style, reply: string): void {
  if (!reply) return;
  err("");
  err(style.green(style.bold(`${icons.check} message`)));
  out(reply);
}

export interface RunTurnInput {
  workflow: string;
  prompt: string;
  trigger?: TriggerInput;
  variables?: Record<string, unknown>;
  sessionId?: string;
  sessionPath?: string;
}

/**
 * Report a turn's {@link Outcome}: an answer, a park (with what resumes it), a
 * rejection, or a resume's result. Returns the exit code: a park is a success,
 * a rejection is not.
 */
export function printOutcome(style: Style, machine: WorkflowMachine, sessionId: string, outcome: Outcome): number {
  if (outcome.disposition === "deliver") return printResumed(style, sessionId, "delivered", asDecide(outcome));
  if (outcome.disposition === "reply") {
    printReply(style, sessionId, { ...asDecide(outcome), state: outcome.state ?? "", parkedChannel: "decision" });
    return 0;
  }
  if (outcome.kind === "parked" && outcome.parkedChannel === "input") {
    const waiting = outcome.pending as PendingInput | undefined;
    printParkMessage(style, outcome.reply);
    err("");
    err(style.yellow(style.bold(`${icons.warn} awaiting input`)));
    err(
      `Session ${sessionId} is parked in the '${outcome.state}' state${waiting?.title ? ` (${waiting.title})` : ""} awaiting an external event.`,
    );
    if (waiting?.reason) err(`  waiting for: ${waiting.reason}`);
    if (waiting?.resumeAt) err(`  due:         ${waiting.resumeAt} (whoever schedules the wake-up)`);
    err(deliverHint(sessionId));
    return 0;
  }
  if (outcome.kind === "parked") {
    const pending = outcome.pending as PendingDecision | undefined;
    printParkMessage(style, outcome.reply);
    err("");
    err(style.yellow(style.bold(`${icons.warn} awaiting human decision`)));
    err(
      `Session ${sessionId} is parked at the '${outcome.state}' human state${pending?.title ? ` (${pending.title})` : ""} awaiting a decision.`,
    );
    printDecisionContext(machine, outcome.state ?? "", pending?.transitions ?? [], pending?.evidence, err);
    err(decideHint(sessionId));
    return 0;
  }
  err("");
  if (outcome.kind === "rejected") {
    printRejected(style, sessionId, outcome.state, outcome.rejected, outcome.reply);
    return 1;
  }
  err(style.green(style.bold(`${icons.check} answer`)));
  out(outcome.reply || "(no textual answer)");
  return 0;
}

/** The resume-shaped view of an {@link Outcome}, for the shared resume printers. */
function asDecide(outcome: Outcome): DecideOutcome {
  return {
    status: outcome.status,
    workflowState: outcome.state,
    reparked: outcome.kind === "parked",
    ...(outcome.parkedChannel ? { parkedChannel: outcome.parkedChannel } : {}),
    ...(outcome.kind === "parked" && outcome.state ? { state: outcome.state } : {}),
    reply: outcome.reply,
    ...(outcome.rejected ? { rejected: outcome.rejected } : {}),
    messages: outcome.messages,
    auditTrail: outcome.auditTrail,
  };
}

/**
 * Drive one turn: name the session the firing belongs to, send the turn through
 * `workflow.send` — which delivers, replies or opens a turn as the session's
 * state dictates — and report how it ended. Returns the exit code; a park is a
 * successful outcome, a rejected session a failed one.
 */
export async function driveTurn(agent: Agent, style: Style, usage: UsageTracker, input: RunTurnInput): Promise<number> {
  const workflow = agent.workflow as WorkflowSurface;
  const trigger = { id: workflow.resolveTrigger(input.trigger).id };
  // One id: `--session` names the conversation when the caller has one, else
  // session resolution derives or mints one that *is* this conversation's.
  let sessionId = input.sessionId;
  if (!sessionId) {
    try {
      sessionId = (
        await workflow.resolveSession({
          trigger,
          ...(input.variables ? { variables: input.variables } : {}),
          ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
        })
      ).sessionId;
    } catch (e) {
      // Reported before any model call: nothing is spent on a firing with nowhere to go.
      throw new CliError((e as Error).message);
    }
  }
  try {
    const outcome = await workflow.send(sessionId, {
      message: input.prompt,
      trigger,
      ...(input.variables ? { variables: input.variables } : {}),
      ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
    });
    const code = printOutcome(style, workflow.machine, sessionId, outcome);
    printUsageFooter(style, usage, sessionId);
    return code;
  } catch (e) {
    // A refusal the runtime made before anything was spent is a one-line error.
    if (isKnown(e)) throw new CliError(e.message);
    throw e;
  } finally {
    agent.dispose(sessionId);
  }
}
