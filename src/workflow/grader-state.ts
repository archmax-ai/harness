/**
 * A grader state's run: an isolated grader subagent — its own model, its own
 * prompt, its own messages — that judges the session and decides where it goes.
 *
 * Isolated in three ways. It reads the session only through its tools
 * (`archmax_get_history` above all), and nothing it says enters the session's
 * transcript. Its tokens are tagged `nostream`, so they never stream as the
 * session's text. And it compiles with no checkpointer, so it writes nothing into
 * the session's thread. What it decided reaches the session as the step
 * recorder's decision, which the orchestrator (`automated.ts`) commits.
 *
 * Its tools are its state's surface, already governed by the PTC gateway on the
 * `agent` origin; this module adds what a model's calls get on the agent's own
 * path — `${{…}}` argument substitution, and a refused or failed call answered
 * as an error the model can read rather than thrown — and ends the loop the
 * moment a decision is recorded.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { StructuredTool } from "@langchain/core/tools";
import { isCommand, isGraphBubbleUp } from "@langchain/langgraph";
import { context } from "@opentelemetry/api";
import { createAgent, createMiddleware, tool } from "langchain";
import { DEFAULT_RECURSION_LIMIT } from "../core/deepagents.js";
import { contentToString, isAiMessage } from "../core/messages.js";
import type { WorkflowEventEmitter } from "../core/events.js";
import { Telemetry, toolOutcomeOf, type ToolOutcome } from "../core/telemetry.js";
import { addSummaries, extractUsage, summarizeUsage, type PricingTable, type UsageSummary } from "../core/usage.js";
import type { WorkflowMachine } from "../machine/machine.js";
import { ADVANCE_TOOL, GET_HISTORY_TOOL, RAISE_TOOL, isWorkflowToolName } from "../machine/tool-names.js";
import { resolveArguments } from "../machine/variables.js";
import { PtcGovernanceError } from "../sandbox/ptc-gateway.js";
import type { StepRecorder } from "./automated-controls.js";
import { UNRESOLVED_ARGUMENT_RULE, unresolvedArgumentMessage } from "./control-tools.js";
import { renderTransitions } from "./render-prompt.js";
import { blockedMessage } from "./tool-service.js";

/**
 * What every grader is told before its state's criteria: what it is, how it reads
 * the session, and the two calls it decides with. Compiled in, like the platform
 * prompt: a grader's contract is the runtime's, its criteria are the author's.
 */
export const GRADER_PREAMBLE = `# Grader

You are the grader of one state of a workflow session. You do not talk to anyone:
you judge the session's work against the criteria below and decide where the
session goes next.

1. Read the session with \`${GET_HISTORY_TOOL}\`: every message so far, and the trail of
   states it moved through and why. Read files or variables when the criteria need them.
2. Decide by calling \`${ADVANCE_TOOL}({ "to": "<slug>", "reason": "<what you found>" })\` with
   one of the transitions listed in your task. The reason is what the next state reads:
   when you send work back, say exactly what has to change.
3. When the work cannot be accepted and must not be retried — your criteria say when —
   call \`${RAISE_TOOL}({ "code": "<short-token>", "reason": "<why>" })\` instead: it ends the
   session as failed.

Make exactly one of those two calls, then stop. Text you write is read by no one.

## Criteria`;

/** The task a grader is handed: where it stands, and the transitions it chooses from. */
export function graderTask(machine: WorkflowMachine, state: string): string {
  return [
    `You are grading the session in the grader state \`${state}\`.`,
    `Transitions — choose one with \`${ADVANCE_TOOL}\`:`,
    ...renderTransitions(machine, state),
  ].join("\n\n");
}

export interface GraderStateRun {
  machine: WorkflowMachine;
  emit: WorkflowEventEmitter;
  /** The session graded: what the grader's spans are reported under. */
  sessionId: string;
  /** Where the grader's model-call and tool-call spans go; omitted, they parent to the active context. */
  telemetry?: Telemetry;
  pricing?: PricingTable;
  state: string;
  model: BaseChatModel;
  /** The model's id, for usage events, when the instance exposes one. */
  modelId?: string;
  /** The grader state's tools, governed (controls included). */
  tools: StructuredTool[];
  recorder: StepRecorder;
  /** The turn's abort signal: a cancelled turn cancels the grader. */
  signal?: AbortSignal;
}

/**
 * Whether a grader's call reached the gateway, which reports every call it
 * sees; the grader's middleware reports the ones that never do.
 */
const gatewayReached = new AsyncLocalStorage<{ reached: boolean }>();

/** The tag LangGraph's message stream skips: a grader's tokens are not the session's text. */
const NO_STREAM_TAG = "langsmith:nostream";

/** The text a tool's settled value reads as, for the grader's tool answer. */
function answerText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof ToolMessage) return contentToString(value.content);
  if (isCommand(value)) {
    const messages = (value as { update?: { messages?: unknown[] } }).update?.messages ?? [];
    const answer = [...messages].reverse().find((m) => m instanceof ToolMessage) as ToolMessage | undefined;
    if (answer) return contentToString(answer.content);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * The grader's own instance of a governed tool: same name, description and
 * schema, invoked with plain arguments. The grader's tool node hands a tool a
 * tool call and its own config; the governed tool takes arguments and runs on
 * the session's turn config, which the gateway supplies.
 */
function graderTool(governed: StructuredTool): StructuredTool {
  return tool(async (args: Record<string, unknown>) => {
    // The arguments passed the tool's schema: the call reaches the gateway, which reports it.
    const probe = gatewayReached.getStore();
    if (probe) probe.reached = true;
    return answerText(await governed.invoke(args as never));
  }, {
    name: governed.name,
    description: governed.description,
    schema: governed.schema as never,
  }) as unknown as StructuredTool;
}

/**
 * Run a grader state's subagent. Settles with the error that stopped it, if one
 * did — an expired `budget.timeoutMs`, the recursion limit, a model or runtime
 * failure — and with its usage across every model call. A cancelled
 * turn is not the grader's failure: its abort propagates.
 */
export async function runGraderState(run: GraderStateRun): Promise<{ error?: string; usage?: UsageSummary }> {
  const { machine, emit, recorder, state, sessionId } = run;
  const declared = machine.spec.states[state];
  const timeoutMs = declared?.budget?.timeoutMs;
  const telemetry = run.telemetry ?? new Telemetry();
  let usage: UsageSummary | undefined;

  const middleware = createMiddleware({
    name: "GraderMiddleware",
    // Each of the grader's model calls is a span under its state's, priced as its `model-usage` event is.
    wrapModelCall: async (request, handler) => {
      const span = telemetry.modelCall({
        sessionId,
        state,
        role: "grader",
        model: run.model,
        ...(run.modelId ? { requestModel: run.modelId, pricingModel: run.modelId } : {}),
        ...(run.pricing ? { pricing: run.pricing } : {}),
      });
      // The call ends at the budget's expiry, whether or not the model honours the abort.
      const onExpiry = () => span.expire();
      expiry?.addEventListener("abort", onExpiry, { once: true });
      try {
        const answer = await context.with(span.context, () => handler(request));
        span.settle(answer);
        return answer;
      } catch (err) {
        if (expiry?.aborted && !run.signal?.aborted) span.expire();
        else span.fail(err);
        throw err;
      } finally {
        expiry?.removeEventListener("abort", onExpiry);
      }
    },
    beforeModel: {
      canJumpTo: ["end"],
      hook: () => {
        // Decided: the run is over, with no further model call.
        if (recorder.decision) return { jumpTo: "end" } as never;
        return undefined;
      },
    },
    afterModel: (stateView) => {
      const last = (stateView as { messages?: unknown[] }).messages?.at(-1);
      if (!last || !isAiMessage(last)) return undefined;
      const extracted = extractUsage(last);
      if (!extracted) return undefined;
      const model = extracted.model ?? run.modelId;
      const summary = summarizeUsage(extracted.usage, run.pricing, model);
      emit({ type: "model-usage", state, ...summary, ...(model ? { model } : {}) });
      usage = usage ? addSummaries(usage, summary) : summary;
      return undefined;
    },
    // A call that reaches the gateway is reported there, under the id its events
    // carry; one that never does — a name no tool has, an unresolved argument,
    // arguments the tool's schema refuses — is reported here.
    wrapToolCall: async (request, handler) => {
      const name = request.toolCall.name;
      const callId = request.toolCall.id ?? "";
      const unknown = request.tool === undefined;
      const report = (outcome: ToolOutcome, rule?: string) =>
        telemetry
          .toolCall({ sessionId, state, tool: unknown ? "unknown" : name, callId, origin: "grader" })
          .end(unknown ? "unknown" : outcome, rule);
      let call = request;
      // `${{…}}` resolves against the session's variables as this run sees them,
      // exactly as the agent's own arguments do; a delegation's are its params.
      if (!isWorkflowToolName(name)) {
        const substituted = resolveArguments((request.toolCall.args ?? {}) as Record<string, unknown>, recorder.store());
        if (!substituted.ok) {
          report("blocked", UNRESOLVED_ARGUMENT_RULE);
          return blockedMessage(name, callId, unresolvedArgumentMessage(substituted));
        }
        call = { ...request, toolCall: { ...request.toolCall, args: substituted.args } };
      }
      const probe = { reached: false };
      try {
        const answer = await gatewayReached.run(probe, () => handler(call));
        if (!probe.reached) report(toolOutcomeOf(answer));
        return answer;
      } catch (err) {
        if (isGraphBubbleUp(err) || run.signal?.aborted) throw err;
        if (!probe.reached) report("error");
        const cause = (err as { cause?: unknown })?.cause ?? err;
        const message = String((cause as Error)?.message ?? cause);
        if (cause instanceof PtcGovernanceError) return blockedMessage(name, callId, message);
        return new ToolMessage({ content: message, tool_call_id: callId, name, status: "error" });
      }
    },
  });

  const grader = createAgent({
    model: run.model,
    tools: run.tools.map(graderTool),
    systemPrompt: `${GRADER_PREAMBLE}\n\n${declared?.instructions?.trim() ?? ""}`,
    middleware: [middleware],
    checkpointer: false,
    name: `grader:${state}`,
  });

  // The time budget starts here, as the grader is invoked; the middleware above
  // reads it during the run, when it is already set.
  const expiry = timeoutMs != null ? AbortSignal.timeout(timeoutMs) : undefined;
  const signals = [run.signal, expiry].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  try {
    await grader.invoke(
      { messages: [new HumanMessage(graderTask(machine, state))] },
      {
        ...(signal ? { signal } : {}),
        tags: [NO_STREAM_TAG],
        // The grader's own loop is bounded the way a turn is.
        recursionLimit: DEFAULT_RECURSION_LIMIT,
      },
    );
  } catch (err) {
    if (run.signal?.aborted) throw err;
    if (recorder.decision) return { ...(usage ? { usage } : {}) };
    const expired = timeoutMs != null && signal?.aborted;
    return {
      error: expired
        ? `grader state '${state}' exceeded its time budget (timeoutMs: ${timeoutMs})`
        : `grader state '${state}' failed: ${(err as Error)?.message ?? String(err)}`,
      ...(usage ? { usage } : {}),
    };
  }
  return usage ? { usage } : {};
}
