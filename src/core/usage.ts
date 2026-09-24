/**
 * Token accounting: what a session cost, in tokens and (when priced) in money.
 *
 * Providers report usage on each AI message as LangChain `usage_metadata`. This
 * module is the single place that reads those shapes (including the cached-prefix
 * detail that makes prompt caching observable), sums them, and turns them into a
 * cost using a caller-supplied price table. Cost is **omitted, never guessed**:
 * an unpriced model reports tokens only, so a number on screen is always a
 * number someone configured.
 */

import type { WorkflowEventHandler } from "./events.js";

/** Tokens consumed by one model call, one turn, or a whole session. */
export interface TokenUsage {
  /** Total input tokens; the two cache counts below are a breakdown of it, not a peer. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache (billed at a discount). */
  cacheReadTokens: number;
  /** Input tokens written to the provider's prompt cache (billed at a premium). */
  cacheCreationTokens: number;
}

/** A run's usage plus its cost when the model is priced. */
export interface UsageSummary extends TokenUsage {
  costUsd?: number;
}

/** Prices in USD per 1,000,000 tokens. Omitted rates contribute nothing. */
export interface ModelPricing {
  input?: number;
  output?: number;
  /** Cache-read rate (Anthropic bills ~10% of input). */
  cacheRead?: number;
  /** Cache-write rate (Anthropic bills ~125% of input). */
  cacheWrite?: number;
}

/**
 * Price table keyed by model id. Lookup is: exact id, then the longest key that
 * is a substring of the id (so `claude-sonnet` prices
 * `anthropic/claude-sonnet-4.6`), then the `default` key.
 */
export type PricingTable = Record<string, ModelPricing>;

/** The key used when a price applies to whatever model is configured. */
export const DEFAULT_PRICING_KEY = "default";

/** A zeroed usage record. */
export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

/** Sum two usage records into a new one. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

/** Whether any counter is non-zero. */
export function hasUsage(usage: TokenUsage): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.cacheCreationTokens > 0
  );
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The provider shapes this reads, in order of preference:
 *  - LangChain normalized: `usage_metadata.input_token_details.{cache_read,cache_creation}`
 *  - OpenAI-compatible raw: `response_metadata.usage.prompt_tokens_details.cached_tokens`
 *  - Anthropic raw: `…usage.{cache_read_input_tokens,cache_creation_input_tokens}`
 *
 * `inputTokens` is the **total** input count, of which `cacheReadTokens` and
 * `cacheCreationTokens` are a breakdown — LangChain's own `usage_metadata`
 * contract (`input_tokens` is the "sum of all input token types"), and what the
 * OpenAI-compatible raw shape reports too (`prompt_tokens` includes
 * `prompt_tokens_details.cached_tokens`). Anthropic's raw shape is the one
 * exception: its `usage.input_tokens` counts only what was neither read from nor
 * written to cache, so the cache counts are folded back in. One invariant then
 * holds downstream whatever the provider sent, which is what lets
 * {@link computeCostUsd} price without a per-provider branch.
 */
export function extractUsage(message: unknown): { usage: TokenUsage; model?: string } | null {
  if (typeof message !== "object" || message === null) return null;
  const meta = (message as { usage_metadata?: Record<string, unknown> }).usage_metadata;
  const response = (message as { response_metadata?: Record<string, unknown> }).response_metadata;
  const raw = (response?.usage ?? response?.token_usage) as Record<string, unknown> | undefined;
  if (!meta && !raw) return null;

  const details = (meta?.input_token_details ?? {}) as Record<string, unknown>;
  const promptDetails = (raw?.prompt_tokens_details ?? {}) as Record<string, unknown>;

  const cacheReadTokens =
    num(details.cache_read) ||
    num(promptDetails.cached_tokens) ||
    num(raw?.cache_read_input_tokens);
  const cacheCreationTokens = num(details.cache_creation) || num(raw?.cache_creation_input_tokens);

  // Which shape reported the input count decides whether the cache counts are
  // already inside it. Read from the keys rather than from a zero, so a prompt
  // served entirely from cache is classified the same way as any other.
  const reportsNumber = (record: Record<string, unknown> | undefined, key: string): boolean =>
    typeof record?.[key] === "number";
  const isAnthropicRaw =
    !reportsNumber(meta, "input_tokens") &&
    !reportsNumber(raw, "prompt_tokens") &&
    reportsNumber(raw, "input_tokens");

  const reportedInput =
    num(meta?.input_tokens) || num(raw?.prompt_tokens) || num(raw?.input_tokens);

  const usage: TokenUsage = {
    inputTokens: isAnthropicRaw
      ? reportedInput + cacheReadTokens + cacheCreationTokens
      : reportedInput,
    outputTokens: num(meta?.output_tokens) || num(raw?.completion_tokens) || num(raw?.output_tokens),
    cacheReadTokens,
    cacheCreationTokens,
  };

  const model =
    typeof response?.model_name === "string"
      ? response.model_name
      : typeof response?.model === "string"
        ? response.model
        : undefined;

  return { usage, ...(model ? { model } : {}) };
}

/**
 * Resolve the price entry for `model`: exact id, then the longest substring key,
 * then `default`. Returns `undefined` when nothing matches — the caller must
 * then omit cost rather than assume free.
 */
export function resolveModelPricing(
  table: PricingTable | undefined,
  model: string | undefined,
): ModelPricing | undefined {
  if (!table) return undefined;
  if (model) {
    if (table[model]) return table[model];
    const keys = Object.keys(table)
      .filter((key) => key !== DEFAULT_PRICING_KEY && model.includes(key))
      .sort((a, b) => b.length - a.length);
    if (keys.length > 0) return table[keys[0]];
  }
  return table[DEFAULT_PRICING_KEY];
}

const PER_MILLION = 1_000_000;

/**
 * Cost in USD for `usage` under `pricing`, or `undefined` when no rate applies.
 *
 * The cache counts are a breakdown of `inputTokens`, not a peer of it (see
 * {@link extractUsage}), so the input rate applies to the **remainder** — what
 * was neither served from nor written to cache — and each cache rate to its own
 * count. Charging the whole input count *and* the cache counts on top would bill
 * a cached token twice, which on a warm prompt-caching workload is most of the
 * bill. A missing cache rate falls back to the input rate for reads and writes,
 * since every provider prices cached tokens relative to input.
 */
export function computeCostUsd(
  usage: TokenUsage,
  pricing: ModelPricing | undefined,
): number | undefined {
  if (!pricing) return undefined;
  const { input, output, cacheRead, cacheWrite } = pricing;
  if (input === undefined && output === undefined) return undefined;
  // Clamped: a provider's breakdown is not obliged to fit inside its own total,
  // and a negative remainder would credit cost back rather than fail loudly.
  const fullRateInput = Math.max(
    0,
    usage.inputTokens - usage.cacheReadTokens - usage.cacheCreationTokens,
  );
  const cost =
    (num(input) * fullRateInput +
      num(output) * usage.outputTokens +
      num(cacheRead ?? input) * usage.cacheReadTokens +
      num(cacheWrite ?? input) * usage.cacheCreationTokens) /
    PER_MILLION;
  // Sub-cent runs are common; keep six decimals so a cost is never rounded to 0.
  return Math.round(cost * 1e6) / 1e6;
}

/** Build a summary: usage plus cost when the model is priced. */
export function summarizeUsage(
  usage: TokenUsage,
  table: PricingTable | undefined,
  model: string | undefined,
): UsageSummary {
  const costUsd = computeCostUsd(usage, resolveModelPricing(table, model));
  return { ...usage, ...(costUsd !== undefined ? { costUsd } : {}) };
}

/**
 * Sum two summaries, tokens and cost together. Cost is present only when at
 * least one side has it — summing an unpriced summary must not invent a `0`.
 * This is the single place summaries are combined (the tracker's cross-session
 * totals and the CLI's per-test-case totals both use it).
 */
export function addSummaries(a: UsageSummary, b: UsageSummary): UsageSummary {
  const costUsd =
    a.costUsd !== undefined || b.costUsd !== undefined
      ? Math.round(((a.costUsd ?? 0) + (b.costUsd ?? 0)) * 1e6) / 1e6
      : undefined;
  return { ...addUsage(a, b), ...(costUsd !== undefined ? { costUsd } : {}) };
}

/** Human-readable one-liner, e.g. `in 12,004 · out 318 · cache r 9,801/w 0 · $0.0421`. */
export function formatUsage(summary: UsageSummary): string {
  const n = (value: number): string => value.toLocaleString("en-US");
  const parts = [
    `in ${n(summary.inputTokens)}`,
    `out ${n(summary.outputTokens)}`,
    `cache r ${n(summary.cacheReadTokens)}/w ${n(summary.cacheCreationTokens)}`,
  ];
  if (summary.costUsd !== undefined) {
    parts.push(`$${summary.costUsd < 0.01 ? summary.costUsd.toFixed(6) : summary.costUsd.toFixed(4)}`);
  }
  return parts.join(" · ");
}

/**
 * `createUsageTracker()` — the supported way to read what a session cost.
 *
 * Usage arrives as one `model-usage` event per model call. A host could sum
 * those by hand; this tracker exists so nobody has to, and so per-session
 * demultiplexing (concurrent runs on one assembled agent) is done once, from the
 * event envelope's `sessionId`.
 *
 * For the consumer holding `invoke`, there is deliberately nothing to wait for:
 * `invoke` returning *is* the end of the turn, and that is where `totals()` is
 * read. The runtime keeps one of these internally so a session's usage can be
 * written into its artifacts.
 *
 * A consumer that only sees the **event stream** has no `invoke` to observe, and
 * for a durable session "`invoke` returned" means the turn ended, not the run — a
 * parked session returns with the run very much alive. Those consumers get the
 * `run-metrics` event instead, which reports the session's cumulative ledger
 * (usage included) whenever a turn settles. See `core/metrics.ts`.
 *
 * ```ts
 * const usage = createUsageTracker();
 * const runtime = await createAgent({ onEvent: usage.handler });
 * await runtime.graph.invoke(input, { configurable: { thread_id: "t1" } });
 * usage.totals("t1"); // { inputTokens, cacheReadTokens, …, costUsd? }
 * ```
 *
 * To keep your own subscriber, pass it in: `createUsageTracker({ onEvent: mine })`.
 */

/** Key used for events that arrive without a bound session id. */
const UNSCOPED = "__unscoped__";

export interface UsageTracker {
  /**
   * Event handler to pass as the runtime `onEvent` (it forwards to the
   * `onEvent` given at construction, when any).
   */
  handler: WorkflowEventHandler;
  /** Totals for one session, or across every observed session when omitted. */
  totals(sessionId?: string): UsageSummary;
  /** Per-session totals, keyed by session id. */
  bySession(): Map<string, UsageSummary>;
  /** Drop accumulated totals for one session, or for all of them. */
  reset(sessionId?: string): void;
}

/** Create a tracker that accumulates usage and cost from the event stream. */
export function createUsageTracker(options: { onEvent?: WorkflowEventHandler } = {}): UsageTracker {
  const sessions = new Map<string, UsageSummary>();

  return {
    handler: (event) => {
      if (event.type === "model-usage") {
        const key = event.sessionId ?? UNSCOPED;
        sessions.set(
          key,
          addSummaries(sessions.get(key) ?? emptyUsage(), {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cacheReadTokens: event.cacheReadTokens ?? 0,
            cacheCreationTokens: event.cacheCreationTokens ?? 0,
            ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
          }),
        );
      }
      options.onEvent?.(event);
    },
    totals: (sessionId) =>
      sessionId !== undefined
        ? (sessions.get(sessionId) ?? emptyUsage())
        : [...sessions.values()].reduce(addSummaries, emptyUsage()),
    bySession: () => new Map(sessions),
    reset: (sessionId) => {
      if (sessionId === undefined) sessions.clear();
      else sessions.delete(sessionId);
    },
  };
}
