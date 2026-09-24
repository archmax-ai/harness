import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "../workflow/session-view.js";
import {
  judgeEvidenceFromView,
  MAX_RECORD_CHARS,
  MAX_VALUE_CHARS,
  renderJudgeEvidence,
  type JudgeResult,
  createJudgeModel,
  gradeClosedQA,
} from "./grade.js";
import type { AgentEnv, ModelFactory } from "../env.js";
import { messagesToSessionView } from "../workflow/session-view.js";
import { runtimeNote } from "../core/messages.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

function view(partial: Partial<SessionView>): SessionView {
  return {
    sessionId: "s",
    reply: "",
    failed: false,
    parked: false,
    events: [],
    toolCalls: [],
    auditTrail: [],
    variables: {},
    ...partial,
  };
}

/** Message shapes as `messagesToSessionView` consumes them (LangChain-ish ducks). */
function ai(content: string, toolCalls?: Array<{ name: string; id: string; args: unknown }>) {
  return { _getType: () => "ai", content, tool_calls: toolCalls };
}
function toolResult(name: string, id: string, content: unknown, status = "completed") {
  return { _getType: () => "tool", name, tool_call_id: id, content, status };
}

describe("judgeEvidenceFromView", () => {
  it("records a runtime note in place and renders it as [runtime:<kind>]", () => {
    const evidence = judgeEvidenceFromView(
      messagesToSessionView([
        { _getType: () => "human", content: "go" },
        ai("Handing this to a reviewer."),
        ...runtimeNote("decision", "[decision] A human selected approve → 'approved' at the 'review' checkpoint."),
        ai("The refund is approved and closed."),
      ]),
    );

    expect(evidence.reply).toBe("The refund is approved and closed.");
    expect(evidence.record).toEqual([
      { kind: "message", text: "Handing this to a reviewer." },
      {
        kind: "runtime",
        note: "decision",
        text: "[decision] A human selected approve → 'approved' at the 'review' checkpoint.",
      },
    ]);
    const rendered = renderJudgeEvidence(evidence);
    expect(rendered).toContain("2. [runtime:decision] [decision] A human selected approve");
    expect(rendered).not.toContain("[tool] archmax_note");
  });

  it("records assistant messages and tool calls in the order they happened", () => {
    const evidence = judgeEvidenceFromView(
      messagesToSessionView([
        ai("Let me look that up.", [
          { name: "read_file", id: "c1", args: { file_path: "data/orders.json" } },
        ]),
        toolResult("read_file", "c1", '{"id":"ORD-1001"}'),
        ai("ORD-1001 ships tomorrow."),
      ]),
    );

    expect(evidence.reply).toBe("ORD-1001 ships tomorrow.");
    expect(evidence.record).toEqual([
      { kind: "message", text: "Let me look that up." },
      {
        kind: "tool",
        name: "read_file",
        input: { file_path: "data/orders.json" },
        output: { id: "ORD-1001" },
        status: "completed",
      },
    ]);
  });

  it("pairs interleaved calls to the same tool with their own outputs", () => {
    const evidence = judgeEvidenceFromView(
      messagesToSessionView([
        ai("", [
          { name: "read_file", id: "a", args: { file_path: "one.json" } },
          { name: "read_file", id: "b", args: { file_path: "two.json" } },
        ]),
        // Answered out of order — pairing is by id, not arrival.
        toolResult("read_file", "b", '"two"'),
        toolResult("read_file", "a", '"one"'),
        ai("Done."),
      ]),
    );

    expect(evidence.record).toEqual([
      {
        kind: "tool",
        name: "read_file",
        input: { file_path: "one.json" },
        output: "one",
        status: "completed",
      },
      {
        kind: "tool",
        name: "read_file",
        input: { file_path: "two.json" },
        output: "two",
        status: "completed",
      },
    ]);
  });

  it("carries each tool call's status, including a governance rejection", () => {
    const rejected = {
      _getType: () => "tool",
      name: "write_file",
      tool_call_id: "c1",
      content: "blocked by policy",
      status: "error",
      additional_kwargs: { governance_blocked: true },
    };
    const evidence = judgeEvidenceFromView(
      messagesToSessionView([
        ai("", [{ name: "write_file", id: "c1", args: { file_path: "output/x" } }]),
        rejected,
        ai("I cannot do that."),
      ]),
    );

    expect(evidence.record).toHaveLength(1);
    expect(evidence.record[0]).toMatchObject({ kind: "tool", status: "rejected" });
  });

  it("keeps a pending call (no result yet) with no output", () => {
    const evidence = judgeEvidenceFromView(
      messagesToSessionView([ai("working", [{ name: "search", id: "c1", args: { q: "x" } }])]),
    );
    expect(evidence.record).toEqual([
      { kind: "message", text: "working" },
      { kind: "tool", name: "search", input: { q: "x" }, status: "pending" },
    ]);
  });

  it("does not repeat the closing message in the record — it is the graded reply", () => {
    const evidence = judgeEvidenceFromView(messagesToSessionView([ai("Only one message.")]));
    expect(evidence.reply).toBe("Only one message.");
    expect(evidence.record).toEqual([]);
  });

  it("keeps the reply message in place when tool calls followed it", () => {
    // `reply` is the last assistant *text*; a message that both spoke and
    // called a tool stays in the record, because "said this, then did that" is
    // the ordering the judge needs.
    const evidence = judgeEvidenceFromView(
      messagesToSessionView([
        ai("Advancing now.", [{ name: "archmax_advance", id: "c1", args: { to: "answer" } }]),
        toolResult("archmax_advance", "c1", '"ok"'),
      ]),
    );
    expect(evidence.reply).toBe("Advancing now.");
    expect(evidence.record).toEqual([
      { kind: "message", text: "Advancing now." },
      {
        kind: "tool",
        name: "archmax_advance",
        input: { to: "answer" },
        output: "ok",
        status: "completed",
      },
    ]);
  });

  it("falls back to the event's own data when no paired fact exists", () => {
    const evidence = judgeEvidenceFromView(
      view({
        reply: "done",
        events: [{ type: "tool.called", data: { name: "ghost", input: { a: 1 } } }],
      }),
    );
    expect(evidence.record).toEqual([
      { kind: "tool", name: "ghost", input: { a: 1 }, status: "pending" },
    ]);
  });
});

describe("renderJudgeEvidence", () => {
  it("labels the record and the final reply as separate sections", () => {
    const rendered = renderJudgeEvidence({
      reply: "ORD-1001 ships tomorrow.",
      record: [
        { kind: "message", text: "Looking it up." },
        {
          kind: "tool",
          name: "read_file",
          input: { file_path: "data/orders.json" },
          output: { id: "ORD-1001" },
          status: "completed",
        },
      ],
    });

    expect(rendered).toContain("What the assistant did, in order:");
    expect(rendered).toContain("1. [message] Looking it up.");
    expect(rendered).toContain(
      '2. [tool] read_file input={"file_path":"data/orders.json"} → completed output={"id":"ORD-1001"}',
    );
    expect(rendered).toContain("Final reply to the user:\nORD-1001 ships tomorrow.");
  });

  it("states explicitly that nothing was recorded rather than dropping the section", () => {
    const rendered = renderJudgeEvidence({ reply: "Hi.", record: [] });
    expect(rendered).toContain("(no tool calls or intermediate messages recorded)");
    expect(rendered).toContain("Final reply to the user:\nHi.");
  });

  it("caps an oversized value and names the characters it dropped", () => {
    const output = "x".repeat(MAX_VALUE_CHARS + 250);
    const rendered = renderJudgeEvidence({
      reply: "done",
      record: [{ kind: "tool", name: "read_file", input: {}, output, status: "completed" }],
    });

    expect(rendered).toContain("…(+250 chars)");
    expect(rendered).not.toContain(output);
  });

  it("marks a missing output rather than rendering it as empty", () => {
    const rendered = renderJudgeEvidence({
      reply: "done",
      record: [{ kind: "tool", name: "search", input: { q: "x" }, status: "pending" }],
    });
    expect(rendered).toContain("→ pending (no output recorded)");
  });

  it("drops the oldest entries over budget and names how many", () => {
    // Each entry renders well under the per-value cap; enough of them to blow
    // the record budget several times over.
    const record = Array.from({ length: 400 }, (_, i) => ({
      kind: "message" as const,
      text: `step ${i} ${"y".repeat(100)}`,
    }));
    const rendered = renderJudgeEvidence({ reply: "done", record });

    expect(rendered).toMatch(/… \d+ earlier entries omitted \(evidence budget\)/);
    expect(rendered).toContain(`400. [message] step 399`);
    expect(rendered).not.toContain("1. [message] step 0 ");
    // The kept body stays within budget (the marker and reply sit outside it).
    const body = rendered.split("Final reply to the user:")[0];
    expect(body.length).toBeLessThan(MAX_RECORD_CHARS + 200);
  });

  it("keeps the newest entry even when it alone exceeds the budget", () => {
    const rendered = renderJudgeEvidence({
      reply: "done",
      record: [{ kind: "message", text: "z".repeat(MAX_RECORD_CHARS * 2) }],
    });
    expect(rendered).toContain("1. [message] zzz");
    expect(rendered).not.toContain("omitted (evidence budget)");
  });

  it("never caps or elides the final reply", () => {
    const reply = "r".repeat(MAX_VALUE_CHARS + MAX_RECORD_CHARS);
    const rendered = renderJudgeEvidence({ reply, record: [] });
    expect(rendered).toContain(reply);
  });
});

/** A model replying with each content in turn (the last one repeats), recording what it was asked. */
function modelReturning(
  ...contents: unknown[]
): BaseChatModel & { calls: Array<Array<{ content: unknown }>> } {
  const calls: Array<Array<{ content: unknown }>> = [];
  return {
    calls,
    async invoke(messages: Array<{ content: unknown }>) {
      calls.push(messages);
      return { content: contents[Math.min(calls.length, contents.length) - 1] };
    },
  } as unknown as BaseChatModel & { calls: Array<Array<{ content: unknown }>> };
}

async function grade(content: unknown): Promise<JudgeResult> {
  return gradeClosedQA(modelReturning(content), "mentions the order id", {
    reply: "Order 42 is delayed.",
    record: [],
  });
}

describe("gradeClosedQA verdict parsing", () => {
  it("extracts the verdict JSON embedded in surrounding prose", async () => {
    const result = await grade(
      'Sure, here is my grade: {"score": 0.8, "pass": true, "reason": "criterion met"} — done.',
    );
    expect(result).toEqual({ score: 0.8, reason: "criterion met" });
  });

  it("parses the first balanced object when the reply contains several", async () => {
    const result = await grade(
      'First: {"score": 0.9, "pass": true, "reason": "ok"} and also {"score": 0.1, "pass": false}',
    );
    expect(result).toEqual({ score: 0.9, reason: "ok" });
  });

  it("handles nested braces and braces inside strings in the verdict", async () => {
    const result = await grade(
      '{"score": 0.7, "pass": true, "reason": "matched {order} token", "meta": {"depth": 2}}',
    );
    expect(result.score).toBe(0.7);
  });

  it("returns a zero-score verdict when the model reply has no JSON object, even when asked again", async () => {
    const result = await grade("definitely yes");
    expect(result.score).toBe(0);
    expect(result.reason).toBe("grader returned no readable JSON verdict");
  });

  it("reads a verdict wrapped in a markdown fence and prose", async () => {
    const result = await grade(
      'Here is my assessment.\n```json\n{"score": 0.9, "pass": true, "reason": "names ORD-42"}\n```\nHope that helps.',
    );
    expect(result).toEqual({ score: 0.9, reason: "names ORD-42" });
  });

  // The first `{` is not always the verdict: a grader that writes braces in its
  // prose used to make the whole grade unreadable.
  it("skips a brace block in the prose that is not JSON", async () => {
    const result = await grade(
      'The reply {mentions} the order. Verdict: {"score": 0.8, "pass": true, "reason": "ok"}',
    );
    expect(result).toEqual({ score: 0.8, reason: "ok" });
  });

  it("asks once more, JSON only, when the first reply is unreadable", async () => {
    const model = modelReturning(
      "Score: high. It clearly names the order.",
      '{"score": 1, "pass": true, "reason": "retry"}',
    );
    const result = await gradeClosedQA(model, "mentions the order id", {
      reply: "Order 42.",
      record: [],
    });
    expect(result).toEqual({ score: 1, reason: "retry" });
    expect(model.calls).toHaveLength(2);
    const reminder = model.calls[1]?.at(-1);
    expect(String(reminder?.content)).toContain("JSON object only");
    // The retry carries the first attempt so the model corrects itself.
    expect(model.calls[1]?.map((m) => String(m.content))).toContain(
      "Score: high. It clearly names the order.",
    );
  });

  it("clamps scores above 1 down to 1", async () => {
    const result = await grade('{"score": 5}');
    expect(result.score).toBe(1);
  });

  it("clamps negative scores up to 0", async () => {
    const result = await grade('{"score": -3}');
    expect(result.score).toBe(0);
  });

  // The model's own pass flag is not part of the result: the case's declared
  // `atLeast` decides, in the assertion layer.
  it("carries no pass flag of the model's own", async () => {
    const result = await grade('{"score": 0.1, "pass": true}');
    expect(result).toEqual({ score: 0.1, reason: undefined });
  });

  it("defaults a missing score to 0", async () => {
    const result = await grade('{"reason": "no score given"}');
    expect(result.score).toBe(0);
    expect(result.reason).toBe("no score given");
  });

  it("scores 0 when no braced block is valid JSON after the retry", async () => {
    const result = await grade("{score: not json}");
    expect(result.score).toBe(0);
    expect(result.reason).toBe("grader returned no readable JSON verdict");
  });

  it("joins array-shaped response content parts before extracting the verdict", async () => {
    const result = await grade([
      { text: '{"score": 1, ' },
      '"pass": true, ',
      { text: '"reason": "joined"}' },
    ]);
    expect(result).toEqual({ score: 1, reason: "joined" });
  });
});

describe("gradeClosedQA prompting", () => {
  /** Captures the messages the grader sends, returning a fixed verdict. */
  function capturingModel(): { model: BaseChatModel; prompts: string[] } {
    const prompts: string[] = [];
    const model = {
      async invoke(messages: Array<{ content: unknown }>) {
        for (const m of messages) prompts.push(String(m.content));
        return { content: '{"score": 1, "pass": true, "reason": "ok"}' };
      },
    } as unknown as BaseChatModel;
    return { model, prompts };
  }

  // The reason is printed beside a verdict line in `archmax test` and in any
  // host UI reading `detail`, so an unbounded paragraph does not fit.
  it("instructs the grader to keep its reason to 1-3 sentences", async () => {
    const { model, prompts } = capturingModel();
    await gradeClosedQA(model, "mentions the order id", {
      reply: "Order 42 is delayed.",
      record: [],
    });
    expect(prompts.join("\n")).toContain("Keep reason to 1-3 sentences");
  });

  // Adding the tool record to the grading input would otherwise let a
  // criterion about what the customer was *told* pass on the strength of a
  // tool call the customer never heard about.
  it("shows the run record and the final reply as separate, differently weighted evidence", async () => {
    const { model, prompts } = capturingModel();
    await gradeClosedQA(model, "looked up the order", {
      reply: "ORD-1001 ships tomorrow.",
      record: [
        {
          kind: "tool",
          name: "read_file",
          input: { file_path: "data/orders.json" },
          output: { id: "ORD-1001" },
          status: "completed",
        },
      ],
    });

    const prompt = prompts.join("\n");
    expect(prompt).toContain("What the assistant did, in order:");
    expect(prompt).toContain('read_file input={"file_path":"data/orders.json"}');
    expect(prompt).toContain("Final reply to the user:\nORD-1001 ships tomorrow.");
    expect(prompt).toContain("met only by the final reply");
    expect(prompt).toContain("may be met by the record");
  });

  it("records an over-long reason as returned rather than truncating it", async () => {
    const long = "One. Two. Three. Four. Five. Six.";
    const model = {
      async invoke() {
        return { content: JSON.stringify({ score: 0.8, pass: true, reason: long }) };
      },
    } as unknown as BaseChatModel;
    const result = await gradeClosedQA(model, "c", { reply: "t", record: [] });
    expect(result).toEqual({ score: 0.8, reason: long });
  });
});

describe("createJudgeModel", () => {
  afterEach(() => vi.unstubAllEnvs());

  function stubEnv() {
    vi.stubEnv("ARCHMAX_API_BASE_URL", "https://example.test/v1");
    vi.stubEnv("ARCHMAX_API_KEY", "key-1");
    vi.stubEnv("ARCHMAX_MODEL", "env-model");
  }

  it("hands tests.judge.model and modelOptions to the model factory through its env", () => {
    stubEnv();
    const seen: Array<{ role: string; env: AgentEnv }> = [];
    const factory: ModelFactory = (role, env) => {
      seen.push({ role, env: env() });
      return {} as BaseChatModel;
    };
    createJudgeModel({ judge: { model: "grader-x", modelOptions: { temperature: 0, maxTokens: 64 } } }, factory);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.role).toBe("judge");
    expect(seen[0]?.env).toMatchObject({
      apiBaseUrl: "https://example.test/v1",
      model: "grader-x",
      temperature: 0,
      maxTokens: 64,
    });
  });

  it("applies modelOptions to the default env-configured grader", () => {
    stubEnv();
    const model = createJudgeModel({ judge: { modelOptions: { temperature: 0.2, maxTokens: 32 } } }) as unknown as {
      model: string;
      temperature?: number;
      maxTokens?: number;
    };
    expect(model.model).toBe("env-model");
    expect(model.temperature).toBe(0.2);
    expect(model.maxTokens).toBe(32);
  });
});
