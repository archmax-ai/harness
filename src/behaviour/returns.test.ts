/**
 * A trigger's `returns` at completion, and a caller's failed delegation.
 *
 * Nothing is handed back. A sub-workflow child that finishes without setting
 * every declared return completes at once, and its caller gets the returns it
 * did set plus a `note` naming the rest. A top-level session finishing short is
 * rejected with the check's own reason, and a mistyped return fails either way.
 * A child that raises fails the call at once.
 *
 * On the calling side, a failed child is the calling state's failure until a
 * later call of the same workflow from that state succeeds; a failure of
 * another workflow, or a rejection with another cause, still routes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { tool } from "langchain";
import { z } from "zod";
import type { StructuredTool } from "@langchain/core/tools";
import { isRuntimeNote, runtimeNoteKind, workflowToolName } from "../index.js";
import {
  AGENTS_MD,
  assemble,
  cleanupWorkspaces,
  eventsOf,
  freshSessionId,
  makeWorkspace,
  messageType,
  toolResults,
  workspaceWith,
  type ScriptedTurn,
} from "./support.js";

afterEach(cleanupWorkspaces);

const RUNTIME = { engine: "archmax-harness", version: "2" };
const CHILD_TOOL = workflowToolName("enrich");
const AUDIT_TOOL = workflowToolName("audit");

/** The text of every `[after]` runtime note in a transcript. */
function afterNotes(messages: unknown[]): string[] {
  return messages
    .filter((m) => isRuntimeNote(m) && runtimeNoteKind(m) === "after" && messageType(m) === "tool")
    .map((m) => String((m as { content: unknown }).content));
}

const setReturn: ScriptedTurn = {
  tool: "archmax_set_variables",
  args: { variables: { enrichment_file: "scratchpad/e.json" } },
};

/** The rejection a top-level session settles with when it finishes short of its returns. */
const UNSET_REJECTION =
  "Completed in state 'work' without setting 'enrichment_file', which trigger 'manual' declares in its " +
  "'returns'. Set it with 'archmax_set_variables' before finishing.";

describe("a top-level session that finishes short of its returns", () => {
  const SPEC = {
    runtime: RUNTIME,
    states: { work: { triggers: { manual: { returns: ["enrichment_file"] } } } },
  };

  it("is rejected at once with the check's reason, without another model call", async () => {
    const { agent, model } = await assemble(workspaceWith(SPEC), {
      turns: [{ reply: "all done" }, { reply: "never asked for" }],
    });
    const outcome = await agent.workflow.send("s1", { message: "go" });

    expect(outcome).toMatchObject({ kind: "rejected", state: "work", rejected: UNSET_REJECTION });
    expect(afterNotes(outcome.messages)).toEqual([]);
    expect(model.calls).toHaveLength(1);
  });

  it("completes when it sets them, on this turn or a later one", async () => {
    const { agent, model } = await assemble(workspaceWith(SPEC), { turns: [{ reply: "done" }] });
    expect((await agent.workflow.send("s1", { message: "go" })).kind).toBe("rejected");
    model.enqueue(setReturn, { reply: "set it" });
    expect((await agent.workflow.send("s1", { message: "please set the file" })).kind).toBe("completed");
  });
});

describe("returns beside a terminal after hook", () => {
  /** Passes only once the last reply says "revised" — so the first finish is vetoed. */
  const revisionHook = [
    "/** Requires the last reply to be a revision. */",
    "export default ({ messages }) => {",
    "  const replies = messages.filter((m) => m.role === 'assistant' && m.text);",
    "  const last = replies.length ? replies[replies.length - 1].text : '';",
    "  return last.indexOf('revised') >= 0 ? ok() : veto('reply revised');",
    "};",
  ].join("\n");
  const root = () =>
    workspaceWith(
      {
        runtime: RUNTIME,
        states: {
          work: { triggers: { manual: { returns: ["enrichment_file"] } }, after: { script: "hooks/complete.js" } },
        },
      },
      { "workflows/w/hooks/complete.js": revisionHook },
    );

  it("runs the hook first, then decides the returns once, handing nothing back", async () => {
    const { agent, events } = await assemble(root(), {
      turns: [{ reply: "first answer" }, { reply: "revised answer" }, { reply: "never asked for" }],
    });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "go" });

    expect(outcome).toMatchObject({ kind: "rejected", rejected: UNSET_REJECTION });
    expect(eventsOf(events, "hook-verdict").map((e) => e.verdict)).toEqual(["veto", "ok"]);
    expect(afterNotes(outcome.messages)).toEqual([expect.stringContaining("reply revised")]);
  });

  it("completes once the hook passes and the returns are set", async () => {
    const { agent } = await assemble(root(), {
      turns: [{ reply: "first answer" }, setReturn, { reply: "revised, with the file" }],
    });
    const outcome = await agent.workflow.send(freshSessionId(), { message: "go" });
    expect(outcome.kind).toBe("completed");
  });
});

/**
 * The parent: `start` — terminal unless told otherwise — may call `enrich` and
 * `audit`, and routes its failures to `failed`.
 */
function delegating(
  opts: {
    parentStart?: Record<string, unknown>;
    parentStates?: Record<string, unknown>;
    /**
     * What `enrich` declares in `returns`: `[enrichment_file]` (default), the
     * names given, or nothing (`false`), so a child completes in one reply.
     */
    enrichReturns?: boolean | string[];
  } = {},
) {
  const returns =
    opts.enrichReturns === false ? [] : Array.isArray(opts.enrichReturns) ? opts.enrichReturns : ["enrichment_file"];
  return makeWorkspace({
    "AGENTS.md": AGENTS_MD,
    "workflows/w/workflow.yaml": {
      runtime: RUNTIME,
      states: {
        start: {
          triggers: { manual: null },
          tools: { allow: [CHILD_TOOL, AUDIT_TOOL] },
          on_error: "failed",
          ...opts.parentStart,
        },
        failed: {},
        ...opts.parentStates,
      },
    },
    "workflows/enrich/workflow.yaml": {
      runtime: RUNTIME,
      states: {
        work: {
          triggers: { manual: { requires: ["order_id"], ...(returns.length > 0 ? { returns } : {}) } },
        },
      },
    },
    "workflows/audit/workflow.yaml": { runtime: RUNTIME, states: { check: { triggers: { manual: null } } } },
  });
}

const callChild: ScriptedTurn = { tool: CHILD_TOOL, args: { order_id: "ORD-7" } };
const RAISE: ScriptedTurn = { tool: "archmax_raise", args: { code: "orders-unavailable", reason: "The API is down." } };

describe("a child that finishes short of its returns", () => {
  it("completes at once: its caller gets the returns it set and a note naming the rest", async () => {
    const { agent, model, events } = await assemble(delegating({ enrichReturns: ["enrichment_file", "delayed"] }), {
      turns: [
        callChild,
        // — child: sets one of its two returns, then finishes —
        setReturn,
        { reply: "enriched" },
        // — parent —
        { reply: "parent finished" },
      ],
    });
    const outcome = await agent.workflow.send("s1", { message: "enrich ORD-7" });

    expect(eventsOf(events, "sub-workflow-result")).toMatchObject([
      { workflow: "enrich", status: "ok", returns: ["enrichment_file", "note"] },
    ]);
    const answer = toolResults(outcome.messages).find((r) => r.name === CHILD_TOOL);
    expect(JSON.parse(answer!.content)).toEqual({
      message: "enriched",
      returns: {
        enrichment_file: "scratchpad/e.json",
        note: "Not all return variables were set by the sub-workflow: 'delayed' was not set.",
      },
    });
    // Nothing handed back: the parent's dispatch, the child's two calls, the parent's reply.
    expect(model.calls).toHaveLength(4);
    const child = (await agent.sessions.list()).find((s) => s.parentSessionId === "s1");
    expect(child?.status).toBe("completed");
    expect(eventsOf(events, "state-error-routed")).toEqual([]);
    expect(outcome).toMatchObject({ kind: "completed", state: "start" });
  });

  it("hands back only the note when it set none", async () => {
    const { agent } = await assemble(delegating(), {
      turns: [callChild, { reply: "enriched" }, { reply: "parent finished" }],
    });
    const outcome = await agent.workflow.send("s1", { message: "enrich ORD-7" });

    const answer = toolResults(outcome.messages).find((r) => r.name === CHILD_TOOL);
    expect(answer?.status).not.toBe("error");
    expect(JSON.parse(answer!.content)).toEqual({
      message: "enriched",
      returns: { note: "Not all return variables were set by the sub-workflow: 'enrichment_file' was not set." },
    });
    expect(outcome).toMatchObject({ kind: "completed", state: "start" });
  });

  it("fails the call at once when it raises, carrying the child's code", async () => {
    const { agent, model } = await assemble(delegating(), {
      turns: [callChild, RAISE, { reply: "parent" }, { reply: "handled" }],
    });
    const outcome = await agent.workflow.send("s1", { message: "enrich ORD-7" });

    const answer = toolResults(outcome.messages).find((r) => r.name === CHILD_TOOL);
    expect(answer?.content).toMatch(/raised 'orders-unavailable' in state 'work'/);
    // One call for the parent's dispatch, one for the child's raise, then the parent's and the handler's.
    expect(model.calls).toHaveLength(4);
  });
});

describe("a caller whose delegation failed", () => {
  it("does not route through on_error when a later call of the same workflow succeeds", async () => {
    const { agent, events } = await assemble(delegating(), {
      turns: [
        callChild,
        RAISE, // — the child fails —
        callChild, // — the parent retries —
        setReturn,
        { reply: "enriched" }, // — the child completes —
        { reply: "parent finished" },
      ],
    });
    const outcome = await agent.workflow.send("s1", { message: "enrich ORD-7" });

    expect(eventsOf(events, "sub-workflow-result").map((e) => e.status)).toEqual(["error", "ok"]);
    expect(eventsOf(events, "state-error-routed")).toEqual([]);
    expect(outcome).toMatchObject({ kind: "completed", state: "start" });
    expect(outcome.reply).toBe("parent finished");
    // The trail still records both calls.
    expect(outcome.auditTrail.filter((s) => s.kind === "sub-workflow").map((s) => s.status)).toEqual(["error", "ok"]);
  });

  it("still routes when the call that succeeds is another workflow's", async () => {
    const { agent, events } = await assemble(delegating(), {
      turns: [
        callChild,
        RAISE, // — enrich fails —
        { tool: AUDIT_TOOL, args: {} },
        { reply: "audited" }, // — audit completes —
        { reply: "parent finished" },
        { reply: "handled" },
      ],
    });
    const outcome = await agent.workflow.send("s1", { message: "go" });

    expect(eventsOf(events, "sub-workflow-result").map((e) => [e.workflow, e.status])).toEqual([
      ["enrich", "error"],
      ["audit", "ok"],
    ]);
    expect(eventsOf(events, "state-error-routed")).toMatchObject([{ state: "start", to: "failed" }]);
    expect(eventsOf(events, "state-error-routed")[0]?.reason).toMatch(/raised 'orders-unavailable'/);
    expect(outcome.state).toBe("failed");
  });

  it("still routes a rejection with another cause, which no successful call recovers", async () => {
    // A guard whose `${{…}}` reference cannot resolve is a terminal block: it
    // commits the state's rejection, and a child completing afterwards changes nothing.
    const guarded = tool(async () => "sent", {
      name: "send_reply",
      description: "Send the reply.",
      schema: z.object({ to: z.string() }),
    }) as unknown as StructuredTool;
    const root = delegating({
      parentStart: {
        tools: { allow: [CHILD_TOOL, { tool: "send_reply", args: { to: ["${{customer_email}}"] } }] },
      },
    });
    const { agent, events } = await assemble(root, {
      turns: [
        { tool: "send_reply", args: { to: "a@b.c" } },
        callChild,
        setReturn,
        { reply: "enriched" }, // — the child completes —
        { reply: "parent finished" },
        { reply: "handled" },
      ],
      params: { tools: [guarded] },
    });
    const outcome = await agent.workflow.send("s1", { message: "go" });

    expect(eventsOf(events, "sub-workflow-result").map((e) => e.status)).toEqual(["ok"]);
    expect(eventsOf(events, "state-error-routed")).toMatchObject([{ state: "start", to: "failed" }]);
    expect(eventsOf(events, "state-error-routed")[0]?.reason).toContain("${{customer_email}}");
    expect(outcome.state).toBe("failed");
  });

  it("routes the failure of each of two children that fail in one batch", async () => {
    const { agent, events } = await assemble(delegating(), {
      turns: [
        { batch: [callChild, { tool: AUDIT_TOOL, args: {} }] },
        // — both children, in whichever order they run: each raises —
        RAISE,
        RAISE,
        { reply: "parent" },
        { reply: "handled" },
      ],
    });
    const outcome = await agent.workflow.send("s1", { message: "go" });

    expect(eventsOf(events, "sub-workflow-result").map((e) => e.status)).toEqual(["error", "error"]);
    const routed = eventsOf(events, "state-error-routed");
    expect(routed).toHaveLength(1);
    expect(routed[0]?.reason).toContain("'enrich'");
    expect(routed[0]?.reason).toContain("'audit'");
    expect(outcome.state).toBe("failed");
  });

  it("is forgiven by a successful transition, as before", async () => {
    const root = delegating({
      parentStart: { transitions: [{ to: "done", description: "Finish without the enrichment." }] },
      parentStates: { done: {} },
    });
    const { agent, events } = await assemble(root, {
      turns: [callChild, RAISE, { tool: "archmax_advance", args: { to: "done", reason: "routing around it" } }, { reply: "done" }],
    });
    const outcome = await agent.workflow.send("s1", { message: "go" });
    expect(eventsOf(events, "state-error-routed")).toEqual([]);
    expect(outcome).toMatchObject({ kind: "completed", state: "done" });
  });
});

/**
 * A failure is recorded per call, with its input. Two parallel calls of one
 * workflow that fail are two failures, and one successful retry recovers at most
 * one of them: the one whose input it repeats, else the oldest.
 */
describe("parallel calls of one workflow that fail", () => {
  const root = () => delegating({ enrichReturns: false });
  const enrich = (order_id: string) => ({ tool: CHILD_TOOL, args: { order_id } });
  const bothFail: ScriptedTurn[] = [
    { batch: [enrich("ORD-1"), enrich("ORD-2")] },
    // — both children, in whichever order they run: each raises —
    RAISE,
    RAISE,
  ];

  it("still routes when only one is retried, naming the call that was not", async () => {
    const { agent, events } = await assemble(root(), {
      turns: [...bothFail, enrich("ORD-1"), { reply: "ORD-1 enriched" }, { reply: "parent finished" }, { reply: "handled" }],
    });
    const outcome = await agent.workflow.send("s1", { message: "enrich both" });

    expect(eventsOf(events, "sub-workflow-result").map((e) => e.status)).toEqual(["error", "error", "ok"]);
    const routed = eventsOf(events, "state-error-routed");
    expect(routed).toMatchObject([{ state: "start", to: "failed" }]);
    expect(routed[0]?.reason).toContain('"order_id":"ORD-2"');
    expect(routed[0]?.reason).not.toContain('"order_id":"ORD-1"');
    expect(outcome.state).toBe("failed");
  });

  it("completes when both are retried", async () => {
    const { agent, events } = await assemble(root(), {
      turns: [
        ...bothFail,
        { batch: [enrich("ORD-1"), enrich("ORD-2")] },
        { reply: "enriched" },
        { reply: "enriched" },
        { reply: "parent finished" },
      ],
    });
    const outcome = await agent.workflow.send("s1", { message: "enrich both" });

    expect(eventsOf(events, "sub-workflow-result").map((e) => e.status)).toEqual(["error", "error", "ok", "ok"]);
    expect(eventsOf(events, "state-error-routed")).toEqual([]);
    expect(outcome).toMatchObject({ kind: "completed", state: "start" });
  });

  it("completes when the one failed call is retried with a corrected input", async () => {
    const { agent, events } = await assemble(root(), {
      turns: [enrich("ORD-1"), RAISE, enrich("ORD-1-corrected"), { reply: "enriched" }, { reply: "parent finished" }],
    });
    const outcome = await agent.workflow.send("s1", { message: "enrich it" });

    expect(eventsOf(events, "state-error-routed")).toEqual([]);
    expect(outcome).toMatchObject({ kind: "completed", state: "start" });
  });

  it("names both failures of one batch in the route", async () => {
    const { agent, events } = await assemble(root(), {
      turns: [...bothFail, { reply: "parent gives up" }, { reply: "handled" }],
    });
    const outcome = await agent.workflow.send("s1", { message: "enrich both" });

    const routed = eventsOf(events, "state-error-routed");
    expect(routed).toHaveLength(1);
    expect(routed[0]?.reason).toContain('"order_id":"ORD-1"');
    expect(routed[0]?.reason).toContain('"order_id":"ORD-2"');
    expect(outcome.state).toBe("failed");
  });

  it("does not let one success recover two failures, even with no input repeated", async () => {
    const { agent, events } = await assemble(root(), {
      turns: [...bothFail, enrich("ORD-9"), { reply: "enriched" }, { reply: "parent finished" }, { reply: "handled" }],
    });
    const outcome = await agent.workflow.send("s1", { message: "enrich both" });

    // The corrected call recovers the oldest failure; the other still routes.
    const routed = eventsOf(events, "state-error-routed");
    expect(routed).toHaveLength(1);
    expect(routed[0]?.reason.match(/"order_id":"ORD-\d"/g)).toHaveLength(1);
    expect(outcome.state).toBe("failed");
  });
});
