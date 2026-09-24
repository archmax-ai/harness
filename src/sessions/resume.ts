/**
 * Resuming a parked session — the one path behind `decide`, `reply` and
 * `deliver`, and the `Outcome` every way of entering a session settles to.
 *
 * A park is two facts: the checkpointed status and a live suspension. Every
 * resume reads both, validates its payload **before** the graph is touched (a
 * rejected resume leaves the park untouched), hands the payload to the suspended
 * `interrupt()` through `Command({ resume })`, and reads the settled state off
 * the invoke result — the same shape a turn produces.
 */
import { Command } from "@langchain/langgraph";
import { mergeConfigs, type RunnableConfig } from "@langchain/core/runnables";
import type { IntrospectableStateGraph } from "../core/deepagents.js";
import { lastAgentText } from "../core/messages.js";
import { hasUsage, type UsageSummary } from "../core/usage.js";
import {
  InvalidVariableNameError,
  VARIABLE_NAME_PATTERN,
  type VariableStore,
} from "../machine/variables.js";
import {
  parkedStateOf,
  readAuditTrail,
  readRunUsage,
  readVariables,
  WORKFLOW_STATUSES,
  type ParkChannel,
  type PendingDecision,
  type PendingDelegation,
  type PendingInput,
  type TrailStep,
  type WorkflowStatus,
} from "../workflow/state.js";
import { childSessionId } from "./scope.js";

export type { IntrospectableStateGraph };

// --- Payloads ------------------------------------------------------------------

/** The value a decision resumes a session parked at a human state with. */
export interface DecisionResolution {
  /**
   * The state the person selected to route to — one of the parked state's
   * declared transition targets. The person picks the edge; no model interprets
   * the choice.
   */
  target: string;
  /** Optional free-form comment explaining the choice; recorded and passed on. */
  comment?: string;
}

/**
 * The value a reply resumes a parked session with: something the person said
 * while a decision is pending. Answered, never acted on — the session stays
 * parked at the same state, and only a {@link DecisionResolution} moves it.
 */
export interface MessageResolution {
  message: string;
}

/**
 * Whether a resume payload is a message rather than a decision or a delivery.
 * Told apart **structurally** — a `target` routes, a `trigger` is delivered (and
 * may carry a message with it), a `message` alone is answered — never by reading
 * the words: "yes, approve it" typed into the chat is not a decision.
 */
export function isMessageResume(resume: unknown): resume is MessageResolution {
  const payload = resume as (MessageResolution & { trigger?: unknown }) | undefined;
  if (payload?.trigger !== undefined && payload.trigger !== null) return false;
  const message = payload?.message;
  return typeof message === "string" && message.trim() !== "";
}

/**
 * A firing delivered into a parked session: the trigger id the session adopts as
 * its current one, plus the variables the event carried. Nothing is routed by
 * the id: the session continues in the state it parked in.
 */
export interface TriggerDelivery {
  trigger: { id: string };
  variables?: Record<string, unknown>;
  /**
   * What a person said with the firing — a chat message that arrived while the
   * session waited. Appended to the transcript as the person's own message in
   * the same resume that delivers the firing, so it can neither land on a session
   * whose park is gone nor be separated from the arrival by a crash between two
   * writes. Blank is the same as absent.
   */
  message?: string;
}

/**
 * The three ways a parked session resumes: a person decides, a person replies,
 * the host delivers — one union, so `send()` takes one argument shape.
 */
export type ResumePayload =
  | { decision: DecisionResolution }
  | { message: string }
  | { delivery: TriggerDelivery };

// --- Errors --------------------------------------------------------------------

/** Thrown when a decision or reply targets a session that is not parked at a human state. */
export class SessionNotParkedError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session '${sessionId}' is not parked at a human state; there is nothing to decide.`);
    this.name = "SessionNotParkedError";
  }
}

/** Thrown when a decision names a target that is not one of the parked state's transitions. */
export class InvalidDecisionTargetError extends Error {
  constructor(
    readonly sessionId: string,
    readonly target: string | undefined,
    readonly validTargets: string[],
  ) {
    super(
      (target
        ? `'${target}' is not a valid decision target for session '${sessionId}'. `
        : `A decision target is required for session '${sessionId}'. `) +
        `Choose one of: ${validTargets.join(", ")}.`,
    );
    this.name = "InvalidDecisionTargetError";
  }
}

/** Thrown when a reply is sent to a parked session without any content. */
export class EmptyMessageError extends Error {
  constructor(readonly sessionId: string) {
    super(
      `A message is required to reply to session '${sessionId}': there is nothing to answer, and ` +
        `a parked session is not moved by an empty turn.`,
    );
    this.name = "EmptyMessageError";
  }
}

/** Thrown when a delivery targets a session that is not parked awaiting input. */
export class SessionNotAwaitingInputError extends Error {
  constructor(readonly sessionId: string) {
    super(
      `Session '${sessionId}' is not parked awaiting an event; there is nothing to deliver to. ` +
        `A session awaiting a human decision resumes through a decision instead.`,
    );
    this.name = "SessionNotAwaitingInputError";
  }
}

/** Thrown when a delivery carries no trigger id to record as the session's current one. */
export class MissingDeliveryTriggerError extends Error {
  constructor(readonly sessionId: string) {
    super(
      `A trigger id is required to deliver to session '${sessionId}': it becomes the session's ` +
        `current trigger, which its hooks and guards read. Any id is accepted — a park ` +
        `awaits no particular one.`,
    );
    this.name = "MissingDeliveryTriggerError";
  }
}

// --- Outcomes ------------------------------------------------------------------

/**
 * The child a parked session's pending decision belongs to. When a delegated
 * child parks at its own human state, the calling session parks with it and
 * presents the child's decision as its own; this says so, and names the child.
 * A decision on the parent (`decide`, `send({ decision })`) is handed to that
 * child — the caller addresses the parent session throughout.
 */
export interface DelegatedPark {
  /** The child workflow's slug. */
  workflow: string;
  /** The child's own session id (`<parent>~<identity>`), when the parent's id was known to the reader. */
  sessionId?: string;
  /** The dispatch identity the child's session id derives from: `<state>:<workflow>:<ordinal>`. */
  identity: string;
  /** The dispatch this park belongs to, as the `sub-workflow-*` events name it. */
  dispatchId: string;
  /** The tool call in the parent's transcript the child answers. */
  toolCallId: string;
  /** The parent state that made the call — where the parent parks, and resumes. */
  state: string;
}

/** Outcome of resuming a session parked at a human state with a decision. */
export interface DecideOutcome {
  /** Session status after the resume settled (`running`, `completed`, …). */
  status?: WorkflowStatus;
  /** Workflow state the session landed in after resuming. */
  workflowState?: string;
  /**
   * Whether the session parked again, on **either** channel: a decision can
   * route into another human state or into a state that then waits for an event.
   */
  reparked: boolean;
  /** Which channel it re-parked on, when it did. Pairs with {@link state}. */
  parkedChannel?: ParkChannel;
  /** The state the session re-parked at — a human state or a waiting state. */
  state?: string;
  /** Present when the pending decision is a delegated child's, not this session's own. */
  delegation?: DelegatedPark;
  /** What the session last said to the person — a finished turn's answer, or a park's message. Empty when it said nothing. */
  reply: string;
  /** Full message history after the resume, for building a session view. */
  messages: unknown[];
  /** The session's full committed audit trail after the resume settled. */
  auditTrail: TrailStep[];
}

/**
 * Outcome of replying to a session parked at a human state. Always a re-park at
 * the same state: a message is answered, never acted on.
 */
export interface ReplyOutcome extends DecideOutcome {
  /** The state the session is (still) parked at. */
  state: string;
  /** Always `decision`: a message is answered where a person still holds the session. */
  parkedChannel: ParkChannel;
}

/** What a delivery produced: a decision's shape plus the variables it seeded. */
export interface DeliverOutcome extends DecideOutcome {
  /** The session's variables after the delivery seeded its own. */
  variables: VariableStore;
  /** Which channel the session re-parked in, when it did. */
  parkedChannel?: ParkChannel;
}

/** Everything any resume settles to — the union of the three outcomes above. */
export interface ResumeOutcome extends DecideOutcome {
  variables: VariableStore;
  /** The park record a re-parked session presents, when it re-parked. */
  pending?: PendingDecision | PendingInput;
  /** Cumulative usage from the checkpoint, when anything was spent. */
  usage?: UsageSummary;
}

/** How `send()` entered the session. */
export type SendDisposition = "turn" | "decide" | "reply" | "deliver";

/**
 * What one `send()` on a session produced, whichever way it entered: a turn, a
 * decision, a reply or a delivery. One shape for a host and the CLI.
 */
export interface Outcome {
  /** Completed, parked (on either channel), or rejected by governance. */
  kind: "completed" | "parked" | "rejected";
  /** How the session was entered. */
  disposition: SendDisposition;
  /** Session status after the turn settled. */
  status?: WorkflowStatus;
  /** The state the session is in — for a park, the state it is parked at. */
  state?: string;
  /** Which channel a parked session awaits. */
  parkedChannel?: ParkChannel;
  /** The park record a parked session presents: what a person or a host needs to resume it. */
  pending?: PendingDecision | PendingInput;
  /**
   * When `kind` is `parked` on the `decision` channel because a **delegated
   * child** parked: which child, and which call. Absent for the session's own
   * park. A host reads this instead of folding `sub-workflow-*` events or
   * shape-testing the child's interrupt.
   */
  delegation?: DelegatedPark;
  /** What the session last said to the person. Empty when it said nothing. */
  reply: string;
  /** Full message history after the turn. */
  messages: unknown[];
  /** The session's committed audit trail. */
  auditTrail: TrailStep[];
  /** The session's variables, keyed by name. */
  variables: VariableStore;
  /** Cumulative usage from the checkpoint, when anything was spent. */
  usage?: UsageSummary;
}

// --- Reading parked state ------------------------------------------------------

/**
 * Read a session that must be parked in `status`, or `null`. "Parked" is two
 * conditions — the checkpointed status *and* a pending interrupt — so every
 * resume asks it here.
 */
export async function readParkedSession(
  graph: IntrospectableStateGraph,
  sessionId: string,
  status: string,
): Promise<Record<string, unknown> | null> {
  const snapshot = await graph.getState({ configurable: { thread_id: sessionId } });
  const values = (snapshot?.values ?? {}) as Record<string, unknown>;
  const suspensions = (snapshot?.tasks ?? []).flatMap((t) => t.interrupts ?? []);
  if (suspensions.length === 0) return null;
  return values.status === status ? values : null;
}

/** The park a settled state presents, on whichever channel, or nothing. */
function parkOf(
  values: Record<string, unknown>,
): { channel: ParkChannel; pending: PendingDecision | PendingInput } | undefined {
  const deciding = values.pendingDecision as PendingDecision | null | undefined;
  const waiting = values.pendingInput as PendingInput | null | undefined;
  if (values.status === WORKFLOW_STATUSES.awaitingDecision && deciding) {
    return { channel: "decision", pending: deciding };
  }
  if (values.status === WORKFLOW_STATUSES.awaitingInput && waiting) {
    return { channel: "input", pending: waiting };
  }
  return undefined;
}

/**
 * The delegated child a decision park belongs to, read from the head of the
 * `pendingDelegations` queue — the record the runtime presents as the session's
 * pending decision. Only a decision park can be delegated; a wait park is always
 * the session's own.
 */
function delegationOf(
  values: Record<string, unknown>,
  channel: ParkChannel | undefined,
  sessionId: string | undefined,
): DelegatedPark | undefined {
  if (channel !== "decision") return undefined;
  const queue = values.pendingDelegations;
  const head = Array.isArray(queue) ? (queue[0] as PendingDelegation | undefined) : undefined;
  if (!head) return undefined;
  return {
    workflow: head.workflow,
    ...(sessionId ? { sessionId: childSessionId(sessionId, head.identity) } : {}),
    identity: head.identity,
    dispatchId: head.dispatchId,
    toolCallId: head.toolCallId,
    state: parkedStateOf(head),
  };
}

/**
 * The settled values of a turn or a resume, read into a {@link ResumeOutcome}.
 * `sessionId` is the session the values belong to, when the caller knows it; it
 * lets a delegated park name the child's session id.
 */
export function settle(result: Record<string, unknown>, sessionId?: string): ResumeOutcome {
  const messages = Array.isArray(result.messages) ? result.messages : [];
  const park = parkOf(result);
  const parkedAt = park ? parkedStateOf(park.pending) : undefined;
  const delegation = delegationOf(result, park?.channel, sessionId);
  const usage = readRunUsage(result);
  return {
    status: typeof result.status === "string" ? (result.status as WorkflowStatus) : undefined,
    workflowState: typeof result.workflowState === "string" ? result.workflowState : undefined,
    reparked: park !== undefined,
    ...(park ? { parkedChannel: park.channel, pending: park.pending } : {}),
    ...(parkedAt ? { state: parkedAt } : {}),
    ...(delegation ? { delegation } : {}),
    reply: lastAgentText(messages),
    messages,
    auditTrail: readAuditTrail(result),
    variables: readVariables(result),
    ...(hasUsage(usage) ? { usage } : {}),
  };
}

/** The {@link Outcome} a settled {@link ResumeOutcome} amounts to. */
export function outcomeOf(settled: ResumeOutcome, disposition: SendDisposition): Outcome {
  const kind: Outcome["kind"] = settled.reparked
    ? "parked"
    : settled.status === WORKFLOW_STATUSES.rejected
      ? "rejected"
      : "completed";
  const state = settled.state ?? settled.workflowState;
  return {
    kind,
    disposition,
    ...(settled.status ? { status: settled.status } : {}),
    ...(state ? { state } : {}),
    ...(settled.parkedChannel ? { parkedChannel: settled.parkedChannel } : {}),
    ...(settled.pending ? { pending: settled.pending } : {}),
    ...(settled.delegation ? { delegation: settled.delegation } : {}),
    reply: settled.reply,
    messages: settled.messages,
    auditTrail: settled.auditTrail,
    variables: settled.variables,
    ...(settled.usage ? { usage: settled.usage } : {}),
  };
}

// --- The one resume path ---------------------------------------------------------

/**
 * Validate a payload against the parked session and produce the value the
 * suspended `interrupt()` receives — before the graph is touched. Also returns
 * the state the session is parked at, which a reply (never routing) reports as its own.
 */
async function validate(
  graph: IntrospectableStateGraph,
  sessionId: string,
  payload: ResumePayload,
): Promise<{ value: unknown; parkedAt?: string }> {
  if ("decision" in payload) {
    const values = await readParkedSession(graph, sessionId, WORKFLOW_STATUSES.awaitingDecision);
    if (!values) throw new SessionNotParkedError(sessionId);
    const pending = values.pendingDecision as PendingDecision | null | undefined;
    // A decision routes only to a target the session can actually leave for: a
    // self-targeted transition would end the session as `completed`. Refused
    // with the options that do lead somewhere.
    const parkedAt = parkedStateOf(pending);
    const validTargets = (pending?.transitions ?? []).map((t) => t.to).filter((to) => to !== parkedAt);
    const target = (payload.decision?.target ?? "").trim();
    if (!target || !validTargets.includes(target)) {
      throw new InvalidDecisionTargetError(sessionId, target || undefined, validTargets);
    }
    return { value: payload.decision, parkedAt };
  }
  if ("delivery" in payload) {
    const values = await readParkedSession(graph, sessionId, WORKFLOW_STATUSES.awaitingInput);
    if (!values) throw new SessionNotAwaitingInputError(sessionId);
    const requested = (payload.delivery?.trigger?.id ?? "").trim();
    if (requested === "") throw new MissingDeliveryTriggerError(sessionId);
    // The same rule host seeds obey at assembly, and the same error.
    for (const name of Object.keys(payload.delivery.variables ?? {})) {
      if (!VARIABLE_NAME_PATTERN.test(name)) {
        throw new InvalidVariableNameError(name, `delivered to session '${sessionId}'`);
      }
    }
    const message = (payload.delivery.message ?? "").trim();
    return {
      value: {
        trigger: { id: requested },
        variables: payload.delivery.variables ?? {},
        ...(message ? { message } : {}),
      } satisfies TriggerDelivery,
      parkedAt: parkedStateOf(values.pendingInput as PendingInput | null | undefined),
    };
  }
  const values = await readParkedSession(graph, sessionId, WORKFLOW_STATUSES.awaitingDecision);
  if (!values) throw new SessionNotParkedError(sessionId);
  const text = (payload.message ?? "").trim();
  if (!text) throw new EmptyMessageError(sessionId);
  return {
    value: { message: text },
    parkedAt: parkedStateOf(values.pendingDecision as PendingDecision | null | undefined),
  };
}

/**
 * Resume a parked session with a decision, a reply or a delivery. Everything is
 * validated before the graph is touched; the invoke result *is* the resumed state.
 */
export async function resume(
  graph: IntrospectableStateGraph,
  sessionId: string,
  payload: ResumePayload,
  config?: RunnableConfig,
): Promise<ResumeOutcome> {
  const { value, parkedAt } = await validate(graph, sessionId, payload);
  // A resumed turn is a turn: the caller's config carries that turn's tool mocks
  // and its abort signal, so it merges here exactly as it does on a fresh turn.
  // The thread id is applied last, so no caller can redirect the resume.
  const result = await graph.invoke(
    new Command({ resume: value }),
    mergeConfigs(config, { configurable: { thread_id: sessionId } }),
  );
  const outcome = settle(result, sessionId);
  if ("message" in payload) {
    // A message never routes: the session is parked where it was. The resumed
    // record is preferred only so the two cannot disagree.
    const state = outcome.state || parkedAt || "";
    return { ...outcome, reparked: true, parkedChannel: "decision", state };
  }
  return outcome;
}

// --- Conveniences ----------------------------------------------------------------

/**
 * Resume a session parked at a human state with the person's decision. Throws
 * {@link SessionNotParkedError} when the session is not awaiting a decision, and
 * {@link InvalidDecisionTargetError} when `target` is not a declared transition.
 */
export function decide(
  graph: IntrospectableStateGraph,
  sessionId: string,
  resolution: DecisionResolution,
  config?: RunnableConfig,
): Promise<DecideOutcome> {
  return resume(graph, sessionId, { decision: resolution }, config);
}

/**
 * Reply to a session parked at a human state and get its answer: a turn with no
 * tools, after which the session stays parked at the same state with the same
 * pending decision. Throws {@link SessionNotParkedError} and {@link EmptyMessageError}.
 */
export async function reply(
  graph: IntrospectableStateGraph,
  sessionId: string,
  message: string,
  config?: RunnableConfig,
): Promise<ReplyOutcome> {
  return (await resume(graph, sessionId, { message }, config)) as ReplyOutcome;
}

/**
 * Resume a parked session with a delivered firing: the session continues in the
 * state it parked in, the delivered id becomes its current trigger, and the
 * variables seed what the event carried. Throws {@link SessionNotAwaitingInputError}
 * and {@link MissingDeliveryTriggerError}.
 */
export function deliver(
  graph: IntrospectableStateGraph,
  sessionId: string,
  delivery: TriggerDelivery,
  config?: RunnableConfig,
): Promise<DeliverOutcome> {
  return resume(graph, sessionId, { delivery }, config);
}
