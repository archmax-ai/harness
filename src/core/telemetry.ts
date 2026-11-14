/**
 * OpenTelemetry for the runtime: one span per turn, per visit to a state, per
 * model call and per tool call, and the GenAI client metrics for every model
 * call — reported through `@opentelemetry/api` alone (a peer dependency), so a
 * host sees them in its own trace once it registers an SDK, and nothing at all
 * happens when it registers none.
 *
 * This module owns every span name, attribute name and recorded value, which
 * is how the metadata-only rule holds: it takes slugs, model ids, counts and
 * outcomes, never a message, an argument, a result or an error's message, and
 * it records no exception.
 *
 * Turn, model-call and tool-call spans are made at their call sites and are
 * active while the call runs, so whatever the call causes — the provider's HTTP
 * request, a host tool's own spans, a sub-workflow's child turn — nests under
 * it. A state visit is not one call: the sites that move a session report it on
 * the event stream, which {@link Telemetry.observe} follows, and its children
 * are parented to it explicitly ({@link Telemetry.parentFor}).
 */
import {
  context,
  createContextKey,
  INVALID_SPAN_CONTEXT,
  metrics,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Histogram,
  type MeterProvider,
  type Span,
  type SpanOptions,
} from "@opentelemetry/api";
import { isGraphBubbleUp, isGraphInterrupt } from "@langchain/langgraph";
import { PACKAGE_VERSION } from "../env.js";
import { currentEventContext, type WorkflowLifecycleEvent } from "./events.js";
import {
  addSummaries,
  extractUsage,
  summarizeUsage,
  type PricingTable,
  type UsageSummary,
} from "./usage.js";

/** The instrumentation scope every span and metric is reported under. */
export const TELEMETRY_SCOPE = "@archmax-ai/harness";

/** Every attribute the runtime records, by the name the backend reads. */
export const TELEMETRY_ATTRIBUTES = {
  operation: "gen_ai.operation.name",
  agentName: "gen_ai.agent.name",
  conversationId: "gen_ai.conversation.id",
  provider: "gen_ai.provider.name",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  finishReasons: "gen_ai.response.finish_reasons",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  cacheReadTokens: "gen_ai.usage.cache_read.input_tokens",
  cacheCreationTokens: "gen_ai.usage.cache_creation.input_tokens",
  cost: "gen_ai.usage.cost",
  toolName: "gen_ai.tool.name",
  toolCallId: "gen_ai.tool.call.id",
  toolType: "gen_ai.tool.type",
  tokenType: "gen_ai.token.type",
  errorType: "error.type",
  state: "archmax.state",
  stateType: "archmax.state.type",
  stateNext: "archmax.state.next",
  stateResumed: "archmax.state.resumed",
  stateParked: "archmax.state.parked",
  raiseCode: "archmax.raise.code",
  turnResume: "archmax.turn.resume",
  sessionStatus: "archmax.session.status",
  dispatchId: "archmax.dispatch.id",
  modelRole: "archmax.model.role",
  responseToolCalls: "archmax.response.tool_calls",
  toolOrigin: "archmax.tool.origin",
  toolOutcome: "archmax.tool.outcome",
  toolRule: "archmax.tool.rule",
} as const;

const A = TELEMETRY_ATTRIBUTES;

/** The two GenAI client metrics, by name. */
export const TELEMETRY_METRICS = {
  operationDuration: "gen_ai.client.operation.duration",
  tokenUsage: "gen_ai.client.token.usage",
} as const;

/** The bucket boundaries the GenAI conventions advise for each metric. */
const DURATION_BUCKETS = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
];
const TOKEN_BUCKETS = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864,
];

// --- What may be recorded ------------------------------------------------------

/** A tool name, raise code or provider name the runtime may record: a plain identifier. */
const IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/;
/** A model id: an identifier that may also carry `/` and `@` (`openai/gpt-6-luna`). */
const MODEL_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:/@+-]{0,127}$/;
/** A tool call's id: what providers and the runtime issue (`call_…`, `toolu_…`, `ptc:12`). */
const CALL_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
/** An error class name: PascalCase, ending `Error` or `Exception` — never free text in a `name`. */
const CLASS_NAME = /^[A-Z][A-Za-z0-9]{0,62}(Error|Exception)$/;

/**
 * A tool's name as a span reports it: the name when it is a plain tool
 * identifier, else `unknown` — a model can call a tool by any string at all.
 */
export function reportedToolName(name: string): string {
  return IDENTIFIER.test(name) ? name : "unknown";
}

/** A raise's code when it is a short token, else nothing: the raiser chose it. */
export function reportedRaiseCode(code: unknown): string | undefined {
  return typeof code === "string" && IDENTIFIER.test(code) ? code : undefined;
}

/** A model id when it reads as one, else nothing. */
export function reportedModelId(id: unknown): string | undefined {
  return typeof id === "string" && MODEL_ID.test(id) ? id : undefined;
}

/** A tool call's id as a span reports it, when it reads as an id. */
export function reportedCallId(id: unknown): string | undefined {
  return typeof id === "string" && CALL_ID.test(id) ? id : undefined;
}

/**
 * An error's `error.type`: the HTTP status it carries (`429`), else its class
 * name (`AbortError`, from its `name` or its constructor's), else `Error`.
 * Never its message, which can quote what the call was given, and never a
 * `name` that is not shaped like a class name.
 */
export function errorTypeOf(err: unknown): string {
  const e = err as
    { status?: unknown; response?: { status?: unknown }; name?: unknown } | null | undefined;
  const status = e?.status ?? e?.response?.status;
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status < 600)
    return String(status);
  for (const name of [
    e?.name,
    (e as { constructor?: { name?: unknown } } | null | undefined)?.constructor?.name,
  ]) {
    if (typeof name === "string" && CLASS_NAME.test(name)) return name;
  }
  return "Error";
}

/** Run a reporting step: telemetry never fails the work it reports. */
function safely(step: () => void): void {
  try {
    step();
  } catch {
    // A span or a metric that cannot be recorded is lost, never the call's failure.
  }
}

/** Annotate `span`, then end it: a span whose annotation fails still ends. */
function finishSpan(span: Span, annotate: () => void): void {
  safely(annotate);
  safely(() => span.end());
}

/** LangChain's model types, mapped to the provider names the GenAI conventions use. */
const PROVIDERS: Record<string, string> = {
  openai: "openai",
  azure_openai: "azure.ai.openai",
  anthropic: "anthropic",
  bedrock: "aws.bedrock",
  amazon_bedrock: "aws.bedrock",
  "bedrock-converse": "aws.bedrock",
  vertexai: "gcp.vertex_ai",
  "google-vertexai": "gcp.vertex_ai",
  google_genai: "gcp.gemini",
  "google-genai": "gcp.gemini",
  mistralai: "mistral_ai",
  mistral: "mistral_ai",
  groq: "groq",
  deepseek: "deepseek",
  xai: "x_ai",
  cohere: "cohere",
  perplexity: "perplexity",
};

/** The `gen_ai.provider.name` of a chat model, from LangChain's own model type. */
export function providerOf(model: unknown): string | undefined {
  const typed = model as { _llmType?: () => unknown } | undefined;
  let type: unknown;
  try {
    type = typeof typed?._llmType === "function" ? typed._llmType() : undefined;
  } catch {
    return undefined;
  }
  if (typeof type !== "string") return undefined;
  return PROVIDERS[type.toLowerCase()] ?? (IDENTIFIER.test(type) ? type : undefined);
}

/** The finish reasons a response gives, as short tokens. */
function finishReasonsOf(message: unknown): string[] {
  const meta = (message as { response_metadata?: Record<string, unknown> } | undefined)
    ?.response_metadata;
  const reasons = [meta?.finish_reason, meta?.stop_reason].filter(
    (reason): reason is string => typeof reason === "string" && IDENTIFIER.test(reason),
  );
  return [...new Set(reasons)];
}

/** How many tool calls a response asked for. */
function toolCallCount(message: unknown): number {
  const calls = (message as { tool_calls?: unknown[] } | undefined)?.tool_calls;
  return Array.isArray(calls) ? calls.length : 0;
}

/** The AI message a model call settled with: the message itself, or the last one a command carries. */
function responseMessage(result: unknown): unknown {
  const update = (result as { update?: { messages?: unknown[] } } | undefined)?.update;
  if (Array.isArray(update?.messages)) {
    return [...update.messages]
      .reverse()
      .find((m) => (m as { tool_calls?: unknown })?.tool_calls !== undefined);
  }
  return result;
}

function usageAttributes(summary: UsageSummary): Attributes {
  return {
    [A.inputTokens]: summary.inputTokens,
    [A.outputTokens]: summary.outputTokens,
    [A.cacheReadTokens]: summary.cacheReadTokens,
    [A.cacheCreationTokens]: summary.cacheCreationTokens,
    ...(summary.costUsd !== undefined ? { [A.cost]: summary.costUsd } : {}),
  };
}

// --- Instruments ---------------------------------------------------------------

function tracer() {
  return trace.getTracer(TELEMETRY_SCOPE, PACKAGE_VERSION);
}

/**
 * Start a span, or — when the host's SDK throws starting it (a sampler, a span
 * processor's `onStart`) — a non-recording one: telemetry never fails the work
 * it reports.
 */
function startSpan(name: string, options: SpanOptions, parent: Context): Span {
  try {
    return tracer().startSpan(name, options, parent);
  } catch {
    return trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
  }
}

/** Whether a span records, read without trusting the host's SDK not to throw. */
function isRecording(span: Span): boolean {
  try {
    return span.isRecording();
  } catch {
    return false;
  }
}

interface Instruments {
  provider: MeterProvider;
  duration: Histogram;
  tokens: Histogram;
}

let instruments: Instruments | undefined;

/**
 * The histograms, built against the meter provider registered now. The metrics
 * API has no proxy meter: an instrument made before the host registers its
 * provider would stay a no-op, so they are rebuilt whenever the provider changes.
 */
function metricInstruments(): Instruments {
  const provider = metrics.getMeterProvider();
  if (instruments?.provider !== provider) {
    const meter = provider.getMeter(TELEMETRY_SCOPE, PACKAGE_VERSION);
    instruments = {
      provider,
      duration: meter.createHistogram(TELEMETRY_METRICS.operationDuration, {
        unit: "s",
        description: "GenAI operation duration.",
        advice: { explicitBucketBoundaries: DURATION_BUCKETS },
      }),
      tokens: meter.createHistogram(TELEMETRY_METRICS.tokenUsage, {
        unit: "{token}",
        description: "Number of input and output tokens used.",
        advice: { explicitBucketBoundaries: TOKEN_BUCKETS },
      }),
    };
  }
  return instruments;
}

// --- Context -------------------------------------------------------------------

/**
 * Marks a context as inside a tool call, by the session that made the call: a
 * call made in that context (a script's, inside `archmax_eval`) nests under it
 * rather than under its state. A turn clears it, so a sub-workflow's child —
 * a different session, run inside its caller's delegation call — attaches its
 * own calls to its own states.
 */
const TOOL_CALL = createContextKey("archmax-harness: inside a tool call of session");

/**
 * Marks a context as a turn's: the work a turn does — events, calls — finds its
 * own turn through the context it runs in, so two turns open on one session at
 * once (a host invoking it twice) keep their spans apart.
 */
const TURN = createContextKey("archmax-harness: the turn this work belongs to");

// --- Spans ---------------------------------------------------------------------

/** What starts a turn's span. */
export interface TurnStart {
  sessionId: string;
  /** The workflow slug; absent for a plain agent. */
  workflow?: string;
  /** The turn resumes a park (a decision, a reply, a delivery). */
  resume?: boolean;
  /** A state's type, for the state spans of a governed turn. */
  stateType?: (slug: string) => string | undefined;
}

/** How a turn settled, read from what it returned. */
export interface TurnSettled {
  /** The session's status after the turn. */
  status?: string;
  /** The state the turn ended in. */
  state?: string;
}

/** A turn in flight: the context its work runs in, and how it ends. */
export interface TurnHandle {
  context: Context;
  /** Whether a provider is recording it: what spares a no-op turn any extra work. */
  recording: boolean;
  end(settled?: TurnSettled): void;
  fail(err: unknown): void;
}

/** A model call in flight. */
export interface ModelCallHandle {
  /** The context the call runs in: its span active. */
  context: Context;
  /** The call answered: its usage, the model it named, its finish. Ends the span. */
  settle(response: unknown): void;
  /** The call threw. Ends the span. */
  fail(err: unknown): void;
  /** The call outlived its time budget. Ends the span; a late answer changes nothing. */
  expire(): void;
}

/** How a tool call ended. */
export type ToolOutcome = "ok" | "error" | "blocked" | "unknown" | "parked" | "cancelled";

/** Who made a tool call. */
export type ToolOrigin = "agent" | "grader" | "script";

/** A tool call in flight. */
export interface ToolCallHandle {
  /** The context the call runs in: its span active, marked as a tool call of its session. */
  context: Context;
  /** The tool the call reached, once its name is resolved. */
  rename(tool: string): void;
  /** How it ended, and — when blocked — the rule that blocked it. Ends the span. */
  end(outcome: ToolOutcome, rule?: string): void;
}

const TOOL_ERROR_TYPES: Partial<Record<ToolOutcome, string>> = {
  error: "tool_error",
  blocked: "blocked",
  unknown: "unknown_tool",
  cancelled: "cancelled",
};

interface OpenState {
  slug: string;
  span: Span;
  context: Context;
  errorType?: string;
}

interface SessionTrace {
  sessionId: string;
  span: Span;
  context: Context;
  stateType?: (slug: string) => string | undefined;
  state?: OpenState;
  /** How many state spans this turn has opened. */
  visits: number;
  usage?: UsageSummary;
  /** What the session parked for during the turn, from its `parked` event. */
  parked?: "decision" | "input";
}

/** What a model call's span is opened with. */
export interface ModelCallStart {
  sessionId: string;
  /** The state the call is made in; absent for a plain agent. */
  state?: string;
  role: "agent" | "grader";
  /** The chat model the call runs on. */
  model: unknown;
  /** The id the call asks the endpoint for. */
  requestModel?: string;
  /** Prices, and the id a call whose response names none is priced as — what its `model-usage` event uses. */
  pricing?: PricingTable;
  pricingModel?: string;
}

/** What a tool call's span is opened with. */
export interface ToolCallStart {
  sessionId: string;
  state?: string;
  /** The name the call was made with. */
  tool: string;
  /** The call's id, as its events carry it. */
  callId: string;
  origin: ToolOrigin;
}

/**
 * The runtime's telemetry for one assembly: the spans of every turn its
 * compositions run, a sub-workflow's children included, keyed by session.
 */
export class Telemetry {
  /**
   * The open turns of each session, oldest first. An ended turn leaves its list
   * at once, wherever it sits in it; a turn the host abandoned without ending
   * (an iterator dropped without `return()`) stays until the process ends.
   */
  readonly #sessions = new Map<string, SessionTrace[]>();

  /** The open turn work of `sessionId` belongs to: the one its context names, else the newest. */
  #turnOf(sessionId: string | undefined): SessionTrace | undefined {
    if (!sessionId) return undefined;
    const open = this.#sessions.get(sessionId) ?? [];
    const active = context.active().getValue(TURN) as SessionTrace | undefined;
    // Work of a turn that already ended (a stream the host stopped reading) has no
    // turn any more: it never lands in a later turn of the same session.
    if (active?.sessionId === sessionId) return open.includes(active) ? active : undefined;
    return open[open.length - 1];
  }

  /**
   * Open a turn's span in the active context. Call {@link TurnHandle.end} or
   * {@link TurnHandle.fail} exactly once.
   */
  openTurn(start: TurnStart): TurnHandle {
    const parent = context.active().deleteValue(TOOL_CALL);
    const dispatchId = currentEventContext()?.subWorkflowDispatchId;
    const span = startSpan(
      start.workflow ? `invoke_agent ${start.workflow}` : "invoke_agent",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          [A.operation]: "invoke_agent",
          ...(start.workflow ? { [A.agentName]: start.workflow } : {}),
          [A.conversationId]: start.sessionId,
          [A.turnResume]: start.resume === true,
          ...(dispatchId ? { [A.dispatchId]: dispatchId } : {}),
        },
      },
      parent,
    );
    const record: SessionTrace = {
      sessionId: start.sessionId,
      span,
      context: parent,
      visits: 0,
      ...(start.stateType ? { stateType: start.stateType } : {}),
    };
    record.context = trace.setSpan(parent, span).setValue(TURN, record);
    this.#sessions.set(start.sessionId, [...(this.#sessions.get(start.sessionId) ?? []), record]);

    let ended = false;
    const close = () => {
      if (ended) return false;
      ended = true;
      const open = (this.#sessions.get(start.sessionId) ?? []).filter((entry) => entry !== record);
      if (open.length > 0) this.#sessions.set(start.sessionId, open);
      else this.#sessions.delete(start.sessionId);
      safely(() => {
        this.#closeState(record);
        if (record.usage) span.setAttributes(usageAttributes(record.usage));
      });
      return true;
    };
    const handle: TurnHandle = {
      context: record.context,
      recording: isRecording(span),
      end: (settled = {}) => {
        if (!close()) return;
        finishSpan(span, () => {
          // A turn that parked and settled with nothing to read (a child session's
          // park, which leaves its turn as a thrown interrupt) reports the park.
          const status =
            settled.status ?? (record.parked ? `awaiting_${record.parked}` : undefined);
          if (status) span.setAttribute(A.sessionStatus, status);
          if (settled.state) span.setAttribute(A.state, settled.state);
          if (status === "failed" || status === "rejected") {
            span.setAttribute(A.errorType, `session_${status}`);
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
        });
      },
      fail: (err) => {
        // A park is not a failure: a child session that parks leaves its turn by
        // throwing the interrupt its caller parks on.
        if (isGraphInterrupt(err)) {
          handle.end();
          return;
        }
        if (!close()) return;
        finishSpan(span, () => {
          span.setAttribute(A.errorType, errorTypeOf(err));
          span.setStatus({ code: SpanStatusCode.ERROR });
        });
      },
    };
    return handle;
  }

  /**
   * Run `fn` as one turn: its span active throughout, settled from what `fn`
   * returned, failed by what it threw (which still propagates).
   */
  async turn<T>(
    start: TurnStart,
    fn: () => Promise<T>,
    settled: (result: T) => TurnSettled,
  ): Promise<T> {
    const handle = this.openTurn(start);
    let result: T;
    try {
      result = await context.with(handle.context, fn);
    } catch (err) {
      handle.fail(err);
      throw err;
    }
    let outcome: TurnSettled = {};
    try {
      outcome = settled(result);
    } catch {
      // Reading the outcome is reporting, never the turn's failure.
    }
    handle.end(outcome);
    return result;
  }

  /**
   * Follow the event stream: a state entered opens its span, a state left ends
   * it, and a park, a failed automated run, an `on_error` route and a raise
   * mark it. Events of a session with no open turn are ignored.
   */
  observe(event: WorkflowLifecycleEvent): void {
    const record = this.#turnOf(event.sessionId);
    if (!record) return;
    safely(() => this.#follow(record, event));
  }

  #follow(record: SessionTrace, event: WorkflowLifecycleEvent): void {
    switch (event.type) {
      case "state-enter":
        this.#openState(record, event.state, false);
        return;
      case "state-leave": {
        const open = record.state;
        if (open?.slug !== event.state) return;
        // A session that completes leaves its terminal state for itself: it went nowhere.
        if (event.next !== event.state) open.span.setAttribute(A.stateNext, event.next);
        this.#closeState(record);
        return;
      }
      case "parked":
        record.parked = event.awaiting;
        this.#stateSpan(record, event.state)?.setAttribute(A.stateParked, event.awaiting);
        return;
      case "code-result":
      case "grader-result":
        if (event.status === "error")
          this.#failState(record, event.state, "automated_state_failed");
        return;
      case "state-error-routed":
        this.#failState(record, event.state, "routed_on_error");
        this.#stateSpan(record, event.state)?.setAttribute(A.stateNext, event.to);
        return;
      case "raised": {
        this.#failState(record, event.state, "raised");
        const code = reportedRaiseCode(event.code);
        if (code) this.#stateSpan(record, event.state)?.setAttribute(A.raiseCode, code);
        return;
      }
      default:
        return;
    }
  }

  /**
   * The context a model or tool call's span is opened in: the active one when
   * it is inside a tool call of the same session (a script's call); else the
   * active one with its span replaced by the turn's — the open span of the state
   * the call is made in; else, when the turn has opened no state yet (it
   * continues in the state the session was in), that state's span, opened now
   * and marked resumed; else the turn's own span (a call of a batch made in a
   * state the batch has already left). A session with no open turn leaves the
   * active context as it is.
   */
  parentFor(sessionId: string, state?: string): Context {
    const active = context.active();
    if (active.getValue(TOOL_CALL) === sessionId) return active;
    const record = this.#turnOf(sessionId);
    if (!record) return active;
    let span = record.span;
    if (state === undefined || record.state?.slug === state) {
      span = record.state?.span ?? record.span;
    } else if (record.visits === 0) {
      this.#openState(record, state, true);
      span = record.state?.span ?? record.span;
    }
    return trace.setSpan(active, span).setValue(TURN, record);
  }

  /** Open a model call's span under {@link parentFor}. */
  modelCall(start: ModelCallStart): ModelCallHandle {
    const parent = this.parentFor(start.sessionId, start.state);
    const requestModel = reportedModelId(start.requestModel);
    const provider = providerOf(start.model);
    const span = startSpan(
      requestModel ? `chat ${requestModel}` : "chat",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          [A.operation]: "chat",
          ...(provider ? { [A.provider]: provider } : {}),
          ...(requestModel ? { [A.requestModel]: requestModel } : {}),
          [A.conversationId]: start.sessionId,
          ...(start.state !== undefined ? { [A.state]: start.state } : {}),
          [A.modelRole]: start.role,
        },
      },
      parent,
    );
    const startedAt = performance.now();
    const metricAttributes: Attributes = {
      [A.operation]: "chat",
      ...(provider ? { [A.provider]: provider } : {}),
      ...(requestModel ? { [A.requestModel]: requestModel } : {}),
    };
    let settled = false;
    const finish = (attributes: Attributes, error?: string): boolean => {
      if (settled) return false;
      settled = true;
      finishSpan(span, () => {
        span.setAttributes(attributes);
        if (error) {
          span.setAttribute(A.errorType, error);
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
      });
      safely(() =>
        metricInstruments().duration.record((performance.now() - startedAt) / 1000, {
          ...metricAttributes,
          ...(attributes[A.responseModel] !== undefined
            ? { [A.responseModel]: attributes[A.responseModel] }
            : {}),
          ...(error ? { [A.errorType]: error } : {}),
        }),
      );
      return true;
    };
    return {
      context: trace.setSpan(parent, span),
      settle: (response) => {
        // Read what the answer reports; an answer that cannot be read still ends the span.
        let attributes: Attributes = {};
        let summary: UsageSummary | undefined;
        let responseModel: string | undefined;
        safely(() => {
          const message = responseMessage(response);
          const extracted = extractUsage(message);
          responseModel = reportedModelId(extracted?.model);
          summary = extracted
            ? summarizeUsage(extracted.usage, start.pricing, extracted.model ?? start.pricingModel)
            : undefined;
          const reasons = finishReasonsOf(message);
          attributes = {
            ...(responseModel ? { [A.responseModel]: responseModel } : {}),
            ...(reasons.length > 0 ? { [A.finishReasons]: reasons } : {}),
            [A.responseToolCalls]: toolCallCount(message),
            ...(summary ? usageAttributes(summary) : {}),
          };
        });
        if (!finish(attributes) || !summary) return;
        const usage = summary;
        safely(() => {
          const record = this.#turnOf(start.sessionId);
          if (record) record.usage = record.usage ? addSummaries(record.usage, usage) : usage;
          const { tokens } = metricInstruments();
          const tokenAttributes = {
            ...metricAttributes,
            ...(responseModel ? { [A.responseModel]: responseModel } : {}),
          };
          tokens.record(usage.inputTokens, { ...tokenAttributes, [A.tokenType]: "input" });
          tokens.record(usage.outputTokens, { ...tokenAttributes, [A.tokenType]: "output" });
        });
      },
      fail: (err) => safely(() => void finish({}, errorTypeOf(err))),
      expire: () => safely(() => void finish({}, "timeout")),
    };
  }

  /** Open a tool call's span under {@link parentFor}, marked as a tool call of its session. */
  toolCall(start: ToolCallStart): ToolCallHandle {
    const parent = this.parentFor(start.sessionId, start.state);
    let tool = reportedToolName(start.tool);
    const callId = reportedCallId(start.callId);
    const span = startSpan(
      `execute_tool ${tool}`,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          [A.operation]: "execute_tool",
          [A.toolName]: tool,
          ...(callId ? { [A.toolCallId]: callId } : {}),
          [A.toolType]: "function",
          [A.conversationId]: start.sessionId,
          ...(start.state !== undefined ? { [A.state]: start.state } : {}),
          [A.toolOrigin]: start.origin,
        },
      },
      parent,
    );
    let ended = false;
    return {
      context: trace.setSpan(parent, span).setValue(TOOL_CALL, start.sessionId),
      rename: (resolved) =>
        safely(() => {
          const name = reportedToolName(resolved);
          if (ended || name === tool) return;
          tool = name;
          span.updateName(`execute_tool ${tool}`);
          span.setAttribute(A.toolName, tool);
        }),
      end: (outcome, rule) => {
        if (ended) return;
        ended = true;
        finishSpan(span, () => annotateEnd(outcome, rule));
      },
    };

    function annotateEnd(outcome: ToolOutcome, rule: string | undefined): void {
      if (outcome === "unknown" && tool !== "unknown") {
        // An unknown name is the model's text, not a tool's identity.
        tool = "unknown";
        span.updateName("execute_tool unknown");
        span.setAttribute(A.toolName, tool);
      }
      span.setAttribute(A.toolOutcome, outcome);
      const errorType = TOOL_ERROR_TYPES[outcome];
      if (errorType) {
        span.setAttribute(A.errorType, errorType);
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      if (outcome === "blocked" && typeof rule === "string" && IDENTIFIER.test(rule)) {
        span.setAttribute(A.toolRule, rule);
      }
    }
  }

  #openState(record: SessionTrace, slug: string, resumed: boolean): void {
    this.#closeState(record);
    const type = record.stateType?.(slug);
    const span = startSpan(
      `state ${slug}`,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          [A.state]: slug,
          ...(type ? { [A.stateType]: type } : {}),
          ...(resumed ? { [A.stateResumed]: true } : {}),
        },
      },
      record.context,
    );
    record.state = { slug, span, context: trace.setSpan(record.context, span) };
    record.visits += 1;
  }

  #closeState(record: SessionTrace): void {
    const open = record.state;
    if (!open) return;
    delete record.state;
    finishSpan(open.span, () => {
      if (open.errorType) {
        open.span.setAttribute(A.errorType, open.errorType);
        open.span.setStatus({ code: SpanStatusCode.ERROR });
      }
    });
  }

  /** The open span of `slug`, when it is the state open now. */
  #stateSpan(record: SessionTrace, slug: string): Span | undefined {
    return record.state?.slug === slug ? record.state.span : undefined;
  }

  /** Mark the open visit of `slug` failed; the first failure names it. */
  #failState(record: SessionTrace, slug: string, errorType: string): void {
    const open = record.state;
    if (open?.slug === slug && !open.errorType) open.errorType = errorType;
  }
}

/** Whether a tool's answer is the runtime's refusal of the call. */
export function isBlockedAnswer(answer: unknown): boolean {
  const message = settledToolMessage(answer) as
    { additional_kwargs?: { governance_blocked?: unknown } } | undefined;
  return message?.additional_kwargs?.governance_blocked === true;
}

/** Whether a tool's answer is an error the model reads. */
export function isErrorAnswer(answer: unknown): boolean {
  return (settledToolMessage(answer) as { status?: unknown } | undefined)?.status === "error";
}

/** The tool message a call settled with: bare, or carried in a command's update. */
function settledToolMessage(answer: unknown): unknown {
  const update = (answer as { update?: { messages?: unknown[] } } | undefined)?.update;
  if (Array.isArray(update?.messages)) {
    return update.messages.find(
      (m) => (m as { tool_call_id?: unknown })?.tool_call_id !== undefined,
    );
  }
  return answer;
}

/**
 * The outcome of a tool call that threw `err`: a park (the session's own, or a
 * sub-workflow's carried up through the call) is not the call's failure, a
 * command to the parent graph is how the call answered, and a throw after the
 * turn was cancelled is the cancellation's.
 */
export function thrownOutcomeOf(err: unknown, signal: AbortSignal | undefined): ToolOutcome {
  if (isGraphInterrupt(err)) return "parked";
  if (isGraphBubbleUp(err)) return "ok";
  return signal?.aborted ? "cancelled" : "error";
}

/** The outcome of a tool call that settled with `answer`. */
export function toolOutcomeOf(answer: unknown): ToolOutcome {
  if (isBlockedAnswer(answer)) return "blocked";
  if (isParkingAnswer(answer)) return "parked";
  return isErrorAnswer(answer) ? "error" : "ok";
}

/**
 * Whether a tool's answer parks the session: it commits a pending input
 * (`archmax_wait` accepted), a pending decision, or a pending delegation (a
 * sub-workflow that stopped for a person).
 */
export function isParkingAnswer(answer: unknown): boolean {
  const update = (answer as { update?: Record<string, unknown> } | undefined)?.update;
  if (!update || typeof update !== "object") return false;
  const delegations = update.pendingDelegations;
  return (
    (update.pendingInput !== undefined && update.pendingInput !== null) ||
    (update.pendingDecision !== undefined && update.pendingDecision !== null) ||
    (Array.isArray(delegations) && delegations.length > 0)
  );
}
