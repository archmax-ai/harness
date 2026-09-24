/**
 * Assembly: `createAgent` and its parameters.
 *
 * Takes Deep Agents' parameters verbatim and adds `workflow`: omit it for a
 * plain Deep Agent, supply it and the same agent is governed by that machine.
 * Every file the assembly reads — machine spec, system prompt, hook scripts,
 * scripts — is served through a configured backend, never via direct `fs`, and
 * the authored governance plane is served by a *separate* backend the agent's
 * workspace has no route to.
 */
import { randomUUID } from "node:crypto";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { mergeConfigs, type RunnableConfig } from "@langchain/core/runnables";
import type { StructuredTool } from "@langchain/core/tools";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { AgentMiddleware } from "langchain";
import type { BackendProtocolV2, CreateDeepAgentParams } from "deepagents";
import {
  AGENT_DEFAULT_CONFIG,
  ArchmaxAgent,
  type Agent,
  type AgentMembers,
  type TurnInput,
  type WorkflowSurface,
} from "../agent.js";
import type { CompiledAgentGraph } from "../core/deepagents.js";
import { consoleEventHandler, createWorkflowEventEmitter, type WorkflowEventHandler } from "../core/events.js";
import type { MountSpec } from "../core/mounts.js";
import type { SessionStore } from "../core/session-store.js";
import { DEFAULT_SKILL_SOURCES, discoverSkills, skillPrefixes } from "../core/skills.js";
import { createUsageTracker, type PricingTable } from "../core/usage.js";
import { createWorkspaceContext } from "../core/workspace-context.js";
import {
  createChatModel,
  loadDotenv,
  loadEnv,
  loadPricingEnv,
  type AgentEnv,
  type ModelFactory,
} from "../env.js";
import type { GovernanceRule } from "../kernel/kernel.js";
import type { HookExecutor } from "../lifecycle/runner.js";
import {
  loadMachineSpec,
  WorkflowDisabledError,
  WorkflowLoadError,
  type LoadSpecResult,
} from "../machine/load-spec.js";
import { WorkflowMachine } from "../machine/machine.js";
import { assertNoReservedToolNames } from "../machine/tool-names.js";
import { DEFAULT_TRIGGER_ID, resolveTrigger, type TriggerInput } from "../machine/triggers.js";
import { buildSeededVariables } from "../machine/variables.js";
import {
  isRuntimeContractSupported,
  resolveRuntimeContract,
  UnsupportedRuntimeContractError,
} from "../runtime/contract.js";
import type { SandboxRuntime } from "../sandbox/runtime.js";
import { rubricsAsSubagents, rubricsFromSpec, type Rubric } from "../rubrics/rubrics.js";
import {
  createArtifactEmitter,
  createSessionOperations,
  createSpecSnapshotReader,
} from "../sessions/operations.js";
import { resolveSession } from "../sessions/resolve.js";
import { decide, deliver, EmptyMessageError, outcomeOf, reply, resume, settle } from "../sessions/resume.js";
import { BackendCheckpointSaver } from "../workflow/checkpointer.js";
import { DEFAULT_WORKFLOW, workflowPaths } from "../workflow/paths.js";
import type { PromptCacheOptions } from "../workflow/prompt-cache.js";
import { createPlainTurnRunner } from "../workflow/turn-runner.js";
import { composeGoverned, renderSystemPrompt, sessionBinder, type AssemblyContext } from "./compose.js";
import { createDelegationRegistry } from "./delegation-registry.js";
import { composePlain } from "./plain.js";


/**
 * Workspace composition, grouped. `rootDir`, `mounts` and `sessionStore` all
 * answer one question — where this agent's files come from and where its
 * sessions go — and none of them exists in Deep Agents.
 */
export interface AgentWorkspaceParams {
  /**
   * Agent workspace root used by the default filesystem backend. Defaults to
   * the consumer's current working directory (the repository's
   * `examples/customer-support` is the reference workspace).
   */
  rootDir?: string;
  /**
   * Authored mounts as a `CompositeBackend` route table: key → backend, or
   * `{ backend, readOnly }`. A key ending in `/` is a directory mount; a key
   * without one (`"/AGENTS.md"`) is an exact-path file mount. Mounts are
   * read-only unless declared otherwise. Omitted on the default filesystem
   * backend, `defaultMounts(rootDir)` is applied — a convention, not a
   * constraint; spread it to extend. Omitted with a custom `backend`, nothing
   * authored is served: exposing it is an explicit act
   * (`mountSubtree(backend, "skills")`).
   */
  mounts?: Record<string, MountSpec>;
  /**
   * Physical storage for sessions — checkpoints, artifacts, scratchpad and
   * offloaded context. Build one with `createFilesystemSessionStore({ dir })`,
   * `createBackendSessionStore({ backend, prefix? })` or
   * `createMemorySessionStore()`. With the default backend this defaults to a
   * filesystem store at `<rootDir>/sessions`; with a custom `backend` it is
   * required — assembly throws `SessionStoreRequiredError` rather than inferring
   * storage.
   */
  sessionStore?: SessionStore;
}

/**
 * Parameters for {@link createAgent}.
 *
 * Every concept shared with LangChain Deep Agents keeps **Deep Agents' own name
 * and meaning** — `model`, `tools`, `systemPrompt`, `middleware`,
 * `backend`, `skills`, `checkpointer`, `store`, `interruptOn`, `name` — so a
 * `createDeepAgent` call ports by changing only the import, with one recorded
 * exception: there is no `subagents` parameter. An agent-facing subagent is not
 * a concept the archmax harness offers — grading is a **rubric** declared in `workflow.yaml`
 * and delegating work is a **sub-workflow** — so `task` is disclosed to no
 * state. The harness's concerns are otherwise strictly additive: `workflow`
 * (governance), `workspace` (file composition), `authoring` (the
 * governance-plane backend), and the extension points below.
 */
export interface CreateAgentParams {
  // --- Deep Agents parameters ---------------------------------------------
  /** Chat model; defaults to the env-configured OpenAI-compatible model. */
  model?: BaseChatModel;
  /**
   * Extra tools bound to the agent alongside the built-in sandbox and control
   * tools — e.g. resolved connector/MCP capabilities (see `toolsFromMap`).
   * Workflow governance still gates which of these the agent may call at any
   * given point; this only makes them exist as invokable functions.
   */
  tools?: StructuredTool[];
  /** Appended after the workspace's `AGENTS.md` in the system prompt. */
  systemPrompt?: string;
  /** Extra middleware appended after the runtime's own — the workflow instrumentation when governed (e.g. test mocks). Honoured on both paths. */
  middleware?: AgentMiddleware[];
  /**
   * Declares that authored content comes from somewhere other than the local
   * filesystem root — a store, sandbox, or remote Deep Agents backend. This
   * backend reaches the workspace only through `workspace.mounts`, and its
   * presence withdraws every zero-config default, so `workspace.sessionStore`
   * becomes required.
   */
  backend?: BackendProtocolV2;
  /**
   * Where the workspace's skills live, as **sources** read through the backend
   * — a parent directory of bundles (`"skills/"`) or a single bundle. Defaults
   * to `DEFAULT_SKILL_SOURCES` (`["skills/"]`). Pass `[]` for a workspace with
   * no skills.
   */
  skills?: string[];
  /**
   * LangGraph checkpointer — the custom-adapter escape hatch. Defaults to a
   * `BackendCheckpointSaver` that persists each session durably through the
   * session store (`<sessionId>/checkpoints/`), so sessions survive restarts
   * and can be listed and resumed. Supply a `MemorySaver` for ephemeral runs.
   */
  checkpointer?: BaseCheckpointSaver;
  /** LangGraph store, passed through to the framework untouched. */
  store?: CreateDeepAgentParams["store"];
  /**
   * Framework-level interrupt configuration, passed through untouched. Distinct
   * from a workflow `type: human` state, which parks through the machine.
   */
  interruptOn?: CreateDeepAgentParams["interruptOn"];
  /** Agent name, passed through for tracing and display. */
  name?: string;
  /** Human-readable description, passed through to graph compilation. */
  description?: string;

  // --- harness additions ----------------------------------------------------------------
  /**
   * The governance layer: a named workflow under `workflows/<slug>/`. Omit it
   * and the result is a plain Deep Agent — no machine, no `archmax_advance`, no
   * per-state gating — and `agent.workflow` is `undefined`. A named workflow
   * with no loadable spec throws {@link WorkflowLoadError} rather than silently
   * returning an ungoverned agent.
   *
   * Omitted, the default workflow (`DEFAULT_WORKFLOW`) is still *looked for* on
   * the authoring backend, and governs the agent when found. Pass `false` for an
   * agent that is ungoverned **by declaration**: no spec is read and no rubric
   * discovered, so a stray `workflows/` tree under the resolved root cannot
   * govern it.
   */
  workflow?: string | false;
  /** Where files come from and where sessions go. See {@link AgentWorkspaceParams}. */
  workspace?: AgentWorkspaceParams;
  /**
   * Backend serving the **authored governance plane** — machine specs,
   * `WORKFLOW.md` prose, lifecycle hook scripts, and cases. The agent's
   * workspace composite has no route to them. Defaults to `backend` when one is
   * supplied, else a filesystem backend over the resolved root. Handing it to a
   * *writable* mount fails assembly (`AuthoringBackendExposedError`).
   */
  authoring?: BackendProtocolV2;
  /** How a session is started when a turn names no trigger. Defaults to `{ id: "manual" }`. */
  trigger?: TriggerInput;
  /**
   * Variables seeded before any turn, keyed by name. Every seed is **locked**:
   * a host-supplied fact is exactly what a `${{name}}` guard should bind to. The
   * same seeds a delivery carries, the CLI takes (`--variables`) and a delegation
   * hands a child — one concept, one name.
   */
  variables?: Record<string, unknown>;
  /**
   * Where a firing's session id lives, as a dotted path over the variables
   * (`triggers.-1.conversationId`) — the same form a `triggers` entry declares,
   * applied to every firing this assembly resolves.
   */
  sessionPath?: string;
  /**
   * Supplies the chat model per role (`agent`, `judge`, `subagent`) so the
   * runtime can run against any LangChain `BaseChatModel`. When both `model`
   * and `modelFactory` are given, `model` wins for the agent role.
   */
  modelFactory?: ModelFactory;
  /**
   * Tool names to treat as always-on: disclosed and permitted in every state,
   * like the file tools. A per-state `tools.allow` entry naming one still
   * narrows it, and the safety/policy rules still bind.
   */
  essentialTools?: string[];
  /**
   * Custom governance rules inserted after the non-overridable safety rules and
   * the workflow `policy` rules, before the per-state `allow` defaults. A custom
   * rule may block a call a state would permit; it cannot loosen a safety rule.
   */
  policyRules?: GovernanceRule[];
  /**
   * Custom lifecycle hook-kind executors, registered alongside `script` and
   * `subagent`. Registering one under a built-in kind fails assembly.
   */
  hookExecutors?: Record<string, HookExecutor>;
  /** Script-execution backend for the sandbox tools and lifecycle scripts. Defaults to QuickJS. */
  sandboxRuntime?: SandboxRuntime;
  /**
   * Lifecycle event subscriber. When supplied, every runtime diagnostic is
   * delivered here as a typed event and the runtime writes nothing to the
   * console; when omitted, a default console subscriber renders them.
   */
  onEvent?: WorkflowEventHandler;
  /** Provider prompt caching for the stable prompt prefix (on by default, 5-minute lifetime). */
  promptCache?: PromptCacheOptions;
  /**
   * Token prices in USD per 1M tokens, keyed by model id (`default` applies to
   * any). Makes `costUsd` appear on usage events, in artifacts and in the CLI
   * footer; without pricing, cost is omitted — never guessed.
   */
  pricing?: PricingTable;
}

/** Assemble an agent. See the module note. */
export async function createAgent(params: CreateAgentParams = {}): Promise<Agent> {
  const workspaceParams = params.workspace ?? {};
  loadDotenv(workspaceParams.rootDir);
  // The namespace is a guarantee, not a convention: a host tool wearing it is
  // refused before anything is assembled, on both paths.
  assertNoReservedToolNames(params.tools);
  // `false` declares the agent ungoverned: nothing is looked for. Otherwise a
  // named workflow — or the default — is read off the authoring backend.
  const governed = params.workflow !== false;
  const workflowName = params.workflow === false ? "" : (params.workflow ?? DEFAULT_WORKFLOW);
  const paths = workflowPaths(workflowName);

  // Root resolution and backend selection (session store as the workspace root +
  // read-only authored mounts) are the shared context's. A custom backend without a session store fails here.
  const { backend, workspace, authoring, sessionZone, sessionStore, mountPrefixes } =
    createWorkspaceContext({
      rootDir: workspaceParams.rootDir,
      backend: params.backend,
      ...(workspaceParams.mounts ? { mounts: workspaceParams.mounts } : {}),
      ...(workspaceParams.sessionStore ? { sessionStore: workspaceParams.sessionStore } : {}),
      ...(params.authoring ? { authoring: params.authoring } : {}),
    });

  // Sessions are durable by default: the checkpointer writes through the
  // session zone, so a session survives restarts and can be listed and resumed.
  const checkpointer = params.checkpointer ?? new BackendCheckpointSaver(workspace);

  // The usage tracker sits in the event chain so a session's totals are known
  // where artifacts are written; every event still reaches `onEvent` (or the
  // console).
  const usage = createUsageTracker({ onEvent: params.onEvent ?? consoleEventHandler });
  const emit = createWorkflowEventEmitter((event) => usage.handler(event));

  // Load the machine spec once from workflow.yaml (the sole spec source).
  const loaded: LoadSpecResult = governed
    ? await loadMachineSpec(authoring, paths)
    : { spec: null, issues: [], lint: [], body: "", specFile: paths.workflowYaml, usable: false };
  for (const issue of [...loaded.issues, ...loaded.lint]) {
    if (issue.kind !== "missing") emit({ type: "warning", scope: "workflow", message: issue.message });
  }

  // Grading rubrics come from the spec that was just loaded — no directory to
  // list, no file format to parse, and nothing to merge: a grader is declared on
  // the hook that applies it, so it arrives with the machine and is scoped to it.
  const rubrics = rubricsFromSpec(loaded.spec ?? { states: {} });

  // Skills are discovered once; the resolved registry is the single input to
  // what the kernel refuses, what the prompt names, and what a listing returns.
  const skillSources = params.skills ?? [...DEFAULT_SKILL_SOURCES];
  const skillRegistry = await discoverSkills(workspace, skillSources, emit);

  const machine =
    loaded.usable && loaded.spec
      ? WorkflowMachine.fromSpec(loaded.spec, params.essentialTools)
      : null;

  // Fail closed when governance was requested but cannot be loaded. The plain
  // agent remains for the unrequested-default case with no definition, and for
  // `workflow: false`.
  if (!machine && governed) {
    const fileMissing = loaded.issues.some((i) => i.kind === "missing");
    if (!fileMissing) throw new WorkflowLoadError(workflowName, loaded.specFile, "no valid machine spec");
    if (params.workflow !== undefined) {
      throw new WorkflowLoadError(workflowName, paths.workflowYaml, "no workflow.yaml found");
    }
  }

  // Enforce the runtime contract before any model-driven work.
  const runtimeContract = resolveRuntimeContract(machine?.spec.runtime);
  if (machine && !isRuntimeContractSupported(runtimeContract)) {
    throw new UnsupportedRuntimeContractError(runtimeContract);
  }

  // Models per role. `env` is a thunk, so `.env` variables are required only by
  // what actually reads them: a caller supplying an explicit `model` never loads it.
  let cachedEnv: AgentEnv | undefined;
  const env = (): AgentEnv => (cachedEnv ??= loadEnv());
  const model = params.model ?? (params.modelFactory ? params.modelFactory("agent", env) : createChatModel());
  // The model a *state* runs on: a workflow may name an id at either position
  // (`settings.model`, a state's `model`), resolved through the same factory seam
  // as every other model and memoized per distinct id, so one model is built per
  // id per assembly however many turns run on it.
  //
  // An explicit `model` outranks every declared id: a host that constructed an
  // instance means it, and the SDK cannot rebuild that instance under another id
  // without guessing at its provider. The composition says so once (see
  // `resolveStateModels`) rather than ignoring the declaration in silence.
  const agentModels = new Map<string, BaseChatModel>([["", model]]);
  const agentModel = (id?: string): BaseChatModel => {
    const key = params.model !== undefined ? "" : (id ?? "");
    let resolved = agentModels.get(key);
    if (!resolved) {
      resolved = params.modelFactory
        ? params.modelFactory("agent", env, key)
        : createChatModel({ ...env(), model: key });
      agentModels.set(key, resolved);
    }
    return resolved;
  };
  // Pricing feeds `costUsd` on usage events (host option first, then env).
  const pricing = params.pricing ?? loadPricingEnv();
  // The grader's model: a rubric may name its own id, resolved through the same
  // factory seam as every other model, and memoized per distinct id so one model
  // is built per id per assembly.
  const rubricModels = new Map<string, BaseChatModel | undefined>();
  const rubricModel = (rubric: Rubric): BaseChatModel | undefined => {
    const key = rubric.model ?? "";
    if (!rubricModels.has(key)) {
      rubricModels.set(
        key,
        params.modelFactory
          ? params.modelFactory("rubric", env, rubric.model)
          : rubric.model !== undefined
            ? createChatModel({ ...env(), model: rubric.model })
            : undefined,
      );
    }
    return rubricModels.get(key);
  };

  const ctx: AssemblyContext = {
    params,
    workflowName,
    workspace,
    authoring,
    backend,
    sessionZone,
    sessionStore,
    mountPrefixes,
    checkpointer,
    emit,
    usage,
    model,
    agentModel,
    honoursDeclaredModels: params.model === undefined,
    rubrics,
    rubricModel,
    subagents: rubricsAsSubagents(rubrics, rubricModel),
    skillSources,
    skillRegistry,
    skillTable: skillPrefixes(skillRegistry),
    runtimeContract,
    ...(pricing ? { pricing } : {}),
  };

  const systemPrompt = await renderSystemPrompt(ctx, machine, loaded.body, { workflow: workflowName });
  if (skillRegistry.size > 0) emit({ type: "skills-loaded", names: [...skillRegistry.keys()] });

  // The session-level members every agent carries, governed or plain.
  const members = (graph: CompiledAgentGraph, dispose: (sessionId: string) => void, toolMocks: boolean): AgentMembers => ({
    dispose,
    runtimeContract,
    toolMocks,
    emitRunArtifacts: createArtifactEmitter({ graph, machine, workspace, workflowName, runtimeContract, usage, emit }),
    sessions: createSessionOperations({ checkpointer, sessionStore, workspace, mountPrefixes, dispose }),
    getSpecSnapshot: createSpecSnapshotReader(workspace),
  });

  if (!machine) {
    const plain = composePlain(ctx, systemPrompt);
    // Bound like a governed session: `configurable.thread_id` names the session
    // whose zone the agent's id-free paths resolve in.
    const driver = createPlainTurnRunner({ graph: plain.graph, bindSession: sessionBinder(ctx) });
    return new ArchmaxAgent({
      graph: plain.graph,
      members: members(plain.graph, () => {}, plain.toolMocks),
      driver,
    });
  }

  const registry = createDelegationRegistry(ctx, machine);
  const composed = await composeGoverned(ctx, {
    machine,
    workflow: workflowName,
    systemPrompt,
    ...(params.trigger ? { trigger: params.trigger } : {}),
    ...(params.variables ? { variables: params.variables } : {}),
    registry,
  });
  const agentMembers = members(composed.graph, composed.dispose, composed.toolMocks);
  const { resumable, driver } = composed;

  const workflow: WorkflowSurface = {
    name: workflowName,
    machine,
    resolveTrigger: (trigger) => resolveTrigger(machine, trigger),
    decide: (sessionId, resolution) => decide(resumable, sessionId, resolution),
    reply: (sessionId, message) => reply(resumable, sessionId, message),
    deliver: (sessionId, delivery) => deliver(resumable, sessionId, delivery),
    resolveSession: (input) =>
      resolveSession(
        machine,
        {
          // The id *is* the address: one direct projection, no mapping step.
          findSession: (sessionId) => agentMembers.sessions.get(sessionId),
          mintSessionId: () => `session-${randomUUID()}`,
        },
        { ...(params.sessionPath ? { sessionPath: params.sessionPath } : {}), ...input },
        (message) => emit({ type: "warning", scope: "session", message }),
      ),
    send: async (sessionId, input, config) => {
      if ("decision" in input) return outcomeOf(await resume(resumable, sessionId, input, config), "decide");
      if ("delivery" in input) return outcomeOf(await resume(resumable, sessionId, input, config), "deliver");
      // A turn: the session's disposition decides whether it is a fresh turn, a
      // reply to a person's hold, or a delivery to a waiting park.
      const turn = input as TurnInput;
      const resolved = await workflow.resolveSession({
        sessionId,
        ...(turn.trigger ? { trigger: turn.trigger } : {}),
        ...(turn.variables ? { variables: turn.variables } : {}),
        ...(turn.sessionPath ? { sessionPath: turn.sessionPath } : {}),
      });
      if (resolved.disposition === "reply") {
        return outcomeOf(await resume(resumable, sessionId, { message: turn.message }, config), "reply");
      }
      if (resolved.disposition === "resume") {
        // The person's message travels with the firing rather than being dropped.
        const delivery = {
          trigger: turn.trigger ?? { id: DEFAULT_TRIGGER_ID },
          ...(turn.variables ? { variables: turn.variables } : {}),
          ...(turn.message?.trim() ? { message: turn.message } : {}),
        };
        return outcomeOf(await resume(resumable, sessionId, { delivery }, config), "deliver");
      }
      if (machine.disabled) throw new WorkflowDisabledError(workflowName);
      const message = (turn.message ?? "").trim();
      if (!message) throw new EmptyMessageError(sessionId);
      const trigger = { id: resolveTrigger(machine, turn.trigger).id };
      const turnConfig: RunnableConfig = mergeConfigs(AGENT_DEFAULT_CONFIG, config, {
        configurable: { thread_id: sessionId },
      });
      const result = await driver.invoke(
        {
          messages: [{ role: "user", content: message }],
          trigger,
          // Seeded per turn, locked, like a delivery's seeds; the channel's
          // merge keeps the first lock, so a later seed cannot overwrite it.
          ...(turn.variables ? { variables: buildSeededVariables(turn.variables) } : {}),
        },
        turnConfig,
      );
      return outcomeOf(settle(result, sessionId), "turn");
    },
  };

  return new ArchmaxAgent({
    graph: composed.graph,
    members: agentMembers,
    driver,
    workflow,
  });
}
