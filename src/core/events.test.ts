import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consoleEventHandler,
  createWorkflowEventEmitter,
  renderEventLine,
  SESSION_ORIGIN,
  withEventContext,
  type WorkflowLifecycleEvent,
} from "./events.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Envelope stub for tests that hand-construct delivered events. */
const env = { ts: 0, seq: 0 };

describe("createWorkflowEventEmitter", () => {
  it("fills in the default level per event type", () => {
    const events: WorkflowLifecycleEvent[] = [];
    const emit = createWorkflowEventEmitter((e) => events.push(e));

    emit({ type: "state-enter", state: "a" });
    emit({ type: "tool-blocked", state: "a", tool: "read_file", reason: "blocked" });
    emit({ type: "warning", scope: "workflow", message: "bad spec" });

    expect(events.map((e) => e.level)).toEqual(["info", "warn", "warn"]);
  });

  it("levels result events by their status", () => {
    const events: WorkflowLifecycleEvent[] = [];
    const emit = createWorkflowEventEmitter((e) => events.push(e));

    emit({
      type: "tool-result",
      state: "a",
      tool: "read_file",
      callId: "c1",
      status: "ok",
      durationMs: 5,
      output: "",
      truncated: false,
    });
    emit({
      type: "tool-result",
      state: "a",
      tool: "read_file",
      callId: "c2",
      status: "error",
      durationMs: 5,
      output: "boom",
      truncated: false,
    });
    emit({
      type: "rubric-result",
      state: "a",
      name: "judge",
      dispatchId: "d1",
      status: "error",
      durationMs: 5,
    });

    expect(events.map((e) => e.level)).toEqual(["info", "warn", "warn"]);
  });

  it("respects an explicit level override", () => {
    const events: WorkflowLifecycleEvent[] = [];
    const emit = createWorkflowEventEmitter((e) => events.push(e));

    emit({ type: "hook-output", state: "a", line: "script error", level: "warn" });

    expect(events[0]).toMatchObject({
      type: "hook-output",
      state: "a",
      line: "script error",
      level: "warn",
    });
  });

  it("stamps a timestamp and a strictly increasing sequence", () => {
    const events: WorkflowLifecycleEvent[] = [];
    const handler = (e: WorkflowLifecycleEvent) => events.push(e);
    // Many emitter instances deliver to one handler (one assembled agent);
    // `seq` must stay strictly increasing across all of them.
    const emitA = createWorkflowEventEmitter(handler);
    const emitB = createWorkflowEventEmitter(handler);

    const before = Date.now();
    emitA({ type: "state-enter", state: "a" });
    emitB({ type: "state-enter", state: "b" });
    emitA({ type: "state-enter", state: "c" });

    for (const event of events) {
      expect(event.ts).toBeGreaterThanOrEqual(before);
      expect(event.ts).toBeLessThanOrEqual(Date.now());
    }
    const seqs = events.map((e) => e.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("stamps the ambient sessionId bound via withEventContext", () => {
    const events: WorkflowLifecycleEvent[] = [];
    const emit = createWorkflowEventEmitter((e) => events.push(e));

    emit({ type: "state-enter", state: "outside" });
    withEventContext({ sessionId: "t-42" }, () => {
      emit({ type: "state-enter", state: "inside" });
    });

    expect(events[0].sessionId).toBeUndefined();
    expect(events[1].sessionId).toBe("t-42");
  });

  it("keeps an explicit payload sessionId over the ambient one", () => {
    const events: WorkflowLifecycleEvent[] = [];
    const emit = createWorkflowEventEmitter((e) => events.push(e));

    withEventContext({ sessionId: "ambient" }, () => {
      emit({ type: "parked", state: "review", sessionId: "explicit", awaiting: "decision" });
    });

    expect(events[0].sessionId).toBe("explicit");
  });

  it("propagates the ambient sessionId across awaits", async () => {
    const events: WorkflowLifecycleEvent[] = [];
    const emit = createWorkflowEventEmitter((e) => events.push(e));

    await withEventContext({ sessionId: "t-async" }, async () => {
      await Promise.resolve();
      emit({ type: "state-enter", state: "later" });
    });

    expect(events[0].sessionId).toBe("t-async");
  });

  it("defaults to the console subscriber when no handler is supplied", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const emit = createWorkflowEventEmitter();

    emit({ type: "state-enter", state: "first" });
    emit({ type: "warning", scope: "workflow", message: "invalid machine spec" });

    expect(logSpy).toHaveBeenCalledWith("[workflow] entering node 'first'");
    expect(warnSpy).toHaveBeenCalledWith("[workflow] invalid machine spec");
  });
});

describe("consoleEventHandler", () => {
  it("skips events the legacy console output never showed", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    consoleEventHandler({ type: "tool-called", state: "a", tool: "read_file", level: "info", ...env });
    consoleEventHandler({ type: "agent-text", state: "a", text: "hello", level: "info", ...env });
    consoleEventHandler({ type: "agent-text-delta", state: "a", text: "he", level: "info", ...env });
    consoleEventHandler({
      type: "tool-result",
      state: "a",
      tool: "read_file",
      callId: "c1",
      status: "error",
      durationMs: 3,
      output: "boom",
      truncated: false,
      level: "warn",
      ...env,
    });
    consoleEventHandler({ type: "rubric-start", state: "a", name: "judge", dispatchId: "d1", level: "info", ...env });
    consoleEventHandler({
      type: "rubric-result",
      state: "a",
      name: "judge",
      dispatchId: "d1",
      status: "ok",
      durationMs: 3,
      level: "info",
      ...env,
    });
    consoleEventHandler({ type: "model-usage", state: "a", inputTokens: 1, outputTokens: 2, level: "info", ...env });

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("renderEventLine", () => {
  it("renders the established console prefixes", () => {
    expect(renderEventLine({ type: "interpreter-enabled", level: "info", ...env })).toBe(
      "[interpreter] enabled (ptc: all agent tools)",
    );
    expect(
      renderEventLine({ type: "state-leave", state: "a", next: "b", level: "info", ...env }),
    ).toBe("[workflow] leaving node 'a' -> workflowState=b");
  });

  it("renders an agent-driven advance as a transition", () => {
    expect(
      renderEventLine({ type: "advance", from: "a", to: "b", reason: "done", level: "info", ...env }),
    ).toBe("[workflow] advanced 'a' -> 'b': done");
  });

  it("renders the initial entry (advance from the run origin) as a start-state entry", () => {
    expect(
      renderEventLine({ type: "advance", from: SESSION_ORIGIN, to: "first", level: "info", ...env }),
    ).toBe("[workflow] entering start state 'first'");
  });
});

describe("title-set event", () => {
  it("renders the title and the state it was set from", () => {
    expect(
      renderEventLine({
        type: "title-set",
        title: "Refund for order A-1042",
        state: "triage",
        level: "info",
        ...env,
      }),
    ).toBe("[workflow] title set in triage: Refund for order A-1042");
  });

  it("renders a run-start seeding event with no state", () => {
    expect(
      renderEventLine({
        type: "title-set",
        title: "Inbound refund request",
        level: "info",
        ...env,
      }),
    ).toBe("[workflow] title set: Inbound refund request");
  });
});

describe("variables-set event", () => {
  it("renders the names and lock state", () => {
    expect(
      renderEventLine({
        type: "variables-set",
        state: "triage",
        names: ["case_id", "company"],
        locked: true,
        level: "info",
        ...env,
      }),
    ).toBe("[workflow] variables set in triage: case_id, company (locked)");
  });

  it("renders a seeding event with no state", () => {
    expect(renderEventLine({
        type: "variables-set",
        names: ["from_email"],
        locked: true,
        level: "info",
        ...env,
      })).toBe(
      "[workflow] variables set: from_email (locked)",
    );
  });

  it("omits the lock marker for an unlocked write", () => {
    expect(
      renderEventLine({
        type: "variables-set",
        state: "a",
        names: ["n"],
        locked: false,
        level: "info",
        ...env,
      }),
    ).toBe("[workflow] variables set in a: n");
  });
});
