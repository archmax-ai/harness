/**
 * Session resolution: given a firing, decide how it lands on its session —
 * without invoking the graph or any model.
 *
 * The rule: **a session whose turn has finished takes its next turn on the same
 * session, continuing from the state it is in; a session whose turn is still
 * open resumes from the state where it parked.** A session is extended, never
 * copied, so there is one id and nothing to map it to. A mid-turn session fails
 * closed: a competing turn would break the checkpointer's single-writer guarantee.
 */
import type { WorkflowMachine } from "../machine/machine.js";
import {
  MANUAL_TRIGGER,
  parseSessionPath,
  resolveSessionId,
  type SessionPath,
} from "../machine/triggers.js";
import type { SessionSummary } from "./summary.js";
import { isFinished, WORKFLOW_STATUSES } from "../workflow/state.js";

/**
 * How a firing lands on its session: it opens a `turn`, it `resume`s the state
 * the session parked in, or — a session parked at a human state — it is a `reply`,
 * answered without moving the run.
 */
export type SessionDisposition = "turn" | "resume" | "reply";

export interface ResolvedSession {
  /** The session to invoke (`turn`) or deliver to (`resume`) — the only id there is. */
  sessionId: string;
  disposition: SessionDisposition;
  /**
   * `turn` only: where the turn begins — the retained position of a session that
   * already has one, else the entry state the firing's trigger declares.
   */
  startState?: string;
  /**
   * `resume` and `reply` only: the state the session is parked at — the one a
   * delivery resumes, or the human state a message is answered at.
   */
  state?: string;
  /** Whether the id was minted for this session because the firing declared none. */
  native: boolean;
}

/**
 * Thrown when a firing maps to a session whose turn is still in progress: a
 * session has a single writer, so the firing must wait. A human-parked session
 * is *not* this case — it resolves to `reply`.
 */
export class SessionNotResumableError extends Error {
  constructor(
    readonly sessionId: string,
    readonly status: string | undefined,
  ) {
    super(
      `Session '${sessionId}' has a turn in progress (status '${status ?? "unknown"}'). A ` +
        `session has a single writer: retry once the turn parks or ends.`,
    );
    this.name = "SessionNotResumableError";
  }
}

/** Thrown when a firing names a trigger no state of the workflow declares. */
export class UnknownSessionTriggerError extends Error {
  constructor(readonly trigger: string) {
    super(
      `No state declares trigger '${trigger}', and no parked session is awaiting it, so there ` +
        `is nowhere for this firing to go. Declare it under the 'triggers:' of the state a run ` +
        `should start in, or deliver the firing to a session parked on it — naming the session, ` +
        `or a 'sessionPath' to find it by.`,
    );
    this.name = "UnknownSessionTriggerError";
  }
}

/** What the caller supplies for one firing. */
export interface ResolveSessionInput {
  trigger?: { id: string };
  /** The variables the firing carries — the same map an invoke or delivery seeds. */
  variables?: Record<string, unknown>;
  /** An explicit id, taking precedence over every path. */
  sessionId?: string;
  /**
   * Where to read the id from for this firing — the same dotted path a
   * `triggers` entry declares (`triggers.-1.conversationId`), overriding what
   * the workflow says.
   */
  sessionPath?: string;
}

/** The lookups resolution needs from the runtime, kept injectable for testing. */
export interface SessionLookup {
  /** The session's state, projected from its own checkpoint — or `null` when the id names no session yet. */
  findSession(sessionId: string): Promise<SessionSummary | null>;
  /** Mint an id for a firing that declares no session of its own. */
  mintSessionId(): string;
}

/**
 * Derive a firing's session id: the explicit one, else the invoking trigger's
 * declared path resolved over the firing's variables, else a minted id (the
 * firing is its own session). Every turn belongs to exactly one session.
 */
export function deriveSessionId(
  path: SessionPath | undefined,
  input: ResolveSessionInput,
  nativeId: string,
): { sessionId: string; native: boolean; unresolvedPath?: SessionPath } {
  const explicit = input.sessionId?.trim();
  if (explicit) return { sessionId: explicit, native: false };
  if (path) {
    const resolved = resolveSessionId(path, input.variables ?? {});
    if (resolved !== undefined) return { sessionId: resolved, native: false };
    return { sessionId: nativeId, native: true, unresolvedPath: path };
  }
  return { sessionId: nativeId, native: true };
}

/**
 * Resolve and classify a firing. Never invokes the graph: the caller decides
 * whether to start the run or deliver into it.
 */
export async function resolveSession(
  machine: WorkflowMachine,
  lookup: SessionLookup,
  input: ResolveSessionInput,
  onWarning?: (message: string) => void,
): Promise<ResolvedSession> {
  const triggerId = input.trigger?.id ?? MANUAL_TRIGGER;
  const { sessionId, native, unresolvedPath } = deriveSessionId(
    sessionPathFor(machine, triggerId, input.sessionPath),
    input,
    lookup.mintSessionId(),
  );
  if (unresolvedPath) {
    onWarning?.(
      `Trigger '${triggerId}' declares session path '${unresolvedPath.raw}', which this firing's ` +
        `variables do not resolve. The firing is its own session ('${sessionId}') and cannot be ` +
        `continued by a later firing for the same conversation.`,
    );
  }

  // Where a *first* turn begins. A session that already has a position keeps it
  // (below), so an unknown trigger id is only fatal at a session's opening.
  const entryState = machine.startStateForTrigger(triggerId);
  const openAt = (startState: string): ResolvedSession => ({
    sessionId,
    disposition: "turn",
    startState,
    native,
  });
  const firstTurn = (): ResolvedSession => {
    if (!entryState) throw new UnknownSessionTriggerError(triggerId);
    return openAt(entryState);
  };

  // A minted id names a session that does not exist yet: nothing to look up.
  if (native) return firstTurn();

  const session = await lookup.findSession(sessionId);
  // Projected from the session's own checkpoint: an absent or unreadable session
  // is one that has not run yet.
  if (!session) return firstTurn();

  if (isFinished(session.status)) {
    // The previous turn ended; this firing is the next turn of the same
    // conversation, continuing from the state that turn left it in (the trigger's
    // entry state applies to a session's opening only). Only a position the
    // *current* definition still declares is reported: the graph falls back to
    // the trigger's entry state for one it cannot route to, and resolution must
    // say the same thing.
    const retained = session.workflowState;
    const routable = retained != null && Object.hasOwn(machine.spec.states, retained);
    return openAt(routable ? retained : (entryState ?? machine.entry));
  }

  // Parked at a human state: a person holds the run, so the firing cannot move
  // it — but it is a message in a live conversation, so it is answered where the
  // session stands and the park is left exactly as it was.
  if (session.status === WORKFLOW_STATUSES.awaitingDecision) {
    return {
      sessionId,
      disposition: "reply",
      ...(session.workflowState ? { state: session.workflowState } : {}),
      native: false,
    };
  }

  if (session.status !== WORKFLOW_STATUSES.awaitingInput) {
    throw new SessionNotResumableError(sessionId, session.status);
  }

  // Parked awaiting an event, and any event will do: the session resumes the
  // state it parked in, so there is no awaited id to match the firing against.
  // The open turn takes the firing rather than a competing turn starting.
  return {
    sessionId,
    disposition: "resume",
    state: session.workflowState,
    native: false,
  };
}

/**
 * The path this firing reads its id from: the caller's override if it supplied
 * one, else what the invoking trigger declares on the state it enters — one
 * parser for both.
 */
function sessionPathFor(
  machine: WorkflowMachine,
  triggerId: string,
  override: string | undefined,
): SessionPath | undefined {
  if (override === undefined || override.trim() === "") {
    return machine.sessionPathForTrigger(triggerId);
  }
  const parsed = parseSessionPath(override);
  if (parsed.error) throw new InvalidSessionPathError(override, parsed.error);
  return parsed.path;
}

/** Thrown when a caller-supplied session path is not a usable dotted path. */
export class InvalidSessionPathError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`the caller-supplied path '${path}' is not a usable session path: ${reason}`);
    this.name = "InvalidSessionPathError";
  }
}
