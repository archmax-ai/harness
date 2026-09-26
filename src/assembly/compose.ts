/**
 * The governed composition: one Deep Agent whose compiled graph carries the
 * machine's position, variables, trail and park records as channels, with the
 * governance middleware enforcing the machine at every turn boundary, model
 * call and tool call.
 *
 * Factored out of `createAgent` so a sub-workflow is composed the same way for
 * a different machine: the {@link AssemblyContext} is everything a composition
 * shares with the root; the machine, its system prompt, its trigger and any
 * inherited denials are what varies.
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredTool } from "@langchain/core/tools";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { mergeConfigs } from "@langchain/core/runnables";
import { todoListMiddleware, type AgentMiddleware } from "langchain";
import { createDeepAgent, type BackendProtocolV2, type CreateDeepAgentParams } from "deepagents";
import { AGENT_DEFAULT_CONFIG } from "../agent.js";
import {
  asCompiledAgentGraph,
  asDecisionGraph,
  type CompiledAgentGraph,
  type IntrospectableStateGraph,
} from "../core/deepagents.js";
import { withEventContext, type WorkflowEventEmitter } from "../core/events.js";
import { resolveSystemPrompt } from "../core/prompt.js";
import { SessionStoreIdError, sessionIdRejection, type SessionStore } from "../core/session-store.js";
import type { SessionZoneRouter } from "../core/session-zone.js";
import type { SkillPrefixes, SkillRegistry } from "../core/skills.js";
import { TOOL_MOCK_MIDDLEWARE_NAME } from "../core/tool-mocks.js";
import type { PricingTable, UsageTracker } from "../core/usage.js";
import type { Workspace } from "../core/workspace.js";
import type { MountPrefixes } from "../core/zones.js";
import { loadPromptCacheEnv } from "../env.js";
import { BUILTIN_HOOK_KINDS } from "../lifecycle/runner.js";
import {
  compileForbiddenSkillRules,
  compileForbiddenMountRules,
  compileForbidRules,
  type GovernanceRule,
} from "../kernel/kernel.js";
import { UNGRANTABLE_TOOLS, type WorkflowMachine } from "../machine/machine.js";
import { WorkflowLoadError } from "../machine/load-spec.js";
import { workflowToolName } from "../machine/tool-names.js";
import { resolveTrigger, type TriggerInput } from "../machine/triggers.js";
import { buildSeededVariables, unguaranteedReferenceWarnings } from "../machine/variables.js";
import type { ResolvedRuntimeContract } from "../runtime/contract.js";
import { createScriptExecutor } from "../sandbox/executor.js";
import { createPtcToolGateway } from "../sandbox/ptc-gateway.js";
import { createQuickJsSandboxRuntime } from "../sandbox/runtime.js";
import { createInterpreter } from "../sandbox/tools.js";
import type { LoadedRubric, Rubric } from "../rubrics/rubrics.js";
import { createWorkflowInstrumentation, type StateModels } from "../workflow/middleware.js";
import { resolveHookScript, workflowPaths } from "../workflow/paths.js";
import {
  createProviderCacheMiddleware,
  modelIdOf,
  NATIVE_CACHE_STRATEGIES,
  resolveCacheStrategy,
  resolvePromptCacheConfig,
  type PromptCacheStrategy,
} from "../workflow/prompt-cache.js";
import { renderWorkflowPrompt, stripHtmlComments } from "../workflow/render-prompt.js";
import { describeMachineTopology } from "../workflow/session-artifacts.js";
import { workflowStateSchema } from "../workflow/state.js";
import {
  createSubWorkflowDispatcher,
  SubWorkflowError,
  type SubWorkflowRegistry,
} from "../workflow/sub-workflow.js";
import { createTurnRunner, type TurnRunner } from "../workflow/turn-runner.js";
import { createDelegationTool } from "../workflow/workflow-tools.js";
import type { CreateAgentParams } from "./index.js";

/**
 * Everything one assembly resolved once and every composition it makes shares.
 * Built by `createAgent`, consumed by {@link composeGoverned}, the plain
 * composition and the delegation registry.
 */
export interface AssemblyContext {
  params: CreateAgentParams;
  /** The root workflow's slug — what a diagnostic names, and what a child inherits denials from. */
  workflowName: string;
  workspace: Workspace;
  authoring: Workspace;
  backend: BackendProtocolV2;
  sessionZone: SessionZoneRouter;
  sessionStore: SessionStore;
  mountPrefixes: MountPrefixes;
  checkpointer: BaseCheckpointSaver;
  emit: WorkflowEventEmitter;
  usage: UsageTracker;
  model: BaseChatModel;
  /**
   * The model a **state** runs on: the id it declares (or its workflow's
   * `settings.model`) resolved through the assembly's factory seam and memoized
   * per distinct id; no id resolves to {@link AssemblyContext.model}. Held on the
   * context so a delegated child — governed by its own machine, declaring its own
   * ids — resolves them exactly as the root does.
   */
  agentModel: (id?: string) => BaseChatModel;
  /**
   * Whether a declared id reaches a model at all. `false` when the host handed
   * `createAgent` an explicit `model` instance, which outranks every declaration;
   * each composition then reports its own inert ids once.
   */
  honoursDeclaredModels: boolean;
  rubrics: Map<string, Rubric>;
  /**
   * The model a rubric grades on: its declared `model` resolved through the
   * assembly's factory seam, else the `rubric`-role model. Held on the context so
   * a delegated child — which builds its own registry from its own spec — resolves
   * graders the same way the root does.
   */
  rubricModel: (rubric: Rubric) => BaseChatModel | undefined;
  /** Every subagent the assembly dispatches to, file-loaded and inline, in the Deep Agents shape. */
  subagents: LoadedRubric[];
  skillSources: string[];
  skillRegistry: SkillRegistry;
  skillTable: SkillPrefixes;
  runtimeContract: ResolvedRuntimeContract;
  /** Token prices, from the host option or the environment; absent means cost is never reported. */
  pricing?: PricingTable;
}

/** What one governed composition is made for. */
export interface ComposeInput {
  /** The machine this composition is governed by — the root's, or a delegated one's. */
  machine: WorkflowMachine;
  /** That machine's slug, so a diagnostic about it can name it. */
  workflow: string;
  /** The fully resolved system prompt for that machine. */
  systemPrompt: string;
  /** The assembly-time default trigger. */
  trigger?: TriggerInput;
  /** Host seeds for sessions of this machine (a child seeds per dispatch instead). */
  variables?: Record<string, unknown>;
  /**
   * Denials compiled from every ancestor's `policy`, evaluated ahead of this
   * machine's per-state grants so a delegated machine can narrow what is
   * permitted but never re-grant what an ancestor forbade.
   */
  inheritedPolicyRules?: GovernanceRule[];
  /** Child compositions, resolved lazily by slug. */
  registry: SubWorkflowRegistry;
}

/** One composed governed agent. */
export interface Composed {
  graph: CompiledAgentGraph;
  /** The session-bound turn runner every entry into a session goes through. */
  driver: TurnRunner;
  /** Release every per-session resource this composition holds. */
  dispose: (sessionId: string) => void;
  /** Whether the tool-mock middleware is wired (see `Agent.toolMocks`). */
  toolMocks: boolean;
  /**
   * The graph as a resume reads and drives it: `getState` off the compiled
   * graph, `invoke` through the turn runner under the agent's default config.
   */
  resumable: IntrospectableStateGraph;
}

/**
 * The Deep Agents options the assembly accepts and forwards untouched, in one
 * place so the governed and plain compositions cannot drift about which reach
 * the framework.
 */
export function frameworkPassthrough(
  params: CreateAgentParams,
): Pick<CreateDeepAgentParams, "store" | "interruptOn" | "name"> {
  return {
    ...(params.store ? { store: params.store } : {}),
    ...(params.interruptOn ? { interruptOn: params.interruptOn } : {}),
    ...(params.name ? { name: params.name } : {}),
  };
}

/**
 * The planning scratchpad: `write_todos` is always-on and deepagents 1.11.1 does
 * not register it, so the assembly installs langchain's `todoListMiddleware`.
 * Must sit outermost among the runtime's own middleware so its guidance lands on
 * the system prompt **before** the workflow instrumentation splits it into
 * `[static, volatile]` blocks.
 */
export function todoMiddleware(): AgentMiddleware {
  return todoListMiddleware() as unknown as AgentMiddleware;
}

/**
 * The subagent parameters both compositions hand the framework: the workflow's
 * grading rubrics, registered so the framework provides the `task` tool the
 * runtime dispatches them through.
 *
 * They are never *disclosed* — `task` is withheld in every state and grantable by
 * nothing — so registering a grader here gives the graded agent no reach; it only
 * gives the runtime a runnable. `generalPurposeAgent: false` holds
 * unconditionally: there is no agent-facing subagent in this SDK, so the
 * framework's default general-purpose one would be a tool nothing may call.
 */
export function rubricParams(ctx: AssemblyContext): {
  subagents: LoadedRubric[];
  generalPurposeAgent: boolean;
} {
  return { subagents: ctx.subagents, generalPurposeAgent: false };
}

/**
 * Bind `fn` to a session: the session zone's view (agent-visible paths resolve
 * against that session without its id embedded) plus the event envelope's
 * session context. The single ingress where a session id becomes a store
 * address, so it refuses an id that would escape the session zone or shadow a
 * reserved root name.
 */
export function sessionBinder(ctx: AssemblyContext): <T>(sessionId: string, fn: () => Promise<T>) => Promise<T> {
  return (sessionId, fn) => {
    const rejection = sessionIdRejection(sessionId, ctx.mountPrefixes);
    if (rejection) throw new SessionStoreIdError(sessionId, rejection);
    return withEventContext({ sessionId }, () => ctx.sessionZone.sessionScoped(sessionId, fn));
  };
}

/**
 * The system prompt for one machine: the spec-rendered workflow header followed
 * by the `WORKFLOW.md` prose (HTML comments stripped — notes for whoever opens
 * the file, not for the model), layered with the persona, the platform prompt and
 * the workspace zones by `resolveSystemPrompt`. The graph itself is not here: it
 * is disclosed per model call, for the active state only, by the middleware. A
 * plain agent (no machine) gets no platform prompt: it explains a graph there is
 * none of.
 */
export function renderSystemPrompt(
  ctx: AssemblyContext,
  machine: WorkflowMachine | null,
  body: string,
  options: { workflow: string },
): Promise<string> {
  const prose = stripHtmlComments(body).trim();
  const workflowPrompt = machine
    ? [renderWorkflowPrompt(machine), prose].filter(Boolean).join("\n\n")
    : prose || null;
  return resolveSystemPrompt(ctx.workspace, {
    platformBackendPath: machine ? workflowPaths(options.workflow).platformPrompt : null,
    workflowPrompt,
    mountPrefixes: ctx.mountPrefixes,
    extra: ctx.params.systemPrompt,
  });
}

/**
 * The models one governed composition runs on: the workflow's own (its
 * `settings.model`, else the assembly default) and, per state, whatever that
 * state declares. Resolved here, once per composition, so a configuration
 * problem surfaces at assembly rather than mid-session and the per-call path is
 * a map lookup.
 *
 * The cache strategy travels with the model, because that is what it is a
 * property of: a state running on Claude behind an OpenAI-compatible endpoint
 * needs the explicit breakpoint whatever the workflow's own model is.
 */
function resolveStateModels(
  ctx: AssemblyContext,
  machine: WorkflowMachine,
  workflow: string,
  cacheEnabled: boolean,
): { workflowModel: BaseChatModel; workflowCacheStrategy: PromptCacheStrategy; stateModels: StateModels } {
  const { emit } = ctx;
  const declared = machine.declaredModels();
  const warn = (message: string) => emit({ type: "warning", scope: "workflow", message });

  // An explicit `model` instance outranks every declared id (see `createAgent`).
  // Reported once per composition, naming every position it makes inert, so a
  // host learns that `modelFactory` is what honours a declaration.
  if (!ctx.honoursDeclaredModels && declared.length > 0) {
    warn(
      `Workflow '${workflow}' declares ${describeDeclaredModels(machine)}, but an explicit ` +
        `'model' was passed to createAgent, which outranks a declared id: every state runs on ` +
        `the supplied model. Pass 'modelFactory' instead — it is called for the 'agent' role ` +
        `with the declared id as 'requested'.`,
    );
  }

  // The id of a model, read from the instance so every route to one answers the
  // same way — a declared id, `ARCHMAX_MODEL`, an explicit `model`, a
  // `modelFactory`. Memoized per instance beside the cache strategy, which is
  // the other thing resolved once here rather than per call. A model exposing no
  // id resolves to `undefined`: cost then falls back to the response's own id or
  // is omitted, exactly as before.
  const ids = new Map<BaseChatModel, string | undefined>();
  const idOf = (model: BaseChatModel): string | undefined => {
    if (!ids.has(model)) ids.set(model, modelIdOf(model) || undefined);
    return ids.get(model);
  };

  const strategies = new Map<BaseChatModel, PromptCacheStrategy>();
  const strategyOf = (model: BaseChatModel): PromptCacheStrategy => {
    let strategy = strategies.get(model);
    if (strategy === undefined) {
      strategy = resolveCacheStrategy(model, cacheEnabled);
      // `unsupported` is not warned about: the providers behind such a model cache
      // a stable prefix automatically, and the `prompt-shaping` event names it.
      strategies.set(model, strategy);
    }
    return strategy;
  };

  const workflowModel = ctx.agentModel(machine.spec.settings?.model);
  const workflowCacheStrategy = strategyOf(workflowModel);

  // Built here, not per call: one model per distinct id, and an id the endpoint
  // cannot serve fails while assembling rather than in the middle of a session.
  const byState = new Map<string, BaseChatModel>();
  for (const state of Object.keys(machine.spec.states)) {
    const id = machine.modelFor(state);
    if (id === undefined || id === machine.spec.settings?.model) continue;
    byState.set(state, ctx.agentModel(id));
  }

  // LangChain's native caching middlewares are graph-level and cannot vary per
  // call, so they stay wired from the workflow's model; a state whose model
  // wants a different native mechanism is named rather than silently mis-cached.
  for (const [state, model] of byState) {
    const strategy = strategyOf(model);
    if (!NATIVE_CACHE_STRATEGIES.has(strategy) && !NATIVE_CACHE_STRATEGIES.has(workflowCacheStrategy)) {
      continue;
    }
    if (strategy === workflowCacheStrategy) continue;
    warn(
      `State '${state}' of workflow '${workflow}' runs on a model whose prompt-cache mechanism ` +
        `('${strategy}') differs from the workflow model's ('${workflowCacheStrategy}'). ` +
        `Provider-native caching is graph-level and stays wired from the workflow model, so ` +
        `this state's calls are cached as '${workflowCacheStrategy}' allows.`,
    );
  }

  return {
    workflowModel,
    workflowCacheStrategy,
    stateModels: {
      modelFor: (state) => byState.get(state),
      cacheStrategyFor: (state) => {
        const model = byState.get(state);
        return model ? strategyOf(model) : workflowCacheStrategy;
      },
      idFor: (state) => idOf(byState.get(state) ?? workflowModel),
    },
  };
}

/** The declared model positions, as a diagnostic names them. */
function describeDeclaredModels(machine: WorkflowMachine): string {
  const positions: string[] = [];
  if (machine.spec.settings?.model) positions.push(`settings.model '${machine.spec.settings.model}'`);
  for (const [state, declaration] of Object.entries(machine.spec.states)) {
    if (declaration?.model) positions.push(`states.${state}.model '${declaration.model}'`);
  }
  return positions.join(", ");
}

/** Compose one governed agent for `input.machine`. */
export async function composeGoverned(ctx: AssemblyContext, input: ComposeInput): Promise<Composed> {
  const { params, emit, workspace, authoring } = ctx;
  const target = input.machine;
  const governanceRules = [...(input.inheritedPolicyRules ?? []), ...(params.policyRules ?? [])];
  const settings = target.harnessSettings;

  // Two executors, one sandbox runtime: agent scripts read sources from the
  // agent workspace, hook scripts from the authoring plane the agent cannot
  // address. Sharing the runtime keeps a session's REPL a single session.
  const sandboxRuntime = params.sandboxRuntime ?? createQuickJsSandboxRuntime();
  const sandboxLimits = {
    timeoutMs: settings.timeoutMs,
    memoryLimitBytes: settings.memoryLimitBytes,
    maxPtcCalls: settings.maxPtcCalls,
    maxResultChars: settings.maxResultChars,
    sandboxRuntime,
  };
  const sandboxVersion = ctx.runtimeContract.sandbox;
  const executor = createScriptExecutor({ workspace, sandboxVersion, ...sandboxLimits });
  const hookExecutor = createScriptExecutor({ workspace: authoring, sandboxVersion, ...sandboxLimits });
  // One gateway for both programmatic-tool-call consumers — the model's own
  // sandbox code and lifecycle hook scripts — so a script's `tools.*` call is
  // governed and instrumented by the same kernel and event stream.
  const ptcGateway = createPtcToolGateway({
    machine: target,
    policyRules: governanceRules,
    mountPrefixes: ctx.mountPrefixes,
    skills: ctx.skillTable,
    emit,
  });
  const interpreter = createInterpreter({ executor, ptcNames: [], ptcGateway });
  emit({ type: "interpreter-enabled" });

  // Consumer hook executors may not shadow the built-in kinds.
  const shadowed = Object.keys(params.hookExecutors ?? {}).filter((kind) =>
    (BUILTIN_HOOK_KINDS as readonly string[]).includes(kind),
  );
  if (shadowed.length > 0) {
    throw new Error(
      `hookExecutors may not override built-in hook kind(s): ${shadowed.join(", ")}. ` +
        `Register a custom kind under a different name.`,
    );
  }

  // Prompt caching: resolved from the models once, here, so an unsupported model
  // is reported at assembly rather than discovered per call.
  const cacheConfig = resolvePromptCacheConfig({
    option: params.promptCache,
    spec: settings.promptCache,
    env: loadPromptCacheEnv(),
  });
  // Which model each state runs on, and therefore which cache mechanism its
  // calls use. `workflowModel` is this machine's own — `settings.model` when it
  // declares one — so the graph default and the native caching middleware follow
  // the workflow rather than the process environment.
  const { workflowModel, workflowCacheStrategy: cacheStrategy, stateModels } = resolveStateModels(
    ctx,
    target,
    input.workflow,
    cacheConfig.enabled,
  );
  // Conditional built-ins no state of this workflow discloses: reported so the
  // saving is visible, and used to prune the matching upstream prompt guidance.
  const disclosedAnywhere = new Set(
    Object.keys(target.spec.states).flatMap((slug) => [...target.disclosedTools(slug)]),
  );
  // `task` is withheld in every state of every assembly, so its upstream
  // guidance is pruned unconditionally rather than per-assembly.
  const withheldBuiltins = [...UNGRANTABLE_TOOLS].filter((tool) => !disclosedAnywhere.has(tool));
  emit({ type: "prompt-shaping", cache: cacheStrategy, withheld: withheldBuiltins });

  // One dispatcher per composition, so the depth, cycle and concurrency bounds
  // are enforced in one place and every dispatch is reported the same way. A
  // child of this composition inherits what it inherited plus its own policy:
  // denials accumulate down the chain, never resetting to the root's.
  const dispatcher = createSubWorkflowDispatcher({
    registry: input.registry,
    machine: target,
    childPolicyRules: [
      ...(input.inheritedPolicyRules ?? []),
      ...workflowDenials(target, input.workflow),
    ],
    onEvent: emit,
  });

  // Validate the assembly-time default trigger (fails closed on an unknown id).
  const defaultTrigger = resolveTrigger(target, input.trigger);

  const seededVariables = buildSeededVariables(input.variables);
  for (const message of unguaranteedReferenceWarnings(target, seededVariables)) {
    emit({ type: "warning", scope: "workflow", message });
  }

  const instrumentation = createWorkflowInstrumentation({
    machine: target,
    executor,
    hookExecutor,
    // Hook paths are workflow-relative and confined to this workflow's `hooks/`.
    resolveHookScript: (declared) => resolveHookScript(input.workflow, declared),
    rubrics: ctx.rubrics,
    ptcNames: [],
    policyRules: governanceRules,
    mountPrefixes: ctx.mountPrefixes,
    skills: ctx.skillRegistry,
    ptcGateway,
    subWorkflows: dispatcher,
    ...(params.hookExecutors ? { hookExecutors: params.hookExecutors } : {}),
    onEvent: emit,
    promptShaping: { cacheStrategy, cacheTtl: cacheConfig.ttl, withheldBuiltins },
    stateModels,
    workspace,
    workflowName: input.workflow,
    trigger: { id: defaultTrigger.id },
    seededVariables,
    ...(ctx.pricing ? { pricing: ctx.pricing } : {}),
  });

  // Native Anthropic/Bedrock caching is LangChain's own middleware; the
  // OpenAI-compatible Claude path is marked by the workflow instrumentation.
  const providerCacheMiddleware = createProviderCacheMiddleware(cacheStrategy, cacheConfig.ttl);

  // The suspension site leads: it has to be the first middleware with an
  // `afterModel` hook, so its hook runs last after the model and the final
  // router honours its jumps (see `WorkflowInstrumentation`).
  const agentMiddleware = [
    instrumentation.parkMiddleware,
    todoMiddleware(),
    interpreter.middleware,
    instrumentation.middleware,
    ...(providerCacheMiddleware ? [providerCacheMiddleware] : []),
    ...(params.middleware ?? []),
  ];

  // One tool per sibling this machine's allow lists name. A delegation tool's
  // schema feeds the system prompt, so an unusable target fails assembly.
  const delegationTools: StructuredTool[] = [];
  for (const slug of target.delegationTargets()) {
    let signature: Awaited<ReturnType<SubWorkflowRegistry["signature"]>>;
    try {
      signature = await input.registry.signature(slug);
    } catch (err) {
      const raw = err instanceof SubWorkflowError ? err.message : String(err);
      const detail = raw.replace(/^Cannot run sub-workflow '[^']*':\s*/, "");
      throw new WorkflowLoadError(
        input.workflow,
        workflowPaths(input.workflow).workflowYaml,
        `it allows '${workflowToolName(slug)}', but ${detail}`,
      );
    }
    // `disabled` is dropped: a description is built once at assembly, so
    // "currently disabled" would be stale and destabilize the cacheable prefix.
    const { disabled: _disabled, ...described } = signature;
    delegationTools.push(createDelegationTool({ workflow: slug, ...described }, dispatcher, target.entry));
  }

  const deepAgent = createDeepAgent({
    // The workflow's own model is the graph default; a state that declares its
    // own is switched onto it per call by the governance middleware.
    model: workflowModel,
    backend: ctx.backend,
    // Deliberately no `skills`: upstream's section cannot vary per state; the
    // workflow middleware renders the active state's set instead.
    tools: [...interpreter.tools, ...instrumentation.tools, ...delegationTools, ...(params.tools ?? [])],
    ...rubricParams(ctx),
    middleware: agentMiddleware,
    // the harness's prompt is the whole prefix; the upstream base prompt contradicts
    // the platform prompt and is dropped (layer order in `core/prompt.ts`).
    systemPrompt: { prefix: input.systemPrompt, base: null },
    stateSchema: workflowStateSchema,
    checkpointer: ctx.checkpointer,
    ...frameworkPassthrough(params),
  });
  const graph = asCompiledAgentGraph(deepAgent.graph);

  // Assembly-time topology summary; the CLI's structured renderer ignores it.
  emit({ type: "graph-topology", topology: describeMachineTopology(target) });

  const driver = createTurnRunner({ graph, emit, bindSession: sessionBinder(ctx), entryState: target.entry });
  return {
    graph,
    driver,
    // Single disposal path for every per-session resource: hook and agent REPL
    // sessions, PTC contexts and tool cache, and the dispatch ledger.
    dispose: (sessionId: string) => {
      instrumentation.dispose(sessionId);
      interpreter.dispose(sessionId);
      dispatcher.release(sessionId);
    },
    toolMocks: agentMiddleware.some((m) => m.name === TOOL_MOCK_MIDDLEWARE_NAME),
    // Every resume — a decision, a reply, a delivery — is a turn on the session,
    // driven through the same runner an invoke is.
    resumable: {
      getState: (config) => asDecisionGraph(graph).getState(config),
      invoke: (resumeInput, config) =>
        driver.invoke(resumeInput, mergeConfigs(AGENT_DEFAULT_CONFIG, config as never)),
    },
  };
}

/**
 * One workflow's **workflow-wide** denials, as rules a descendant inherits:
 * `tools.forbid_always`, `skills.forbid_always` and `mounts.forbid_always`,
 * named with the workflow that declared them. A per-state `forbid` is not
 * inherited — it governs that state's turns, not a child session — and neither
 * is any grant.
 */
function workflowDenials(machine: WorkflowMachine, source: string): GovernanceRule[] {
  return [
    ...compileForbidRules(machine.spec.tools?.forbid_always, { scope: "workflow", source }),
    ...compileForbiddenSkillRules(machine.spec.skills?.forbid_always ?? [], source),
    ...compileForbiddenMountRules(machine.spec.mounts?.forbid_always ?? [], source),
  ];
}

/** The denials a direct child inherits from the root machine — the chain's first link. */
export function inheritedDenials(ctx: AssemblyContext, root: WorkflowMachine): GovernanceRule[] {
  return workflowDenials(root, ctx.workflowName);
}
