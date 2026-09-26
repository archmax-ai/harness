/**
 * Provider prompt caching for the stable prompt prefix (tool schemas and the
 * static system prompt, re-sent on every model call of a turn).
 *
 * LangChain owns the provider mechanics where it has them: a native
 * `ChatAnthropic` or `ChatBedrockConverse` gets LangChain's own caching
 * middleware. The one case with no built-in is the default — Claude reached
 * through an OpenAI-compatible endpoint — where the workflow middleware places
 * an explicit `cache_control` breakpoint on the static system block. Anything
 * else is a no-op (OpenAI and Gemini cache prefixes automatically).
 */

import {
  anthropicPromptCachingMiddleware,
  bedrockPromptCachingMiddleware,
  type AgentMiddleware,
} from "langchain";

export const CACHE_TTLS = ["5m", "1h"] as const;
export type CacheTtl = (typeof CACHE_TTLS)[number];

export const DEFAULT_CACHE_TTL: CacheTtl = "5m";

export function isCacheTtl(value: unknown): value is CacheTtl {
  return typeof value === "string" && (CACHE_TTLS as readonly string[]).includes(value);
}

/**
 * How caching is applied: `anthropic-native` / `bedrock-native` via LangChain's
 * middlewares; `anthropic-compat` via an explicit marker on the static system
 * block; `unsupported` when requested for a model with no known mechanism; `off`.
 */
export type PromptCacheStrategy =
  | "anthropic-native"
  | "bedrock-native"
  | "anthropic-compat"
  | "off"
  | "unsupported";

/**
 * The strategies LangChain implements as graph-level provider middleware. They
 * cannot vary per model call, which is why a state whose model wants a different
 * one is reported at assembly rather than silently mis-cached.
 */
export const NATIVE_CACHE_STRATEGIES: ReadonlySet<PromptCacheStrategy> = new Set([
  "anthropic-native",
  "bedrock-native",
]);

export interface PromptCacheConfig {
  enabled: boolean;
  ttl: CacheTtl;
}

export interface PromptCacheOptions {
  enabled?: boolean;
  ttl?: string;
}

/** A `cache_control` marker as Anthropic and its gateways accept it. */
export interface CacheControlMarker {
  type: "ephemeral";
  ttl: CacheTtl;
}

export function cacheControl(ttl: CacheTtl): CacheControlMarker {
  return { type: "ephemeral", ttl };
}

function modelName(model: unknown): string {
  const named = model as { getName?: () => string };
  try {
    return typeof named?.getName === "function" ? named.getName() : "";
  } catch {
    return "";
  }
}

/** The provider's model id, however the client exposes it. */
export function modelIdOf(model: unknown): string {
  const candidate = model as {
    model?: unknown;
    modelName?: unknown;
    _defaultConfig?: { model?: unknown };
  };
  for (const value of [candidate?.model, candidate?.modelName, candidate?._defaultConfig?.model]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

const ANTHROPIC_MODEL_ID = /claude|anthropic/i;
/** Bedrock caches only these model families (mirrors LangChain's own check). */
const BEDROCK_CACHEABLE_ID = /anthropic\.claude|amazon\.nova/i;

/**
 * Pick the mechanism for `model`, with the same client/provider tests LangChain's
 * middlewares apply, so a `*-native` strategy is exactly one that middleware acts on.
 */
export function resolveCacheStrategy(model: unknown, enabled: boolean): PromptCacheStrategy {
  if (!enabled || !model) return "off";
  const name = modelName(model);
  const provider = (model as { _defaultConfig?: { modelProvider?: unknown } })?._defaultConfig
    ?.modelProvider;
  const id = modelIdOf(model);

  if (name === "ChatAnthropic" || (name === "ConfigurableModel" && provider === "anthropic")) {
    return "anthropic-native";
  }
  const isBedrock =
    name === "ChatBedrockConverse" ||
    (name === "ConfigurableModel" && (provider === "bedrock" || provider === "aws"));
  if (isBedrock) return BEDROCK_CACHEABLE_ID.test(id) ? "bedrock-native" : "unsupported";

  if (ANTHROPIC_MODEL_ID.test(id) || ANTHROPIC_MODEL_ID.test(name)) return "anthropic-compat";
  return "unsupported";
}

/**
 * The LangChain provider middleware for `strategy`, or `null` when none is
 * needed. `minMessagesToCache: 1` because the prefix is large from the first
 * call; `unsupportedModelBehavior: "ignore"` because the strategy was already
 * reported through `onEvent`.
 */
export function createProviderCacheMiddleware(
  strategy: PromptCacheStrategy,
  ttl: CacheTtl,
): AgentMiddleware | null {
  const options = { ttl, minMessagesToCache: 1, unsupportedModelBehavior: "ignore" } as const;
  if (strategy === "anthropic-native") {
    return anthropicPromptCachingMiddleware(options) as unknown as AgentMiddleware;
  }
  if (strategy === "bedrock-native") {
    return bedrockPromptCachingMiddleware(options) as unknown as AgentMiddleware;
  }
  return null;
}

/** Precedence host option → workflow spec → env → default (on, 5m). A bad `ttl` falls back rather than failing a run. */
export function resolvePromptCacheConfig(sources: {
  option?: PromptCacheOptions | undefined;
  spec?: { enabled?: boolean; ttl?: string } | undefined;
  env?: { enabled?: boolean; ttl?: string } | undefined;
}): PromptCacheConfig {
  const { option, spec, env } = sources;
  const enabled = option?.enabled ?? spec?.enabled ?? env?.enabled ?? true;
  const ttlCandidate = option?.ttl ?? spec?.ttl ?? env?.ttl;
  return { enabled, ttl: isCacheTtl(ttlCandidate) ? ttlCandidate : DEFAULT_CACHE_TTL };
}
