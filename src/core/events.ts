/**
 * Workflow lifecycle diagnostics the harness emits during assembly and while a
 * machine-governed workflow runs. Every runtime diagnostic flows through this
 * single typed stream; callers subscribe via `onEvent` on
 * `CreateWorkflowAgentOptions`. With no subscriber, the harness installs
 * {@link consoleEventHandler} (`[workflow]` / `[interpreter]` / `[rubrics]`
 * console output).
 *
 * Two visual tiers: **node-change** events (`state-enter`, `state-leave`) render
 * at the outer level; **action** events (`hook-*`, `advance`, `agent-text`)
 * happen within a node and render indented beneath it.
 *
 * `callId` pairing rule: every event a tool call causes carries that call's
 * `callId` — its own `tool-called`/`tool-result` pair and the effects it produced
 * (`advance`, `parked`, `variables-set`, the sub-workflow pair). An event no call
 * caused (a turn's opening arrival, a human-node park, run-start seeding) omits
 * the field rather than carrying a synthetic id, so the set of events one call
 * produced is derivable from ids alone. No governed call is exempt,
 * `archmax_advance` included.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type WorkflowEventLevel = "info" | "warn" | "error";

/**
 * The `advance.from` marker for a turn's opening arrival at its state: a
 * transition with no prior state. Mirrors LangGraph's `START` constant, kept as
 * a local literal so this module stays free of a LangGraph dependency.
 */
export const SESSION_ORIGIN = "__start__";

/**
 * Where a tool call came from, on the tool events. Absent means the model called
 * the tool directly; a value marks a programmatic call from inside a sandbox
 * script (`script`) or a lifecycle hook (`lifecycle`).
 */
export type ToolEventOrigin = "script" | "lifecycle";

/** How a programmatic tool call's origin reads in human-facing output. */
export function originLabel(origin: ToolEventOrigin): string {
  return origin === "script" ? "script" : "lifecycle hook";
}

/**
 * Event payloads, without the severity level (added by the emitter). Every
 * `state` field carries a **state slug** — never a `title`, so a retitled node
 * emits byte-identical events.
 */
export type WorkflowEventPayload =
  // Assembly-time diagnostics.
  | { type: "interpreter-enabled" }
  | { type: "skills-loaded"; names: string[] }
  | { type: "hooks-summary"; summary: string }
  | { type: "graph-topology"; topology: string }
  // Warnings (machine-spec load, prompt resolution, run artifacts).
  | { type: "warning"; scope: string; message: string }
  // Node-change diagnostics (outer tier).
  | { type: "workflow-reset"; entry: string }
  | { type: "state-enter"; state: string }
  | { type: "state-leave"; state: string; next: string }
  | { type: "state-error-routed"; state: string; to: string; reason: string }
  // Per-node action diagnostics (inner tier).
  | { type: "hook-start"; state: string; phase: "before" | "after"; label: string }
  | { type: "hook-output"; state: string; line: string }
  | { type: "hook-passed"; state: string; phase: "before" | "after" }
  | {
      type: "hook-verdict";
      state: string;
      phase: "before" | "after";
      label: string;
      /** The hook's verdict, kept as the exact kernel vocabulary (never widened). */
      verdict: "ok" | "correct" | "veto";
      reason: string;
      missing?: string[];
    }
  | { type: "hook-rejected"; state: string; phase: "before" | "after"; reason: string }
  // A state transition. Emitted for the agent's `archmax_advance` transitions
  // (`from`/`to` are declared states, `reason` the agent's rationale) and once
  // per run for the initial entry into the start state, where `from` is
  // {@link SESSION_ORIGIN} (no prior state) and `reason` is absent.
  | {
      type: "advance";
      from: string;
      to: string;
      reason?: string;
      /**
       * The `archmax_advance` call that drove this transition, matching its
       * `tool-called`/`tool-result` pair. Absent for the turn's opening arrival
       * (`from` is {@link SESSION_ORIGIN}), which the turn boundary commits
       * rather than a call.
       */
      callId?: string;
    }
  | {
      type: "parked";
      /** The state the session parked at: a human state, or the state that waits. */
      state: string;
      sessionId: string;
      /**
       * Which channel the session awaits: a human's decision, or an external
       * event delivered as a trigger — so a subscriber can tell a waiting run
       * from an ended one without reading checkpoints.
       */
      awaiting: "decision" | "input";
      /**
       * For an agent park, why the agent is waiting — its own `archmax_wait`
       * reason. This is what a surface shows: an in-place park declares no
       * awaited trigger ids, since any delivered firing resumes it.
       */
      reason?: string;
      /**
       * Absolute time the park asked to be resumed at, when the wait declared
       * an `until`. A hint for whoever schedules the wake-up — the runtime holds
       * no timer.
       */
      resumeAt?: string;
      /**
       * The `archmax_wait` call that asked for this park, matching that call's
       * `tool-called`/`tool-result` pair. Absent for a human-node park: the run
       * routed there, and no call asked for it.
       */
      callId?: string;
    }
  | { type: "decided"; state: string; to: string; sessionId: string }
  // A message exchanged with a parked session: `inbound` is what the person said
  // while a decision is pending, `outbound` is the run's answer. The run's
  // position, record and trail are unchanged either way.
  | {
      type: "park-message";
      state: string;
      sessionId: string;
      direction: "inbound" | "outbound";
      text: string;
    }
  | {
      type: "delivered";
      state: string;
      /** The trigger id that resumed the park. */
      trigger: string;
      /**
       * The state the run continues in — the parked node itself, since a
       * delivery resumes in place rather than routing an edge.
       */
      to: string;
      sessionId: string;
    }
  // Assistant output. `agent-text-delta` streams each text chunk as the model
  // produces it; `agent-text` carries each new AI message's complete text after
  // the turn. `messageId` is shared between a message's deltas and its final
  // `agent-text`, so consumers can accumulate deltas and replace them.
  //
  // `messageId` rule: on `agent-text` the id is **always** present for a message
  // that reached state, and it is the id the message carries there (LangGraph's
  // reducer assigns one to every message arriving without it). That is what lets
  // a consumer attribute a message to the state visit that produced it and join
  // this stream to a persisted transcript.
  //
  // `partial: true` marks an `agent-text` emitted because the turn failed
  // mid-stream: the text is what accumulated before the failure and may be
  // incomplete. It is the one case where `messageId` may be absent — nothing was
  // committed, so an id exists only if the provider put one on its chunks.
  | { type: "agent-text"; state: string; text: string; messageId?: string; partial?: boolean }
  | { type: "agent-text-delta"; state: string; text: string; messageId?: string }
  // A governed tool call, announced when it passes governance and settled when
  // it returns. Emitted for **every** governed call, the runtime-serviced
  // workflow tools included (`withPairedEvents` in `workflow/middleware.ts`
  // holds the pairing for those).
  //
  // `callId` is the provider's own tool-call id whenever the call carries one —
  // the issuing AI message's `tool_calls[].id` and the settling
  // `ToolMessage.tool_call_id` — so a consumer joins the stream to a transcript
  // exactly. A call with no provider id gets a runtime-generated one, which
  // correlates the two events with each other but names no message.
  | {
      type: "tool-called";
      state: string;
      tool: string;
      callId?: string;
      args?: Record<string, unknown>;
      detail?: string;
      origin?: ToolEventOrigin;
    }
  | {
      type: "tool-result";
      state: string;
      tool: string;
      callId: string;
      status: "ok" | "error";
      durationMs: number;
      output: string;
      truncated: boolean;
      origin?: ToolEventOrigin;
    }
  // A variable write that landed. Names only, never values: a run variable can
  // hold a whole event payload, and a consumer rendering the stream must not be
  // the reason an oversized or sensitive value is echoed. A refused write emits
  // nothing — its refusal is already the tool's error result.
  | {
      type: "variables-set";
      /** State the write was made from, or absent for run-start seeding. */
      state?: string;
      names: string[];
      locked: boolean;
      /**
       * The `archmax_set_variables` call that wrote them, matching that call's
       * `tool-called`/`tool-result` pair. Absent for run-start seeding, which no
       * call made.
       */
      callId?: string;
    }
  // The run's title changed. Carries the **value**, which no other variable event
  // does: `title` is the one variable whose write check bounds it to a single
  // line of at most 200 characters, so the "names only" rule above keeps no
  // exception by making this its own event. Emitted from every path that changes
  // the stored title (agent write, delivery, run-start seeding); a write that
  // does not land emits nothing, as with `variables-set`.
  | {
      type: "title-set";
      /** The stored (trimmed) value. */
      title: string;
      /** State the write was made from, or absent for run-start seeding. */
      state?: string;
      /**
       * The `archmax_set_variables` call that wrote it, matching that call's
       * `tool-called`/`tool-result` pair. Absent when no call made the write.
       */
      callId?: string;
    }
  // A refused call. `callId`/`args` mirror `tool-called` — the refusal happens
  // before that event, so this is the call's only record, and a consumer needs
  // the model's own call id to match it against a persisted transcript.
  | {
      type: "tool-blocked";
      state: string;
      tool: string;
      reason: string;
      callId?: string;
      args?: Record<string, unknown>;
      origin?: ToolEventOrigin;
    }
  | { type: "rubric-start"; state: string; name: string; dispatchId: string }
  | {
      type: "rubric-result";
      state: string;
      name: string;
      dispatchId: string;
      status: "ok" | "error";
      durationMs: number;
    }
  // One sub-workflow dispatch, bracketed like a rubric dispatch. Emitted for
  // **refused** dispatches too (depth, cycle, unloadable target, unresolvable
  // prompt): a run that attempted a delegation and was stopped should not be
  // indistinguishable from one that never tried.
  | {
      type: "sub-workflow-start";
      /** The state the call was made from. */
      state: string;
      /** The child workflow slug. */
      workflow: string;
      dispatchId: string;
      /**
       * The tool call that started it, when one did. Concurrent sub-runs differ
       * in both this and `dispatchId`.
       */
      toolCallId?: string;
      /** How many delegations deep this sub-run is; `1` directly under a root run. */
      depth: number;
      /** The ancestor chain above it, when there is one. */
      chain?: string[];
    }
  | {
      type: "sub-workflow-result";
      state: string;
      workflow: string;
      dispatchId: string;
      /** The tool call this answers, matching its `sub-workflow-start`. */
      toolCallId?: string;
      /**
       * How the dispatch settled. `parked` is not an outcome but a suspension:
       * the child reached a human node (or waited), so the *parent* suspended
       * with it and the dispatch resumes when the decision arrives.
       */
      status: "ok" | "error" | "parked";
      durationMs: number;
      /** Why it failed; absent on success. */
      reason?: string;
      /**
       * The variables the sub-run returned, by **name** — absent when its target
       * declares no `returns`. Names only, never values (this is a diagnostic
       * channel); the values reach the parent as its `result:` variable.
       */
      returns?: string[];
    }
  // Token accounting for one turn, from the provider's own usage metadata. Cache
  // counts are zero when a provider reports none; `costUsd` is absent (never
  // zero) when the model is unpriced. Totals are the caller's to aggregate —
  // `createUsageTracker` does it per session. See `core/usage.ts`.
  | {
      type: "model-usage";
      state: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      model?: string;
      costUsd?: number;
    }
  // The resolved model-facing payload shape for this assembly: the prompt-cache
  // mechanism resolved for the model, and any built-in tools the assembly
  // withholds. `cache` is a `PromptCacheStrategy`, kept as a plain string here so
  // this core module stays independent of `workflow/`.
  | {
      type: "prompt-shaping";
      cache: string;
      withheld: string[];
    };

/**
 * Metadata stamped on every delivered event: emission time, a sequence number
 * that is strictly increasing across all events delivered to the same handler
 * (i.e. the same assembled agent), and — when a session context is bound — the
 * session the event belongs to, so one handler can demultiplex concurrent runs.
 */
export interface WorkflowEventEnvelope {
  ts: number;
  seq: number;
  sessionId?: string;
  /**
   * The sub-workflow dispatch this event was emitted inside, when it was. A
   * sub-run has its own session but shares its caller's event handler, so
   * without this a child's `state-enter` would read as the parent moving to
   * that state. Absent for everything a run does on its own behalf.
   */
  subWorkflowDispatchId?: string;
}

/** A lifecycle event as delivered to subscribers: payload, severity, envelope. */
export type WorkflowLifecycleEvent = WorkflowEventPayload &
  { level: WorkflowEventLevel } & WorkflowEventEnvelope;

/** Callback signature for {@link WorkflowLifecycleEvent} subscribers. */
export type WorkflowEventHandler = (event: WorkflowLifecycleEvent) => void;

/** Payload with an optional explicit level override (else derived per type). */
export type WorkflowEventInput = WorkflowEventPayload & { level?: WorkflowEventLevel };

/** Internal emitter shape: accepts payloads, fills in the level, delivers. */
export type WorkflowEventEmitter = (event: WorkflowEventInput) => void;

function defaultLevel(event: WorkflowEventPayload): WorkflowEventLevel {
  switch (event.type) {
    case "warning":
    case "tool-blocked":
    case "hook-rejected":
      return "warn";
    case "tool-result":
    case "rubric-result":
    case "sub-workflow-result":
      return event.status === "error" ? "warn" : "info";
    default:
      return "info";
  }
}

/**
 * Ambient session binding for the event envelope. The turn runner binds it
 * around each invoke so every event emitted while a session executes — from any
 * emitter instance — carries that session's id without threading it through
 * every emit call site.
 */
const eventContext = new AsyncLocalStorage<EventContext>();

/** What the ambient binding contributes to every event's envelope. */
export interface EventContext {
  sessionId: string;
  /** Set while a sub-run executes, so its events can be told from its parent's. */
  subWorkflowDispatchId?: string;
}

/**
 * Run `fn` with the ambient event-envelope context bound. Nested calls
 * **inherit** what they do not override: a sub-run binds its dispatch id without
 * having to restate the session id it is running on.
 */
export function withEventContext<T>(context: Partial<EventContext> & { sessionId?: string }, fn: () => T): T {
  const current = eventContext.getStore();
  const merged: EventContext = {
    sessionId: context.sessionId ?? current?.sessionId ?? "",
    ...(context.subWorkflowDispatchId ?? current?.subWorkflowDispatchId
      ? {
          subWorkflowDispatchId:
            context.subWorkflowDispatchId ?? current?.subWorkflowDispatchId,
        }
      : {}),
  };
  return eventContext.run(merged, fn);
}

/**
 * Per-handler sequence counters. Many emitter instances deliver to one
 * handler (one assembled agent), so the counter is keyed by the handler to
 * keep `seq` strictly increasing across everything that agent observes.
 */
const seqByHandler = new WeakMap<WorkflowEventHandler, { n: number }>();

function nextSeq(handler: WorkflowEventHandler): number {
  let counter = seqByHandler.get(handler);
  if (!counter) {
    counter = { n: 0 };
    seqByHandler.set(handler, counter);
  }
  return ++counter.n;
}

/**
 * Build the runtime's event emitter: fills in each event's severity level and
 * envelope (`ts`, `seq`, ambient `sessionId`) and delivers it to `handler`,
 * defaulting to {@link consoleEventHandler} so diagnostics are never silently
 * dropped.
 */
export function createWorkflowEventEmitter(handler?: WorkflowEventHandler): WorkflowEventEmitter {
  const deliver = handler ?? consoleEventHandler;
  return (event) => {
    const { level, ...payload } = event;
    const sessionId =
      (payload as { sessionId?: string }).sessionId ?? eventContext.getStore()?.sessionId;
    const dispatchId = eventContext.getStore()?.subWorkflowDispatchId;
    deliver({
      ...payload,
      level: level ?? defaultLevel(payload as WorkflowEventPayload),
      ts: Date.now(),
      seq: nextSeq(deliver),
      ...(sessionId ? { sessionId } : {}),
      ...(dispatchId ? { subWorkflowDispatchId: dispatchId } : {}),
    } as WorkflowLifecycleEvent);
  };
}

/**
 * The default console line for an event, or `null` for events the console
 * output does not show (`tool-called`, `agent-text`).
 */
export function renderEventLine(event: WorkflowLifecycleEvent): string | null {
  switch (event.type) {
    case "interpreter-enabled":
      return "[interpreter] enabled (ptc: all agent tools)";
    case "skills-loaded":
      return `[skills] loaded: ${event.names.join(", ")}`;
    case "hooks-summary":
      return `[workflow] lifecycle: ${event.summary}`;
    case "graph-topology":
      return `[workflow] LangGraph graph:\n  ${event.topology}`;
    case "warning":
      return `[${event.scope}] ${event.message}`;
    case "workflow-reset":
      return `[workflow] reset to entry '${event.entry}'`;
    case "state-enter":
      return `[workflow] entering node '${event.state}'`;
    case "state-leave":
      return `[workflow] leaving node '${event.state}' -> workflowState=${event.next}`;
    case "state-error-routed":
      return `[workflow] '${event.state}' failed -> routing to on_error '${event.to}': ${event.reason}`;
    case "hook-start":
      return `[workflow] ${event.phase} '${event.state}': running ${event.label}`;
    case "hook-output":
      return `[workflow:${event.state}] ${event.line}`;
    case "hook-passed":
      return `[workflow] '${event.state}' ${event.phase}-script passed`;
    case "hook-verdict": {
      const missing = event.missing?.length ? ` (missing: ${event.missing.join(", ")})` : "";
      return `[workflow:${event.state}] ${event.label}: ${event.verdict.toUpperCase()} — ${event.reason}${missing}`;
    }
    case "hook-rejected":
      return `[workflow] '${event.state}' ${event.phase} REJECTED: ${event.reason}`;
    case "advance":
      return event.from === SESSION_ORIGIN
        ? `[workflow] entering start state '${event.to}'`
        : `[workflow] advanced '${event.from}' -> '${event.to}'${event.reason ? `: ${event.reason}` : ""}`;
    case "parked":
      return event.awaiting === "input"
        ? `[workflow] parked in '${event.state}' awaiting an event${
            event.reason ? `: ${event.reason}` : ""
          }${event.resumeAt ? ` (due ${event.resumeAt})` : ""} (session ${event.sessionId})`
        : `[workflow] parked at human node '${event.state}' awaiting a decision (session ${event.sessionId})`;
    case "decided":
      return `[workflow] decision at '${event.state}' routed to '${event.to}' (session ${event.sessionId})`;
    case "park-message":
      return (
        `[workflow] ${event.direction === "inbound" ? "message to" : "reply from"} the run parked ` +
        `at '${event.state}' (session ${event.sessionId})`
      );
    case "delivered":
      return `[workflow] '${event.trigger}' delivered to '${event.state}', resuming it (session ${event.sessionId})`;
    case "variables-set":
      return `[workflow] variables set${event.state ? ` in ${event.state}` : ""}: ${
        event.names.join(", ")
      }${event.locked ? " (locked)" : ""}`;
    case "title-set":
      // Printed in full: the write check bounds a title to one short line, so
      // there is nothing here to cap or elide.
      return `[workflow] title set${event.state ? ` in ${event.state}` : ""}: ${event.title}`;
    case "tool-blocked":
      // A refused programmatic call says so: the reason names a tool and a
      // state, and without this an author would look for the call in the
      // model's transcript, where it never appears.
      return event.origin ? `${event.reason} (called from a ${originLabel(event.origin)})` : event.reason;
    case "prompt-shaping":
      return (
        `[workflow] prompt cache ${event.cache}` +
        (event.withheld.length ? ` (withheld: ${event.withheld.join(", ")})` : "")
      );
    case "sub-workflow-start":
      return `[workflow] running sub-workflow '${event.workflow}' from '${event.state}'`;
    case "sub-workflow-result":
      if (event.status === "parked") {
        return `[workflow] sub-workflow '${event.workflow}' parked, suspending the run with it`;
      }
      return event.status === "ok"
        ? `[workflow] sub-workflow '${event.workflow}' completed (${event.durationMs}ms)`
        : `[workflow] sub-workflow '${event.workflow}' failed: ${event.reason ?? "unknown error"}`;
    case "tool-called":
    case "agent-text":
    case "agent-text-delta":
    case "tool-result":
    case "rubric-start":
    case "rubric-result":
    case "model-usage":
      // Accounting is not console output: the CLI renders its own usage footer
      // from its own subscriber, so a line here would duplicate it.
      return null;
  }
}

/**
 * Default subscriber: renders events with the established console prefixes.
 * Installed by the harness when the caller supplies no `onEvent` handler.
 */
export const consoleEventHandler: WorkflowEventHandler = (event) => {
  const line = renderEventLine(event);
  if (line == null) return;
  if (event.level === "info") console.log(line);
  else console.warn(line);
};
