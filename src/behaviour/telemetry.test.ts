/**
 * OpenTelemetry: a host that registers an SDK sees every turn as an
 * `invoke_agent` span, every visit to a state as a `state` span, every model
 * call as a `chat` span and every tool call as an `execute_tool` span — nested
 * as the work is, carrying metadata only — and the GenAI client metrics for
 * every model call. Driven through the public barrel with the SDK registered on
 * the API's globals, exactly as a host registers one (`./otel.ts`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { tool } from "langchain";
import { z } from "zod";
import type { StructuredTool } from "@langchain/core/tools";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { createAgent, createMemorySessionStore, workflowToolName } from "../index.js";
import { installOtel, uninstallOtel, useOtel, type ReadableSpan } from "./otel.js";
import {
  advanceTo,
  AGENTS_MD,
  assemble,
  cleanupWorkspaces,
  eventsOf,
  freshSessionId,
  makeWorkspace,
  ScriptedModel,
  STREAM_FAILURE,
  StreamingScriptedModel,
  turn,
  workspaceWith,
  type ScriptedTurn,
} from "./support.js";

afterEach(cleanupWorkspaces);

const otel = useOtel();
const RUNTIME = { engine: "archmax-harness", version: "3" };
const attrs = (span: ReadableSpan) => span.attributes;
const isError = (span: ReadableSpan) => span.status.code === SpanStatusCode.ERROR;

/** The spans of one kind, in start order. */
const turns = () => otel.named(/^invoke_agent/);
const states = () => otel.named(/^state /);
const chats = () => otel.named(/^chat/);
const toolSpans = () => otel.named(/^execute_tool /);

/** A host tool: echoes its input, or throws when asked to. */
function hostTool(name: string): StructuredTool {
  return tool(
    async ({ q }: { q: string }) => {
      if (q.startsWith("fail")) throw new Error(`${name} could not handle ${q}`);
      return `${name}:${q}`;
    },
    { name, description: `The ${name} tool.`, schema: z.object({ q: z.string() }) },
  ) as unknown as StructuredTool;
}

/** start (may call `lookup`) → done. */
const LINEAR = {
  runtime: RUNTIME,
  states: {
    start: {
      triggers: { manual: null },
      tools: { allow: ["lookup"] },
      transitions: [{ to: "done", description: "The lookup is done." }],
    },
    done: {},
  },
};

describe("a turn", () => {
  it("is one invoke_agent span holding its states, model calls and tool calls", async () => {
    const model = new ScriptedModel(
      [
        { tool: "lookup", args: { q: "ORD-7" }, usage: { input: 100, output: 10 } },
        { ...advanceTo("done", "looked up"), usage: { input: 120, output: 12 } },
        { reply: "ORD-7 ships tomorrow", usage: { input: 130, output: 13 } },
      ],
      { model: "gpt-test" },
    );
    const { agent, events } = await assemble(workspaceWith(LINEAR), {
      model,
      params: { tools: [hostTool("lookup")] },
    });
    await turn(agent, "s1", "where is ORD-7?");

    expect(otel.outline()).toBe(
      [
        "invoke_agent w",
        "  state start",
        "    chat gpt-test",
        "    execute_tool lookup",
        "    chat gpt-test",
        "    execute_tool archmax_advance",
        "  state done",
        "    chat gpt-test",
      ].join("\n"),
    );
    const span = otel.one("invoke_agent w");
    expect(span.kind).toBe(SpanKind.INTERNAL);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(attrs(span)).toEqual({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "w",
      "gen_ai.conversation.id": "s1",
      "archmax.turn.resume": false,
      "archmax.session.status": "completed",
      "archmax.state": "done",
      "gen_ai.usage.input_tokens": 350,
      "gen_ai.usage.output_tokens": 35,
      "gen_ai.usage.cache_read.input_tokens": 0,
      "gen_ai.usage.cache_creation.input_tokens": 0,
    });
    // Its totals are the turn's `model-usage` events, summed.
    const usage = eventsOf(events, "model-usage");
    expect(usage.reduce((sum, e) => sum + e.inputTokens, 0)).toBe(350);
    // Every span is one trace, rooted at the turn.
    expect(otel.traces()).toHaveLength(1);
  });

  it("is a child of the host's span when the host invokes it inside one", async () => {
    const { agent } = await assemble(workspaceWith(LINEAR), { turns: [{ reply: "hi" }] });
    const host = otel.tracer.startSpan("POST /api/messages");
    await context.with(trace.setSpan(context.active(), host), () => turn(agent, "s1", "hello"));
    host.end();

    expect(otel.parentOf(otel.one("invoke_agent w"))?.name).toBe("POST /api/messages");
    expect(otel.traces()).toHaveLength(1);
  });

  it("is a resumed turn for each decide, reply and deliver", async () => {
    const REVIEW = {
      runtime: RUNTIME,
      states: {
        work: {
          triggers: { manual: null },
          transitions: [{ to: "review", description: "Hand over." }],
        },
        review: {
          type: "human",
          transitions: [
            { to: "approved", type: "approve", description: "Fine." },
            { to: "work", type: "refine", description: "Again." },
          ],
        },
        approved: {},
      },
    };
    const { agent, model } = await assemble(workspaceWith(REVIEW), {
      turns: [advanceTo("review", "ready")],
    });
    await turn(agent, "s1", "please review");
    model.enqueue({ reply: "I will wait for the reviewer" });
    await agent.workflow.reply("s1", "any news?");
    model.enqueue({ reply: "approved and closed" });
    await agent.workflow.decide("s1", { target: "approved" });

    const CLARIFY = {
      runtime: RUNTIME,
      states: {
        clarify: {
          triggers: {
            manual: { session: "conversation_id" },
            email_reply: { session: "conversation_id" },
          },
          transitions: [{ to: "answer", description: "Clear now." }],
        },
        answer: {},
      },
    };
    const waiting = await assemble(workspaceWith(CLARIFY), {
      turns: [{ tool: "archmax_wait", args: { reason: "which order?" } }],
    });
    await turn(waiting.agent, "conv-1", "help with my order");
    waiting.model.enqueue(advanceTo("answer", "named"), { reply: "found it" });
    await waiting.agent.workflow.deliver("conv-1", { trigger: { id: "email_reply" } });

    expect(
      turns().map((s) => [
        attrs(s)["gen_ai.conversation.id"],
        attrs(s)["archmax.turn.resume"],
        attrs(s)["archmax.session.status"],
        isError(s),
      ]),
    ).toEqual([
      ["s1", false, "awaiting_decision", false],
      ["s1", true, "awaiting_decision", false],
      ["s1", true, "completed", false],
      ["conv-1", false, "awaiting_input", false],
      ["conv-1", true, "completed", false],
    ]);
    // A resumption is its own trace: nothing is kept across a park.
    expect(otel.traces()).toHaveLength(5);
  });

  it("is an error when the session ends failed by a raise", async () => {
    const { agent } = await assemble(workspaceWith(LINEAR), {
      turns: [{ tool: "archmax_raise", args: { code: "order-unknown", reason: "no such order" } }],
    });
    await turn(agent, "s1", "where is ORD-0?");

    const span = otel.one("invoke_agent w");
    expect(attrs(span)).toMatchObject({
      "archmax.session.status": "failed",
      "error.type": "session_failed",
    });
    expect(isError(span)).toBe(true);
  });

  it("carries a thrown turn's error type and still throws", async () => {
    const model = new StreamingScriptedModel([{ reply: `partial words ${STREAM_FAILURE}` }]);
    const { agent } = await assemble(workspaceWith(LINEAR), { model });
    await expect(turn(agent, "s1", "hello")).rejects.toThrow(/mid-stream/);

    const span = otel.one("invoke_agent w");
    expect(attrs(span)["error.type"]).toBe("Error");
    expect(isError(span)).toBe(true);
    expect(span.events).toEqual([]);
    expect(attrs(otel.one("chat"))["error.type"]).toBe("Error");
  });

  it.each(["stream", "streamEvents"] as const)(
    "ends its span when the %s iterator ends",
    async (method) => {
      const { agent } = await assemble(workspaceWith(LINEAR), {
        turns: [{ tool: "lookup", args: { q: "x" } }, advanceTo("done"), { reply: "done" }],
        params: { tools: [hostTool("lookup")] },
      });
      const input = { messages: [{ role: "user", content: "go" }] };
      const config = { configurable: { thread_id: "s1" } };
      const iterable =
        method === "stream"
          ? await agent.stream(input as never, config as never)
          : agent.streamEvents(input as never, { ...config, version: "v2" } as never);
      let steps = 0;
      for await (const _ of iterable) {
        steps += 1;
        // Mid-stream, the turn's span is still open.
        expect(turns()).toEqual([]);
      }
      expect(steps).toBeGreaterThan(0);

      expect(otel.outline()).toBe(
        [
          "invoke_agent w",
          "  state start",
          "    chat",
          "    execute_tool lookup",
          "    chat",
          "    execute_tool archmax_advance",
          "  state done",
          "    chat",
        ].join("\n"),
      );
      expect(attrs(otel.one("invoke_agent w"))).toMatchObject({
        "archmax.session.status": "completed",
        "archmax.state": "done",
      });
    },
  );

  it("ends its span when the consumer stops reading a stream", async () => {
    const { agent } = await assemble(workspaceWith(LINEAR), {
      turns: [{ tool: "lookup", args: { q: "x" } }, advanceTo("done"), { reply: "done" }],
      params: { tools: [hostTool("lookup")] },
    });
    const iterable = await agent.stream(
      { messages: [{ role: "user", content: "go" }] } as never,
      {
        configurable: { thread_id: "s1" },
      } as never,
    );
    for await (const _ of iterable) break;

    // The span ends where the consumer stopped reading, not an error.
    const span = otel.one("invoke_agent w");
    expect(span.ended).toBe(true);
    expect(isError(span)).toBe(false);
    expect(attrs(span)["archmax.session.status"]).toBeUndefined();
    // The graph is not stopped by it: the turn's remaining calls still finish, under it.
    await vi.waitFor(async () =>
      expect((await agent.sessions.get("s1"))?.status).toBe("completed"),
    );
    expect(chats()).toHaveLength(3);
    for (const call of [...chats(), ...toolSpans()]) expect(otel.isUnder(call, span)).toBe(true);
  });
});

describe("a plain agent's turn", () => {
  it("holds its model and tool calls directly, with no state spans", async () => {
    const model = new ScriptedModel(
      [
        {
          tool: "write_file",
          args: { file_path: "scratchpad/note.md", content: "# note" },
          usage: { input: 5, output: 2 },
        },
        { tool: "no_such_tool", args: { q: "x" } },
        { reply: "written", usage: { input: 7, output: 3 } },
      ],
      { model: "plain-model" },
    );
    const agent = await createAgent({
      workflow: false,
      model: model as never,
      onEvent: () => {},
      workspace: {
        rootDir: makeWorkspace({ "AGENTS.md": AGENTS_MD }),
        sessionStore: createMemorySessionStore(),
      },
    });
    await agent.invoke({ messages: [{ role: "user", content: "write a note" }] } as never, {
      configurable: { thread_id: "p1" },
    });

    expect(otel.outline()).toBe(
      [
        "invoke_agent",
        "  chat plain-model",
        "  execute_tool write_file",
        "  chat plain-model",
        "  execute_tool unknown",
        "  chat plain-model",
      ].join("\n"),
    );
    expect(attrs(otel.one("execute_tool unknown"))).toMatchObject({
      "archmax.tool.outcome": "unknown",
      "error.type": "unknown_tool",
    });
    expect(attrs(otel.one("invoke_agent"))).toEqual({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.conversation.id": "p1",
      "archmax.turn.resume": false,
      "gen_ai.usage.input_tokens": 12,
      "gen_ai.usage.output_tokens": 5,
      "gen_ai.usage.cache_read.input_tokens": 0,
      "gen_ai.usage.cache_creation.input_tokens": 0,
    });
    expect(attrs(otel.one("execute_tool write_file"))).toMatchObject({
      "archmax.tool.outcome": "ok",
      "archmax.tool.origin": "agent",
    });
    expect(attrs(otel.one("execute_tool write_file"))["archmax.state"]).toBeUndefined();
  });
});

/** A code-state script: reads the history, then advances. */
function advancingScript(to: string): string {
  return (
    `export default async function ({ tools }) {\n` +
    `  JSON.parse(await tools.archmax_get_history());\n` +
    `  await tools.archmax_advance({ to: ${JSON.stringify(to)}, reason: "checked" });\n` +
    `}\n`
  );
}

/** work → check [code] → review [grader] → done. */
const AUTOMATED = {
  runtime: RUNTIME,
  states: {
    work: {
      triggers: { manual: null },
      transitions: [{ to: "check", description: "The work is done." }],
    },
    check: {
      type: "code",
      script: "scripts/check.js",
      transitions: [{ to: "review", description: "Checked." }],
    },
    review: {
      type: "grader",
      instructions: "Approve the work.",
      transitions: [{ to: "done", description: "The work is fine." }],
    },
    done: {},
  },
};

describe("state visits", () => {
  it("are one span each, naming their type and where the session went", async () => {
    const grader = new ScriptedModel([
      { tool: "archmax_get_history", args: {}, usage: { input: 40, output: 4 } },
      { ...advanceTo("done", "fine"), usage: { input: 50, output: 5 } },
    ]);
    const model = new ScriptedModel([advanceTo("check", "worked"), { reply: "all done" }]);
    const { agent } = await assemble(
      workspaceWith(AUTOMATED, { "workflows/w/scripts/check.js": advancingScript("review") }),
      { model, graderModel: grader },
    );
    await agent.workflow.send(freshSessionId(), { message: "go" });

    expect(otel.outline()).toBe(
      [
        "invoke_agent w",
        "  state work",
        "    chat",
        "    execute_tool archmax_advance",
        "  state check",
        "    execute_tool archmax_get_history",
        "    execute_tool archmax_advance",
        "  state review",
        "    chat",
        "    execute_tool archmax_get_history",
        "    chat",
        "    execute_tool archmax_advance",
        "  state done",
        "    chat",
      ].join("\n"),
    );
    expect(
      states().map((s) => [
        s.name,
        attrs(s)["archmax.state.type"],
        attrs(s)["archmax.state.next"],
        isError(s),
      ]),
    ).toEqual([
      ["state work", "agent", "check", false],
      ["state check", "code", "review", false],
      ["state review", "grader", "done", false],
      ["state done", "agent", undefined, false],
    ]);
    // A code state's calls are its script's; a grader's are the grader's own, each reported once.
    const check = otel.one("state check");
    const review = otel.one("state review");
    expect(otel.childrenOf(check).map((s) => attrs(s)["archmax.tool.origin"])).toEqual([
      "script",
      "script",
    ]);
    expect(
      otel
        .childrenOf(review)
        .map((s) => attrs(s)["archmax.model.role"] ?? attrs(s)["archmax.tool.origin"]),
    ).toEqual(["grader", "grader", "grader", "grader"]);
    expect(toolSpans().filter((s) => attrs(s)["archmax.state"] === "review")).toHaveLength(2);
    // A grader's calls carry their usage, under its state.
    expect(
      otel
        .childrenOf(review)
        .filter((s) => s.name === "chat")
        .map((s) => attrs(s)["gen_ai.usage.input_tokens"]),
    ).toEqual([40, 50]);
  });

  it("are opened resumed when a turn continues in the state the session is in", async () => {
    const REVIEW = {
      runtime: RUNTIME,
      states: {
        work: {
          triggers: { manual: null },
          transitions: [{ to: "review", description: "Hand over." }],
        },
        review: {
          type: "human",
          transitions: [{ to: "approved", type: "approve", description: "Fine." }],
        },
        approved: {},
      },
    };
    const { agent, model } = await assemble(workspaceWith(REVIEW), {
      turns: [advanceTo("review", "ready")],
    });
    await turn(agent, "s1", "please review");
    model.enqueue({ reply: "the reviewer will look at it" });
    await agent.workflow.reply("s1", "any news?");

    const [first, second] = otel.traces();
    expect(
      first!
        .filter((s) => s.name.startsWith("state "))
        .map((s) => [s.name, attrs(s)["archmax.state.parked"]]),
    ).toEqual([
      ["state work", undefined],
      ["state review", "decision"],
    ]);
    const resumed = second!.find((s) => s.name === "state review")!;
    // A reply is answered in the state the session is parked at; it stays parked, with no new park.
    expect(attrs(resumed)).toMatchObject({ "archmax.state.resumed": true });
    expect(isError(resumed)).toBe(false);
    expect(otel.childrenOf(resumed).map((s) => s.name)).toEqual(["chat"]);
  });

  it("fail when a time budget routes them through on_error, naming the target", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        slow: {
          triggers: { manual: null },
          budget: { timeoutMs: 50 },
          on_error: "fallback",
          transitions: [{ to: "fallback", description: "Fall back." }],
        },
        fallback: {},
      },
    };
    const { agent } = await assemble(workspaceWith(spec), {
      turns: [{ tool: "archmax_get_variables", args: {}, delayMs: 1000 }, { reply: "fell back" }],
    });
    await turn(agent, "s1", "go");

    const slow = otel.one("state slow");
    expect(attrs(slow)).toMatchObject({
      "error.type": "routed_on_error",
      "archmax.state.next": "fallback",
    });
    expect(isError(slow)).toBe(true);
    // The model call ended at the expiry, not when its late answer arrived.
    const expired = otel.childrenOf(slow).find((s) => s.name === "chat")!;
    expect(attrs(expired)["error.type"]).toBe("timeout");
    expect(expired.duration[0] * 1e3 + expired.duration[1] / 1e6).toBeLessThan(600);
    expect(attrs(expired)["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(isError(otel.one("state fallback"))).toBe(false);
    // The routed session completed: the turn is not an error.
    expect(isError(otel.one("invoke_agent w"))).toBe(false);
  });

  it("fail on a raise, carrying its code only when it is a token", async () => {
    const raiseWith = async (code: string) => {
      const { agent } = await assemble(workspaceWith(LINEAR), {
        turns: [{ tool: "archmax_raise", args: { code, reason: "cannot go on" } }],
      });
      await turn(agent, freshSessionId(), "go");
    };
    await raiseWith("order-unknown");
    await raiseWith("no such order at all");

    expect(states().map((s) => [attrs(s)["error.type"], attrs(s)["archmax.raise.code"]])).toEqual([
      ["raised", "order-unknown"],
      ["raised", undefined],
    ]);
  });
});

/** A model that fails every call the way a provider's client does. */
class RefusingModel extends ScriptedModel {
  constructor(private readonly status: number) {
    super([]);
  }
  override async _generate(): Promise<ChatResult> {
    throw Object.assign(
      new Error(`Request failed with status ${this.status}: quota for key sk-live-123`),
      {
        status: this.status,
      },
    );
  }
}

/** A model whose client reports its own request as a span, as an instrumented HTTP client does. */
class TracedModel extends ScriptedModel {
  override async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    return trace.getTracer("http").startActiveSpan("POST /v1/chat/completions", async (span) => {
      try {
        return await super._generate(messages);
      } finally {
        span.end();
      }
    });
  }
}

describe("a model call", () => {
  it("carries the tokens and cost its model-usage event reports", async () => {
    const model = new ScriptedModel(
      [
        { ...advanceTo("done"), usage: { input: 1200, output: 80 } },
        { reply: "done", usage: { input: 1300, output: 90 }, reports: "gpt-test-2026" },
      ],
      { model: "gpt-test" },
    );
    const { agent, events } = await assemble(workspaceWith(LINEAR), {
      model,
      params: {
        pricing: { "gpt-test": { input: 2, output: 8 }, "gpt-test-2026": { input: 3, output: 9 } },
      },
    });
    await turn(agent, "s1", "go");

    const usage = eventsOf(events, "model-usage");
    expect(usage).toHaveLength(2);
    expect(
      chats().map((s) => [
        attrs(s)["gen_ai.usage.input_tokens"],
        attrs(s)["gen_ai.usage.output_tokens"],
        attrs(s)["gen_ai.usage.cost"],
        attrs(s)["gen_ai.response.model"],
      ]),
    ).toEqual(
      usage.map((e) => [
        e.inputTokens,
        e.outputTokens,
        e.costUsd,
        e.model === "gpt-test" ? undefined : e.model,
      ]),
    );
    expect(usage.every((e) => typeof e.costUsd === "number" && e.costUsd > 0)).toBe(true);
    expect(attrs(otel.one("invoke_agent w"))["gen_ai.usage.cost"]).toBeCloseTo(
      usage[0]!.costUsd! + usage[1]!.costUsd!,
      9,
    );
    expect(attrs(chats()[0]!)).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "gpt-test",
      "gen_ai.provider.name": "archmax-behaviour-scripted",
      "archmax.model.role": "agent",
      "archmax.state": "start",
      "archmax.response.tool_calls": 1,
    });
    expect(chats()[0]!.kind).toBe(SpanKind.CLIENT);
  });

  it("has no cost when it is unpriced", async () => {
    const { agent, events } = await assemble(workspaceWith(LINEAR), {
      turns: [{ reply: "hi", usage: { input: 3, output: 1 } }],
    });
    await turn(agent, "s1", "go");
    expect(eventsOf(events, "model-usage")[0]?.costUsd).toBeUndefined();
    expect(attrs(otel.one("chat"))["gen_ai.usage.cost"]).toBeUndefined();
    expect(attrs(otel.one("chat"))["gen_ai.usage.input_tokens"]).toBe(3);
  });

  it("is an error typed 429 when the provider refuses it, and the turn's error is too", async () => {
    const { agent } = await assemble(workspaceWith(LINEAR), { model: new RefusingModel(429) });
    await expect(turn(agent, "s1", "go")).rejects.toThrow(/429/);
    const call = otel.one("chat");
    expect(attrs(call)["error.type"]).toBe("429");
    expect(isError(call)).toBe(true);
    expect(attrs(otel.one("invoke_agent w"))["error.type"]).toBe("429");
  });

  it("is the parent of what the model's client reports", async () => {
    const { agent } = await assemble(workspaceWith(LINEAR), {
      model: new TracedModel([{ reply: "hi" }]),
    });
    await turn(agent, "s1", "go");
    expect(otel.parentOf(otel.one("POST /v1/chat/completions"))?.name).toBe("chat");
  });

  it("records one duration and two token measurements, with no session or state", async () => {
    const { agent } = await assemble(workspaceWith(LINEAR), {
      model: new ScriptedModel([{ reply: "hi", usage: { input: 30, output: 4 } }], {
        model: "gpt-test",
      }),
    });
    await turn(agent, "session-with-a-name", "go");

    const collected = await otel.metrics();
    const duration = collected.find((m) => m.name === "gen_ai.client.operation.duration")!;
    const tokens = collected.find((m) => m.name === "gen_ai.client.token.usage")!;
    expect(duration.points).toHaveLength(1);
    expect(duration.points[0]).toMatchObject({
      count: 1,
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "archmax-behaviour-scripted",
        "gen_ai.request.model": "gpt-test",
      },
    });
    expect(tokens.points.map((p) => [p.attributes["gen_ai.token.type"], p.sum])).toEqual([
      ["input", 30],
      ["output", 4],
    ]);
    const values = collected.flatMap((m) => m.points.flatMap((p) => Object.values(p.attributes)));
    expect(values).not.toContain("session-with-a-name");
    expect(values).not.toContain("start");
  });
});

describe("a tool call", () => {
  const params = { tools: [hostTool("lookup"), hostTool("other")] };

  it("says how it ended: granted, blocked by a rule, unresolved, failed or unknown", async () => {
    const { agent, model, events } = await assemble(workspaceWith(LINEAR), {
      turns: [
        { tool: "lookup", args: { q: "ORD-7" } },
        { tool: "other", args: { q: "x" } },
        { tool: "lookup", args: { q: "${{missing_variable}}" } },
        { tool: "lookup", args: { q: "fail-on-purpose" } },
        { tool: "look up the order please", args: {} },
        { reply: "done" },
      ],
      params,
    });
    await turn(agent, "s1", "go");

    expect(
      toolSpans().map((s) => [
        s.name,
        attrs(s)["archmax.tool.outcome"],
        attrs(s)["archmax.tool.rule"],
        attrs(s)["error.type"],
      ]),
    ).toEqual([
      ["execute_tool lookup", "ok", undefined, undefined],
      ["execute_tool other", "blocked", "tool.not-allowed", "blocked"],
      ["execute_tool lookup", "blocked", "unresolved-argument", "blocked"],
      ["execute_tool lookup", "error", undefined, "tool_error"],
      ["execute_tool unknown", "unknown", undefined, "unknown_tool"],
    ]);
    // The failing tool's error is still the model's to read.
    expect(model.calls[4]!.toolAnswers.at(-1)).toMatchObject({ status: "error" });
    expect(model.calls[4]!.toolAnswers.at(-1)!.content).toContain("could not handle");
    // Every span is in the state the call was made in, and carries the call's id.
    for (const span of toolSpans()) {
      expect(otel.parentOf(span)?.name).toBe("state start");
      expect(attrs(span)).toMatchObject({
        "archmax.state": "start",
        "archmax.tool.origin": "agent",
      });
    }
    expect(attrs(toolSpans()[0]!)["gen_ai.tool.call.id"]).toBe(
      eventsOf(events, "tool-called")[0]!.callId,
    );
  });

  it("is under the state a script's archmax_eval call was made in, and holds the script's calls", async () => {
    // `lookup` is granted for one order only: the script's second call is the kernel's to refuse.
    const guarded = {
      ...LINEAR,
      states: {
        ...LINEAR.states,
        start: {
          ...LINEAR.states.start,
          tools: { allow: [{ tool: "lookup", args: { q: ["ORD-1"] } }] },
        },
      },
    };
    const { agent, events } = await assemble(workspaceWith(guarded), {
      turns: [
        {
          tool: "archmax_eval",
          args: {
            code: 'await tools.lookup({ q: "ORD-1" }); try { await tools.lookup({ q: "ORD-2" }); } catch (e) {} "ok";',
          },
        },
        { reply: "done" },
      ],
      params,
    });
    await turn(agent, freshSessionId(), "go");

    const evalSpan = otel.one("execute_tool archmax_eval");
    expect(otel.parentOf(evalSpan)?.name).toBe("state start");
    expect(attrs(evalSpan)["archmax.tool.outcome"]).toBe("ok");
    const scripted = otel.childrenOf(evalSpan);
    expect(
      scripted.map((s) => [
        s.name,
        attrs(s)["archmax.tool.origin"],
        attrs(s)["archmax.tool.outcome"],
      ]),
    ).toEqual([
      ["execute_tool lookup", "script", "ok"],
      ["execute_tool lookup", "script", "blocked"],
    ]);
    expect(attrs(scripted[1]!)["archmax.tool.rule"]).toMatch(/^[a-z]+\.[a-z-]+$/);
    // A script's call carries the id its events do.
    expect(scripted.map((s) => attrs(s)["gen_ai.tool.call.id"])).toEqual([
      eventsOf(events, "tool-called").find((e) => e.origin === "script")!.callId,
      eventsOf(events, "tool-blocked").find((e) => e.origin === "script")!.callId,
    ]);
  });

  it("made by a grader is reported once, with the rule that blocked it", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        work: { triggers: { manual: null }, transitions: [{ to: "review", description: "Done." }] },
        review: {
          type: "grader",
          instructions: "Approve.",
          tools: { allow: [{ tool: "lookup", args: { q: ["ORD-1"] } }] },
          transitions: [{ to: "done", description: "Fine." }],
        },
        done: {},
      },
    };
    const grader = new ScriptedModel([
      { tool: "lookup", args: { q: "ORD-1" } },
      { tool: "lookup", args: { q: "ORD-2" } },
      { tool: "lookup", args: { q: "${{not_set}}" } },
      { tool: "acct_4111111111111111", args: { q: "${{not_set}}" } },
      advanceTo("done", "fine"),
    ]);
    const { agent } = await assemble(workspaceWith(spec), {
      model: new ScriptedModel([advanceTo("review", "worked"), { reply: "done" }]),
      graderModel: grader,
      params: { tools: [hostTool("lookup")] },
    });
    await agent.workflow.send(freshSessionId(), { message: "go" });

    const review = otel.one("state review");
    const calls = otel.childrenOf(review).filter((s) => s.name.startsWith("execute_tool"));
    expect(
      calls.map((s) => [s.name, attrs(s)["archmax.tool.origin"], attrs(s)["archmax.tool.outcome"]]),
    ).toEqual([
      ["execute_tool lookup", "grader", "ok"],
      ["execute_tool lookup", "grader", "blocked"],
      ["execute_tool lookup", "grader", "blocked"],
      // A name no tool of the grader's has: reported as unknown, its text nowhere.
      ["execute_tool unknown", "grader", "unknown"],
      ["execute_tool archmax_advance", "grader", "ok"],
    ]);
    expect(attrs(calls[1]!)["archmax.tool.rule"]).toMatch(/^tool\./);
    expect(attrs(calls[2]!)["archmax.tool.rule"]).toBe("unresolved-argument");
  });

  it("holds the child session's turn of a delegation, which keeps its own totals", async () => {
    const CHILD_TOOL = workflowToolName("enrich");
    const root = makeWorkspace({
      "AGENTS.md": AGENTS_MD,
      "workflows/w/workflow.yaml": {
        runtime: RUNTIME,
        states: {
          start: {
            triggers: { manual: null },
            tools: { allow: [CHILD_TOOL] },
            transitions: [{ to: "done", description: "Enriched." }],
          },
          done: {},
        },
      },
      "workflows/enrich/workflow.yaml": {
        runtime: RUNTIME,
        states: {
          work: { triggers: { manual: { requires: ["order_id"], returns: ["enrichment_file"] } } },
        },
      },
    });
    const { agent, events } = await assemble(root, {
      turns: [
        { tool: CHILD_TOOL, args: { order_id: "ORD-7" }, usage: { input: 10, output: 1 } },
        // — child —
        {
          tool: "archmax_set_variables",
          args: { variables: { enrichment_file: "scratchpad/e.json" } },
          usage: { input: 1000, output: 100 },
        },
        { reply: "ORD-7 enriched", usage: { input: 1000, output: 100 } },
        // — parent —
        { ...advanceTo("done"), usage: { input: 20, output: 2 } },
        { reply: "parent finished", usage: { input: 30, output: 3 } },
      ],
    });
    await turn(agent, "s1", "enrich ORD-7");

    expect(otel.outline()).toBe(
      [
        "invoke_agent w",
        "  state start",
        "    chat",
        `    execute_tool ${CHILD_TOOL}`,
        "      invoke_agent enrich",
        "        state work",
        "          chat",
        "          execute_tool archmax_set_variables",
        "          chat",
        "    chat",
        "    execute_tool archmax_advance",
        "  state done",
        "    chat",
      ].join("\n"),
    );
    const start = eventsOf(events, "sub-workflow-start")[0]!;
    const child = otel.one("invoke_agent enrich");
    expect(attrs(child)).toMatchObject({
      "archmax.dispatch.id": start.dispatchId,
      "archmax.session.status": "completed",
      "gen_ai.usage.input_tokens": 2000,
    });
    expect(attrs(child)["gen_ai.conversation.id"]).not.toBe("s1");
    expect(attrs(otel.one("invoke_agent w"))["gen_ai.usage.input_tokens"]).toBe(60);
  });
});

describe("whole turns", () => {
  /** A marker no span or metric may carry: it stands for content. */
  const mark = (where: string) => `MARKER ${where} 7f3a`;
  const CHILD_TOOL = workflowToolName("enrich");

  /**
   * A workspace that exercises every path a call can take: the agent's own
   * calls (granted, blocked, unresolved, failing, unknown), `archmax_eval`, a
   * delegation whose child raises, a code state and a grader.
   */
  function everyPath() {
    const root = makeWorkspace({
      "AGENTS.md": AGENTS_MD,
      "workflows/w/workflow.yaml": {
        runtime: RUNTIME,
        states: {
          start: {
            triggers: { manual: null },
            tools: { allow: ["lookup", CHILD_TOOL] },
            transitions: [{ to: "check", description: "Looked everything up." }],
          },
          check: {
            type: "code",
            script: "scripts/check.js",
            tools: { allow: ["lookup"] },
            transitions: [{ to: "review", description: "Checked." }],
          },
          review: {
            type: "grader",
            instructions: "Approve.",
            tools: { allow: ["lookup"] },
            transitions: [{ to: "done", description: "Fine." }],
          },
          done: {},
        },
      },
      "workflows/w/scripts/check.js":
        `export default async function ({ tools, variables }) {\n` +
        `  console.log(${JSON.stringify(mark("console"))} + variables.note);\n` +
        `  await tools.lookup({ q: ${JSON.stringify(mark("code argument"))} });\n` +
        `  try { await tools.lookup({ q: ${JSON.stringify(`fail ${mark("code error")}`)} }); } catch (e) {}\n` +
        `  await tools.archmax_set_variables({ variables: { checked: ${JSON.stringify(mark("code variable"))} } });\n` +
        `  await tools.archmax_advance({ to: "review", reason: ${JSON.stringify(mark("code reason"))} });\n` +
        `}\n`,
      "workflows/enrich/workflow.yaml": {
        runtime: RUNTIME,
        states: { work: { triggers: { manual: { requires: ["order_id"] } } } },
      },
    });
    const agentTurns: ScriptedTurn[] = [
      {
        tool: "lookup",
        args: { q: mark("argument") },
        text: mark("text beside a call"),
        usage: { input: 9, output: 1 },
      },
      { tool: "lookup", args: { q: `fail ${mark("error message")}` } },
      { tool: "other", args: { q: mark("blocked argument") } },
      { tool: "lookup", args: { q: "${{not_set}}" } },
      { tool: `look up ${mark("free-text tool name")}`, args: { q: mark("unknown argument") } },
      { tool: "MARKER_identifier_7f3a", args: {} },
      { tool: "archmax_set_variables", args: { variables: { note: mark("variable value") } } },
      { tool: "lookup", args: { q: "${{note}}" } },
      {
        tool: "archmax_eval",
        args: {
          code:
            `await tools.lookup({ q: ${JSON.stringify(mark("script argument"))} });\n` +
            `try { await tools.lookup({ q: ${JSON.stringify(`fail ${mark("script error")}`)} }); } catch (e) {}\n` +
            `${JSON.stringify(mark("eval result"))};`,
        },
      },
      { tool: CHILD_TOOL, args: { order_id: mark("delegation parameter") } },
      // — child —
      { tool: "archmax_raise", args: { code: "enrich-failed", reason: mark("raise reason") } },
      // — parent —
      advanceTo("check", mark("advance reason")),
      { reply: mark("closing reply") },
    ];
    const graderTurns: ScriptedTurn[] = [
      { tool: "archmax_get_history", args: {} },
      { tool: "lookup", args: { q: mark("grader argument") } },
      { tool: "lookup", args: { q: "${{not_set_either}}" } },
      { tool: "MARKER_grader_tool_7f3a", args: { q: "${{not_set_either}}" } },
      { tool: `ask ${mark("grader free text")}`, args: {} },
      { ...advanceTo("done", mark("grader reason")), usage: { input: 4, output: 1 } },
    ];
    return { root, agentTurns, graderTurns };
  }

  async function runEveryPath() {
    const { root, agentTurns, graderTurns } = everyPath();
    const assembled = await assemble(root, {
      model: new ScriptedModel(agentTurns, { model: "gpt-test" }),
      graderModel: new ScriptedModel(graderTurns, { model: "grader-test" }),
      params: {
        tools: [hostTool("lookup"), hostTool("other")],
        pricing: { "gpt-test": { input: 1, output: 1 } },
      },
    });
    const sessionId = freshSessionId();
    const outcome = await assembled.agent.workflow.send(sessionId, {
      message: mark("the person's message"),
    });
    return { ...assembled, sessionId, outcome };
  }

  it("carry metadata only: no message, reply, argument, result, variable value or error text", async () => {
    const { outcome } = await runEveryPath();
    expect(outcome).toMatchObject({ kind: "completed", state: "done" });

    // Every path was taken…
    const outcomes = new Set(
      toolSpans().map(
        (s) => `${attrs(s)["archmax.tool.origin"]}:${attrs(s)["archmax.tool.outcome"]}`,
      ),
    );
    for (const expected of [
      "agent:ok",
      "agent:blocked",
      "agent:error",
      "agent:unknown",
      "script:ok",
      "script:error",
      "grader:ok",
      "grader:blocked",
      "grader:unknown",
    ]) {
      expect(outcomes).toContain(expected);
    }
    expect(otel.one("invoke_agent enrich")).toBeDefined();
    expect(attrs(otel.one("state work"))["error.type"]).toBe("raised");
    expect(states().map((s) => attrs(s)["archmax.state.type"])).toEqual(
      expect.arrayContaining(["agent", "code", "grader"]),
    );

    // …and nothing any of them was given or answered is recorded anywhere.
    const recorded = await otel.strings();
    expect(recorded.length).toBeGreaterThan(200);
    expect(recorded.filter((s) => /MARKER|7f3a/.test(s))).toEqual([]);
    expect(otel.spans().every((s) => s.events.length === 0 && s.status.message === undefined)).toBe(
      true,
    );
  });

  it("share their ids with the event stream: one span per reported call", async () => {
    const { events } = await runEveryPath();

    const reported = [
      ...eventsOf(events, "tool-called"),
      ...eventsOf(events, "tool-blocked"),
      ...eventsOf(events, "tool-result"),
    ];
    expect(reported.length).toBeGreaterThan(20);
    for (const event of reported) {
      // A model's call ids are its own (two scripted models both count from one),
      // so a call is identified as the events identify it: its id in its session and state.
      const matching = toolSpans().filter(
        (s) =>
          attrs(s)["gen_ai.tool.call.id"] === event.callId &&
          attrs(s)["gen_ai.conversation.id"] === event.sessionId &&
          attrs(s)["archmax.state"] === event.state,
      );
      expect(matching, `${event.type} ${event.tool} ${event.callId}`).toHaveLength(1);
      const name = attrs(matching[0]!)["gen_ai.tool.name"];
      expect([event.tool, "unknown"]).toContain(name);
    }
    // Every turn's session is its events' session.
    const sessions = new Set(events.map((e) => e.sessionId).filter(Boolean));
    expect(new Set(turns().map((s) => attrs(s)["gen_ai.conversation.id"]))).toEqual(sessions);
  });

  it("change nothing a host sees: the same outcome and events with and without an SDK", async () => {
    /** What a run reports, with what differs between any two runs (times, ids, the session's name) taken out. */
    const comparable = (run: Awaited<ReturnType<typeof runEveryPath>>) =>
      JSON.parse(
        JSON.stringify({ outcome: run.outcome, events: run.events }, (key, value) =>
          ["ts", "seq", "durationMs", "createdAt", "id", "messageId", "lc_kwargs"].includes(key)
            ? undefined
            : value,
        )
          .replaceAll(run.sessionId, "<session>")
          .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>"),
      ) as unknown;

    const traced = comparable(await runEveryPath());
    expect(otel.spans().length).toBeGreaterThan(30);
    await uninstallOtel();
    const untraced = comparable(await runEveryPath());
    installOtel();

    expect(untraced).toEqual(traced);
    expect(otel.spans()).toEqual([]);
  });

  it("of two sessions at once are two traces that never cross", async () => {
    const root = workspaceWith(LINEAR);
    const script = (n: number): ScriptedTurn[] => [
      { tool: "lookup", args: { q: `q${n}` }, delayMs: 15, usage: { input: n, output: 1 } },
      { ...advanceTo("done"), delayMs: 5, usage: { input: n, output: 1 } },
      { reply: `r${n}`, delayMs: 10, usage: { input: n, output: 1 } },
    ];
    // One agent per session, so each scripted model answers its own session only.
    const [one, two] = await Promise.all([
      assemble(root, { turns: script(100), params: { tools: [hostTool("lookup")] } }),
      assemble(root, { turns: script(200), params: { tools: [hostTool("lookup")] } }),
    ]);
    await Promise.all([turn(one.agent, "s-one", "go"), turn(two.agent, "s-two", "go")]);

    const traces = otel.traces();
    expect(traces).toHaveLength(2);
    for (const spans of traces) {
      const ids = new Set(spans.map((s) => attrs(s)["gen_ai.conversation.id"]).filter(Boolean));
      expect(ids.size).toBe(1);
      const root = spans.find((s) => s.name.startsWith("invoke_agent"))!;
      const id = [...ids][0];
      expect(attrs(root)["gen_ai.usage.input_tokens"]).toBe(id === "s-one" ? 300 : 600);
      expect(spans.map((s) => s.name)).toHaveLength(8);
    }
  });

  it("of one agent serving two sessions at once never cross either", async () => {
    const model = new ScriptedModel([]);
    const { agent } = await assemble(workspaceWith(LINEAR), {
      model,
      params: { tools: [hostTool("lookup")] },
    });
    // The shared script interleaves: each session reads whichever turn is next, so
    // the test asserts only what cannot depend on the order.
    model.enqueue({ reply: "a", delayMs: 20 }, { reply: "b", delayMs: 5 });
    await Promise.all([turn(agent, "s-a", "go"), turn(agent, "s-b", "go")]);

    expect(otel.traces()).toHaveLength(2);
    for (const spans of otel.traces()) {
      const root = spans.find((s) => s.name === "invoke_agent w")!;
      const session = attrs(root)["gen_ai.conversation.id"];
      for (const span of spans) {
        if (span !== root) expect(otel.isUnder(span, root)).toBe(true);
        const id = attrs(span)["gen_ai.conversation.id"];
        if (id !== undefined) expect(id).toBe(session);
      }
    }
  });
});

describe("parks", () => {
  const CHILD_TOOL = workflowToolName("enrich");
  /** The parent may delegate to `enrich`, whose child parks at a human state. */
  function reviewingChild() {
    return makeWorkspace({
      "AGENTS.md": AGENTS_MD,
      "workflows/w/workflow.yaml": {
        runtime: RUNTIME,
        states: {
          start: {
            triggers: { manual: null },
            tools: { allow: [CHILD_TOOL] },
            transitions: [{ to: "done", description: "Enriched." }],
          },
          done: {},
        },
      },
      "workflows/enrich/workflow.yaml": {
        runtime: RUNTIME,
        states: {
          draft: {
            triggers: { manual: { requires: ["order_id"] } },
            transitions: [{ to: "review", description: "Ready for review." }],
          },
          review: {
            type: "human",
            transitions: [{ to: "approved", type: "approve", description: "Fine." }],
          },
          approved: {},
        },
      },
    });
  }

  it("of archmax_wait is the call's outcome, not an error", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        clarify: {
          triggers: {
            manual: { session: "conversation_id" },
            email_reply: { session: "conversation_id" },
          },
          transitions: [{ to: "answer", description: "Clear now." }],
        },
        answer: {},
      },
    };
    const { agent } = await assemble(workspaceWith(spec), {
      turns: [{ tool: "archmax_wait", args: { reason: "which order?" } }],
    });
    await turn(agent, "conv-1", "help with my order");

    const wait = otel.one("execute_tool archmax_wait");
    expect(attrs(wait)["archmax.tool.outcome"]).toBe("parked");
    expect(isError(wait)).toBe(false);
    expect(attrs(otel.one("state clarify"))["archmax.state.parked"]).toBe("input");
    expect(attrs(otel.one("invoke_agent w"))["archmax.session.status"]).toBe("awaiting_input");
  });

  it("of a child session is the child turn's park and the delegation's outcome, never an error", async () => {
    const { agent } = await assemble(reviewingChild(), {
      turns: [
        { tool: CHILD_TOOL, args: { order_id: "ORD-7" } },
        advanceTo("review", "needs a reviewer"),
      ],
    });
    await turn(agent, "s1", "go");

    const child = otel.one("invoke_agent enrich");
    expect(isError(child)).toBe(false);
    expect(attrs(child)["error.type"]).toBeUndefined();
    expect(attrs(child)["archmax.session.status"]).toBe("awaiting_decision");
    expect(attrs(otel.one("state review"))["archmax.state.parked"]).toBe("decision");
    const delegation = otel.one(`execute_tool ${CHILD_TOOL}`);
    expect(attrs(delegation)["archmax.tool.outcome"]).toBe("parked");
    expect(isError(delegation)).toBe(false);
    expect(otel.isUnder(child, delegation)).toBe(true);
    expect(attrs(otel.one("invoke_agent w"))["archmax.session.status"]).toBe("awaiting_decision");
    expect(otel.spans().filter(isError)).toEqual([]);
  });

  it("of a child session resumes as a turn directly under the parent's resumed turn", async () => {
    const { agent, model } = await assemble(reviewingChild(), {
      turns: [
        { tool: CHILD_TOOL, args: { order_id: "ORD-7" } },
        advanceTo("review", "needs a reviewer"),
      ],
    });
    await turn(agent, "s1", "go");
    otel.reset();
    model.enqueue({ reply: "child approved" }, advanceTo("done"), { reply: "parent finished" });
    await agent.workflow.decide("s1", { target: "approved" });

    const parent = otel.one("invoke_agent w");
    const child = otel.one("invoke_agent enrich");
    expect(otel.parentOf(child)).toBe(parent);
    expect(attrs(child)).toMatchObject({
      "archmax.turn.resume": true,
      "archmax.session.status": "completed",
    });
    expect(attrs(parent)).toMatchObject({
      "archmax.turn.resume": true,
      "archmax.session.status": "completed",
    });
  });
});

describe("a grader's", () => {
  const spec = (review: Record<string, unknown> = {}) => ({
    runtime: RUNTIME,
    states: {
      work: { triggers: { manual: null }, transitions: [{ to: "review", description: "Done." }] },
      review: {
        type: "grader",
        instructions: "Approve.",
        on_error: "escalate",
        tools: { allow: ["lookup"] },
        transitions: [{ to: "done", description: "Fine." }],
        ...review,
      },
      done: {},
      escalate: {},
    },
  });

  it("model call over its time budget ends at the expiry, even when the model ignores the abort", async () => {
    const grader = new ScriptedModel([{ tool: "archmax_get_history", args: {}, delayMs: 1000 }]);
    const { agent } = await assemble(workspaceWith(spec({ budget: { timeoutMs: 50 } })), {
      model: new ScriptedModel([advanceTo("review", "worked"), { reply: "escalated" }]),
      graderModel: grader,
    });
    await agent.workflow.send(freshSessionId(), { message: "go" });

    const call = otel.childrenOf(otel.one("state review")).find((s) => s.name === "chat")!;
    expect(attrs(call)["error.type"]).toBe("timeout");
    expect(attrs(call)["archmax.model.role"]).toBe("grader");
    expect(call.duration[0] * 1e3 + call.duration[1] / 1e6).toBeLessThan(600);
    expect(attrs(otel.one("state review"))["error.type"]).toBe("automated_state_failed");
  });

  it("call whose arguments the tool refuses is a span too", async () => {
    const grader = new ScriptedModel([
      { tool: "lookup", args: { q: 42 } },
      advanceTo("done", "fine"),
    ]);
    const { agent } = await assemble(workspaceWith(spec()), {
      model: new ScriptedModel([advanceTo("review", "worked"), { reply: "done" }]),
      graderModel: grader,
      params: { tools: [hostTool("lookup")] },
    });
    await agent.workflow.send(freshSessionId(), { message: "go" });

    const calls = otel
      .childrenOf(otel.one("state review"))
      .filter((s) => s.name.startsWith("execute_tool"));
    expect(calls.map((s) => [s.name, attrs(s)["archmax.tool.outcome"]])).toEqual([
      ["execute_tool lookup", "error"],
      ["execute_tool archmax_advance", "ok"],
    ]);
  });
});

describe("the host's SDK", () => {
  it("cannot fail a turn by throwing while a span starts", async () => {
    await uninstallOtel();
    const { TracerProvider } = await import("@opentelemetry/sdk-trace");
    const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks");
    const throwing = new TracerProvider({
      spanProcessors: [
        {
          onStart: () => {
            throw new Error("a span processor's bug");
          },
          onEnd: () => {},
          forceFlush: async () => {},
          shutdown: async () => {},
        },
      ],
    });
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(throwing);
    try {
      const { agent } = await assemble(workspaceWith(LINEAR), {
        turns: [{ tool: "lookup", args: { q: "x" } }, advanceTo("done"), { reply: "done" }],
        params: { tools: [hostTool("lookup")] },
      });
      const { reply } = await turn(agent, "s1", "go");
      expect(reply).toBe("done");
    } finally {
      trace.disable();
      context.disable();
      installOtel();
    }
  });

  it("can name its own middleware as it likes, beside a plain agent's telemetry", async () => {
    const { createMiddleware } = await import("langchain");
    const agent = await createAgent({
      workflow: false,
      model: new ScriptedModel([{ reply: "hi" }]) as never,
      onEvent: () => {},
      middleware: [createMiddleware({ name: "TelemetryMiddleware" })],
      workspace: {
        rootDir: makeWorkspace({ "AGENTS.md": AGENTS_MD }),
        sessionStore: createMemorySessionStore(),
      },
    });
    await agent.invoke({ messages: [{ role: "user", content: "hello" }] } as never, {
      configurable: { thread_id: "p1" },
    });
    expect(otel.one("invoke_agent")).toBeDefined();
  });
});
