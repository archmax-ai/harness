/**
 * A cancelled turn: the host aborts `send` while a script awaits a `tools.*`
 * call, and disposes the session as soon as `send` settles, as a host does in a
 * `finally` around every send. The script stops with the turn, no work starts
 * under it, and a call that settles afterwards reaches nothing: the host's
 * process stays up.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { tool } from "langchain";
import { z } from "zod";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import type { StructuredTool } from "@langchain/core/tools";
import { workflowToolName, type WorkflowLifecycleEvent } from "../index.js";
import {
  AGENTS_MD,
  assemble,
  cleanupWorkspaces,
  freshSessionId,
  makeWorkspace,
  ScriptedModel,
  toolResults,
  turn,
  watchReplFrees,
  watchUnhandledRejections,
  workspaceWith,
  type ScriptedTurn,
} from "./support.js";

const RUNTIME = { engine: "archmax-harness", version: "2" };
/** Far beyond the test's own timeout: a script that ran to it would fail the test. */
const SCRIPT_TIMEOUT_MS = 60_000;

const stops: Array<() => void> = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
  vi.restoreAllMocks();
  cleanupWorkspaces();
});

function watchUnhandled(): unknown[] {
  const watch = watchUnhandledRejections();
  stops.push(watch.stop);
  return watch.seen;
}

/** The events emitted from `from` on: what happened after the abort. */
const after = (events: WorkflowLifecycleEvent[], from: number) => events.slice(from);

/**
 * A scripted model whose call number `hangAt` waits for the turn's abort and
 * then fails, as a child's model call stalled in production did.
 */
class StallingModel extends ScriptedModel {
  constructor(
    turns: ScriptedTurn[],
    private readonly hangAt: number,
    private readonly turnSignal: AbortSignal,
  ) {
    super(turns);
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    if (this.calls.length + 1 === this.hangAt) {
      await new Promise((_, reject) =>
        this.turnSignal.addEventListener("abort", () => reject(new Error("Abort")), { once: true }),
      );
    }
    return super._generate(messages);
  }
}

describe("a turn cancelled while its script awaits a child session", () => {
  const CHILD_TOOL = workflowToolName("derive");
  const root = () =>
    makeWorkspace({
      "AGENTS.md": AGENTS_MD,
      "workflows/w/workflow.yaml": {
        runtime: RUNTIME,
        settings: { timeoutMs: SCRIPT_TIMEOUT_MS },
        states: { start: { triggers: { manual: null }, tools: { allow: [CHILD_TOOL] } } },
      },
      "workflows/derive/workflow.yaml": {
        runtime: RUNTIME,
        states: { work: { triggers: { manual: { requires: ["invoice"] } } } },
      },
    });
  // Three dispatches in turn, each failure caught and the next one tried: the
  // shape of the script that took a production worker down.
  const fanOut = [
    "const results = [];",
    "for (const invoice of ['a', 'b', 'c']) {",
    "  try { results.push(await tools.archmaxWorkflowDerive({ invoice })); }",
    "  catch (e) { results.push('failed: ' + e.message); }",
    "}",
    "results;",
  ].join("\n");

  it("settles send, and starts no dispatch and no script call after the abort", async () => {
    const cancel = new AbortController();
    const unhandled = watchUnhandled();
    // Call 1 is the parent's eval; call 2, the first child's, stalls until the abort.
    const model = new StallingModel(
      [{ tool: "archmax_eval", args: { code: fanOut } }],
      2,
      cancel.signal,
    );
    const { agent, events } = await assemble(root(), { model });
    const sid = freshSessionId("cancel");

    const startedAt = Date.now();
    const sent = agent.workflow.send(
      sid,
      { message: "derive the three invoices" },
      { signal: cancel.signal },
    );
    await vi.waitFor(() => expect(events.some((e) => e.type === "sub-workflow-start")).toBe(true));
    const abortedAt = events.length;
    cancel.abort();
    await expect(sent).rejects.toThrow();
    agent.dispose(sid);

    expect(Date.now() - startedAt).toBeLessThan(SCRIPT_TIMEOUT_MS / 4);
    // What the script reaches for after the abort is refused before the tool, so
    // nothing is dispatched and nothing is called.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const later = after(events, abortedAt);
    expect(later.filter((e) => e.type === "sub-workflow-start")).toEqual([]);
    expect(later.filter((e) => e.type === "tool-called" && e.origin === "script")).toEqual([]);
    expect(unhandled).toEqual([]);
  });
});

describe("a host disposing a cancelled session while its script's call is pending", () => {
  /** A host tool whose call waits until the test settles it. */
  function gatedTool() {
    let settle!: (outcome: "resolve" | "reject") => void;
    const gate = new Promise<string>((resolve, reject) => {
      settle = (outcome) => (outcome === "resolve" ? resolve("late") : reject(new Error("late")));
    });
    let calls = 0;
    const slow = tool(
      async () => {
        calls += 1;
        return gate;
      },
      { name: "slow_tool", description: "Answers slowly.", schema: z.object({}) },
    ) as unknown as StructuredTool;
    return { slow, settle, calls: () => calls };
  }

  const spec = {
    runtime: RUNTIME,
    settings: { timeoutMs: SCRIPT_TIMEOUT_MS },
    states: { start: { triggers: { manual: null }, tools: { allow: ["slow_tool"] } } },
  };
  const awaitSlow = "try { await tools.slowTool({}); } catch (e) { await tools.slowTool({}); }";

  it.each(["resolve", "reject"] as const)(
    "keeps the process up when the call goes on to %s after the session is disposed",
    async (settle) => {
      const cancel = new AbortController();
      const unhandled = watchUnhandled();
      const frees = watchReplFrees();
      const gated = gatedTool();
      const { agent, model, events } = await assemble(workspaceWith(spec), {
        turns: [{ tool: "archmax_eval", args: { code: awaitSlow } }],
        params: { tools: [gated.slow] },
      });
      const sid = freshSessionId("dispose");

      const sent = agent.workflow.send(sid, { message: "go" }, { signal: cancel.signal });
      await vi.waitFor(() => expect(gated.calls()).toBe(1));
      const abortedAt = events.length;
      cancel.abort();
      await expect(sent).rejects.toThrow();
      // The host's `finally`: disposed at once, the call still pending.
      agent.dispose(sid);
      gated.settle(settle);

      await vi.waitFor(() => expect(frees.freed(`${sid}:agent`)).toBeDefined());
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(frees.freed(`${sid}:agent`)?.assertion).toBeUndefined();
      expect(unhandled).toEqual([]);
      expect(gated.calls()).toBe(1);
      expect(
        after(events, abortedAt).filter((e) => e.type === "tool-called" && e.origin === "script"),
      ).toEqual([]);

      // Another session in the same process still evaluates code.
      model.enqueue({ tool: "archmax_eval", args: { code: "1 + 1" } }, { reply: "two" });
      const { messages } = await turn(agent, freshSessionId("after"), "add");
      expect(toolResults(messages).find((r) => r.name === "archmax_eval")?.content).toContain("2");
    },
  );
});
