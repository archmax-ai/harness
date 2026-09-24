import { describe, expect, it } from "vitest";
import type { Agent, WorkflowSurface } from "../agent.js";
import { outcomeOf, settle, type Outcome, type SendDisposition } from "../sessions/resume.js";
import { DEFAULT_SESSION_ID, createSessionEngine } from "./driver.js";

/**
 * Give a fake agent the `send` the engine drives through, composed over the
 * fake's own `invoke` / `decide` / `reply` / `deliver`. Production decides
 * "turn or reply" from the checkpoint; the fake decides it from the outcome it
 * last produced, which is the same fact.
 */
function withSend(agent: Agent & { workflow: WorkflowSurface }): Agent & { workflow: WorkflowSurface } {
  const held = new Map<string, boolean>();
  const wf = agent.workflow as unknown as Record<string, (...args: never[]) => Promise<Record<string, unknown>>>;
  const lastText = (messages: unknown[]): string => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { type?: string; content?: unknown };
      if (m?.type === "ai" && typeof m.content === "string" && m.content) return m.content;
    }
    return "";
  };
  const asOutcome = (o: Record<string, unknown>, disposition: SendDisposition): Outcome => {
    const parked = o.reparked === true;
    const state = (o.state ?? o.state) as string | undefined;
    const messages = (o.messages ?? []) as unknown[];
    return {
      kind: parked ? "parked" : "completed",
      disposition,
      ...(o.status ? { status: o.status as Outcome["status"] } : {}),
      ...(state ? { state } : {}),
      ...(o.parkedChannel ? { parkedChannel: o.parkedChannel as Outcome["parkedChannel"] } : {}),
      reply: typeof o.reply === "string" ? o.reply : lastText(messages),
      messages,
      auditTrail: (o.auditTrail ?? []) as Outcome["auditTrail"],
      variables: (o.variables ?? {}) as Outcome["variables"],
    };
  };
  const remember = (sessionId: string, o: Outcome): Outcome => {
    held.set(sessionId, o.kind === "parked" && o.parkedChannel === "decision");
    return o;
  };
  wf.send = (async (sessionId: string, input: Record<string, unknown>, config?: { configurable?: Record<string, unknown> }) => {
    if ("decision" in input) return remember(sessionId, asOutcome(await wf.decide(sessionId as never, input.decision as never), "decide"));
    if ("delivery" in input) return remember(sessionId, asOutcome(await wf.deliver(sessionId as never, input.delivery as never), "deliver"));
    if (held.get(sessionId)) {
      // A reply never routes: production reports it parked on the decision channel.
      const replied = asOutcome(await wf.reply(sessionId as never, input.message as never), "reply");
      return { ...replied, kind: "parked", parkedChannel: "decision" };
    }
    const result = (await (agent as unknown as { invoke: (i: unknown, c: unknown) => Promise<Record<string, unknown>> }).invoke(
      {
        messages: [{ role: "user", content: input.message }],
        ...(input.trigger ? { trigger: input.trigger } : {}),
        ...(input.variables
          ? {
              variables: Object.fromEntries(
                Object.entries(input.variables as Record<string, unknown>).map(([k, v]) => [k, { value: v, locked: true }]),
              ),
            }
          : {}),
      },
      { ...config, configurable: { thread_id: sessionId, ...(config?.configurable ?? {}) } },
    )) as Record<string, unknown>;
    return remember(sessionId, outcomeOf(settle(result), "turn"));
  }) as never;
  return agent;
}

/**
 * Per-session isolation is an engine invariant, covered here rather than by a
 * YAML case: the case format is one conversation on one session, so the
 * multi-session guarantees (derived session ids, views that never bleed
 * across sessions under concurrent sends) are pinned at the engine level.
 */

function fakeAgent(): {
  agent: Agent & { workflow: WorkflowSurface };
  sessions: string[];
} {
  const sessions: string[] = [];
  const agent = withSend({
    async invoke(
      input: { messages: Array<{ content: string }> },
      config: { configurable: { thread_id: string } },
    ) {
      sessions.push(config.configurable.thread_id);
      // Reply names the session, so a view leaking across sessions is visible.
      return {
        messages: [
          {
            type: "ai",
            content: `reply:${config.configurable.thread_id}:${input.messages[0]?.content}`,
          },
        ],
      };
    },
    toolMocks: true,
    sessions: { async seed() {} },
    dispose() {},
    workflow: {
      resolveTrigger(trigger?: { id: string }) {
        return { ...(trigger ?? { id: "manual" }), startState: "start" };
      },
    },
  } as unknown as Agent & { workflow: WorkflowSurface });
  return { agent, sessions };
}

describe("session engine isolation", () => {
  it("derives non-default session ids from the default session id", async () => {
    const { agent } = fakeAgent();
    const engine = createSessionEngine({ agent, defaultSessionId: "host-session" });
    await engine.open(DEFAULT_SESSION_ID);
    const known = await engine.open("known");
    const unknown = await engine.open("unknown");
    expect(known.sessionId).toBe("host-session-known");
    expect(unknown.sessionId).toBe("host-session-unknown");
  });

  it("keeps concurrent sessions' views isolated", async () => {
    const { agent, sessions } = fakeAgent();
    const engine = createSessionEngine({ agent, defaultSessionId: "t" });
    await engine.open("a");
    await engine.open("b");

    const [viewA, viewB] = await Promise.all([
      engine.send("a", "first"),
      engine.send("b", "second"),
    ]);

    expect(viewA.reply).toBe("reply:t-a:first");
    expect(viewB.reply).toBe("reply:t-b:second");
    expect(sessions.sort()).toEqual(["t-a", "t-b"]);
  });

  it("applies each session's declared trigger to its own sends only", async () => {
    const { agent } = fakeAgent();
    const inputs: Array<Record<string, unknown>> = [];
    const spied = agent as unknown as { invoke: (i: unknown, c: never) => unknown };
    const original = spied.invoke.bind(spied);
    spied.invoke = ((input: Record<string, unknown>, config: never) => {
      inputs.push(input);
      return original(input, config);
    }) as never;

    const engine = createSessionEngine({ agent, defaultSessionId: "t" });
    await engine.open(DEFAULT_SESSION_ID);
    await engine.open("triggered", { trigger: { id: "report_requested" } });

    await engine.send("triggered", "in session");
    await engine.send(DEFAULT_SESSION_ID, "on default");

    expect(inputs[0]?.trigger).toEqual({ id: "report_requested" });
    expect(inputs[1]?.trigger).toBeUndefined();
  });

  it("refuses double-opening and unknown sessions", async () => {
    const { agent } = fakeAgent();
    const engine = createSessionEngine({ agent, defaultSessionId: "t" });
    await engine.open("a");
    await expect(engine.open("a")).rejects.toThrow("already open");
    await expect(engine.send("ghost", "hi")).rejects.toThrow("unknown session 'ghost'");
  });
});

/** An agent whose delivery surface records what it received and how it replied. */
function deliveringAgent(outcome: Record<string, unknown> | Error) {
  const calls: Array<{ sessionId: string; delivery: unknown }> = [];
  const agent = withSend({
    async invoke() {
      return { messages: [{ type: "ai", content: "asked a question" }] };
    },
    toolMocks: true,
    sessions: { async seed() {} },
    dispose() {},
    workflow: {
      resolveTrigger: (trigger?: { id: string }) => ({
        ...(trigger ?? { id: "manual" }),
        startState: "start",
      }),
      async deliver(sessionId: string, delivery: unknown) {
        calls.push({ sessionId, delivery });
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    },
  } as unknown as Agent & { workflow: WorkflowSurface });
  return { agent, calls };
}

describe("delivering a firing into a driven session", () => {
  it("carries the trigger id and variables to the runtime's delivery surface", async () => {
    const { agent, calls } = deliveringAgent({
      messages: [{ type: "ai", content: "answered from the reply" }],
      auditTrail: [{ to: "answer", kind: "agent", ts: 1 }],
      reparked: false,
    });
    const engine = createSessionEngine({ agent, defaultSessionId: "t1" });
    await engine.open(DEFAULT_SESSION_ID);
    await engine.send(DEFAULT_SESSION_ID, "where is my order?", []);

    const view = await engine.deliver(DEFAULT_SESSION_ID, "email_reply", {
      reply_body: "the Tuesday one",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.delivery).toEqual({
      trigger: { id: "email_reply" },
      variables: { reply_body: "the Tuesday one" },
    });
    expect(view.reply).toContain("answered from the reply");
    expect(view.parked).toBe(false);
  });

  it("marks a run that parked again, with the channel it parked in", async () => {
    const { agent } = deliveringAgent({
      messages: [{ type: "ai", content: "waiting again" }],
      auditTrail: [],
      reparked: true,
      state: "await-approval",
    });
    const engine = createSessionEngine({ agent, defaultSessionId: "t1" });
    await engine.open(DEFAULT_SESSION_ID);
    await engine.send(DEFAULT_SESSION_ID, "hi", []);

    const view = await engine.deliver(DEFAULT_SESSION_ID, "email_reply");
    expect(view.parked).toBe(true);
    expect(view.state).toBe("await-approval");
  });

  it("propagates a refused delivery instead of starting a new turn", async () => {
    const { agent, calls } = deliveringAgent(
      Object.assign(new Error("Session 't1' is not parked awaiting an event"), {
        name: "SessionNotAwaitingInputError",
      }),
    );
    const engine = createSessionEngine({ agent, defaultSessionId: "t1" });
    await engine.open(DEFAULT_SESSION_ID);
    await engine.send(DEFAULT_SESSION_ID, "hi", []);

    await expect(engine.deliver(DEFAULT_SESSION_ID, "anything")).rejects.toThrow(
      /not parked awaiting an event/,
    );
    expect(calls).toHaveLength(1);
  });
});

/**
 * An agent whose first turn parks at a human state and whose messaging surface
 * records what a later `send` handed it.
 */
function humanParkedAgent(reply = "It is with a reviewer.") {
  const messages: Array<{ sessionId: string; message: string }> = [];
  const agent = withSend({
    async invoke() {
      return {
        messages: [{ type: "ai", content: "Recorded — sending it to a reviewer." }],
        status: "awaiting_decision",
        pendingDecision: { state: "refund-review" },
      };
    },
    toolMocks: true,
    sessions: { async seed() {} },
    dispose() {},
    workflow: {
      resolveTrigger: (trigger?: { id: string }) => ({
        ...(trigger ?? { id: "manual" }),
        startState: "start",
      }),
      async reply(sessionId: string, message: string) {
        messages.push({ sessionId, message });
        return {
          reply,
          state: "refund-review",
          reparked: true,
          status: "awaiting_decision",
          messages: [
            { type: "human", content: message },
            { type: "ai", content: reply },
          ],
          auditTrail: [],
        };
      },
    },
  } as unknown as Agent & { workflow: WorkflowSurface });
  return { agent, messages };
}

describe("sending to a session parked at a human state", () => {
  it("routes the message to the messaging surface instead of starting a turn", async () => {
    const { agent, messages } = humanParkedAgent();
    const engine = createSessionEngine({ agent, defaultSessionId: "t1" });
    await engine.open(DEFAULT_SESSION_ID);
    const parked = await engine.send(DEFAULT_SESSION_ID, "refund order 1042", []);
    expect(parked.parked).toBe(true);
    expect(parked.parkedChannel).toBe("decision");

    const view = await engine.send(DEFAULT_SESSION_ID, "any news on my refund?", []);

    expect(messages).toEqual([{ sessionId: "t1", message: "any news on my refund?" }]);
    expect(view.reply).toContain("It is with a reviewer");
    // Still parked at the same node: a message is answered, never acted on.
    expect(view.parked).toBe(true);
    expect(view.parkedChannel).toBe("decision");
    expect(view.state).toBe("refund-review");
  });

  it("carries the park's own message as the reply of the turn that parked", async () => {
    const { agent } = humanParkedAgent();
    const engine = createSessionEngine({ agent, defaultSessionId: "t1" });
    await engine.open(DEFAULT_SESSION_ID);

    const view = await engine.send(DEFAULT_SESSION_ID, "refund order 1042", []);

    // What the run said as it handed over is what a `reply` assertion grades.
    expect(view.reply).toContain("Recorded — sending it to a reviewer.");
  });

  it("keeps answering across several messages", async () => {
    const { agent, messages } = humanParkedAgent();
    const engine = createSessionEngine({ agent, defaultSessionId: "t1" });
    await engine.open(DEFAULT_SESSION_ID);
    await engine.send(DEFAULT_SESSION_ID, "refund order 1042", []);

    await engine.send(DEFAULT_SESSION_ID, "one?", []);
    await engine.send(DEFAULT_SESSION_ID, "two?", []);

    expect(messages.map((m) => m.message)).toEqual(["one?", "two?"]);
  });
});

describe("a decide that re-parks", () => {
  /** An agent whose first turn parks and whose decide re-parks at a second gate. */
  function twoGateAgent(): { agent: Agent & { workflow: WorkflowSurface }; calls: string[] } {
    const calls: string[] = [];
    const agent = withSend({
      async invoke(input: { messages: { content: string }[] }) {
        calls.push(`invoke:${input.messages[0]?.content}`);
        return {
          messages: [{ type: "ai", content: "parked" }],
          status: "awaiting_decision",
          pendingDecision: { state: "review-1", transitions: [] },
          auditTrail: [],
        };
      },
      toolMocks: true,
      sessions: { async seed() {} },
      dispose() {},
      workflow: {
        resolveTrigger: (t?: { id: string }) => ({
          ...(t ?? { id: "manual" }),
          startState: "start",
        }),
        async decide() {
          calls.push("decide");
          return {
            status: "awaiting_decision",
            workflowState: "review-2",
            reparked: true,
            parkedChannel: "decision" as const,
            state: "review-2",
            reply: "",
            messages: [{ type: "ai", content: "second gate" }],
            auditTrail: [],
          };
        },
        async reply() {
          calls.push("reply");
          return {
            status: "awaiting_decision",
            workflowState: "review-2",
            reparked: true,
            parkedChannel: "decision" as const,
            state: "review-2",
            reply: "still with the reviewer",
            messages: [{ type: "ai", content: "still with the reviewer" }],
            auditTrail: [],
          };
        },
      },
    } as unknown as Agent & { workflow: WorkflowSurface });
    return { agent, calls };
  }

  // The channel is what tells `send` that a person holds the run. Dropped here,
  // a `parked` assertion pinned to a channel failed on a run parked exactly as
  // it claimed — and the next `send` opened a turn on a human-held session.
  it("carries the park channel onto the view", async () => {
    const { agent } = twoGateAgent();
    const engine = createSessionEngine({ agent, defaultSessionId: "t" });
    await engine.open(DEFAULT_SESSION_ID);
    await engine.send(DEFAULT_SESSION_ID, "please refund");

    const view = await engine.decide(DEFAULT_SESSION_ID, "escalate", "needs a second look");

    expect(view.parked).toBe(true);
    expect(view.parkedChannel).toBe("decision");
    expect(view.state).toBe("review-2");
  });

  it("answers the next send instead of opening a turn on the held session", async () => {
    const { agent, calls } = twoGateAgent();
    const engine = createSessionEngine({ agent, defaultSessionId: "t" });
    await engine.open(DEFAULT_SESSION_ID);
    await engine.send(DEFAULT_SESSION_ID, "please refund");
    await engine.decide(DEFAULT_SESSION_ID, "escalate");

    const view = await engine.send(DEFAULT_SESSION_ID, "any update?");

    expect(calls).toEqual(["invoke:please refund", "decide", "reply"]);
    expect(view.reply).toBe("still with the reviewer");
    expect(view.parked).toBe(true);
  });
});
