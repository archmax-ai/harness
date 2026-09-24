import { AIMessage } from "@langchain/core/messages";
import type { ToolMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { Graph } from "@langchain/core/runnables/graph";
import type { StructuredTool } from "@langchain/core/tools";
import type {
  AgentMiddleware,
  BuiltInState,
  ModelRequest,
  Runtime,
  ToolCallHandler,
  ToolCallRequest,
} from "langchain";
import type { DeepAgent } from "deepagents";
import type { WorkflowStateFields } from "../workflow/state.js";

/**
 * The single typed seam between this runtime and its agent framework
 * (`deepagents` / `langchain` / `langgraph`). Every place the runtime reaches
 * into a framework request object, drives the Deep Agent graph, or introspects a
 * compiled graph does so through the aliases and helpers defined here — so a
 * framework reshape surfaces at `tsc` in this module (and its call sites) rather
 * than at runtime. Keep it thin: aliases over the framework's own generics plus
 * a couple of narrowing helpers, not a re-abstraction of the framework.
 *
 * This is the only runtime module permitted to depend on the framework's
 * middleware/introspection seam types.
 */

// --- Middleware request/handler aliases ------------------------------------

/**
 * Agent state the workflow middleware sees on every framework request: the
 * checkpointed workflow fields (derived once from the zod `workflowStateSchema`)
 * intersected with the framework's built-in agent state (messages, etc.).
 */
export type WorkflowRequestState = WorkflowStateFields & BuiltInState & Record<string, unknown>;

/** A model-call request carrying the workflow state (for `wrapModelCall`). */
export type ModelCallRequest = ModelRequest<WorkflowRequestState>;

/**
 * The structured-output result the framework's model handler returns when the
 * agent was assembled with a `responseFormat` — a plain object, not a message.
 */
export interface StructuredModelResult {
  structuredResponse: unknown;
  messages: unknown[];
}

/**
 * What a `wrapModelCall` handler may hand back, and therefore what a middleware
 * may return: a settled `AIMessage`, a LangGraph `Command`, or a
 * {@link StructuredModelResult}. `Command` is typed structurally by the one field
 * the framework's own `isCommand` duck-types on, so this seam does not depend on
 * a `Command` class identity that a second copy of `@langchain/langgraph` would
 * break.
 */
export type ModelCallResult = AIMessage | { lg_name: "Command" } | StructuredModelResult;

/**
 * What a `wrapModelCall` hook must be *declared* to return. The framework's own
 * hook type names only `AIMessage | Command`, while its agent node additionally
 * accepts (and its own base handler produces) a {@link StructuredModelResult} —
 * so this alias tracks the declaration and {@link asModelCallResult} bridges the
 * gap in one place instead of at every middleware.
 */
export type ModelCallHookResult = Awaited<
  ReturnType<NonNullable<AgentMiddleware["wrapModelCall"]>>
>;

/**
 * The handler that runs the model for a (possibly modified) request. The
 * workflow middleware forwards its request through this to invoke the model.
 */
export type ModelCallHandler = (
  request: ModelCallRequest,
) => ModelCallResult | Promise<ModelCallResult>;

/** A tool-call request carrying the workflow state (for `wrapToolCall`). */
export type WorkflowToolCallRequest = ToolCallRequest<WorkflowRequestState>;

/** The handler that executes a (possibly modified) tool call. */
export type WorkflowToolCallHandler = ToolCallHandler<WorkflowRequestState>;

/**
 * A generic tool-call request for middleware that declares no state schema
 * (e.g. the evals tool-mock middleware). The optional `config` mirror is a
 * defensive fallback for runtimes that surface `configurable` under `config`
 * instead of `runtime`.
 */
export type AnyToolCallRequest = ToolCallRequest & {
  config?: { configurable?: Record<string, unknown> };
};

/** A generic model-call request for middleware that declares no state schema. */
export type AnyModelCallRequest = ModelRequest;

/** The handler that executes a (possibly modified) generic tool call. */
export type AnyToolCallHandler = ToolCallHandler;

/** The handler that runs the model for a generic model-call request. */
export type AnyModelCallHandler = (
  request: AnyModelCallRequest,
) => ModelCallResult | Promise<ModelCallResult>;

/** The framework runtime handed to lifecycle hooks (context, configurable, signal, store). */
export type FrameworkRuntime = Runtime;

export type { ToolMessage };

/**
 * Bridge the framework's tool-surface type (`(ServerTool | ClientTool)[]`) to
 * the `StructuredTool[]` the runtime works with. The runtime only ever binds
 * `StructuredTool`s, so this narrowing is sound; confining it here keeps the one
 * tool-surface cast out of the middleware.
 */
export function asStructuredTools(tools: ModelCallRequest["tools"] | undefined): StructuredTool[] {
  return (tools ?? []) as unknown as StructuredTool[];
}

// --- Model-call result narrowing -------------------------------------------

/** Fields of an AI message the agent loop needs carried across a repair. */
interface AiMessageLike {
  content: string | unknown[];
  tool_calls?: unknown[];
  invalid_tool_calls?: unknown[];
  additional_kwargs?: Record<string, unknown>;
  response_metadata?: Record<string, unknown>;
  usage_metadata?: unknown;
  id?: string;
  name?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStructuredModelResult(value: unknown): value is StructuredModelResult {
  return isRecord(value) && "structuredResponse" in value && "messages" in value;
}

/** The framework's own `Command` test: a duck-typed `lg_name` marker. */
function isCommandLike(value: unknown): value is { lg_name: "Command" } {
  return isRecord(value) && value.lg_name === "Command";
}

/**
 * An AI message in all but class identity: a plain object that *says* it is the
 * assistant's turn — LangChain's `type: "ai"` (an `AIMessage` built against a
 * second copy of `@langchain/core`, whose brand this copy does not recognize) or
 * the chat protocol's `role: "assistant"` (a provider dict) — with `content` the
 * framework accepts. A message that names no role is not repaired here: the
 * provider seam (`createChatModel` in `env.ts`) reads a role-less response as the
 * assistant's before it reaches the agent loop.
 */
function asAiMessageLike(value: unknown): AiMessageLike | undefined {
  if (!isRecord(value)) return undefined;
  const { content } = value;
  if (typeof content !== "string" && !Array.isArray(content)) return undefined;
  const declaredType =
    typeof value._getType === "function" ? (value._getType as () => unknown)() : value.type;
  const isAi = declaredType === "ai" || value.role === "assistant";
  return isAi ? (value as unknown as AiMessageLike) : undefined;
}

/**
 * Narrow what a `wrapModelCall` handler returned to the framework's contract.
 *
 * The agent node validates each middleware's *return* value, so when the model
 * handler below the stack yields something outside the contract, the innermost
 * middleware is the one named — even though it only forwarded the value. An
 * `AIMessage`, a `Command` or a {@link StructuredModelResult} passes through; a
 * value that is an assistant message in all but class identity is rebuilt into a
 * real `AIMessage`; anything else is refused with the shape it actually had,
 * naming the model rather than the middleware.
 */
export function asModelCallResult(result: unknown, origin: string): ModelCallHookResult {
  if (AIMessage.isInstance(result) || isCommandLike(result) || isStructuredModelResult(result)) {
    // The one widening cast: a structured-output result is outside the framework's
    // declared hook return type but inside what its agent node accepts.
    return result as ModelCallHookResult;
  }
  const messageLike = asAiMessageLike(result);
  if (messageLike) {
    return new AIMessage({
      content: messageLike.content as AIMessage["content"],
      ...(messageLike.tool_calls ? { tool_calls: messageLike.tool_calls as never } : {}),
      ...(messageLike.invalid_tool_calls
        ? { invalid_tool_calls: messageLike.invalid_tool_calls as never }
        : {}),
      ...(messageLike.additional_kwargs ? { additional_kwargs: messageLike.additional_kwargs } : {}),
      ...(messageLike.response_metadata ? { response_metadata: messageLike.response_metadata } : {}),
      ...(messageLike.usage_metadata ? { usage_metadata: messageLike.usage_metadata as never } : {}),
      ...(messageLike.id ? { id: messageLike.id } : {}),
      ...(messageLike.name ? { name: messageLike.name } : {}),
    });
  }
  throw new Error(
    `The model call in '${origin}' returned ${describeModelResult(result)}, which is neither ` +
      `an AIMessage, a Command, nor a structured-output result. The value comes from the model ` +
      `(or from a middleware assembled inside this one), not from workflow governance — check ` +
      `the configured chat model and its provider response.`,
  );
}

/**
 * A short, non-leaking description of a rejected model result. Names the message
 * kind (LangChain's `type`, and the class it arrived as) when the value is
 * message-shaped — that is what identifies which turn a provider claimed.
 */
function describeModelResult(result: unknown): string {
  if (result === null) return "null";
  if (result === undefined) return "undefined";
  if (!isRecord(result)) return `a ${typeof result}`;
  const keys = Object.keys(result);
  const shown = keys.slice(0, 8).join(", ");
  const shape = `a plain object with keys [${shown}${keys.length > 8 ? ", …" : ""}]`;
  const kind = typeof result.type === "string" ? `type '${result.type}'` : undefined;
  const className =
    typeof result.constructor === "function" && result.constructor.name !== "Object"
      ? result.constructor.name
      : undefined;
  const named = [kind, className].filter(Boolean).join(", ");
  return named === "" ? shape : `${shape} (${named})`;
}

// --- Defaults -----------------------------------------------------------------

/**
 * The `recursionLimit` a turn runs under when the caller names none. One invoke
 * is one whole turn across states — every hook, model call and tool batch is a
 * super-step — so this is generous by design: the authored budgets
 * (`budget.maxTurns`, `maxParks`) are the real bound, and this only stops a
 * run nothing else bounds.
 */
export const DEFAULT_RECURSION_LIMIT = 400;

// --- The compiled graph an assembly wraps ----------------------------------

/** The input a Deep Agent graph is invoked with: messages plus any state channel. */
export type AgentInput = Parameters<DeepAgent["invoke"]>[0];

/** The settled state a Deep Agent graph resolves to. */
export type AgentResult = Awaited<ReturnType<DeepAgent["invoke"]>>;

/** The options object accepted by a Deep Agent graph's `stream`. */
export type AgentStreamOptions = Parameters<DeepAgent["stream"]>[1];

/**
 * The compiled graph an assembly is built over: the Deep Agent's own
 * `CompiledStateGraph` — a real Pregel runnable — so the surface below is the
 * framework's own, not a re-abstraction. Declared structurally because the
 * governed and plain graphs' state generics differ while their runtime surface
 * is identical; the runtime only ever drives them through these members.
 */
export interface CompiledAgentGraph {
  invoke(input: AgentInput, config?: RunnableConfig): Promise<AgentResult>;
  stream(input: AgentInput, options?: AgentStreamOptions): Promise<AsyncIterable<unknown>>;
  streamEvents(input: AgentInput, config: RunnableConfig, options?: unknown): AsyncIterable<unknown>;
  withConfig(config: RunnableConfig): CompiledAgentGraph;
  getState(config: RunnableConfig, options?: unknown): Promise<unknown>;
  getStateHistory(config: RunnableConfig, options?: unknown): AsyncIterableIterator<unknown>;
  updateState(config: RunnableConfig, values: unknown, asNode?: string): Promise<RunnableConfig>;
  getSubgraphs(namespace?: string, recurse?: boolean): Generator<[string, unknown]>;
  getSubgraphsAsync(namespace?: string, recurse?: boolean): AsyncGenerator<[string, unknown]>;
  getGraphAsync(config?: RunnableConfig): Promise<Graph>;
  checkpointer?: unknown;
  store?: unknown;
}

/**
 * Narrow a compiled graph to {@link CompiledAgentGraph}. The governed and plain
 * graphs' declared state generics differ, so neither is assignable to a shared
 * type by structure alone; at run time both are the same `CompiledStateGraph`
 * class, and this is the one place that fact is asserted.
 */
export function asCompiledAgentGraph(graph: unknown): CompiledAgentGraph {
  return graph as CompiledAgentGraph;
}

// --- Compiled-graph introspection ------------------------------------------

/** Minimal shape needed to serialize a compiled LangGraph runnable's topology. */
export interface IntrospectableGraph {
  getGraphAsync(config: RunnableConfig): Promise<Graph>;
}

/**
 * The narrow view of a compiled state graph the human-decision surface needs:
 * read a parked session's checkpoint (`getState`) and resume it (`invoke`).
 */
export interface IntrospectableStateGraph {
  getState(config: unknown): Promise<{
    values?: Record<string, unknown>;
    tasks?: { interrupts?: unknown[] }[];
  }>;
  invoke(input: unknown, config: unknown): Promise<Record<string, unknown>>;
}

/**
 * The compiled state-graph methods the decision surface calls. The signatures
 * are intentionally permissive (`...args: never[]`) so this gates on the methods
 * *existing* rather than on their exact generic variance: a framework that drops
 * or renames `getState`/`invoke` fails at the call site, while a benign
 * parameter-type reshape does not produce noise. The exact call shapes are
 * enforced inside {@link decide} against {@link IntrospectableStateGraph}.
 */
export interface DecisionGraphSource {
  getState(...args: never[]): unknown;
  invoke(...args: never[]): unknown;
}

/**
 * Narrow a compiled state graph to {@link IntrospectableStateGraph}. The single
 * remaining framework cast lives here (design D3): the compiled graph's
 * `getState`/`invoke` are structurally compatible but their generic
 * input/return types do not unify with the narrow introspection shape without
 * widening. Containing the cast in one place keeps every call site typed against
 * {@link DecisionGraphSource}.
 */
export function asDecisionGraph(graph: DecisionGraphSource): IntrospectableStateGraph {
  return graph as unknown as IntrospectableStateGraph;
}
