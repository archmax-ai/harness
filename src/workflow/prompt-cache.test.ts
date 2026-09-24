import { describe, expect, it } from "vitest";
import {
  cacheControl,
  createProviderCacheMiddleware,
  DEFAULT_CACHE_TTL,
  isCacheTtl,
  modelIdOf,
  resolveCacheStrategy,
  resolvePromptCacheConfig,
  unsupportedCacheMessage,
} from "./prompt-cache.js";

/** A model stand-in identified the way LangChain identifies chat clients. */
function fakeModel(name: string, model?: string, defaults?: Record<string, unknown>) {
  return {
    getName: () => name,
    ...(model ? { model } : {}),
    ...(defaults ? { _defaultConfig: defaults } : {}),
  };
}

describe("resolveCacheStrategy", () => {
  it("routes a native Anthropic client to LangChain's provider middleware", () => {
    expect(resolveCacheStrategy(fakeModel("ChatAnthropic", "claude-sonnet-4-5"), true)).toBe(
      "anthropic-native",
    );
    expect(
      resolveCacheStrategy(
        fakeModel("ConfigurableModel", undefined, { modelProvider: "anthropic" }),
        true,
      ),
    ).toBe("anthropic-native");
  });

  it("routes Bedrock Converse Claude/Nova to the Bedrock middleware", () => {
    expect(
      resolveCacheStrategy(
        fakeModel("ChatBedrockConverse", "anthropic.claude-haiku-4-5-20251001-v1:0"),
        true,
      ),
    ).toBe("bedrock-native");
    expect(resolveCacheStrategy(fakeModel("ChatBedrockConverse", "amazon.nova-pro-v1:0"), true)).toBe(
      "bedrock-native",
    );
  });

  it("reports an uncacheable Bedrock model family as unsupported", () => {
    expect(resolveCacheStrategy(fakeModel("ChatBedrockConverse", "meta.llama3-70b"), true)).toBe(
      "unsupported",
    );
  });

  it("marks Claude over an OpenAI-compatible endpoint explicitly (no LangChain built-in)", () => {
    expect(
      resolveCacheStrategy(fakeModel("ChatOpenAI", "anthropic/claude-sonnet-4.6"), true),
    ).toBe("anthropic-compat");
  });

  it("is a no-op for other providers and when disabled", () => {
    expect(resolveCacheStrategy(fakeModel("ChatOpenAI", "gpt-5"), true)).toBe("unsupported");
    expect(resolveCacheStrategy(fakeModel("ChatAnthropic", "claude"), false)).toBe("off");
    expect(resolveCacheStrategy(undefined, true)).toBe("off");
  });

  it("reads the model id from whichever field the client exposes", () => {
    expect(modelIdOf(fakeModel("ChatOpenAI", "gpt-5"))).toBe("gpt-5");
    expect(modelIdOf({ modelName: "claude-3" })).toBe("claude-3");
    expect(modelIdOf({ _defaultConfig: { model: "claude-4" } })).toBe("claude-4");
    expect(modelIdOf({})).toBe("");
  });
});

describe("createProviderCacheMiddleware", () => {
  it("supplies LangChain's middleware for the native strategies", () => {
    expect(createProviderCacheMiddleware("anthropic-native", "5m")?.name).toBe(
      "PromptCachingMiddleware",
    );
    expect(createProviderCacheMiddleware("bedrock-native", "1h")?.name).toBe(
      "BedrockPromptCachingMiddleware",
    );
  });

  it("supplies none where the harness marks blocks itself or caching is inactive", () => {
    expect(createProviderCacheMiddleware("anthropic-compat", "5m")).toBeNull();
    expect(createProviderCacheMiddleware("off", "5m")).toBeNull();
    expect(createProviderCacheMiddleware("unsupported", "5m")).toBeNull();
  });
});

describe("resolvePromptCacheConfig", () => {
  it("is enabled with the short lifetime by default", () => {
    expect(resolvePromptCacheConfig({})).toEqual({ enabled: true, ttl: DEFAULT_CACHE_TTL });
  });

  it("prefers the host option, then the spec, then the environment", () => {
    expect(
      resolvePromptCacheConfig({
        option: { enabled: false },
        spec: { enabled: true },
        env: { enabled: true },
      }).enabled,
    ).toBe(false);
    expect(resolvePromptCacheConfig({ spec: { enabled: false }, env: { enabled: true } }).enabled).toBe(
      false,
    );
    expect(resolvePromptCacheConfig({ env: { enabled: false } }).enabled).toBe(false);
    expect(resolvePromptCacheConfig({ option: { ttl: "1h" }, spec: { ttl: "5m" } }).ttl).toBe("1h");
  });

  it("falls back to the default lifetime rather than failing on a bad value", () => {
    expect(resolvePromptCacheConfig({ option: { ttl: "3 weeks" } }).ttl).toBe(DEFAULT_CACHE_TTL);
    expect(isCacheTtl("3 weeks")).toBe(false);
    expect(isCacheTtl("1h")).toBe(true);
  });

});

describe("cache markers and diagnostics", () => {
  it("builds an ephemeral marker with the requested lifetime", () => {
    expect(cacheControl("1h")).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("names the model in the unsupported-model diagnostic", () => {
    expect(unsupportedCacheMessage(fakeModel("ChatOpenAI", "gpt-5"))).toContain("gpt-5");
  });
});
