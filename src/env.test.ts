import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  BUNDLED_AUTHORING_SKILL_DIR,
  createChatModel,
  defaultModelFactory,
  loadEnv,
  type AgentEnv,
  type ModelRole,
} from "./env.js";
import { createJudgeModel } from "./testing/grade.js";

const KEYS = [
  "ARCHMAX_API_BASE_URL",
  "ARCHMAX_API_KEY",
  "ARCHMAX_MODEL",
  "ARCHMAX_TEMPERATURE",
  "ARCHMAX_MAX_TOKENS",
  "ARCHMAX_STREAMING",
];

function clearAll(): void {
  for (const key of KEYS) vi.stubEnv(key, "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("BUNDLED_AUTHORING_SKILL_DIR", () => {
  it("resolves to an existing directory containing the archmax-harness authoring skill", () => {
    expect(existsSync(BUNDLED_AUTHORING_SKILL_DIR)).toBe(true);
    expect(existsSync(join(BUNDLED_AUTHORING_SKILL_DIR, "archmax-harness", "SKILL.md"))).toBe(true);
    expect(existsSync(join(BUNDLED_AUTHORING_SKILL_DIR, "archmax-harness", "references"))).toBe(true);
  });
});

describe("loadDotenv precedence", () => {
  /**
   * A fresh copy of the module, so its import-time cwd load runs against `dir`
   * and its record of what came from a `.env` starts empty.
   */
  async function freshEnvModule(dir: string) {
    process.chdir(dir);
    vi.resetModules();
    return (await import("./env.js")) as typeof import("./env.js");
  }

  const NAMES = ["ARCHMAX_MODEL", "ARCHMAX_API_KEY", "ARCHMAX_DOTENV_PROBE"];
  const originalCwd = process.cwd();
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
    for (const n of NAMES) delete process.env[n];
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const [n, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
    vi.resetModules();
  });

  it("lets the workspace root override a .env in the process's working directory", async () => {
    // The cwd `.env` is loaded at import time for convenience; the workspace
    // root is the source of truth and must win over it (issue #23).
    const cwdDir = mkdtempSync(join(tmpdir(), "archmax-cwd-"));
    const wsDir = mkdtempSync(join(tmpdir(), "archmax-ws-"));
    writeFileSync(join(cwdDir, ".env"), "ARCHMAX_MODEL=cwd-model\nARCHMAX_API_KEY=cwd-key\n");
    writeFileSync(join(wsDir, ".env"), "ARCHMAX_MODEL=ws-model\n");

    const env = await freshEnvModule(cwdDir);
    expect(process.env.ARCHMAX_MODEL).toBe("cwd-model");

    env.loadDotenv(wsDir);
    expect(process.env.ARCHMAX_MODEL).toBe("ws-model");
    // A key only the cwd file declares is not unset by the later load.
    expect(process.env.ARCHMAX_API_KEY).toBe("cwd-key");
  });

  it("never overrides a variable that came from the real environment", async () => {
    const wsDir = mkdtempSync(join(tmpdir(), "archmax-ws-"));
    writeFileSync(join(wsDir, ".env"), "ARCHMAX_DOTENV_PROBE=from-file\n");
    process.env.ARCHMAX_DOTENV_PROBE = "from-real-env";

    const env = await freshEnvModule(wsDir);
    env.loadDotenv(wsDir);

    expect(process.env.ARCHMAX_DOTENV_PROBE).toBe("from-real-env");
  });
});

describe("loadEnv", () => {
  it("reads canonical ARCHMAX_* variables", () => {
    clearAll();
    vi.stubEnv("ARCHMAX_API_BASE_URL", "https://example.test/v1");
    vi.stubEnv("ARCHMAX_API_KEY", "key-1");
    vi.stubEnv("ARCHMAX_MODEL", "model-1");
    vi.stubEnv("ARCHMAX_TEMPERATURE", "0.5");
    expect(loadEnv()).toEqual({
      apiBaseUrl: "https://example.test/v1",
      apiKey: "key-1",
      model: "model-1",
      temperature: 0.5,
      maxTokens: undefined,
    });
  });

  it("names the canonical variable in the missing-variable error", () => {
    clearAll();
    expect(() => loadEnv()).toThrow(/ARCHMAX_API_BASE_URL/);
  });

  it("parses the ARCHMAX_STREAMING opt-out", () => {
    clearAll();
    vi.stubEnv("ARCHMAX_API_BASE_URL", "https://example.test/v1");
    vi.stubEnv("ARCHMAX_API_KEY", "key-1");
    vi.stubEnv("ARCHMAX_MODEL", "model-1");
    expect(loadEnv().streaming).toBeUndefined();
    vi.stubEnv("ARCHMAX_STREAMING", "0");
    expect(loadEnv().streaming).toBe(false);
    vi.stubEnv("ARCHMAX_STREAMING", "true");
    expect(loadEnv().streaming).toBe(true);
    vi.stubEnv("ARCHMAX_STREAMING", "maybe");
    expect(() => loadEnv()).toThrow(/ARCHMAX_STREAMING/);
  });
});

describe("createChatModel streaming", () => {
  it("streams by default and honors the opt-out", () => {
    const base: AgentEnv = {
      apiBaseUrl: "https://example.test/v1",
      apiKey: "key",
      model: "model-x",
    };
    expect(createChatModel(base).streaming).toBe(true);
    expect(createChatModel({ ...base, streaming: false }).streaming).toBe(false);
  });
});

/**
 * The provider's two message-conversion seams, reached the way the provider's own
 * streaming/generate loops reach them. Exercising them directly is what keeps
 * these tests offline while still running the real converters.
 */
interface ConverterSeam {
  completions: {
    _convertCompletionsDeltaToBaseMessageChunk: (
      delta: Record<string, unknown>,
      rawResponse: unknown,
      defaultRole?: string,
    ) => { type: string; tool_call_chunks?: { name?: string; args?: string }[] };
    _convertCompletionsMessageToBaseMessage: (
      message: Record<string, unknown>,
      rawResponse: unknown,
    ) => { type: string };
  };
}

const seamOf = (model: unknown): ConverterSeam["completions"] =>
  (model as unknown as ConverterSeam).completions;

const RAW_CHUNK = { id: "chatcmpl-1", model: "model-x", choices: [{ index: 0, delta: {} }] };
const RAW_RESPONSE = { id: "chatcmpl-1", model: "model-x", choices: [{ index: 0 }] };

describe("createChatModel role normalization", () => {
  const env: AgentEnv = {
    apiBaseUrl: "https://example.test/v1",
    apiKey: "key",
    model: "model-x",
  };

  it("reads a streaming delta that names no role as the assistant's turn", () => {
    // Plain `ChatOpenAI` builds a generic ChatMessageChunk here, which poisons
    // the whole concatenated reply — every later AIMessageChunk merges into it.
    const chunk = seamOf(createChatModel(env))._convertCompletionsDeltaToBaseMessageChunk(
      { content: "hello" },
      RAW_CHUNK,
      undefined,
    );
    expect(chunk.type).toBe("ai");
  });

  it("keeps tool-call chunks parseable on a role-less delta", () => {
    const chunk = seamOf(createChatModel(env))._convertCompletionsDeltaToBaseMessageChunk(
      {
        content: "",
        tool_calls: [{ index: 0, id: "call_1", function: { name: "ls", arguments: '{"path":' } }],
      },
      RAW_CHUNK,
      undefined,
    );
    expect(chunk.type).toBe("ai");
    expect(chunk.tool_call_chunks?.[0]).toMatchObject({ name: "ls", args: '{"path":' });
  });

  it("reads a role from another API's vocabulary as the assistant's turn", () => {
    // What a proxy fronting a non-OpenAI provider passes through.
    const chunk = seamOf(createChatModel(env))._convertCompletionsDeltaToBaseMessageChunk(
      { role: "model", content: "hello" },
      RAW_CHUNK,
    );
    expect(chunk.type).toBe("ai");
  });

  it("leaves a turn the protocol defines as somebody else's alone", () => {
    const seam = seamOf(createChatModel(env));
    expect(seam._convertCompletionsDeltaToBaseMessageChunk({ role: "user" }, RAW_CHUNK).type).toBe(
      "human",
    );
    // A role named on an earlier delta is carried forward by the caller, not
    // overridden here.
    expect(
      seam._convertCompletionsDeltaToBaseMessageChunk({ content: "x" }, RAW_CHUNK, "user").type,
    ).toBe("human");
  });

  it("reads a non-streaming response that names no role as the assistant's turn", () => {
    const message = seamOf(createChatModel(env))._convertCompletionsMessageToBaseMessage(
      { content: "hello" },
      RAW_RESPONSE,
    );
    expect(message.type).toBe("ai");
  });

  it("survives withConfig, which rebuilds the model from its fields", () => {
    const reconfigured = createChatModel(env).withConfig({ tags: ["t"] });
    const chunk = seamOf(reconfigured)._convertCompletionsDeltaToBaseMessageChunk(
      { content: "hello" },
      RAW_CHUNK,
      undefined,
    );
    expect(chunk.type).toBe("ai");
  });
});

const FAKE_ENV: AgentEnv = {
  apiBaseUrl: "https://example.test/v1",
  apiKey: "key",
  model: "model-x",
  temperature: undefined,
  maxTokens: undefined,
};

describe("defaultModelFactory", () => {
  it("returns the env-configured model for every role (role-independent default)", () => {
    for (const role of ["agent", "judge", "rubric"] as ModelRole[]) {
      const model = defaultModelFactory(role, () => FAKE_ENV) as { model?: string };
      expect(model.model).toBe("model-x");
    }
  });
});

describe("createJudgeModel model factory routing", () => {
  function stubEnvVars(): void {
    clearAll();
    vi.stubEnv("ARCHMAX_API_BASE_URL", "https://example.test/v1");
    vi.stubEnv("ARCHMAX_API_KEY", "key");
    vi.stubEnv("ARCHMAX_MODEL", "env-model");
  }

  it("requests the judge role from a supplied factory when config has no judge model", () => {
    stubEnvVars();
    const roles: ModelRole[] = [];
    const sentinel = { __sentinel: true } as unknown as BaseChatModel;
    const factory = (role: ModelRole) => {
      roles.push(role);
      return sentinel;
    };
    const model = createJudgeModel({}, factory);
    expect(roles).toEqual(["judge"]);
    expect(model).toBe(sentinel);
  });

  it("never loads the environment for a factory that carries its own model", () => {
    // The host case: credentials come from the caller, not `ARCHMAX_*`. Loading
    // env eagerly would throw here and make a `judge:` expectation unrunnable.
    clearAll();
    const sentinel = { __sentinel: true } as unknown as BaseChatModel;
    expect(createJudgeModel({}, () => sentinel)).toBe(sentinel);
  });

  it("passes a thunk the factory may call to reach the env-configured model", () => {
    stubEnvVars();
    const model = createJudgeModel({}, (_role, env) => createChatModel(env())) as {
      model?: string;
    };
    expect(model.model).toBe("env-model");
  });

  it("applies a config.judge.model override to the env the factory is handed", () => {
    stubEnvVars();
    const model = createJudgeModel({ judge: { model: "override-model" } }, (_role, env) =>
      createChatModel(env()),
    ) as { model?: string };
    expect(model.model).toBe("override-model");
  });

  it("still asks the factory for the judge role when config names a model", () => {
    stubEnvVars();
    const roles: ModelRole[] = [];
    const sentinel = { __sentinel: true } as unknown as BaseChatModel;
    const model = createJudgeModel({ judge: { model: "override-model" } }, (role) => {
      roles.push(role);
      return sentinel;
    });
    expect(roles).toEqual(["judge"]);
    expect(model).toBe(sentinel);
  });
});
