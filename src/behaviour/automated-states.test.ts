/**
 * Automated states — `type: code` and `type: grader` — driven through the public
 * barrel. Each runs on entry with no model call of the session's agent, is
 * offered exactly its own state's tools, and leaves the way every state does:
 * `archmax_advance` along a declared edge, or `archmax_raise` to end the
 * session. A chain of code states makes no model call at all; a grader is an
 * isolated subagent whose own messages never reach the session's transcript.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isRuntimeNote, runtimeNoteKind } from "../index.js";
import {
  advanceTo,
  assemble,
  cleanupWorkspaces,
  eventsOf,
  freshSessionId,
  ScriptedModel,
  statesEntered,
  storeFile,
  workspaceWith,
} from "./support.js";

afterEach(cleanupWorkspaces);

const RUNTIME = { engine: "archmax-harness", version: "3" };

/** A code-state script file for the workspace. */
function script(body: string): string {
  return (
    `/** A test code state. */\nexport default async function ({ state, variables, tools }) {\n` +
    `  const { messages, trail } = JSON.parse(await tools.archmax_get_history());\n${body}\n}\n`
  );
}

/** The runtime notes a transcript carries, as `kind: text`. */
function notes(messages: unknown[]): string[] {
  return messages
    .filter((m) => isRuntimeNote(m) && (m as { getType?: () => string }).getType?.() === "tool")
    .map((m) => `${runtimeNoteKind(m)}: ${String((m as { content?: unknown }).content)}`);
}

describe("a code state", () => {
  it("runs on entry and chains into the next state with no model call", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        screen: {
          type: "code",
          script: "scripts/screen.js",
          triggers: { manual: null },
          transitions: [{ to: "enrich", description: "The request is fine." }],
        },
        enrich: {
          type: "code",
          script: "scripts/enrich.js",
          transitions: [{ to: "answer", description: "Enriched." }],
        },
        answer: {},
      },
    };
    const root = workspaceWith(spec, {
      "workflows/w/scripts/screen.js": script(
        `  console.log("screening " + messages.find((m) => m.role === "user").text);\n` +
          `  await tools.archmax_advance({ to: "enrich", reason: "the request names a requester" });`,
      ),
      "workflows/w/scripts/enrich.js": script(
        `  await tools.archmax_set_variables({ variables: { seen: trail.length } });\n` +
          `  await tools.archmax_advance({ to: "answer", reason: "enriched" });`,
      ),
    });
    const { agent, model, events } = await assemble(root, { turns: [{ reply: "here is your answer" }] });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "hi from ann@acme.test" });

    expect(outcome).toMatchObject({ kind: "completed", state: "answer", reply: "here is your answer" });
    // The agent's model was called once, in the agent state, and never in either code state.
    expect(model.calls).toHaveLength(1);
    expect(outcome.auditTrail.map((step) => `${step.kind}:${step.to}`)).toEqual([
      "trigger:screen",
      "code:enrich",
      "code:answer",
    ]);
    expect(outcome.variables.seen).toEqual({ value: 2, locked: false });
    expect(statesEntered(events)).toEqual(["screen", "enrich", "answer"]);
    expect(eventsOf(events, "code-output").map((e) => e.line)).toEqual(["screening hi from ann@acme.test"]);
    expect(eventsOf(events, "code-result").map((e) => `${e.state}:${e.status}`)).toEqual(["screen:ok", "enrich:ok"]);
    // The agent reads why it was entered.
    expect(notes(outcome.messages)).toEqual([
      "code: [code] 'screen' moved the run to 'enrich': the request names a requester. You are now in 'enrich'.",
      "code: [code] 'enrich' moved the run to 'answer': enriched. You are now in 'answer'.",
    ]);
    expect(model.calls[0]!.toolAnswers.map((a) => a.content).join("\n")).toContain("moved the run to 'answer'");
  });

  it("sees exactly its state's tools: a tool another state grants is undefined", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        probe: {
          type: "code",
          script: "scripts/probe.js",
          triggers: { manual: null },
          tools: { forbid: ["grep"] },
          transitions: [{ to: "done", description: "Probed." }],
        },
        other: { tools: { allow: ["archmax_workflow_x"] }, transitions: [{ to: "done", description: "x" }] },
        done: {},
      },
    };
    const root = workspaceWith(spec, {
      "workflows/w/scripts/probe.js": script(
        `  const listed = Object.keys(tools).sort();\n` +
          `  const absent = [typeof tools.write_todos, typeof tools.archmax_eval, typeof tools.archmax_wait, typeof tools.grep];\n` +
          `  await tools.archmax_set_variables({ variables: { listed, absent, both: typeof tools.read_file === typeof tools.readFile } });\n` +
          `  await tools.archmax_advance({ to: "done", reason: "probed" });`,
      ),
    });
    const { agent } = await assemble(root, { turns: [{ reply: "done" }] });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "go" });

    expect(outcome.kind).toBe("completed");
    const listed = outcome.variables.listed?.value as string[];
    expect(listed).toEqual(
      expect.arrayContaining(["readFile", "writeFile", "ls", "archmaxAdvance", "archmaxRaise", "archmaxSetVariables"]),
    );
    expect(listed).toContain("archmaxGetHistory");
    expect(listed).toContain("archmaxAddMessage");
    for (const name of ["writeTodos", "archmaxEval", "archmaxRun", "archmaxWait", "archmaxReset", "grep", "task"]) {
      expect(listed).not.toContain(name);
    }
    expect(outcome.variables.absent?.value).toEqual(["undefined", "undefined", "undefined", "undefined"]);
    expect(outcome.variables.both?.value).toBe(true);
  });

  it("reads the agent's tool calls and their results inline in the history", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        work: { triggers: { manual: null }, transitions: [{ to: "check", description: "The note is written." }] },
        check: { type: "code", script: "scripts/check.js", transitions: [{ to: "done", description: "Checked." }] },
        done: {},
      },
    };
    const root = workspaceWith(spec, {
      "workflows/w/scripts/check.js":
        `export default async function ({ tools }) {\n` +
        `  const { messages } = JSON.parse(await tools.archmax_get_history());\n` +
        `  const call = messages.flatMap((m) => m.toolCalls ?? []).find((c) => c.name === "write_file");\n` +
        `  const answered = messages.find((m) => m.role === "tool" && m.id === call.id);\n` +
        `  await tools.archmax_set_variables({ variables: { path: call.args.file_path, answered: answered.tool, text: answered.text } });\n` +
        `  await tools.archmax_advance({ to: "done", reason: "checked" });\n` +
        `}\n`,
    });
    const { agent } = await assemble(root, {
      turns: [
        { tool: "write_file", args: { file_path: "scratchpad/note.txt", content: "hello" } },
        { tool: "archmax_advance", args: { to: "check", reason: "written" } },
        { reply: "done" },
      ],
    });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "go" });

    expect(outcome).toMatchObject({ kind: "completed", state: "done" });
    expect(outcome.variables.path?.value).toBe("scratchpad/note.txt");
    expect(outcome.variables.answered?.value).toBe("write_file");
    expect(String(outcome.variables.text?.value)).toMatch(/note\.txt/);
  });

  it("can catch a refused advance and take a declared edge instead", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        route: {
          type: "code",
          script: "scripts/route.js",
          triggers: { manual: null },
          requires: ["verdict"],
          transitions: [{ to: "done", description: "Routed." }],
        },
        done: {},
      },
    };
    const root = workspaceWith(spec, {
      "workflows/w/scripts/route.js": script(
        `  const refusals = [];\n` +
          `  try { await tools.archmax_advance({ to: "done", reason: "too early" }); } catch (e) { refusals.push(e.message); }\n` +
          `  await tools.archmax_set_variables({ variables: { verdict: "ok" } });\n` +
          `  try { await tools.archmax_advance({ to: "nowhere", reason: "try" }); } catch (e) { refusals.push(e.message); }\n` +
          `  await tools.archmax_set_variables({ variables: { refusals } });\n` +
          `  await tools.archmax_advance({ to: "done", reason: "routed" });`,
      ),
    });
    const { agent } = await assemble(root, { turns: [{ reply: "done" }] });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "go" });

    expect(outcome).toMatchObject({ kind: "completed", state: "done" });
    const refusals = outcome.variables.refusals?.value as string[];
    expect(refusals[0]).toMatch(/cannot leave 'route' yet: 'verdict' is not set/);
    expect(refusals[1]).toMatch(/cannot advance from 'route' to 'nowhere'. Valid target slugs: done/);
    expect(outcome.auditTrail.at(-1)).toMatchObject({ kind: "code", to: "done", reason: "routed" });
  });

  it("fails closed when it finishes undecided, routing through on_error", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        check: {
          type: "code",
          script: "scripts/check.js",
          triggers: { manual: null },
          on_error: "escalate",
          transitions: [{ to: "done", description: "Checked." }],
        },
        done: {},
        escalate: {},
      },
    };
    const root = workspaceWith(spec, { "workflows/w/scripts/check.js": script(`  console.log("forgot to decide");`) });
    const { agent, model, events } = await assemble(root, { turns: [{ reply: "escalated" }] });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "go" });

    expect(outcome).toMatchObject({ kind: "completed", state: "escalate" });
    expect(model.calls).toHaveLength(1);
    const routed = eventsOf(events, "state-error-routed");
    expect(routed).toEqual([
      expect.objectContaining({
        state: "check",
        to: "escalate",
        reason: "code state 'check' finished without calling archmax_advance or archmax_raise",
      }),
    ]);
    expect(eventsOf(events, "code-result")[0]).toMatchObject({ state: "check", status: "error" });
  });

  it("discards a move when the script throws after advancing", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        check: {
          type: "code",
          script: "scripts/check.js",
          triggers: { manual: null },
          transitions: [{ to: "done", description: "Checked." }],
        },
        done: {},
      },
    };
    const root = workspaceWith(spec, {
      "workflows/w/scripts/check.js": script(
        `  await tools.archmax_advance({ to: "done", reason: "fine" });\n  throw new Error("but then it broke");`,
      ),
    });
    const { agent, model } = await assemble(root, { turns: [] });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "go" });

    expect(outcome.kind).toBe("rejected");
    expect(outcome.rejected).toMatch(/but then it broke/);
    expect(outcome.state).toBe("check");
    expect(model.calls).toHaveLength(0);
  });

  it("ends the session failed with archmax_raise", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        check: {
          type: "code",
          script: "scripts/check.js",
          triggers: { manual: null },
          on_error: "escalate",
          transitions: [{ to: "done", description: "Checked." }],
        },
        done: {},
        escalate: {},
      },
    };
    const root = workspaceWith(spec, {
      "workflows/w/scripts/check.js": script(
        `  await tools.archmax_raise({ code: "requester-unknown", reason: "no such requester" });`,
      ),
    });
    const { agent, model, events } = await assemble(root, { turns: [] });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "go" });

    expect(outcome).toMatchObject({ kind: "failed", state: "check" });
    expect(outcome.exit).toEqual({ success: false, code: "requester-unknown", reason: "no such requester" });
    expect(model.calls).toHaveLength(0);
    expect(eventsOf(events, "raised")).toEqual([expect.objectContaining({ state: "check", code: "requester-unknown" })]);
    expect(notes(outcome.messages)).toEqual([
      "code: [code] 'check' ended the session as failed ('requester-unknown'): no such requester",
    ]);
  });

  it("completes the session when a terminal code state returns, held to the trigger's returns", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        start: {
          triggers: { manual: { returns: ["summary"] } },
          transitions: [{ to: "record", description: "The answer is written." }],
        },
        record: { type: "code", script: "scripts/record.js" },
      },
    };
    const root = workspaceWith(spec, {
      "workflows/w/scripts/record.js": script(
        `  const asked = messages.find((m) => m.role === "user").text;\n` +
          `  await tools.write_file({ file_path: "scratchpad/answer.json", content: JSON.stringify({ asked }) });\n` +
          `  await tools.archmax_set_variables({ variables: { summary: "asked: " + asked } });`,
      ),
    });
    const { agent, model, store } = await assemble(root, { turns: [advanceTo("record", "answered")] });
    const sessionId = freshSessionId();
    const outcome = await agent.workflow.send(sessionId, { message: "summarize" });

    expect(outcome).toMatchObject({ kind: "completed", state: "record" });
    expect(outcome.exit).toEqual({ success: true });
    expect(outcome.variables.summary).toEqual({ value: "asked: summarize", locked: false });
    expect(model.calls).toHaveLength(1);
    expect(await storeFile(store, `/${sessionId}/scratchpad/answer.json`)).toBe(JSON.stringify({ asked: "summarize" }));
  });

  it("starts the next turn at the entry when the session completed in a terminal code state", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        start: { triggers: { manual: null }, transitions: [{ to: "record", description: "Answered." }] },
        record: { type: "code", script: "scripts/record.js" },
      },
    };
    const root = workspaceWith(spec, { "workflows/w/scripts/record.js": script(`  console.log("recorded");`) });
    const { agent, model, events } = await assemble(root, {
      turns: [advanceTo("record", "answered"), { reply: "a follow-up answer" }],
    });
    const sessionId = freshSessionId();
    await agent.workflow.send(sessionId, { message: "first" });
    const second = await agent.workflow.send(sessionId, { message: "and another thing" });

    expect(second).toMatchObject({ kind: "completed", state: "start", reply: "a follow-up answer" });
    expect(model.calls).toHaveLength(2);
    expect(eventsOf(events, "code-start")).toHaveLength(1);
    expect(eventsOf(events, "workflow-reset").map((e) => e.entry)).toEqual(["start", "start"]);
  });

  it("parks the session when it advances into a human state", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        check: {
          type: "code",
          script: "scripts/check.js",
          triggers: { manual: null },
          transitions: [{ to: "review", description: "Needs a person." }],
        },
        review: {
          type: "human",
          instructions: "Approve the request.",
          transitions: [{ to: "done", type: "approve", description: "Approve." }],
        },
        done: {},
      },
    };
    const root = workspaceWith(spec, {
      "workflows/w/scripts/check.js": script(`  await tools.archmax_advance({ to: "review", reason: "over the limit" });`),
    });
    const { agent, model } = await assemble(root, { turns: [{ reply: "a person will review this" }] });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "go" });

    expect(outcome).toMatchObject({ kind: "parked", parkedChannel: "decision", state: "review" });
    // The park's one handoff message.
    expect(model.calls).toHaveLength(1);
    expect(outcome.reply).toBe("a person will review this");
    expect(outcome.auditTrail.at(-1)).toMatchObject({ kind: "code", to: "review", reason: "over the limit" });
  });
});

/** The transcript's assistant messages with text, in order, as `id: text`. */
function said(messages: unknown[]): Array<{ id: string; text: string }> {
  return messages
    .filter((m) => (m as { getType?: () => string }).getType?.() === "ai" && !isRuntimeNote(m))
    .map((m) => ({ id: String((m as { id?: unknown }).id), text: String((m as { content?: unknown }).content) }))
    .filter((m) => m.text !== "");
}

describe("a code state's messages", () => {
  it("answer the person from a terminal code state, with no model call", async () => {
    const spec = {
      runtime: RUNTIME,
      states: { status: { type: "code", script: "scripts/status.js", triggers: { manual: null } } },
    };
    const root = workspaceWith(spec, {
      "workflows/w/scripts/status.js": script(
        `  const id = messages.find((m) => m.role === "user").text.match(/ORD-\\d+/)[0];\n` +
          `  await tools.archmax_add_message({ text: "Order " + id + " shipped on 3 May." });`,
      ),
    });
    const { agent, model, events } = await assemble(root, { turns: [] });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "Where is ORD-1001?" });

    expect(outcome).toMatchObject({ kind: "completed", state: "status", reply: "Order ORD-1001 shipped on 3 May." });
    expect(model.calls).toHaveLength(0);
    const [message, ...more] = said(outcome.messages);
    expect(more).toEqual([]);
    expect(message?.text).toBe("Order ORD-1001 shipped on 3 May.");
    expect(outcome.messages.at(-1)).toMatchObject({ content: "Order ORD-1001 shipped on 3 May." });
    // The event names the message the transcript holds.
    expect(eventsOf(events, "agent-text")).toEqual([
      expect.objectContaining({ state: "status", text: "Order ORD-1001 shipped on 3 May.", messageId: message?.id }),
    ]);
  });

  it("precede the move's note, and the agent reads them before it", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        screen: {
          type: "code",
          script: "scripts/screen.js",
          triggers: { manual: null },
          transitions: [{ to: "answer", description: "Looked up." }],
        },
        answer: {},
      },
    };
    const root = workspaceWith(spec, {
      "workflows/w/scripts/screen.js": script(
        `  await tools.archmax_add_message({ text: "Checking your order." });\n` +
          `  await tools.archmax_add_message({ text: "It shipped." });\n` +
          `  await tools.archmax_advance({ to: "answer", reason: "looked up" });`,
      ),
    });
    const { agent, model } = await assemble(root, { turns: [{ reply: "Anything else?" }] });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "where is my order?" });

    expect(outcome).toMatchObject({ kind: "completed", state: "answer" });
    expect(outcome.reply).toBe("Checking your order.\n\nIt shipped.\n\nAnything else?");
    // In the transcript: the person, both messages in order, then the note's pair.
    const kinds = outcome.messages.map((m) =>
      isRuntimeNote(m) ? `note:${(m as { getType: () => string }).getType()}` : (m as { getType: () => string }).getType(),
    );
    expect(kinds.slice(0, 5)).toEqual(["human", "ai", "ai", "note:ai", "note:tool"]);
    expect(said(outcome.messages).map((m) => m.text)).toEqual(["Checking your order.", "It shipped.", "Anything else?"]);
    // The agent's model call reads both, then the note.
    const shown = model.calls[0]!.parts.map((m) => `${m.type}:${m.parts.map((p) => p.text ?? "").join("")}`);
    const first = shown.indexOf("ai:Checking your order.");
    const second = shown.indexOf("ai:It shipped.");
    const note = shown.findIndex((line) => line.startsWith("tool:[code] 'screen' moved the run to 'answer'"));
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(note).toBeGreaterThan(second);
  });

  it("stand when the script raises", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        refund: {
          type: "code",
          script: "scripts/refund.js",
          triggers: { manual: null },
          transitions: [{ to: "done", description: "Refunded." }],
        },
        done: {},
      },
    };
    const root = workspaceWith(spec, {
      "workflows/w/scripts/refund.js": script(
        `  await tools.archmax_add_message({ text: "We cannot refund an order older than 30 days." });\n` +
          `  await tools.archmax_raise({ code: "refund-window", reason: "the order is 41 days old" });`,
      ),
    });
    const { agent, model } = await assemble(root, { turns: [] });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "refund ORD-7" });

    expect(outcome).toMatchObject({ kind: "failed", state: "refund", reply: "We cannot refund an order older than 30 days." });
    expect(outcome.exit).toEqual({ success: false, code: "refund-window", reason: "the order is 41 days old" });
    expect(model.calls).toHaveLength(0);
    expect(notes(outcome.messages)).toEqual([
      "code: [code] 'refund' ended the session as failed ('refund-window'): the order is 41 days old",
    ]);
  });

  it("are discarded when the run fails, so the on_error route speaks alone", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        refund: {
          type: "code",
          script: "scripts/refund.js",
          triggers: { manual: null },
          on_error: "escalate",
          transitions: [{ to: "done", description: "Refunded." }],
        },
        done: {},
        escalate: {},
      },
    };
    const root = workspaceWith(spec, {
      "workflows/w/scripts/refund.js": script(
        `  await tools.archmax_add_message({ text: "Your refund is on its way." });\n` +
          `  throw new Error("the payment provider is down");`,
      ),
    });
    const { agent, events } = await assemble(root, { turns: [{ reply: "A colleague will look into it." }] });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "refund ORD-7" });

    expect(outcome).toMatchObject({ kind: "completed", state: "escalate", reply: "A colleague will look into it." });
    expect(said(outcome.messages).map((m) => m.text)).toEqual(["A colleague will look into it."]);
    expect(eventsOf(events, "agent-text").map((e) => e.text)).toEqual(["A colleague will look into it."]);
    expect(eventsOf(events, "code-result")[0]).toMatchObject({ state: "refund", status: "error" });
  });

  it("refuse a blank message the script can catch", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        screen: {
          type: "code",
          script: "scripts/screen.js",
          triggers: { manual: null },
          transitions: [{ to: "done", description: "Screened." }],
        },
        done: { type: "code", script: "scripts/done.js" },
      },
    };
    const root = workspaceWith(spec, {
      "workflows/w/scripts/screen.js": script(
        `  let refusal = "";\n` +
          `  try { await tools.archmax_add_message({ text: "   " }); } catch (e) { refusal = e.message; }\n` +
          `  await tools.archmax_set_variables({ variables: { refusal } });\n` +
          `  await tools.archmax_advance({ to: "done", reason: "screened" });`,
      ),
      "workflows/w/scripts/done.js": script(`  console.log("done");`),
    });
    const { agent, events } = await assemble(root, { turns: [] });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "go" });

    expect(outcome).toMatchObject({ kind: "completed", state: "done", reply: "" });
    expect(String(outcome.variables.refusal?.value)).toMatch(/archmax_add_message rejected: 'text' is empty/);
    expect(said(outcome.messages)).toEqual([]);
    expect(eventsOf(events, "agent-text")).toEqual([]);
  });

  it("reach a later state's history as the session's own, and not the run's own history", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        "look-up": {
          type: "code",
          script: "scripts/look-up.js",
          triggers: { manual: null },
          transitions: [{ to: "check", description: "Looked up." }],
        },
        check: { type: "code", script: "scripts/check.js" },
      },
    };
    const root = workspaceWith(spec, {
      "workflows/w/scripts/look-up.js":
        `export default async function ({ tools }) {\n` +
        `  await tools.archmax_add_message({ text: "Looked it up." });\n` +
        `  const { messages } = JSON.parse(await tools.archmax_get_history());\n` +
        `  await tools.archmax_set_variables({ variables: { own: messages.filter((m) => m.role === "assistant").length } });\n` +
        `  await tools.archmax_advance({ to: "check", reason: "looked up" });\n` +
        `}\n`,
      "workflows/w/scripts/check.js":
        `export default async function ({ tools }) {\n` +
        `  const { messages } = JSON.parse(await tools.archmax_get_history());\n` +
        `  await tools.archmax_set_variables({ variables: { seen: messages.map((m) => m.role + (m.note ? ":" + m.note : "") + ":" + m.text) } });\n` +
        `}\n`,
    });
    const { agent } = await assemble(root, { turns: [] });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "find it" });

    expect(outcome).toMatchObject({ kind: "completed", state: "check", reply: "Looked it up." });
    expect(outcome.variables.own?.value).toBe(0);
    expect(outcome.variables.seen?.value).toEqual([
      "user:find it",
      "assistant:Looked it up.",
      "runtime:code:[code] 'look-up' moved the run to 'check': looked up. You are now in 'check'.",
    ]);
  });

  it("are reported after the script's console lines and before its result", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        screen: {
          type: "code",
          script: "scripts/screen.js",
          triggers: { manual: null },
          transitions: [{ to: "answer", description: "Screened." }],
        },
        answer: {},
      },
    };
    const root = workspaceWith(spec, {
      "workflows/w/scripts/screen.js": script(
        `  console.log("screening");\n` +
          `  await tools.archmax_add_message({ text: "One moment." });\n` +
          `  await tools.archmax_advance({ to: "answer", reason: "screened" });`,
      ),
    });
    const { agent, events } = await assemble(root, { turns: [{ reply: "Here it is." }] });
    await agent.workflow.send(freshSessionId(), { message: "go" });

    const ORDERED = new Set([
      "code-start",
      "tool-called",
      "tool-result",
      "code-output",
      "agent-text",
      "code-result",
      "advance",
      "state-leave",
      "state-enter",
    ]);
    const stream = events
      .filter((e) => ORDERED.has(e.type))
      .map((e) => {
        const tool = (e as { tool?: string }).tool;
        return tool ? `${e.type}:${tool}` : e.type;
      });
    const from = stream.indexOf("code-start");
    expect(stream.slice(from, from + 13)).toEqual([
      "code-start",
      "tool-called:archmax_get_history",
      "tool-result:archmax_get_history",
      "tool-called:archmax_add_message",
      "tool-result:archmax_add_message",
      "tool-called:archmax_advance",
      "tool-result:archmax_advance",
      "code-output",
      "agent-text",
      "code-result",
      "advance",
      "state-leave",
      "state-enter",
    ]);
  });
});

describe("a grader state", () => {
  const spec = (grader: Record<string, unknown> = {}) => ({
    runtime: RUNTIME,
    states: {
      answer: {
        triggers: { manual: null },
        transitions: [{ to: "review", description: "The reply is written." }],
      },
      review: {
        type: "grader",
        instructions: "Judge the reply's tone. Send it back when it is curt.",
        on_error: "escalate",
        transitions: [
          { to: "answered", description: "The reply is friendly." },
          { to: "answer", description: "The reply is curt: send it back with what to change." },
        ],
        ...grader,
      },
      answered: { type: "code", script: "scripts/answered.js" },
      escalate: {},
    },
  });
  const files = { "workflows/w/scripts/answered.js": script(`  console.log("approved");`) };

  it("reads the history, sends the work back with a reason, then approves", async () => {
    const grader = new ScriptedModel([
      { tool: "archmax_get_history", args: {} },
      advanceTo("answer", "the reply is curt: thank the customer"),
      { tool: "archmax_get_history", args: {} },
      advanceTo("answered", "friendly now"),
    ]);
    const agentModel = new ScriptedModel([
      { tool: "archmax_advance", args: { to: "review", reason: "replied" } },
      { tool: "archmax_advance", args: { to: "review", reason: "replied again" } },
    ]);
    const { agent, events } = await assemble(workspaceWith(spec(), files), { model: agentModel, graderModel: grader });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "where is my order?" });

    expect(outcome).toMatchObject({ kind: "completed", state: "answered" });
    expect(outcome.auditTrail.map((step) => `${step.kind}:${step.to}`)).toEqual([
      "trigger:answer",
      "agent:review",
      "grader:answer",
      "agent:review",
      "grader:answered",
    ]);
    // The agent read the correction.
    expect(agentModel.calls[1]!.toolAnswers.map((a) => a.content).join("\n")).toContain(
      "[grader] The 'review' grader moved the run to 'answer': the reply is curt: thank the customer.",
    );
    // The grader was offered exactly its state's surface.
    const offered = grader.calls[0]!.tools;
    expect(offered).toEqual(expect.arrayContaining(["archmax_get_history", "archmax_advance", "archmax_raise", "read_file"]));
    for (const name of [
      "archmax_eval",
      "archmax_run",
      "write_todos",
      "archmax_wait",
      "archmax_reset",
      "archmax_add_message",
      "task",
    ]) {
      expect(offered).not.toContain(name);
    }
    // The grader's prompt is its preamble plus the state's criteria, and its task names the transitions.
    expect(grader.calls[0]!.systemPrompt).toContain("Judge the reply's tone.");
    expect(grader.calls[0]!.humanTexts[0]).toContain("- to `answered`");
    // The history it read holds the session's transcript and trail.
    const history = JSON.parse(grader.calls[1]!.toolAnswers[0]!.content) as {
      messages: Array<{ role: string; text: string }>;
      trail: Array<{ kind: string; to: string }>;
    };
    expect(history.messages[0]).toMatchObject({ role: "user", text: "where is my order?" });
    expect(history.trail.map((step) => step.kind)).toEqual(["trigger", "agent"]);
    // Nothing the grader said reached the session's transcript, and a decision ends its run.
    expect(grader.calls).toHaveLength(4);
    expect(eventsOf(events, "grader-result").map((e) => e.status)).toEqual(["ok", "ok"]);
  });

  it("ends the session failed with archmax_raise", async () => {
    const grader = new ScriptedModel([
      { tool: "archmax_raise", args: { code: "tone-unfixable", reason: "sent back twice already" } },
    ]);
    const agentModel = new ScriptedModel([advanceTo("review", "replied")]);
    const { agent } = await assemble(workspaceWith(spec(), files), { model: agentModel, graderModel: grader });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "hello" });

    expect(outcome).toMatchObject({ kind: "failed", state: "review" });
    expect(outcome.exit).toEqual({ success: false, code: "tone-unfixable", reason: "sent back twice already" });
  });

  it("fails closed when it answers in text without deciding", async () => {
    const grader = new ScriptedModel([{ reply: "looks fine to me" }]);
    const agentModel = new ScriptedModel([advanceTo("review", "replied"), { reply: "escalated" }]);
    const { agent, events } = await assemble(workspaceWith(spec(), files), { model: agentModel, graderModel: grader });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "hello" });

    expect(outcome).toMatchObject({ kind: "completed", state: "escalate" });
    expect(eventsOf(events, "state-error-routed")[0]).toMatchObject({
      state: "review",
      reason: "grader state 'review' finished without calling archmax_advance or archmax_raise",
    });
  });

  it("is bounded by its own time budget, routing through on_error", async () => {
    const grader = new ScriptedModel([{ tool: "archmax_get_history", args: {}, delayMs: 150 }]);
    const agentModel = new ScriptedModel([advanceTo("review", "replied"), { reply: "escalated" }]);
    const { agent, events } = await assemble(workspaceWith(spec({ budget: { timeoutMs: 50 } }), files), {
      model: agentModel,
      graderModel: grader,
    });
    await agent.workflow.send(freshSessionId(), { message: "hello" });

    expect(eventsOf(events, "state-error-routed")[0]).toMatchObject({
      reason: "grader state 'review' exceeded its time budget (timeoutMs: 50)",
    });
  });

  it("reports its model calls under its state", async () => {
    const grader = new ScriptedModel([{ ...advanceTo("answered", "fine"), usage: { input: 10, output: 5 } }]);
    const agentModel = new ScriptedModel([advanceTo("review", "replied")]);
    const { agent, events } = await assemble(workspaceWith(spec(), files), { model: agentModel, graderModel: grader });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "hello" });

    expect(eventsOf(events, "model-usage")).toEqual([
      expect.objectContaining({ state: "review", inputTokens: 10, outputTokens: 5 }),
    ]);
    expect(outcome.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    // A grader's tokens are never the session's text.
    expect(eventsOf(events, "agent-text")).toEqual([]);
  });
});

describe("an agent state's scripts", () => {
  it("reach only the active state's tools", async () => {
    const spec = {
      runtime: RUNTIME,
      states: {
        start: { triggers: { manual: null }, tools: { forbid: ["grep"] } },
      },
    };
    const code =
      "JSON.stringify([typeof tools.grep, typeof tools.archmax_advance, typeof tools.read_file, 'grep' in tools])";
    const { agent, model } = await assemble(workspaceWith(spec), {
      turns: [{ tool: "archmax_eval", args: { code } }, { reply: "done" }],
    });
    await agent.workflow.send(freshSessionId(), { message: "go" });

    const answer = model.calls[1]!.toolAnswers[0]!.content;
    expect(answer).toContain('["undefined","undefined","function",false]');
  });
});

describe("a workflow that still declares hooks", () => {
  it.each(["before", "after"])("fails to load on '%s'", async (key) => {
    const spec = {
      runtime: RUNTIME,
      states: { start: { triggers: { manual: null }, [key]: { script: "hooks/check.js" } } },
    };
    await expect(assemble(workspaceWith(spec))).rejects.toThrow(/no valid machine spec/);
  });
});
