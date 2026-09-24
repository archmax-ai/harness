import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI, ChatOpenAICompletions } from "@langchain/openai";
import dotenv from "dotenv";
import { DEFAULT_PRICING_KEY, type ModelPricing, type PricingTable } from "./core/usage.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Package install root — the directory containing this file's parent (`dist/`
 * when published/built, `src/` in development). Used only to locate assets
 * bundled with the package, never the consumer's workspace or configuration.
 */
export const PACKAGE_ROOT = resolve(here, "..");

/** Installed package implementation version, read from the package's `package.json`. */
export const PACKAGE_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** Return the first existing directory among the candidates, else the first. */
function firstExistingDir(candidates: string[]): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

/**
 * The authoring skill bundled with the package — the parent directory holding
 * `archmax-harness/` (`SKILL.md` + `references/*.md`), which teaches a coding agent how
 * to author a workspace. Resolved to `dist/authoring-skill` when built or
 * installed, with a repo-checkout fallback to the top-level `skills/` when
 * running from `src/`. Consumers mount it directly so the skill always matches
 * the installed SDK version instead of a synced copy.
 */
export const BUNDLED_AUTHORING_SKILL_DIR = firstExistingDir([
  resolve(here, "authoring-skill"),
  resolve(here, "..", "skills"),
]);

/** Resolve the agent workspace root: an explicit path, else the consumer's cwd. */
export function resolveWorkspaceRoot(rootDir?: string): string {
  return rootDir ? resolve(rootDir) : process.cwd();
}

let lastEnvFileLoaded: string | null = null;

/**
 * Variables whose current value came from a `.env` file rather than from the
 * real process environment. Only these may be replaced by a later `.env`.
 */
const fromEnvFile = new Set<string>();

/**
 * Load `.env` from the resolved workspace root (or cwd) if present.
 *
 * Two rules, in this order: the real process environment always wins, and a
 * later `.env` wins over an earlier one. The second is why this does not just
 * call `dotenv.config` — dotenv never overrides an already-set variable, and it
 * cannot tell its own earlier assignment from a real environment variable. The
 * import-time cwd load below is an earlier one, so without the distinction a
 * stray `.env` in whatever directory the process happened to start in would
 * silently outrank the workspace root that owns the configuration (issue #23).
 */
export function loadDotenv(rootDir?: string): void {
  const envFile = resolve(resolveWorkspaceRoot(rootDir), ".env");
  if (envFile === lastEnvFileLoaded) return;
  if (!existsSync(envFile)) return;
  // Parsed rather than applied by dotenv, so assignment follows the rules above.
  // Parsing also emits nothing on stdout, which the CLI reserves for its answer.
  let parsed: Record<string, string>;
  try {
    parsed = dotenv.parse(readFileSync(envFile));
  } catch {
    return;
  }
  for (const [name, value] of Object.entries(parsed)) {
    if (process.env[name] !== undefined && !fromEnvFile.has(name)) continue;
    process.env[name] = value;
    fromEnvFile.add(name);
  }
  lastEnvFileLoaded = envFile;
}

// Eagerly load `.env` from the consumer's working directory for the common case.
// A workspace-root load later in startup overrides whatever this set.
loadDotenv();

/** Resolve a config key from its canonical `ARCHMAX_*` environment name. */
function envValue(suffix: string): { name: string; raw: string | undefined } {
  const name = `ARCHMAX_${suffix}`;
  return { name, raw: process.env[name] };
}

function required(suffix: string): string {
  const { name, raw } = envValue(suffix);
  if (!raw || raw.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return raw.trim();
}

function optionalNumber(suffix: string): number | undefined {
  const { name, raw } = envValue(suffix);
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got: ${raw}`);
  }
  return parsed;
}

export interface AgentEnv {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Whether the model streams responses (default true). Streaming is what
   * makes `agent-text-delta` lifecycle events flow; invoke results are
   * unchanged. Set `ARCHMAX_STREAMING=0` for OpenAI-compatible endpoints that
   * misbehave under SSE.
   */
  streaming?: boolean;
}

function optionalBoolean(suffix: string): boolean | undefined {
  const { name, raw } = envValue(suffix);
  if (raw === undefined || raw.trim() === "") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Environment variable ${name} must be a boolean, got: ${raw}`);
}

/** Read the OpenAI-compatible model configuration from the `ARCHMAX_*` environment keys. */
export function loadEnv(): AgentEnv {
  return {
    apiBaseUrl: required("API_BASE_URL"),
    apiKey: required("API_KEY"),
    model: required("MODEL"),
    temperature: optionalNumber("TEMPERATURE"),
    maxTokens: optionalNumber("MAX_TOKENS"),
    streaming: optionalBoolean("STREAMING"),
  };
}

/**
 * Pin an unnamed response role to `assistant` on both of the provider's
 * message-conversion seams.
 *
 * An OpenAI-compatible endpoint is not required to name the role in what it
 * sends back, and many do not: proxies (LiteLLM and friends) drop or null it,
 * and providers legitimately send it only on the first streaming delta.
 * `@langchain/openai` maps a response with no role to a *generic* `ChatMessage`
 * / `ChatMessageChunk` instead of an `AIMessage` — and a generic **first**
 * chunk poisons the whole reply, because every later `AIMessageChunk` merges
 * into the receiver's class. The agent loop then gets a message that is not the
 * assistant's turn: tool calls are invisible to it, and the framework refuses
 * the model result outright (see `asModelCallResult` in `core/framework.ts`,
 * which repairs what still reaches it — e.g. from a model a library user
 * supplies rather than this factory).
 *
 * What comes back from a chat completion *is* the assistant's turn, so a
 * response that names no role is read as one.
 */
function withAssistantRoleDefault(completions: ChatOpenAICompletions): ChatOpenAICompletions {
  // Both converters are `protected` on the provider class, so they are replaced
  // through an index signature rather than a subclass override — that keeps this
  // module free of the provider SDK's request/response types. Each is patched
  // only if present: a provider release that drops the seam (both are marked
  // deprecated upstream) leaves the model untouched rather than failing here,
  // and the framework-level repair still covers it.
  const seam = completions as unknown as Record<string, unknown>;

  const deltaConverter = seam._convertCompletionsDeltaToBaseMessageChunk;
  if (typeof deltaConverter === "function") {
    const original = deltaConverter as (...args: unknown[]) => unknown;
    seam._convertCompletionsDeltaToBaseMessageChunk = (
      delta: Record<string, unknown>,
      rawResponse: unknown,
      defaultRole?: string,
    ): unknown => {
      // `role` on a delta is sticky: the provider sends it once and the caller
      // carries it forward as `defaultRole`. A role the provider did name as one
      // of the protocol's own keeps deciding the class, so this changes nothing
      // for a conforming endpoint.
      const role = responseRole(stringRole(delta)) ?? defaultRole ?? "assistant";
      return original.call(completions, { ...delta, role }, rawResponse, role);
    };
  }

  const messageConverter = seam._convertCompletionsMessageToBaseMessage;
  if (typeof messageConverter === "function") {
    const original = messageConverter as (...args: unknown[]) => unknown;
    seam._convertCompletionsMessageToBaseMessage = (
      message: Record<string, unknown>,
      rawResponse: unknown,
    ): unknown => {
      const role = responseRole(stringRole(message)) ?? "assistant";
      return original.call(completions, { ...message, role }, rawResponse);
    };
  }

  return completions;
}

/** The `role` a provider named on a delta/message, if it named a non-empty one. */
function stringRole(payload: Record<string, unknown> | null | undefined): string | undefined {
  const role = payload?.role;
  return typeof role === "string" && role !== "" ? role : undefined;
}

/**
 * The roles the chat-completions protocol defines for a turn that is *not* the
 * assistant's. A response naming one of these is left as it is — the endpoint
 * meant it, and the provider integration maps it faithfully.
 */
const NON_ASSISTANT_ROLES = new Set(["user", "system", "developer", "tool", "function"]);

/**
 * Which role a *response* should be read as. Anything the protocol does not
 * define for another turn is the assistant's — including a role borrowed from a
 * different API's vocabulary (`model`), which is what a proxy fronting a
 * non-OpenAI provider tends to pass through.
 */
function responseRole(named: string | undefined): string | undefined {
  if (named === undefined) return undefined;
  return NON_ASSISTANT_ROLES.has(named) ? named : "assistant";
}

/** Build a `ChatOpenAI` model pointed at any OpenAI-compatible endpoint. */
export function createChatModel(env: AgentEnv = loadEnv()): ChatOpenAI {
  const fields = {
    model: env.model,
    apiKey: env.apiKey,
    temperature: env.temperature,
    maxTokens: env.maxTokens,
    // Streaming feeds `agent-text-delta` events; `invoke` results are the
    // same either way. `ARCHMAX_STREAMING=0` opts out.
    streaming: env.streaming ?? true,
    // Ask for usage in the stream: without it a streaming run (the default)
    // reports no tokens at all, and token/cost accounting would silently be zero.
    streamUsage: true,
    configuration: { baseURL: env.apiBaseUrl },
  };
  // The chat-completions sub-model is constructed here rather than left to
  // `ChatOpenAI` so the role normalization is part of the fields the wrapper
  // rebuilds itself from: `withConfig()` (which the agent loop uses) makes a new
  // wrapper out of exactly this object, and a sub-model patched afterwards would
  // be dropped by it.
  return new ChatOpenAI({
    ...fields,
    completions: withAssistantRoleDefault(new ChatOpenAICompletions(fields)),
  });
}

/**
 * Prompt-cache configuration from the environment: `ARCHMAX_PROMPT_CACHE`
 * (default on) and `ARCHMAX_PROMPT_CACHE_TTL` (`5m` | `1h`).
 */
export function loadPromptCacheEnv(): { enabled?: boolean; ttl?: string } {
  const enabled = optionalBoolean("PROMPT_CACHE");
  const { raw: ttl } = envValue("PROMPT_CACHE_TTL");
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(ttl?.trim() ? { ttl: ttl.trim() } : {}),
  };
}

/**
 * Token prices from the environment, in USD per 1M tokens, applying to whatever
 * model is configured: `ARCHMAX_PRICE_INPUT`, `ARCHMAX_PRICE_OUTPUT`,
 * `ARCHMAX_PRICE_CACHE_READ`, `ARCHMAX_PRICE_CACHE_WRITE`. Returns `undefined`
 * when none are set, so cost is omitted rather than reported as zero.
 */
export function loadPricingEnv(): PricingTable | undefined {
  const entry: ModelPricing = {};
  const input = optionalNumber("PRICE_INPUT");
  const output = optionalNumber("PRICE_OUTPUT");
  const cacheRead = optionalNumber("PRICE_CACHE_READ");
  const cacheWrite = optionalNumber("PRICE_CACHE_WRITE");
  if (input !== undefined) entry.input = input;
  if (output !== undefined) entry.output = output;
  if (cacheRead !== undefined) entry.cacheRead = cacheRead;
  if (cacheWrite !== undefined) entry.cacheWrite = cacheWrite;
  if (Object.keys(entry).length === 0) return undefined;
  return { [DEFAULT_PRICING_KEY]: entry };
}

/**
 * The role a model plays in the runtime: the workflow `agent` (turns), a `judge`
 * (the offline case grader), or a `rubric` (a grading rubric dispatched by a
 * lifecycle hook). A {@link ModelFactory} may return a different model per role.
 */
export type ModelRole = "agent" | "judge" | "rubric";

/**
 * Supplies the chat model for a given role, so library users can run the runtime
 * against any LangChain `BaseChatModel` (e.g. Amazon Bedrock via
 * `ChatBedrockConverse`) without forking. The default
 * ({@link defaultModelFactory}) is role-independent and returns the
 * env-configured OpenAI-compatible model, so existing `.env` setups and the
 * bundled offline test cases are unchanged.
 *
 * `env` is a thunk, not a value: a factory that brings its own credentials (a
 * host resolving the model from its own configuration) never calls it, and
 * {@link loadEnv} — which throws on a missing `ARCHMAX_API_BASE_URL` — is then
 * never reached. Calling it more than once is cheap; the assembly memoizes.
 */
export type ModelFactory = (
  role: ModelRole,
  env: () => AgentEnv,
  /**
   * The model id the caller asked for — today, the `model` a grading rubric
   * declares. Additive: a factory that ignores it behaves exactly as one written
   * before rubrics could name a model, and no error is raised for an unhonoured
   * request. The default factory applies it over `ARCHMAX_MODEL`, keeping the
   * configured endpoint and credentials.
   */
  requested?: string,
) => BaseChatModel;

/** The default, role-independent model factory: the env-configured `ChatOpenAI`. */
export const defaultModelFactory: ModelFactory = (_role, env, requested) =>
  createChatModel(requested === undefined ? env() : { ...env(), model: requested });
