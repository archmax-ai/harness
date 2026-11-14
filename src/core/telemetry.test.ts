import { context, createContextKey, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { Command, GraphInterrupt, ParentCommand } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { installOtel, uninstallOtel, useOtel, type ReadableSpan } from "../behaviour/otel.js";
import { PACKAGE_VERSION } from "../env.js";
import { withEventContext, type WorkflowLifecycleEvent } from "./events.js";
import {
  errorTypeOf,
  isBlockedAnswer,
  isErrorAnswer,
  providerOf,
  reportedModelId,
  reportedRaiseCode,
  isParkingAnswer,
  reportedCallId,
  reportedToolName,
  Telemetry,
  thrownOutcomeOf,
  TELEMETRY_METRICS,
  TELEMETRY_SCOPE,
  toolOutcomeOf,
} from "./telemetry.js";

/** A lifecycle event as the emitter delivers it: envelope filled, session bound. */
function event(sessionId: string, payload: Record<string, unknown>): WorkflowLifecycleEvent {
  return {
    level: "info",
    ts: 0,
    seq: 0,
    sessionId,
    ...payload,
  } as unknown as WorkflowLifecycleEvent;
}

/** An answer as a model returns it: usage, the model it names, its finish. */
function answer(
  opts: {
    input?: number;
    output?: number;
    cacheRead?: number;
    model?: string;
    finish?: string;
    calls?: number;
  } = {},
): AIMessage {
  return new AIMessage({
    content: "a reply nobody may record",
    tool_calls: Array.from({ length: opts.calls ?? 0 }, (_, i) => ({
      id: `c${i}`,
      name: "lookup",
      args: {},
    })),
    usage_metadata: {
      input_tokens: opts.input ?? 100,
      output_tokens: opts.output ?? 20,
      total_tokens: (opts.input ?? 100) + (opts.output ?? 20),
      ...(opts.cacheRead ? { input_token_details: { cache_read: opts.cacheRead } } : {}),
    },
    response_metadata: {
      ...(opts.model ? { model_name: opts.model } : {}),
      ...(opts.finish ? { finish_reason: opts.finish } : {}),
    },
  });
}

const chatModel = (type: string) => ({ _llmType: () => type });

describe("what the telemetry may record", () => {
  it.each([
    ["lookup_order", "lookup_order"],
    ["archmax_workflow_refund-check", "archmax_workflow_refund-check"],
    ["mcp:billing.refund", "mcp:billing.refund"],
    ["x".repeat(64), "x".repeat(64)],
    ["x".repeat(65), "unknown"],
    ["", "unknown"],
    ["drop table orders", "unknown"],
    ["../../etc/passwd", "unknown"],
    ["lookup\norder", "unknown"],
    ["bestellübersicht", "unknown"],
  ])("reports the tool name %j as %j", (name, reported) => {
    expect(reportedToolName(name)).toBe(reported);
  });

  it("reports a raise code only when it is a short token", () => {
    expect(reportedRaiseCode("refund-denied")).toBe("refund-denied");
    expect(reportedRaiseCode("ORDER_NOT_FOUND")).toBe("ORDER_NOT_FOUND");
    expect(reportedRaiseCode("customer said: cancel order 4711")).toBeUndefined();
    expect(reportedRaiseCode("c".repeat(65))).toBeUndefined();
    expect(reportedRaiseCode(42)).toBeUndefined();
    expect(reportedRaiseCode(undefined)).toBeUndefined();
  });

  it("reports a model id only when it reads as one", () => {
    expect(reportedModelId("gpt-6-luna")).toBe("gpt-6-luna");
    expect(reportedModelId("openai/gpt-6-luna")).toBe("openai/gpt-6-luna");
    expect(reportedModelId("anthropic.claude-opus-5-5@2026-06-01")).toBe(
      "anthropic.claude-opus-5-5@2026-06-01",
    );
    expect(reportedModelId("my model")).toBeUndefined();
    expect(reportedModelId("m".repeat(129))).toBeUndefined();
    expect(reportedModelId("")).toBeUndefined();
    expect(reportedModelId(7)).toBeUndefined();
  });

  it("types an error by its HTTP status, then its class, never its message", () => {
    expect(
      errorTypeOf(Object.assign(new Error("rate limited for key sk-secret"), { status: 429 })),
    ).toBe("429");
    expect(errorTypeOf({ response: { status: 503 } })).toBe("503");
    expect(errorTypeOf(Object.assign(new TypeError("x"), { status: 400 }))).toBe("400");
    expect(errorTypeOf(new TypeError("order 4711 is not a function"))).toBe("TypeError");
    class AbortError extends Error {
      override name = "AbortError";
    }
    expect(errorTypeOf(new AbortError("aborted"))).toBe("AbortError");
    expect(errorTypeOf(Object.assign(new Error("x"), { status: 99 }))).toBe("Error");
    expect(errorTypeOf(Object.assign(new Error("x"), { status: "429" }))).toBe("Error");
    expect(errorTypeOf(Object.assign(new Error("x"), { name: "the customer's IBAN" }))).toBe(
      "Error",
    );
    // A `name` that is an identifier but not a class name is free text too.
    expect(errorTypeOf(Object.assign(new Error("x"), { name: "secret_value_42" }))).toBe("Error");
    expect(errorTypeOf(Object.assign(new Error("x"), { name: "ORD4711" }))).toBe("Error");
    // A class that keeps the default `name` is typed by its constructor.
    class RateLimitError extends Error {}
    expect(errorTypeOf(new RateLimitError("x"))).toBe("RateLimitError");
    class Leaky extends Error {}
    expect(errorTypeOf(new Leaky("x"))).toBe("Error");
    expect(errorTypeOf({ name: "ZodError" })).toBe("ZodError");
    expect(errorTypeOf({ name: "QuotaException" })).toBe("QuotaException");
    expect(errorTypeOf("thrown text with a secret")).toBe("Error");
    expect(errorTypeOf(null)).toBe("Error");
    expect(errorTypeOf(undefined)).toBe("Error");
  });

  it("reports a tool call's id only when it reads as one", () => {
    for (const id of ["call_abc123", "toolu_01AbC", "ptc:12", "tool-3", "c".repeat(128)]) {
      expect(reportedCallId(id)).toBe(id);
    }
    for (const id of ["call: my secret text here", "", "c".repeat(129), "../x", 7, undefined]) {
      expect(reportedCallId(id)).toBeUndefined();
    }
  });

  it("names the provider the GenAI conventions use", () => {
    expect(providerOf(chatModel("openai"))).toBe("openai");
    expect(providerOf(chatModel("anthropic"))).toBe("anthropic");
    expect(providerOf(chatModel("bedrock-converse"))).toBe("aws.bedrock");
    expect(providerOf(chatModel("google_genai"))).toBe("gcp.gemini");
    expect(providerOf(chatModel("archmax-behaviour-scripted"))).toBe("archmax-behaviour-scripted");
    expect(providerOf(chatModel("a provider name"))).toBeUndefined();
    expect(
      providerOf({
        _llmType: () => {
          throw new Error("no");
        },
      }),
    ).toBeUndefined();
    expect(providerOf({})).toBeUndefined();
    expect(providerOf(undefined)).toBeUndefined();
  });

  it("reads a thrown call's outcome: a park, a parent command, a cancellation, a failure", () => {
    const aborted = AbortSignal.abort();
    expect(thrownOutcomeOf(new GraphInterrupt([]), undefined)).toBe("parked");
    expect(thrownOutcomeOf(new GraphInterrupt([]), aborted)).toBe("parked");
    expect(thrownOutcomeOf(new ParentCommand(new Command({ goto: "x" })), undefined)).toBe("ok");
    expect(thrownOutcomeOf(new Error("x"), aborted)).toBe("cancelled");
    expect(thrownOutcomeOf(new Error("x"), new AbortController().signal)).toBe("error");
    expect(thrownOutcomeOf("thrown", undefined)).toBe("error");
  });

  it("reads a parking answer: a pending input, decision or delegation", () => {
    const answer = (update: Record<string, unknown>) => new Command({ update });
    expect(isParkingAnswer(answer({ pendingInput: { state: "a" } }))).toBe(true);
    expect(isParkingAnswer(answer({ pendingDecision: { state: "a" } }))).toBe(true);
    expect(isParkingAnswer(answer({ pendingDelegations: [{ workflow: "x" }] }))).toBe(true);
    expect(toolOutcomeOf(answer({ pendingInput: { state: "a" } }))).toBe("parked");
    expect(isParkingAnswer(answer({ pendingInput: null, pendingDecision: null }))).toBe(false);
    expect(isParkingAnswer(answer({ pendingDelegations: [] }))).toBe(false);
    expect(isParkingAnswer(answer({ workflowState: "b" }))).toBe(false);
    expect(isParkingAnswer(new ToolMessage({ content: "x", tool_call_id: "c" }))).toBe(false);
    expect(isParkingAnswer(undefined)).toBe(false);
    // A refusal is a refusal, whatever else it carries.
    const refused = new ToolMessage({
      content: "no",
      tool_call_id: "c",
      additional_kwargs: { governance_blocked: true },
    });
    expect(toolOutcomeOf(answer({ pendingInput: { state: "a" }, messages: [refused] }))).toBe(
      "blocked",
    );
  });

  it("reads a tool call's outcome from its answer, bare or in a command", () => {
    const blocked = new ToolMessage({
      content: "refused",
      tool_call_id: "c1",
      additional_kwargs: { governance_blocked: true },
    });
    const failed = new ToolMessage({ content: "boom", tool_call_id: "c2", status: "error" });
    const ok = new ToolMessage({ content: "fine", tool_call_id: "c3" });
    expect([isBlockedAnswer(blocked), isErrorAnswer(blocked), toolOutcomeOf(blocked)]).toEqual([
      true,
      false,
      "blocked",
    ]);
    expect([isBlockedAnswer(failed), isErrorAnswer(failed), toolOutcomeOf(failed)]).toEqual([
      false,
      true,
      "error",
    ]);
    expect(toolOutcomeOf(ok)).toBe("ok");
    expect(toolOutcomeOf(new Command({ update: { messages: [blocked] } }))).toBe("blocked");
    expect(toolOutcomeOf(new Command({ update: { messages: [failed] } }))).toBe("error");
    expect(toolOutcomeOf(new Command({ update: { messages: [ok] } }))).toBe("ok");
    expect(toolOutcomeOf(new Command({ update: { workflowState: "next" } }))).toBe("ok");
    expect(toolOutcomeOf(undefined)).toBe("ok");
  });
});

describe("with no SDK registered", () => {
  it("records nothing and still runs the work in its contexts", async () => {
    const telemetry = new Telemetry();
    const turn = telemetry.openTurn({ sessionId: "s1", workflow: "w" });
    expect(turn.recording).toBe(false);
    telemetry.observe(event("s1", { type: "state-enter", state: "a" }));
    const call = telemetry.modelCall({
      sessionId: "s1",
      state: "a",
      role: "agent",
      model: chatModel("openai"),
    });
    expect(context.with(call.context, () => 7)).toBe(7);
    call.settle(answer());
    const tool = telemetry.toolCall({
      sessionId: "s1",
      state: "a",
      tool: "lookup",
      callId: "c1",
      origin: "agent",
    });
    tool.end("ok");
    telemetry.observe(event("s1", { type: "state-leave", state: "a", next: "b" }));
    turn.end({ status: "completed" });
    expect(
      await telemetry.turn(
        { sessionId: "s2" },
        async () => "result",
        () => ({}),
      ),
    ).toBe("result");

    const otel = installOtel();
    try {
      expect(otel.spans()).toEqual([]);
      expect((await otel.metrics()).flatMap((m) => m.points)).toEqual([]);
    } finally {
      await uninstallOtel();
    }
  });
});

describe("the test kit", () => {
  it("collects what a span was named and carried when it started, not only when it ended", async () => {
    const otel = installOtel();
    try {
      const span = otel.tracer.startSpan("started as this", {
        attributes: { early: "value at start" },
      });
      span.updateName("ended as that");
      span.setAttribute("early", "value at end");
      span.end();
      const strings = await otel.strings();
      expect(strings).toEqual(
        expect.arrayContaining([
          "started as this",
          "value at start",
          "ended as that",
          "value at end",
        ]),
      );
    } finally {
      await uninstallOtel();
    }
  });

  it("leaves no provider, meter or context manager behind", async () => {
    const otel = installOtel();
    otel.tracer.startSpan("host").end();
    expect(otel.spans()).toHaveLength(1);
    await uninstallOtel();

    const span = trace.getTracer("after").startSpan("after");
    expect(span.isRecording()).toBe(false);
    const ctx = trace.setSpan(context.active(), span);
    expect(context.with(ctx, () => trace.getActiveSpan())).toBeUndefined();
    span.end();
    expect(() => otel.spans()).toThrow(/no OpenTelemetry SDK/);
  });
});

describe("Telemetry", () => {
  const otel = useOtel();
  const attrs = (span: ReadableSpan) => span.attributes;

  describe("a turn", () => {
    it("is an invoke_agent span with the session and workflow", () => {
      const telemetry = new Telemetry();
      const turn = telemetry.openTurn({ sessionId: "s1", workflow: "refund" });
      expect(turn.recording).toBe(true);
      turn.end({ status: "completed", state: "done" });

      const span = otel.one("invoke_agent refund");
      expect(span.kind).toBe(SpanKind.INTERNAL);
      expect(span.instrumentationScope).toMatchObject({
        name: TELEMETRY_SCOPE,
        version: PACKAGE_VERSION,
      });
      expect(attrs(span)).toEqual({
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "refund",
        "gen_ai.conversation.id": "s1",
        "archmax.turn.resume": false,
        "archmax.session.status": "completed",
        "archmax.state": "done",
      });
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
    });

    it("is named for no workflow when the agent is plain", () => {
      const telemetry = new Telemetry();
      telemetry.openTurn({ sessionId: "s1", resume: true }).end();
      const span = otel.one("invoke_agent");
      expect(attrs(span)["gen_ai.agent.name"]).toBeUndefined();
      expect(attrs(span)["archmax.turn.resume"]).toBe(true);
    });

    it.each(["failed", "rejected"])("is an error when the session is %s", (status) => {
      const telemetry = new Telemetry();
      telemetry.openTurn({ sessionId: "s1", workflow: "w" }).end({ status });
      const span = otel.one("invoke_agent w");
      expect(attrs(span)["error.type"]).toBe(`session_${status}`);
      expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
    });

    it.each(["completed", "running", "awaiting_decision", "awaiting_input"])(
      "is not an error when %s",
      (status) => {
        const telemetry = new Telemetry();
        telemetry.openTurn({ sessionId: "s1", workflow: "w" }).end({ status });
        expect(otel.one("invoke_agent w").status.code).toBe(SpanStatusCode.UNSET);
      },
    );

    it("ends as a park, not an error, when a child session's park leaves it as an interrupt", () => {
      const telemetry = new Telemetry();
      const turn = telemetry.openTurn({ sessionId: "child", workflow: "check" });
      telemetry.observe(event("child", { type: "state-enter", state: "review" }));
      telemetry.observe(
        event("child", {
          type: "parked",
          state: "review",
          sessionId: "child",
          awaiting: "decision",
        }),
      );
      turn.fail(new GraphInterrupt([]));
      const span = otel.one("invoke_agent check");
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
      expect(attrs(span)["error.type"]).toBeUndefined();
      expect(attrs(span)["archmax.session.status"]).toBe("awaiting_decision");
    });

    it("carries a thrown error's type, never its message, and records no exception", () => {
      const telemetry = new Telemetry();
      telemetry
        .openTurn({ sessionId: "s1", workflow: "w" })
        .fail(Object.assign(new Error("key sk-123 refused"), { status: 401 }));
      const span = otel.one("invoke_agent w");
      expect(attrs(span)["error.type"]).toBe("401");
      expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
      expect(span.events).toEqual([]);
    });

    it("ends once, however often it is settled", () => {
      const telemetry = new Telemetry();
      const turn = telemetry.openTurn({ sessionId: "s1", workflow: "w" });
      turn.end({ status: "completed" });
      turn.fail(new Error("late"));
      turn.end({ status: "failed" });
      expect(otel.spans()).toHaveLength(1);
      expect(otel.one("invoke_agent w").status.code).toBe(SpanStatusCode.UNSET);
    });

    it("starts in the host's span and keeps its own span active while it runs", async () => {
      const telemetry = new Telemetry();
      const host = otel.tracer.startSpan("host request");
      const seen = await context.with(trace.setSpan(context.active(), host), () =>
        telemetry.turn(
          { sessionId: "s1", workflow: "w" },
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            return trace.getActiveSpan()?.spanContext().spanId;
          },
          () => ({ status: "completed" }),
        ),
      );
      host.end();
      const span = otel.one("invoke_agent w");
      expect(seen).toBe(span.spanContext().spanId);
      expect(otel.parentOf(span)?.name).toBe("host request");
    });

    it("rethrows what the turn threw and still ends its span", async () => {
      const telemetry = new Telemetry();
      const boom = new RangeError("the customer's message");
      await expect(
        telemetry.turn(
          { sessionId: "s1", workflow: "w" },
          () => Promise.reject(boom),
          () => ({}),
        ),
      ).rejects.toBe(boom);
      expect(attrs(otel.one("invoke_agent w"))["error.type"]).toBe("RangeError");
    });

    it("is not failed when reading its outcome throws", async () => {
      const telemetry = new Telemetry();
      const result = await telemetry.turn(
        { sessionId: "s1", workflow: "w" },
        async () => "ok",
        () => {
          throw new Error("unreadable");
        },
      );
      expect(result).toBe("ok");
      expect(otel.one("invoke_agent w").status.code).toBe(SpanStatusCode.UNSET);
    });

    it("totals the usage of its own model calls", () => {
      const telemetry = new Telemetry();
      const pricing = { m: { input: 1, output: 2 } };
      const turn = telemetry.openTurn({ sessionId: "s1", workflow: "w" });
      for (const [input, output] of [
        [1_000_000, 0],
        [0, 500_000],
      ] as const) {
        telemetry
          .modelCall({
            sessionId: "s1",
            role: "agent",
            model: chatModel("openai"),
            pricing,
            pricingModel: "m",
          })
          .settle(answer({ input, output, cacheRead: 10 }));
      }
      turn.end({ status: "completed" });
      const calls = otel.named("chat").map((span) => Number(attrs(span)["gen_ai.usage.cost"]));
      expect(attrs(otel.one("invoke_agent w"))).toMatchObject({
        "gen_ai.usage.input_tokens": 1_000_000,
        "gen_ai.usage.output_tokens": 500_000,
        "gen_ai.usage.cache_read.input_tokens": 20,
        "gen_ai.usage.cache_creation.input_tokens": 0,
        "gen_ai.usage.cost": expect.closeTo(calls[0]! + calls[1]!, 9),
      });
      expect(calls[0]! + calls[1]!).toBeCloseTo(2, 3);
    });

    it("carries no usage when it made no model call", () => {
      const telemetry = new Telemetry();
      telemetry.openTurn({ sessionId: "s1", workflow: "w" }).end({ status: "completed" });
      expect(attrs(otel.one("invoke_agent w"))["gen_ai.usage.input_tokens"]).toBeUndefined();
    });

    it("shadows an open turn of the same session and gives it back when it ends", () => {
      const telemetry = new Telemetry();
      const outer = telemetry.openTurn({ sessionId: "s1", workflow: "outer" });
      const inner = telemetry.openTurn({ sessionId: "s1", workflow: "inner" });
      telemetry.observe(event("s1", { type: "state-enter", state: "a" }));
      inner.end();
      telemetry.observe(event("s1", { type: "state-enter", state: "b" }));
      outer.end();
      expect(otel.parentOf(otel.one("state a"))?.name).toBe("invoke_agent inner");
      expect(otel.parentOf(otel.one("state b"))?.name).toBe("invoke_agent outer");
    });

    it("never gives back a turn that already ended, whatever order turns end in", () => {
      const telemetry = new Telemetry();
      const first = telemetry.openTurn({ sessionId: "s1", workflow: "first" });
      const second = telemetry.openTurn({ sessionId: "s1", workflow: "second" });
      first.end();
      telemetry.observe(event("s1", { type: "state-enter", state: "a" }));
      second.end();
      // Both ended: an event of the session now has no turn to land in.
      telemetry.observe(event("s1", { type: "state-enter", state: "late" }));
      const third = telemetry.openTurn({ sessionId: "s1", workflow: "third" });
      telemetry.observe(event("s1", { type: "state-enter", state: "b" }));
      third.end();

      expect(otel.parentOf(otel.one("state a"))?.name).toBe("invoke_agent second");
      expect(otel.named("state late")).toEqual([]);
      expect(otel.parentOf(otel.one("state b"))?.name).toBe("invoke_agent third");
      expect(otel.spans().every((span) => span.ended)).toBe(true);
    });

    it("keeps two turns open on one session apart by the context their work runs in", async () => {
      const telemetry = new Telemetry();
      const one = telemetry.openTurn({ sessionId: "s1", workflow: "one" });
      const two = telemetry.openTurn({ sessionId: "s1", workflow: "two" });
      const work = (turn: typeof one, slug: string, input: number) =>
        context.with(turn.context, async () => {
          await new Promise((resolve) => setTimeout(resolve, input === 1 ? 5 : 1));
          telemetry.observe(event("s1", { type: "state-enter", state: slug }));
          telemetry
            .modelCall({ sessionId: "s1", state: slug, role: "agent", model: undefined })
            .settle(answer({ input, output: 0 }));
        });
      await Promise.all([work(one, "a", 1), work(two, "b", 2)]);
      one.end();
      two.end();

      expect(otel.outline()).toBe(
        [
          "invoke_agent one",
          "  state a",
          "    chat",
          "invoke_agent two",
          "  state b",
          "    chat",
        ].join("\n"),
      );
      expect(attrs(otel.one("invoke_agent one"))["gen_ai.usage.input_tokens"]).toBe(1);
      expect(attrs(otel.one("invoke_agent two"))["gen_ai.usage.input_tokens"]).toBe(2);
    });

    it("never gives a later turn the work of a turn that already ended", () => {
      const telemetry = new Telemetry();
      const stopped = telemetry.openTurn({ sessionId: "s1", workflow: "a" });
      stopped.end();
      const next = telemetry.openTurn({ sessionId: "s1", workflow: "b" });
      // The stopped turn's graph is still going, in the stopped turn's context.
      context.with(stopped.context, () => {
        telemetry.observe(event("s1", { type: "state-enter", state: "late" }));
        telemetry
          .modelCall({ sessionId: "s1", state: "late", role: "agent", model: undefined })
          .settle(answer({ input: 999, output: 0 }));
      });
      next.end();

      expect(otel.named("state late")).toEqual([]);
      expect(otel.parentOf(otel.one("chat"))?.name).toBe("invoke_agent a");
      expect(attrs(otel.one("invoke_agent b"))["gen_ai.usage.input_tokens"]).toBeUndefined();
    });

    it("never fails the work it reports, whatever the answer looks like", () => {
      const telemetry = new Telemetry();
      const turn = telemetry.openTurn({ sessionId: "s1", workflow: "w" });
      const hostile = {
        get usage_metadata(): never {
          throw new Error("a getter that throws");
        },
      };
      const call = telemetry.modelCall({ sessionId: "s1", role: "agent", model: undefined });
      expect(() => call.settle(hostile)).not.toThrow();
      expect(() =>
        telemetry
          .toolCall({ sessionId: "s1", tool: "x", callId: "c", origin: "agent" })
          .end("blocked", {
            toString: () => {
              throw new Error("no");
            },
          } as never),
      ).not.toThrow();
      expect(() => turn.end({ status: "completed" })).not.toThrow();
      // Every span still ended, the refused annotations aside.
      expect(otel.spans().map((span) => [span.name, span.ended])).toEqual([
        ["chat", true],
        ["execute_tool x", true],
        ["invoke_agent w", true],
      ]);
      expect(attrs(otel.one("execute_tool x"))["archmax.tool.rule"]).toBeUndefined();
    });

    it("names the sub-workflow dispatch it runs for", () => {
      const telemetry = new Telemetry();
      withEventContext({ sessionId: "child", subWorkflowDispatchId: "d-1" }, () =>
        telemetry.openTurn({ sessionId: "child", workflow: "check" }).end(),
      );
      expect(attrs(otel.one("invoke_agent check"))["archmax.dispatch.id"]).toBe("d-1");
    });
  });

  describe("state visits", () => {
    function turnWith(stateType?: (slug: string) => string | undefined) {
      const telemetry = new Telemetry();
      const turn = telemetry.openTurn({
        sessionId: "s1",
        workflow: "w",
        ...(stateType ? { stateType } : {}),
      });
      const emit = (payload: Record<string, unknown>) => telemetry.observe(event("s1", payload));
      return { telemetry, turn, emit };
    }

    it("open on entry and close on leaving, naming where the session went", () => {
      const { turn, emit } = turnWith((slug) => (slug === "check" ? "code" : "agent"));
      emit({ type: "state-enter", state: "triage" });
      emit({ type: "state-leave", state: "triage", next: "check" });
      emit({ type: "state-enter", state: "check" });
      emit({ type: "state-leave", state: "check", next: "done" });
      emit({ type: "state-enter", state: "done" });
      turn.end({ status: "completed", state: "done" });

      expect(otel.outline()).toBe(
        ["invoke_agent w", "  state triage", "  state check", "  state done"].join("\n"),
      );
      expect(attrs(otel.one("state triage"))).toEqual({
        "archmax.state": "triage",
        "archmax.state.type": "agent",
        "archmax.state.next": "check",
      });
      expect(attrs(otel.one("state check"))).toMatchObject({
        "archmax.state.type": "code",
        "archmax.state.next": "done",
      });
      expect(attrs(otel.one("state done"))["archmax.state.next"]).toBeUndefined();
      for (const span of otel.named(/^state /)) {
        expect(span.status.code).toBe(SpanStatusCode.UNSET);
        expect(span.ended).toBe(true);
      }
    });

    it("name no next state when the session completes in the state", () => {
      const { turn, emit } = turnWith();
      emit({ type: "state-enter", state: "done" });
      emit({ type: "state-leave", state: "done", next: "done" });
      turn.end({ status: "completed", state: "done" });
      const span = otel.one("state done");
      expect(span.ended).toBe(true);
      expect(attrs(span)["archmax.state.next"]).toBeUndefined();
    });

    it("close a stray visit when another state is entered", () => {
      const { turn, emit } = turnWith();
      emit({ type: "state-enter", state: "a" });
      emit({ type: "state-enter", state: "b" });
      turn.end();
      expect(attrs(otel.one("state a"))["archmax.state.next"]).toBeUndefined();
      expect(otel.named(/^state /).map((s) => s.name)).toEqual(["state a", "state b"]);
    });

    it("ignore leaving a state that is not open", () => {
      const { turn, emit } = turnWith();
      emit({ type: "state-enter", state: "a" });
      emit({ type: "state-leave", state: "b", next: "c" });
      turn.end();
      expect(attrs(otel.one("state a"))["archmax.state.next"]).toBeUndefined();
    });

    it("mark a park, which is not an error", () => {
      const { turn, emit } = turnWith();
      emit({ type: "state-enter", state: "review" });
      emit({ type: "parked", state: "review", awaiting: "decision" });
      turn.end({ status: "awaiting_decision", state: "review" });
      const span = otel.one("state review");
      expect(attrs(span)["archmax.state.parked"]).toBe("decision");
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
    });

    it("fail on an automated state's error, and not on its success", () => {
      const { turn, emit } = turnWith();
      emit({ type: "state-enter", state: "code-ok" });
      emit({ type: "code-result", state: "code-ok", status: "ok", durationMs: 3 });
      emit({ type: "state-leave", state: "code-ok", next: "grade" });
      emit({ type: "state-enter", state: "grade" });
      emit({
        type: "grader-result",
        state: "grade",
        status: "error",
        durationMs: 9,
        reason: "the grader said: secret",
      });
      turn.end();
      expect(otel.one("state code-ok").status.code).toBe(SpanStatusCode.UNSET);
      const failed = otel.one("state grade");
      expect(attrs(failed)["error.type"]).toBe("automated_state_failed");
      expect(failed.status).toEqual({ code: SpanStatusCode.ERROR });
    });

    it("fail when routed through on_error, naming the target", () => {
      const { turn, emit } = turnWith();
      emit({ type: "state-enter", state: "slow" });
      emit({
        type: "state-error-routed",
        state: "slow",
        to: "fallback",
        reason: "timed out after 5000ms",
      });
      emit({ type: "state-enter", state: "fallback" });
      turn.end();
      expect(attrs(otel.one("state slow"))).toMatchObject({
        "error.type": "routed_on_error",
        "archmax.state.next": "fallback",
      });
      expect(otel.one("state fallback").status.code).toBe(SpanStatusCode.UNSET);
    });

    it("fail on a raise with its code, and leave out a code that is not a token", () => {
      const { turn, emit } = turnWith();
      emit({ type: "state-enter", state: "a" });
      emit({
        type: "raised",
        state: "a",
        sessionId: "s1",
        code: "refund-denied",
        reason: "reason text",
      });
      emit({ type: "state-leave", state: "a", next: "b" });
      emit({ type: "state-enter", state: "b" });
      emit({
        type: "raised",
        state: "b",
        sessionId: "s1",
        code: "the customer wrote this",
        reason: "x",
      });
      turn.end({ status: "failed" });
      expect(attrs(otel.one("state a"))).toMatchObject({
        "error.type": "raised",
        "archmax.raise.code": "refund-denied",
      });
      expect(attrs(otel.one("state b"))["error.type"]).toBe("raised");
      expect(attrs(otel.one("state b"))["archmax.raise.code"]).toBeUndefined();
    });

    it("keep the first failure that names the visit", () => {
      const { turn, emit } = turnWith();
      emit({ type: "state-enter", state: "a" });
      emit({ type: "code-result", state: "a", status: "error", durationMs: 1 });
      emit({ type: "state-error-routed", state: "a", to: "b", reason: "x" });
      turn.end();
      expect(attrs(otel.one("state a"))["error.type"]).toBe("automated_state_failed");
    });

    it("are closed by the turn's end", () => {
      const { turn, emit } = turnWith();
      emit({ type: "state-enter", state: "a" });
      turn.end({ status: "completed" });
      expect(otel.one("state a").ended).toBe(true);
      expect(otel.spans().map((s) => s.name)).toEqual(["state a", "invoke_agent w"]);
    });

    it("ignore events of a session with no open turn, and events of no session", () => {
      const { telemetry, turn, emit } = turnWith();
      telemetry.observe(event("other", { type: "state-enter", state: "x" }));
      telemetry.observe({
        type: "state-enter",
        state: "y",
        level: "info",
        ts: 0,
        seq: 0,
      } as WorkflowLifecycleEvent);
      emit({ type: "tool-called", tool: "lookup", callId: "c1", state: "a" });
      turn.end();
      telemetry.observe(event("s1", { type: "state-enter", state: "late" }));
      expect(otel.spans().map((s) => s.name)).toEqual(["invoke_agent w"]);
    });

    it("open lazily, resumed, when the turn continues in the session's state", () => {
      const { telemetry, turn } = turnWith(() => "agent");
      telemetry
        .modelCall({ sessionId: "s1", state: "triage", role: "agent", model: undefined })
        .settle(answer());
      telemetry
        .modelCall({ sessionId: "s1", state: "triage", role: "agent", model: undefined })
        .settle(answer());
      turn.end();
      const state = otel.one("state triage");
      expect(attrs(state)).toEqual({
        "archmax.state": "triage",
        "archmax.state.type": "agent",
        "archmax.state.resumed": true,
      });
      expect(otel.childrenOf(state).map((s) => s.name)).toEqual(["chat", "chat"]);
    });

    it("attach a call made in a state the turn already left to the turn", () => {
      const { telemetry, turn, emit } = turnWith();
      emit({ type: "state-enter", state: "a" });
      emit({ type: "state-leave", state: "a", next: "b" });
      emit({ type: "state-enter", state: "b" });
      telemetry
        .toolCall({ sessionId: "s1", state: "a", tool: "lookup", callId: "c9", origin: "agent" })
        .end("ok");
      turn.end();
      expect(otel.named(/^state /).map((s) => s.name)).toEqual(["state a", "state b"]);
      expect(otel.parentOf(otel.one("execute_tool lookup"))?.name).toBe("invoke_agent w");
    });
  });

  describe("the parenting rule", () => {
    it("keeps what the active context carries, with the state's span as the parent", () => {
      const telemetry = new Telemetry();
      const turn = telemetry.openTurn({ sessionId: "s1", workflow: "w" });
      telemetry.observe(event("s1", { type: "state-enter", state: "a" }));
      const HOST = createContextKey("a host's own value");
      const seen = context.with(context.active().setValue(HOST, "kept"), () => {
        const call = telemetry.toolCall({
          sessionId: "s1",
          state: "a",
          tool: "lookup",
          callId: "c1",
          origin: "agent",
        });
        const value = context.with(call.context, () => context.active().getValue(HOST));
        call.end("ok");
        return value;
      });
      turn.end();
      expect(seen).toBe("kept");
      expect(otel.parentOf(otel.one("execute_tool lookup"))?.name).toBe("state a");
    });

    it("nests a call made inside a tool call of the same session under that tool call", () => {
      const telemetry = new Telemetry();
      const turn = telemetry.openTurn({ sessionId: "s1", workflow: "w" });
      telemetry.observe(event("s1", { type: "state-enter", state: "a" }));
      const evalCall = telemetry.toolCall({
        sessionId: "s1",
        state: "a",
        tool: "archmax_eval",
        callId: "c1",
        origin: "agent",
      });
      context.with(evalCall.context, () => {
        telemetry
          .toolCall({
            sessionId: "s1",
            state: "a",
            tool: "lookup",
            callId: "c1-1",
            origin: "script",
          })
          .end("ok");
      });
      evalCall.end("ok");
      turn.end();
      expect(otel.outline()).toBe(
        [
          "invoke_agent w",
          "  state a",
          "    execute_tool archmax_eval",
          "      execute_tool lookup",
        ].join("\n"),
      );
    });

    it("nests a child session's turn inside the call that dispatched it, and its calls under its own states", () => {
      const telemetry = new Telemetry();
      const parent = telemetry.openTurn({ sessionId: "parent", workflow: "w" });
      telemetry.observe(event("parent", { type: "state-enter", state: "a" }));
      const delegation = telemetry.toolCall({
        sessionId: "parent",
        state: "a",
        tool: "archmax_workflow_check",
        callId: "c1",
        origin: "agent",
      });
      context.with(delegation.context, () => {
        const child = telemetry.openTurn({ sessionId: "child", workflow: "check" });
        context.with(child.context, () => {
          telemetry.observe(event("child", { type: "state-enter", state: "inspect" }));
          telemetry
            .modelCall({ sessionId: "child", state: "inspect", role: "agent", model: undefined })
            .settle(answer());
        });
        child.end({ status: "completed" });
      });
      delegation.end("ok");
      parent.end({ status: "completed" });
      expect(otel.outline()).toBe(
        [
          "invoke_agent w",
          "  state a",
          "    execute_tool archmax_workflow_check",
          "      invoke_agent check",
          "        state inspect",
          "          chat",
        ].join("\n"),
      );
      expect(attrs(otel.one("invoke_agent w"))["gen_ai.usage.input_tokens"]).toBeUndefined();
      expect(attrs(otel.one("invoke_agent check"))["gen_ai.usage.input_tokens"]).toBe(100);
    });

    it("puts a call made inside another session's tool call under its own state", () => {
      const telemetry = new Telemetry();
      const one = telemetry.openTurn({ sessionId: "one", workflow: "w" });
      const two = telemetry.openTurn({ sessionId: "two", workflow: "w" });
      telemetry.observe(event("two", { type: "state-enter", state: "b" }));
      const foreign = telemetry.toolCall({
        sessionId: "one",
        tool: "lookup",
        callId: "c1",
        origin: "agent",
      });
      context.with(foreign.context, () => {
        telemetry
          .modelCall({ sessionId: "two", state: "b", role: "agent", model: undefined })
          .settle(answer());
      });
      foreign.end("ok");
      two.end();
      one.end();
      expect(otel.parentOf(otel.one("chat"))?.name).toBe("state b");
    });

    it("leaves a call of a session with no open turn in the active context", () => {
      const telemetry = new Telemetry();
      const host = otel.tracer.startSpan("host");
      context.with(trace.setSpan(context.active(), host), () => {
        telemetry
          .modelCall({ sessionId: "nobody", role: "agent", model: undefined })
          .settle(answer());
      });
      host.end();
      expect(otel.parentOf(otel.one("chat"))?.name).toBe("host");
    });

    it("puts a call with no state under the open state, else the turn", () => {
      const telemetry = new Telemetry();
      const turn = telemetry.openTurn({ sessionId: "s1" });
      telemetry.modelCall({ sessionId: "s1", role: "agent", model: undefined }).settle(answer());
      telemetry.observe(event("s1", { type: "state-enter", state: "a" }));
      telemetry.modelCall({ sessionId: "s1", role: "agent", model: undefined }).settle(answer());
      turn.end();
      expect(otel.outline()).toBe(["invoke_agent", "  chat", "  state a", "    chat"].join("\n"));
    });
  });

  describe("a model call", () => {
    function inState() {
      const telemetry = new Telemetry();
      const turn = telemetry.openTurn({ sessionId: "s1", workflow: "w" });
      telemetry.observe(event("s1", { type: "state-enter", state: "triage" }));
      return { telemetry, turn };
    }

    it("is a chat client span with its models, usage, cost and finish", () => {
      const { telemetry, turn } = inState();
      const call = telemetry.modelCall({
        sessionId: "s1",
        state: "triage",
        role: "agent",
        model: chatModel("openai"),
        requestModel: "gpt-6-luna",
        pricing: { "gpt-6-luna-2026-05": { input: 2, output: 8, cacheRead: 0.5 } },
        pricingModel: "gpt-6-luna",
      });
      call.settle(
        answer({
          input: 1200,
          output: 300,
          cacheRead: 1000,
          model: "gpt-6-luna-2026-05",
          finish: "tool_calls",
          calls: 2,
        }),
      );
      turn.end();

      const span = otel.one("chat gpt-6-luna");
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(otel.parentOf(span)?.name).toBe("state triage");
      expect(attrs(span)).toEqual({
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-6-luna",
        "gen_ai.response.model": "gpt-6-luna-2026-05",
        "gen_ai.response.finish_reasons": ["tool_calls"],
        "gen_ai.conversation.id": "s1",
        "archmax.state": "triage",
        "archmax.model.role": "agent",
        "archmax.response.tool_calls": 2,
        "gen_ai.usage.input_tokens": 1200,
        "gen_ai.usage.output_tokens": 300,
        "gen_ai.usage.cache_read.input_tokens": 1000,
        "gen_ai.usage.cache_creation.input_tokens": 0,
        "gen_ai.usage.cost": expect.closeTo((200 * 2 + 300 * 8 + 1000 * 0.5) / 1e6, 9),
      });
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
    });

    it("prices a response that names no model as the model it was asked for", () => {
      const { telemetry, turn } = inState();
      telemetry
        .modelCall({
          sessionId: "s1",
          state: "triage",
          role: "agent",
          model: undefined,
          pricing: { m: { input: 1 } },
          pricingModel: "m",
        })
        .settle(answer({ input: 1_000_000, output: 0 }));
      turn.end();
      expect(attrs(otel.one("chat"))["gen_ai.usage.cost"]).toBe(1);
    });

    it("has no cost when it is unpriced", () => {
      const { telemetry, turn } = inState();
      telemetry
        .modelCall({ sessionId: "s1", state: "triage", role: "agent", model: undefined })
        .settle(answer());
      turn.end();
      expect(attrs(otel.one("chat"))["gen_ai.usage.cost"]).toBeUndefined();
      expect(attrs(otel.one("invoke_agent w"))["gen_ai.usage.cost"]).toBeUndefined();
    });

    it("reads the answer a command carries", () => {
      const { telemetry, turn } = inState();
      const reply = answer({ input: 5, output: 6, calls: 1 });
      telemetry
        .modelCall({ sessionId: "s1", state: "triage", role: "agent", model: undefined })
        .settle(
          new Command({
            update: { messages: [reply, new ToolMessage({ content: "x", tool_call_id: "c0" })] },
          }),
        );
      turn.end();
      expect(attrs(otel.one("chat"))).toMatchObject({
        "gen_ai.usage.input_tokens": 5,
        "archmax.response.tool_calls": 1,
      });
    });

    it("leaves out a requested model that is not an id", () => {
      const { telemetry, turn } = inState();
      telemetry
        .modelCall({
          sessionId: "s1",
          state: "triage",
          role: "grader",
          model: undefined,
          requestModel: "not an id",
        })
        .settle({});
      turn.end();
      const span = otel.one("chat");
      expect(attrs(span)["gen_ai.request.model"]).toBeUndefined();
      expect(attrs(span)["archmax.model.role"]).toBe("grader");
      expect(attrs(span)["gen_ai.usage.input_tokens"]).toBeUndefined();
    });

    it("is an error typed by the HTTP status when the provider refuses it", () => {
      const { telemetry, turn } = inState();
      telemetry
        .modelCall({ sessionId: "s1", state: "triage", role: "agent", model: undefined })
        .fail(Object.assign(new Error("Rate limit reached for org-secret"), { status: 429 }));
      turn.end();
      const span = otel.one("chat");
      expect(attrs(span)["error.type"]).toBe("429");
      expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
      expect(span.events).toEqual([]);
    });

    it("ends at its expiry, and a late answer changes nothing", () => {
      const { telemetry, turn } = inState();
      const call = telemetry.modelCall({
        sessionId: "s1",
        state: "triage",
        role: "agent",
        model: undefined,
      });
      call.expire();
      call.settle(answer());
      call.fail(new Error("late"));
      turn.end();
      expect(otel.named("chat")).toHaveLength(1);
      const span = otel.one("chat");
      expect(attrs(span)["error.type"]).toBe("timeout");
      expect(attrs(span)["gen_ai.usage.input_tokens"]).toBeUndefined();
      expect(attrs(otel.one("invoke_agent w"))["gen_ai.usage.input_tokens"]).toBeUndefined();
    });

    it("keeps its span active for what the call does", () => {
      const { telemetry, turn } = inState();
      const call = telemetry.modelCall({
        sessionId: "s1",
        state: "triage",
        role: "agent",
        model: undefined,
      });
      context.with(call.context, () => otel.tracer.startSpan("POST /v1/chat/completions").end());
      call.settle(answer());
      turn.end();
      expect(otel.parentOf(otel.one("POST /v1/chat/completions"))?.name).toBe("chat");
    });

    it("records one duration and two token measurements, with no session id", async () => {
      const { telemetry, turn } = inState();
      telemetry
        .modelCall({
          sessionId: "s1",
          state: "triage",
          role: "agent",
          model: chatModel("anthropic"),
          requestModel: "opus",
        })
        .settle(answer({ input: 40, output: 7, model: "opus-5" }));
      telemetry
        .modelCall({
          sessionId: "s1",
          state: "triage",
          role: "agent",
          model: chatModel("anthropic"),
          requestModel: "opus",
        })
        .fail(Object.assign(new Error("x"), { status: 500 }));
      turn.end();

      const collected = await otel.metrics();
      const duration = collected.find((m) => m.name === TELEMETRY_METRICS.operationDuration)!;
      const tokens = collected.find((m) => m.name === TELEMETRY_METRICS.tokenUsage)!;
      expect(duration).toMatchObject({ unit: "s", scope: TELEMETRY_SCOPE });
      expect(tokens).toMatchObject({ unit: "{token}", scope: TELEMETRY_SCOPE });
      expect(duration.points.map((p) => p.attributes)).toEqual([
        {
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": "anthropic",
          "gen_ai.request.model": "opus",
          "gen_ai.response.model": "opus-5",
        },
        {
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": "anthropic",
          "gen_ai.request.model": "opus",
          "error.type": "500",
        },
      ]);
      expect(duration.points.every((p) => p.count === 1)).toBe(true);
      expect(duration.points[0]!.boundaries).toEqual([
        0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
      ]);
      expect(tokens.points.map((p) => [p.attributes["gen_ai.token.type"], p.sum, p.count])).toEqual(
        [
          ["input", 40, 1],
          ["output", 7, 1],
        ],
      );
      expect(tokens.points[0]!.boundaries).toEqual([
        1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864,
      ]);
      const recorded = collected.flatMap((m) =>
        m.points.flatMap((p) => Object.values(p.attributes)),
      );
      expect(recorded).not.toContain("s1");
      expect(recorded).not.toContain("triage");
    });

    it("records its metrics on a meter provider registered after the first call", async () => {
      await uninstallOtel();
      const telemetry = new Telemetry();
      telemetry.modelCall({ sessionId: "s1", role: "agent", model: undefined }).settle(answer());
      const late = installOtel();
      telemetry.modelCall({ sessionId: "s1", role: "agent", model: undefined }).settle(answer());
      const duration = (await late.metrics()).find(
        (m) => m.name === TELEMETRY_METRICS.operationDuration,
      );
      expect(duration?.points.map((p) => p.count)).toEqual([1]);
    });
  });

  describe("a tool call", () => {
    function inState() {
      const telemetry = new Telemetry();
      const turn = telemetry.openTurn({ sessionId: "s1", workflow: "w" });
      telemetry.observe(event("s1", { type: "state-enter", state: "a" }));
      const call = (tool: string, origin: "agent" | "grader" | "script" = "agent") =>
        telemetry.toolCall({ sessionId: "s1", state: "a", tool, callId: `id-${tool}`, origin });
      return { telemetry, turn, call };
    }

    it("is an execute_tool span with its call id, state and origin", () => {
      const { turn, call } = inState();
      call("lookup_order").end("ok");
      turn.end();
      const span = otel.one("execute_tool lookup_order");
      expect(span.kind).toBe(SpanKind.INTERNAL);
      expect(otel.parentOf(span)?.name).toBe("state a");
      expect(attrs(span)).toEqual({
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "lookup_order",
        "gen_ai.tool.call.id": "id-lookup_order",
        "gen_ai.tool.type": "function",
        "gen_ai.conversation.id": "s1",
        "archmax.state": "a",
        "archmax.tool.origin": "agent",
        "archmax.tool.outcome": "ok",
      });
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
    });

    it("takes the name it resolved to", () => {
      const { turn, call } = inState();
      const handle = call("lookup");
      handle.rename("lookup_order");
      handle.rename("not a name");
      handle.end("ok");
      handle.rename("too_late");
      turn.end();
      expect(
        otel.named(/^execute_tool/).map((s) => [s.name, s.attributes["gen_ai.tool.name"]]),
      ).toEqual([["execute_tool unknown", "unknown"]]);
    });

    it("carries the rule that blocked it", () => {
      const { turn, call } = inState();
      call("delete_order").end("blocked", "tool.not-allowed");
      turn.end();
      const span = otel.one("execute_tool delete_order");
      expect(attrs(span)).toMatchObject({
        "archmax.tool.outcome": "blocked",
        "archmax.tool.rule": "tool.not-allowed",
        "error.type": "blocked",
      });
      expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
    });

    it("leaves out a rule that is not a token, and a rule on a call that was not blocked", () => {
      const { turn, call } = inState();
      call("one").end("blocked", "refused because the customer said so");
      call("two").end("error", "tool.not-allowed");
      turn.end();
      expect(attrs(otel.one("execute_tool one"))["archmax.tool.rule"]).toBeUndefined();
      expect(attrs(otel.one("execute_tool two"))["archmax.tool.rule"]).toBeUndefined();
    });

    it.each([
      ["error", "tool_error"],
      ["cancelled", "cancelled"],
    ] as const)("is an error when it ends %s", (outcome, errorType) => {
      const { turn, call } = inState();
      call("lookup").end(outcome);
      turn.end();
      const span = otel.one("execute_tool lookup");
      expect(attrs(span)).toMatchObject({
        "archmax.tool.outcome": outcome,
        "error.type": errorType,
      });
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
    });

    it("is not an error when it parks the session", () => {
      const { turn, call } = inState();
      call("archmax_wait").end("parked");
      turn.end();
      const span = otel.one("execute_tool archmax_wait");
      expect(attrs(span)["archmax.tool.outcome"]).toBe("parked");
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
    });

    it("is named unknown when no tool has its name, whatever the model called", () => {
      const { turn, call } = inState();
      call("delete_everything").end("unknown");
      call("rm -rf / please").end("unknown");
      turn.end();
      const spans = otel.named(/^execute_tool/);
      expect(
        spans.map((s) => [s.name, s.attributes["gen_ai.tool.name"], s.attributes["error.type"]]),
      ).toEqual([
        ["execute_tool unknown", "unknown", "unknown_tool"],
        ["execute_tool unknown", "unknown", "unknown_tool"],
      ]);
    });

    it("ends once", () => {
      const { turn, call } = inState();
      const handle = call("lookup");
      handle.end("ok");
      handle.end("error");
      turn.end();
      expect(otel.named(/^execute_tool/)).toHaveLength(1);
      expect(attrs(otel.one("execute_tool lookup"))["archmax.tool.outcome"]).toBe("ok");
    });

    it("keeps its span active for what the tool does", () => {
      const { turn, call } = inState();
      const handle = call("lookup");
      context.with(handle.context, () => otel.tracer.startSpan("SELECT orders").end());
      handle.end("ok");
      turn.end();
      expect(otel.parentOf(otel.one("SELECT orders"))?.name).toBe("execute_tool lookup");
    });
  });
});
