/**
 * A turn that throws ends the session `failed` instead of leaving it `running`,
 * where every later message would be refused: the step limit, a model failing
 * mid-stream and a cancelled turn each leave an exit record, the original error
 * still reaches the caller, and the next message starts a fresh turn. A park the
 * turn committed before it threw is left as it is.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import {
  advanceTo,
  assemble,
  cleanupWorkspaces,
  linearSpec,
  ScriptedModel,
  STREAM_FAILURE,
  StreamingScriptedModel,
  workspaceWith,
  type ScriptedTurn,
} from "./support.js";

afterEach(cleanupWorkspaces);

const RUNTIME = { engine: "archmax-harness", version: "3" };

/** a ⇄ b, so a model that always advances never ends its turn. */
const CYCLE = {
  runtime: RUNTIME,
  states: {
    a: { triggers: { manual: null }, transitions: [{ to: "b", description: "Test edge to b." }] },
    b: { transitions: [{ to: "a", description: "Test edge to a." }] },
  },
};

/** A scripted model that cancels its own turn on call `at`, as a host aborting mid-run does. */
class CancellingModel extends ScriptedModel {
  constructor(
    turns: ScriptedTurn[],
    private readonly at: number,
    private readonly cancel: AbortController,
  ) {
    super(turns);
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    if (this.calls.length + 1 === this.at) {
      this.cancel.abort();
      throw new Error("Abort");
    }
    return super._generate(messages);
  }
}

describe("a turn that throws", () => {
  it("ends the session failed when the model fails mid-stream, and the next message runs a fresh turn", async () => {
    const model = new StreamingScriptedModel([{ reply: `partial ${STREAM_FAILURE}` }, { reply: "back again" }]);
    const { agent } = await assemble(workspaceWith(linearSpec()), { model });

    await expect(agent.workflow.send("s1", { message: "go" })).rejects.toThrow(/failed mid-stream/);
    expect(await agent.sessions.get("s1")).toMatchObject({
      status: "failed",
      classification: "finished",
      exit: { success: false, code: "turn-error", reason: "the model endpoint failed mid-stream" },
    });

    const next = await agent.workflow.send("s1", { message: "again" });
    expect(next).toMatchObject({ kind: "completed", reply: "back again" });
  });

  it("ends the session failed at the step limit, rethrowing the limit's own error", async () => {
    const turns: ScriptedTurn[] = Array.from({ length: 40 }, (_, i) => advanceTo(i % 2 === 0 ? "b" : "a"));
    const { agent, model } = await assemble(workspaceWith(CYCLE), { turns });

    await expect(agent.workflow.send("s1", { message: "go" }, { recursionLimit: 20 })).rejects.toThrow(
      /Recursion limit of 20/,
    );
    expect((await agent.sessions.get("s1"))?.exit).toMatchObject({ code: "recursion-limit" });

    turns.splice(model.calls.length, turns.length, { reply: "answered" });
    expect(await agent.workflow.send("s1", { message: "again" })).toMatchObject({ kind: "completed", reply: "answered" });
  });

  it("ends the session failed when the turn is cancelled mid-run", async () => {
    const cancel = new AbortController();
    const model = new CancellingModel([advanceTo("done"), { reply: "after the cancel" }], 2, cancel);
    const { agent } = await assemble(workspaceWith(linearSpec()), { model });

    await expect(agent.workflow.send("s1", { message: "go" }, { signal: cancel.signal })).rejects.toThrow();
    expect((await agent.sessions.get("s1"))?.exit).toMatchObject({ code: "turn-cancelled" });
    // Nothing the cancelled run settles late reopens it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await agent.sessions.get("s1"))?.status).toBe("failed");
  });

  it("leaves a session cancelled before it started usable, whatever reads it next", async () => {
    const { agent } = await assemble(workspaceWith(linearSpec()), { turns: [{ reply: "ok" }] });
    const cancel = new AbortController();
    cancel.abort();
    await expect(agent.workflow.send("s1", { message: "go" }, { signal: cancel.signal })).rejects.toThrow();
    // A write the cancelled run settles late must not make these reads throw.
    await agent.sessions.get("s1");
    expect(await agent.workflow.send("s1", { message: "again" })).toMatchObject({ reply: "ok" });
  });

  it("leaves a park it committed before it threw", async () => {
    const review = {
      runtime: RUNTIME,
      states: {
        work: { triggers: { manual: null }, transitions: [{ to: "review", description: "Hand it to a reviewer." }] },
        review: { type: "human", transitions: [{ to: "done", type: "approve", description: "Approve it." }] },
        done: {},
      },
    };
    // The handoff call after the advance into the human state is the one that fails.
    const model = new StreamingScriptedModel([advanceTo("review"), { reply: `handing over ${STREAM_FAILURE}` }]);
    const { agent } = await assemble(workspaceWith(review), { model });

    await expect(agent.workflow.send("s1", { message: "go" })).rejects.toThrow(/failed mid-stream/);
    expect((await agent.sessions.get("s1"))?.status).toBe("awaiting_decision");
  });
});
