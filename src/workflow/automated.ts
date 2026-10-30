/**
 * Automated states — grader and code states — as the runtime runs them.
 *
 * Every model call of a session crosses `wrapModelCall`, the `jumpTo: "model"`
 * routes that skip `beforeModel` included. So that is where an automated state
 * is run: when the session's position is a grader or a code state, the call is
 * **serviced in place of the agent's model** — {@link runAutomatedStep} runs the
 * state and returns a marker message carrying its outcome — and `afterModel`
 * strips the marker and commits the outcome ({@link automatedOutcomeOf}). A move
 * jumps back to the model, where the next state's call is serviced the same way
 * (an automated state, with no model call), made for real (an agent state), or
 * spent on a park's handoff (a human state). One step per graph iteration: each
 * committed as its own checkpointed step, and a runaway cycle bounded by the
 * session's recursion limit like any runaway turn.
 *
 * The outcome rides in the marker, not in memory, so a process that dies
 * between the model node and `afterModel` replays the commit from the marker.
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredTool } from "@langchain/core/tools";
import { v4 as uuidv4 } from "@langchain/core/utils/uuid";
import type { WorkflowEventEmitter } from "../core/events.js";
import type { MountPrefixes } from "../core/mounts.js";
import type { PricingTable, UsageSummary } from "../core/usage.js";
import type { WorkflowMachine } from "../machine/machine.js";
import { TRIGGER_VARIABLE, type VariableStore } from "../machine/variables.js";
import type { ScriptExecutor } from "../sandbox/executor.js";
import type { PtcToolGateway } from "../sandbox/ptc-gateway.js";
import { createAutomatedControls, createStepRecorder, type AutomatedDecision } from "./automated-controls.js";
import { runCodeState, type CodeScriptResolver } from "./code-state.js";
import { runGraderState } from "./grader-state.js";
import { sessionHistory } from "./history.js";
import { reportAdvance } from "./move-events.js";
import type { FileValueCheck } from "./signature-checks.js";
import { currentWorkflowState, readVariables, readWorkflowState, type TrailStep } from "./state.js";

/** An automated state's type. */
export type AutomatedType = "grader" | "code";

/**
 * What one automated run settled as — exactly one of: it advanced (its decision
 * stood and it finished cleanly), it raised, a terminal state completed, or it
 * failed (an error, a timeout, a spent budget, or a non-terminal state that
 * finished undecided).
 */
export type AutomatedResult =
  | { kind: "advanced"; to: string; reason: string; evidence?: string[] }
  | { kind: "raised"; code: string; reason: string }
  | { kind: "completed" }
  | { kind: "failed"; reason: string };

/** A settled run, as the marker carries it to the commit: serializable, and the whole of what it commits. */
export interface AutomatedOutcome {
  state: string;
  type: AutomatedType;
  result: AutomatedResult;
  /** The run's variable writes. */
  variables?: VariableStore;
  /** What the run's own model calls cost (a grader's). */
  usage?: UsageSummary;
  /** The sub-runs its calls dispatched, as trail steps. */
  trail?: TrailStep[];
}

/** Where the marker message carries its outcome. */
const AUTOMATED_STEP_KEY = "archmax_automated_step";

/** The outcome a marker message carries, when the message is one. */
export function automatedOutcomeOf(message: unknown): AutomatedOutcome | undefined {
  const kwargs = (message as { additional_kwargs?: Record<string, unknown> } | undefined)?.additional_kwargs;
  const outcome = kwargs?.[AUTOMATED_STEP_KEY];
  return outcome && typeof outcome === "object" ? (outcome as AutomatedOutcome) : undefined;
}

export interface AutomatedStatesContext {
  machine: WorkflowMachine;
  emit: WorkflowEventEmitter;
  mountPrefixes: MountPrefixes;
  /** Governs every tool an automated state calls, against the live state. */
  ptcGateway: PtcToolGateway;
  /** Runs a code state's script, reading it from the authoring backend. */
  codeExecutor: ScriptExecutor;
  resolveScript: CodeScriptResolver;
  /** The model a grader state runs on, and its id when the instance exposes one. */
  graderModel(state: string): { model: BaseChatModel; id?: string };
  pricing?: PricingTable;
  /** The `file` type's runtime check for a session in a state; omitted, a `file` value is held to its shape alone. */
  files?: (state: string, variables: VariableStore) => FileValueCheck;
  /** The sub-runs the session's calls dispatched since the last drain, as trail steps. */
  dispatchSteps(sessionId: string, state: string): TrailStep[];
}

export interface AutomatedStepRequest {
  sessionId: string;
  /** The checkpointed session. */
  session: unknown;
  /** Every tool the assembly registered, before any state narrows it. */
  tools: StructuredTool[];
  /** The turn's config, naming the calling state. */
  config: RunnableConfig;
  signal?: AbortSignal;
}

/** The variables as a script reads them: a flat `name → value` map. */
function flatVariables(store: VariableStore): Record<string, unknown> {
  return Object.fromEntries(Object.entries(store).map(([name, entry]) => [name, entry.value]));
}

/** How a run settles, from its decision and whether it finished cleanly. */
function settle(
  machine: WorkflowMachine,
  state: string,
  type: AutomatedType,
  decision: AutomatedDecision | undefined,
  error: string | undefined,
): AutomatedResult {
  // A raise ends the session whatever the run did next; an error discards a move.
  if (decision?.kind === "raise") return { kind: "raised", code: decision.code, reason: decision.reason };
  if (error !== undefined) return { kind: "failed", reason: error };
  if (decision?.kind === "advance") {
    return {
      kind: "advanced",
      to: decision.to,
      reason: decision.reason,
      ...(decision.evidence.length > 0 ? { evidence: decision.evidence } : {}),
    };
  }
  if (machine.isTerminal(state)) return { kind: "completed" };
  return {
    kind: "failed",
    reason: `${type} state '${state}' finished without calling archmax_advance or archmax_raise`,
  };
}

/**
 * Run the automated state the session stands in — one step — and return the
 * marker message standing in for the model call that was not made.
 *
 * The state is offered exactly its surface (`disclosedTools`): the registered
 * tools it names, minus the agent's control declarations, plus its own controls
 * bound to this run's recorder — every one wrapped by the gateway, whose live
 * context is pointed at this state first. Narrative events are emitted once the
 * run has settled, so nothing announces a move the run's error then discarded.
 */
export async function runAutomatedStep(ctx: AutomatedStatesContext, request: AutomatedStepRequest): Promise<AIMessage> {
  const { machine, emit } = ctx;
  const { sessionId, session, config } = request;
  const state = currentWorkflowState(session, machine.entry);
  const type: AutomatedType = machine.isGraderState(state) ? "grader" : "code";
  const declared = machine.spec.states[state];

  const refresh = (variables: VariableStore) =>
    ctx.ptcGateway.refresh(sessionId, { state, config, replyOnly: false, variables });
  refresh(readVariables(session));
  const recorder = createStepRecorder(state, session, refresh);
  const history = sessionHistory(session);

  const surface = machine.disclosedTools(state);
  const controls = machine.controlTools(state);
  const own = request.tools.filter((tool) => surface.has(tool.name) && !controls.has(tool.name));
  const tools = ctx.ptcGateway.wrap(
    [...own, ...createAutomatedControls(ctx, recorder, history)],
    { origin: type === "grader" ? "agent" : "script", sessionId },
  );

  const startedAt = Date.now();
  let error: string | undefined;
  let usage: UsageSummary | undefined;
  if (type === "code") {
    emit({ type: "code-start", state, script: declared?.script ?? "" });
    const trigger = readWorkflowState(session).trigger?.id;
    const input = { state, ...(trigger ? { trigger } : {}), variables: flatVariables(recorder.store()) };
    ({ error } = await runCodeState({
      emit,
      executor: ctx.codeExecutor,
      resolveScript: ctx.resolveScript,
      sessionId,
      state,
      script: declared?.script ?? "",
      input,
      tools,
      surface: [...surface],
      ...(request.signal ? { signal: request.signal } : {}),
    }));
  } else {
    emit({ type: "grader-start", state });
    const { model, id } = ctx.graderModel(state);
    ({ error, usage } = await runGraderState({
      machine,
      emit,
      ...(ctx.pricing ? { pricing: ctx.pricing } : {}),
      state,
      model,
      ...(id ? { modelId: id } : {}),
      tools,
      recorder,
      ...(request.signal ? { signal: request.signal } : {}),
    }));
  }

  const decision = recorder.decision;
  const result = settle(machine, state, type, decision, error);
  const failed = result.kind === "failed";
  emit({
    type: type === "code" ? "code-result" : "grader-result",
    state,
    status: failed ? "error" : "ok",
    durationMs: Date.now() - startedAt,
    ...(failed ? { reason: result.reason } : {}),
  });
  if (result.kind === "advanced") {
    reportAdvance(emit, sessionId, {
      from: state,
      to: result.to,
      reason: result.reason,
      ...(decision?.callId ? { callId: decision.callId } : {}),
      parks: machine.isHumanState(result.to),
    });
  } else if (result.kind === "raised") {
    emit({
      type: "raised",
      state,
      sessionId,
      code: result.code,
      reason: result.reason,
      ...(decision?.callId ? { callId: decision.callId } : {}),
    });
    // The session leaves the state it failed in as a completing one does; nothing is entered.
    emit({ type: "state-leave", state, next: state });
  }

  // The built-in `trigger` is the turn's, set at its boundary: never a run's write.
  const { [TRIGGER_VARIABLE]: _trigger, ...variables } = recorder.delta;
  const trail = ctx.dispatchSteps(sessionId, state);
  const outcome: AutomatedOutcome = {
    state,
    type,
    result,
    ...(Object.keys(variables).length > 0 ? { variables } : {}),
    ...(usage ? { usage } : {}),
    ...(trail.length > 0 ? { trail } : {}),
  };
  return new AIMessage({
    content: "",
    id: `automated_${uuidv4()}`,
    additional_kwargs: { [AUTOMATED_STEP_KEY]: outcome },
  });
}

/** `text` as one sentence: trimmed, ending in its own full stop, or one added. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** The runtime note an automated move or raise leaves for the session to read. */
export function automatedNoteText(outcome: AutomatedOutcome): string | undefined {
  const { state, type, result } = outcome;
  const who = type === "grader" ? `The '${state}' grader` : `'${state}'`;
  if (result.kind === "advanced") {
    return `[${type}] ${who} moved the run to '${result.to}': ${sentence(result.reason)} You are now in '${result.to}'.`;
  }
  if (result.kind === "raised") {
    return `[${type}] ${who} ended the session as failed ('${result.code}'): ${result.reason}`;
  }
  return undefined;
}
