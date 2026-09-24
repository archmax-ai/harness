import { mergeConfigs, type RunnableConfig } from "@langchain/core/runnables";
import type { BaseCheckpointSaver, BaseStore } from "@langchain/langgraph-checkpoint";
import type { Graph } from "@langchain/core/runnables/graph";
import {
  asCompiledAgentGraph,
  DEFAULT_RECURSION_LIMIT,
  type AgentInput,
  type AgentResult,
  type AgentStreamOptions,
  type CompiledAgentGraph,
} from "./core/deepagents.js";
import type { WorkflowMachine } from "./machine/machine.js";
import type { MachineSpec } from "./machine/types.js";
import type { ResolvedTrigger, TriggerInput } from "./machine/triggers.js";
import type { ResolvedRuntimeContract } from "./runtime/contract.js";
import type { EmitRunArtifacts, SessionOperations } from "./sessions/operations.js";
import type { ResolvedSession, ResolveSessionInput } from "./sessions/resolve.js";
import type {
  DecideOutcome,
  DecisionResolution,
  DeliverOutcome,
  Outcome,
  ReplyOutcome,
  ResumePayload,
  TriggerDelivery,
} from "./sessions/resume.js";
import type { TurnRunner } from "./workflow/turn-runner.js";

/**
 * The default config an assembled agent carries: the integration metadata
 * tracing backends key off, and the recursion limit a turn runs under when the
 * caller names none. One invoke is one whole turn across states — every hook,
 * model call and tool batch is a super-step — so the limit is generous by
 * design: the authored budgets (`budget.maxTurns`, `maxParks`) are the real
 * bound, and this only stops a turn nothing else bounds.
 */
export const AGENT_DEFAULT_CONFIG: RunnableConfig = {
  metadata: { ls_integration: "archmax-harness" },
  recursionLimit: DEFAULT_RECURSION_LIMIT,
};

/**
 * A turn's input to {@link WorkflowSurface.send}: what the person said, and —
 * for a session's opening turn — how it is started and what it is seeded with.
 * On a session parked at a human state the message is answered without moving
 * it; on a session parked with `archmax_wait` the trigger and variables are
 * delivered into it.
 */
export interface TurnInput {
  /** What the person said. */
  message: string;
  /** How the session is started; defaults to `manual`. */
  trigger?: TriggerInput;
  /** Variables seeded for this turn, locked — the same seeds a delivery carries. */
  variables?: Record<string, unknown>;
  /** Where a firing's session id lives, overriding the trigger's declaration. */
  sessionPath?: string;
}

/** What {@link WorkflowSurface.send} takes: a turn, or one of the three resumes. */
export type SendInput = TurnInput | ResumePayload;

/**
 * The governance surface of a governed assembly, reached at `agent.workflow`.
 *
 * Carries only what is meaningless without a machine. Everything that describes
 * *the session* — `sessions`, artifacts, spec snapshots, disposal — is on the
 * agent itself, because an ungoverned assembly has those too. `undefined` on a
 * plain assembly, so TypeScript makes the caller handle that.
 */
export interface WorkflowSurface {
  /** Workflow slug this agent was assembled for. */
  name: string;
  /** The compiled machine backing this agent's workflow. */
  machine: WorkflowMachine;
  /** Map a trigger id to the start state it enters; throws `UnknownTriggerError`. */
  resolveTrigger(trigger?: TriggerInput): ResolvedTrigger;
  /** Resume a session parked at a human state with the person's decision. */
  decide(sessionId: string, resolution: DecisionResolution): Promise<DecideOutcome>;
  /** Reply to a session parked at a human state and get its answer; it stays parked. */
  reply(sessionId: string, message: string): Promise<ReplyOutcome>;
  /** Resume a session parked with `archmax_wait` with a delivered firing. */
  deliver(sessionId: string, delivery: TriggerDelivery): Promise<DeliverOutcome>;
  /** Map a firing to the session it belongs to and the disposition it takes — without invoking. */
  resolveSession(input: ResolveSessionInput): Promise<ResolvedSession>;
  /**
   * The one operation a host or the CLI needs: enter `sessionId` with a turn or
   * a resume and get one {@link Outcome} back. A turn is resolved first — a new
   * or finished session takes it as its next turn, a session parked at a human
   * state has it answered as a reply, a session parked with `archmax_wait` has
   * its trigger and variables delivered. `config` merges into the invoke config
   * (a tool-mock declaration, a recursion limit).
   */
  send(sessionId: string, input: SendInput, config?: RunnableConfig): Promise<Outcome>;
}

/** The session-level members every assembled agent carries, governed or plain. */
export interface AgentMembers {
  /** Release every per-session resource held for `sessionId`. Idempotent. */
  dispose(sessionId: string): void;
  /** Runtime contract resolved (and enforced) for this agent. */
  runtimeContract: ResolvedRuntimeContract;
  /**
   * Whether tool mocks declared for a session (`configurable.__toolMocks`, the
   * case engine's `mocks:` channel) intercept **agent-initiated** tool calls —
   * true when the tool-mock middleware is wired. Scripts' PTC calls are always
   * intercepted; without this, interception would be partial, which is why the
   * case engine refuses mock-declaring cases against an agent that lacks it.
   */
  toolMocks: boolean;
  /**
   * Persist the session's graph snapshot, the supplied trajectory and (when
   * governed) its trail, variables and usage under `<sessionId>/artifacts/`.
   * Best-effort: the artifacts directory, or `null` if writing failed.
   */
  emitRunArtifacts: EmitRunArtifacts;
  /** Session handles over the configured session store. */
  sessions: SessionOperations;
  /** Resolve a machine spec persisted to the snapshot store by its `specHash`. */
  getSpecSnapshot(hash: string): Promise<MachineSpec | null>;
}

/**
 * An assembled agent: a wrapper over the compiled Deep Agent graph.
 *
 * This is the shape `createDeepAgent` returns — a thin delegating object holding
 * the compiled graph — mirrored for two reasons. Familiarity: a consumer who
 * knows `createDeepAgent` gets `invoke`/`stream`/`streamEvents`/`graph` where
 * they expect them. Correctness: a compiled graph's `withConfig()` returns a
 * **new** graph, so a governance namespace attached to a graph object would be
 * dropped the first time anyone reconfigured it; {@link ArchmaxAgent.withConfig}
 * rebuilds the wrapper, so `.workflow` survives.
 *
 * Every agent's `invoke`, `stream` and `streamEvents` go through a turn runner
 * that binds the session zone and event context around the call, from
 * `configurable.thread_id`. A governed agent's runner also streams the model's
 * text as `agent-text-delta` events and settles parks; a plain agent's runner
 * drives the graph as-is, bound.
 */
export class ArchmaxAgent implements AgentMembers {
  readonly #graph: CompiledAgentGraph;
  readonly #config: RunnableConfig;
  readonly #members: AgentMembers;
  readonly #driver: TurnRunner | undefined;

  readonly dispose: (sessionId: string) => void;
  readonly runtimeContract: ResolvedRuntimeContract;
  readonly toolMocks: boolean;
  readonly emitRunArtifacts: EmitRunArtifacts;
  readonly sessions: SessionOperations;
  readonly getSpecSnapshot: (hash: string) => Promise<MachineSpec | null>;

  /**
   * Governance for this assembly, or `undefined` when no `workflow` was
   * supplied. Carries only what is meaningless without a machine.
   */
  readonly workflow: WorkflowSurface | undefined;

  constructor(opts: {
    graph: unknown;
    members: AgentMembers;
    workflow?: WorkflowSurface | undefined;
    config?: RunnableConfig;
    /** The session-bound turn runner the assembly drives its graph through. */
    driver?: TurnRunner;
  }) {
    this.#graph = asCompiledAgentGraph(opts.graph);
    this.#members = opts.members;
    this.#config = mergeConfigs(AGENT_DEFAULT_CONFIG, opts.config);
    this.#driver = opts.driver;
    this.workflow = opts.workflow;
    this.dispose = opts.members.dispose;
    this.runtimeContract = opts.members.runtimeContract;
    this.toolMocks = opts.members.toolMocks;
    this.emitRunArtifacts = opts.members.emitRunArtifacts;
    this.sessions = opts.members.sessions;
    this.getSpecSnapshot = opts.members.getSpecSnapshot;

    // Bound so the agent survives destructuring — `const { invoke } = agent` is
    // how a caller naturally reaches for one method.
    this.invoke = this.invoke.bind(this);
    this.stream = this.stream.bind(this);
    this.streamEvents = this.streamEvents.bind(this);
    this.withConfig = this.withConfig.bind(this);
    this.getState = this.getState.bind(this);
    this.getStateHistory = this.getStateHistory.bind(this);
    this.updateState = this.updateState.bind(this);
    this.getSubgraphs = this.getSubgraphs.bind(this);
    this.getSubgraphsAsync = this.getSubgraphsAsync.bind(this);
    this.getGraphAsync = this.getGraphAsync.bind(this);
  }

  /** The compiled `CompiledStateGraph` — a real Pregel, for LangGraph-native use. */
  get graph(): CompiledAgentGraph {
    return this.#graph;
  }

  /** The checkpointer the graph was compiled with. */
  get checkpointer(): BaseCheckpointSaver | boolean | undefined {
    return this.#graph.checkpointer as BaseCheckpointSaver | boolean | undefined;
  }

  /** The LangGraph store the graph was compiled with, when one was supplied. */
  get store(): BaseStore | undefined {
    return this.#graph.store as BaseStore | undefined;
  }

  /**
   * A new agent of the same kind with `config` merged into its defaults.
   * Returns a wrapper, never a bare graph: `.workflow` and the session-level
   * members must survive reconfiguration.
   */
  withConfig(config: RunnableConfig): ArchmaxAgent {
    return new ArchmaxAgent({
      graph: this.#graph,
      members: this.#members,
      workflow: this.workflow,
      config: mergeConfigs(this.#config, config),
      ...(this.#driver ? { driver: this.#driver } : {}),
    });
  }

  /** Drive one turn to a settled result. */
  invoke(input: AgentInput, config?: RunnableConfig): Promise<AgentResult> {
    const merged = mergeConfigs(this.#config, config);
    if (this.#driver) return this.#driver.invoke(input, merged) as Promise<AgentResult>;
    return this.#graph.invoke(input, merged);
  }

  /** Stream one turn's execution. */
  async stream(input: AgentInput, options?: AgentStreamOptions): Promise<AsyncIterable<unknown>> {
    const merged = mergeConfigs(this.#config, options as RunnableConfig);
    if (this.#driver) return this.#driver.stream(input, merged);
    return this.#graph.stream(input, merged as AgentStreamOptions);
  }

  /** Stream the framework's own event feed. */
  streamEvents(input: AgentInput, config: RunnableConfig, options?: unknown): AsyncIterable<unknown> {
    const merged = mergeConfigs(this.#config, config);
    if (this.#driver) return this.#driver.streamEvents(input, merged, options);
    return this.#graph.streamEvents(input, merged, options);
  }

  // --- Checkpoint surface, delegated to the compiled graph -------------------

  getState(config: RunnableConfig, options?: unknown): Promise<unknown> {
    return this.#graph.getState(mergeConfigs(this.#config, config), options);
  }

  getStateHistory(config: RunnableConfig, options?: unknown): AsyncIterableIterator<unknown> {
    return this.#graph.getStateHistory(mergeConfigs(this.#config, config), options);
  }

  updateState(config: RunnableConfig, values: unknown, asNode?: string): Promise<RunnableConfig> {
    return this.#graph.updateState(mergeConfigs(this.#config, config), values, asNode);
  }

  getSubgraphs(namespace?: string, recurse?: boolean): Generator<[string, unknown]> {
    return this.#graph.getSubgraphs(namespace, recurse);
  }

  getSubgraphsAsync(namespace?: string, recurse?: boolean): AsyncGenerator<[string, unknown]> {
    return this.#graph.getSubgraphsAsync(namespace, recurse);
  }

  getGraphAsync(config?: RunnableConfig): Promise<Graph> {
    return this.#graph.getGraphAsync(config ? mergeConfigs(this.#config, config) : this.#config);
  }
}

/** An assembled agent. See {@link ArchmaxAgent}. */
export type Agent = ArchmaxAgent;
