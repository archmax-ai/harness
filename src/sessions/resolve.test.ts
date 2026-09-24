import { describe, expect, it } from "vitest";
import { WorkflowMachine } from "../machine/machine.js";
import type { MachineSpec } from "../machine/types.js";
import type { SessionSummary } from "./summary.js";
import { WORKFLOW_STATUSES } from "../workflow/state.js";
import {
  InvalidSessionPathError,
  resolveSession,
  SessionNotResumableError,
  UnknownSessionTriggerError,
  type SessionLookup,
} from "./resolve.js";

const SPEC: MachineSpec = {
  states: {
    // `intake` parks itself with `archmax_wait` once it has asked; a delivery
    // resumes it there, so no state declares what it awaits. `email_reply` is
    // dual-role: it starts a run *and* resumes one, so a reply to a finished
    // conversation is served instead of failing.
    intake: {
      triggers: {
        email_received: { session: "triggers.-1.conversationId" },
        email_reply: { session: "triggers.-1.conversationId" },
      },
      transitions: [{ to: "answer", description: "Test edge to answer." }],
    },
    answer: {},
  },
};

const machine = WorkflowMachine.fromSpec(SPEC);

function lookupOf(sessions: Record<string, SessionSummary>): SessionLookup {
  return {
    // Mirrors the real lookup: the id *is* the address, so this is one direct
    // projection with no mapping step in front of it.
    findSession: async (sessionId) => sessions[sessionId] ?? null,
    mintSessionId: () => "minted-session",
  };
}

const parked = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  status: WORKFLOW_STATUSES.awaitingInput,
  classification: "open",
  workflowState: "intake",
  sessionId: "AAQk1",
  state: "intake",
  waitReason: "waiting for the customer's reply",
  ...over,
});

const firing = (id: string, conversationId = "AAQk1") => ({
  trigger: { id },
  variables: { triggers: [{ conversationId }] },
});

describe("resolveSession — deriving the id", () => {
  it("reads the trigger's declared path from the firing's variables", async () => {
    const resolved = await resolveSession(machine, lookupOf({}), firing("email_received"));
    expect(resolved).toMatchObject({
      sessionId: "AAQk1",
      disposition: "turn",
      startState: "intake",
      native: false,
    });
  });

  it("prefers an explicit id over the declared path", async () => {
    const resolved = await resolveSession(machine, lookupOf({}), {
      ...firing("email_received"),
      sessionId: "case-7",
    });
    expect(resolved.sessionId).toBe("case-7");
  });

  it("mints an id when the declared path does not resolve, and warns", async () => {
    const warnings: string[] = [];
    const resolved = await resolveSession(
      machine,
      lookupOf({}),
      { trigger: { id: "email_received" }, variables: {} },
      (w) => warnings.push(w),
    );
    expect(resolved).toMatchObject({ sessionId: "minted-session", native: true });
    expect(warnings[0]).toContain("cannot be continued by a later firing");
  });

  it("gives a trigger with no declared path a session of its own", async () => {
    const plain = WorkflowMachine.fromSpec({ states: { a: { triggers: { manual: null } } } });
    const resolved = await resolveSession(plain, lookupOf({}), { trigger: { id: "manual" } });
    expect(resolved).toMatchObject({ sessionId: "minted-session", native: true, disposition: "turn" });
  });
});

describe("resolveSession — a caller-supplied path", () => {
  it("reads the id from the caller's path instead of the trigger's", async () => {
    const resolved = await resolveSession(machine, lookupOf({}), {
      trigger: { id: "email_received" },
      variables: { mail: { session: { id: "MSFT-9" } } },
      sessionPath: "mail.session.id",
    });
    expect(resolved.sessionId).toBe("MSFT-9");
  });

  it("gives a trigger that declares none a path it would not otherwise have", async () => {
    const plain = WorkflowMachine.fromSpec({ states: { a: { triggers: { manual: null } } } });
    const resolved = await resolveSession(plain, lookupOf({}), {
      trigger: { id: "manual" },
      variables: { case_id: "C-7" },
      sessionPath: "case_id",
    });
    expect(resolved).toMatchObject({ sessionId: "C-7", native: false });
  });

  it("still yields to an explicit id", async () => {
    const resolved = await resolveSession(machine, lookupOf({}), {
      ...firing("email_received"),
      sessionPath: "mail.session.id",
      sessionId: "wins",
    });
    expect(resolved.sessionId).toBe("wins");
  });

  it("rejects a malformed path rather than silently ignoring it", async () => {
    await expect(
      resolveSession(machine, lookupOf({}), {
        ...firing("email_received"),
        sessionPath: "${{conversation_id}}",
      }),
    ).rejects.toThrow(InvalidSessionPathError);
  });
});

describe("resolveSession — dispositions", () => {
  it("resumes a parked session in the state it parked in", async () => {
    const resolved = await resolveSession(
      machine,
      lookupOf({ AAQk1: parked() }),
      firing("email_reply"),
    );
    expect(resolved).toMatchObject({
      disposition: "resume",
      sessionId: "AAQk1",
      state: "intake",
    });
  });

  // A park awaits no declared ids, so the open run takes whatever arrives —
  // starting a competing run for the same conversation is what session identity
  // exists to prevent.
  it("resumes a parked session for a trigger that could also start a run", async () => {
    const resolved = await resolveSession(
      machine,
      lookupOf({ AAQk1: parked() }),
      firing("email_received"),
    );
    expect(resolved).toMatchObject({ disposition: "resume", sessionId: "AAQk1" });
  });

  // An event that must never start a run is declared nowhere; the caller names
  // the session it belongs to, or the path to find it by.
  it("resumes a parked session for a trigger the workflow never declares", async () => {
    const named = await resolveSession(machine, lookupOf({ AAQk1: parked() }), {
      ...firing("ticket_closed"),
      sessionId: "AAQk1",
    });
    expect(named).toMatchObject({ disposition: "resume", sessionId: "AAQk1" });

    const byPath = await resolveSession(machine, lookupOf({ AAQk1: parked() }), {
      ...firing("ticket_closed"),
      sessionPath: "triggers.-1.conversationId",
    });
    expect(byPath).toMatchObject({ disposition: "resume", sessionId: "AAQk1" });
  });

  // Nothing declares it and nothing names a session: there is nowhere to go.
  it("fails closed on an undeclared trigger with no session to deliver into", async () => {
    await expect(resolveSession(machine, lookupOf({}), firing("ticket_closed"))).rejects.toThrow(
      UnknownSessionTriggerError,
    );
  });

  // The heart of the model: a finished session is extended, not copied, and it
  // continues where it left off rather than reopening at the trigger's entry.
  it("takes the next turn on the same session, continuing where it left off", async () => {
    const finished = parked({
      status: WORKFLOW_STATUSES.completed,
      classification: "finished",
      workflowState: "answer",
    });
    const resolved = await resolveSession(
      machine,
      lookupOf({ AAQk1: finished }),
      firing("email_reply"),
    );
    expect(resolved).toMatchObject({
      disposition: "turn",
      sessionId: "AAQk1",
      startState: "answer",
      native: false,
    });
  });

  it("refuses a firing for a run in progress rather than starting a competing one", async () => {
    const running = parked({ status: WORKFLOW_STATUSES.running, workflowState: "intake" });
    await expect(
      resolveSession(machine, lookupOf({ AAQk1: running }), firing("email_reply")),
    ).rejects.toThrow(SessionNotResumableError);
  });

  it("directs a firing for a human-parked run to the messaging surface", async () => {
    const human = parked({ status: WORKFLOW_STATUSES.awaitingDecision, workflowState: "review" });
    const resolved = await resolveSession(
      machine,
      lookupOf({ AAQk1: human }),
      firing("email_reply"),
    );
    // A person holds the run, so the firing cannot move it — but it is a message
    // in a live conversation, and the run answers it where it stands.
    expect(resolved).toMatchObject({
      disposition: "reply",
      sessionId: "AAQk1",
      state: "review",
      native: false,
    });
  });

  it("fails closed on a trigger with nowhere to go", async () => {
    await expect(
      resolveSession(machine, lookupOf({}), { trigger: { id: "unknown_event" } }),
    ).rejects.toThrow(UnknownSessionTriggerError);
  });
});

describe("resolveSession — a definition that changed", () => {
  it("falls back to the trigger's entry when the retained state no longer exists", async () => {
    const finished = parked({
      status: WORKFLOW_STATUSES.completed,
      classification: "finished",
      // A state the current definition does not declare — the edit dropped it.
      workflowState: "state-that-was-removed",
    });
    const resolved = await resolveSession(
      machine,
      lookupOf({ AAQk1: finished }),
      firing("email_reply"),
    );
    // The graph routes a position it cannot resolve to the trigger's entry, so
    // resolution must say the same thing rather than name a state the turn will
    // not actually begin in.
    expect(resolved).toMatchObject({ disposition: "turn", startState: "intake" });
  });
});

describe("resolveSession — a session that has not run yet", () => {
  it("opens at the trigger's entry state when the id names no session", async () => {
    const resolved = await resolveSession(machine, lookupOf({}), firing("email_reply"));
    expect(resolved).toMatchObject({
      disposition: "turn",
      sessionId: "AAQk1",
      startState: "intake",
    });
  });
});
