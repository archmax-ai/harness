import { afterEach, describe, expect, it, vi } from "vitest";
import { AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BackendProtocolV2 } from "deepagents";
import { runtimeNote } from "../core/messages.js";
import { Workspace } from "../core/workspace.js";
import { WorkflowMachine } from "../machine/machine.js";
import type { ScriptExecutor, ScriptOutcome } from "../sandbox/executor.js";
import type { WorkflowLifecycleEvent } from "../core/events.js";
import type { VariableStore } from "../machine/variables.js";
import { createWorkflowInstrumentation } from "./middleware.js";
import { mergeVariables, type TrailStep } from "./state.js";

const SPEC_PATHS = { workflowYaml: "workflow.yaml", workflow: "WORKFLOW.md" };

// Minimal structural shapes for the model/tool-call requests these tests poke
// at. Each wrap* call casts the middleware to `unknown` first (see the casts
// below), so its handler receives `unknown`; the handlers narrow to just the
// fields they read, keeping the file free of `any` under no-explicit-any.
type ShapedBlock = { type: string; text: string; cache_control?: unknown };
type ModelCallRequest = {
  systemMessage: { content: ShapedBlock[] };
  systemPrompt?: string;
  modelSettings?: unknown;
  /** Whatever the middleware left on the request for the framework to invoke. */
  model?: { getName: () => string };
};
type ToolCallRequest = { toolCall: { name: string } };

const STATE_YAML = `
states:
  g:
    triggers: { manual: }
    after: { script: hooks/after.js }
    tools:
      allow:
        - { tool: write_file, args: { file_path: ["output/**"] } }
        - { tool: task }
    transitions:
      - to: done
        description: finish
  done:
`;

function machineWorkspace(yaml: string): Workspace {
  const spec = `${yaml.trim()}\n`;
  const backend = {
    async readRaw(filePath: string) {
      if (filePath.endsWith("workflow.yaml")) {
        return { data: { content: spec, mimeType: "text/yaml", created_at: "", modified_at: "" } };
      }
      return { error: "missing" };
    },
  } as unknown as BackendProtocolV2;
  return new Workspace(backend);
}

async function loadMachine(): Promise<WorkflowMachine> {
  const machine = await WorkflowMachine.load(machineWorkspace(STATE_YAML), SPEC_PATHS);
  if (!machine) throw new Error("failed to load state machine");
  return machine;
}

interface Tracker {
  executor: ScriptExecutor;
  calls: number;
}

function trackingExecutor(outcome: ScriptOutcome): Tracker {
  const tracker: Tracker = {
    calls: 0,
    executor: {
      async runFile() {
        tracker.calls += 1;
        return outcome;
      },
      async runCode() {
        return outcome;
      },
      dispose() {},
    },
  };
  return tracker;
}

const passOutcome: ScriptOutcome = { ok: true, value: null, logs: [], formatted: "" };

function toolRequest(name: string, args: Record<string, unknown>) {
  return {
    toolCall: { name, args, id: "call-1" },
    runtime: { configurable: { thread_id: "t1" } },
    state: { messages: [] },
  };
}

async function callMiddleware(
  name: string,
  args: Record<string, unknown>,
  handler?: (r: unknown) => unknown,
) {
  const machine = await loadMachine();
  const tracker = trackingExecutor(passOutcome);
  const events: WorkflowLifecycleEvent[] = [];
  const instrumentation = createWorkflowInstrumentation({
    machine,
    executor: tracker.executor,
    ptcNames: [],
    onEvent: (e) => events.push(e),
  });
  const wrapToolCall = (
    instrumentation.middleware as unknown as {
      wrapToolCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
    }
  ).wrapToolCall;
  let handlerRan = false;
  const result = await wrapToolCall(
    toolRequest(name, args),
    handler ??
      (() => {
        handlerRan = true;
        return "HANDLER_RAN";
      }),
  );
  return { result, handlerRan, tracker, events };
}

describe("workflow middleware tool governance", () => {
  it("runs the handler for a permitted call", async () => {
    const { result, handlerRan } = await callMiddleware("write_file", {
      file_path: "output/a.json",
    });
    expect(handlerRan).toBe(true);
    expect(result).toBe("HANDLER_RAN");
  });

  it("blocks a statically-disallowed call", async () => {
    const { result, handlerRan } = await callMiddleware("web_fetch", {
      url: "https://example.com",
    });
    expect(handlerRan).toBe(false);
    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).status).toBe("error");
  });

  it("blocks an undisclosed tool call at the kernel even though it was never shown", async () => {
    // Disclosure hides web_fetch from the model, but a call for it (e.g. a
    // hallucinated name) is still governed.
    const { result, handlerRan } = await callMiddleware("web_fetch", { url: "https://x" });
    expect(handlerRan).toBe(false);
    expect((result as ToolMessage).additional_kwargs?.governance_blocked).toBe(true);
  });

  it("permits an essential tool not named by the state's allow list", async () => {
    const { result, handlerRan } = await callMiddleware("read_file", {
      file_path: "data/orders.json",
    });
    expect(handlerRan).toBe(true);
    expect(result).toBe("HANDLER_RAN");
  });

  it("runs write_todos even though this workflow never disclosed it", async () => {
    // Undisclosed for token reasons, not governance reasons: a model that names
    // the planning scratchpad anyway is served rather than refused.
    const { handlerRan } = await callMiddleware("write_todos", {});
    expect(handlerRan).toBe(true);
  });
});

describe("workflow middleware progressive tool disclosure", () => {
  function fakeTool(name: string) {
    return { name } as unknown as import("@langchain/core/tools").StructuredTool;
  }

  async function seenByModel(tools: string[], workflowState?: string): Promise<string[]> {
    const machine = await loadMachine();
    const tracker = trackingExecutor(passOutcome);
    const instrumentation = createWorkflowInstrumentation({
      machine,
      executor: tracker.executor,
      ptcNames: [],
      onEvent: () => {},
    });
    const wrapModelCall = (
      instrumentation.middleware as unknown as {
        wrapModelCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      }
    ).wrapModelCall;
    let seen: string[] = [];
    await wrapModelCall(
      {
        runtime: { configurable: { thread_id: "t1" } },
        tools: tools.map(fakeTool),
        messages: [],
        state: { messages: [], ...(workflowState ? { workflowState } : {}) },
      },
      (req: unknown) => {
        seen = ((req as { tools?: { name: string }[] }).tools ?? []).map((t) => t.name);
        return new AIMessage("AI");
      },
    );
    return seen;
  }

  it("hides undeclared non-essential tools and keeps declared, essential, and movement tools", async () => {
    const seen = await seenByModel([
      "web_fetch",
      "task",
      "write_file",
      "read_file",
      "archmax_advance",
    ]);
    expect(seen).not.toContain("web_fetch");
    expect(seen).toContain("task");
    expect(seen).toContain("write_file");
    expect(seen).toContain("read_file");
    expect(seen).toContain("archmax_advance");
  });

  it("hides archmax_advance in a terminal state", async () => {
    const seen = await seenByModel(["archmax_advance", "read_file"], "done");
    expect(seen).not.toContain("archmax_advance");
    expect(seen).toContain("read_file");
  });

  it("discloses the active state's argument constraints in a volatile system block", async () => {
    const machine = await loadMachine();
    const instrumentation = createWorkflowInstrumentation({
      machine,
      executor: trackingExecutor(passOutcome).executor,
      ptcNames: [],
      onEvent: () => {},
    });
    const wrapModelCall = (
      instrumentation.middleware as unknown as {
        wrapModelCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      }
    ).wrapModelCall;
    let blocks: { type: string; text: string; cache_control?: unknown }[] = [];
    await wrapModelCall(
      {
        runtime: { configurable: { thread_id: "t1" } },
        tools: [fakeTool("write_file")],
        messages: [],
        state: { messages: [] },
        systemMessage: new SystemMessage("BASE"),
        systemPrompt: "BASE",
      },
      (req) => {
        blocks = (req as ModelCallRequest).systemMessage.content;
        return new AIMessage("AI");
      },
    );
    // The static prompt stays in its own leading block (the cacheable prefix);
    // the state's guidance and guards go in a trailing, unmarked block.
    expect(blocks.map((b) => b.text)).toHaveLength(2);
    expect(blocks[0].text).toBe("BASE");
    expect(blocks[0].cache_control).toBeUndefined();
    const prompt = blocks[1].text;
    // The guarded value is presented up front, so the model's first call can
    // already satisfy the constraint instead of learning it from a block.
    expect(prompt).toContain("## Current state: g");
    // A durable session's transcript carries earlier turns' advance results; the
    // volatile block says which state is actually current, so the model does not
    // act on a stale one. It stays out of the cacheable static block above.
    expect(prompt).toContain("overrides any state movement recorded earlier");
    expect(blocks[0].text).not.toContain("overrides any state movement");
    expect(prompt).toContain("Enforced tool argument constraints");
    expect(prompt).toContain("- write_file: file_path must match 'output/**'");
  });

  /** Drive one model call and return the volatile system block. */
  async function volatileBlock(state: Record<string, unknown>): Promise<string> {
    const machine = await loadMachine();
    const instrumentation = createWorkflowInstrumentation({
      machine,
      executor: trackingExecutor(passOutcome).executor,
      ptcNames: [],
      onEvent: () => {},
    });
    const wrapModelCall = (
      instrumentation.middleware as unknown as {
        wrapModelCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      }
    ).wrapModelCall;
    let blocks: { type: string; text: string }[] = [];
    await wrapModelCall(
      {
        runtime: { configurable: { thread_id: "tv" } },
        tools: [fakeTool("write_file")],
        messages: [],
        state: { messages: [], ...state },
        systemMessage: new SystemMessage("BASE"),
        systemPrompt: "BASE",
      },
      (req) => {
        blocks = (req as ModelCallRequest).systemMessage.content;
        return new AIMessage("AI");
      },
    );
    // [0] is the cacheable static prefix; [1] is this segment's volatile block.
    expect(blocks[0].text).toBe("BASE");
    return blocks[1].text;
  }

  // A durable session keeps sitting in the state its run ended in, so a
  // follow-up lands in a terminal state and the model's habit is to answer
  // there — skipping the graph. The note fires exactly where that applies.
  describe("terminal-state follow-up note", () => {
    /** The trail of a run something *arrived* at: `init`, or a delivery into a park. */
    const arrival = [{ to: "done", kind: "trigger", reason: "chat", ts: 1 }];

    /**
     * Keyed on the note's own words, not on "this state is terminal": that is
     * stated for every terminal state by the graph block, so only the follow-up
     * advice distinguishes the note from the ordinary arrival.
     */
    const NOTE = "This state is where this run finished.";

    it("tells the model to reset before answering, in a terminal state", async () => {
      const text = await volatileBlock({ workflowState: "done", auditTrail: arrival });
      expect(text).toContain(NOTE);
      expect(text).toContain("archmax_reset");
      expect(text).toContain("Do not answer a follow-up from here.");
    });

    it("stays out of a state the run can still advance from", async () => {
      const text = await volatileBlock({ workflowState: "g", auditTrail: arrival });
      expect(text).not.toContain(NOTE);
      // A state with edges is not terminal, so neither statement appears.
      expect(text).not.toContain("This state is terminal");
    });

    it("stays out of a terminal state the conversation began in, where a reset moves nothing", async () => {
      const text = await volatileBlock({
        workflowState: "done",
        entryState: "done",
        auditTrail: arrival,
      });
      expect(text).not.toContain(NOTE);
    });

    // The note addresses a run that *finished* here and is being spoken to
    // again. A run routed here this turn is here to work, and telling it to
    // restart is how a decision loops forever: reset → entry → advance → the
    // same human node → park, once per decision, never reaching the chosen
    // state. The trail is what tells the two apart.
    it("stays out of a terminal state a human decision routed into this turn", async () => {
      const text = await volatileBlock({
        workflowState: "done",
        auditTrail: [
          { to: "g", kind: "trigger", reason: "chat", ts: 1 },
          { to: "done", kind: "human", reason: "Approve", ts: 2 },
        ],
      });
      expect(text).not.toContain(NOTE);
    });

    it("stays out of a terminal state the agent advanced into this turn", async () => {
      const text = await volatileBlock({
        workflowState: "done",
        auditTrail: [
          { to: "g", kind: "trigger", reason: "chat", ts: 1 },
          { to: "done", kind: "agent", reason: "work is done", ts: 2 },
        ],
      });
      expect(text).not.toContain(NOTE);
    });

    it("still fires for a delivery that resumed a park held in a terminal state", async () => {
      const text = await volatileBlock({
        workflowState: "done",
        auditTrail: [
          { to: "done", kind: "agent", reason: "answered", ts: 1 },
          { to: "done", kind: "trigger", reason: "chat", ts: 2 },
        ],
      });
      expect(text).toContain("This state is terminal");
    });
  });

  // A model has no clock, and a governed session is long-lived: it parks for a
  // reviewer, is delivered to days later, and every timestamp in its transcript
  // is by then in the past. The turn says what "now" is.
  describe("the clock in the state prompt", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const CLOCK =
      /^Current date and time: (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC \((Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\), rounded down to the nearest 10 minutes/m;

    it("leads the volatile block with the date, the time and the weekday", async () => {
      const text = await volatileBlock({});
      expect(text).toMatch(CLOCK);
      // First line, before the state's own heading: it is true of the turn, not of the state.
      expect(text.split("\n")[0]).toMatch(CLOCK);
    });

    it("renders the current instant, quantised so consecutive calls match byte for byte", async () => {
      const before = Date.now();
      const first = await volatileBlock({});
      const second = await volatileBlock({});
      const [, day, time] = CLOCK.exec(first)!;
      const stamp = Date.parse(`${day}T${time}:00Z`);
      // Rounded down to the bucket, so the lower bound loses up to one bucket.
      expect(stamp).toBeGreaterThanOrEqual(before - 10 * 60_000);
      expect(stamp).toBeLessThanOrEqual(Date.now());
      expect(new Date(stamp).getUTCMinutes() % 10).toBe(0);
      // The point of the bucket: two calls of a turn carry the same line, so the
      // provider's cache key — a prefix ending at the last message — still matches.
      expect(second.split("\n")[0]).toBe(first.split("\n")[0]);
    });

    // The whole point of the bucket: the provider's cache key is a prefix, and
    // the caching middleware marks the tail of the request — so a system block
    // that moved between two calls would re-price every message behind it.
    it("holds the line still inside a bucket and moves it only at the boundary", async () => {
      // `Date` only: the request path races nothing on a timer here.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-10T14:30:00Z"));
      const opening = (await volatileBlock({})).split("\n")[0];
      expect(opening).toContain("2026-09-10 14:30 UTC (Thursday)");

      vi.setSystemTime(new Date("2026-09-10T14:39:59.999Z"));
      expect((await volatileBlock({})).split("\n")[0]).toBe(opening);

      vi.setSystemTime(new Date("2026-09-10T14:40:00Z"));
      expect((await volatileBlock({})).split("\n")[0]).toContain("2026-09-10 14:40 UTC");
    });

    it("names the host's zone when it is not UTC, so business hours mean something", async () => {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const text = (await volatileBlock({})).split("\n")[0];
      if (zone === "UTC" || zone === "Etc/UTC") expect(text).not.toContain("Locally");
      else expect(text).toMatch(new RegExp(`Locally that is (\\d{4}-\\d{2}-\\d{2} )?\\d{2}:\\d{2} in ${zone}\\.`));
    });
  });

  describe("run-variable disclosure in the state prompt", () => {
    it("says none are set, so the model has no reason to spend a turn probing", async () => {
      expect(await volatileBlock({ variables: {} })).toContain("Run variables: none set.");
    });

    it("names the variables that are set, without their values", async () => {
      const text = await volatileBlock({
        variables: {
          from_email: { value: "a@b.com", locked: true },
          order: { value: { secret: "do-not-echo" }, locked: false },
        },
      });
      expect(text).toContain("Run variables set: from_email, order");
      // A value can be a whole event payload, and this block is re-sent on every
      // model call — names are enough to tell the agent what it can ask for.
      expect(text).not.toContain("do-not-echo");
      expect(text).not.toContain("a@b.com");
    });

    it("keeps the listing out of the cacheable static block", async () => {
      const text = await volatileBlock({ variables: { a: { value: 1, locked: false } } });
      expect(text).toContain("Run variables set: a");
    });

    // The `${{…}}`-in-arguments statement is state-invariant, so it belongs in
    // the cacheable prefix the platform prompt supplies — never re-sent per
    // segment, and never varying with what is set.
    it("never restates the interpolation syntax in the volatile block", async () => {
      for (const state of [
        { variables: {} },
        { variables: { a: { value: 1, locked: false } } },
        { workflowState: "done" },
      ]) {
        expect(await volatileBlock(state)).not.toContain("${{");
      }
    });
    });
});

describe("workflow middleware model-result narrowing", () => {
  function fakeTool(name: string) {
    return { name } as unknown as import("@langchain/core/tools").StructuredTool;
  }

  /** Drive `wrapModelCall` with a handler that returns exactly `result`. */
  async function returned(result: unknown): Promise<unknown> {
    const machine = await loadMachine();
    const instrumentation = createWorkflowInstrumentation({
      machine,
      executor: trackingExecutor(passOutcome).executor,
      ptcNames: [],
      onEvent: () => {},
    });
    const wrapModelCall = (
      instrumentation.middleware as unknown as {
        wrapModelCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      }
    ).wrapModelCall;
    return wrapModelCall(
      {
        runtime: { configurable: { thread_id: "narrow" } },
        tools: [fakeTool("read_file")],
        messages: [],
        state: { messages: [] },
      },
      () => result,
    );
  }

  it("forwards an AIMessage, a Command, and a structured-output result untouched", async () => {
    const message = new AIMessage("done");
    expect(await returned(message)).toBe(message);

    const command = { lg_name: "Command", update: { messages: [] } };
    expect(await returned(command)).toBe(command);

    const structured = { structuredResponse: { ok: true }, messages: [message] };
    expect(await returned(structured)).toBe(structured);
  });

  it("repairs an AI-message-shaped plain object into a real AIMessage", async () => {
    // The agent node rejects such a value with `expected AIMessage or Command,
    // got object` and blames whichever middleware is innermost — this one. It is
    // a message in all but class identity, so the run continues on a rebuilt one.
    const toolCalls = [{ name: "read_file", args: { file_path: "/data/a.json" }, id: "call-1" }];
    const repaired = (await returned({
      type: "ai",
      content: "here you go",
      tool_calls: toolCalls,
      id: "msg-1",
    })) as AIMessage;

    expect(AIMessage.isInstance(repaired)).toBe(true);
    expect(repaired.content).toBe("here you go");
    expect(repaired.tool_calls).toEqual(toolCalls);
    expect(repaired.id).toBe("msg-1");
  });

  it("repairs an OpenAI-style assistant message dict", async () => {
    const repaired = (await returned({ role: "assistant", content: "hi" })) as AIMessage;
    expect(AIMessage.isInstance(repaired)).toBe(true);
    expect(repaired.content).toBe("hi");
  });

  it("refuses anything else with an error naming the model, not the middleware", async () => {
    // A run must not continue on a response the harness cannot interpret, but the
    // error has to point at the model — the previous message named
    // `WorkflowMiddleware`, which only forwarded the value.
    await expect(returned({ choices: [], usage: {} })).rejects.toThrow(
      /model call in 'state 'g'' returned a plain object with keys \[choices, usage\]/,
    );
    await expect(returned({ choices: [] })).rejects.toThrow(/check the configured chat model/);
    await expect(returned("AI")).rejects.toThrow(/returned a string/);
    await expect(returned(null)).rejects.toThrow(/returned null/);
  });
});

describe("workflow middleware tool telemetry", () => {
  it("pairs a tool-called and a tool-result via the model's call id", async () => {
    const { events } = await callMiddleware("write_file", { file_path: "output/a.json" });

    const called = events.find((e) => e.type === "tool-called");
    const settled = events.find((e) => e.type === "tool-result");
    expect(called).toMatchObject({
      state: "g",
      tool: "write_file",
      callId: "call-1",
      args: { file_path: "output/a.json" },
      detail: "output/a.json",
    });
    expect(settled).toMatchObject({
      state: "g",
      tool: "write_file",
      callId: "call-1",
      status: "ok",
      output: "HANDLER_RAN",
      truncated: false,
    });
    expect(settled?.type === "tool-result" && settled.durationMs >= 0).toBe(true);
  });

  it("reports an error result for a ToolMessage with status error", async () => {
    const { events } = await callMiddleware(
      "write_file",
      { file_path: "output/a.json" },
      () =>
        new ToolMessage({
          content: "boom",
          tool_call_id: "call-1",
          name: "write_file",
          status: "error",
        }),
    );

    expect(events.find((e) => e.type === "tool-result")).toMatchObject({
      status: "error",
      output: "boom",
    });
  });

  it("reports an error result and rethrows when the tool throws", async () => {
    const machine = await loadMachine();
    const events: WorkflowLifecycleEvent[] = [];
    const instrumentation = createWorkflowInstrumentation({
      machine,
      executor: trackingExecutor(passOutcome).executor,
      ptcNames: [],
      onEvent: (e) => events.push(e),
    });
    const wrapToolCall = (
      instrumentation.middleware as unknown as {
        wrapToolCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      }
    ).wrapToolCall;

    await expect(
      wrapToolCall(toolRequest("write_file", { file_path: "output/a.json" }), () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    expect(events.find((e) => e.type === "tool-result")).toMatchObject({
      status: "error",
      output: "disk full",
    });
  });

  it("truncates oversized output previews", async () => {
    const big = "x".repeat(5000);
    const { events } = await callMiddleware(
      "write_file",
      { file_path: "output/a.json" },
      () => big,
    );

    const settled = events.find((e) => e.type === "tool-result");
    expect(settled).toMatchObject({ status: "ok", truncated: true });
    expect(settled?.type === "tool-result" && settled.output.length === 4096).toBe(true);
  });

  it("emits no tool events for a blocked call", async () => {
    const { events } = await callMiddleware("web_fetch", { url: "https://example.com" });

    expect(events.some((e) => e.type === "tool-called" || e.type === "tool-result")).toBe(false);
    expect(events.some((e) => e.type === "tool-blocked")).toBe(true);
  });

  it("refuses an agent's task call rather than bracketing it as a dispatch", async () => {
    // `task` exists in the tool list because registered rubrics put it there for
    // the runtime. It is not the agent's to call: the kernel refuses it, so the
    // turn produces a block and no dispatch pair. A rubric's own dispatch is
    // bracketed by the bridge instead (see sandbox/bridge.test.ts).
    const { events, handlerRan, result } = await callMiddleware("task", {
      description: "judge it",
      subagent_type: "quality-judge",
    });

    expect(handlerRan).toBe(false);
    expect(JSON.stringify(result)).toContain("not a tool");
    const types = events.map((e) => e.type);
    expect(types).not.toContain("rubric-start");
    expect(types).not.toContain("rubric-result");
  });
});

describe("workflow middleware session isolation and dispose", () => {
  function fakeTool(name: string) {
    return { name } as unknown as import("@langchain/core/tools").StructuredTool;
  }

  function modelRequest(sessionId: string, tools: unknown[]) {
    return {
      runtime: { configurable: { thread_id: sessionId } },
      tools,
      messages: [],
      state: { messages: [] },
    };
  }

  function advanceRequest(sessionId: string) {
    return {
      toolCall: { name: "archmax_advance", args: { to: "done", reason: "done" }, id: "call-1" },
      runtime: { configurable: { thread_id: sessionId } },
      state: { messages: [], workflowState: "g" },
    };
  }

  /** Executor that records the PTC tool names passed to each lifecycle-hook run. */
  function toolRecordingExecutor(): {
    executor: ScriptExecutor;
    toolsSeen: string[][];
    disposed: string[];
  } {
    const toolsSeen: string[][] = [];
    const disposed: string[] = [];
    return {
      toolsSeen,
      disposed,
      executor: {
        async runFile(_filePath, params) {
          toolsSeen.push((params.tools ?? []).map((t) => t.name));
          return passOutcome;
        },
        async runCode() {
          return passOutcome;
        },
        dispose(sessionId, ns) {
          disposed.push(`${sessionId}:${ns ?? "*"}`);
        },
      },
    };
  }

  async function makeInstrumentation(executor: ScriptExecutor) {
    const machine = await loadMachine();
    const instrumentation = createWorkflowInstrumentation({ machine, executor, ptcNames: [] });
    const mw = instrumentation.middleware as unknown as {
      wrapModelCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      wrapToolCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
    };
    return { instrumentation, mw };
  }

  it("gives each session's lifecycle hook only its own segment context", async () => {
    const { executor, toolsSeen } = toolRecordingExecutor();
    const { mw } = await makeInstrumentation(executor);

    // Two sessions run model calls with different tool surfaces, interleaved.
    await mw.wrapModelCall(modelRequest("t1", [fakeTool("alpha")]), () => new AIMessage("AI"));
    await mw.wrapModelCall(modelRequest("t2", [fakeTool("beta")]), () => new AIMessage("AI"));

    // Each `archmax_advance` runs the departing state's `after` hook, which reads
    // the session's own segment tool surface.
    await mw.wrapToolCall(advanceRequest("t1"), () => "OK");
    await mw.wrapToolCall(advanceRequest("t2"), () => "OK");

    expect(toolsSeen).toEqual([["alpha"], ["beta"]]);
  });

  it("clears segment context on dispose, including mid-segment aborts", async () => {
    const { executor, toolsSeen, disposed } = toolRecordingExecutor();
    const { instrumentation, mw } = await makeInstrumentation(executor);

    // Segment starts (context populated) and is then aborted: no afterAgent.
    await mw.wrapModelCall(modelRequest("t1", [fakeTool("alpha")]), () => new AIMessage("AI"));
    instrumentation.dispose("t1");

    // The lifecycle interpreter session was released for the session.
    expect(disposed).toContain("t1:process");

    // A later lifecycle hook on the same session sees no stale tool surface.
    await mw.wrapToolCall(advanceRequest("t1"), () => "OK");
    expect(toolsSeen).toEqual([[]]);
  });

  it("is idempotent on double dispose", async () => {
    const { executor, disposed } = toolRecordingExecutor();
    const { instrumentation } = await makeInstrumentation(executor);

    instrumentation.dispose("t1");
    instrumentation.dispose("t1");

    expect(disposed).toEqual(["t1:process", "t1:process"]);
  });
});

describe("workflow middleware tool-call events", () => {
  async function callWithEvents(name: string, args: Record<string, unknown>) {
    const machine = await loadMachine();
    const tracker = trackingExecutor(passOutcome);
    const events: { type: string; tool?: string; detail?: string }[] = [];
    const instrumentation = createWorkflowInstrumentation({
      machine,
      executor: tracker.executor,
      ptcNames: [],
      onEvent: (e) => events.push(e as { type: string; tool?: string; detail?: string }),
    });
    const wrapToolCall = (
      instrumentation.middleware as unknown as {
        wrapToolCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      }
    ).wrapToolCall;
    await wrapToolCall(toolRequest(name, args), () => "HANDLER_RAN");
    return events;
  }

  it("emits tool-called with a detail hint for an allowed call", async () => {
    const events = await callWithEvents("write_file", { file_path: "output/a.json" });
    const called = events.find((e) => e.type === "tool-called");
    expect(called).toMatchObject({ tool: "write_file", detail: "output/a.json" });
  });

  it("emits tool-called for a permitted essential tool", async () => {
    const events = await callWithEvents("read_file", { file_path: "data/orders.json" });
    expect(events.some((e) => e.type === "tool-called" && e.tool === "read_file")).toBe(true);
  });

  it("does not emit tool-called for a blocked call", async () => {
    const events = await callWithEvents("web_fetch", { url: "https://example.com" });
    expect(events.some((e) => e.type === "tool-called")).toBe(false);
    expect(events.some((e) => e.type === "tool-blocked")).toBe(true);
  });

  it("announces archmax_advance like any other governed call", async () => {
    // Open-mode machine so archmax_advance passes governance and reaches the
    // emit path. No governed call is exempt from the pair: the dedicated
    // `advance`/`state-leave` events report where the run went, not that a tool
    // was called.
    const openYaml = `
states:
  g:
    triggers: { manual: }
    transitions:
      - to: done
        description: finish
  done:
`;
    const machine = await WorkflowMachine.load(machineWorkspace(openYaml), SPEC_PATHS);
    if (!machine) throw new Error("failed to load open machine");
    const tracker = trackingExecutor(passOutcome);
    const events: { type: string; tool?: string }[] = [];
    const instrumentation = createWorkflowInstrumentation({
      machine,
      executor: tracker.executor,
      ptcNames: [],
      onEvent: (e) => events.push(e as { type: string; tool?: string }),
    });
    const wrapToolCall = (
      instrumentation.middleware as unknown as {
        wrapToolCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      }
    ).wrapToolCall;
    await wrapToolCall(toolRequest("archmax_advance", { to: "done" }), () => "HANDLER_RAN");
    expect(events.filter((e) => e.type === "tool-called").map((e) => e.tool)).toEqual([
      "archmax_advance",
    ]);
  });
});

describe("workflow middleware archmax_advance intercept", () => {
  const OPEN_YAML = `
states:
  g:
    triggers: { manual: }
    transitions:
      - to: done
        description: finish
  done:
`;

  it("commits the transition and checkpointed corrections via a Command", async () => {
    const { Command } = await import("@langchain/langgraph");
    const machine = await WorkflowMachine.load(machineWorkspace(OPEN_YAML), SPEC_PATHS);
    if (!machine) throw new Error("failed to load open machine");
    const tracker = trackingExecutor(passOutcome);
    const instrumentation = createWorkflowInstrumentation({
      machine,
      executor: tracker.executor,
      ptcNames: [],
    });
    const wrapToolCall = (
      instrumentation.middleware as unknown as {
        wrapToolCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      }
    ).wrapToolCall;

    let handlerRan = false;
    const result = await wrapToolCall(
      {
        toolCall: { name: "archmax_advance", args: { to: "done", reason: "all set" }, id: "call-9" },
        runtime: { configurable: { thread_id: "t1" } },
        // Corrections recorded in an earlier segment live in checkpointed state.
        state: { messages: [], workflowState: "g", iterations: { g: 1 } },
      },
      () => {
        handlerRan = true;
        return "HANDLER_RAN";
      },
    );

    expect(handlerRan).toBe(false);
    expect(result).toBeInstanceOf(Command);
    const update = (result as InstanceType<typeof Command>).update as Record<string, unknown>;
    expect(update.workflowState).toBe("done");
    expect(update.iterations).toEqual({ g: 1 });
    const [message] = update.messages as ToolMessage[];
    expect(String(message.content)).toContain("Advanced to state 'done'");
    expect(message.tool_call_id).toBe("call-9");
  });
});

/**
 * The five tools `wrapToolCall` services itself. Each announces a call and
 * announces its result: a consumer correlating the two by `callId` must never be
 * left with one running forever, and must find the call that moved the run among
 * the rest — `archmax_advance` included, which is why a window over a turn can be
 * derived from ids alone.
 */
describe("workflow middleware intercepted-tool events", () => {
  const OPEN_YAML = `
states:
  g:
    triggers: { manual: }
    transitions:
      - to: done
        description: finish
  done:
`;

  /** Drives a sequence of intercepted calls in one state, threading committed state. */
  async function interceptedCalls(
    calls: { name: string; args: Record<string, unknown>; id: string }[],
    seed: VariableStore = {},
  ) {
    const machine = await WorkflowMachine.load(machineWorkspace(OPEN_YAML), SPEC_PATHS);
    if (!machine) throw new Error("failed to load open machine");
    const events: WorkflowLifecycleEvent[] = [];
    const instrumentation = createWorkflowInstrumentation({
      machine,
      executor: trackingExecutor(passOutcome).executor,
      ptcNames: [],
      onEvent: (e) => events.push(e),
    });
    const wrapToolCall = (
      instrumentation.middleware as unknown as {
        wrapToolCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      }
    ).wrapToolCall;

    // The real channel's fold, so a second call in this state sees what the
    // first one committed — exactly as the inner Deep Agent channel now does.
    let variables: VariableStore = { ...seed };
    const results: unknown[] = [];
    for (const call of calls) {
      const result = await wrapToolCall(
        {
          toolCall: { name: call.name, args: call.args, id: call.id },
          runtime: { configurable: { thread_id: "t1" } },
          state: { messages: [], workflowState: "g", variables },
        },
        () => "HANDLER_RAN",
      );
      results.push(result);
      const delta = (result as { update?: { variables?: VariableStore } } | undefined)?.update
        ?.variables;
      if (delta) variables = mergeVariables(variables, delta);
    }
    return { events, results, variables };
  }

  const setCall = (id: string, vars: Record<string, unknown>, lock = true) => ({
    name: "archmax_set_variables",
    args: { variables: vars, lock },
    id,
  });

  it("keeps every name a state wrote across successive set_variables calls", async () => {
    const { variables } = await interceptedCalls([
      setCall("c1", { is_confirmed: true }),
      setCall("c2", { product: "strawberries", email: "a@b.c" }),
      setCall("c3", { success: true }),
    ]);

    expect(Object.keys(variables).sort()).toEqual([
      "email",
      "is_confirmed",
      "product",
      "success",
    ]);
    expect(variables.is_confirmed?.value).toBe(true);
  });

  it("still refuses a locked name after an earlier write in the same state", async () => {
    const { results, variables } = await interceptedCalls(
      [setCall("c1", { note: "first" }, false), setCall("c2", { case_id: "K-10" })],
      { case_id: { value: "K-9", locked: true } },
    );

    const refusal = results[1] as ToolMessage;
    expect(refusal.status).toBe("error");
    expect(String(refusal.content)).toContain("locked");
    expect(variables.case_id?.value).toBe("K-9");
  });

  it("pairs a tool-result with every announced intercepted call", async () => {
    const { events } = await interceptedCalls([
      { name: "archmax_get_variables", args: { name: "", path: "" }, id: "g1" },
      setCall("s1", { is_confirmed: true }),
      { name: "archmax_wait", args: { reason: "waiting for the customer" }, id: "w1" },
    ]);

    const called = events.filter((e) => e.type === "tool-called");
    const settled = events.filter((e) => e.type === "tool-result");
    expect(called.map((e) => (e as { callId: string }).callId)).toEqual(["g1", "s1", "w1"]);
    expect(settled.map((e) => (e as { callId: string }).callId)).toEqual(["g1", "s1", "w1"]);
    for (const event of settled) {
      expect(event).toMatchObject({ state: "g", status: "ok" });
      expect(typeof (event as { durationMs: number }).durationMs).toBe("number");
    }
  });

  it("settles a refused set_variables as an error carrying the refusal text", async () => {
    const { events } = await interceptedCalls([setCall("s1", { case_id: "K-10" })], {
      case_id: { value: "K-9", locked: true },
    });

    const settled = events.find((e) => e.type === "tool-result") as {
      status: string;
      output: string;
    };
    expect(settled.status).toBe("error");
    expect(settled.output).toContain("locked");
  });

  it("emits the pair for a committed archmax_advance", async () => {
    const { events, results } = await interceptedCalls([
      { name: "archmax_advance", args: { to: "done", reason: "finished" }, id: "a1" },
    ]);

    const called = events.find((e) => e.type === "tool-called");
    const settled = events.find((e) => e.type === "tool-result");
    expect(called).toMatchObject({ state: "g", tool: "archmax_advance", callId: "a1" });
    expect((called as { args: Record<string, unknown> }).args).toMatchObject({ to: "done" });
    expect(settled).toMatchObject({ tool: "archmax_advance", callId: "a1", status: "ok" });
    // The transition itself is reported by its own event, carrying the same id as
    // the call that drove it.
    expect(events.find((e) => e.type === "advance")).toMatchObject({
      from: "g",
      to: "done",
      callId: "a1",
    });
    // The id on the events is the id on the message the model reads back, so the
    // stream and the transcript name this call the same way.
    const update = (results[0] as { update: { messages: ToolMessage[] } }).update;
    expect(update.messages[0]?.tool_call_id).toBe("a1");
  });

  it("settles a refused archmax_advance as an error and reports no transition", async () => {
    // 'g' declares only `done`, so this edge does not exist. The reply the model
    // reads is deliberately not an error message — it retries in place — but the
    // stream must report the refusal as one.
    const { events } = await interceptedCalls([
      { name: "archmax_advance", args: { to: "nowhere", reason: "guessing" }, id: "a1" },
    ]);

    const settled = events.find((e) => e.type === "tool-result") as {
      status: string;
      output: string;
      callId: string;
    };
    expect(settled).toMatchObject({ status: "error", callId: "a1" });
    expect(settled.output).toContain("rejected");
    expect(events.some((e) => e.type === "advance")).toBe(false);
  });

  it("settles a vetoed archmax_advance as an error", async () => {
    // Nothing wrong with the edge — the departing state's `after` hook refuses
    // the transition. The reply the model reads is still not an error message, so
    // only reading the committed outcome gets this right.
    const vetoYaml = `
states:
  g:
    triggers: { manual: }
    after:
      script: hooks/review.js
    transitions:
      - to: done
        description: finish
  done:
`;
    const machine = await WorkflowMachine.load(machineWorkspace(vetoYaml), SPEC_PATHS);
    if (!machine) throw new Error("failed to load veto machine");
    const events: WorkflowLifecycleEvent[] = [];
    const instrumentation = createWorkflowInstrumentation({
      machine,
      executor: trackingExecutor({
        ok: true,
        value: { verdict: "veto", reason: "not ready" },
        logs: [],
        formatted: "",
      }).executor,
      ptcNames: [],
      onEvent: (e) => events.push(e),
    });
    const wrapToolCall = (
      instrumentation.middleware as unknown as {
        wrapToolCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      }
    ).wrapToolCall;

    await wrapToolCall(
      {
        toolCall: { name: "archmax_advance", args: { to: "done", reason: "finished" }, id: "a1" },
        runtime: { configurable: { thread_id: "t1" } },
        state: { messages: [], workflowState: "g", variables: {} },
      },
      () => "HANDLER_RAN",
    );

    expect(events.find((e) => e.type === "tool-result")).toMatchObject({
      tool: "archmax_advance",
      callId: "a1",
      status: "error",
    });
    expect(events.some((e) => e.type === "advance")).toBe(false);
  });

  it("commits the park a wait call asks for, and names the call on the parked event", async () => {
    const { results, events } = await interceptedCalls([
      { name: "archmax_wait", args: { reason: "waiting for the customer" }, id: "w1" },
    ]);

    const update = (results[0] as { update: Record<string, unknown> }).update;
    expect(update.pendingInput).toMatchObject({ state: "g", reason: "waiting for the customer" });
    expect(update.status).toBe("awaiting_input");
    expect(events.find((e) => e.type === "parked")).toMatchObject({
      state: "g",
      awaiting: "input",
      reason: "waiting for the customer",
      callId: "w1",
    });
  });

  it("names the call that wrote when it reports a variable write", async () => {
    const { events } = await interceptedCalls([setCall("s1", { product: "strawberries" })]);

    expect(events.find((e) => e.type === "variables-set")).toMatchObject({
      state: "g",
      names: ["product"],
      callId: "s1",
    });
  });

  describe("the title-set event", () => {
    it("announces the value, the state and the writing call", async () => {
      const { events } = await interceptedCalls([
        setCall("t1", { title: "Refund for order A-1042" }, false),
      ]);

      expect(events.find((e) => e.type === "title-set")).toMatchObject({
        title: "Refund for order A-1042",
        state: "g",
        callId: "t1",
      });
    });

    it("carries the stored, trimmed value rather than the raw argument", async () => {
      const { events } = await interceptedCalls([
        setCall("t2", { title: "  Refund for A-1042  " }, false),
      ]);

      expect(events.find((e) => e.type === "title-set")).toMatchObject({
        title: "Refund for A-1042",
      });
    });

    // The whole point of a separate event: `variables-set` keeps its invariant
    // unconditionally, so a title write announces on both.
    it("does not put the value on variables-set, which still carries names only", async () => {
      const { events } = await interceptedCalls([setCall("t3", { title: "Refund" }, false)]);

      const written = events.find((e) => e.type === "variables-set");
      expect(written).toMatchObject({ names: ["title"] });
      expect(JSON.stringify(written)).not.toContain("Refund");
    });

    it("emits neither event when the write is refused for its shape", async () => {
      const { events } = await interceptedCalls([setCall("t4", { title: 42 }, false)]);

      expect(events.some((e) => e.type === "title-set")).toBe(false);
      expect(events.some((e) => e.type === "variables-set")).toBe(false);
    });

    it("emits neither event when the write is refused for locking", async () => {
      const { events } = await interceptedCalls([setCall("t5", { title: "Refund" }, true)]);

      expect(events.some((e) => e.type === "title-set")).toBe(false);
      expect(events.some((e) => e.type === "variables-set")).toBe(false);
    });

    it("says nothing about a title when no title was written", async () => {
      const { events } = await interceptedCalls([setCall("t6", { case_id: "K-9" }, false)]);

      expect(events.some((e) => e.type === "title-set")).toBe(false);
    });
  });

  /**
   * The trail channel appends: a delegation call commits **its own** step and
   * nothing else, so two calls in one state — or in one batch — each land theirs
   * without either rewriting the list.
   */
  it("records each delegation call as its own trail step", async () => {
    // Delegation is granted by name, never by default, so the calling state has
    // to allow both targets — an open state grants neither.
    const delegatingYaml = `
states:
  g:
    triggers: { manual: }
    tools:
      allow:
        - { tool: archmax_workflow_enrich }
        - { tool: archmax_workflow_audit }
    transitions:
      - to: done
        description: finish
  done:
`;
    const machine = await WorkflowMachine.load(machineWorkspace(delegatingYaml), SPEC_PATHS);
    if (!machine) throw new Error("failed to load delegating machine");
    // A dispatcher that answers at once and keeps the ledger a real one keeps.
    const ledger: { workflow: string; status: "ok" | "error" }[] = [];
    const instrumentation = createWorkflowInstrumentation({
      machine,
      executor: trackingExecutor(passOutcome).executor,
      ptcNames: [],
      onEvent: () => {},
      subWorkflows: {
        refusal: async () => undefined,
        signature: async () => ({}),
        drainDispatches: () => ledger.splice(0),
        dispatch: async (input) => {
          ledger.push({ workflow: input.workflow, status: "ok" });
          return { result: "ok", workflow: input.workflow, state: "done" };
        },
        resume: async () => ({ result: "ok", workflow: "enrich", state: "done" }),
        release: () => {},
      },
    });
    const wrapToolCall = (
      instrumentation.middleware as unknown as {
        wrapToolCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      }
    ).wrapToolCall;

    const seed: TrailStep = { to: "g", kind: "trigger", reason: "manual", ts: 1 };
    const committed: TrailStep[][] = [];
    for (const slug of ["enrich", "audit"]) {
      const result = await wrapToolCall(
        {
          toolCall: { name: `archmax_workflow_${slug}`, args: {}, id: `call-${slug}` },
          runtime: { configurable: { thread_id: "t1" } },
          state: { messages: [], workflowState: "g", auditTrail: [seed] },
        },
        () => new ToolMessage({ content: "done", tool_call_id: `call-${slug}`, name: slug }),
      );
      committed.push(
        ((result as { update?: { auditTrail?: TrailStep[] } } | undefined)?.update?.auditTrail ??
          []) as TrailStep[],
      );
    }

    // A delta each: the seed is the channel's to keep, not the writer's to resend.
    expect(committed.map((steps) => steps.map((s) => s.workflow))).toEqual([["enrich"], ["audit"]]);
    expect(committed.flat().every((s) => s.kind === "sub-workflow" && s.to === "g")).toBe(true);
  });
});

describe("workflow middleware tool-name resolution", () => {
  const NAMESPACED_YAML = `
states:
  g:
    triggers: { manual: }
    tools:
      allow:
        - { tool: outlook__downloadAttachment }
        - { tool: gmail__downloadAttachment }
        - { tool: outlook__sendEmail }
    transitions:
      - to: done
        description: finish
  done:
`;

  /** Registered on the agent; `slack__postMessage` is deliberately not granted by the state. */
  const REGISTERED = [
    "outlook__downloadAttachment",
    "gmail__downloadAttachment",
    "outlook__sendEmail",
    "slack__postMessage",
  ];

  function fakeTool(name: string) {
    return { name } as unknown as import("@langchain/core/tools").StructuredTool;
  }

  /**
   * Runs a model call first so the segment's registered tool surface is known
   * — the tool node hands `tool: undefined` for any name it cannot resolve, so
   * without that surface the middleware has nothing to resolve against.
   */
  async function callWithSurface(name: string, args: Record<string, unknown> = {}) {
    const machine = await WorkflowMachine.load(machineWorkspace(NAMESPACED_YAML), SPEC_PATHS);
    if (!machine) throw new Error("failed to load state machine");
    const events: WorkflowLifecycleEvent[] = [];
    const instrumentation = createWorkflowInstrumentation({
      machine,
      executor: trackingExecutor(passOutcome).executor,
      ptcNames: [],
      onEvent: (e) => events.push(e),
    });
    const mw = instrumentation.middleware as unknown as {
      wrapModelCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      wrapToolCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
    };
    await mw.wrapModelCall(
      {
        runtime: { configurable: { thread_id: "t1" } },
        tools: REGISTERED.map(fakeTool),
        messages: [],
        state: { messages: [] },
      },
      () => new AIMessage("AI"),
    );
    let ranAs: string | undefined;
    const result = await mw.wrapToolCall(toolRequest(name, args), (req) => {
      ranAs = (req as ToolCallRequest).toolCall.name;
      return "HANDLER_RAN";
    });
    return { result, ranAs, events };
  }

  it("runs a bare action name as the one namespaced tool it can mean", async () => {
    const { result, ranAs } = await callWithSurface("sendEmail", { to: "a@b.c" });

    // The rewritten name travels on — the tool node resolves the tool by it.
    expect(ranAs).toBe("outlook__sendEmail");
    expect(result).toBe("HANDLER_RAN");
  });

  it("refuses an unknown tool as unknown, not as a governance block", async () => {
    const { result, ranAs, events } = await callWithSurface("summarize");

    expect(ranAs).toBeUndefined();
    expect(String((result as ToolMessage).content)).toContain("'summarize' is not a tool");
    // A name that exists nowhere is the model's mistake to fix, not a state
    // policy decision — reporting it as one sends the model chasing `allow`.
    expect(events.some((e) => e.type === "tool-blocked")).toBe(false);
  });

  it("names the candidates when a bare action name is ambiguous", async () => {
    const { result, ranAs } = await callWithSurface("downloadAttachment", { messageId: "m1" });

    expect(ranAs).toBeUndefined();
    const content = String((result as ToolMessage).content);
    expect(content).toContain("outlook__downloadAttachment");
    expect(content).toContain("gmail__downloadAttachment");
  });

  it("still governs a resolved call by the state's grant", async () => {
    const { ranAs, events } = await callWithSurface("postMessage", { text: "hi" });

    expect(ranAs).toBeUndefined();
    // Blocked under the resolved id, so the message names the tool governance
    // actually evaluated rather than the model's abbreviation.
    expect(events.find((e) => e.type === "tool-blocked")).toMatchObject({
      tool: "slack__postMessage",
    });
  });

  it("carries the call's id and args on a governance block", async () => {
    const { events } = await callWithSurface("slack__postMessage", { text: "hi" });

    // No `tool-called` precedes a refusal, so this event is the call's only
    // record — consumers correlate it with the transcript by these fields.
    expect(events.find((e) => e.type === "tool-blocked")).toMatchObject({
      tool: "slack__postMessage",
      callId: "call-1",
      args: { text: "hi" },
    });
  });

  it("leaves the call untouched when no model call established a surface", async () => {
    const machine = await WorkflowMachine.load(machineWorkspace(NAMESPACED_YAML), SPEC_PATHS);
    if (!machine) throw new Error("failed to load state machine");
    const instrumentation = createWorkflowInstrumentation({
      machine,
      executor: trackingExecutor(passOutcome).executor,
      ptcNames: [],
      onEvent: () => {},
    });
    const wrapToolCall = (
      instrumentation.middleware as unknown as {
        wrapToolCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      }
    ).wrapToolCall;

    let ranAs: string | undefined;
    await wrapToolCall(toolRequest("outlook__sendEmail", { to: "a@b.c" }), (req) => {
      ranAs = (req as ToolCallRequest).toolCall.name;
      return "HANDLER_RAN";
    });

    // Nothing to resolve against is not evidence the tool is missing.
    expect(ranAs).toBe("outlook__sendEmail");
  });
});

describe("the model a state's call runs on", () => {
  function fakeTool(name: string) {
    return { name } as unknown as import("@langchain/core/tools").StructuredTool;
  }

  /** A model instance identifiable by name, never invoked here. */
  function namedModel(name: string) {
    return { getName: () => name } as unknown as import(
      "@langchain/core/language_models/chat_models"
    ).BaseChatModel;
  }

  /** Drive one model call in `state` and report the model and marker the handler received. */
  async function callIn(
    state: string,
    stateModels?: import("./middleware.js").StateModels,
    shaping: import("./middleware.js").PromptShaping = {},
  ) {
    const machine = await loadMachine();
    const instrumentation = createWorkflowInstrumentation({
      machine,
      executor: trackingExecutor(passOutcome).executor,
      ptcNames: [],
      promptShaping: shaping,
      ...(stateModels ? { stateModels } : {}),
      onEvent: () => {},
    });
    const wrapModelCall = (
      instrumentation.middleware as unknown as {
        wrapModelCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      }
    ).wrapModelCall;
    let seen!: ModelCallRequest;
    await wrapModelCall(
      {
        runtime: { configurable: { thread_id: "t1" } },
        model: namedModel("graph-default"),
        tools: [fakeTool("write_file")],
        messages: [],
        state: { messages: [], workflowState: state },
        systemMessage: new SystemMessage("STATIC"),
        systemPrompt: "STATIC",
      },
      (req) => {
        seen = req as ModelCallRequest;
        return new AIMessage("AI");
      },
    );
    return {
      model: seen.model?.getName(),
      marker: (seen.systemMessage.content as { cache_control?: unknown }[])[0]?.cache_control,
    };
  }

  const stateModels: import("./middleware.js").StateModels = {
    modelFor: (state) => (state === "g" ? namedModel("state-model") : undefined),
    cacheStrategyFor: (state) => (state === "g" ? "anthropic-compat" : "off"),
    idFor: (state) => (state === "g" ? "state-model-id" : "graph-default-id"),
  };

  it("hands the handler the model that state declared", async () => {
    expect((await callIn("g", stateModels)).model).toBe("state-model");
  });

  it("leaves the graph's own model in place for a state that declared none", async () => {
    expect((await callIn("done", stateModels)).model).toBe("graph-default");
    expect((await callIn("g")).model).toBe("graph-default");
  });

  it("marks the static block from the strategy of the model in force", async () => {
    // The workflow's own model caches nothing; the state's does, and the
    // breakpoint follows the model that is about to be called.
    expect((await callIn("g", stateModels, { cacheStrategy: "off", cacheTtl: "5m" })).marker).toEqual({
      type: "ephemeral",
      ttl: "5m",
    });
    expect((await callIn("done", stateModels, { cacheStrategy: "off", cacheTtl: "5m" })).marker).toBeUndefined();
  });
});

describe("workflow middleware prompt shaping", () => {
  function fakeTool(name: string) {
    return { name } as unknown as import("@langchain/core/tools").StructuredTool;
  }

  /** Drive one model call with the given shaping and return the resulting request. */
  async function callWithShaping(
    shaping: import("./middleware.js").PromptShaping,
    staticPrompt = "STATIC PROMPT",
  ) {
    const machine = await loadMachine();
    const warnings: string[] = [];
    const instrumentation = createWorkflowInstrumentation({
      machine,
      executor: trackingExecutor(passOutcome).executor,
      ptcNames: [],
      promptShaping: shaping,
      onEvent: (e) => {
        if (e.type === "warning") warnings.push(e.message);
      },
    });
    const wrapModelCall = (
      instrumentation.middleware as unknown as {
        wrapModelCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      }
    ).wrapModelCall;
    let seen!: ModelCallRequest;
    await wrapModelCall(
      {
        runtime: { configurable: { thread_id: "t1" } },
        tools: [fakeTool("write_file")],
        messages: [],
        state: { messages: [] },
        systemMessage: new SystemMessage(staticPrompt),
        systemPrompt: staticPrompt,
      },
      (req) => {
        seen = req as ModelCallRequest;
        return new AIMessage("AI");
      },
    );
    return { request: seen, warnings };
  }

  it("marks only the static block when caching over an OpenAI-compatible endpoint", async () => {
    const { request } = await callWithShaping({
      cacheStrategy: "anthropic-compat",
      cacheTtl: "1h",
    });
    const blocks = request.systemMessage.content;
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(blocks[1].cache_control).toBeUndefined();
    // The native strategies are LangChain's middleware, not ours: no model settings.
    expect(request.modelSettings).toBeUndefined();
  });

  /**
   * The cache invariant the whole shaping exists for: a provider's cache key is
   * a *prefix*, so what must hold still is the entire system message, not just
   * the block that carries the breakpoint. Two calls of one turn — a grown
   * transcript, the same state — must produce identical bytes, clock included.
   */
  it("keeps the whole system message byte-identical across a turn's model calls", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-10T14:31:07Z"));
      const first = await callWithShaping({ cacheStrategy: "anthropic-compat", cacheTtl: "5m" });
      // Later in the same turn: more messages, more seconds, same bucket.
      vi.setSystemTime(new Date("2026-09-10T14:38:52Z"));
      const second = await callWithShaping({ cacheStrategy: "anthropic-compat", cacheTtl: "5m" });

      const blocksOf = (r: typeof first) => r.request.systemMessage.content;
      expect(JSON.stringify(blocksOf(second))).toBe(JSON.stringify(blocksOf(first)));
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds no marker for the native strategies (LangChain's middleware owns them)", async () => {
    for (const cacheStrategy of ["anthropic-native", "bedrock-native", "off"] as const) {
      const { request } = await callWithShaping({ cacheStrategy });
      const blocks = request.systemMessage.content;
      expect(blocks.every((b) => b.cache_control === undefined)).toBe(true);
    }
  });

  it("prunes the upstream guidance of a withheld built-in", async () => {
    const prompt = [
      "# Persona",
      "",
      "## Important Task Tool Usage Notes to Remember",
      "",
      "Task guidance.",
      "",
      "## Filesystem Tools",
      "",
      "Keep me.",
    ].join("\n");
    const { request, warnings } = await callWithShaping({ withheldBuiltins: ["task"] }, prompt);
    const staticBlock = request.systemMessage.content[0].text;
    expect(staticBlock).not.toContain("Task guidance");
    expect(staticBlock).toContain("Keep me.");
    expect(warnings).toEqual([]);
  });

  it("warns and leaves the prompt intact when the tool's guidance is absent entirely", async () => {
    const { request, warnings } = await callWithShaping(
      { withheldBuiltins: ["task"] },
      "# Persona\n\nNo upstream sections here.",
    );
    expect(request.systemMessage.content[0].text).toBe("# Persona\n\nNo upstream sections here.");
    expect(warnings.join(" ")).toContain("could not prune");
  });

  // Nothing selects a different rendering: with no withheld built-ins there is
  // nothing to prune, and that is the only condition that decides it.
  it("prunes nothing when no built-in is withheld", async () => {
    const prompt = "# Persona\n\n## Important Task Tool Usage Notes to Remember\n\nTask guidance.";
    const { request } = await callWithShaping({ withheldBuiltins: [] }, prompt);
    expect(request.systemMessage.content[0].text).toContain("Task guidance.");
  });

  it("leaves model settings untouched (provider caching is LangChain's middleware)", async () => {
    const { request } = await callWithShaping({ cacheStrategy: "anthropic-compat" });
    expect(request.modelSettings).toBeUndefined();
  });

  it("never writes the deprecated systemPrompt field alongside systemMessage", async () => {
    // Changing both in one request is rejected by the agent node.
    const { request } = await callWithShaping({ cacheStrategy: "anthropic-compat" });
    expect(request.systemPrompt).toBe("STATIC PROMPT");
    expect(request.systemMessage.content).toHaveLength(2);
  });
});

const PARK_YAML = `
states:
  work:
    triggers: { manual: }
    tools:
      allow:
        - { tool: write_file, args: { file_path: ["output/**"] } }
    transitions:
      - to: review
        description: hand it to a reviewer
      - to: done
        description: finish it here
  review:
    type: human
    title: Reviewer check
    instructions: Confirm the recorded decision before the case closes.
    transitions:
      - to: done
        type: approve
        description: approve it
  done:
`;

/** The middleware under a machine that has a human node to park at. */
async function parkInstrumentation() {
  const machine = await WorkflowMachine.load(machineWorkspace(PARK_YAML), SPEC_PATHS);
  if (!machine) throw new Error("failed to load state machine");
  return createWorkflowInstrumentation({
    machine,
    executor: trackingExecutor(passOutcome).executor,
    ptcNames: [],
    onEvent: () => {},
  });
}

type GateResult = { jumpTo?: string; replyOnly?: boolean } | undefined;

async function beforeModel(state: Record<string, unknown>): Promise<GateResult> {
  const instrumentation = await parkInstrumentation();
  const hook = (
    instrumentation.middleware as unknown as {
      beforeModel: { hook: (s: unknown) => GateResult };
    }
  ).beforeModel.hook;
  return hook(state);
}

const userMessage = (content: string) => ({ role: "human", content });
const agentText = (content: string) => ({ role: "assistant", content });
const agentToolCall = () => ({
  role: "assistant",
  content: "",
  tool_calls: [{ name: "archmax_advance", args: { to: "review" } }],
});
const toolResult = () => ({ role: "tool", content: "advanced" });

describe("workflow middleware — the gate before the model", () => {
  it("starts the closing turn a fresh park owes: one reply-only call, then suspension", async () => {
    const gate = await beforeModel({
      workflowState: "review",
      pendingDecision: { state: "review", seq: 1, transitions: [], createdAt: "t" },
      parkPhase: "closing",
      messages: [userMessage("refund order 1042"), agentToolCall(), toolResult()],
    });
    expect(gate).toEqual({ replyOnly: true, parkPhase: "suspend" });
  });

  it("presents a delegated child's decision, then owes the closing turn", async () => {
    const decision = { state: "child-review", seq: 1, transitions: [{ to: "ok", description: "Test edge to ok." }], createdAt: "t" };
    const gate = (await beforeModel({
      workflowState: "work",
      pendingDelegations: [
        { state: "work", workflow: "enrich", toolCallId: "c1", identity: "work:enrich:0", dispatchId: "d1", decision },
      ],
      messages: [userMessage("go"), agentToolCall(), toolResult()],
    })) as Record<string, unknown>;
    expect(gate).toMatchObject({
      pendingDecision: { ...decision, seq: 1 },
      decisionCount: 1,
      status: "awaiting_decision",
      replyOnly: true,
      parkPhase: "suspend",
    });
  });

  it("lets a reply-only turn take its one model call while the person spoke last", async () => {
    const gate = await beforeModel({
      workflowState: "review",
      replyOnly: true,
      parkPhase: "suspend",
      pendingDecision: { state: "review", seq: 1, transitions: [], createdAt: "t" },
      messages: [agentText("It is with a reviewer."), userMessage("any news?")],
    });
    expect(gate).toBeUndefined();
  });

  it("ends the turn once a reply-only turn has been spent", async () => {
    const gate = await beforeModel({
      workflowState: "review",
      replyOnly: true,
      messages: [userMessage("any news?"), agentToolCall(), toolResult()],
    });
    expect(gate).toEqual({ jumpTo: "end" });
  });

  // Narration qualifies as something the run was told by carrying a marker, so a
  // note as the last message leaves the reply-only turn owed exactly as a
  // person's message would.
  it("still owes the turn when a runtime note is the last thing said", async () => {
    const gate = await beforeModel({
      workflowState: "review",
      replyOnly: true,
      messages: [
        userMessage("refund order 1042"),
        userMessage("[event] 'email_reply' arrived while the run waited in 'review'."),
        ...runtimeNote("decision", "[decision] A human selected approve → 'review'."),
      ],
    });
    expect(gate).toBeUndefined();
  });

  it("counts the model call against the state's turn budget", async () => {
    const first = await beforeModel({ workflowState: "work", messages: [userMessage("go")] });
    expect(first).toEqual({ stateTurns: { state: "work", count: 1 } });
    const later = await beforeModel({
      workflowState: "work",
      stateTurns: { state: "work", count: 2 },
      messages: [userMessage("go")],
    });
    expect(later).toEqual({ stateTurns: { state: "work", count: 3 } });
  });

  it("starts the count over in a new state", async () => {
    const gate = await beforeModel({
      workflowState: "done",
      stateTurns: { state: "work", count: 5 },
      messages: [userMessage("go")],
    });
    expect(gate).toEqual({ stateTurns: { state: "done", count: 1 } });
  });
});

describe("workflow middleware — reply-only turns", () => {
  async function replyOnlyCall(state: Record<string, unknown>) {
    const instrumentation = await parkInstrumentation();
    const wrapModelCall = (
      instrumentation.middleware as unknown as {
        wrapModelCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      }
    ).wrapModelCall;
    let seen: string[] = [];
    let blocks: ShapedBlock[] = [];
    const request = {
      runtime: { configurable: { thread_id: "t1" } },
      tools: [
        { name: "write_file" },
        { name: "archmax_advance" },
        { name: "read_file" },
        { name: "task" },
      ] as unknown as import("@langchain/core/tools").StructuredTool[],
      messages: [],
      state: { messages: [], ...state },
      systemMessage: new SystemMessage("BASE"),
      systemPrompt: "BASE",
    };
    await wrapModelCall(request, (req: unknown) => {
      seen = ((req as { tools?: { name: string }[] }).tools ?? []).map((t) => t.name);
      blocks = (req as ModelCallRequest).systemMessage.content;
      return new AIMessage("Your refund is with a reviewer.");
    });
    return { seen, text: blocks.map((b) => b.text).join("\n") };
  }

  it("discloses no tools at all", async () => {
    const { seen } = await replyOnlyCall({
      workflowState: "review",
      replyOnly: true,
    });
    expect(seen).toEqual([]);
  });

  it("tells the model it is parked and cannot act", async () => {
    const { text } = await replyOnlyCall({
      workflowState: "review",
      replyOnly: true,
    });
    expect(text).toContain("This run is parked");
    expect(text).toContain("review");
    expect(text).toContain("Reviewer check");
    // A park is exactly where the clock matters most: the handoff message is
    // written now, and "now" may be days after the run started.
    expect(text).toMatch(/Current date and time: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    expect(text).toContain("no tools");
  });

  it("withholds the human node's reviewer instructions from the agent", async () => {
    const { text } = await replyOnlyCall({
      workflowState: "review",
      replyOnly: true,
    });
    expect(text).not.toContain("Confirm the recorded decision");
  });

  // The graph is disclosed to a turn that can move; a parked turn cannot, so it
  // is told no more about the edges than it is handed tools to take them with.
  it("discloses no transitions, matching the tools it is handed", async () => {
    const { text } = await replyOnlyCall({
      workflowState: "review",
      replyOnly: true,
    });
    expect(text).not.toContain("Transitions");
    expect(text).not.toContain("- to `done`");
    expect(text).not.toContain("approve it");
    expect(text).not.toContain("This state is terminal");
  });

  it("frames the handoff turn as a handoff, not as an answer to a question", async () => {
    // The last thing in the transcript is the advance's own result, not a
    // person's message — the run just handed itself over.
    const { text } = await replyOnlyCall({
      workflowState: "review",
      replyOnly: true,
      pendingDecision: { state: "review", seq: 1, transitions: [], createdAt: "t" },
      messages: [userMessage("refund it"), agentToolCall(), toolResult()],
    });
    expect(text).toContain("handed this run to a person");
  });

  it("frames the answer to a person's message as an answer", async () => {
    const { text } = await replyOnlyCall({
      workflowState: "review",
      replyOnly: true,
      pendingDecision: { state: "review", seq: 1, transitions: [], createdAt: "t" },
      messages: [agentText("It is with a reviewer."), userMessage("any news?")],
    });
    expect(text).toContain("a person is deciding what happens next");
  });

  it("names what a wait park is waiting for", async () => {
    const { text } = await replyOnlyCall({
      workflowState: "work",
      replyOnly: true,
      pendingInput: { state: "work", reason: "the customer to name an order", parkedAt: "t" },
    });
    expect(text).toContain("the customer to name an order");
  });

  it("discloses the state's tools normally on an ordinary turn", async () => {
    const { seen, text } = await replyOnlyCall({ segmentAt: "work", workflowState: "work" });
    expect(seen).toContain("write_file");
    expect(seen).toContain("archmax_advance");
    expect(text).toContain("Current state: work");
  });
});

describe("workflow middleware skill governance", () => {
  const SKILLS_YAML = `
skills:
  allow_always: []
states:
  lookup:
    triggers: { manual: }
    instructions: Find the orders.
    skills:
      allow: [order-data, refund-policy]
    transitions:
      - to: refund
        description: refund needed
  refund:
    skills:
      allow: [refund-policy]
    transitions:
      - to: draft
        description: decided
  draft:
    skills:
      allow: []
`;

  const REGISTRY = new Map([
    [
      "order-data",
      {
        slug: "order-data",
        description: "The order records every answer comes from",
        prefix: "skills/order-data",
        skillFile: "skills/order-data/SKILL.md",
      },
    ],
    [
      "refund-policy",
      {
        slug: "refund-policy",
        description: "When a refund may be issued.",
        prefix: "skills/refund-policy",
        skillFile: "skills/refund-policy/SKILL.md",
      },
    ],
    [
      "order-enrichment",
      {
        slug: "order-enrichment",
        description: "Fan-out enrichment of order records.",
        prefix: "skills/order-enrichment",
        skillFile: "skills/order-enrichment/SKILL.md",
      },
    ],
  ]);

  async function skillInstrumentation() {
    const machine = await WorkflowMachine.load(machineWorkspace(SKILLS_YAML), SPEC_PATHS);
    if (!machine) throw new Error("failed to load skills machine");
    return createWorkflowInstrumentation({
      machine,
      executor: trackingExecutor(passOutcome).executor,
      ptcNames: [],
      skills: REGISTRY,
      mountPrefixes: { dirs: ["skills"], files: [], writable: [], governed: [], unsearchable: [] },
      onEvent: () => {},
    });
  }

  /** Drive one model call in `workflowState` and return both system blocks. */
  async function blocksFor(workflowState: string): Promise<{ static: string; volatile: string }> {
    const instrumentation = await skillInstrumentation();
    const wrapModelCall = (
      instrumentation.middleware as unknown as {
        wrapModelCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      }
    ).wrapModelCall;
    let blocks: { type: string; text: string }[] = [];
    await wrapModelCall(
      {
        runtime: { configurable: { thread_id: `t-${workflowState}` } },
        tools: [{ name: "read_file" } as unknown as import("@langchain/core/tools").StructuredTool],
        messages: [],
        state: { messages: [], workflowState },
        systemMessage: new SystemMessage("BASE"),
        systemPrompt: "BASE",
      },
      (req) => {
        blocks = (req as ModelCallRequest).systemMessage.content;
        return new AIMessage("AI");
      },
    );
    return { static: blocks[0]?.text ?? "", volatile: blocks[1]?.text ?? "" };
  }

  it("discloses only the active state's skills, with their descriptions", async () => {
    const { volatile } = await blocksFor("lookup");
    expect(volatile).toContain("Skills available in this state");
    expect(volatile).toContain("`order-data`");
    expect(volatile).toContain("The order records every answer comes from.");
    expect(volatile).toContain("Read `skills/order-data/SKILL.md` first.");
    // Enabled by this state too, so it is disclosed here…
    expect(volatile).toContain("`refund-policy`");
    // …while a skill the workflow's root list omits is named nowhere.
    expect(volatile).not.toContain("order-enrichment");
  });

  it("changes disclosure with the state", async () => {
    const { volatile } = await blocksFor("refund");
    expect(volatile).toContain("`refund-policy`");
    expect(volatile).not.toContain("`order-data`");
  });

  it("renders no section at all for a state that enables nothing", async () => {
    const { volatile } = await blocksFor("draft");
    expect(volatile).not.toContain("Skills available in this state");
  });

  it("keeps the cacheable static block byte-identical across states", async () => {
    const [a, b, c] = await Promise.all([
      blocksFor("lookup"),
      blocksFor("refund"),
      blocksFor("draft"),
    ]);
    expect(a.static).toBe("BASE");
    expect(b.static).toBe(a.static);
    expect(c.static).toBe(a.static);
    expect(b.volatile).not.toBe(a.volatile);
  });

  it("renders the section byte-identically on repeated calls in one state", async () => {
    const [first, second] = [await blocksFor("lookup"), await blocksFor("lookup")];
    expect(second.volatile).toBe(first.volatile);
  });

  /** Drive one tool call in `workflowState` and return the middleware's result. */
  async function toolCall(
    workflowState: string,
    name: string,
    args: Record<string, unknown>,
    handlerResult: unknown,
  ): Promise<unknown> {
    const instrumentation = await skillInstrumentation();
    const wrapToolCall = (
      instrumentation.middleware as unknown as {
        wrapToolCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      }
    ).wrapToolCall;
    return wrapToolCall(
      {
        toolCall: { name, args, id: "call-1" },
        runtime: { configurable: { thread_id: "ts" } },
        state: { messages: [], workflowState },
      },
      () => handlerResult,
    );
  }

  const listing = (content: string) =>
    new ToolMessage({ content, tool_call_id: "call-1", name: "ls" });

  it("filters a listing to the state's enabled bundles", async () => {
    const result = await toolCall(
      "refund",
      "ls",
      { path: "skills/" },
      listing(
        [
          "/skills/order-data (directory)",
          "/skills/refund-policy (directory)",
          "/skills/order-enrichment (directory)",
        ].join("\n"),
      ),
    );
    expect((result as ToolMessage).content).toBe("/skills/refund-policy (directory)");
  });

  it("filters grep matches out of a disabled bundle", async () => {
    const result = await toolCall(
      "lookup",
      "grep",
      { pattern: "refundWindowDays", path: "skills/" },
      new ToolMessage({
        content: [
          "",
          "/skills/refund-policy/rules.json:",
          "  1: refundWindowDays: 30",
          "",
          "/skills/order-data/assets/orders.json:",
          "  3: ACME-1",
        ].join("\n"),
        tool_call_id: "call-1",
        name: "grep",
      }),
    );
    // `lookup` enables both, so the refund group survives here.
    expect((result as ToolMessage).content).toContain("refundWindowDays");

    const narrowed = await toolCall(
      "refund",
      "grep",
      { pattern: "ACME", path: "skills/" },
      new ToolMessage({
        content: ["", "/skills/order-data/assets/orders.json:", "  3: ACME-1"].join("\n"),
        tool_call_id: "call-1",
        name: "grep",
      }),
    );
    expect((narrowed as ToolMessage).content).toBe("");
  });

  it("leaves an enabled bundle's own listing complete", async () => {
    const content = [
      "/skills/refund-policy/SKILL.md (400 bytes)",
      "/skills/refund-policy/scripts (directory)",
    ].join("\n");
    const result = await toolCall("refund", "ls", { path: "skills/refund-policy/" }, listing(content));
    expect((result as ToolMessage).content).toBe(content);
  });

  it("carries the filtered message's identity and metadata over", async () => {
    const result = await toolCall(
      "refund",
      "ls",
      { path: "skills/" },
      new ToolMessage({
        content: "/skills/order-data (directory)\n/skills/refund-policy (directory)",
        tool_call_id: "call-1",
        name: "ls",
        id: "msg-42",
        status: "success",
        additional_kwargs: { marker: true },
      }),
    );
    expect(result).toMatchObject({
      id: "msg-42",
      tool_call_id: "call-1",
      name: "ls",
      status: "success",
      additional_kwargs: { marker: true },
    });
    expect((result as ToolMessage).content).toBe("/skills/refund-policy (directory)");
  });

  it("leaves a read_file result untouched", async () => {
    const content = "1\tsome file body mentioning skills/order-enrichment/SKILL.md";
    const result = await toolCall(
      "refund",
      "read_file",
      { file_path: "scratchpad/notes.md" },
      new ToolMessage({ content, tool_call_id: "call-1", name: "read_file" }),
    );
    expect((result as ToolMessage).content).toBe(content);
  });

  it("blocks a read into a bundle the state does not enable", async () => {
    const result = await toolCall(
      "refund",
      "read_file",
      { file_path: "skills/order-data/assets/orders.json" },
      "HANDLER_RAN",
    );
    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).status).toBe("error");
    expect(String((result as ToolMessage).content)).toContain("not enabled in state 'refund'");
  });
});

describe("workflow middleware mount governance", () => {
  const MOUNTS_YAML = `
mounts:
  allow_always: [reference]
states:
  intake:
    triggers: { manual: }
    instructions: Take the request.
    mounts:
      forbid: [reference]
    transitions:
      - to: triage
        description: routed
  triage:
    mounts:
      allow: [catalogs/eu]
    transitions:
      - to: draft
        description: decided
  draft:
    mounts:
      forbid: [reference, skills]
`;

  /** `reference` and `catalogs/eu` governed, `skills` and `shared` not. */
  const MOUNT_PREFIXES = {
    dirs: ["skills", "reference", "catalogs/eu", "shared"],
    files: [],
    writable: ["shared"],
    governed: ["reference", "catalogs/eu"],
    unsearchable: [],
  };

  async function mountInstrumentation() {
    const machine = await WorkflowMachine.load(machineWorkspace(MOUNTS_YAML), SPEC_PATHS);
    if (!machine) throw new Error("failed to load mounts machine");
    return createWorkflowInstrumentation({
      machine,
      executor: trackingExecutor(passOutcome).executor,
      ptcNames: [],
      skills: new Map(),
      mountPrefixes: MOUNT_PREFIXES,
      onEvent: () => {},
    });
  }

  /** Drive one model call in `workflowState` and return both system blocks. */
  async function blocksFor(workflowState: string): Promise<{ static: string; volatile: string }> {
    const instrumentation = await mountInstrumentation();
    const wrapModelCall = (
      instrumentation.middleware as unknown as {
        wrapModelCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      }
    ).wrapModelCall;
    let blocks: { type: string; text: string }[] = [];
    await wrapModelCall(
      {
        runtime: { configurable: { thread_id: `t-${workflowState}` } },
        tools: [{ name: "read_file" } as unknown as import("@langchain/core/tools").StructuredTool],
        messages: [],
        state: { messages: [], workflowState },
        systemMessage: new SystemMessage("BASE"),
        systemPrompt: "BASE",
      },
      (req) => {
        blocks = (req as ModelCallRequest).systemMessage.content;
        return new AIMessage("AI");
      },
    );
    return { static: blocks[0]?.text ?? "", volatile: blocks[1]?.text ?? "" };
  }

  it("discloses the governed mounts the state enables, as the agent addresses them", async () => {
    const { volatile } = await blocksFor("triage");
    expect(volatile).toContain("Mounts available in this state");
    expect(volatile).toContain("`catalogs/eu/`");
    expect(volatile).toContain("read-only");
    // The always-on grant reaches this state too.
    expect(volatile).toContain("`reference/`");
  });

  it("renders no section for a state that reaches no governed mount", async () => {
    // `intake` forbids the one mount the workflow grants always.
    const { volatile } = await blocksFor("intake");
    expect(volatile).not.toContain("Mounts available in this state");
    expect(volatile).not.toContain("`reference/`");
  });

  it("keeps the cacheable static block byte-identical across states", async () => {
    const [a, b, c] = await Promise.all([
      blocksFor("intake"),
      blocksFor("triage"),
      blocksFor("draft"),
    ]);
    expect(a.static).toBe("BASE");
    expect(b.static).toBe(a.static);
    expect(c.static).toBe(a.static);
    expect(b.volatile).not.toBe(a.volatile);
  });

  it("renders the section byte-identically on repeated calls in one state", async () => {
    const [first, second] = [await blocksFor("triage"), await blocksFor("triage")];
    expect(second.volatile).toBe(first.volatile);
  });

  /** Drive one tool call in `workflowState` and return the middleware's result. */
  async function toolCall(
    workflowState: string,
    name: string,
    args: Record<string, unknown>,
    handlerResult: unknown,
  ): Promise<unknown> {
    const instrumentation = await mountInstrumentation();
    const wrapToolCall = (
      instrumentation.middleware as unknown as {
        wrapToolCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      }
    ).wrapToolCall;
    return wrapToolCall(
      {
        toolCall: { name, args, id: "call-1" },
        runtime: { configurable: { thread_id: "tm" } },
        state: { messages: [], workflowState },
      },
      () => handlerResult,
    );
  }

  const listing = (content: string) =>
    new ToolMessage({ content, tool_call_id: "call-1", name: "ls" });

  it("filters the workspace root listing to the mounts the state can reach", async () => {
    const root = [
      "/skills (directory)",
      "/reference (directory)",
      "/catalogs (directory)",
      "/shared (directory)",
      "/scratchpad (directory)",
    ].join("\n");
    expect((await toolCall("triage", "ls", { path: "/" }, listing(root)) as ToolMessage).content).toBe(
      root,
    );
    // `intake` forbids `reference`, so the entry is gone from its root listing.
    expect((await toolCall("intake", "ls", { path: "/" }, listing(root)) as ToolMessage).content).toBe(
      [
        "/skills (directory)",
        "/catalogs (directory)",
        "/shared (directory)",
        "/scratchpad (directory)",
      ].join("\n"),
    );
  });

  it("filters glob results under a governed mount the state does not have", async () => {
    const globbed = ["/catalogs/eu/skus.csv", "/reference/rates.csv", "/scratchpad/x.csv"].join("\n");
    const result = await toolCall("draft", "glob", { pattern: "**/*.csv" }, listing(globbed));
    // `draft` forbids `reference` and enables no governed mount of its own.
    expect((result as ToolMessage).content).toBe("/scratchpad/x.csv");
  });

  it("filters grep matches out of a mount the state cannot see", async () => {
    const result = await toolCall(
      "intake",
      "grep",
      { pattern: "EUR", path: "/" },
      new ToolMessage({
        content: ["", "/reference/rates.csv:", "  3: EUR,1.08", "", "/scratchpad/n.md:", "  1: EUR"].join(
          "\n",
        ),
        tool_call_id: "call-1",
        name: "grep",
      }),
    );
    // The matched content does not survive its filename.
    expect(String((result as ToolMessage).content)).not.toContain("1.08");
    expect(String((result as ToolMessage).content)).toContain("/scratchpad/n.md:");
  });

  it("leaves an ungoverned mount's listing complete where nothing forbids it", async () => {
    const content = ["/skills/order-data (directory)", "/skills/README.md (12 bytes)"].join("\n");
    const result = await toolCall("triage", "ls", { path: "skills/" }, listing(content));
    expect((result as ToolMessage).content).toBe(content);
  });

  it("blocks a read under a governed mount the state does not enable", async () => {
    const result = await toolCall("intake", "read_file", { file_path: "catalogs/eu/skus.csv" }, "RAN");
    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).status).toBe("error");
    expect(String((result as ToolMessage).content)).toContain("state 'intake' does not have");
  });

  it("blocks a read under a mount the state forbids, saying a denial did it", async () => {
    const result = await toolCall("intake", "read_file", { file_path: "reference/rates.csv" }, "RAN");
    expect(String((result as ToolMessage).content)).toContain("state 'intake' forbids");
  });
});

// A machine whose one state guards `send_reply`'s `to` against a run variable and
// lets `write_file` anywhere under the working area — enough to exercise both
// sides of substitution meeting the same guard.
const INTERPOLATION_YAML = `
states:
  g:
    triggers: { manual: }
    tools:
      allow:
        - { tool: send_reply, args: { to: ["\${{from_email}}"] } }
        - { tool: post_messages }
        - { tool: write_file, paths: ["scratchpad/**"] }
    transitions:
      - to: done
        description: finish
  done:
`;

/** Drive one tool call against a machine and a seeded variable store. */
async function callWithVariables(
  yaml: string,
  name: string,
  args: Record<string, unknown>,
  values: Record<string, unknown> = {},
) {
  const machine = await WorkflowMachine.load(machineWorkspace(yaml), SPEC_PATHS);
  if (!machine) throw new Error("failed to load state machine");
  const events: WorkflowLifecycleEvent[] = [];
  const instrumentation = createWorkflowInstrumentation({
    machine,
    executor: trackingExecutor(passOutcome).executor,
    ptcNames: [],
    onEvent: (e) => events.push(e),
  });
  const wrapToolCall = (
    instrumentation.middleware as unknown as {
      wrapToolCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
    }
  ).wrapToolCall;
  const variables: VariableStore = Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, { value: v, locked: false }]),
  );
  let seen: Record<string, unknown> | undefined;
  const result = await wrapToolCall(
    {
      toolCall: { name, args, id: "call-1" },
      runtime: { configurable: { thread_id: "t1" } },
      state: { messages: [], workflowState: "g", variables },
    },
    (req: unknown) => {
      seen = (req as { toolCall: { args: Record<string, unknown> } }).toolCall.args;
      return "HANDLER_RAN";
    },
  );
  return { result, seen, events };
}

describe("workflow middleware agent-argument interpolation", () => {
  it("delivers the resolved value to the tool", async () => {
    const { seen, result } = await callWithVariables(
      INTERPOLATION_YAML,
      "send_reply",
      { to: "${{from_email}}", body: "Refunded.\n\n--- Original ---\n\n${{inbound.text}}" },
      { from_email: "a@b.c", inbound: { text: "my order is late" } },
    );
    expect(result).toBe("HANDLER_RAN");
    expect(seen).toEqual({
      to: "a@b.c",
      body: "Refunded.\n\n--- Original ---\n\nmy order is late",
    });
  });

  it("matches a guard that references the same variable", async () => {
    // The guard resolves `${{from_email}}` and so does the argument, so they meet
    // on the value rather than on the model having retyped it.
    const { result } = await callWithVariables(
      INTERPOLATION_YAML,
      "send_reply",
      { to: "${{from_email}}" },
      { from_email: "a@b.c" },
    );
    expect(result).toBe("HANDLER_RAN");
  });

  it("still blocks when the resolved value misses the guard", async () => {
    const { result } = await callWithVariables(
      INTERPOLATION_YAML,
      "send_reply",
      { to: "${{other}}" },
      { from_email: "a@b.c", other: "stranger@x.y" },
    );
    expect((result as ToolMessage).status).toBe("error");
    expect((result as ToolMessage).content).toContain("send_reply");
  });

  it("canonicalizes a substituted path, so substitution cannot dodge zone rules", async () => {
    const { result } = await callWithVariables(
      INTERPOLATION_YAML,
      "write_file",
      { file_path: "scratchpad/${{v}}", content: "x" },
      { v: "../checkpoints/cp.json" },
    );
    expect((result as ToolMessage).status).toBe("error");
    expect((result as ToolMessage).content).not.toContain("${{v}}");
  });

  it("walks nested arguments", async () => {
    const { seen } = await callWithVariables(
      INTERPOLATION_YAML,
      "post_messages",
      { messages: [{ text: "quote: ${{note}}" }], limit: 3 },
      { note: "hi" },
    );
    expect(seen).toEqual({ messages: [{ text: "quote: hi" }], limit: 3 });
  });

  it("honours the $${{…}} literal escape", async () => {
    const { seen } = await callWithVariables(
      INTERPOLATION_YAML,
      "write_file",
      { file_path: "scratchpad/guard.yaml", content: "to: [\"$${{from_email}}\"]" },
      { from_email: "a@b.c" },
    );
    expect(seen).toMatchObject({ content: 'to: ["${{from_email}}"]' });
  });

  it("leaves a reference-free call untouched", async () => {
    const args = { file_path: "scratchpad/n.md", content: "hello" };
    const { seen } = await callWithVariables(INTERPOLATION_YAML, "write_file", args);
    expect(seen).toEqual(args);
  });

  it("refuses an unresolved reference without running the tool, and stays correctable", async () => {
    const { result, seen, events } = await callWithVariables(
      INTERPOLATION_YAML,
      "send_reply",
      { to: "${{from_email}}", body: "${{missing_var}}" },
      { from_email: "a@b.c" },
    );
    expect(seen).toBeUndefined();
    const message = result as ToolMessage;
    expect(message.status).toBe("error");
    expect(message.additional_kwargs).toMatchObject({ governance_blocked: true });
    expect(message.content).toContain("${{missing_var}}");
    expect(message.content).toContain("archmax_get_variables");
    // The escape is offered as one of the two fixes.
    expect(message.content).toContain("$${{missing_var}}");
    // Correctable, not terminal: a ToolMessage, never a Command committing
    // `rejected`, so the agent gets another attempt.
    expect(message).toBeInstanceOf(ToolMessage);
    expect(events.some((e) => e.type === "tool-blocked")).toBe(true);
  });

  it("leaves the model's own call object untouched, so the transcript keeps the reference", async () => {
    // The whole token saving rests on this split: the AI message the transcript
    // replays carries `${{…}}`, while the tool receives the value. Writing the
    // resolved text back into the message would re-send it on every later model
    // call — exactly the cost referencing a variable exists to avoid.
    const machine = await WorkflowMachine.load(machineWorkspace(INTERPOLATION_YAML), SPEC_PATHS);
    if (!machine) throw new Error("failed to load state machine");
    const instrumentation = createWorkflowInstrumentation({
      machine,
      executor: trackingExecutor(passOutcome).executor,
      ptcNames: [],
      onEvent: () => {},
    });
    const wrapToolCall = (
      instrumentation.middleware as unknown as {
        wrapToolCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      }
    ).wrapToolCall;
    const emitted = { to: "${{from_email}}" };
    let seen: Record<string, unknown> | undefined;
    await wrapToolCall(
      {
        toolCall: { name: "send_reply", args: emitted, id: "call-1" },
        runtime: { configurable: { thread_id: "t1" } },
        state: {
          messages: [],
          workflowState: "g",
          variables: { from_email: { value: "a@b.c", locked: true } },
        },
      },
      (req: unknown) => {
        seen = (req as { toolCall: { args: Record<string, unknown> } }).toolCall.args;
        return "HANDLER_RAN";
      },
    );
    expect(seen).toEqual({ to: "a@b.c" });
    expect(emitted).toEqual({ to: "${{from_email}}" });
  });

  it("exempts a delegation tool, whose params have their own single pass", async () => {
    // Not substituted here: `resolveParams` resolves a delegation's declared
    // params and reports failure in delegation terms. The reference therefore
    // survives this stage untouched — visible on the block the kernel issues for
    // a tool this state does not declare.
    const { events } = await callWithVariables(
      INTERPOLATION_YAML,
      "archmax_workflow_enrich_order",
      { account_id: "${{acct}}" },
      { acct: "acct-42" },
    );
    const blocked = events.find((e) => e.type === "tool-blocked") as unknown as {
      args: Record<string, unknown>;
    };
    expect(blocked.args).toEqual({ account_id: "${{acct}}" });
  });

  it("reports the raw argument on the refusal event", async () => {
    const { events } = await callWithVariables(INTERPOLATION_YAML, "send_reply", {
      to: "${{nope}}",
    });
    const blocked = events.find((e) => e.type === "tool-blocked") as unknown as {
      args: Record<string, unknown>;
    };
    expect(blocked.args).toEqual({ to: "${{nope}}" });
  });
});

const FORK_YAML = `
states:
  g:
    triggers: { manual: }
    after: { script: hooks/after.js }
    transitions:
      - to: b
        description: one way
      - to: c
        description: another way
  b:
  c:
`;

describe("one transition per model step", () => {
  /** One instrumentation, driven step by step the way the tool node would. */
  async function forkRunner() {
    const machine = await WorkflowMachine.load(machineWorkspace(FORK_YAML), SPEC_PATHS);
    if (!machine) throw new Error("failed to load fork machine");
    const tracker = trackingExecutor(passOutcome);
    const mw = (
      createWorkflowInstrumentation({ machine, executor: tracker.executor, ptcNames: [] })
        .middleware as unknown as {
        wrapToolCall: (req: unknown, handler: (r: unknown) => unknown) => Promise<unknown>;
      }
    ).wrapToolCall;

    /**
     * One model step: every sibling call is handed the *same* step-start
     * snapshot, because the tool node does not re-read state between the calls
     * of a single assistant message.
     */
    return async function step(messageId: string, from: string, targets: string[]) {
      const state = {
        workflowState: from,
        messages: [
          new AIMessage({
            id: messageId,
            content: "",
            tool_calls: targets.map((to, i) => ({
              name: "archmax_advance",
              args: { to, reason: "go" },
              id: `${messageId}-${i}`,
            })),
          }),
        ],
      };
      const results: unknown[] = [];
      for (const [i, to] of targets.entries()) {
        results.push(
          await mw(
            {
              toolCall: { name: "archmax_advance", args: { to, reason: "go" }, id: `${messageId}-${i}` },
              runtime: { configurable: { thread_id: "dup" } },
              state,
            },
            () => "OK",
          ),
        );
      }
      return { results, afterHookRuns: tracker.calls };
    };
  }

  /** The position a serviced advance committed, or undefined for a refusal. */
  const committed = (result: unknown) =>
    (result as { update?: { workflowState?: string } }).update?.workflowState;

  it("honours the first advance, refuses its siblings, and runs the after hook once", async () => {
    // Both siblings used to pass edge validation against the same `from`, each
    // running `g`'s `after` hook and each committing a position to a last-value
    // channel — so the hook double-executed and the run landed wherever the
    // last writer said (issue #66).
    const step = await forkRunner();
    const { results, afterHookRuns } = await step("ai-1", "g", ["b", "c"]);

    expect(committed(results[0])).toBe("b");
    expect(committed(results[1])).toBeUndefined();
    expect(results[1]).toBeInstanceOf(ToolMessage);
    expect(String((results[1] as ToolMessage).content)).toContain("already moved");
    expect(String((results[1] as ToolMessage).content)).toContain("'b'");
    expect(afterHookRuns).toBe(1);
  });

  it("scopes the guard to the message, so a later step may move again", async () => {
    const step = await forkRunner();
    expect(committed((await step("ai-1", "g", ["b"])).results[0])).toBe("b");
    // A fresh assistant message is a fresh step: this is a further transition,
    // not a duplicate of the first.
    expect(committed((await step("ai-2", "g", ["c"])).results[0])).toBe("c");
  });

  it("lets a sibling try after a refused attempt, which committed nothing", async () => {
    const step = await forkRunner();
    // 'nowhere' is not a declared target: refused by edge validation, so the
    // step is not claimed and the valid sibling still moves.
    const { results } = await step("ai-1", "g", ["nowhere", "b"]);

    expect(committed(results[0])).toBeUndefined();
    expect(committed(results[1])).toBe("b");
  });
});
