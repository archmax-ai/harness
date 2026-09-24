/**
 * Parks: how a session suspends for a person or an event, and how it resumes.
 *
 * A park has three moments, each in a different graph node so a process that
 * dies between two of them sees a parked session rather than a lost one:
 *
 *  1. **Commit.** The record is written — by the tool seam (`archmax_advance`
 *     into a human state, `archmax_wait`, a delegated child's suspension) or by a
 *     hook — with `parkPhase: "closing"`.
 *  2. **Close.** The run owes the person one tool-free message: `servePark` sets
 *     `replyOnly` and moves the phase to `suspend`; the model speaks; the hook
 *     after it marks the reply spent.
 *  3. **Suspend.** The next hook site holding a record in phase `suspend` with
 *     nothing owed calls `interrupt(record)`. Nothing else happens in that node
 *     before the interrupt, so its re-execution on resume repeats no side effect.
 *
 * Resuming is `applyResume`: a decision routes, a message is answered (and the
 * session suspends again on the same record), a delivered firing continues the
 * parked state. All three are told apart structurally, never by reading words.
 */
import { HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { interrupt, isGraphInterrupt } from "@langchain/langgraph";
import type { WorkflowEventEmitter } from "../core/events.js";
import {
  contentToString,
  isAiMessage,
  isHumanMessage,
  isRuntimeNote,
  lastMessageIsHuman,
  runtimeNote,
} from "../core/messages.js";
import { isMessageResume, type DecisionResolution, type TriggerDelivery } from "../sessions/resume.js";
import type { WorkflowMachine } from "../machine/machine.js";
import {
  normalizeTitle,
  TITLE_VARIABLE,
  titleWriteError,
  TRIGGER_VARIABLE,
  type VariableStore,
} from "../machine/variables.js";
import type { HookSite } from "./on-error.js";
import {
  currentWorkflowState,
  isReplyOnly,
  parkedStateOf,
  pendingParkOf,
  readWorkflowState,
  WORKFLOW_STATUSES,
  type PendingDecision,
  type PendingDelegation,
  type PendingInput,
  type TrailStep,
  type WorkflowUpdate,
  isDecisionPark,
} from "./state.js";
import { SubWorkflowError, subWorkflowParkOf, type SubWorkflowDispatcher } from "./sub-workflow.js";

// --- Records ------------------------------------------------------------------

/**
 * The pending-decision record for a human state: its declared transitions and
 * evidence (the author's list leads and is never displaced), plus whatever the
 * transition attached, duplicates removed keeping first position.
 */
export function decisionRecordFor(
  machine: WorkflowMachine,
  state: string,
  seq: number,
  attached: readonly string[] = [],
): PendingDecision {
  const declared = machine.spec.states[state];
  const evidence: string[] = [];
  for (const path of [...(declared?.evidence ?? []), ...attached]) {
    if (path && !evidence.includes(path)) evidence.push(path);
  }
  const title = declared?.title?.trim();
  return {
    state,
    ...(title ? { title } : {}),
    seq,
    transitions: (declared?.transitions ?? []).map((t) => ({
      to: t.to,
      ...(t.description ? { description: t.description } : {}),
      ...(t.type ? { type: t.type } : {}),
    })),
    ...(evidence.length ? { evidence } : {}),
    createdAt: new Date().toISOString(),
  };
}

/** The pending-input record for a state the agent parked with `archmax_wait`. */
export function inputRecordFor(
  machine: WorkflowMachine,
  state: string,
  reason: string,
  resumeAt?: string,
): PendingInput {
  const title = machine.spec.states[state]?.title?.trim();
  return {
    state,
    ...(title ? { title } : {}),
    reason,
    parkedAt: new Date().toISOString(),
    ...(resumeAt ? { resumeAt } : {}),
  };
}

// --- Reply-only turns ---------------------------------------------------------

/** Whether a reply-only turn still owes its one model call: the flag is set and the last message is what the run was told. */
function replyOwed(state: unknown): boolean {
  return isReplyOnly(state) && lastMessageIsHuman(messagesOf(state));
}

function messagesOf(state: unknown): unknown[] {
  return (state as { messages?: unknown[] })?.messages ?? [];
}

/** How the state in front of the model is labelled: its title when it has one. */
function stateLabel(machine: WorkflowMachine, slug: string): string {
  const title = machine.spec.states[slug]?.title?.trim();
  return title ? `'${slug}' (${title})` : `'${slug}'`;
}

/** Whether a message was typed by a person, as opposed to written by the runtime. */
function isPersonsMessage(message: unknown): boolean {
  return message !== undefined && isHumanMessage(message) && !isRuntimeNote(message);
}

/**
 * What a reply-only turn is told. Four shapes of park reach this — handing the
 * run to a person, being routed to one by a decision, waiting for something
 * from outside, and answering someone while a person decides — each with its
 * own first sentence. The last paragraph is the same in all: it is what stands
 * between a parked run and a model that would rather keep working.
 */
export function replyOnlyDirective(machine: WorkflowMachine, state: unknown): string {
  const fields = readWorkflowState(state);
  const messages = messagesOf(state);
  const position = currentWorkflowState(state, machine.entry);
  const last = messages[messages.length - 1];
  let opening: string;
  if (isPersonsMessage(last)) {
    opening =
      `This run is parked at the ${stateLabel(machine, position)} checkpoint and a person ` +
      `is deciding what happens next. Answer the message in front of you from what the ` +
      `conversation already shows: what has been done, and that the decision is with them. ` +
      `You cannot make that decision, predict it, or announce it.`;
  } else if (fields.pendingInput) {
    opening =
      `You have parked this run: it stays in ${stateLabel(machine, position)} until ` +
      `something arrives from outside (${fields.pendingInput.reason}). Tell whoever you are ` +
      `talking to what you have done and what you are waiting for.`;
  } else if (isRuntimeNote(last)) {
    opening =
      `A decision has routed this run to ${stateLabel(machine, position)}, which is now ` +
      `waiting for a person's decision. Tell whoever you are talking to where the run stands ` +
      `and that it is with a reviewer — do not promise what they will decide.`;
  } else {
    const parkedAt = parkedStateOf(fields.pendingDecision) || position;
    opening =
      `You have just handed this run to a person: ${stateLabel(machine, parkedAt)} is now ` +
      `waiting for their decision, and your own work here is finished. Tell whoever you are ` +
      `talking to what you did and that it is now with a reviewer — do not promise what they ` +
      `will decide.`;
  }
  return (
    `${opening}\n\n` +
    `Write one short message to them, in your own voice, and nothing else. This turn has no ` +
    `tools: you cannot read, write, move the run, or do any further work, and the run does not ` +
    `continue when you finish — it stays parked until someone else acts.`
  );
}

// --- Serving a park ------------------------------------------------------------

export interface ParkContext {
  machine: WorkflowMachine;
  emit: WorkflowEventEmitter;
  /** Resumes a parked child; absent in an assembly that cannot run sub-workflows. */
  dispatcher?: SubWorkflowDispatcher;
  /** The session a hook is executing for, read from its runtime. */
  sessionIdOf(runtime: unknown): string;
  /** The runnable config a hook's runtime stands for, for a child's resume. */
  configOf(runtime: unknown): RunnableConfig;
}

/** Whether the last message is an AI message still carrying tool calls the tools node must answer. */
function lastReplyCallsTools(messages: unknown[]): boolean {
  const last = messages[messages.length - 1] as { tool_calls?: unknown[] } | undefined;
  return last !== undefined && isAiMessage(last) && Array.isArray(last.tool_calls) && last.tool_calls.length > 0;
}

/** The update that starts a closing turn: one reply-only model call, after which the next hook site suspends. */
function closingTurn(): WorkflowUpdate {
  return { parkPhase: "suspend", replyOnly: true };
}

/**
 * Move a park along, deterministically on state. Before the model: a record in
 * phase `closing` gets its closing turn; a delegated child that parked becomes
 * the pending decision and gets its closing turn. After the model: a reply-only
 * turn that just spoke is spent, and an answer to a person's message is reported.
 */
export function servePark(ctx: ParkContext, state: unknown, runtime: unknown, site: HookSite): WorkflowUpdate | undefined {
  const fields = readWorkflowState(state);
  const messages = messagesOf(state);
  const park = pendingParkOf(state);

  if (site === "before-model") {
    if (!park) {
      const queue = fields.pendingDelegations ?? [];
      if (queue.length === 0) return undefined;
      return presentDelegation(ctx, state, runtime, queue[0]!);
    }
    return fields.parkPhase === "closing" ? closingTurn() : undefined;
  }

  if (!park || !isReplyOnly(state)) return undefined;
  const last = messages[messages.length - 1] as { content?: unknown } | undefined;
  // A reply-only turn that called tools instead is not spent yet: the tools node
  // refuses the calls, and the hook after it suspends.
  if (!last || !isAiMessage(last) || lastReplyCallsTools(messages)) return undefined;
  if (isPersonsMessage(messages[messages.length - 2])) {
    const text = contentToString(last.content).trim();
    if (text) {
      const position = currentWorkflowState(state, ctx.machine.entry);
      ctx.emit({
        type: "park-message",
        state: position,
        sessionId: ctx.sessionIdOf(runtime),
        direction: "outbound",
        text,
      });
    }
  }
  return { replyOnly: null, parkPhase: "suspend" };
}

/**
 * Present the head of the delegation queue as the session's pending decision —
 * the child's decision unchanged, since that is what the person is asked. Not
 * counted against `maxParks`: nothing the calling agent did caused this.
 */
function presentDelegation(
  ctx: ParkContext,
  state: unknown,
  runtime: unknown,
  head: PendingDelegation,
): WorkflowUpdate {
  const fields = readWorkflowState(state);
  const position = currentWorkflowState(state, ctx.machine.entry);
  const sessionId = ctx.sessionIdOf(runtime);

  // The channel has to be the one the child asked for. A child that called
  // `archmax_wait` is waiting for an event, so presenting it as a decision would
  // leave a park with no transitions to choose and nothing able to resume it.
  if (!isDecisionPark(head.decision)) {
    ctx.emit({ type: "parked", state: position, sessionId, awaiting: "input" });
    return {
      pendingInput: head.decision,
      status: WORKFLOW_STATUSES.awaitingInput,
      rejected: null,
      ...closingTurn(),
    };
  }

  const seq = (fields.decisionCount ?? 0) + 1;
  ctx.emit({ type: "parked", state: position, sessionId, awaiting: "decision" });
  return {
    pendingDecision: { ...head.decision, seq },
    decisionCount: seq,
    status: WORKFLOW_STATUSES.awaitingDecision,
    rejected: null,
    ...closingTurn(),
  };
}

/**
 * The suspension site: with a record in phase `suspend` and nothing owed, park
 * the session on it. `interrupt()` throws on first arrival — the session parks
 * durably — and on resume returns what a surface resumed with, which
 * {@link applyResume} turns into the run's continuation.
 */
export async function suspendIfParked(
  ctx: ParkContext,
  state: unknown,
  runtime: unknown,
  site: HookSite,
): Promise<WorkflowUpdate | undefined> {
  const park = pendingParkOf(state);
  if (!park || readWorkflowState(state).parkPhase !== "suspend") return undefined;
  if (replyOwed(state)) return undefined;
  // Tool calls left unanswered would dangle across the park; the tools node
  // answers (refuses) them first and the hook after it suspends.
  if (lastReplyCallsTools(messagesOf(state))) return undefined;
  const resume = interrupt(park.record) as unknown;
  return applyResume(ctx, state, runtime, resume, site);
}

// --- Resuming -------------------------------------------------------------------

function isTriggerDelivery(resume: unknown): resume is TriggerDelivery {
  const trigger = (resume as TriggerDelivery | undefined)?.trigger;
  return trigger != null && typeof trigger === "object" && typeof trigger.id === "string";
}

/** `jumpTo: "model"` where the loop would otherwise exit — after the model. */
function continueToModel(site: HookSite): Pick<WorkflowUpdate, "jumpTo"> {
  return site === "after-model" ? { jumpTo: "model" } : {};
}

/**
 * Turn what a surface resumed with into the run's continuation: a **message** is
 * recorded as a person's and answered on a reply-only turn (the record stays and
 * the session suspends again); a **delivery** seeds the firing's variables and
 * continues the parked state; a **decision** routes — or, for a delegated park,
 * is handed to the child that asked.
 */
async function applyResume(
  ctx: ParkContext,
  state: unknown,
  runtime: unknown,
  resume: unknown,
  site: HookSite,
): Promise<WorkflowUpdate> {
  const pending = readWorkflowState(state).pendingDelegations ?? [];

  // A delivery is told apart first: it may carry the person's message with the
  // firing, and a message alone is what a reply is. When a delegation is pending
  // the firing belongs to the child that asked for it — routed here, because the
  // parent's own delivery path would resume the parent and leave the child
  // waiting forever.
  if (isTriggerDelivery(resume)) {
    return pending.length > 0
      ? resumeDelegated(ctx, state, runtime, resume, pending, site)
      : applyDelivery(ctx, state, runtime, resume, site);
  }

  if (isMessageResume(resume)) {
    const position = currentWorkflowState(state, ctx.machine.entry);
    const text = resume.message.trim();
    ctx.emit({
      type: "park-message",
      state: position,
      sessionId: ctx.sessionIdOf(runtime),
      direction: "inbound",
      text,
    });
    // A plain `HumanMessage`, the only runtime-appended one: a person wrote this.
    return {
      messages: [new HumanMessage(text)],
      replyOnly: true,
      parkPhase: "suspend",
      ...continueToModel(site),
    };
  }

  // A decision routes, and a delegated park hands it to the child that asked. A
  // message never reaches here: it is answered by the parent above, parked or
  // delegated alike.
  if (pending.length > 0) return resumeDelegated(ctx, state, runtime, resume, pending, site);
  return applyDecision(ctx, state, runtime, resume as DecisionResolution, site);
}

/** A person picked an edge at the run's own human state. */
function applyDecision(
  ctx: ParkContext,
  state: unknown,
  runtime: unknown,
  decision: DecisionResolution,
  site: HookSite,
): WorkflowUpdate {
  const { machine } = ctx;
  const fields = readWorkflowState(state);
  const from = currentWorkflowState(state, machine.entry);
  const sessionId = ctx.sessionIdOf(runtime);
  const target = (decision?.target ?? "").trim();
  const comment = (decision?.comment ?? "").trim();
  const advanced = target !== from && machine.transitionTargets(from).includes(target);
  const chosen = fields.pendingDecision?.transitions.find((t) => t.to === target);
  const humanStep: TrailStep = {
    to: advanced ? target : from,
    kind: "human",
    ...(comment ? { reason: comment } : {}),
    ts: Date.now(),
  };

  ctx.emit({ type: "decided", state: from, to: advanced ? target : "__end__", sessionId });

  if (!advanced) {
    // No declared edge was selected (the decision surface refuses this, but a
    // checkpoint may predate it): the run ends rather than loops, decision on the trail.
    return {
      pendingDecision: null,
      status: WORKFLOW_STATUSES.completed,
      parkPhase: null,
      replyOnly: null,
      auditTrail: [humanStep],
      ...(site === "before-model" ? { jumpTo: "end" } : {}),
    };
  }

  // This note is the only thing the target state reads about how it got here.
  const label = chosen?.type && chosen.type !== "none" ? `${chosen.type} → '${target}'` : `'${target}'`;
  const note = runtimeNote(
    "decision",
    `[decision] A human selected ${label} at the '${from}' checkpoint` +
      (comment ? `: ${comment}.` : ".") +
      ` The run has already been routed: you are now in '${target}'. Do its work and ` +
      `continue from here.`,
  );
  ctx.emit({ type: "state-leave", state: from, next: target });
  ctx.emit({ type: "state-enter", state: target });

  // Corrections are carried across unchanged: a person choosing `refine` again is
  // judgment at human pace, not the runaway a correction budget exists to stop.
  const routed: WorkflowUpdate = {
    messages: note,
    workflowState: target,
    pendingDecision: null,
    status: WORKFLOW_STATUSES.running,
    replyOnly: null,
    parkPhase: null,
    stateTurns: null,
    rejected: null,
    auditTrail: [humanStep],
    ...continueToModel(site),
  };

  // Routed straight into another human state: present it. The run owes the person
  // a closing message first — the one model call that reaches the next hook site.
  if (machine.isHumanState(target)) {
    const seq = (fields.decisionCount ?? 0) + 1;
    ctx.emit({ type: "parked", state: target, sessionId, awaiting: "decision" });
    return {
      ...routed,
      pendingDecision: decisionRecordFor(machine, target, seq),
      decisionCount: seq,
      status: WORKFLOW_STATUSES.awaitingDecision,
      ...closingTurn(),
    };
  }
  return routed;
}

/**
 * A person decided at a delegated child's human state: hand the decision to that
 * child and record what it answered. A child that parks again is re-presented
 * on the spot; a sibling still waiting is presented next; otherwise the calling
 * state continues.
 */
async function resumeDelegated(
  ctx: ParkContext,
  state: unknown,
  runtime: unknown,
  resume: unknown,
  delegations: PendingDelegation[],
  site: HookSite,
): Promise<WorkflowUpdate> {
  const fields = readWorkflowState(state);
  const from = currentWorkflowState(state, ctx.machine.entry);
  const sessionId = ctx.sessionIdOf(runtime);
  const [head, ...rest] = delegations as [PendingDelegation, ...PendingDelegation[]];
  // Only a decision routes; a delivery hands the child its firing and the parent
  // records nothing to have decided.
  if (isDecisionPark(head.decision)) {
    const decision = resume as DecisionResolution;
    ctx.emit({ type: "decided", state: from, to: decision?.target ?? "", sessionId });
  }

  const present = (next: PendingDelegation, remaining: PendingDelegation[], committed: WorkflowUpdate) => {
    if (!isDecisionPark(next.decision)) {
      ctx.emit({ type: "parked", state: from, sessionId, awaiting: "input" });
      return {
        ...committed,
        pendingDelegations: { remaining },
        pendingInput: next.decision,
        status: WORKFLOW_STATUSES.awaitingInput,
        ...closingTurn(),
        ...continueToModel(site),
      } satisfies WorkflowUpdate;
    }
    const seq = (fields.decisionCount ?? 0) + 1;
    ctx.emit({ type: "parked", state: from, sessionId, awaiting: "decision" });
    return {
      ...committed,
      pendingDelegations: { remaining },
      pendingDecision: { ...next.decision, seq },
      decisionCount: seq,
      status: WORKFLOW_STATUSES.awaitingDecision,
      ...closingTurn(),
      ...continueToModel(site),
    } satisfies WorkflowUpdate;
  };

  let text: string;
  let status: "ok" | "error" = "ok";
  try {
    if (!ctx.dispatcher) {
      throw new SubWorkflowError(
        "error",
        head.workflow,
        `Cannot resume sub-workflow '${head.workflow}': this assembly cannot run ` +
          `sub-workflows (no dispatcher is wired).`,
      );
    }
    const result = await ctx.dispatcher.resume({
      workflow: head.workflow,
      identity: head.identity,
      dispatchId: head.dispatchId,
      config: ctx.configOf(runtime),
      resume,
      state: from,
    });
    text = `[sub-workflow: ${result.workflow}] ${result.result}`;
  } catch (err) {
    // Parked again — a second decision inside the same child, re-presented on the spot.
    const reparked = subWorkflowParkOf(err);
    if (reparked) {
      const reentry = { ...head, decision: reparked.decision as PendingDelegation["decision"] };
      return present(reentry, [reentry, ...rest], {});
    }
    if (isGraphInterrupt(err)) throw err;
    status = "error";
    text =
      `[error] sub-workflow '${head.workflow}' failed after the decision: ` +
      `${(err as Error)?.message ?? String(err)}`;
  }

  // The child's answer is a transcript fact: its tool call was answered when the run parked.
  const committed: WorkflowUpdate = {
    messages: runtimeNote(status === "ok" ? "sub-workflow" : "error", text),
    auditTrail: [
      { to: from, kind: "sub-workflow", workflow: head.workflow, status, ts: Date.now() } satisfies TrailStep,
    ],
  };
  if (rest.length > 0) return present(rest[0]!, rest, committed);
  return {
    ...committed,
    pendingDelegations: null,
    pendingDecision: null,
    pendingInput: null,
    status: WORKFLOW_STATUSES.running,
    parkPhase: null,
    replyOnly: null,
    ...continueToModel(site),
  };
}

/**
 * A firing delivered into a wait park: the firing's variables as locked host
 * seeds, the arrival in the transcript and on the trail, the delivered id as the
 * run's current trigger — and the parked state continues in place. An id-less
 * firing is accepted: the delivery surface validated the park, and refusing a
 * resume the host committed to would leave the run parked forever.
 */
function applyDelivery(
  ctx: ParkContext,
  state: unknown,
  runtime: unknown,
  delivery: TriggerDelivery,
  site: HookSite,
): WorkflowUpdate {
  const slug = currentWorkflowState(state, ctx.machine.entry);
  const sessionId = ctx.sessionIdOf(runtime);
  const deliveredId = (delivery.trigger?.id ?? "").trim();
  ctx.emit({ type: "delivered", state: slug, trigger: deliveredId, to: slug, sessionId });

  // Host seeds at a delivery boundary: locked, and marked `reseed` so a repeat
  // park/deliver cycle can re-establish the same name. Only this path and the
  // turn boundary set that marker, so no agent-reachable write bypasses a lock.
  const delivered: VariableStore = {};
  for (const [name, value] of Object.entries(delivery.variables ?? {})) {
    // `title` is never locked. A malformed one is warned and skipped rather than
    // thrown: dropping a whole resume over a bad label is the worse failure.
    if (name === TITLE_VARIABLE) {
      const problem = titleWriteError(value);
      if (problem) {
        ctx.emit({ type: "warning", scope: "workflow", message: `Delivered title ignored: ${problem}` });
        continue;
      }
      delivered[name] = { value: normalizeTitle(value as string), locked: false, reseed: true };
      continue;
    }
    delivered[name] = { value, locked: true, reseed: true };
  }
  const names = Object.keys(delivered);
  if (names.length > 0) {
    ctx.emit({ type: "variables-set", state: slug, names, locked: true });
    const title = delivered[TITLE_VARIABLE]?.value;
    if (typeof title === "string") ctx.emit({ type: "title-set", title, state: slug });
  }
  // The delivered firing is the resumed turn's cause (`args.trigger`, `${{trigger}}`); `entryState` is untouched.
  delivered[TRIGGER_VARIABLE] = { value: deliveredId, locked: true, reseed: true };

  // The arrival in the transcript, the way a decision is recorded: the resumed state has to see what arrived.
  const summary = Object.entries(delivery.variables ?? {})
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join(", ");
  const detail = summary ? `: ${summary} (also readable as run variables)` : ".";
  // A person's message that came with the firing: the one runtime-appended
  // human message besides a reply, written in the same update as the arrival so
  // the two cannot be split by a crash or land on a park that is gone.
  const said = (delivery.message ?? "").trim();
  if (said) {
    ctx.emit({ type: "park-message", state: slug, sessionId, direction: "inbound", text: said });
  }
  ctx.emit({ type: "state-enter", state: slug });
  return {
    messages: [
      ...runtimeNote(
        "event",
        `[event] '${deliveredId}' arrived while the run waited in '${slug}'${detail} ` +
          `You are still in '${slug}'; continue from here.` +
          (said ? " The person's message that came with it follows." : ""),
      ),
      ...(said ? [new HumanMessage(said)] : []),
    ],
    variables: delivered,
    trigger: { id: deliveredId },
    pendingInput: null,
    status: WORKFLOW_STATUSES.running,
    parkPhase: null,
    replyOnly: null,
    rejected: null,
    auditTrail: [{ to: slug, kind: "trigger", reason: deliveredId, ts: Date.now() } satisfies TrailStep],
    ...continueToModel(site),
  };
}
