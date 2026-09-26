/**
 * The turn boundary: what happens once per invoke, before any model call.
 *
 * A turn boundary resets the turn's mechanics (rejected, iterations,
 * beforeDone, parkCounts, park records and phase, replyOnly, the turn budget)
 * and retains the conversation (position, entryState, variables, transcript,
 * trail, files). Every ingress that begins a turn arrives here; a park
 * resumption re-enters at its own suspension through a `Command` and never
 * crosses this boundary — which is what makes "a disabled machine starts
 * nothing, finishes what it started" a property of the graph's shape.
 */
import { SESSION_ORIGIN, type WorkflowEventEmitter, type WorkflowEventHandler } from "../core/events.js";
import type { Workspace } from "../core/workspace.js";
import type { WorkflowMachine } from "../machine/machine.js";
import { MANUAL_TRIGGER } from "../machine/triggers.js";
import {
  buildSeededVariables,
  TITLE_VARIABLE,
  TRIGGER_VARIABLE,
  type VariableStore,
} from "../machine/variables.js";
import { decisionRecordFor } from "./parks.js";
import { requiresRefusal } from "./signature-checks.js";
import { writeSpecSnapshotIfAbsent } from "./snapshot.js";
import {
  readVariables,
  readWorkflowState,
  reseedAll,
  WORKFLOW_STATUSES,
  type TrailStep,
  type WorkflowUpdate,
} from "./state.js";
import { sessionScopeFrom, seedVariablesFrom } from "../sessions/scope.js";

export interface TurnBoundaryContext {
  machine: WorkflowMachine;
  emit: WorkflowEventEmitter;
  /** The lifecycle event subscriber, for the spec snapshot's own diagnostics. */
  onEvent?: WorkflowEventHandler;
  /** Workspace backend for writing the spec snapshot into the session zone. */
  workspace?: Workspace;
  /** The `workflows/<slug>/` name, used only to name the machine in a refusal. */
  workflowName?: string;
  /** The assembly-time default trigger, used when an invocation supplies none. */
  defaultTrigger?: { id: string };
  /** Host-seeded run variables, applied at each turn boundary (already locked). */
  seededVariables?: VariableStore;
}

/**
 * Open a turn: resolve where it begins, refuse it if the machine cannot serve
 * it, and commit the opening. A refused turn carries `jumpTo: "end"` so no model runs.
 */
export async function openTurn(
  ctx: TurnBoundaryContext,
  state: unknown,
  runtime: { configurable?: Record<string, unknown> } | undefined,
): Promise<WorkflowUpdate> {
  const { machine, emit } = ctx;
  const fields = readWorkflowState(state);
  // The trigger is per invoke, falling back to the assembly's default; its id maps
  // to a declared start state, or the machine's entry when unmatched.
  const trigger = fields.trigger ?? ctx.defaultTrigger ?? { id: MANUAL_TRIGGER };
  const startState = machine.startStateForTrigger(trigger.id) ?? machine.entry;

  // A session's first turn enters the state its trigger declares; every later turn
  // continues where the conversation is. A retained position the current
  // definition no longer declares reopens at the trigger's entry.
  const retained = fields.workflowState;
  const reopening = retained == null || !Object.hasOwn(machine.spec.states, retained);
  const position = reopening ? startState : retained;
  const entryState = fields.entryState ?? position;

  // A refused turn commits `rejected` with a reason rather than throwing, before
  // any event narrates a turn beginning: nothing is entered, no hook runs.
  const refuse = (reason: string, extra: WorkflowUpdate = {}): WorkflowUpdate => {
    emit({ type: "warning", scope: "workflow", message: reason });
    return {
      workflowState: position,
      entryState,
      specHash: machine.specHash,
      status: WORKFLOW_STATUSES.rejected,
      rejected: reason,
      trigger,
      ...extra,
      jumpTo: "end",
    };
  };

  if (machine.disabled) {
    const named = ctx.workflowName ? `workflow '${ctx.workflowName}'` : "this workflow";
    return refuse(`Refusing to start: ${named} is disabled.`);
  }

  // A reset means "opened at an entry state": a first turn, or a reopening on a dropped position.
  if (reopening) emit({ type: "workflow-reset", entry: position });
  // Every turn announces where it begins; the trail records the same arrival below.
  emit({ type: "advance", from: SESSION_ORIGIN, to: position });

  // A definition may change between turns; the snapshot must exist for the recorded hash to mean anything.
  if (fields.specHash !== machine.specHash && ctx.workspace) {
    await writeSpecSnapshotIfAbsent(ctx.workspace, machine.specHash, machine.spec, ctx.onEvent);
  }

  // This turn's opening variables: the host's seeds, this invocation's seeds (a
  // sub-run's params), and the built-in `trigger`, locked. Marked `reseed`: a turn
  // boundary is a host seeding boundary exactly as a delivery is.
  const openingVariables = reseedAll({
    ...(ctx.seededVariables ?? {}),
    ...buildSeededVariables(seedVariablesFrom(runtime?.configurable), "supplied to a sub-workflow"),
    [TRIGGER_VARIABLE]: { value: trigger.id, locked: true },
  });
  // A seeded `title` is an opening label: it loses to a title the session already
  // holds, so the agent's refinement survives the next turn.
  if (
    openingVariables[TITLE_VARIABLE] !== undefined &&
    readVariables(state)[TITLE_VARIABLE] !== undefined
  ) {
    delete openingVariables[TITLE_VARIABLE];
  }
  const seededTitle = openingVariables[TITLE_VARIABLE]?.value;
  if (typeof seededTitle === "string") emit({ type: "title-set", title: seededTitle });

  // The entry half of the trigger's signature: a run that cannot satisfy its own contract reaches no model.
  const refusal = requiresRefusal(machine, trigger.id, openingVariables);
  if (refusal) return refuse(refusal, { variables: openingVariables });

  emit({ type: "state-enter", state: position });
  // A turn opened on a session parked at a human state presents the decision
  // again on a fresh record: the run owes the person a closing message, then
  // suspends where it stood.
  let reparked: WorkflowUpdate = {};
  if (machine.isHumanState(position)) {
    const seq = (fields.decisionCount ?? 0) + 1;
    emit({ type: "parked", state: position, sessionId: sessionScopeFrom(runtime).sessionId, awaiting: "decision" });
    reparked = {
      pendingDecision: decisionRecordFor(machine, position, seq),
      decisionCount: seq,
      status: WORKFLOW_STATUSES.awaitingDecision,
      parkPhase: "closing",
    };
  }
  return {
    workflowState: position,
    rejected: null,
    iterations: {},
    beforeDone: {},
    parkCounts: {},
    // A new turn is not a resumed park: every park channel is cleared, and a
    // delegated child suspended on its own human state is abandoned by the turn
    // that supersedes it — an orphaned child beats a caller wedged on an interrupt.
    pendingInput: null,
    pendingDecision: null,
    pendingDelegations: null,
    parkPhase: null,
    replyOnly: null,
    stateTurns: null,
    // Where this session began: recorded once, so the reset tool has a fixed target.
    entryState,
    specHash: machine.specHash,
    status: WORKFLOW_STATUSES.running,
    trigger,
    variables: openingVariables,
    auditTrail: [{ to: position, kind: "trigger", reason: trigger.id, ts: Date.now() } satisfies TrailStep],
    ...reparked,
  };
}

