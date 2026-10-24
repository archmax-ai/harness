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
import { createMiddleware, todoListMiddleware, type AgentMiddleware } from "langchain";
import { createDeepAgent, type BackendProtocolV2, type CreateDeepAgentParams } from "deepagents";
import { AGENT_DEFAULT_CONFIG } from "../agent.js";
import {
  READ_FILE_IMAGES_LINE,
  READ_FILE_TEXT_ONLY_LINE,
  textOnlyReadFileDescription,
} from "../core/binary-read.js";
import { createFileOperationTools, workspaceEntryKind } from "../core/file-operations.js";
import { createSessionFiles } from "../core/attachments.js";
import { fileGovernance, runtimeReadDenial } from "../workflow/file-values.js";
import { runWithToolContext } from "../core/tool-context.js";
import { imageReadMiddleware, resolveImageReads } from "./image-reads.js";
import {
  asCompiledAgentGraph,
  asDecisionGraph,
  asModelCallResult,
  asStructuredTools,
  type AnyModelCallHandler,
  type AnyModelCallRequest,
  type CompiledAgentGraph,
  type IntrospectableStateGraph,
} from "../core/deepagents.js";
import { withEventContext, type WorkflowEventEmitter } from "../core/events.js";
import { resolveSystemPrompt } from "../core/prompt.js";
import { SessionStoreIdError, sessionIdRejection, type SessionStore } from "../core/session-store.js";
import type { SessionZoneRouter } from "../core/session-zone.js";
import type { SkillPrefixes, SkillRegistry } from "../core/skills.js";
import { TOOL_MOCK_MIDDLEWARE_NAME } from "../core/tool-mocks.js";
import { withoutDeletion } from "../core/workspace-router.js";
import type { PricingTable, UsageTracker } from "../core/usage.js";
import type { Workspace } from "../core/workspace.js";
import type { MountPrefixes } from "../core/zones.js";
import { loadPromptCacheEnv } from "../env.js";
import { workflowDenials, type GovernanceRule } from "../kernel/kernel.js";
import { UNGRANTABLE_TOOLS, type WorkflowMachine } from "../machine/machine.js";
import { WorkflowLoadError } from "../machine/load-spec.js";
import { TODO_TOOL, workflowToolName } from "../machine/tool-names.js";
import type { ToolPaths, ToolPathTable } from "../machine/tool-paths.js";
import { resolveTrigger, type TriggerInput } from "../machine/triggers.js";
import { buildSeededVariables, unguaranteedReferenceWarnings } from "../machine/variables.js";
import type { ResolvedRuntimeContract } from "../runtime/contract.js";
import { createScriptExecutor } from "../sandbox/executor.js";
import { createPtcToolGateway } from "../sandbox/ptc-gateway.js";
import { createQuickJsSandboxRuntime } from "../sandbox/runtime.js";
import { createInterpreter } from "../sandbox/tools.js";
import { createWorkflowInstrumentation, type StateModels } from "../workflow/middleware.js";
import { resolveCodeScript, workflowPaths } from "../workflow/paths.js";
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
import { parseClock } from "../core/clock.js";

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
  /**
   * The model a **grader state** runs on: the id it declares (or its workflow's
   * `settings.model`) resolved through the assembly's factory seam under the
   * `grader` role and memoized per distinct id. Held on the context so a
   * delegated child's graders resolve exactly as the root's do.
   */
  graderModel: (id?: string) => BaseChatModel;
  skillSources: string[];
  skillRegistry: SkillRegistry;
  skillTable: SkillPrefixes;
  runtimeContract: ResolvedRuntimeContract;
  /** Token prices, from the host option or the environment; absent means cost is never reported. */
  pricing?: PricingTable;
  /**
   * Every tool's declared path arguments — the built-ins plus the host's — which
   * every machine of this assembly, root and delegated alike, governs by.
   */
  toolPaths: ToolPathTable;
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
  /**
   * This composition runs a sub-workflow's child sessions, which do not name
   * themselves: `archmax_set_variables` asks for no title (the system prompt,
   * rendered with `child`, leaves the step out too).
   */
  child?: boolean;
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
 * The planning scratchpad: `write_todos` is a default tool and Deep Agents 1.13
 * does not register it (only its Codex harness profile adds the middleware), so
 * the assembly installs langchain's `todoListMiddleware` — for a governed agent,
 * only when some state of its workflow is granted `write_todos`, so the static
 * prompt never carries guidance for a tool no state can call.
 * Must sit outermost among the runtime's own middleware so its guidance lands on
 * the system prompt **before** the workflow instrumentation splits it into
 * `[static, volatile]` blocks. On a model with the Codex profile, Deep Agents
 * merges it into the profile's tail position instead, past the split (pinned in
 * `behaviour/upstream-additions.test.ts`).
 */
export function todoMiddleware(): AgentMiddleware {
  return todoListMiddleware() as unknown as AgentMiddleware;
}

/**
 * Hand the model a `read_file` whose description matches the workspace's
 * text-only reads (`core/binary-read.ts`): Deep Agents' own promises multimodal
 * content blocks for images, audio, video and PDFs, which the workspace router
 * refuses. `createDeepAgent` does not expose the filesystem middleware's
 * description overrides, and LangChain rejects a `wrapModelCall` that swaps a
 * registered tool for another instance (the tool node runs tools by identity),
 * so the description is rewritten on the registered instance itself, once, on
 * the first model call that offers it. The instance is this agent's own: Deep
 * Agents builds the filesystem tools per agent. When the upstream lines are
 * gone the description is left as it is and one `warning` says so.
 *
 * Both compositions install it, ahead of the provider cache and the host's
 * middleware, so the first call they see already carries the final definition.
 */
export function readFileContractMiddleware(
  emit: WorkflowEventEmitter,
  options: { images?: boolean } = {},
): AgentMiddleware {
  const line = options.images ? READ_FILE_IMAGES_LINE : READ_FILE_TEXT_ONLY_LINE;
  const settled = new WeakSet<StructuredTool>();
  const settle = (tool: StructuredTool) => {
    if (settled.has(tool)) return;
    settled.add(tool);
    const description = textOnlyReadFileDescription(tool.description, line);
    if (description !== null) {
      tool.description = description;
      return;
    }
    emit({
      type: "warning",
      scope: "workflow",
      message:
        "could not replace the binary-file lines of Deep Agents' read_file description; it still " +
        "promises multimodal content blocks although reads are text only — the upstream text may " +
        "have been reworded",
    });
  };
  return createMiddleware({
    name: "ReadFileContract",
    wrapModelCall: async (request: AnyModelCallRequest, handler: AnyModelCallHandler) => {
      for (const tool of asStructuredTools(request.tools)) if (tool.name === "read_file") settle(tool);
      return asModelCallResult(await handler(request), "the read_file contract");
    },
  }) as unknown as AgentMiddleware;
}

/**
 * The `read_file` contract and, when the host turned it on, the image reads —
 * one pair both compositions install at the same depth.
 */
export function fileReadMiddleware(ctx: AssemblyContext): AgentMiddleware[] {
  const images = resolveImageReads(ctx.params.images);
  return [
    readFileContractMiddleware(ctx.emit, { images: images !== null }),
    ...(images ? [imageReadMiddleware(ctx.backend, images)] : []),
  ];
}

/**
 * Bind `fn` to a session: the session zone's view (agent-visible paths resolve
 * against that session without its id embedded), the event envelope's session
 * context, and the tool context host tools are handed. The single ingress where a session id becomes a store
 * address, so it refuses an id that would escape the session zone or shadow a
 * reserved root name.
 */
export function sessionBinder(ctx: AssemblyContext): <T>(sessionId: string, fn: () => Promise<T>) => Promise<T> {
  return (sessionId, fn) => {
    const rejection = sessionIdRejection(sessionId, ctx.mountPrefixes);
    if (rejection) throw new SessionStoreIdError(sessionId, rejection);
    // A host tool's handler gets the same workspace the built-in file tools
    // resolve through, bound to this session for the turn, and the session's
    // id: a child's own when the binding is a dispatch's.
    return withEventContext({ sessionId }, () =>
      ctx.sessionZone.sessionScoped(sessionId, () =>
        runWithToolContext({ workspace: ctx.backend, sessionId }, fn),
      ),
    );
  };
}

/**
 * The system prompt for one machine: the spec-rendered workflow header followed
 * by the `WORKFLOW.md` prose (HTML comments stripped — notes for whoever opens
 * the file, not for the model), layered with the persona, the platform prompt and
 * the workspace zones by `resolveSystemPrompt`. The graph itself is not here: it
 * is disclosed per model call, for the active state only, by the middleware. A
 * plain agent (no machine) gets no platform prompt: it explains a graph there is
 * none of. A child session's platform layer leaves out the top-level-only
 * passages (`child`), so it is not asked to name itself.
 */
export function renderSystemPrompt(
  ctx: AssemblyContext,
  machine: WorkflowMachine | null,
  body: string,
  options: { workflow: string; child?: boolean },
): Promise<string> {
  const prose = stripHtmlComments(body).trim();
  const workflowPrompt = machine
    ? [renderWorkflowPrompt(machine), prose].filter(Boolean).join("\n\n")
    : prose || null;
  return resolveSystemPrompt(ctx.workspace, {
    platformBackendPath: machine ? workflowPaths(options.workflow).platformPrompt : null,
    ...(options.child ? { child: true } : {}),
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
): {
  workflowModel: BaseChatModel;
  workflowCacheStrategy: PromptCacheStrategy;
  stateModels: StateModels;
  graderModels: (state: string) => { model: BaseChatModel; id?: string };
} {
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
  // A grader state's model is its grader's — the `grader` role — and never the
  // graph's: no call of the session's agent is made in a grader state.
  const byState = new Map<string, BaseChatModel>();
  const graders = new Map<string, BaseChatModel>();
  for (const state of Object.keys(machine.spec.states)) {
    const id = machine.modelFor(state);
    if (machine.isGraderState(state)) {
      graders.set(state, ctx.graderModel(id));
      continue;
    }
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
    graderModels: (state) => {
      const model = graders.get(state) ?? ctx.graderModel(machine.modelFor(state));
      const id = idOf(model);
      return { model, ...(id ? { id } : {}) };
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
  // Every sibling this machine's allow lists name, read first: a delegation
  // tool's schema feeds the system prompt, so an unusable target fails assembly,
  // and a target's `file` arguments are path arguments the kernel governs.
  const delegationSignatures = await readDelegationSignatures(input);
  const target = input.machine.withToolPaths(delegationFilePaths(delegationSignatures));
  const governanceRules = [...(input.inheritedPolicyRules ?? []), ...(params.policyRules ?? [])];
  const settings = target.harnessSettings;

  // Two executors, one sandbox runtime: agent scripts read sources from the
  // agent workspace, code-state scripts from the authoring backend the agent
  // cannot address.
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
  const codeExecutor = createScriptExecutor({ workspace: authoring, sandboxVersion, ...sandboxLimits });
  // One gateway for every call made outside the tool node — the model's own
  // sandbox code, a code state's script, a grader — so each is governed and
  // instrumented by the same kernel and event stream.
  const ptcGateway = createPtcToolGateway({
    machine: target,
    policyRules: governanceRules,
    mountPrefixes: ctx.mountPrefixes,
    skills: ctx.skillTable,
    emit,
  });
  const interpreter = createInterpreter({ executor, ptcNames: [], ptcGateway });
  emit({ type: "interpreter-enabled" });

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
  const { workflowModel, workflowCacheStrategy: cacheStrategy, stateModels, graderModels } = resolveStateModels(
    ctx,
    target,
    input.workflow,
    cacheConfig.enabled,
  );
  // Built-ins no state of this workflow discloses, reported so a host sees what
  // the model is never shown: `task`, in every state of every assembly.
  const disclosedAnywhere = new Set(
    Object.keys(target.spec.states).flatMap((slug) => [...target.disclosedTools(slug)]),
  );
  const withheld = [...UNGRANTABLE_TOOLS].filter((tool) => !disclosedAnywhere.has(tool));
  emit({ type: "prompt-shaping", cache: cacheStrategy, withheld });

  // One dispatcher per composition, so the depth, cycle and concurrency bounds
  // are enforced in one place and every dispatch is reported the same way. A
  // child of this composition inherits what it inherited plus its own policy:
  // denials accumulate down the chain, never resetting to the root's.
  // A `file` argument is read from the caller and copied into the child, a
  // `file` return copied back: across sessions, each bound in turn.
  const callerFiles = fileGovernance({
    machine: target,
    policyRules: governanceRules,
    mountPrefixes: ctx.mountPrefixes,
    skills: ctx.skillTable,
    kind: (path) => workspaceEntryKind(ctx.backend, path),
  });
  const dispatcher = createSubWorkflowDispatcher({
    registry: input.registry,
    machine: target,
    childPolicyRules: [
      ...(input.inheritedPolicyRules ?? []),
      ...workflowDenials(target, input.workflow),
    ],
    onEvent: emit,
    files: createSessionFiles(ctx.backend, sessionBinder(ctx)),
    readDenial: (state, path, variables) => runtimeReadDenial(callerFiles, state, path, variables),
  });

  // Validate the assembly-time default trigger (fails closed on an unknown id).
  const defaultTrigger = resolveTrigger(target, input.trigger);

  const seededVariables = buildSeededVariables(input.variables);
  for (const message of unguaranteedReferenceWarnings(target, seededVariables)) {
    emit({ type: "warning", scope: "workflow", message });
  }
  // A seed is the host's and final, so a state owning the same name can never write it.
  for (const name of Object.keys(seededVariables)) {
    const owner = target.ownerOf(name);
    if (owner === undefined) continue;
    emit({
      type: "warning",
      scope: "workflow",
      message: `The host seeds '${name}', which state '${owner}' owns in 'locks'. A seed is locked, so '${owner}' can never change it.`,
    });
  }

  const instrumentation = createWorkflowInstrumentation({
    machine: target,
    codeExecutor,
    // Script paths are workflow-relative and confined to this workflow's `scripts/`.
    resolveCodeScript: (declared) => resolveCodeScript(input.workflow, declared),
    graderModel: graderModels,
    policyRules: governanceRules,
    mountPrefixes: ctx.mountPrefixes,
    skills: ctx.skillRegistry,
    ptcGateway,
    subWorkflows: dispatcher,
    onEvent: emit,
    // Validated by `createAgent`; a pin reaches every child composed from the same params.
    promptShaping: { cacheStrategy, cacheTtl: cacheConfig.ttl, clock: parseClock(params.clock ?? "") },
    stateModels,
    workspace,
    workflowName: input.workflow,
    trigger: { id: defaultTrigger.id },
    seededVariables,
    ...(ctx.pricing ? { pricing: ctx.pricing } : {}),
    ...(input.child ? { child: true } : {}),
    // Through the workspace, bound to the turn's session: what a `file` value names.
    entryKind: (path) => workspaceEntryKind(ctx.backend, path),
  });

  // Native Anthropic/Bedrock caching is LangChain's own middleware; the
  // OpenAI-compatible Claude path is marked by the workflow instrumentation.
  const providerCacheMiddleware = createProviderCacheMiddleware(cacheStrategy, cacheConfig.ttl);

  // The suspension site leads: it has to be the first middleware with an
  // `afterModel` hook, so its hook runs last after the model and the final
  // router honours its jumps (see `WorkflowInstrumentation`).
  const agentMiddleware = [
    instrumentation.parkMiddleware,
    // Decided once per composition: the guidance it adds is part of the static prefix.
    ...(target.grantsAnywhere(TODO_TOOL) ? [todoMiddleware()] : []),
    interpreter.middleware,
    instrumentation.middleware,
    // Inside the workflow's own, so a governed read is decided before either acts.
    ...fileReadMiddleware(ctx),
    ...(providerCacheMiddleware ? [providerCacheMiddleware] : []),
    ...(params.middleware ?? []),
  ];

  // One tool per sibling this machine's allow lists name.
  const delegationTools: StructuredTool[] = [];
  for (const [slug, signature] of delegationSignatures) {
    // `disabled` is dropped: a description is built once at assembly, so
    // "currently disabled" would be stale and destabilize the cacheable prefix.
    const { disabled: _disabled, ...described } = signature;
    delegationTools.push(createDelegationTool({ workflow: slug, ...described }, dispatcher, target.entry));
  }

  const deepAgent = createDeepAgent({
    // The workflow's own model is the graph default; a state that declares its
    // own is switched onto it per call by the governance middleware.
    model: workflowModel,
    // Without `delete`: Deep Agents' own recursive `delete` tool stays out, and
    // `remove_file` is the agent's one way to delete a file.
    backend: withoutDeletion(ctx.backend),
    // Deliberately no `skills`: upstream's section cannot vary per state; the
    // workflow middleware renders the active state's set instead.
    tools: [
      ...interpreter.tools,
      ...instrumentation.tools,
      // The runtime's own file operations, beside the tools Deep Agents registers.
      ...createFileOperationTools(ctx),
      ...delegationTools,
      ...(params.tools ?? []),
    ],
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
    // Single disposal path for every per-session resource: code-state and agent
    // REPL sessions, PTC contexts and tool cache, and the dispatch ledger.
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
        driver.invoke(
          resumeInput,
          mergeConfigs(AGENT_DEFAULT_CONFIG, config as never),
        ),
    },
  };
}

type DelegationSignatures = Map<string, Awaited<ReturnType<SubWorkflowRegistry["signature"]>>>;

/** The signature of every sibling `input.machine` may delegate to, by slug; an unreadable one fails assembly. */
async function readDelegationSignatures(input: ComposeInput): Promise<DelegationSignatures> {
  const signatures: DelegationSignatures = new Map();
  for (const slug of input.machine.delegationTargets()) {
    try {
      signatures.set(slug, await input.registry.signature(slug));
    } catch (err) {
      const raw = err instanceof SubWorkflowError ? err.message : String(err);
      const detail = raw.replace(/^Cannot run sub-workflow '[^']*':\s*/, "");
      throw new WorkflowLoadError(
        input.workflow,
        workflowPaths(input.workflow).workflowYaml,
        `it allows '${workflowToolName(slug)}', but ${detail}`,
      );
    }
  }
  return signatures;
}

/**
 * The path arguments of the delegation tools: each target's `file` arguments,
 * declared `read`, so the kernel governs them as it governs any read — a
 * `paths:` guard on the tool and the zone and mount rules bind them.
 */
function delegationFilePaths(signatures: DelegationSignatures): Record<string, ToolPaths> {
  const declared: Record<string, ToolPaths> = {};
  for (const [slug, signature] of signatures) {
    const files = (signature.requires ?? []).filter((entry) => entry.type === "file");
    if (files.length > 0) declared[workflowToolName(slug)] = Object.fromEntries(files.map((entry) => [entry.name, "read"]));
  }
  return declared;
}

/** The denials a direct child inherits from the root machine — the chain's first link. */
export function inheritedDenials(ctx: AssemblyContext, root: WorkflowMachine): GovernanceRule[] {
  return workflowDenials(root, ctx.workflowName);
}
