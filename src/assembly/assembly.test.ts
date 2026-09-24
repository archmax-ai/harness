import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { AGENT_DEFAULT_CONFIG } from "../agent.js";
import { assertNoReservedToolNames, ReservedToolNameError } from "../machine/tool-names.js";
import { createAgent } from "./index.js";
import { resolveTrigger, UnknownTriggerError } from "../machine/triggers.js";
import { WorkflowLoadError } from "../machine/load-spec.js";
import { SessionNotParkedError } from "../sessions/resume.js";
import { UnsupportedRuntimeContractError } from "../runtime/contract.js";
import { createMemorySessionStore } from "../core/session-store.js";
import { createToolMockMiddleware } from "../testing/mock-middleware.js";
import { createCaseTarget } from "../testing/target.js";
import { WorkflowMachine } from "../machine/machine.js";
import type { MachineSpec } from "../machine/types.js";
import type { Trajectory } from "../workflow/session-artifacts.js";
import { SimpleChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { FilesystemBackend, type BackendProtocolV2 } from "deepagents";
import { defaultMounts } from "../core/mounts.js";
import { mountSubtree } from "../core/path-mapping.js";
import type { WorkflowLifecycleEvent } from "../core/events.js";

/** Never invoked during assembly or artifact emission — a type-satisfying stub. */
const stubModel = { getName: () => "StubModel" } as unknown as BaseChatModel;

function machineFrom(spec: MachineSpec): WorkflowMachine {
  return WorkflowMachine.fromSpec(spec);
}

const tmpRoots: string[] = [];

function makeWorkspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "assembly-test-"));
  tmpRoots.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const full = resolve(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

afterEach(() => {
  while (tmpRoots.length) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

describe("resolveTrigger", () => {
  const spec: MachineSpec = {
    states: {
      identify: { triggers: { manual: null }, transitions: [{ to: "answer", description: "Test edge to answer." }] },
      handle_email: { triggers: { email_received: null }, transitions: [{ to: "answer", description: "Test edge to answer." }] },
      answer: {},
    },
  };

  it("defaults to the manual trigger and its start state", () => {
    expect(resolveTrigger(machineFrom(spec))).toEqual({ id: "manual", startState: "identify" });
  });

  it("resolves a tool/event trigger to its start state", () => {
    expect(resolveTrigger(machineFrom(spec), { id: "email_received" })).toEqual({
      id: "email_received",
      startState: "handle_email",
    });
  });

  it("throws UnknownTriggerError for an unknown trigger id", () => {
    expect(() => resolveTrigger(machineFrom(spec), { id: "nope" })).toThrow(UnknownTriggerError);
  });

  it("resolves the manual trigger to the state declaring it", () => {
    const m = machineFrom({
      states: {
        start: { triggers: { manual: null }, transitions: [{ to: "closed", description: "Test edge to closed." }] },
        closed: {},
      },
    });
    expect(resolveTrigger(m)).toEqual({ id: "manual", startState: "start" });
  });
});

describe("reserved archmax_ tool namespace", () => {
  const named = (name: string) => ({ name }) as never;

  it("rejects a host tool claiming the namespace", () => {
    expect(() => assertNoReservedToolNames([named("archmax_custom")])).toThrow(
      ReservedToolNameError,
    );
    expect(() => assertNoReservedToolNames([named("archmax_custom")])).toThrow(/archmax_custom/);
  });

  it("names every offender at once", () => {
    try {
      assertNoReservedToolNames([named("archmax_a"), named("ok"), named("archmax_b")]);
      throw new Error("expected a rejection");
    } catch (err) {
      expect((err as ReservedToolNameError).names).toEqual(["archmax_a", "archmax_b"]);
    }
  });

  it("accepts ordinary host tools", () => {
    expect(() =>
      assertNoReservedToolNames([named("crm__lookup"), named("read_file")]),
    ).not.toThrow();
    expect(() => assertNoReservedToolNames(undefined)).not.toThrow();
  });
});

describe("createAgent runtime contract enforcement", () => {
  it("rejects an unsupported runtime contract before model-driven execution", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": [
        "runtime:",
        "  engine: archmax-harness",
        '  version: "99"',
        "states:",
        "  start: { triggers: { manual: } }",
      ].join("\n"),
    });

    await expect(
      createAgent({ workflow: "p", workspace: { rootDir: root } }),
    ).rejects.toBeInstanceOf(UnsupportedRuntimeContractError);
  });
});

describe("createAgent workflow load enforcement", () => {
  it("throws WorkflowLoadError when an explicitly requested workflow is missing", async () => {
    const root = makeWorkspace({ "AGENTS.md": "# Agent\n" });

    const error = await createAgent({ workflow: "nope", workspace: { rootDir: root } }).then(
      () => null,
      (err) => err,
    );
    expect(error).toBeInstanceOf(WorkflowLoadError);
    expect((error as WorkflowLoadError).workflow).toBe("nope");
    expect((error as WorkflowLoadError).message).toContain("no workflow.yaml found");
  });

  it("throws WorkflowLoadError when workflow.yaml exists but has no valid machine spec", async () => {
    const root = makeWorkspace({
      "workflows/order-lookup/workflow.yaml": "- not a mapping\n",
    });

    // Even the unrequested default fails closed when a definition exists but
    // cannot be parsed into a machine spec.
    const error = await createAgent({ workspace: { rootDir: root } }).then(
      () => null,
      (err) => err,
    );
    expect(error).toBeInstanceOf(WorkflowLoadError);
    expect((error as WorkflowLoadError).message).toContain("no valid machine spec");
  });

  // Host-owned decorations on a trigger declaration must not be able to take a
  // workflow down: `message` is resolved by the host, and an unrecognized key is
  // ignored — neither leaves the machine underdetermined.
  it("assembles a workflow whose trigger declares host-resolved and unknown keys", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": [
        "states:",
        "  start:",
        "    triggers:",
        "      chat:",
        "        session: triggers.-1.threadId",
        "        message: triggers.-1.text",
        "        connection: acme-oidc",
        "        nonsense: 1",
      ].join("\n"),
    });

    const runtime = await createAgent({
      workflow: "p",
      model: stubModel,
      trigger: { id: "chat" },
      workspace: { rootDir: root },
    });
    expect(runtime.workflow).toBeDefined();
    const machine = runtime.workflow!.machine;
    expect(machine.startStateForTrigger("chat")).toBe("start");
    expect(machine.connectionForTrigger("chat")).toBe("acme-oidc");
    expect(machine.messagePathForTrigger("chat")).toMatchObject({
      name: "triggers",
      path: ["-1", "text"],
    });
  });
});

describe("createAgent model factory", () => {
  it("assembles without ARCHMAX_* variables when the factory supplies its own models", async () => {
    // A host resolving the model from its own configuration passes a factory
    // that ignores the `env` thunk; nothing then reads the environment, so
    // `loadEnv`'s missing-variable error is never reached.
    for (const key of ["ARCHMAX_API_BASE_URL", "ARCHMAX_API_KEY", "ARCHMAX_MODEL"]) {
      vi.stubEnv(key, "");
    }
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": ["states:", "  start: { triggers: { manual: } }"].join("\n"),
    });

    const roles: string[] = [];
    const runtime = await createAgent({
      workflow: "p",
      modelFactory: (role) => {
        roles.push(role);
        return stubModel;
      },
      workspace: { rootDir: root },
    });

    // Only the roles the assembly actually needs: a workflow declaring no rubric
    // has no grader to build a model for, so the factory is asked once.
    expect(roles).toEqual(["agent"]);
    expect(runtime.graph).toBeDefined();
    vi.unstubAllEnvs();
  });

  it("asks the factory for the rubric role, passing the id a rubric declares", async () => {
    for (const key of ["ARCHMAX_API_BASE_URL", "ARCHMAX_API_KEY", "ARCHMAX_MODEL"]) {
      vi.stubEnv(key, "");
    }
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": [
        "states:",
        "  start:",
        "    triggers: { manual: }",
        "    after: { rubric: { instructions: judge the tone, model: grader-model } }",
        "    transitions: [{ to: done, description: finish }]",
        "  done:",
      ].join("\n"),
    });

    const calls: { role: string; requested?: string }[] = [];
    await createAgent({
      workflow: "p",
      modelFactory: (role, _env, requested) => {
        calls.push({ role, ...(requested === undefined ? {} : { requested }) });
        return stubModel;
      },
      workspace: { rootDir: root },
    });

    expect(calls).toEqual([
      { role: "agent" },
      { role: "rubric", requested: "grader-model" },
    ]);
    vi.unstubAllEnvs();
  });

  it("asks the factory for each declared id once, and only for the ids the spec names", async () => {
    for (const key of ["ARCHMAX_API_BASE_URL", "ARCHMAX_API_KEY", "ARCHMAX_MODEL"]) {
      vi.stubEnv(key, "");
    }
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": [
        "settings: { model: small-model }",
        "states:",
        "  triage:",
        "    triggers: { manual: }",
        "    transitions: [{ to: draft, description: hand over }]",
        "  draft:",
        "    model: large-model",
        "    transitions: [{ to: review, description: hand over }]",
        "  review:",
        "    model: large-model",
        "    transitions: [{ to: done, description: finish }]",
        "  done:",
      ].join("\n"),
    });

    const calls: { role: string; requested?: string }[] = [];
    await createAgent({
      workflow: "p",
      modelFactory: (role, _env, requested) => {
        calls.push({ role, ...(requested === undefined ? {} : { requested }) });
        return stubModel;
      },
      workspace: { rootDir: root },
    });

    // One model per distinct id: `large-model` is declared by two states and
    // built once; the default (`agent`, no id) is the one every state without a
    // declaration runs on.
    expect(calls).toEqual([
      { role: "agent" },
      { role: "agent", requested: "small-model" },
      { role: "agent", requested: "large-model" },
    ]);
    vi.unstubAllEnvs();
  });

  it("warns once when an explicit model outranks the ids the spec declares", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": [
        "settings: { model: small-model }",
        "states:",
        "  triage:",
        "    triggers: { manual: }",
        "    transitions: [{ to: draft, description: hand over }]",
        "  draft:",
        "    model: large-model",
        "    transitions: [{ to: done, description: finish }]",
        "  done:",
      ].join("\n"),
    });

    const warnings: string[] = [];
    await createAgent({
      workflow: "p",
      model: stubModel,
      workspace: { rootDir: root },
      onEvent: (event) => {
        if (event.type === "warning") warnings.push(event.message);
      },
    });

    const ignored = warnings.filter((message) => message.includes("outranks a declared id"));
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toContain("settings.model 'small-model'");
    expect(ignored[0]).toContain("states.draft.model 'large-model'");
    expect(ignored[0]).toContain("modelFactory");
  });

  it("reports the cache mechanism per model, and names a state whose model wants another", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": [
        "settings: { model: compat-claude }",
        "states:",
        "  triage:",
        "    triggers: { manual: }",
        "    transitions: [{ to: draft, description: hand over }]",
        "  draft:",
        "    model: native-claude",
        "    transitions: [{ to: extract, description: hand over }]",
        "  extract:",
        "    model: no-cache-model",
        "    transitions: [{ to: done, description: finish }]",
        "  done:",
      ].join("\n"),
    });

    // Three mechanisms in one workflow: Claude over an OpenAI-compatible
    // endpoint (an explicit breakpoint), a native `ChatAnthropic` (LangChain's
    // graph-level middleware), and a model with no known mechanism.
    const models: Record<string, BaseChatModel> = {
      "compat-claude": { getName: () => "ChatOpenAI", model: "claude-sonnet-x" } as unknown as BaseChatModel,
      "native-claude": { getName: () => "ChatAnthropic", model: "claude-opus-x" } as unknown as BaseChatModel,
      "no-cache-model": { getName: () => "ChatOpenAI", model: "some-other-model" } as unknown as BaseChatModel,
    };

    const warnings: string[] = [];
    await createAgent({
      workflow: "p",
      modelFactory: (_role, _env, requested) => models[requested ?? ""] ?? stubModel,
      workspace: { rootDir: root },
      onEvent: (event) => {
        if (event.type === "warning") warnings.push(event.message);
      },
    });

    // The unsupported model is reported by its own id, not the workflow's.
    const unsupported = warnings.filter((message) => message.includes("prompt caching is inactive"));
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]).toContain("some-other-model");

    // Native caching is graph-level, so the state that wants it while the
    // workflow's model does not is named rather than silently mis-cached.
    const mismatch = warnings.filter((message) => message.includes("prompt-cache mechanism"));
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]).toContain("State 'draft'");
    expect(mismatch[0]).toContain("anthropic-native");
  });

  it("says nothing about models when the spec declares none", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": ["states:", "  start: { triggers: { manual: } }"].join("\n"),
    });

    const warnings: string[] = [];
    await createAgent({
      workflow: "p",
      model: stubModel,
      workspace: { rootDir: root },
      onEvent: (event) => {
        if (event.type === "warning") warnings.push(event.message);
      },
    });

    expect(warnings.filter((message) => message.includes("declared id"))).toEqual([]);
  });
});

describe("createAgent run metadata + spec snapshot", () => {
  const trajectory: Trajectory = { sessionId: "r1", workflow: "p", finalAnswer: "", segments: [] };

  it("records specHash in a governed run's metadata, resolvable via getSpecSnapshot once persisted", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": ["states:", "  start: { triggers: { manual: } }"].join("\n"),
    });

    const runtime = await createAgent({ workflow: "p", model: stubModel, workspace: { rootDir: root } });
    const runDir = await runtime.emitRunArtifacts("r1", trajectory);
    expect(runDir).not.toBeNull();

    const meta = JSON.parse(readFileSync(resolve(root, "sessions/r1/artifacts/metadata.json"), "utf8"));
    expect(typeof meta.specHash).toBe("string");

    // No session has actually run (assembly alone never invokes `initNode`), so
    // no snapshot was persisted yet for this hash — verified by `graph.test.ts`
    // for the write path itself.
    await expect(runtime.getSpecSnapshot(meta.specHash)).resolves.toBeNull();

    // Simulate a prior session having persisted the snapshot for this same
    // hash, and confirm the runtime resolves it back through the workspace.
    const specDir = resolve(root, "sessions/_specs");
    mkdirSync(specDir, { recursive: true });
    const spec = { entry: "start", states: { start: {} } };
    writeFileSync(resolve(specDir, `${meta.specHash}.json`), JSON.stringify(spec));
    await expect(runtime.getSpecSnapshot(meta.specHash)).resolves.toEqual(spec);
  });

  it("omits specHash from a plain agent's run metadata", async () => {
    const root = makeWorkspace({ "AGENTS.md": "# Agent\n" });

    const runtime = await createAgent({ model: stubModel, workspace: { rootDir: root } });
    expect(runtime.workflow).toBeUndefined();
    const runDir = await runtime.emitRunArtifacts("r1", trajectory);
    expect(runDir).not.toBeNull();

    const meta = JSON.parse(readFileSync(resolve(root, "sessions/r1/artifacts/metadata.json"), "utf8"));
    expect(meta.specHash).toBeUndefined();
  });

  it("resolves null for an unknown spec hash", async () => {
    const root = makeWorkspace({ "AGENTS.md": "# Agent\n" });
    const runtime = await createAgent({ model: stubModel, workspace: { rootDir: root } });
    await expect(runtime.getSpecSnapshot("does-not-exist")).resolves.toBeNull();
  });

  it("writes a governed run's trail.json from checkpointed state (empty when the session never ran)", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": ["states:", "  start: { triggers: { manual: } }"].join("\n"),
    });

    const runtime = await createAgent({ workflow: "p", model: stubModel, workspace: { rootDir: root } });
    await runtime.emitRunArtifacts("r1", trajectory);

    const trail = JSON.parse(readFileSync(resolve(root, "sessions/r1/artifacts/trail.json"), "utf8"));
    expect(trail).toEqual({ sessionId: "r1", workflow: "p", steps: [] });
  });

  it("prefers a caller-supplied trail over the checkpoint read", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": ["states:", "  start: { triggers: { manual: } }"].join("\n"),
    });

    const runtime = await createAgent({ workflow: "p", model: stubModel, workspace: { rootDir: root } });
    const steps = [{ to: "start", kind: "trigger" as const, reason: "manual", ts: 1 }];
    await runtime.emitRunArtifacts("r2", trajectory, { trail: steps });

    const trail = JSON.parse(readFileSync(resolve(root, "sessions/r2/artifacts/trail.json"), "utf8"));
    expect(trail.steps).toEqual(steps);
  });

  it("omits the metrics ledger when a session measured nothing", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": ["states:", "  start: { triggers: { manual: } }"].join("\n"),
    });

    const runtime = await createAgent({ workflow: "p", model: stubModel, workspace: { rootDir: root } });
    // No session has run, so nothing was spent: artifacts are still written, and
    // metadata carries no misleading row of zeros.
    await runtime.emitRunArtifacts("r1", trajectory);

    const meta = JSON.parse(readFileSync(resolve(root, "sessions/r1/artifacts/metadata.json"), "utf8"));
    expect(meta.usage).toBeUndefined();
    expect(meta.packageVersion).toBeDefined();
  });

  it("writes artifacts for a plain agent, which has no machine to snapshot", async () => {
    const root = makeWorkspace({ "AGENTS.md": "# Agent\n" });

    const runtime = await createAgent({ model: stubModel, workspace: { rootDir: root } });
    const runDir = await runtime.emitRunArtifacts("r1", trajectory);

    expect(runDir).not.toBeNull();
    const meta = JSON.parse(readFileSync(resolve(root, "sessions/r1/artifacts/metadata.json"), "utf8"));
    expect(meta.packageVersion).toBeDefined();
    expect(meta.specHash).toBeUndefined();
  });

  it("records a governed run's variables, with the host's seed and trigger locked", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": ["states:", "  start: { triggers: { manual: } }"].join("\n"),
    });

    // A real turn, so the store read back is the checkpoint's own — the join
    // this artifact exists for. The fake model replies without tool calls,
    // which ends the segment in the terminal state.
    const runtime = await createAgent({
      workflow: "p",
      model: new FakeListChatModel({ responses: ["done"] }) as never,
      variables: { from_email: "a@b.c", order: { items: [{ sku: "A-1" }] } },
      onEvent: () => {},
      workspace: { rootDir: root },
    });
    await runtime.invoke(
      { messages: [{ role: "user", content: "hi" }] } as never,
      { configurable: { thread_id: "r5" }, recursionLimit: 12 } as never,
    );
    await runtime.emitRunArtifacts("r5", { ...trajectory, sessionId: "r5" });

    const recorded = JSON.parse(
      readFileSync(resolve(root, "sessions/r5/artifacts/variables.json"), "utf8"),
    );
    expect(recorded.sessionId).toBe("r5");
    expect(recorded.workflow).toBe("p");
    // Host-established facts, locked — what a test case reproduces as its seeds.
    expect(recorded.variables.from_email).toEqual({ value: "a@b.c", locked: true });
    expect(recorded.variables.order.value).toEqual({ items: [{ sku: "A-1" }] });
    expect(recorded.variables.trigger).toEqual({ value: "manual", locked: true });
  });

  it("records an empty store for a governed run that seeded nothing", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": ["states:", "  start: { triggers: { manual: } }"].join("\n"),
    });

    const runtime = await createAgent({ workflow: "p", model: stubModel, workspace: { rootDir: root } });
    await runtime.emitRunArtifacts("r1", trajectory);

    // Empty says "took no seeded input"; absent would say "no machine". The two
    // must not collapse into the same artifact.
    const recorded = JSON.parse(
      readFileSync(resolve(root, "sessions/r1/artifacts/variables.json"), "utf8"),
    );
    expect(recorded).toEqual({ sessionId: "r1", workflow: "p", variables: {} });
  });

  it("writes no variables.json for a plain agent", async () => {
    const root = makeWorkspace({ "AGENTS.md": "# Agent\n" });

    const runtime = await createAgent({ model: stubModel, workspace: { rootDir: root } });
    await runtime.emitRunArtifacts("r1", trajectory);

    expect(() =>
      readFileSync(resolve(root, "sessions/r1/artifacts/variables.json"), "utf8"),
    ).toThrow();
  });

  it("writes no trail.json for a plain agent", async () => {
    const root = makeWorkspace({ "AGENTS.md": "# Agent\n" });

    const runtime = await createAgent({ model: stubModel, workspace: { rootDir: root } });
    await runtime.emitRunArtifacts("r1", trajectory);

    expect(() => readFileSync(resolve(root, "sessions/r1/artifacts/trail.json"), "utf8")).toThrow();
  });
});

describe("createAgent capability stamping", () => {
  const governedRoot = () =>
    makeWorkspace({
      "workflows/p/workflow.yaml": ["states:", "  start: { triggers: { manual: } }"].join("\n"),
    });

  it("stamps toolMocks: true when the tool-mock middleware is wired", async () => {
    const runtime = await createAgent({
      workflow: "p",
      model: stubModel,
      middleware: [createToolMockMiddleware()],
      workspace: { rootDir: governedRoot() },
    });
    expect(runtime.toolMocks).toBe(true);
  });

  it("stamps toolMocks: false when it is not", async () => {
    const runtime = await createAgent({
      workflow: "p",
      model: stubModel,
      workspace: { rootDir: governedRoot() },
    });
    expect(runtime.toolMocks).toBe(false);
  });

  it("stamps toolMocks: false on a plain agent, where no middleware is wired", async () => {
    const root = makeWorkspace({ "AGENTS.md": "# Agent\n" });
    const runtime = await createAgent({ model: stubModel, workspace: { rootDir: root } });
    expect(runtime.workflow).toBeUndefined();
    // A plain agent has no machine to delegate from, so it declares neither.
    expect(runtime.toolMocks).toBe(false);
    expect(runtime.workflow).toBeUndefined();
  });

  it("createCaseTarget's default target always carries the capability", async () => {
    const target = await createCaseTarget({
      workflow: "p",
      rootDir: governedRoot(),
      modelFactory: () => stubModel,
    });
    expect(target.toolMocks).toBe(true);
  });
});

describe("sessions.get with an in-memory checkpointer", () => {
  it("projects a live session rather than reporting none", async () => {
    const { MemorySaver, emptyCheckpoint } = await import("@langchain/langgraph");
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": ["states:", "  start: { triggers: { manual: } }"].join("\n"),
    });
    const checkpointer = new MemorySaver();
    const runtime = await createAgent({
      workflow: "p",
      model: stubModel,
      checkpointer,
      workspace: { rootDir: root },
    });

    // Nothing has run for this id: no session, correctly.
    expect(await runtime.sessions.get("mem-1")).toBeNull();

    const cp = emptyCheckpoint();
    cp.id = "0001";
    cp.channel_values = { status: "completed", workflowState: "start" };
    await checkpointer.put(
      { configurable: { thread_id: "mem-1", checkpoint_ns: "" } },
      cp,
      { source: "input", step: 0, parents: {} } as never,
    );

    // The projection needs only `getTuple`, so a non-backend checkpointer answers
    // too. Reporting `null` here would make this session's next turn look like its
    // first, and `resolveSession` would misreport where that turn begins.
    const summary = await runtime.sessions.get("mem-1");
    expect(summary).toMatchObject({
      sessionId: "mem-1",
      status: "completed",
      classification: "finished",
      workflowState: "start",
    });
  });
});

describe("sessions.delete with an in-memory checkpointer", () => {
  it("evicts live checkpointer state, not only the stored namespace", async () => {
    const { MemorySaver, emptyCheckpoint } = await import("@langchain/langgraph");
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": ["states:", "  start: { triggers: { manual: } }"].join("\n"),
    });
    const checkpointer = new MemorySaver();
    const runtime = await createAgent({
      workflow: "p",
      model: stubModel,
      checkpointer,
      workspace: { rootDir: root },
    });

    const cp = emptyCheckpoint();
    cp.id = "0001";
    cp.channel_values = { status: "completed", workflowState: "start" };
    const config = { configurable: { thread_id: "gone-1", checkpoint_ns: "" } };
    await checkpointer.put(config, cp, { source: "input", step: 0, parents: {} } as never);

    await runtime.sessions.delete("gone-1");

    // `deleteThread` is abstract on every saver, so eviction must not be gated on
    // one implementation: a deleted session that still resumes from memory is a
    // session whose storage is gone but whose state is not.
    expect(await checkpointer.getTuple(config)).toBeUndefined();
    expect(await runtime.sessions.get("gone-1")).toBeNull();
  });
});

describe("sessions.seed", () => {
  const governedRoot = () =>
    makeWorkspace({
      "workflows/p/workflow.yaml": ["states:", "  start: { triggers: { manual: } }"].join("\n"),
    });

  async function seedRuntime() {
    const root = governedRoot();
    const runtime = await createAgent({ workflow: "p", model: stubModel, workspace: { rootDir: root } });
    return { root, runtime };
  }

  it("writes agent-visible run-zone files: JSON serialized, strings verbatim", async () => {
    const { root, runtime } = await seedRuntime();
    await runtime.sessions.seed("t1", {
      "trigger.json": { company: "Acme" },
      "scratchpad/note.txt": "hi",
      "output/report.md": "# Report",
    });
    expect(readFileSync(join(root, "sessions/t1/trigger.json"), "utf8")).toBe(
      `${JSON.stringify({ company: "Acme" }, null, 2)}\n`,
    );
    expect(readFileSync(join(root, "sessions/t1/scratchpad/note.txt"), "utf8")).toBe("hi");
    expect(readFileSync(join(root, "sessions/t1/output/report.md"), "utf8")).toBe("# Report");
  });

  it("overwrites an existing seeded file", async () => {
    const { root, runtime } = await seedRuntime();
    await runtime.sessions.seed("t1", { "trigger.json": { company: "Acme" } });
    await runtime.sessions.seed("t1", { "trigger.json": { company: "Globex" } });
    expect(readFileSync(join(root, "sessions/t1/trigger.json"), "utf8")).toBe(
      `${JSON.stringify({ company: "Globex" }, null, 2)}\n`,
    );
  });

  it("overwrites a seeded file through the memory store", async () => {
    const root = governedRoot();
    const store = createMemorySessionStore();
    const runtime = await createAgent({
      workflow: "p",
      model: stubModel,
      workspace: { rootDir: root, sessionStore: store },
    });
    await runtime.sessions.seed("t1", { "trigger.json": "v1" });
    await runtime.sessions.seed("t1", { "trigger.json": "v2" });
    expect(await store.backend.read("/t1/trigger.json")).toMatchObject({ content: "v2" });
  });

  it.each([
    ["checkpoints/x.json", "run-internal"],
    ["large_tool_results/x.json", "run-offload"],
    ["skills/orders/assets/orders.json", "authored"],
    ["../escape.txt", "escapes"],
  ])("rejects %s (%s zone) naming the path and zone", async (path, zone) => {
    const { runtime } = await seedRuntime();
    await expect(runtime.sessions.seed("t1", { [path]: "x" })).rejects.toThrow(
      new RegExp(`${zone}`),
    );
  });

  it("seeds nothing when any path in the call is rejected", async () => {
    const { root, runtime } = await seedRuntime();
    await expect(
      runtime.sessions.seed("t1", { "ok.txt": "hi", "checkpoints/bad.json": "x" }),
    ).rejects.toThrow(/run-internal/);
    expect(existsSync(join(root, "sessions/t1/ok.txt"))).toBe(false);
  });

  it("rejects reserved or traversing session ids before writing", async () => {
    const { root, runtime } = await seedRuntime();
    for (const sessionId of ["", "../t1", "scratchpad"]) {
      await expect(runtime.sessions.seed(sessionId, { "trigger.json": "x" })).rejects.toThrow(
        /Invalid session id/,
      );
    }
    expect(existsSync(join(root, "sessions/scratchpad"))).toBe(false);
  });
});

describe("createAgent delegation tool binding", () => {
  const caller = (allow: string) =>
    [
      "states:",
      "  start:",
      "    triggers: { manual: }",
      "    tools:",
      "      allow:",
      `        - ${allow}`,
    ].join("\n");

  const target = (extra = "") =>
    [
      "title: Order enrichment",
      "states:",
      "  enrich:",
      "    triggers:",
      "      manual:",
      "        requires: [order_id]",
      "        returns: [enrichment_file]",
      extra,
    ]
      .filter(Boolean)
      .join("\n");

  const assemble = (root: string) =>
    createAgent({ workflow: "p", model: stubModel, workspace: { rootDir: root } });

  it("reads the signature of each target a state allows", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": caller("archmax_workflow_enrich-order"),
      "workflows/enrich-order/workflow.yaml": target(),
    });
    await expect(assemble(root)).resolves.toBeDefined();
  });

  it("never reads a sibling no allow list names", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": caller("read_file"),
      // Unloadable, and irrelevant: nothing names it, so nothing reads it. The
      // same file under an allow entry fails assembly (below).
      "workflows/enrich-order/workflow.yaml": "- not a mapping\n",
    });
    await expect(assemble(root)).resolves.toBeDefined();
  });

  it("fails assembly when an allowed target does not exist", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": caller("archmax_workflow_absent"),
    });
    const error = await assemble(root).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(error).toBeInstanceOf(WorkflowLoadError);
    expect(error?.message).toContain("archmax_workflow_absent");
  });

  // A caller enters where a host would, so a machine with no `manual` entry has
  // no state to start in at all — the same fail-closed read both ingresses make,
  // rather than an opt-in the target withheld.
  it("fails assembly when an allowed target has no manual entry", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": caller("archmax_workflow_enrich-order"),
      // Loadable and startable by a host firing `enrichment_requested`, but there
      // is no `manual` entry for anything else to enter.
      "workflows/enrich-order/workflow.yaml": [
        "states:",
        "  enrich:",
        "    triggers: { enrichment_requested: }",
      ].join("\n"),
    });
    const error = await assemble(root).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(error).toBeInstanceOf(WorkflowLoadError);
    expect(error?.message).toMatch(/declares no 'manual' trigger entry/);
  });

  // The merge's point: one declaration makes a machine runnable and callable, so
  // a target needs nothing beyond the entry a host would use.
  // A disabled target is a deliberate, reversible operational state, not the
  // spec bug a missing entry is: failing here would take every caller — and every
  // caller's parked session — offline for a one-line change. The dispatch refuses
  // instead, and `validate` warns offline.
  it("still assembles when an allowed target is disabled", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": caller("archmax_workflow_enrich-order"),
      "workflows/enrich-order/workflow.yaml": target("disabled: true"),
    });
    await expect(assemble(root)).resolves.toBeDefined();
  });

  it("binds a target whose only declaration is its manual entry", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": caller("archmax_workflow_enrich-order"),
      "workflows/enrich-order/workflow.yaml": [
        "states:",
        "  enrich:",
        "    triggers: { manual: }",
      ].join("\n"),
    });
    await expect(assemble(root)).resolves.toBeDefined();
  });
});

describe("createAgent skill discovery and disclosure", () => {
  const skillFile = (name: string, description: string) =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

  const WORKFLOW = [
    "skills:",
    "  allow_always: []",
    "states:",
    "  lookup:",
    "    triggers: { manual: }",
    "    skills:",
    "      allow: [order-data]",
  ].join("\n");

  const slugsFrom = (events: WorkflowLifecycleEvent[]): string[] =>
    events.flatMap((e) => (e.type === "skills-loaded" ? e.names : []));

  /** A model that records the system prompt of every call and then replies. */
  class PromptCaptureModel extends SimpleChatModel {
    readonly systemPrompts: string[] = [];

    _llmType(): string {
      return "archmax-prompt-capture";
    }

    bindTools(): BaseChatModel {
      return this as unknown as BaseChatModel;
    }

    async _call(messages: BaseMessage[]): Promise<string> {
      const system = messages.find((m) => m.getType() === "system");
      const content = system?.content;
      this.systemPrompts.push(
        typeof content === "string"
          ? content
          : (content ?? [])
              .map((block: unknown) =>
                typeof block === "object" && block && "text" in block ? String(block.text) : "",
              )
              .join("\n"),
      );
      return "done";
    }
  }

  it("discovers the conventional source and announces the slugs", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": WORKFLOW,
      "skills/order-data/SKILL.md": skillFile("order-data", "The order records."),
      "skills/refund-policy/SKILL.md": skillFile("refund-policy", "When to refund."),
    });
    const events: WorkflowLifecycleEvent[] = [];
    await createAgent({
      workflow: "p",
      model: stubModel,
      onEvent: (e) => events.push(e),
      workspace: { rootDir: root },
    });
    expect(slugsFrom(events)).toEqual(["order-data", "refund-policy"]);
  });

  it("honors a custom source list over the conventional one", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": ["states:", "  lookup: { triggers: { manual: } }"].join("\n"),
      "capabilities/order-data/SKILL.md": skillFile("order-data", "The order records."),
      "skills/ignored/SKILL.md": skillFile("ignored", "Not a declared source."),
    });
    const events: WorkflowLifecycleEvent[] = [];
    await createAgent({
      workflow: "p",
      model: stubModel,
      skills: ["capabilities/"],
      onEvent: (e) => events.push(e),
      workspace: { rootDir: root, mounts: { ...defaultMounts(root), "/capabilities/": mountSubtree(new FilesystemBackend({ rootDir: root, virtualMode: true }), "capabilities") } },
    });
    expect(slugsFrom(events)).toEqual(["order-data"]);
  });

  it("discovers through a mounted backend with nothing on disk", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": ["states:", "  lookup: { triggers: { manual: } }"].join("\n"),
    });
    const files: Record<string, string> = {
      "/in-memory/SKILL.md": skillFile("in-memory", "Served from state, never from disk."),
    };
    const backend = {
      async readRaw(filePath: string) {
        const content = files[`/${filePath.replace(/^\/+/, "")}`];
        if (content === undefined) return { error: "missing" };
        return { data: { content, mimeType: "text/plain", created_at: "", modified_at: "" } };
      },
      async ls() {
        return { files: [{ path: "/in-memory/", is_dir: true }] };
      },
    } as unknown as BackendProtocolV2;

    const events: WorkflowLifecycleEvent[] = [];
    await createAgent({
      workflow: "p",
      model: stubModel,
      skills: ["caps/"],
      onEvent: (e) => events.push(e),
      workspace: { rootDir: root, mounts: { ...defaultMounts(root), "/caps/": backend } },
    });
    expect(slugsFrom(events)).toEqual(["in-memory"]);
    expect(existsSync(join(root, "caps"))).toBe(false);
  });

  it("assembles with no skills at all: an empty source list, and a source serving nothing", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": ["states:", "  lookup: { triggers: { manual: } }"].join("\n"),
      "skills/order-data/SKILL.md": skillFile("order-data", "The order records."),
    });
    for (const skills of [[], ["nowhere/"]]) {
      const events: WorkflowLifecycleEvent[] = [];
      const runtime = await createAgent({
      workflow: "p",
      model: stubModel,
      skills,
      onEvent: (e) => events.push(e),
      workspace: { rootDir: root },
    });
      expect(runtime.graph).toBeDefined();
      expect(slugsFrom(events)).toEqual([]);
    }
  });

  it("discloses the active state's skills and no upstream skills section", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": WORKFLOW,
      "skills/order-data/SKILL.md": skillFile("order-data", "The order records."),
      "skills/refund-policy/SKILL.md": skillFile("refund-policy", "When to refund."),
    });
    const model = new PromptCaptureModel({});
    const runtime = await createAgent({
      workflow: "p",
      model: model as unknown as BaseChatModel,
      onEvent: () => {},
      workspace: { rootDir: root, sessionStore: createMemorySessionStore() },
    });
    await runtime.invoke(
      { messages: [{ role: "user", content: "hi" }] } as never,
      { configurable: { thread_id: "sk1" }, recursionLimit: 12 } as never,
    );

    const prompt = model.systemPrompts.join("\n---\n");
    expect(prompt).toContain("## Skills available in this state");
    expect(prompt).toContain("`order-data`");
    // The state narrowed to one skill, so the other is named nowhere…
    expect(prompt).not.toContain("refund-policy");
    // …and upstream's whole-source section, which would have named both, is not
    // installed on the governed path.
    expect(prompt).not.toContain("Skills System");
  });

  it("keeps the plain no-machine assembly skills-driven", async () => {
    const root = makeWorkspace({
      "AGENTS.md": "# Persona\n",
      "skills/order-data/SKILL.md": skillFile("order-data", "The order records."),
    });
    const events: WorkflowLifecycleEvent[] = [];
    const runtime = await createAgent({
      model: stubModel,
      onEvent: (e) => events.push(e),
      workspace: { rootDir: root },
    });
    expect(runtime.workflow).toBeUndefined();
    expect(slugsFrom(events)).toEqual(["order-data"]);
  });
});

/**
 * Parity with `createDeepAgent`, pinned as behavior rather than as a type.
 *
 * These cover the three facts the design turns on: the wrapper is what
 * `createDeepAgent` itself returns (not a bare graph), the graph behind it is a
 * real Pregel, and `withConfig` must rebuild the wrapper — because a compiled
 * graph's `withConfig` returns a *new* graph, so a namespace merely attached to
 * one is silently lost the first time anybody reconfigures it.
 */
describe("Deep Agents parity", () => {
  const governedRoot = () =>
    makeWorkspace({
      "workflows/p/workflow.yaml": ["states:", "  start: { triggers: { manual: } }"].join("\n"),
    });

  it("returns a wrapper exposing the framework surface, not a bare graph", async () => {
    const agent = await createAgent({
      workflow: "p",
      model: stubModel,
      workspace: { rootDir: governedRoot() },
    });

    for (const member of [
      "invoke",
      "stream",
      "streamEvents",
      "withConfig",
      "getState",
      "getStateHistory",
      "updateState",
      "getSubgraphs",
      "getSubgraphsAsync",
      "getGraphAsync",
    ]) {
      expect(typeof (agent as unknown as Record<string, unknown>)[member]).toBe("function");
    }
    // The wrapper is not itself the Pregel — that is what `.graph` is for.
    expect((agent as unknown as { lg_is_pregel?: boolean }).lg_is_pregel).toBeUndefined();
  });

  // Caught by a CLI smoke run, not by a unit test: `const { invoke } = agent` is
  // how a caller naturally reaches for one method, and an unbound prototype
  // method throws on the class's private field rather than failing as a missing
  // function. A public class has to tolerate being taken apart.
  /** Stand in for the compiled graph's stream: one `values` chunk, the config recorded. */
  function stubStream(agent: { graph: unknown }, seen: Array<Record<string, unknown>>) {
    (agent.graph as unknown as { stream: unknown }).stream = ((
      _input: unknown,
      config: Record<string, unknown>,
    ) => {
      seen.push(config);
      return Promise.resolve(
        (async function* () {
          yield ["values", { messages: [] }];
        })(),
      );
    }) as never;
  }

  it("survives being destructured", async () => {
    const agent = await createAgent({
      workflow: "p",
      model: stubModel,
      workspace: { rootDir: governedRoot() },
    });
    stubStream(agent, []);

    const { invoke, withConfig, getState } = agent;
    await expect(
      invoke({ messages: [] } as never, { configurable: { thread_id: "t" } }),
    ).resolves.toBeDefined();
    expect(() => withConfig({ recursionLimit: 5 })).not.toThrow();
    expect(typeof getState).toBe("function");
  });

  it("exposes the compiled graph as a real Pregel", async () => {
    const agent = await createAgent({
      workflow: "p",
      model: stubModel,
      workspace: { rootDir: governedRoot() },
    });
    expect((agent.graph as unknown as { lg_is_pregel?: boolean }).lg_is_pregel).toBe(true);
    expect(agent.graph.constructor.name).toBe("CompiledStateGraph");
  });

  it("keeps the governance namespace across withConfig, which a bare graph would not", async () => {
    const agent = await createAgent({
      workflow: "p",
      model: stubModel,
      workspace: { rootDir: governedRoot() },
    });
    const reconfigured = agent.withConfig({ recursionLimit: 100 });

    expect(reconfigured).not.toBe(agent);
    expect(reconfigured.workflow).toBeDefined();
    expect(reconfigured.workflow!.machine).toBe(agent.workflow!.machine);
    // The run-level surface survives too — it is on the wrapper, not the graph.
    expect(reconfigured.sessions).toBe(agent.sessions);

    // The contrast this design exists for: the graph drops what is attached to it.
    const attached = agent.graph as unknown as Record<string, unknown>;
    attached.workflow = { marker: true };
    expect((attached.withConfig as (c: unknown) => Record<string, unknown>)({}).workflow).toBeUndefined();
  });

  it("carries the deep-agent default config and lets a caller override it", async () => {
    const agent = await createAgent({
      workflow: "p",
      model: stubModel,
      workspace: { rootDir: governedRoot() },
    });
    const seen: Array<Record<string, unknown>> = [];
    stubStream(agent, seen);
    const session = { configurable: { thread_id: "t" } };

    await agent.invoke({ messages: [] } as never, session);
    expect((seen[0]?.metadata as Record<string, unknown>)?.ls_integration).toBe( "archmax-harness");
    // A turn runs under a generous default bound: one invoke is one whole turn
    // across states, and the authored budgets are the real limit.
    expect(AGENT_DEFAULT_CONFIG.recursionLimit).toBe(400);
    expect(seen[0]?.recursionLimit).toBe(400);
    // The runner drives the graph's native stream in values+messages mode.
    expect(seen[0]?.streamMode).toEqual(["values", "messages"]);

    await agent.invoke({ messages: [] } as never, { ...session, recursionLimit: 7 });
    expect(seen[1]?.recursionLimit).toBe(7);
  });

  it("namespaces governance and leaves run-level members on the agent", async () => {
    const governed = await createAgent({
      workflow: "p",
      model: stubModel,
      workspace: { rootDir: governedRoot() },
    });
    expect(governed.workflow?.name).toBe("p");
    expect(typeof governed.workflow?.resolveTrigger).toBe("function");

    const plain = await createAgent({
      model: stubModel,
      workspace: { rootDir: makeWorkspace({ "AGENTS.md": "# Agent\n" }) },
    });
    expect(plain.workflow).toBeUndefined();
    // An ungoverned run still has sessions and still writes artifacts.
    expect(typeof plain.sessions.list).toBe("function");
    expect(typeof plain.emitRunArtifacts).toBe("function");
    expect(typeof plain.getSpecSnapshot).toBe("function");
    expect(typeof plain.dispose).toBe("function");
  });
});

/**
 * Deep Agents appends its own base prompt ("You are a Deep Agent…") after a
 * string `systemPrompt`; verified against `createDeepAgent` directly during the
 * refactor and pinned here. The assembly hands `{ prefix, base: null }` instead,
 * so the model reads the harness's layers and the middleware's tool guidance only,
 * with the persona first.
 */
describe("prompt layering", () => {
  class CaptureModel extends SimpleChatModel {
    readonly systemPrompts: string[] = [];
    _llmType(): string {
      return "archmax-layer-capture";
    }
    bindTools(): BaseChatModel {
      return this as unknown as BaseChatModel;
    }
    async _call(messages: BaseMessage[]): Promise<string> {
      const system = messages.find((m) => m.getType() === "system");
      const content = system?.content;
      this.systemPrompts.push(
        typeof content === "string"
          ? content
          : (content ?? [])
              .map((block: unknown) =>
                typeof block === "object" && block && "text" in block ? String(block.text) : "",
              )
              .join("\n"),
      );
      return "done";
    }
  }

  it("drops the upstream base prompt and leads with the persona", async () => {
    const root = makeWorkspace({
      "AGENTS.md": "# Persona first\n",
      "workflows/p/workflow.yaml": ["states:", "  start: { triggers: { manual: } }"].join("\n"),
    });
    const model = new CaptureModel({});
    const agent = await createAgent({
      workflow: "p",
      model: model as unknown as BaseChatModel,
      systemPrompt: "Consumer layer.",
      workspace: { rootDir: root, sessionStore: createMemorySessionStore() },
      onEvent: () => {},
    });
    await agent.invoke({ messages: [{ role: "user", content: "hi" }] } as never, {
      configurable: { thread_id: "layers" },
    });
    const prompt = model.systemPrompts[0] ?? "";
    expect(prompt.startsWith("# Persona first")).toBe(true);
    expect(prompt).not.toContain("You are a Deep Agent");
    // The order the module header documents: persona → consumer → platform →
    // zones → the workflow header. The graph itself is not in the prefix at all.
    const at = (s: string) => prompt.indexOf(s);
    expect(at("# Persona first")).toBeLessThan(at("Consumer layer."));
    expect(at("Consumer layer.")).toBeLessThan(at("# Graph state execution"));
    expect(at("# Graph state execution")).toBeLessThan(at("## Workspace zones"));
    expect(at("## Workspace zones")).toBeLessThan(at("# Workflow"));
    // The cacheable prefix names no state of the machine.
    expect(prompt).not.toContain("`start`");
    expect(prompt).not.toContain("## States");
  });

  /** The first system prompt a one-turn session on `params` sends the model. */
  async function firstSystemPrompt(params: Parameters<typeof createAgent>[0]): Promise<string> {
    const model = new CaptureModel({});
    const agent = await createAgent({ ...params, model: model as unknown as BaseChatModel });
    await agent.invoke({ messages: [{ role: "user", content: "hi" }] } as never, {
      configurable: { thread_id: "platform" },
    });
    return model.systemPrompts[0] ?? "";
  }

  const oneState = ["states:", "  start: { triggers: { manual: } }"].join("\n");

  // The platform prompt ships in the code, so a custom backend that serves none
  // still gets it, where it used to get nothing and a warning.
  it("gives a governed agent on a custom backend the compiled-in platform prompt", async () => {
    const root = makeWorkspace({ "workflows/p/workflow.yaml": oneState });
    const events: WorkflowLifecycleEvent[] = [];
    const prompt = await firstSystemPrompt({
      workflow: "p",
      backend: new FilesystemBackend({ rootDir: root, virtualMode: true }),
      workspace: { mounts: {}, sessionStore: createMemorySessionStore() },
      onEvent: (event) => events.push(event),
    });
    expect(prompt).toContain("# Graph state execution");
    expect(events.filter((e) => e.type === "warning" && e.scope === "harness")).toEqual([]);
  });

  it("lets the workspace override the platform prompt", async () => {
    const root = makeWorkspace({
      "workflows/p/workflow.yaml": oneState,
      ".platform/system/GRAPH_STATE.md": "# House movement rules\n",
    });
    const prompt = await firstSystemPrompt({
      workflow: "p",
      workspace: { rootDir: root, sessionStore: createMemorySessionStore() },
      onEvent: () => {},
    });
    expect(prompt).toContain("# House movement rules");
    expect(prompt).not.toContain("# Graph state execution");
  });

  it("gives a plain agent no platform prompt, override or not", async () => {
    const root = makeWorkspace({
      "AGENTS.md": "# Agent\n",
      ".platform/system/GRAPH_STATE.md": "# House movement rules\n",
    });
    const prompt = await firstSystemPrompt({
      workflow: false,
      workspace: { rootDir: root, sessionStore: createMemorySessionStore() },
      onEvent: () => {},
    });
    expect(prompt).toContain("# Agent");
    expect(prompt).not.toContain("# House movement rules");
    expect(prompt).not.toContain("# Graph state execution");
  });
});

describe("workflow.send", () => {
  const root = () =>
    makeWorkspace({
      "workflows/p/workflow.yaml": ["states:", "  start: { triggers: { manual: } }"].join("\n"),
    });

  it("opens a turn on a new session and settles to one Outcome", async () => {
    const agent = await createAgent({
      workflow: "p",
      model: new FakeListChatModel({ responses: ["done"] }) as never,
      workspace: { rootDir: root(), sessionStore: createMemorySessionStore() },
      onEvent: () => {},
    });
    const outcome = await agent.workflow!.send("s1", { message: "hi" });
    expect(outcome.kind).toBe("completed");
    expect(outcome.disposition).toBe("turn");
    expect(outcome.reply).toBe("done");
    expect(outcome.state).toBe("start");
    expect((await agent.sessions.get("s1"))?.status).toBe("completed");
  });

  it("refuses a decision for a session nobody is holding", async () => {
    const agent = await createAgent({
      workflow: "p",
      model: new FakeListChatModel({ responses: ["done"] }) as never,
      workspace: { rootDir: root(), sessionStore: createMemorySessionStore() },
      onEvent: () => {},
    });
    await agent.workflow!.send("s2", { message: "hi" });
    await expect(agent.workflow!.send("s2", { decision: { target: "start" } })).rejects.toBeInstanceOf(
      SessionNotParkedError,
    );
  });

  it("is absent on a plain assembly, where toolMocks is also false", async () => {
    const agent = await createAgent({
      model: stubModel,
      workspace: { rootDir: makeWorkspace({ "AGENTS.md": "# p\n" }), sessionStore: createMemorySessionStore() },
      onEvent: () => {},
    });
    expect(agent.workflow).toBeUndefined();
    expect(agent.toolMocks).toBe(false);
  });
});

describe("createAgent ungoverned by declaration (workflow: false)", () => {
  const rootWithDefaultWorkflow = () =>
    makeWorkspace({
      "AGENTS.md": "# Agent\n",
      "workflows/order-lookup/workflow.yaml": ["states:", "  start: { triggers: { manual: } }"].join("\n"),
    });

  it("would be governed by the default workflow when one is found under the root", async () => {
    const agent = await createAgent({ model: stubModel, workspace: { rootDir: rootWithDefaultWorkflow() } });
    expect(agent.workflow?.name).toBe("order-lookup");
  });

  it("reads no spec and stays plain when the host says so", async () => {
    const reads: string[] = [];
    const authoring = {
      async readRaw(path: string) {
        reads.push(path);
        return { error: "missing" };
      },
    } as unknown as BackendProtocolV2;
    const agent = await createAgent({
      workflow: false,
      model: stubModel,
      authoring,
      workspace: { rootDir: rootWithDefaultWorkflow() },
    });
    expect(agent.workflow).toBeUndefined();
    expect(reads.filter((p) => p.includes("workflows/"))).toEqual([]);
  });

  it("honours the host's middleware on the plain path", async () => {
    const agent = await createAgent({
      workflow: false,
      model: stubModel,
      middleware: [createToolMockMiddleware()],
      workspace: { rootDir: makeWorkspace({ "AGENTS.md": "# Agent\n" }) },
    });
    expect(agent.workflow).toBeUndefined();
    expect(agent.toolMocks).toBe(true);
  });
});
