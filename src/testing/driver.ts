/**
 * The host-side session engine cases drive the agent through. One engine per
 * case; it owns the case's session on the agent under test, its declared start
 * conditions (trigger, variables, seeded workspace files), and its latest turn
 * view. A thin caller of `agent.workflow.send`: where a message lands — a turn,
 * a reply to a session a person holds — is the session's business, decided by
 * the runtime exactly as it is for a host.
 */
import type { Agent, WorkflowSurface } from "../agent.js";
import { messagesToSessionView, type SessionView } from "../workflow/session-view.js";
import type { Outcome } from "../sessions/resume.js";
import type { ToolMockSpec } from "../core/tool-mocks.js";

/** The session name steps without a `session:` key drive. */
export const DEFAULT_SESSION_ID = "default";

export interface DriveSession {
  /** The session's name as the case declares it (`session:` on a step). */
  name: string;
  /**
   * The id the runtime addresses this session by — namespaced per case, since one
   * agent serves every case. One id: the runtime has no separate session beneath it.
   */
  sessionId: string;
  /** The validated trigger every driven turn of this session starts from. */
  trigger?: { id: string };
  /** Variables seeded into every driven turn of this session, locked by the runtime. */
  variables?: Record<string, unknown>;
  /** The session's latest turn view (empty until it first drives). */
  lastView: SessionView;
}

export interface SessionStartConditions {
  trigger?: { id: string };
  /**
   * Variables seeded for this session, supplied per turn rather than at
   * assembly: one agent serves every case of a suite, so a case's seeds cannot
   * ride the assembly-time `variables` seeds.
   */
  variables?: Record<string, unknown>;
  /** Workspace files seeded into the session before any turn. */
  files?: Record<string, unknown>;
}

/**
 * Validate-then-seed-then-store for a session's declared start conditions.
 * Fails closed before any turn: an unknown trigger id surfaces
 * `UnknownTriggerError` with the declared triggers, and declared files against
 * a target without a `sessions.seed` handle are refused rather than skipped.
 */
async function applyStartConditions(
  agent: Agent & { workflow: WorkflowSurface },
  session: DriveSession,
  input: SessionStartConditions,
): Promise<void> {
  if (input.trigger) {
    agent.workflow.resolveTrigger(input.trigger);
    session.trigger = input.trigger;
  }
  if (input.variables && Object.keys(input.variables).length > 0) {
    session.variables = { ...input.variables };
  }
  const files = input.files ?? {};
  if (Object.keys(files).length > 0) {
    if (typeof agent.sessions?.seed !== "function") {
      throw new Error(
        `this case declares ${Object.keys(files).length} workspace file(s), but the target ` +
          `runtime's session handles expose no 'seed' operation, so nothing can be placed in the ` +
          `session workspace before the agent runs. Supply a target whose sessions handle can seed ` +
          `(createAgent provides one).`,
      );
    }
    await agent.sessions.seed(session.sessionId, files);
  }
}

/**
 * The refusal for a sub-workflow mock against a target that cannot delegate.
 * Separate from the interception refusal because the fix is different: this one
 * is not about middleware but about the target being workflow-governed at all.
 */
export function unDelegatableMocksMessage(): string {
  return (
    `this case mocks a sub-workflow, but the target agent is not workflow-governed ` +
    `(agent.workflow is undefined) — it cannot dispatch sub-workflows, so the mock would ` +
    `never be consulted. Run the case against a workflow-governed target.`
  );
}

/** The refusal for mocks a target cannot intercept (single definition). */
export function unInterceptableMocksMessage(mockCount: number): string {
  return (
    `this case declares ${mockCount} tool mock(s), but the target agent ` +
    `cannot intercept agent-initiated tool calls (interception would be partial: ` +
    `scripts' PTC calls mocked, the agent's own calls real). Wire ` +
    `createToolMockMiddleware() into the target's middleware, or set ` +
    `toolMocks on a target that intercepts by other means.`
  );
}

export interface SessionEngine {
  /** Open a session, validating and applying its declared start conditions. */
  open(sessionId: string, conditions?: SessionStartConditions): Promise<DriveSession>;
  /** Drive one user turn on a session under its declared trigger. */
  send(sessionId: string, message: string, toolMocks?: ToolMockSpec[]): Promise<SessionView>;
  /** Resume a session parked at a human state with the person's chosen edge. */
  decide(sessionId: string, to: string, comment?: string): Promise<SessionView>;
  /**
   * Resume a session parked awaiting an event with a delivered firing; the
   * session continues in the state it parked in. Fails the case the way
   * production fails the host — the session was not parked — rather than
   * silently starting a new turn.
   */
  deliver(sessionId: string, trigger: string, variables?: Record<string, unknown>): Promise<SessionView>;
}

/** The view of one settled {@link Outcome}, as assertions read it. */
function viewOf(session: DriveSession, outcome: Outcome): SessionView {
  const view = messagesToSessionView(outcome.messages, session.name, outcome.auditTrail, outcome.variables);
  if (outcome.kind === "parked") {
    view.parked = true;
    if (outcome.parkedChannel) view.parkedChannel = outcome.parkedChannel;
    if (outcome.state) view.state = outcome.state;
  }
  return view;
}

/**
 * Create the per-case session engine. The default session runs on
 * `defaultSessionId` (caller-nameable via `sessionIdForCase`); every other
 * session's id derives from it, so naming the default names the whole case and
 * no session is a timestamped orphan.
 */
export function createSessionEngine(opts: {
  agent: Agent & { workflow: WorkflowSurface };
  defaultSessionId: string;
  /** Aborts every run this engine drives — the case's wall-clock budget. */
  signal?: AbortSignal;
}): SessionEngine {
  const { agent, defaultSessionId } = opts;
  const runConfig = opts.signal ? { signal: opts.signal } : {};
  const sessions = new Map<string, DriveSession>();

  function get(sessionId: string): DriveSession {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(
        `unknown session '${sessionId}' (opened: ${[...sessions.keys()].join(", ") || "none"})`,
      );
    }
    return session;
  }

  async function settle(session: DriveSession, outcome: Promise<Outcome>): Promise<SessionView> {
    const view = viewOf(session, await outcome);
    session.lastView = view;
    return view;
  }

  return {
    async open(name, conditions = {}) {
      if (sessions.has(name)) throw new Error(`session '${name}' is already open`);
      const session: DriveSession = {
        name,
        sessionId: name === DEFAULT_SESSION_ID ? defaultSessionId : `${defaultSessionId}-${name}`,
        lastView: messagesToSessionView([], name),
      };
      await applyStartConditions(agent, session, conditions);
      sessions.set(name, session);
      return session;
    },

    async send(sessionId, message, toolMocks = []) {
      const session = get(sessionId);
      // Every turn of a session runs under the session's declared trigger and
      // seeds — consistency by construction: a send step carries neither, so a
      // follow-up message cannot restart the session at a different start state.
      // Mocks ride the config, the one per-invocation channel; the runtime
      // decides whether this is a turn or a reply to a session a person holds.
      return settle(
        session,
        agent.workflow.send(
          session.sessionId,
          {
            message,
            ...(session.trigger ? { trigger: session.trigger } : {}),
            ...(session.variables ? { variables: session.variables } : {}),
          },
          { ...runConfig, configurable: { __toolMocks: toolMocks } },
        ),
      );
    },

    async deliver(sessionId, trigger, variables) {
      const session = get(sessionId);
      return settle(
        session,
        agent.workflow.send(
          session.sessionId,
          { delivery: { trigger: { id: trigger }, ...(variables ? { variables } : {}) } },
          runConfig,
        ),
      );
    },

    async decide(sessionId, to, comment) {
      const session = get(sessionId);
      return settle(
        session,
        agent.workflow.send(
          session.sessionId,
          { decision: { target: to, ...(comment ? { comment } : {}) } },
          runConfig,
        ),
      );
    },
  };
}
