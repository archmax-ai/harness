/**
 * Governance of the two calls the model makes: `wrapModelCall` shapes the
 * payload (per-state tool disclosure, the volatile prompt section, the cache
 * breakpoint, the time budget) — or, in an automated state, services the call
 * itself by running the state (`automated.ts`) — and `wrapToolCall` decides
 * every tool call (variable substitution, the kernel's verdict, the calls the
 * runtime services itself, telemetry, skill redaction). The hooks that wire
 * these into the agent live in `middleware.ts`.
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredTool } from "@langchain/core/tools";
import { AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { v4 as uuidv4 } from "@langchain/core/utils/uuid";
import { Command, isGraphBubbleUp } from "@langchain/langgraph";
import type { PtcToolGateway } from "../sandbox/ptc-gateway.js";
import type { WorkflowMachine } from "../machine/machine.js";
import { readClockPin } from "../core/clock.js";
import type { WorkflowEventEmitter } from "../core/events.js";
import { ADVANCE_TOOL, entryStateOf, RESET_TOOL, unresolvedArgumentMessage } from "./control-tools.js";
import { resolveArguments, type VariableStore } from "../machine/variables.js";
import type { FileValueCheck } from "./signature-checks.js";
import {
  currentWorkflowState,
  isReplyOnly,
  readAuditTrail,
  readVariables,
  readWorkflowState,
} from "./state.js";
import type { SubWorkflowDispatcher } from "./sub-workflow.js";
import { CALLING_STATE_KEY, invocationOf, releaseScopes } from "../sessions/scope.js";
import { isWorkflowToolName, workflowSlugFromToolName } from "../machine/tool-names.js";
import { toolOutputPreview } from "../core/tool-telemetry.js";
import { decide, type GovernanceRule } from "../kernel/kernel.js";
import type { MountPrefixes } from "../core/mounts.js";
import { skillPrefixes, type SkillRegistry } from "../core/skills.js";
import { renderSkillsSection } from "../core/skill-prompt.js";
import { renderMountsSection } from "../core/mount-prompt.js";
import { REDACTED_TOOLS, redactDisabledSkills } from "../core/skill-redact.js";
import { redactHiddenMounts } from "../core/mount-redact.js";
import {
  asModelCallResult,
  asStructuredTools,
  type ModelCallHandler,
  type ModelCallRequest,
  type WorkflowRequestState,
  type WorkflowToolCallHandler,
  type WorkflowToolCallRequest,
} from "../core/deepagents.js";
import {
  cacheControl,
  DEFAULT_CACHE_TTL,
  type CacheControlMarker,
  type CacheTtl,
  type PromptCacheStrategy,
} from "./prompt-cache.js";
import { replyOnlyDirective } from "./parks.js";
import { renderStateGraph } from "./render-prompt.js";
import { blockedMessage, createToolService } from "./tool-service.js";
import { buildRunnableConfig } from "./runtime-config.js";
import { runAutomatedStep, type AutomatedStatesContext } from "./automated.js";

export { buildRunnableConfig } from "./runtime-config.js";

/**
 * Payload shaping resolved once at assembly and applied on every model call.
 * Presentation only — which bytes the model sees and which prefix is marked
 * cacheable; none of it widens what the kernel permits.
 */
/**
 * Which model a state's calls run on, and the prompt-cache mechanism that model
 * uses. Resolved once per composition (`resolveStateModels`) from what the spec
 * declares; a state with nothing of its own is absent from `modelFor`, so the
 * graph's own model — the workflow's — is what runs.
 */
export interface StateModels {
  /** The model this state's calls run on, or `undefined` for the composition's own. */
  modelFor(state: string): BaseChatModel | undefined;
  /** The cache strategy of the model in force for this state. */
  cacheStrategyFor(state: string): PromptCacheStrategy;
  /**
   * The **id** of the model in force for this state — read from the model the
   * assembly will actually run, not from what the spec declares, so it is
   * answered the same way whether the model came from a declared id, the
   * environment, an explicit `model` or a `modelFactory`. `undefined` when the
   * model exposes no id.
   *
   * Used to price a call whose response names no model: an OpenAI-compatible
   * endpoint is not obliged to echo one back, and without this the runtime would
   * hold the id it asked for and still report no cost.
   */
  idFor(state: string): string | undefined;
}

export interface PromptShaping {
  cacheStrategy?: PromptCacheStrategy;
  cacheTtl?: CacheTtl;
  /** The host's pinned "now" (`createAgent({ clock })`); a turn's own pin outranks it. */
  clock?: Date;
}

export interface GovernanceContext {
  machine: WorkflowMachine;
  emit: WorkflowEventEmitter;
  policyRules: GovernanceRule[];
  mountPrefixes: MountPrefixes;
  skills: SkillRegistry;
  shaping: PromptShaping;
  /** Per-state models; omitted, every call runs on the graph's own model. */
  stateModels?: StateModels;
  ptcGateway?: PtcToolGateway;
  subWorkflows?: SubWorkflowDispatcher;
  /** The sessions are a sub-workflow's children, whose caller reads what they return. */
  child?: boolean;
  /** The `file` type's runtime check for a session in a state; omitted, a `file` value is held to its shape alone. */
  files?: (state: string, variables: VariableStore) => FileValueCheck;
  /**
   * What runs an automated state. Omitted, an automated position has nothing to
   * run it, and its model call is refused as a failure of the state.
   */
  automated?: Omit<AutomatedStatesContext, "dispatchSteps" | "machine" | "emit" | "mountPrefixes" | "files" | "ptcGateway">;
  sessionIdOf(runtime: unknown): string;
}

export interface Governance {
  wrapModelCall(
    request: ModelCallRequest,
    handler: ModelCallHandler,
  ): Promise<ReturnType<typeof asModelCallResult>>;
  wrapToolCall(
    request: WorkflowToolCallRequest,
    handler: WorkflowToolCallHandler,
  ): Promise<Command | ToolMessage>;
  /**
   * Reserve the session's checkpointed dispatch count and return how many
   * dispatch numbers it has now taken: what a hook site outside the tool node
   * commits, so a number an automated state's calls took is never taken again.
   */
  dispatchCount(sessionId: string, state: unknown): number;
  /** End the session's turn: drop its model context. */
  endTurn(sessionId: string): void;
  /** Release the session and every sub-run scope nested beneath it; returns the scopes released. */
  release(sessionId: string): string[];
}

/**
 * Per-session context captured from the most recent model request: the
 * registered tool names a called name is resolved against.
 */
interface ModelContext {
  /** Every registered tool name, BEFORE per-state disclosure narrows it. */
  toolNames: string[];
}

/**
 * Resolve the name the model called to a registered tool: an exact match, or the
 * bare action name of a namespaced `<collection>__<action>` id (models routinely
 * drop the prefix) when that suffix is unambiguous.
 */
export function resolveToolName(called: string, registered: string[]): string | undefined {
  if (registered.includes(called)) return called;
  const matches = registered.filter((name) => name.endsWith(`__${called}`));
  return matches.length === 1 ? matches[0] : undefined;
}

/** A tool call's result, carrying the session's dispatch count into the step's update. */
function withDispatchCount(result: Command | ToolMessage, dispatchCount: number): Command | ToolMessage {
  if (result instanceof ToolMessage) return new Command({ update: { messages: [result], dispatchCount } });
  const update = result.update;
  if (update !== undefined && (typeof update !== "object" || Array.isArray(update))) return result;
  const { goto, graph } = result;
  return new Command({
    ...(Array.isArray(goto) ? (goto.length > 0 ? { goto } : {}) : goto ? { goto } : {}),
    ...(graph ? { graph } : {}),
    update: { ...(update ?? {}), dispatchCount },
  });
}

function unknownToolMessage(called: string, registered: string[]): string {
  const ambiguous = registered.filter((name) => name.endsWith(`__${called}`));
  const hint =
    ambiguous.length > 1
      ? ` Did you mean one of: ${ambiguous.join(", ")}? Call it by its full name.`
      : "";
  return (
    `[workflow] '${called}' is not a tool. Call one of the tools you were given, ` +
    `by its exact name.${hint}`
  );
}

/**
 * Whether the run was already sitting in its current state when this turn
 * opened (the trail's last step is an arrival), as opposed to having
 * transitioned into it this turn. The terminal directive applies only to the
 * former; a run routed into a terminal state to do work must not be told to
 * restart, or it restarts forever.
 */
function arrivedInPlace(state: WorkflowRequestState): boolean {
  const trail = readAuditTrail(state);
  return trail[trail.length - 1]?.kind === "trigger";
}

/**
 * How coarsely the clock is rendered. The line is *quantised*, not merely put in
 * the volatile block, because "volatile" is not free: the provider's cache key
 * is a prefix, and LangChain's Anthropic/Bedrock middlewares put their
 * breakpoint on the last message — so a system block that differs between two
 * calls costs the cache of the whole transcript behind it, not just its own
 * bytes. A per-second stamp would therefore re-price every turn at full input
 * cost on every call.
 *
 * Ten minutes is chosen against the cache TTLs (5m default, 1h option): a turn
 * shorter than the bucket renders one byte-identical line for all its model
 * calls, and two turns close enough for the previous turn's cache to still be
 * warm are usually inside one bucket too. What it costs is precision the model
 * has no use for — a date, a weekday and the time to the ten minutes are what
 * date arithmetic needs, and a state can always read the exact instant from the
 * sandbox.
 */
const CLOCK_BUCKET_MINUTES = 10;

/** The host's IANA zone, or `null` when it is UTC or the platform will not say. */
function hostTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone !== "UTC" && zone !== "Etc/UTC" ? zone : null;
  } catch {
    return null;
  }
}

function inZone(
  at: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
  // `en-CA` renders a date as `YYYY-MM-DD`, matching the UTC stamp beside it.
  locale = "en-CA",
): string {
  return new Intl.DateTimeFormat(locale, { timeZone, ...options }).format(at);
}

/**
 * The wall clock, one line, rendered per model call and never in the cacheable
 * prefix. UTC leads because that is the zone the park and trail records stamp,
 * so what the model reads and what the session stores agree; the weekday is
 * spelled out because it is the part a model cannot derive; the host's zone is
 * named when it differs, because a workflow that reasons about business hours
 * runs there. Rounding is stated rather than hidden — a clock that may be ten
 * minutes behind and says so is usable, one that quietly is not.
 */
function renderNow(now: Date, zone: string | null): string {
  const bucketMs = CLOCK_BUCKET_MINUTES * 60_000;
  const at = new Date(Math.floor(now.getTime() / bucketMs) * bucketMs);
  const utc = at.toISOString().slice(0, 16).replace("T", " ");
  const weekday = inZone(at, "UTC", { weekday: "long" }, "en-GB");
  let local = "";
  if (zone) {
    const day = inZone(at, zone, { year: "numeric", month: "2-digit", day: "2-digit" });
    const time = inZone(at, zone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    // The local date is repeated only when the zone puts it on the other side of midnight.
    local = ` Locally that is ${day === utc.slice(0, 10) ? time : `${day} ${time}`} in ${zone}.`;
  }
  return (
    `Current date and time: ${utc} UTC (${weekday}), rounded down to the nearest ` +
    `${CLOCK_BUCKET_MINUTES} minutes — it can be that much behind.${local}`
  );
}

/** The composed static prompt on a request: `systemMessage`, or the deprecated `systemPrompt`. */
function staticPromptOf(request: {
  systemMessage?: { text?: string; content?: unknown };
  systemPrompt?: unknown;
}): string {
  const message = request.systemMessage;
  if (message) {
    if (typeof message.text === "string") return message.text;
    if (typeof message.content === "string") return message.content;
  }
  return typeof request.systemPrompt === "string" ? request.systemPrompt : "";
}

/**
 * Rewrite the system message as `[static, volatile]` blocks, marking the static
 * block cacheable when a marker is supplied. Only `systemMessage` is written:
 * changing it and `systemPrompt` in one request is rejected by the agent node.
 */
function applySystemMessage(
  request: { systemMessage?: unknown; systemPrompt?: unknown },
  staticText: string,
  volatileText: string,
  marker?: CacheControlMarker,
): void {
  if (!volatileText && !marker && staticText === staticPromptOf(request as never)) return;
  const blocks: Record<string, unknown>[] = [];
  if (staticText) {
    blocks.push({ type: "text", text: staticText, ...(marker ? { cache_control: marker } : {}) });
  }
  if (volatileText) blocks.push({ type: "text", text: volatileText });
  if (blocks.length === 0) return;
  // `cache_control` is a provider extension the core `ContentBlock` union does not model.
  request.systemMessage = new SystemMessage({
    content: blocks as unknown as SystemMessage["content"],
  });
}

/** Where a model call that ran out of its state's time budget says so. */
const BUDGET_EXHAUSTED_KEY = "archmax_budget_exhausted";

/** The reason kwarg `key` carries on `message`, when it carries one. */
function markerReason(message: unknown, key: string): string | undefined {
  const kwargs = (message as { additional_kwargs?: Record<string, unknown> } | undefined)
    ?.additional_kwargs;
  const reason = kwargs?.[key];
  return typeof reason === "string" ? reason : undefined;
}

/** The reason a message stands in for a model call that exceeded its `budget.timeoutMs`, if it does. */
export function budgetExhaustedReason(message: unknown): string | undefined {
  return markerReason(message, BUDGET_EXHAUSTED_KEY);
}

export function createGovernance(ctx: GovernanceContext): Governance {
  const { machine, emit, policyRules, mountPrefixes, skills, ptcGateway, subWorkflows } = ctx;
  const skillTable = skillPrefixes(skills);
  const skillSlugs = [...skills.keys()];
  const enabledSkillsIn = (state: string) => machine.enabledSkills(state, skillSlugs);
  const enabledMountsIn = (state: string) => machine.enabledMounts(state, mountPrefixes.governed);
  /** Whether any mount of the table can be hidden at all — cheap early exit. */
  const tableGoverns =
    mountPrefixes.governed.length > 0 || machine.workflowForbiddenMounts().length > 0;
  const cacheStrategy: PromptCacheStrategy = ctx.shaping.cacheStrategy ?? "off";
  const cacheTtl: CacheTtl = ctx.shaping.cacheTtl ?? DEFAULT_CACHE_TTL;

  // Keyed by session id; a sub-run is its own session.
  const modelContexts = new Map<string, ModelContext>();
  // Fallback ids for tool calls the model supplied no id for.
  let generatedCallSeq = 0;

  const service = createToolService({
    machine,
    emit,
    mountPrefixes,
    ...(subWorkflows ? { subWorkflows } : {}),
    ...(ctx.files ? { files: ctx.files } : {}),
  });

  // An automated state runs through the same gateway, dispatcher and file check
  // the session's own calls use.
  const automated: AutomatedStatesContext | undefined =
    ctx.automated && ptcGateway
      ? {
          ...ctx.automated,
          machine,
          emit,
          mountPrefixes,
          ptcGateway,
          ...(ctx.files ? { files: ctx.files } : {}),
          dispatchSteps: service.dispatchSteps,
        }
      : undefined;

  /**
   * Filter a scoped listing (`ls`, `glob`, `grep`) to what the state can reach:
   * the kernel refuses a path inside a disabled skill bundle or a mount the
   * state does not have, but a listing names a *scope* the state may reach and
   * would otherwise hand back everything in it — including a directory the
   * agent would then be refused, which reads as a broken workspace rather than
   * as a capability it was not given.
   *
   * Skills first, then mounts, then one rebuilt message: the two filters are
   * independent (a bundle lives inside the `skills/` mount) and both are
   * identity when they hide nothing.
   */
  function redactListings<T>(result: T, state: string, toolName: string): T {
    if (!REDACTED_TOOLS.has(toolName)) return result;
    if (!(result instanceof ToolMessage) || typeof result.content !== "string") return result;
    let text = result.content;
    if (skillTable.length > 0) {
      text = redactDisabledSkills(text, enabledSkillsIn(state), skillTable);
    }
    if (tableGoverns) {
      text = redactHiddenMounts(
        text,
        { enabled: enabledMountsIn(state), forbidden: machine.forbiddenMounts(state) },
        mountPrefixes,
      );
    }
    if (text === result.content) return result;
    return new ToolMessage({
      ...(result.status ? { status: result.status } : {}),
      content: text,
      tool_call_id: result.tool_call_id,
      ...(result.id !== undefined ? { id: result.id } : {}),
      ...(result.name !== undefined ? { name: result.name } : {}),
      ...(result.artifact !== undefined ? { artifact: result.artifact } : {}),
      additional_kwargs: result.additional_kwargs,
      response_metadata: result.response_metadata,
    }) as T;
  }

  /**
   * The model calls this turn has left, this one included, while its budget is
   * being counted and not yet spent; `beforeModel` has already counted this call.
   */
  function turnCallsLeft(request: ModelCallRequest): number | undefined {
    const calls = readWorkflowState(request.state).turnCalls;
    const invocation = invocationOf(request.runtime as RunnableConfig | undefined);
    if (!calls || calls.exhausted || invocation === undefined || calls.invocation !== invocation) return undefined;
    return machine.maxModelCalls - calls.count + 1;
  }

  /** The volatile prompt section: what the model is told about where the run stands right now. */
  function volatileSection(request: ModelCallRequest, workflowState: string, replyOnly: boolean): string {
    // First, and outside either heading: the clock is true of the turn, not of
    // the state the turn is in, so a parked run reads it as well.
    // A pin renders without the host's local time, which differs between machines.
    const pin = readClockPin((request.runtime as RunnableConfig | undefined)?.configurable) ?? ctx.shaping.clock;
    const clock = pin ? renderNow(pin, null) : renderNow(new Date(), hostTimeZone());
    if (replyOnly) {
      return `${clock}\n\n## This run is parked\n\n${replyOnlyDirective(machine, request.state)}`;
    }
    const sections: string[] = [];
    if (
      machine.isTerminal(workflowState) &&
      workflowState !== entryStateOf(readWorkflowState(request.state), machine) &&
      arrivedInPlace(request.state)
    ) {
      // A durable session sits in the terminal state it finished in, so a follow-up
      // arrives where no transition leads out. Said only where it applies (see
      // arrivedInPlace); that the state *is* terminal is stated by renderStateGraph
      // below, so this covers only what is particular to a follow-up landing here.
      sections.push(
        `This state is where this run finished. If what is in front of you now is a new message ` +
          `rather than the work you entered this state to do, that run is over — call ` +
          `${RESET_TOOL} before answering and before doing any of the work, then go forward ` +
          `through the graph from the state the conversation began in. Do not answer a follow-up ` +
          `from here.`,
      );
    }
    // A human state's `instructions` address the reviewer, which is why a reply-only turn gets none.
    const instructions = machine.spec.states[workflowState]?.instructions?.trim();
    if (instructions) sections.push(instructions);
    const skillsSection = renderSkillsSection(enabledSkillsIn(workflowState), skills);
    if (skillsSection) sections.push(skillsSection);
    // Beside the skills section, and volatile for the same reason: which mounts
    // a state reaches varies, and the cacheable prefix does not.
    const mountsSection = renderMountsSection(
      enabledMountsIn(workflowState),
      mountPrefixes,
      (name) => machine.mountWritable(workflowState, name, mountPrefixes),
    );
    if (mountsSection) sections.push(mountsSection);
    // Names, never values: one can hold a whole event payload.
    const variables = readVariables(request.state);
    const variableNames = Object.keys(variables).sort();
    sections.push(
      variableNames.length > 0
        ? `Run variables set: ${variableNames.join(", ")}. Read one with archmax_get_variables.`
        : "Run variables: none set.",
    );
    const argConstraints = machine.describeArgConstraints(workflowState, variables);
    if (argConstraints.length > 0) {
      sections.push(
        [
          "Enforced tool argument constraints in this state (a call with any other value is blocked):",
          ...argConstraints,
        ].join("\n"),
      );
    }
    const left = turnCallsLeft(request);
    if (left !== undefined && left * 5 <= machine.maxModelCalls) {
      sections.push(
        `This turn has ${left} model call${left === 1 ? "" : "s"} left. Finish what you are doing and answer the person.`,
      );
    }
    // Last, immediately before the model acts: choosing the edge is the decision
    // the turn ends on. This is the only place the graph is disclosed at all.
    const graph = renderStateGraph(machine, workflowState, {
      trigger: readWorkflowState(request.state).trigger?.id,
      child: ctx.child === true,
    });
    if (graph) sections.push(graph);
    // The heading asserts itself over the transcript: a durable session carries
    // earlier turns' advance results, which a model would otherwise read as current.
    return `${clock}\n\n## Current state: ${workflowState}\n\nThis is the state you are in now; it overrides any state movement recorded earlier in this conversation.${
      sections.length > 0 ? `\n\n${sections.join("\n\n")}` : ""
    }`;
  }

  async function wrapModelCall(request: ModelCallRequest, handler: ModelCallHandler) {
    const sessionId = ctx.sessionIdOf(request.runtime);
    const tools: StructuredTool[] = asStructuredTools(request.tools);
    const workflowState = currentWorkflowState(request.state, machine.entry);
    const base = buildRunnableConfig(request.runtime ?? {});
    // The state rides on the config, so a delegation a script or an automated
    // state makes names the state it was made from.
    const config: RunnableConfig = {
      ...base,
      configurable: { ...(base.configurable ?? {}), [CALLING_STATE_KEY]: workflowState },
    };
    const replyOnly = isReplyOnly(request.state);
    // An automated state's calls may dispatch: they number above what the session has taken.
    subWorkflows?.reserve(sessionId, readWorkflowState(request.state).dispatchCount ?? 0);
    modelContexts.set(sessionId, { toolNames: tools.map((t) => t.name) });

    // An automated state is serviced here, in place of the agent's model: the
    // state runs, and the marker standing in for the call carries its outcome to
    // `afterModel`. A parked session never stands in one.
    if (!replyOnly && machine.isAutomatedState(workflowState)) {
      if (!automated) {
        throw new Error(
          `state '${workflowState}' is a ${machine.stateType(workflowState)} state, and this ` +
            `assembly wires nothing to run one (no automated-state runner and PTC gateway)`,
        );
      }
      return runAutomatedStep(automated, {
        sessionId,
        session: request.state,
        tools,
        config,
        ...(request.runtime?.signal ? { signal: request.runtime.signal } : {}),
      });
    }

    // Point every wrapped PTC tool at the state, config and variables in force
    // now; the variables are what a script call's `${{name}}` guards resolve against.
    ptcGateway?.refresh(sessionId, {
      state: workflowState,
      config,
      replyOnly,
      variables: readVariables(request.state),
    });

    // Progressive disclosure: the active state's surface in registration order (a
    // byte-identical cacheable prefix). A reply-only turn is handed the same list:
    // its transcript carries tool calls and runtime notes, and a provider may refuse
    // that history without the definitions it belongs to. The kernel's reply-only
    // rule refuses every call the turn makes, so the list lets it act on nothing.
    const disclosed = machine.disclosedTools(workflowState);
    request.tools = tools.filter((t) => disclosed.has(t.name));

    // The model this state declared, if it declared one. Set here because this
    // is where the machine's position is known: a session moves inside a turn,
    // so a state's model cannot be chosen when the graph is built. A reply-only
    // turn is made in the state the session is parked at, so the handoff message
    // runs on that state's model too.
    const stateModel = ctx.stateModels?.modelFor(workflowState);
    if (stateModel) request.model = stateModel;

    // The breakpoint belongs to the model that is about to be called, not to the
    // assembly: a state on Claude behind an OpenAI-compatible endpoint needs it
    // whatever the workflow's own model is.
    const strategy = ctx.stateModels?.cacheStrategyFor(workflowState) ?? cacheStrategy;

    applySystemMessage(
      request,
      staticPromptOf(request),
      volatileSection(request, workflowState, replyOnly),
      strategy === "anthropic-compat" ? cacheControl(cacheTtl) : undefined,
    );

    // Narrowed rather than forwarded blind: this middleware is innermost, so the
    // agent node blames it for whatever the handler returned.
    const call = async () => asModelCallResult(await handler(request), `state '${workflowState}'`);
    // `budget.timeoutMs`: the call races a timer. On expiry an empty marker message
    // stands in for the answer so `afterModel` can route through `on_error`; the
    // in-flight request itself is not cancelled (the framework exposes no per-call signal).
    const timeoutMs = machine.spec.states[workflowState]?.budget?.timeoutMs;
    if (timeoutMs == null) return call();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<AIMessage>((resolve) => {
      timer = setTimeout(
        () =>
          resolve(
            new AIMessage({
              content: "",
              id: `budget_${uuidv4()}`,
              additional_kwargs: {
                [BUDGET_EXHAUSTED_KEY]: `state '${workflowState}' exceeded its time budget (timeoutMs: ${timeoutMs})`,
              },
            }),
          ),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([call(), expiry]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * The ids of the delegation calls in the assistant message that made this
   * call, in tool-call order: the batch whose dispatches are numbered together.
   */
  function delegationCallsOf(request: WorkflowToolCallRequest, sessionId: string): string[] {
    const id = request.toolCall?.id;
    if (!id) return [];
    const registered = modelContexts.get(sessionId)?.toolNames;
    const messages: unknown[] = request.state?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const calls = (messages[i] as { tool_calls?: Array<{ id?: string; name?: string }> } | undefined)?.tool_calls;
      if (!Array.isArray(calls) || !calls.some((c) => c.id === id)) continue;
      return calls
        .filter((c) => {
          const name = c.name ?? "";
          return isWorkflowToolName(registered ? (resolveToolName(name, registered) ?? name) : name);
        })
        .map((c) => c.id ?? "");
    }
    return [];
  }

  /**
   * Every tool call, numbered for the dispatches it may make. A child session
   * is `<session>~<n>`, `n` counted across the session's turns in its
   * checkpointed `dispatchCount`. The model's delegation calls in one batch are
   * numbered in tool-call order from the count the step read, so a node
   * replayed from its checkpoint gives each call the same number — the same
   * child. That count plus the batch is reserved first, so a script dispatching
   * in the same step numbers above every one of them. The call's
   * result carries the count it leaves, so the next step, and the next turn on
   * a fresh agent, continue from it.
   */
  async function wrapToolCall(
    request: WorkflowToolCallRequest,
    handler: WorkflowToolCallHandler,
  ): Promise<Command | ToolMessage> {
    if (!subWorkflows) return governToolCall(request, handler);
    const sessionId = ctx.sessionIdOf(request.runtime);
    const counted = readWorkflowState(request.state).dispatchCount ?? 0;
    const batch = delegationCallsOf(request, sessionId);
    subWorkflows.reserve(sessionId, counted + batch.length);
    const at = batch.indexOf(request.toolCall?.id ?? "");
    const result = await governToolCall(request, handler, at < 0 ? undefined : counted + 1 + at);
    const taken = subWorkflows.dispatchCount(sessionId);
    return taken > counted ? withDispatchCount(result, taken) : result;
  }

  async function governToolCall(
    request: WorkflowToolCallRequest,
    handler: WorkflowToolCallHandler,
    dispatchNumber?: number,
  ): Promise<Command | ToolMessage> {
    const called: string = request.toolCall?.name ?? "";
    const sessionId = ctx.sessionIdOf(request.runtime);
    const workflowState = currentWorkflowState(request.state, machine.entry);
    const callId: string = request.toolCall?.id || `tool-${++generatedCallSeq}`;
    const toolCallId = request.toolCall?.id ?? "";

    // A bare action name of a namespaced id resolves to its target; the rest is
    // refused as unknown, a different mistake from a governance denial. The control
    // tools never reach the tool node, so they are registered by definition.
    const registeredNames = modelContexts.get(sessionId)?.toolNames;
    const resolved =
      request.tool !== undefined || registeredNames === undefined || called === ADVANCE_TOOL
        ? called
        : resolveToolName(called, registeredNames);
    if (resolved === undefined) {
      return new ToolMessage({
        content: unknownToolMessage(called, registeredNames ?? []),
        tool_call_id: toolCallId,
        name: called,
        status: "error",
      });
    }
    const toolName = resolved;
    if (toolName !== called) {
      request = { ...request, toolCall: { ...request.toolCall, name: toolName } };
    }
    const call = { sessionId, workflowState, toolName, callId, toolCallId };
    const block = (reason: string, args: Record<string, unknown>) => {
      emit({ type: "tool-blocked", state: workflowState, tool: toolName, reason, callId, args });
      return blockedMessage(toolName, toolCallId, reason);
    };

    // Variable substitution is the FIRST stage, ahead of the kernel, so a guard and
    // an argument referencing the same variable agree by construction. Delegation
    // tools are exempt: their params go through `resolveParams`.
    const variables = readVariables(request.state);
    let args = (request.toolCall?.args ?? {}) as Record<string, unknown>;
    if (!isWorkflowToolName(toolName)) {
      const substituted = resolveArguments(args, variables);
      if (!substituted.ok) return block(unresolvedArgumentMessage(substituted), args);
      args = substituted.args;
      request = { ...request, toolCall: { ...request.toolCall, args } };
    }

    const verdict = decide(
      machine,
      {
        kind: "tool-call",
        state: workflowState,
        tool: toolName,
        args,
        // A reply-only turn may only speak: the kernel refuses any call it makes, ahead of every grant.
        ...(isReplyOnly(request.state) ? { replyOnly: true } : {}),
      },
      policyRules,
      mountPrefixes,
      variables,
      skillTable,
    );
    if (verdict.decision === "block") {
      const message = verdict.reason ?? "";
      if (verdict.warn) {
        emit({ type: "tool-blocked", state: workflowState, tool: toolName, reason: message, callId, args });
      }
      const blocked = blockedMessage(toolName, toolCallId, message);
      // A terminal verdict (an unevaluable guard) cannot be corrected by the agent:
      // committed as `rejected`, so the run routes through `on_error` rather than looping.
      if (verdict.terminal) return new Command({ update: { rejected: message, messages: [blocked] } });
      return blocked;
    }

    if (subWorkflows && isWorkflowToolName(toolName)) {
      return service.serviceDelegation(request, subWorkflows, call, args, dispatchNumber);
    }
    const serviced = await service.serviceControlTool(request, call, args);
    if (serviced) return serviced;

    // Governed call telemetry.
    service.emitToolCalled(workflowState, toolName, callId, args);
    const startedAt = Date.now();
    const settle = (status: "ok" | "error", preview: { output: string; truncated: boolean }) => {
      const durationMs = Date.now() - startedAt;
      emit({ type: "tool-result", state: workflowState, tool: toolName, callId, status, durationMs, ...preview });
    };
    let result: Command | ToolMessage;
    try {
      result = redactListings(await handler(request), workflowState, toolName);
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      // A park, a parent command or a cancellation is not the tool's failure:
      // exactly what the tool node itself refuses to answer keeps propagating.
      if (isGraphBubbleUp(err) || request.runtime?.signal?.aborted) {
        settle("error", toolOutputPreview(message));
        throw err;
      }
      // Anything else is the call's answer, so the model can retry, switch tools
      // or say what it could not do, and sibling answers survive the step.
      result = new ToolMessage({ content: message, tool_call_id: toolCallId, name: toolName, status: "error" });
    }
    const failed = result instanceof ToolMessage && result.status === "error";
    settle(failed ? "error" : "ok", toolOutputPreview(result));
    const steps = service.dispatchSteps(sessionId, workflowState);
    // A delegation the tool body ran itself (no dispatcher wired): recorded from its result.
    if (steps.length === 0 && isWorkflowToolName(toolName) && result instanceof ToolMessage) {
      steps.push({
        to: workflowState,
        kind: "sub-workflow",
        workflow: workflowSlugFromToolName(toolName)!,
        status: failed ? "error" : "ok",
        ...(failed ? { reason: String(result.content).slice(0, 500) } : {}),
        ts: Date.now(),
      });
    }
    return result instanceof ToolMessage ? service.withDispatchSteps(result, steps) : result;
  }

  return {
    wrapModelCall,
    wrapToolCall,
    dispatchCount(sessionId: string, state: unknown): number {
      if (!subWorkflows) return 0;
      subWorkflows.reserve(sessionId, readWorkflowState(state).dispatchCount ?? 0);
      return subWorkflows.dispatchCount(sessionId);
    },
    endTurn(sessionId) {
      modelContexts.delete(sessionId);
      service.releaseSession(sessionId);
    },
    release(sessionId) {
      const scopes = releaseScopes(modelContexts, sessionId);
      for (const scope of new Set([...scopes, sessionId])) service.releaseSession(scope);
      return scopes;
    },
  };
}
