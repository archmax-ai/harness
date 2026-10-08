/**
 * What Deep Agents adds to a model request on its own, keyed by the model's
 * client and id, beside everything the harness composes: a harness profile's
 * prompt suffix, and its own prompt-cache middleware for Anthropic and Bedrock
 * Converse clients. Pinned here so an upstream change, or the harness taking
 * either over, shows up as a changed test.
 */
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { createMiddleware, initChatModel, type AgentMiddleware } from "langchain";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent, createMemorySessionStore } from "../index.js";
import { cleanupWorkspaces, ScriptedModel, workspaceWith } from "./support.js";

afterEach(cleanupWorkspaces);

const SPEC = {
  runtime: { engine: "archmax-harness", version: "2" },
  states: { start: { triggers: { manual: null } } },
};

/** The system prompt of a governed agent's first model call on `model`; the call itself is never made. */
async function firstSystemPrompt(model: BaseChatModel): Promise<string> {
  const prompts: string[] = [];
  const capture = createMiddleware({
    name: "CaptureSystemPrompt",
    wrapModelCall: async (request) => {
      prompts.push(request.systemMessage.text);
      return new AIMessage("done");
    },
  }) as unknown as AgentMiddleware;
  const agent = await createAgent({
    workflow: "w",
    model,
    middleware: [capture],
    onEvent: () => {},
    workspace: { rootDir: workspaceWith(SPEC), sessionStore: createMemorySessionStore() },
  });
  await agent.invoke({ messages: [{ role: "user", content: "hi" }] } as never, {
    configurable: { thread_id: "profile" },
  });
  expect(prompts).toHaveLength(1);
  return prompts[0]!;
}

describe("Deep Agents' harness profile suffix", () => {
  // Deep Agents appends a model's harness-profile suffix after the system prompt
  // even with `base: null`, and `createDeepAgent` takes no per-agent opt-out: a
  // Codex model is told to bias to action and not to end its turn with a
  // question, against every human state. The profile is found for a LangChain
  // `ConfigurableModel` (`initChatModel`), which carries its id where Deep Agents
  // looks. Fails until the harness keeps the suffix out of the static prompt
  // itself: Deep Agents has no per-agent profile to pass.
  it.fails("does not reach a governed agent on a Codex model", async () => {
    const model = await initChatModel("gpt-5.2-codex", {
      modelProvider: "openai",
      apiKey: "sk-test",
    });
    expect(await firstSystemPrompt(model as unknown as BaseChatModel)).not.toContain(
      "Codex-Specific Behavior",
    );
  });

  // Why the default model is not affected today: Deep Agents reads an instance's
  // id from `model_name` or `modelName`, and `ChatOpenAI` sets only `model`, so
  // the lookup finds no profile. Should Deep Agents start reading `model`, this
  // fails, and the suffix above reaches the env-configured model too.
  it("is out of Deep Agents' reach on a ChatOpenAI instance, which it reads no id from", async () => {
    const model = new ChatOpenAI({ model: "gpt-5.2-codex", apiKey: "sk-test" });
    expect(await firstSystemPrompt(model)).not.toContain("Codex-Specific Behavior");
  });

  // The Codex profile also adds `todoListMiddleware` to the tail of the stack,
  // and Deep Agents merges the harness's same-named one into that position: it
  // then runs inside the workflow instrumentation, and its guidance lands after
  // the volatile block. Fails until the harness places its todo middleware where
  // the merge cannot move it.
  it.fails("keeps the write_todos guidance in the static block on a Codex model", async () => {
    class CodexModel extends ScriptedModel {
      static lc_name(): string {
        return "ConfigurableModel";
      }
      readonly _defaultConfig = { modelProvider: "openai", model: "gpt-5.2-codex" };
    }
    const model = new CodexModel([{ reply: "done" }]);
    const agent = await createAgent({
      workflow: "w",
      model: model as never,
      onEvent: () => {},
      workspace: { rootDir: workspaceWith(SPEC), sessionStore: createMemorySessionStore() },
    });
    await agent.invoke({ messages: [{ role: "user", content: "hi" }] } as never, {
      configurable: { thread_id: "codex-todos" },
    });

    const system = model.calls[0]?.parts.find((message) => message.type === "system")?.parts ?? [];
    expect(system).toHaveLength(2);
    expect(String(system[0]?.text)).toContain("## `write_todos`");
  });
});

/** A scripted model Deep Agents and LangChain identify as `client` serving `model`, recording each binding's settings. */
function providerModel(client: string, model: string) {
  class ProviderModel extends ScriptedModel {
    static lc_name(): string {
      return client;
    }
    readonly settings: Array<Record<string, unknown>> = [];
    bindTools(tools: unknown[], kwargs?: Record<string, unknown>) {
      this.settings.push({ ...kwargs });
      return super.bindTools(tools);
    }
  }
  return new ProviderModel([{ reply: "done" }], { model });
}

/**
 * One governed turn on `client` serving `model`: the `cache_control` of each
 * system block (`[static, volatile]`) and the `cache_control` model setting of
 * its one model call.
 */
async function oneCall(
  client: string,
  model: string,
  promptCache: { enabled: boolean; ttl?: "5m" | "1h" },
) {
  const provider = providerModel(client, model);
  const agent = await createAgent({
    workflow: "w",
    model: provider as never,
    promptCache,
    onEvent: () => {},
    workspace: { rootDir: workspaceWith(SPEC), sessionStore: createMemorySessionStore() },
  });
  await agent.invoke({ messages: [{ role: "user", content: "hi" }] } as never, {
    configurable: { thread_id: "cache" },
  });
  const system = provider.calls[0]?.parts.find((message) => message.type === "system")?.parts ?? [];
  return {
    blocks: system.map((block) => block.cache_control ?? null),
    setting: provider.settings.at(-1)?.cache_control ?? null,
  };
}

// Deep Agents adds LangChain's caching middleware for these two clients, and for
// `ChatAnthropic` its own breakpoint on the last system block, whatever
// `promptCache` says. The harness's own copy of LangChain's middleware has the
// same name, so with caching on it replaces Deep Agents' (its TTL holds); with
// caching off nothing replaces it. What 0.5.0 does about it is open.
describe("Deep Agents' own prompt caching", () => {
  const ANTHROPIC = ["ChatAnthropic", "claude-sonnet-4-5"] as const;
  const BEDROCK = ["ChatBedrockConverse", "anthropic.claude-sonnet-4-5-20250929-v1:0"] as const;

  it("marks a ChatAnthropic agent's volatile block, not its static one", async () => {
    expect(await oneCall(...ANTHROPIC, { enabled: true, ttl: "1h" })).toEqual({
      blocks: [null, { type: "ephemeral" }],
      setting: { type: "ephemeral", ttl: "1h" },
    });
  });

  it("caches a ChatAnthropic agent with caching turned off", async () => {
    expect(await oneCall(...ANTHROPIC, { enabled: false })).toEqual({
      blocks: [null, { type: "ephemeral" }],
      setting: { type: "ephemeral", ttl: "5m" },
    });
  });

  // `ChatBedrockConverse` turns the setting into a `cachePoint` after the last
  // system block (the volatile one), after the last message and after the tools.
  it("leaves a ChatBedrockConverse agent's blocks unmarked and caches by setting", async () => {
    expect(await oneCall(...BEDROCK, { enabled: true, ttl: "1h" })).toEqual({
      blocks: [null, null],
      setting: { type: "ephemeral", ttl: "1h" },
    });
  });

  it("caches a ChatBedrockConverse agent with caching turned off", async () => {
    expect(await oneCall(...BEDROCK, { enabled: false })).toEqual({
      blocks: [null, null],
      setting: { type: "ephemeral", ttl: "5m" },
    });
  });
});
