/**
 * The turn runner: how one invocation on a session is driven. Every way a
 * session is entered goes through here, so all of them bind the session's run
 * zone and event context, stream the model's text as `agent-text-delta` events,
 * and settle to the same state the graph's `invoke` would.
 */
import type { RunnableConfig } from "@langchain/core/runnables";
import { Command, GraphRecursionError, INTERRUPT } from "@langchain/langgraph";
import { context } from "@opentelemetry/api";
import type { WorkflowEventEmitter } from "../core/events.js";
import type { CompiledAgentGraph } from "../core/deepagents.js";
import { contentToString, isAiMessage } from "../core/messages.js";
import type { Telemetry, TurnHandle, TurnSettled, TurnStart } from "../core/telemetry.js";
import { currentWorkflowState, readWorkflowState, WORKFLOW_STATUSES } from "./state.js";
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
  /** Where the turn's span goes, and the workflow and state types it is named by. */
  telemetry: TurnTelemetry;
}

/** What a turn's span is opened with: the assembly's telemetry, and how this composition names its turns. */
export interface TurnTelemetry {
  telemetry: Telemetry;
  /** The workflow slug; absent for a plain agent. */
  workflow?: string;
  /** A state's type, for a governed turn's state spans. */
  stateType?: (slug: string) => string | undefined;
}

export function sessionIdOfConfig(config: RunnableConfig | undefined): string {
  const id = config?.configurable?.thread_id;
  return typeof id === "string" && id ? id : DEFAULT_SESSION_ID;
}

/** The start of a turn's span: a resume (a decision, a reply, a delivery) is a command to the parked graph. */
function turnStart(turn: TurnTelemetry, sessionId: string, input: unknown): TurnStart {
  return {
    sessionId,
    resume: input instanceof Command,
    ...(turn.workflow ? { workflow: turn.workflow } : {}),
    ...(turn.stateType ? { stateType: turn.stateType } : {}),
  };
}

/** How a governed turn settled, from the session's values: its status and the state it is in. */
function settledFrom(values: unknown): TurnSettled {
  const status = (values as { status?: unknown } | undefined)?.status;
  const state = readWorkflowState(values).workflowState;
  return {
    ...(typeof status === "string" ? { status } : {}),
    ...(typeof state === "string" ? { state } : {}),
  };
}

/**
 * Bind every step of an async iterable to the session: `next()` runs in the
 * caller's context, so the binding — the turn's span among it — is per step.
 * The turn's span opens with the stream and ends when the iterator does: at its
 * last step (settled from `settled`, read only when a provider records it), at
 * a throw, or when the consumer stops reading.
 */
async function* boundIterable<T>(
  sessionId: string,
  bind: TurnRunnerOptions["bindSession"],
  open: () => Promise<AsyncIterable<T>>,
  turn: { telemetry: Telemetry; start: TurnStart; settled?: () => Promise<TurnSettled> },
): AsyncGenerator<T> {
  let handle: TurnHandle | undefined;
  const inTurn = <R>(fn: () => Promise<R>): Promise<R> => (handle ? context.with(handle.context, fn) : fn());
  try {
    const iterable = await bind(sessionId, () => {
      handle = turn.telemetry.openTurn(turn.start);
      return inTurn(open);
    });
    const iterator = iterable[Symbol.asyncIterator]();
    for (;;) {
      const step = await bind(sessionId, () => inTurn(() => iterator.next()));
      if (step.done) break;
      yield step.value;
    }
    let settled: TurnSettled = {};
    if (handle?.recording && turn.settled) {
      try {
        settled = await bind(sessionId, turn.settled);
      } catch {
        // Reading how the turn ended is reporting, never the turn's failure.
      }
    }
    handle?.end(settled);
  } catch (err) {
    handle?.fail(err);
    throw err;
  } finally {
    // The consumer stopped reading: the turn's span ends where it did.
    handle?.end();
  }
}

export function createTurnRunner(opts: TurnRunnerOptions): TurnRunner {
  const { graph, emit, bindSession } = opts;
  const { telemetry } = opts.telemetry;
  /** The session's values after a streamed turn, for its span. */
  const settledOf = (sessionId: string) => async () =>
    settledFrom(
      ((await graph.getState({ configurable: { thread_id: sessionId } })) as { values?: unknown } | undefined)?.values,
    );

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
      await endFailed(config, err);
      throw err;
    }
  }

  /**
   * A turn that throws while the session is still `running` would leave it
   * refused for good, so it ends `failed` with an exit record, as `archmax_raise`
   * would, and the next message starts a fresh turn. A park is left as it is.
   */
  async function endFailed(config: RunnableConfig | undefined, err: unknown): Promise<void> {
    const at = { configurable: { thread_id: sessionIdOfConfig(config) } };
    try {
      const values = ((await graph.getState(at)) as { values?: Record<string, unknown> } | undefined)?.values ?? {};
      if (values.status !== WORKFLOW_STATUSES.running) return;
      const code =
        err instanceof GraphRecursionError
          ? "recursion-limit"
          : config?.signal?.aborted || (err as Error)?.name === "AbortError"
            ? "turn-cancelled"
            : "turn-error";
      const reason = err instanceof Error ? err.message : String(err);
      await graph.updateState(at, {
        status: WORKFLOW_STATUSES.failed,
        raised: { code, reason, state: currentWorkflowState(values, opts.entryState) },
      });
    } catch (failure) {
      // The original error is what the caller needs; this one only explains why the session stayed `running`.
      emit({ type: "warning", scope: "session", message: `could not end the failed turn: ${(failure as Error).message}` });
    }
  }

  return {
    // `async`, so a refused session id is a rejection like every other failure of
    // the call, never a synchronous throw out of `invoke`.
    async invoke(input, config) {
      const sessionId = sessionIdOfConfig(config);
      return bindSession(sessionId, () =>
        telemetry.turn(turnStart(opts.telemetry, sessionId, input), () => drive(input, config), settledFrom),
      );
    },
    stream(input, config) {
      const sessionId = sessionIdOfConfig(config);
      return boundIterable(sessionId, bindSession, () => graph.stream(input, config as never), {
        telemetry,
        start: turnStart(opts.telemetry, sessionId, input),
        settled: settledOf(sessionId),
      });
    },
    streamEvents(input, config, options) {
      const sessionId = sessionIdOfConfig(config);
      return boundIterable(sessionId, bindSession, async () => graph.streamEvents(input, config, options), {
        telemetry,
        start: turnStart(opts.telemetry, sessionId, input),
        settled: settledOf(sessionId),
      });
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
export function createPlainTurnRunner(opts: {
  graph: CompiledAgentGraph;
  bindSession: SessionBinder;
  telemetry: TurnTelemetry;
}): TurnRunner {
  const { graph, bindSession } = opts;
  const { telemetry } = opts.telemetry;
  return {
    async invoke(input, config) {
      const sessionId = sessionIdOfConfig(config);
      return bindSession(sessionId, () =>
        telemetry.turn(
          turnStart(opts.telemetry, sessionId, input),
          () => graph.invoke(input as never, config) as Promise<Record<string, unknown>>,
          () => ({}),
        ),
      );
    },
    stream(input, config) {
      const sessionId = sessionIdOfConfig(config);
      return boundIterable(sessionId, bindSession, () => graph.stream(input as never, config as never), {
        telemetry,
        start: turnStart(opts.telemetry, sessionId, input),
      });
    },
    streamEvents(input, config, options) {
      const sessionId = sessionIdOfConfig(config);
      return boundIterable(sessionId, bindSession, async () => graph.streamEvents(input as never, config, options), {
        telemetry,
        start: turnStart(opts.telemetry, sessionId, input),
      });
    },
  };
}
