import { describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import {
  addSummaries,
  addUsage,
  computeCostUsd,
  createUsageTracker,
  emptyUsage,
  extractUsage,
  formatUsage,
  hasUsage,
  resolveModelPricing,
  summarizeUsage,
  type PricingTable,
} from "./usage.js";
import type { WorkflowLifecycleEvent } from "./events.js";

const PRICING: PricingTable = {
  "claude-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  default: { input: 1, output: 2 },
};

describe("extractUsage", () => {
  it("reads LangChain's normalized cache detail, cache counts inside the input total", () => {
    const message = new AIMessage({
      content: "hi",
      usage_metadata: {
        input_tokens: 1200,
        output_tokens: 40,
        total_tokens: 1240,
        input_token_details: { cache_read: 1000, cache_creation: 200 },
      },
      response_metadata: { model_name: "anthropic/claude-sonnet-4.6" },
    });
    const extracted = extractUsage(message);
    expect(extracted).toEqual({
      usage: {
        inputTokens: 1200,
        outputTokens: 40,
        cacheReadTokens: 1000,
        cacheCreationTokens: 200,
      },
      model: "anthropic/claude-sonnet-4.6",
    });
    // LangChain's contract: `input_tokens` is the sum of all input token types,
    // `input_token_details` its breakdown. Nothing is added on top of it here.
    const { inputTokens, cacheReadTokens, cacheCreationTokens } = extracted!.usage;
    expect(cacheReadTokens + cacheCreationTokens).toBeLessThanOrEqual(inputTokens);
  });

  it("falls back to the OpenAI-compatible raw shape, cached tokens inside prompt_tokens", () => {
    const message = new AIMessage({
      content: "hi",
      response_metadata: {
        model: "gpt-5",
        usage: {
          prompt_tokens: 900,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 512 },
        },
      },
    });
    // `prompt_tokens` already counts `prompt_tokens_details.cached_tokens`.
    expect(extractUsage(message)).toEqual({
      usage: {
        inputTokens: 900,
        outputTokens: 20,
        cacheReadTokens: 512,
        cacheCreationTokens: 0,
      },
      model: "gpt-5",
    });
  });

  it("normalizes the Anthropic raw shape, whose input count excludes its cache counts", () => {
    const message = new AIMessage({
      content: "hi",
      response_metadata: {
        model_name: "claude-sonnet-4.6",
        usage: {
          input_tokens: 200,
          output_tokens: 20,
          cache_read_input_tokens: 700,
          cache_creation_input_tokens: 100,
        },
      },
    });
    // Reported disjoint by the provider, folded into one total here so every
    // reader downstream sees the same invariant.
    expect(extractUsage(message)?.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 20,
      cacheReadTokens: 700,
      cacheCreationTokens: 100,
    });
  });

  it("prices a disjoint provider shape identically to the same usage reported inclusively", () => {
    const disjoint = extractUsage(
      new AIMessage({
        content: "hi",
        response_metadata: {
          usage: {
            input_tokens: 200,
            output_tokens: 20,
            cache_read_input_tokens: 700,
            cache_creation_input_tokens: 100,
          },
        },
      }),
    );
    const inclusive = extractUsage(
      new AIMessage({
        content: "hi",
        usage_metadata: {
          input_tokens: 1000,
          output_tokens: 20,
          total_tokens: 1020,
          input_token_details: { cache_read: 700, cache_creation: 100 },
        },
      }),
    );
    expect(computeCostUsd(disjoint!.usage, PRICING["claude-sonnet"])).toBe(
      computeCostUsd(inclusive!.usage, PRICING["claude-sonnet"]),
    );
  });

  it("treats a provider that reports no cache detail as zeros, not a failure", () => {
    const message = new AIMessage({
      content: "hi",
      usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    });
    expect(extractUsage(message)?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it("returns null when there is no usage at all", () => {
    expect(extractUsage(new AIMessage("hi"))).toBeNull();
    expect(extractUsage(undefined)).toBeNull();
  });
});

describe("pricing and cost", () => {
  it("matches a model by exact id, then longest substring, then default", () => {
    expect(resolveModelPricing(PRICING, "claude-sonnet")).toEqual(PRICING["claude-sonnet"]);
    expect(resolveModelPricing(PRICING, "anthropic/claude-sonnet-4.6")).toEqual(
      PRICING["claude-sonnet"],
    );
    expect(resolveModelPricing(PRICING, "gpt-5")).toEqual(PRICING.default);
    expect(resolveModelPricing(undefined, "gpt-5")).toBeUndefined();
  });

  it("prices each token kind at its own rate", () => {
    // `inputTokens` is the total, so a million at the full input rate means a
    // million *beyond* the cache counts.
    const usage = {
      inputTokens: 3_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    };
    expect(computeCostUsd(usage, PRICING["claude-sonnet"])).toBe(3 + 15 + 0.3 + 3.75);
  });

  it("charges a cached token once, not at the input rate as well", () => {
    // The documented warm-cache run: 20,000 input of which 18,000 came from cache.
    const usage = {
      inputTokens: 20_000,
      outputTokens: 0,
      cacheReadTokens: 18_000,
      cacheCreationTokens: 0,
    };
    const expected = (2_000 * 3 + 18_000 * 0.3) / 1_000_000;
    expect(computeCostUsd(usage, PRICING["claude-sonnet"])).toBeCloseTo(expected, 9);
    // The pre-fix arithmetic charged the full input count on top of the cache count.
    expect(computeCostUsd(usage, PRICING["claude-sonnet"])).toBeLessThan(
      (20_000 * 3 + 18_000 * 0.3) / 1_000_000,
    );
  });

  it("clamps the full-rate remainder at zero when a breakdown exceeds its total", () => {
    const usage = {
      inputTokens: 500,
      outputTokens: 0,
      cacheReadTokens: 900,
      cacheCreationTokens: 200,
    };
    // Never negative: an over-large breakdown must not credit cost back.
    expect(computeCostUsd(usage, PRICING["claude-sonnet"])).toBeCloseTo(
      (900 * 0.3 + 200 * 3.75) / 1_000_000,
      9,
    );
  });

  it("prices cache tokens at the input rate when no cache rate is given", () => {
    expect(
      computeCostUsd(
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 0 },
        { input: 2 },
      ),
    ).toBe(2);
  });

  it("omits cost when the model is unpriced, rather than reporting zero", () => {
    expect(computeCostUsd(emptyUsage(), undefined)).toBeUndefined();
    expect(computeCostUsd(emptyUsage(), {})).toBeUndefined();
    expect(summarizeUsage(emptyUsage(), PRICING, "gpt-5").costUsd).toBe(0);
    expect(summarizeUsage(emptyUsage(), undefined, "gpt-5").costUsd).toBeUndefined();
  });

  it("keeps sub-cent costs visible", () => {
    const summary = summarizeUsage(
      { inputTokens: 1200, outputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0 },
      PRICING,
      "claude-sonnet",
    );
    expect(summary.costUsd).toBeGreaterThan(0);
    expect(formatUsage(summary)).toContain("$0.0042");
  });
});

describe("usage arithmetic", () => {
  it("adds and detects usage", () => {
    const a = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 };
    expect(addUsage(a, a)).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cacheReadTokens: 6,
      cacheCreationTokens: 8,
    });
    expect(hasUsage(emptyUsage())).toBe(false);
    expect(hasUsage({ ...emptyUsage(), cacheReadTokens: 1 })).toBe(true);
  });

  it("formats tokens with cost only when priced", () => {
    const usage = { inputTokens: 12004, outputTokens: 318, cacheReadTokens: 9801, cacheCreationTokens: 0 };
    expect(formatUsage(usage)).toBe("in 12,004 · out 318 · cache r 9,801/w 0");
    expect(formatUsage({ ...usage, costUsd: 0.0421 })).toContain("$0.0421");
  });
});

describe("createUsageTracker", () => {
  const event = (payload: Record<string, unknown> & { type: string }) =>
    ({ level: "info", ts: 0, seq: 0, ...payload }) as unknown as WorkflowLifecycleEvent;

  it("accumulates segment usage per session and forwards every event", () => {
    const seen: string[] = [];
    const tracker = createUsageTracker({ onEvent: (e) => seen.push(e.type) });
    tracker.handler(
      event({
        type: "model-usage",
        sessionId: "t1",
        state: "a",
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 90,
        costUsd: 0.001,
      }),
    );
    tracker.handler(
      event({ type: "model-usage", sessionId: "t1", state: "b", inputTokens: 50, outputTokens: 5 }),
    );
    tracker.handler(
      event({ type: "model-usage", sessionId: "t2", state: "a", inputTokens: 7, outputTokens: 1 }),
    );
    tracker.handler(event({ type: "state-enter", state: "a" }));

    expect(tracker.totals("t1")).toEqual({
      inputTokens: 150,
      outputTokens: 15,
      cacheReadTokens: 90,
      cacheCreationTokens: 0,
      costUsd: 0.001,
    });
    // Cross-session totals cover every observed run.
    expect(tracker.totals().inputTokens).toBe(157);
    expect([...tracker.bySession().keys()].sort()).toEqual(["t1", "t2"]);
    expect(seen).toEqual(["model-usage", "model-usage", "model-usage", "state-enter"]);
  });

  it("reports zeros for an unknown session and resets on request", () => {
    const tracker = createUsageTracker();
    tracker.handler(
      event({ type: "model-usage", sessionId: "t1", state: "a", inputTokens: 5, outputTokens: 1 }),
    );
    expect(tracker.totals("nope")).toEqual(emptyUsage());
    tracker.reset("t1");
    expect(tracker.totals("t1")).toEqual(emptyUsage());
    expect(tracker.bySession().size).toBe(0);
  });

  it("keeps cost absent when no observed segment was priced", () => {
    const tracker = createUsageTracker();
    tracker.handler(
      event({ type: "model-usage", sessionId: "t1", state: "a", inputTokens: 5, outputTokens: 1 }),
    );
    expect(tracker.totals("t1").costUsd).toBeUndefined();
    expect(tracker.totals().costUsd).toBeUndefined();
  });
});

describe("addSummaries", () => {
  it("sums tokens and cost, and only reports cost when a side had it", () => {
    const base = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1 };
    expect(addSummaries(base, base).costUsd).toBeUndefined();
    expect(addSummaries({ ...base, costUsd: 0.001 }, base).costUsd).toBe(0.001);
    expect(addSummaries({ ...base, costUsd: 0.001 }, { ...base, costUsd: 0.002 })).toEqual({
      inputTokens: 2,
      outputTokens: 2,
      cacheReadTokens: 2,
      cacheCreationTokens: 2,
      costUsd: 0.003,
    });
  });
});
