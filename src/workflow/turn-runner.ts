/**
 * The turn runner: how one invocation on a session is driven. Every way a
 * session is entered goes through here, so all of them bind the session's run
 * zone and event context, stream the model's text as `agent-text-delta` events,
 * and settle to the same state the graph's `invoke` would.
 */
import type { RunnableConfig } from "@langchain/core/runnables";
import { INTERRUPT } from "@langchain/langgraph";
import type { WorkflowEventEmitter } from "../core/events.js";
import type { CompiledAgentGraph } from "../core/deepagents.js";
import { contentToString, isAiMessage } from "../core/messages.js";
import { currentWorkflowState } from "./state.js";
import { DEFAULT_SESSION_ID } from "../sessions/scope.js";

/** Drives one turn on a session: the graph's `invoke`/`stream`/`streamEvents`, session-bound. */
export interface TurnRunner {
  invoke(input: unknown, config?: RunnableConfig): Promise<Record<string, unknown>>;
  stream(input: unknown, config?: RunnableConfig): AsyncIterable<unknown>;
  streamEvents(input: unknown, config: RunnableConfig, options?: unknown): AsyncIterable<unknown>;
}

/** What binds a call to a session: the session zone's view and the event context, refusing a bad id. */
export type SessionBinder = <T>(sessionId: string, fn: () => Promise<T>) => Promise<T>;

export interface TurnRunnerOptions {
  graph: CompiledAgentGraph;
  emit: WorkflowEventEmitter;
  /** Bind `fn` to `sessionId` (session zone and event context); refuses an id that escapes its zone or shadows a reserved name. */
  bindSession: SessionBinder;
  /** The state deltas are attributed to before the graph reports one. */
  entryState: string;
}

export function sessionIdOfConfig(config: RunnableConfig | undefined): string {
  const id = config?.configurable?.thread_id;
  return typeof id === "string" && id ? id : DEFAULT_SESSION_ID;
}

/** Bind every step of an async iterable to the session: `next()` runs in the caller's context, so the binding is per step. */
async function* boundIterable<T>(
  sessionId: string,
  bind: TurnRunnerOptions["bindSession"],
  open: () => Promise<AsyncIterable<T>>,
): AsyncGenerator<T> {
  const iterator = (await bind(sessionId, open))[Symbol.asyncIterator]();
  for (;;) {
    const step = await bind(sessionId, () => iterator.next());
    if (step.done) return;
    yield step.value;
  }
}

export function createTurnRunner(opts: TurnRunnerOptions): TurnRunner {
  const { graph, emit, bindSession } = opts;

  /**
   * Drive one turn via LangGraph streaming (`["values", "messages"]`): each AI
   * chunk with text is an `agent-text-delta` attributed to the current state (a
   * non-streaming model yields one chunk, so deltas flow regardless); the result
   * is the last `values` chunk. A turn that fails mid-stream finalizes the text
   * streamed so far as `agent-text` events flagged `partial`, since the
   * governance hooks that emit the final `agent-text` never ran for it.
   */
  async function drive(input: unknown, config: RunnableConfig | undefined): Promise<Record<string, unknown>> {
    const stream = await graph.stream(input, {
      ...(config ?? {}),
      streamMode: ["values", "messages"],
    } as never);
    let state = opts.entryState;
    const streamedText = new Map<string, { text: string; messageId?: string }>();
    let result: Record<string, unknown> | undefined;
    // A parked turn ends with an interrupt chunk; reported the way `Pregel.invoke`
    // does — the last state with the interrupts under `__interrupt__`.
    const interrupts: unknown[] = [];
    try {
      for await (const item of stream as AsyncIterable<[string, unknown]>) {
        const [mode, payload] = item;
        if (mode === "messages") {
          const [chunk] = payload as [unknown, unknown];
          if (!isAiMessage(chunk)) continue;
          const msg = chunk as Record<string, unknown>;
          const text = contentToString(msg.content);
          if (!text) continue;
          const id = typeof msg.id === "string" && msg.id ? msg.id : undefined;
          const bucket = streamedText.get(id ?? "");
          if (bucket) bucket.text += text;
          else streamedText.set(id ?? "", { text, ...(id ? { messageId: id } : {}) });
          emit({ type: "agent-text-delta", state, text, ...(id ? { messageId: id } : {}) });
        } else if (mode === "values") {
          const values = payload as Record<string, unknown>;
          const interrupted = values[INTERRUPT];
          if (Array.isArray(interrupted)) {
            interrupts.push(...interrupted);
            continue;
          }
          result = values;
          state = currentWorkflowState(result, state);
        }
      }
      if (result === undefined) {
        if (interrupts.length > 0) return { [INTERRUPT]: interrupts };
        throw new Error("the turn's stream ended without a final state");
      }
      return interrupts.length > 0 ? { ...result, [INTERRUPT]: interrupts } : result;
    } catch (err) {
      // The one `agent-text` that may carry no id: nothing was committed.
      for (const { text, messageId } of streamedText.values()) {
        emit({ type: "agent-text", state, text, partial: true, ...(messageId ? { messageId } : {}) });
      }
      throw err;
    }
  }

  return {
    // `async`, so a refused session id is a rejection like every other failure of
    // the call, never a synchronous throw out of `invoke`.
    async invoke(input, config) {
      return bindSession(sessionIdOfConfig(config), () => drive(input, config));
    },
    stream(input, config) {
      return boundIterable(sessionIdOfConfig(config), bindSession, () =>
        graph.stream(input, config as never),
      );
    },
    streamEvents(input, config, options) {
      return boundIterable(sessionIdOfConfig(config), bindSession, async () =>
        graph.streamEvents(input, config, options),
      );
    },
  };
}

/**
 * The runner a **plain** (ungoverned) agent drives its graph through: the graph's
 * own `invoke`/`stream`/`streamEvents`, each bound to the session named by
 * `configurable.thread_id`. No machine means no state to attribute text deltas
 * to and no park to settle, so nothing here reshapes the graph's results; what
 * the binding buys is that the agent's `scratchpad/…` and offload paths land
 * under `<sessionId>/` in the session store exactly as a governed session's do,
 * and that a reserved or escaping id is refused before anything is written.
 */
export function createPlainTurnRunner(opts: { graph: CompiledAgentGraph; bindSession: SessionBinder }): TurnRunner {
  const { graph, bindSession } = opts;
  return {
    async invoke(input, config) {
      return bindSession(sessionIdOfConfig(config), () => graph.invoke(input as never, config));
    },
    stream(input, config) {
      return boundIterable(sessionIdOfConfig(config), bindSession, () => graph.stream(input as never, config as never));
    },
    streamEvents(input, config, options) {
      return boundIterable(sessionIdOfConfig(config), bindSession, async () =>
        graph.streamEvents(input as never, config, options),
      );
    },
  };
}
