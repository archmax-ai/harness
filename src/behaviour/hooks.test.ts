/**
 * Lifecycle hooks: `before` gates entry, `after` gates the advance out (or the
 * completion of a terminal state); scripts run in the sandbox and vote through
 * `veto()`/`ok()`; a judge subagent may ask for a correction; errors fail closed; a
 * failed segment routes to `on_error`; `budget.maxTurns` bounds a segment.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isRuntimeNote, runtimeNoteKind } from "../index.js";
import { computeSpecHash } from "../workflow/snapshot.js";
import {
  advanceTo,
  advances,
  assemble,
  cleanupWorkspaces,
  eventsOf,
  freshSessionId,
  JudgeModel,
  statesEntered,
  storeFile,
  rubricDeclaration,
  toolResults,
  turn,
  workspaceWith,
} from "./support.js";

afterEach(cleanupWorkspaces);

const RUNTIME = { engine: "archmax-harness", version: "2" };

/** A hook script that vetoes with `reason`. */
const vetoScript = (reason: string) =>
  `/** Always refuses. */\nexport default () => veto(${JSON.stringify(reason)});\n`;

/** A hook script that passes, logging one line. */
const passScript = `/** Always passes. */\nexport default () => { console.log("gate passed"); return ok(); };\n`;

/**
 * A hook whose body is a list of `[condition, label]` checks: the first failing
 * check vetoes with its label; all passing is `ok`.
 */
const checks = (doc: string, lines: string[]) =>
  [
    `/** ${doc} */`,
    "export default async ({ state, phase, trigger, variables, messages, from, to, reason, tools }) => {",
    "  const checks = [",
    ...lines.map((line) => `    ${line},`),
    "  ];",
    "  const failed = checks.find(([passes]) => !passes);",
    "  return failed ? veto(failed[1]) : ok();",
    "};",
  ].join("\n");

/** A hook script that throws before voting. */
const throwingScript = `/** Blows up. */\nthrow new Error("hook exploded");\n`;

describe("before hooks", () => {
  const spec = (hook: string) => ({
    runtime: RUNTIME,
    states: {
      start: { triggers: { manual: null }, transitions: [{ to: "gated", description: "Test edge to gated." }] },
      gated: { before: { script: `hooks/${hook}` } },
    },
  });

  it("blocks entry when the script vetoes, and the run stays where it was", async () => {
    const sid = freshSessionId();
    const root = workspaceWith(spec("deny.js"), { "workflows/w/hooks/deny.js": vetoScript("not yet") });
    const { agent, events } = await assemble(root, {
      turns: [advanceTo("gated"), { reply: "could not enter" }],
    });
    const { messages } = await turn(agent, sid, "go");

    expect(advances(events)).toEqual([]);
    expect(statesEntered(events)).toEqual(["start"]);
    expect(eventsOf(events, "hook-verdict")).toMatchObject([
      { state: "gated", phase: "before", verdict: "veto", reason: "not yet" },
    ]);
    expect(eventsOf(events, "hook-rejected")).toMatchObject([{ state: "gated", phase: "before" }]);
    const refusal = toolResults(messages).find((r) => r.name === "archmax_advance");
    expect(refusal?.content).toContain("not yet");
    expect((await agent.sessions.get(sid))?.workflowState).toBe("start");
  });

  it("admits entry when the script passes, and reports its output", async () => {
    const sid = freshSessionId();
    const root = workspaceWith(spec("allow.js"), { "workflows/w/hooks/allow.js": passScript });
    const { agent, events } = await assemble(root, { turns: [advanceTo("gated"), { reply: "in" }] });
    await turn(agent, sid, "go");

    expect(statesEntered(events)).toEqual(["start", "gated"]);
    const starts = eventsOf(events, "hook-start");
    expect(starts.length).toBeGreaterThan(0);
    for (const start of starts) expect(start).toMatchObject({ state: "gated", phase: "before", label: "hooks/allow.js" });
    expect(eventsOf(events, "hook-output")[0]).toMatchObject({ state: "gated", line: "gate passed" });
    const verdicts = eventsOf(events, "hook-verdict");
    expect(verdicts.length).toBeGreaterThan(0);
    for (const v of verdicts) expect(v).toMatchObject({ state: "gated", phase: "before", verdict: "ok" });
    expect(eventsOf(events, "hook-rejected")).toEqual([]);
  });

  it("gates the entry state itself on the run's first segment", async () => {
    const sid = freshSessionId();
    const root = workspaceWith(
      {
        runtime: RUNTIME,
        states: { start: { triggers: { manual: null }, before: { script: "hooks/deny.js" } } },
      },
      { "workflows/w/hooks/deny.js": vetoScript("no requester") },
    );
    const { agent, events, model } = await assemble(root, { turns: [{ reply: "never asked" }] });
    await turn(agent, sid, "go");

    expect(eventsOf(events, "hook-rejected")).toMatchObject([{ state: "start", phase: "before" }]);
    // The model never ran: the gate refused before any segment.
    expect(model.calls).toHaveLength(0);
    expect((await agent.sessions.get(sid))?.classification).toBe("finished");
  });

  it("settles the session rejected when the entry state's gate refuses it", async () => {
    // The refusal used to end the turn looking completed: no `rejected` marker,
    // so a caller could not tell a governed refusal from a finished run — the
    // one path in a fail-closed design that failed open (issue #29).
    const sid = freshSessionId();
    const root = workspaceWith(
      {
        runtime: RUNTIME,
        states: { start: { triggers: { manual: null }, before: { script: "hooks/deny.js" } } },
      },
      { "workflows/w/hooks/deny.js": vetoScript("no requester") },
    );
    const { agent, model } = await assemble(root, { turns: [{ reply: "never asked" }] });
    const outcome = await agent.workflow.send(sid, { message: "go" });

    expect(model.calls).toHaveLength(0);
    expect(outcome.kind).toBe("rejected");
    expect(outcome.status).toBe("rejected");
    // The refusal is still the reply the person is owed.
    expect(outcome.reply).toContain("no requester");
    expect(await agent.sessions.get(sid)).toMatchObject({ status: "rejected", workflowState: "start" });
  });

  it("routes an entry state's refusal through its declared on_error", async () => {
    const sid = freshSessionId();
    const root = workspaceWith(
      {
        runtime: RUNTIME,
        states: {
          start: { triggers: { manual: null }, on_error: "escalate", before: { script: "hooks/deny.js" } },
          escalate: {},
        },
      },
      { "workflows/w/hooks/deny.js": vetoScript("no requester") },
    );
    const { agent, events } = await assemble(root, { turns: [{ reply: "escalated to a person" }] });
    const { reply } = await turn(agent, sid, "go");

    expect(eventsOf(events, "state-error-routed")).toMatchObject([{ state: "start", to: "escalate" }]);
    expect(reply).toBe("escalated to a person");
    expect(await agent.sessions.get(sid)).toMatchObject({ status: "completed", workflowState: "escalate" });
  });

  it("sees the run's variables and the user request in args", async () => {
    const sid = freshSessionId();
    const script = checks("Passes only when the seed and the request are visible.", [
      "[variables.from_email === 'a@b.c', 'seed visible']",
      "[messages.some((m) => m.role === 'user' && m.text.includes('hello')), 'request visible']",
      "[phase === 'before' && state === 'gated', 'phase and state']",
      "[variables.trigger === 'manual' && trigger === 'manual', 'trigger visible']",
    ]);
    const root = workspaceWith(spec("see.js"), { "workflows/w/hooks/see.js": script });
    const { agent, events } = await assemble(root, {
      turns: [advanceTo("gated"), { reply: "in" }],
      params: { variables: { from_email: "a@b.c" } },
    });
    await turn(agent, sid, "hello there");
    expect(statesEntered(events)).toEqual(["start", "gated"]);
  });

  it("can read workspace files through the privileged tool bridge", async () => {
    const sid = freshSessionId();
    const script = [
      "/** Reads a skill asset on runtime authority. */",
      "export default async ({ tools }) => {",
      "  const text = await tools.readFile({ file_path: 'skills/data/assets/x.json' });",
      "  return String(text).indexOf('\"ok\"') >= 0 ? ok() : veto('asset readable');",
      "};",
    ].join("\n");
    const root = workspaceWith(spec("read.js"), {
      "workflows/w/hooks/read.js": script,
      "skills/data/SKILL.md": "---\nname: data\ndescription: Data.\n---\n",
      "skills/data/assets/x.json": '{"ok":true}',
    });
    const { agent, events } = await assemble(root, { turns: [advanceTo("gated"), { reply: "in" }] });
    await turn(agent, sid, "go");
    expect(statesEntered(events)).toEqual(["start", "gated"]);
  });
});

describe("after hooks", () => {
  const spec = (hook: string, extra: Record<string, unknown> = {}) => ({
    runtime: RUNTIME,
    states: {
      start: { triggers: { manual: null }, after: { script: `hooks/${hook}` }, transitions: [{ to: "done", description: "Test edge to done." }], ...extra },
      done: {},
    },
  });

  it("vetoes the advance out of a state and leaves the run there", async () => {
    const sid = freshSessionId();
    const root = workspaceWith(spec("deny.js"), { "workflows/w/hooks/deny.js": vetoScript("incomplete") });
    const { agent, events } = await assemble(root, { turns: [advanceTo("done"), { reply: "stuck" }] });
    const { messages } = await turn(agent, sid, "go");

    expect(advances(events)).toEqual([]);
    expect(eventsOf(events, "hook-verdict")).toMatchObject([
      { state: "start", phase: "after", verdict: "veto", reason: "incomplete" },
    ]);
    const refusal = toolResults(messages).find((r) => r.name === "archmax_advance");
    expect(refusal?.content).toContain("incomplete");
    expect((await agent.sessions.get(sid))?.workflowState).toBe("start");
  });

  it("sees the transition it gates: from, to and the agent's reason", async () => {
    const sid = freshSessionId();
    const script = checks("Passes only when the transition is described.", [
      "[from === 'start' && to === 'done', 'edge visible']",
      "[reason === 'all set', 'reason visible']",
      "[phase === 'after', 'phase visible']",
    ]);
    const root = workspaceWith(spec("edge.js"), { "workflows/w/hooks/edge.js": script });
    const { agent, events } = await assemble(root, { turns: [advanceTo("done", "all set"), { reply: "ok" }] });
    await turn(agent, sid, "go");
    expect(statesEntered(events)).toEqual(["start", "done"]);
  });

  it("can inspect the run's transcript and files before letting the agent leave", async () => {
    const sid = freshSessionId();
    const script = [
      "/** Requires the decision file to exist and name an order. */",
      "export default async ({ tools }) => {",
      "  let raw = '';",
      "  try { raw = String(await tools.readFile({ file_path: 'scratchpad/decision.json' })); } catch {}",
      "  return raw.indexOf('ORD-1') >= 0 ? ok() : veto('decision recorded');",
      "};",
    ].join("\n");
    const root = workspaceWith(spec("file.js"), { "workflows/w/hooks/file.js": script });
    const { agent, events } = await assemble(root, {
      turns: [
        advanceTo("done", "too early"),
        { tool: "write_file", args: { file_path: "scratchpad/decision.json", content: '{"orderId":"ORD-1"}' } },
        advanceTo("done", "now recorded"),
        { reply: "ok" },
      ],
    });
    await turn(agent, sid, "go");
    expect(eventsOf(events, "hook-verdict").map((e) => e.verdict)).toEqual(["veto", "ok"]);
    expect(statesEntered(events)).toEqual(["start", "done"]);
  });

  it("runs at completion for a terminal state, asking for a revision until it passes", async () => {
    const sid = freshSessionId();
    // The completion check is not a transition: a failing verdict hands the
    // state back to the agent with a runtime note, and the run completes once
    // the check passes. This script passes only once the reply says "revised".
    const script = [
      "/** Requires the last reply to be a revision. */",
      "export default ({ messages }) => {",
      "  const replies = messages.filter((m) => m.role === 'assistant' && m.text);",
      "  const last = replies.length ? replies[replies.length - 1].text : '';",
      "  return last.indexOf('revised') >= 0 ? ok() : veto('reply revised');",
      "};",
    ].join("\n");
    const root = workspaceWith(
      {
        runtime: RUNTIME,
        states: {
          start: { triggers: { manual: null }, transitions: [{ to: "done", description: "Test edge to done." }] },
          done: { after: { script: "hooks/complete.js" } },
        },
      },
      { "workflows/w/hooks/complete.js": script },
    );
    const { agent, events } = await assemble(root, {
      turns: [advanceTo("done"), { reply: "first answer" }, { reply: "revised answer" }],
    });
    const { messages, reply } = await turn(agent, sid, "go");

    expect(eventsOf(events, "hook-verdict")).toMatchObject([
      { state: "done", phase: "after", verdict: "veto", reason: "reply revised" },
      { state: "done", phase: "after", verdict: "ok" },
    ]);
    expect(reply).toBe("revised answer");
    expect(messages.filter(isRuntimeNote).map(runtimeNoteKind)).toContain("after");
    // The revision happens inside the terminal node: no re-entry is announced.
    expect(statesEntered(events)).toEqual(["start", "done"]);
    const summary = await agent.sessions.get(sid);
    expect(summary?.status).toBe("completed");
  });

  it("completes a terminal state whose completion check passes", async () => {
    const sid = freshSessionId();
    const root = workspaceWith(
      {
        runtime: RUNTIME,
        states: {
          start: { triggers: { manual: null }, transitions: [{ to: "done", description: "Test edge to done." }] },
          done: { after: { script: "hooks/ok.js" } },
        },
      },
      { "workflows/w/hooks/ok.js": passScript },
    );
    const { agent, events } = await assemble(root, { turns: [advanceTo("done"), { reply: "final" }] });
    await turn(agent, sid, "go");
    expect(eventsOf(events, "hook-verdict")).toMatchObject([{ state: "done", phase: "after", verdict: "ok" }]);
    expect((await agent.sessions.get(sid))?.status).toBe("completed");
  });
});

describe("hook errors fail closed", () => {
  it("treats a throwing before hook as a veto and ends the segment", async () => {
    const sid = freshSessionId();
    const root = workspaceWith(
      {
        runtime: RUNTIME,
        states: {
          start: { triggers: { manual: null }, transitions: [{ to: "gated", description: "Test edge to gated." }] },
          gated: { before: { script: "hooks/boom.js" } },
        },
      },
      { "workflows/w/hooks/boom.js": throwingScript },
    );
    const { agent, events } = await assemble(root, { turns: [advanceTo("gated"), { reply: "?" }] });
    await turn(agent, sid, "go");

    expect(advances(events)).toEqual([]);
    expect(eventsOf(events, "hook-rejected")).toMatchObject([{ state: "gated", phase: "before" }]);
    expect(eventsOf(events, "hook-rejected")[0]?.reason).toMatch(/hook exploded/);
    expect((await agent.sessions.get(sid))?.status).toBe("rejected");
  });

  it("refuses the advance when an after hook returns a shape that is not a verdict", async () => {
    // The one that used to pass silently: a hook meaning to block returned a
    // retired shape, the runtime read it as `ok`, and the transition went
    // through with nothing said.
    const sid = freshSessionId();
    const root = workspaceWith(
      {
        runtime: RUNTIME,
        states: {
          start: { triggers: { manual: null }, after: { script: "hooks/wrong-shape.js" }, transitions: [{ to: "done", description: "Test edge to done." }] },
          done: {},
        },
      },
      {
        "workflows/w/hooks/wrong-shape.js":
          '/** Means to block, says it wrong. */\nexport default () => ({ ok: false, reason: "not allowed" });\n',
      },
    );
    const { agent, events } = await assemble(root, { turns: [advanceTo("done"), { reply: "?" }] });
    await turn(agent, sid, "go");

    expect(advances(events)).toEqual([]);
    expect(statesEntered(events)).toEqual(["start"]);
    const rejected = eventsOf(events, "hook-rejected");
    expect(rejected).toMatchObject([{ state: "start", phase: "after" }]);
    expect(rejected[0]?.reason).toMatch(/is not a verdict/);
    // Named by its keys, so the author can see which shape they returned.
    expect(rejected[0]?.reason).toMatch(/'ok', 'reason'/);
    expect((await agent.sessions.get(sid))?.status).toBe("rejected");
  });

  it("treats a missing hook script as an error, not as a pass", async () => {
    const sid = freshSessionId();
    const root = workspaceWith({
      runtime: RUNTIME,
      states: {
        start: { triggers: { manual: null }, transitions: [{ to: "gated", description: "Test edge to gated." }] },
        gated: { before: { script: "hooks/absent.js" } },
      },
    });
    const { agent, events } = await assemble(root, { turns: [advanceTo("gated"), { reply: "?" }] });
    await turn(agent, sid, "go");
    expect(statesEntered(events)).toEqual(["start"]);
    expect(eventsOf(events, "hook-rejected")).toHaveLength(1);
  });
});

describe("on_error routing", () => {
  it("routes a segment failed by a hook error to the declared error state with an error note", async () => {
    const sid = freshSessionId();
    const root = workspaceWith(
      {
        runtime: RUNTIME,
        states: {
          start: { triggers: { manual: null }, on_error: "escalate", transitions: [{ to: "gated", description: "Test edge to gated." }] },
          gated: { before: { script: "hooks/boom.js" } },
          escalate: {},
        },
      },
      { "workflows/w/hooks/boom.js": throwingScript },
    );
    const { agent, events } = await assemble(root, {
      // The failing segment still lets the agent close its turn before routing.
      turns: [advanceTo("gated"), { reply: "could not enter" }, { reply: "escalated to a person" }],
    });
    const { messages, reply } = await turn(agent, sid, "go");

    expect(eventsOf(events, "state-error-routed")).toMatchObject([{ state: "start", to: "escalate" }]);
    expect(eventsOf(events, "state-error-routed")[0]?.reason).toMatch(/hook exploded/);
    expect(statesEntered(events)).toEqual(["start", "escalate"]);
    expect(reply).toBe("escalated to a person");
    expect(messages.filter(isRuntimeNote).map(runtimeNoteKind)).toContain("error");
    expect((await agent.sessions.get(sid))).toMatchObject({ status: "completed", workflowState: "escalate" });
  });

  it("routes an exhausted turn budget to the error state", async () => {
    const sid = freshSessionId();
    const root = workspaceWith({
      runtime: RUNTIME,
      states: {
        start: {
          triggers: { manual: null },
          budget: { maxTurns: 1 },
          on_error: "escalate",
          transitions: [{ to: "done", description: "Test edge to done." }],
        },
        done: {},
        escalate: {},
      },
    });
    const probe = { tool: "archmax_get_variables", args: {} };
    const { agent, events } = await assemble(root, {
      turns: [probe, probe, probe, probe, probe, probe, { reply: "gave up" }],
    });
    await turn(agent, sid, "go");

    expect(eventsOf(events, "state-error-routed")).toMatchObject([{ state: "start", to: "escalate" }]);
    expect(statesEntered(events)).toEqual(["start", "escalate"]);
  });

  it("fails the turn closed when a budget is exhausted and no on_error is declared", async () => {
    const sid = freshSessionId();
    const root = workspaceWith({
      runtime: RUNTIME,
      states: {
        start: { triggers: { manual: null }, budget: { maxTurns: 1 }, transitions: [{ to: "done", description: "Test edge to done." }] },
        done: {},
      },
    });
    const probe = { tool: "archmax_get_variables", args: {} };
    const { agent, events, model } = await assemble(root, {
      turns: [probe, probe, probe, probe, probe, probe, { reply: "gave up" }],
    });
    await turn(agent, sid, "go");
    // The turn ends rejected where it stands: no error route, no further model
    // call — the one probe was the whole budget.
    expect(model.calls).toHaveLength(1);
    expect(statesEntered(events)).toEqual(["start"]);
    expect(eventsOf(events, "state-error-routed")).toEqual([]);
    const summary = await agent.sessions.get(sid);
    expect(summary).toMatchObject({ status: "rejected", classification: "finished", workflowState: "start" });
  });

  it("admits exactly as many agent turns as budget.maxTurns grants", async () => {
    const sid = freshSessionId();
    // A budget of N turns must let a run that spends N tool turns before its
    // advance succeed, and stop one that spends more. Pinned at N = 2: two
    // probes then the advance is within budget; five probes is not.
    const spec = {
      runtime: RUNTIME,
      states: {
        start: { triggers: { manual: null }, budget: { maxTurns: 2 }, on_error: "escalate", transitions: [{ to: "done", description: "Test edge to done." }] },
        done: {},
        escalate: {},
      },
    };
    const probe = { tool: "archmax_get_variables", args: {} };

    const within = await assemble(workspaceWith(spec), {
      turns: [probe, advanceTo("done"), { reply: "ok" }],
    });
    await turn(within.agent, sid, "go");
    expect(statesEntered(within.events)).toEqual(["start", "done"]);

    const beyond = await assemble(workspaceWith(spec), {
      turns: [probe, probe, probe, probe, probe, advanceTo("done"), { reply: "ok" }],
    });
    await turn(beyond.agent, sid, "go");
    expect(statesEntered(beyond.events)).toEqual(["start", "escalate"]);
  });
});

describe("a grading rubric as an after hook", () => {
  // Both budget levels in one fixture: the rubric declares one, and a state's
  // hook may override it for that state alone.
  // The budget is declared inside the rubric, because the rubric is declared on
  // the hook: there is one place to put it.
  const spec = (iterations = 1) => ({
    runtime: RUNTIME,
    states: {
      start: {
        triggers: { manual: null },
        after: { rubric: rubricDeclaration({ maxIterations: iterations }) },
        transitions: [{ to: "done", description: "Test edge to done." }],
      },
      done: {},
    },
  });

  it("lets the advance through on an ok verdict", async () => {
    const sid = freshSessionId();
    const judge = new JudgeModel([{ verdict: "ok", reason: "friendly" }]);
    const { agent, events } = await assemble(workspaceWith(spec()), {
      turns: [advanceTo("done"), { reply: "ok" }],
      rubricModel: judge,
    });
    await turn(agent, sid, "go");

    expect(judge.dispatches).toBe(1);
    expect(eventsOf(events, "rubric-start")).toMatchObject([{ name: "start--after--0", state: "start" }]);
    expect(eventsOf(events, "rubric-result")).toMatchObject([{ name: "start--after--0", status: "ok" }]);
    expect(eventsOf(events, "hook-verdict")).toMatchObject([{ verdict: "ok", reason: "friendly", phase: "after" }]);
    expect(statesEntered(events)).toEqual(["start", "done"]);
  });

  it("gives the agent another attempt on `correct`, then vetoes once max_iterations is spent", async () => {
    const sid = freshSessionId();
    const judge = new JudgeModel([
      { verdict: "correct", reason: "too curt" },
      { verdict: "correct", reason: "still curt" },
    ]);
    const { agent, events } = await assemble(workspaceWith(spec(1)), {
      turns: [advanceTo("done", "first try"), advanceTo("done", "second try"), { reply: "gave up" }],
      rubricModel: judge,
    });
    const { messages } = await turn(agent, sid, "go");

    const verdicts = eventsOf(events, "hook-verdict").map((e) => e.verdict);
    expect(verdicts).toEqual(["correct", "correct"]);
    const rejections = eventsOf(events, "hook-rejected").map((e) => e.reason);
    expect(rejections[0]).toMatch(/attempt\(s\) remaining/);
    expect(rejections[1]).toMatch(/veto/);
    // The first refusal tells the agent to try again; the second is final.
    const results = toolResults(messages).filter((r) => r.name === "archmax_advance");
    expect(results[0]?.content).toMatch(/Update your answer/);
    expect(advances(events)).toEqual([]);
    expect((await agent.sessions.get(sid))?.status).toBe("rejected");
  });

  it("admits the advance once a correction is followed by an ok verdict", async () => {
    const sid = freshSessionId();
    const judge = new JudgeModel([
      { verdict: "correct", reason: "add the order id" },
      { verdict: "ok", reason: "complete now" },
    ]);
    const { agent, events } = await assemble(workspaceWith(spec(2)), {
      turns: [advanceTo("done", "first"), advanceTo("done", "revised"), { reply: "ok" }],
      rubricModel: judge,
    });
    await turn(agent, sid, "go");
    expect(eventsOf(events, "hook-verdict").map((e) => e.verdict)).toEqual(["correct", "ok"]);
    expect(statesEntered(events)).toEqual(["start", "done"]);
  });

  it("hard-vetoes a correct verdict when the rubric grants no iterations", async () => {
    const sid = freshSessionId();
    const judge = new JudgeModel([{ verdict: "correct", reason: "needs work" }]);
    // No budget: the first `correct` is already a veto.
    const { agent, events } = await assemble(workspaceWith(spec(0)), {
      turns: [advanceTo("done"), { reply: "stuck" }],
      rubricModel: judge,
    });
    await turn(agent, sid, "go");
    expect(eventsOf(events, "hook-rejected")[0]?.reason).toMatch(/veto/);
    expect(advances(events)).toEqual([]);
  });

  it("keeps two inline rubrics on one state independent, in declaration order", async () => {
    const sid = freshSessionId();
    const judge = new JudgeModel([
      { verdict: "ok", reason: "tone fine" },
      { verdict: "ok", reason: "complete" },
    ]);
    const { agent, events } = await assemble(
      workspaceWith({
        runtime: RUNTIME,
        states: {
          start: {
            triggers: { manual: null },
            after: [
              { rubric: rubricDeclaration({ instructions: "tone", maxIterations: 2 }) },
              { rubric: rubricDeclaration({ instructions: "completeness" }) },
            ],
            transitions: [{ to: "done", description: "Test edge to done." }],
          },
          done: {},
        },
      }),
      { turns: [advanceTo("done"), { reply: "ok" }], rubricModel: judge },
    );
    await turn(agent, sid, "go");

    // Each is dispatched under its own positional id, so neither can be mistaken
    // for the other and neither shares the other's retry budget.
    expect(eventsOf(events, "rubric-start").map((e) => e.name)).toEqual([
      "start--after--0",
      "start--after--1",
    ]);
    expect(statesEntered(events)).toEqual(["start", "done"]);
  });

  it("vetoes on a veto verdict", async () => {
    const sid = freshSessionId();
    const judge = new JudgeModel([{ verdict: "veto", reason: "hostile" }]);
    const { agent, events } = await assemble(workspaceWith(spec()), {
      turns: [advanceTo("done"), { reply: "stuck" }],
      rubricModel: judge,
    });
    await turn(agent, sid, "go");
    expect(eventsOf(events, "hook-verdict")).toMatchObject([{ verdict: "veto", reason: "hostile" }]);
    expect(advances(events)).toEqual([]);
  });

  it("shows the agent that a state is graded, never what it is graded on", async () => {
    const sid = freshSessionId();
    const judge = new JudgeModel([{ verdict: "ok", reason: "fine" }]);
    const { agent, model } = await assemble(
      workspaceWith({
        runtime: RUNTIME,
        states: {
          start: {
            triggers: { manual: null },
            after: {
              rubric: rubricDeclaration({
                maxIterations: 3,
                model: "grader-model",
                instructions: "SECRET-CRITERION: reject any reply under ten words.",
              }),
            },
            transitions: [{ to: "done", description: "Test edge to done." }],
          },
          done: {},
        },
      }),
      { turns: [advanceTo("done"), { reply: "ok" }], rubricModel: judge },
    );
    await turn(agent, sid, "go");

    const prompts = model.calls.map((c) => c.systemPrompt).join("\n");
    // Presence is disclosed: a graded exit may come back for a correction.
    expect(prompts).toMatch(/after: rubric/);
    // Identity and criteria are not: no name, no body, no budget, no model id.
    expect(prompts).not.toContain("start--after--0");
    expect(prompts).not.toContain("SECRET-CRITERION");
    expect(prompts).not.toContain("grader-model");
    expect(prompts).not.toContain("max_iterations");
    // And no upstream guidance for a tool that is disclosed to no state: telling
    // the agent how to spawn subagents only teaches it to try.
    expect(prompts).not.toContain("subagent spawner");
    expect(prompts).not.toContain("Spawn");
  });

  it("vetoes fail-closed when the grader's model cannot serve the dispatch", async () => {
    const sid = freshSessionId();
    // A `model` id the host cannot serve fails at invocation. An `after` hook
    // that errors vetoes, so the transition is blocked rather than graded by
    // some fallback the author did not choose.
    const unusable = new JudgeModel([], undefined, "unknown model: grader-model");
    const { agent, events } = await assemble(
      workspaceWith({
        runtime: RUNTIME,
        states: {
          start: {
            triggers: { manual: null },
            after: { rubric: rubricDeclaration({ model: "grader-model" }) },
            transitions: [{ to: "done", description: "Test edge to done." }],
          },
          done: {},
        },
      }),
      { turns: [advanceTo("done"), { reply: "stuck" }], rubricModel: unusable },
    );
    await turn(agent, sid, "go");

    expect(eventsOf(events, "hook-rejected")[0]?.reason).toMatch(/unknown model: grader-model/);
    expect(advances(events)).toEqual([]);
    expect(statesEntered(events)).toEqual(["start"]);
  });

  it("keeps host metadata out of the prompt and out of the spec hash", async () => {
    const sid = freshSessionId();
    const judge = new JudgeModel([{ verdict: "ok", reason: "fine" }]);
    const withMetadata = {
      runtime: RUNTIME,
      metadata: { canvas: { zoom: "CANVAS-MARKER" } },
      states: {
        start: {
          triggers: { manual: null },
          metadata: { x: 40, y: "NODE-MARKER" },
          after: { rubric: rubricDeclaration({ metadata: { label: "RUBRIC-MARKER" } }) },
          transitions: [{ to: "done", description: "Test edge to done." }],
        },
        done: {},
      },
    };
    const { agent, model } = await assemble(workspaceWith(withMetadata), {
      turns: [advanceTo("done"), { reply: "ok" }],
      rubricModel: judge,
    });
    await turn(agent, sid, "go");

    const prompts = model.calls.map((c) => c.systemPrompt).join("\n");
    for (const marker of ["CANVAS-MARKER", "NODE-MARKER", "RUBRIC-MARKER", "metadata"]) {
      expect(prompts).not.toContain(marker);
    }

    // Inert also means invisible to the hash: moving a node on a canvas must not
    // mint a spec version and orphan a durable session.
    const hashed = computeSpecHash(withMetadata as never);
    const stripped = {
      runtime: RUNTIME,
      states: {
        start: {
          triggers: { manual: null },
          after: { rubric: rubricDeclaration() },
          transitions: [{ to: "done", description: "Test edge to done." }],
        },
        done: {},
      },
    };
    expect(hashed).toBe(computeSpecHash(stripped as never));
    expect((await agent.sessions.get(sid))?.specHash).toBe(hashed);
  });

  it("refuses an agent's own task call, whatever the state allows", async () => {
    const sid = freshSessionId();
    const judge = new JudgeModel([{ verdict: "ok", reason: "fine" }]);
    const { agent, model } = await assemble(
      workspaceWith({
        runtime: RUNTIME,
        states: {
          start: {
            triggers: { manual: null },
            after: { rubric: rubricDeclaration() },
            transitions: [{ to: "done", description: "Test edge to done." }],
          },
          done: {},
        },
      }),
      {
        turns: [
          { tool: "task", args: { description: "grade me", subagent_type: "start--after--0" } },
          advanceTo("done"),
          { reply: "ok" },
        ],
        rubricModel: judge,
      },
    );
    const { messages } = await turn(agent, sid, "go");

    // Registered rubrics make `task` exist for the runtime; it is disclosed to no
    // state, and a call to it is refused rather than serviced.
    expect(model.calls.every((c) => !c.tools.includes("task"))).toBe(true);
    const refusal = toolResults(messages).find((r) => r.name === "task");
    expect(refusal?.content ?? "").toMatch(/not a tool|BLOCKED/);
  });
});

/**
 * A `before` hook runs exactly once per entry into its state: at the
 * `archmax_advance` that enters it, and once more when a later turn opens there.
 * The hook leaves a mark per run, so the count is what the workspace shows.
 */
describe("which denials bind a hook", () => {
  // A hook runs on runtime authority: outside the state's tool surface in both
  // directions, so the state's `forbid` does not reach it — while the
  // workflow's does, as every safety rule does.
  const spec = {
    runtime: RUNTIME,
    tools: { forbid_always: [{ tool: "write_file" }] },
    states: {
      start: { triggers: { manual: null }, transitions: [{ to: "gated", description: "Test edge to gated." }] },
      gated: {
        tools: { forbid: [{ tool: "read_file" }] },
        before: { script: "hooks/probe.js" },
      },
    },
  };

  /**
   * Reads the file the active state forbids (expected to succeed) and writes the
   * one the workflow forbids (expected to throw), reporting each outcome.
   */
  const probe = [
    "/** Probes both denial levels from runtime authority. */",
    "export default async ({ tools }) => {",
    "  const read = await tools",
    '    .readFile({ file_path: "notes/brief.md" })',
    '    .then(() => "read: ran")',
    '    .catch((e) => `read: ${e.message}`);',
    "  const wrote = await tools",
    '    .writeFile({ file_path: "scratchpad/x.txt", content: "x" })',
    '    .then(() => "write: ran")',
    '    .catch((e) => `write: ${e.message}`);',
    "  console.log(read);",
    "  console.log(wrote);",
    "  return ok();",
    "};",
    "",
  ].join("\n");

  it("lets a hook past the state's forbid and holds it to the workflow's", async () => {
    const sid = freshSessionId();
    const root = workspaceWith(spec, {
      "workflows/w/hooks/probe.js": probe,
      "notes/brief.md": "# Brief\n",
    });
    const { agent, events } = await assemble(root, {
      turns: [advanceTo("gated"), { reply: "in" }],
    });
    await turn(agent, sid, "go");

    expect(statesEntered(events)).toEqual(["start", "gated"]);
    const lines = eventsOf(events, "hook-output").map((e) => e.line);
    // The state's denial shapes the model's surface, not the hook's.
    expect(lines).toContain("read: ran");
    // The workflow's denial is absolute — it binds the hook too.
    expect(lines.join("\n")).toMatch(/write: .*forbidden by the workflow/);
  });
});

describe("before hooks run once per entry", () => {
  const spec = {
    runtime: RUNTIME,
    states: {
      start: { triggers: { manual: null }, transitions: [{ to: "gated", description: "Test edge to gated." }] },
      gated: { before: { script: "hooks/mark.js" } },
    },
  };
  /** Writes `scratchpad/entry-<n>.txt`, n being one more than the marks already there. */
  const markScript = [
    "/** Leaves one mark per run. */",
    "export default async ({ tools }) => {",
    "  let listing = '';",
    "  try { listing = String(await tools.ls({ path: 'scratchpad' })); } catch { listing = ''; }",
    "  const n = (listing.match(/entry-/g) ?? []).length;",
    "  await tools.writeFile({ file_path: `scratchpad/entry-${n + 1}.txt`, content: 'x' });",
    "  return ok();",
    "};",
  ].join("\n");
  const beforeRuns = (events: Parameters<typeof eventsOf>[0]) =>
    eventsOf(events, "hook-start").filter((e) => e.state === "gated" && e.phase === "before");

  it("runs once at the advance into the state, and once more when the next turn opens there", async () => {
    const sid = freshSessionId();
    const root = workspaceWith(spec, { "workflows/w/hooks/mark.js": markScript });
    const { agent, events, model, store } = await assemble(root, { turns: [advanceTo("gated"), { reply: "in" }] });

    await turn(agent, sid, "go");
    expect(statesEntered(events)).toEqual(["start", "gated"]);
    expect(beforeRuns(events)).toHaveLength(1);
    expect(await storeFile(store, `/${sid}/scratchpad/entry-1.txt`)).toBe("x");
    expect(await storeFile(store, `/${sid}/scratchpad/entry-2.txt`)).toBeUndefined();

    // A turn that opens in `gated` (retained position) is a new entry: the gate runs once.
    model.enqueue({ reply: "still here" });
    await turn(agent, sid, "again");
    expect(beforeRuns(events)).toHaveLength(2);
    expect(await storeFile(store, `/${sid}/scratchpad/entry-2.txt`)).toBe("x");
    expect(await storeFile(store, `/${sid}/scratchpad/entry-3.txt`)).toBeUndefined();
  });
});
