/**
 * A child session owns its session, its files and its mounts.
 *
 * - A host tool is told which session its call is made in: inside a dispatch,
 *   the child's own id, so a host that keeps session files in its own store
 *   addresses the child's folder, never its caller's.
 * - A child's id is its dispatch number in its parent session, `<parent>~<n>`,
 *   counted across the parent's turns in its checkpointed state, so a fresh
 *   agent per turn never hands two dispatches one child.
 * - A workflow writes a governed mount only where its own grants ask to, so a
 *   table shared by a caller and its children lets neither widen the other.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFilesystemSessionStore,
  createMemorySessionStore,
  defaultMounts,
  toolsFromMap,
  workflowToolName,
  type SessionStore,
} from "../index.js";
import { childSessionId } from "../public/spec.js";
import {
  advanceTo,
  assemble,
  blockedTools,
  cleanupWorkspaces,
  eventsOf,
  makeWorkspace,
  AGENTS_MD,
  storeFile,
  toolResults,
  turn,
  type ScriptedTurn,
} from "./support.js";

const storeDirs: string[] = [];
afterEach(() => {
  cleanupWorkspaces();
  for (const dir of storeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const RUNTIME = { engine: "archmax-harness", version: "2" };
const CHILD_TOOL = workflowToolName("enrich");

/** A parent whose one state delegates to `enrich`, answering every turn there. */
function parentSpec(allow: unknown[] = [CHILD_TOOL], extra: Record<string, unknown> = {}) {
  return { runtime: RUNTIME, ...extra, states: { start: { triggers: { manual: null }, tools: { allow } } } };
}

/** A child that finishes in the state it starts in. */
function childSpec(allow: unknown[] = [], extra: Record<string, unknown> = {}) {
  return {
    runtime: RUNTIME,
    ...extra,
    states: { work: { triggers: { manual: { requires: ["order_id"] } }, tools: { allow } } },
  };
}

/** A child that stops for a reviewer before it finishes. */
const REVIEWING_CHILD = {
  runtime: RUNTIME,
  states: {
    draft: {
      triggers: { manual: { requires: ["order_id"] } },
      transitions: [{ to: "review", description: "Test edge to review." }],
    },
    review: {
      type: "human",
      transitions: [{ to: "approved", type: "approve", description: "Test edge to approved." }],
    },
    approved: {},
  },
};

function workspace(parent: Record<string, unknown>, child: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return makeWorkspace({
    "AGENTS.md": AGENTS_MD,
    "workflows/w/workflow.yaml": parent,
    "workflows/enrich/workflow.yaml": child,
    ...extra,
  });
}

const evalCall = (code: string): ScriptedTurn => ({ tool: "archmax_eval", args: { code } });

/**
 * Rewrite a session parked on its child `n`, in a filesystem store, into the
 * shape 0.5 wrote: the child's folder named by `legacy`, and the parent's park
 * recording that identity and the dispatch id `subwf-<n>`. A checkpoint record
 * holds its payload as base64 JSON (`cp`, and `val` for a pending write).
 */
function asParkedBeforeDispatchNumbers(dir: string, parent: string, n: string, legacy: string): void {
  renameSync(join(dir, `${parent}~${n}`), join(dir, `${parent}~${legacy}`));
  const checkpoints = join(dir, parent, "checkpoints");
  for (const file of readdirSync(checkpoints)) {
    const path = join(checkpoints, file);
    const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    let changed = false;
    for (const field of ["cp", "val"]) {
      const encoded = record[field];
      if (typeof encoded !== "string") continue;
      const text = Buffer.from(encoded, "base64").toString("utf8");
      const rewritten = text
        .replaceAll(`"identity":"${n}"`, `"identity":"${legacy}"`)
        .replaceAll(`"dispatchId":"${n}"`, `"dispatchId":"subwf-${n}"`);
      if (rewritten === text) continue;
      record[field] = Buffer.from(rewritten, "utf8").toString("base64");
      changed = true;
    }
    if (changed) writeFileSync(path, JSON.stringify(record));
  }
}

describe("a host tool in a child session", () => {
  /** A host tool reporting the session it was told it runs in. */
  function whoami(seen: string[]) {
    return toolsFromMap({
      whoami: {
        description: "Names the session this call is made in.",
        inputSchema: { type: "object", properties: {} },
        handler: async (_input, context) => {
          seen.push(context.sessionId);
          return context.sessionId;
        },
      },
    });
  }

  it("is told the child's own session id, from the model and from a script alike", async () => {
    const seen: string[] = [];
    const root = workspace(parentSpec(["whoami", CHILD_TOOL]), childSpec(["whoami"]));
    const { agent } = await assemble(root, {
      params: { tools: whoami(seen) },
      turns: [
        { tool: "whoami", args: {} },
        evalCall("await tools.whoami({});"),
        { tool: CHILD_TOOL, args: { order_id: "ORD-7" } },
        // — child —
        { tool: "whoami", args: {} },
        evalCall("await tools.whoami({});"),
        { reply: "child done" },
        // — parent —
        { reply: "parent done" },
      ],
    });
    await turn(agent, "s1", "go");

    const child = childSessionId("s1", 1);
    expect(seen).toEqual(["s1", "s1", child, child]);
    expect((await agent.sessions.list()).map((s) => s.sessionId).sort()).toEqual(["s1", child]);
  });

  /**
   * The contract a host's own file service rests on: a session's agent-visible
   * files live under `<sessionId>/` in the session store. A host tool keying by
   * the session it sent the turn to would write the parent's folder, where the
   * child's `read_file` never looks.
   */
  it("addresses the child's own files in the session store by that id", async () => {
    let store: SessionStore = createMemorySessionStore();
    const stash = toolsFromMap({
      stash: {
        description: "Writes a file through the host's own handle on the session store.",
        inputSchema: { type: "object", properties: {} },
        handler: async (_input, context) => {
          const written = await store.backend.write(`/${context.sessionId}/scratchpad/x.txt`, "from the host");
          return written.error ?? "stashed";
        },
      },
    });
    const root = workspace(parentSpec([CHILD_TOOL]), childSpec(["stash"]));
    const assembled = await assemble(root, {
      store,
      params: { tools: stash },
      turns: [
        { tool: CHILD_TOOL, args: { order_id: "ORD-7" } },
        // — child —
        { tool: "stash", args: {} },
        { tool: "read_file", args: { file_path: "scratchpad/x.txt" } },
        { reply: "child done" },
        // — parent —
        { tool: "read_file", args: { file_path: "scratchpad/x.txt" } },
        { reply: "parent done" },
      ],
    });
    store = assembled.store;
    const { messages } = await turn(assembled.agent, "s1", "go");

    const reads = toolResults(messages).filter((r) => r.name === "read_file");
    // The parent's transcript holds its own read only: the child's ran in the child's session.
    expect(reads).toHaveLength(1);
    expect(reads[0]?.content).not.toContain("from the host");
    expect(await storeFile(store, `/${childSessionId("s1", 1)}/scratchpad/x.txt`)).toBe("from the host");
    expect(await storeFile(store, "/s1/scratchpad/x.txt")).toBeUndefined();
    const childRead = assembled.model.calls
      .flatMap((call) => call.toolAnswers)
      .find((answer) => answer.content.includes("from the host"));
    expect(childRead).toBeDefined();
  });
});

describe("a child session's id", () => {
  it("numbers a session's dispatches across its turns, each turn on a fresh agent", async () => {
    const root = workspace(parentSpec(), childSpec());
    const store = createMemorySessionStore();
    const dispatchOn = async (orderId: string, note: string) => {
      const { agent } = await assemble(root, {
        store,
        turns: [
          { tool: CHILD_TOOL, args: { order_id: orderId } },
          // — child —
          { tool: "write_file", args: { file_path: "scratchpad/notes.md", content: note } },
          { reply: `${orderId} done` },
          // — parent —
          { reply: "parent done" },
        ],
      });
      await turn(agent, "s1", `enrich ${orderId}`);
      return agent;
    };
    await dispatchOn("ORD-1", "first");
    const agent = await dispatchOn("ORD-2", "second");

    const children = (await agent.sessions.list()).filter((s) => s.parentSessionId === "s1");
    expect(children.map((s) => s.sessionId).sort()).toEqual(["s1~1", "s1~2"]);
    expect((await agent.sessions.get("s1~1"))?.variables?.order_id?.value).toBe("ORD-1");
    expect((await agent.sessions.get("s1~2"))?.variables?.order_id?.value).toBe("ORD-2");
    // Two dispatches, two folders: the second child did not inherit the first's.
    expect(await storeFile(store, "/s1~1/scratchpad/notes.md")).toBe("first");
    expect(await storeFile(store, "/s1~2/scratchpad/notes.md")).toBe("second");
  });

  /**
   * The defect this numbering closes: a per-agent ordinal reset on every turn,
   * so the next dispatch from the same state after a parked child was decided
   * derived the parked child's id, and ran on its thread and in its folder.
   */
  it("never hands a later dispatch the child an earlier one parked on, across fresh agents", async () => {
    const root = workspace(parentSpec(), REVIEWING_CHILD);
    const store = createMemorySessionStore();
    const fresh = (turns: ScriptedTurn[]) => assemble(root, { store, turns }).then((a) => a.agent);
    const parkOn = (orderId: string) =>
      fresh([{ tool: CHILD_TOOL, args: { order_id: orderId } }, advanceTo("review", "needs a reviewer")]).then(
        (agent) => agent.workflow.send("s1", { message: `enrich ${orderId}` }),
      );
    const decide = () =>
      fresh([{ reply: "child approved" }, { reply: "parent done" }]).then((agent) =>
        agent.workflow.decide("s1", { target: "approved" }).then((outcome) => ({ agent, outcome })),
      );

    const first = await parkOn("ORD-1");
    expect(first.delegation).toMatchObject({ sessionId: "s1~1", identity: "1", dispatchId: "1" });
    await decide();

    const second = await parkOn("ORD-2");
    expect(second.delegation).toMatchObject({ sessionId: "s1~2", identity: "2", dispatchId: "2" });
    const { agent, outcome } = await decide();

    expect(outcome.status).toBe("completed");
    const settled = await agent.sessions.get("s1~2");
    expect(settled?.status).toBe("completed");
    expect(settled?.workflowState).toBe("approved");
    expect(settled?.variables?.order_id?.value).toBe("ORD-2");
    expect((await agent.sessions.get("s1~1"))?.variables?.order_id?.value).toBe("ORD-1");
  });

  it("numbers the calls of one batch in tool-call order", async () => {
    const root = workspace(parentSpec(), childSpec());
    const { agent, events } = await assemble(root, {
      turns: [
        { batch: ["ORD-1", "ORD-2", "ORD-3"].map((id) => ({ tool: CHILD_TOOL, args: { order_id: id } })) },
        // — the three children, in whichever order they run —
        { reply: "child done" },
        { reply: "child done" },
        { reply: "child done" },
        // — parent —
        { reply: "parent done" },
      ],
    });
    const { messages } = await turn(agent, "s1", "go");

    for (const n of [1, 2, 3]) {
      expect((await agent.sessions.get(`s1~${n}`))?.variables?.order_id?.value).toBe(`ORD-${n}`);
    }
    // The stream names each call's dispatch by the same number.
    const calls = (messages.find((m) => Array.isArray((m as { tool_calls?: unknown[] }).tool_calls)) as {
      tool_calls: Array<{ id: string }>;
    }).tool_calls;
    const started = eventsOf(events, "sub-workflow-start");
    expect(calls.map((call) => started.find((e) => e.toolCallId === call.id)?.dispatchId)).toEqual(["1", "2", "3"]);
  });

  it("numbers a script's dispatch above the batch's own calls, and keeps counting on the next turn", async () => {
    const root = workspace(parentSpec(), childSpec());
    const store = createMemorySessionStore();
    const first = await assemble(root, {
      store,
      turns: [
        {
          batch: [
            { tool: "archmax_eval", args: { code: 'await tools.archmaxWorkflowEnrich({ order_id: "ORD-S" });' } },
            { tool: CHILD_TOOL, args: { order_id: "ORD-M" } },
          ],
        },
        { reply: "child done" },
        { reply: "child done" },
        { reply: "parent done" },
      ],
    });
    await turn(first.agent, "s1", "go");
    // The model's call is numbered from the step's count; the script's takes the next free number.
    expect((await first.agent.sessions.get("s1~1"))?.variables?.order_id?.value).toBe("ORD-M");
    expect((await first.agent.sessions.get("s1~2"))?.variables?.order_id?.value).toBe("ORD-S");

    const second = await assemble(root, {
      store,
      turns: [{ tool: CHILD_TOOL, args: { order_id: "ORD-N" } }, { reply: "child done" }, { reply: "parent done" }],
    });
    await turn(second.agent, "s1", "again");
    expect((await second.agent.sessions.get("s1~3"))?.variables?.order_id?.value).toBe("ORD-N");
  });

  it("names a grandchild by its path below the root, and tags its events with its caller's dispatch", async () => {
    const MID_TOOL = workflowToolName("mid");
    const LEAF_TOOL = workflowToolName("leaf");
    const root = makeWorkspace({
      "AGENTS.md": AGENTS_MD,
      "workflows/w/workflow.yaml": {
        runtime: RUNTIME,
        states: { start: { triggers: { manual: null }, tools: { allow: [MID_TOOL] } } },
      },
      "workflows/mid/workflow.yaml": {
        runtime: RUNTIME,
        states: { work: { triggers: { manual: null }, tools: { allow: [LEAF_TOOL] } } },
      },
      "workflows/leaf/workflow.yaml": { runtime: RUNTIME, states: { work: { triggers: { manual: null } } } },
    });
    const { agent, events } = await assemble(root, {
      turns: [
        { tool: MID_TOOL, args: {} },
        { tool: LEAF_TOOL, args: {} },
        { reply: "leaf done" },
        { reply: "mid done" },
        { reply: "root done" },
      ],
    });
    await turn(agent, "r", "go");

    expect(
      eventsOf(events, "sub-workflow-start").map((e) => [e.workflow, e.dispatchId, e.subWorkflowDispatchId]),
    ).toEqual([
      ["mid", "1", undefined],
      ["leaf", "1~1", "1"],
    ]);
    const leafEnters = eventsOf(events, "state-enter").filter((e) => e.subWorkflowDispatchId === "1~1");
    expect(leafEnters.map((e) => e.state)).toEqual(["work"]);
    const ids = (await agent.sessions.list()).map((s) => s.sessionId).sort();
    expect(ids).toEqual(["r", "r~1", "r~1~1"]);
    expect((await agent.sessions.list()).find((s) => s.sessionId === "r~1~1")?.parentSessionId).toBe("r~1");
  });

  /**
   * 0.5 named a child `<parent>~<state>:<workflow>:<ordinal>` and its dispatch
   * `subwf-<n>`. A parent parked on such a child before the upgrade resumes it
   * under the identity its park recorded: resume reads the record and never
   * re-derives it. Built by rewriting a parked session on disk into that shape.
   */
  it("resumes a park made before dispatch numbers under the identity it recorded", async () => {
    const root = workspace(parentSpec(), REVIEWING_CHILD);
    const dir = mkdtempSync(join(tmpdir(), "legacy-park-"));
    storeDirs.push(dir);
    const store = createFilesystemSessionStore({ dir });
    const parker = await assemble(root, {
      store,
      turns: [{ tool: CHILD_TOOL, args: { order_id: "ORD-1" } }, advanceTo("review", "needs a reviewer")],
    });
    expect((await parker.agent.workflow.send("s1", { message: "go" })).delegation?.sessionId).toBe("s1~1");
    asParkedBeforeDispatchNumbers(dir, "s1", "1", "start:enrich:0");

    const { agent, events } = await assemble(root, { store, turns: [{ reply: "child approved" }, { reply: "parent done" }] });
    const outcome = await agent.workflow.decide("s1", { target: "approved" });

    expect(outcome.status).toBe("completed");
    const child = await agent.sessions.get("s1~start:enrich:0");
    expect(child?.status).toBe("completed");
    expect(child?.parentSessionId).toBe("s1");
    expect(eventsOf(events, "sub-workflow-result")).toMatchObject([{ dispatchId: "subwf-1", status: "ok" }]);
    expect(await agent.sessions.get("s1~1")).toBeNull();
  });

  it("refuses a host's session id holding '~' in any other shape", async () => {
    const { agent } = await assemble(workspace(parentSpec(), childSpec()), { turns: [{ reply: "hi" }] });
    await expect(turn(agent, "tenant~conversation", "go")).rejects.toThrow(/'~' is reserved/);
  });
});

describe("a mount a caller and its child share", () => {
  /** A workspace serving `exports/` writable and governed, as a host does when any workflow in the tree writes it. */
  function exportsWorkspace(parent: Record<string, unknown>, child: Record<string, unknown>) {
    const root = workspace(parent, child);
    const exportsStore = createMemorySessionStore();
    const mounts = { ...defaultMounts(root), "/exports/": { backend: exportsStore.backend, readOnly: false, governed: true } };
    return { root, exportsStore, params: { workspace: { rootDir: root, sessionStore: createMemorySessionStore(), mounts } } };
  }

  const writeExport = (name: string): ScriptedTurn => ({
    tool: "write_file",
    args: { file_path: `exports/${name}.txt`, content: name },
  });

  it("is written by the caller that asks read_write, and only read by a child that grants it bare", async () => {
    const parent = parentSpec([CHILD_TOOL], { mounts: { allow_always: [{ mount: "exports", access: "read_write" }] } });
    const child = childSpec([], { mounts: { allow_always: ["exports"] } });
    const { root, exportsStore, params } = exportsWorkspace(parent, child);
    const { agent, events, model } = await assemble(root, {
      params,
      turns: [
        writeExport("caller"),
        { tool: CHILD_TOOL, args: { order_id: "ORD-7" } },
        // — child —
        writeExport("child"),
        { reply: "child done" },
        // — parent —
        { reply: "parent done" },
      ],
    });
    await turn(agent, "s1", "go");

    expect(blockedTools(events)).toEqual(["write_file"]);
    const blocked = eventsOf(events, "tool-blocked")[0];
    expect(blocked?.sessionId).toBe("s1~1");
    expect(blocked?.reason).toContain("no grant of this workflow asks for 'access: read_write'");
    expect(await storeFile(exportsStore, "/caller.txt")).toBe("caller");
    expect(await storeFile(exportsStore, "/child.txt")).toBeUndefined();
    // Each prompt says what its own workflow may do there.
    const prompts = model.calls.map((call) => call.systemPrompt);
    expect(prompts[0]).toMatch(/\*\*`exports\/`\*\* — read\/write/);
    expect(prompts[2]).toMatch(/\*\*`exports\/`\*\* — read-only/);
  });

  it("is written by the child that asks read_write, and only read by a caller that grants it bare", async () => {
    const parent = parentSpec([CHILD_TOOL], { mounts: { allow_always: ["exports"] } });
    const child = childSpec([], { mounts: { allow_always: [{ mount: "exports", access: "read_write" }] } });
    const { root, exportsStore, params } = exportsWorkspace(parent, child);
    const { agent, events } = await assemble(root, {
      params,
      turns: [
        writeExport("caller"),
        { tool: CHILD_TOOL, args: { order_id: "ORD-7" } },
        // — child —
        writeExport("child"),
        { reply: "child done" },
        // — parent —
        { reply: "parent done" },
      ],
    });
    await turn(agent, "s1", "go");

    const blocked = eventsOf(events, "tool-blocked");
    expect(blocked.map((e) => [e.tool, e.sessionId])).toEqual([["write_file", "s1"]]);
    expect(await storeFile(exportsStore, "/caller.txt")).toBeUndefined();
    expect(await storeFile(exportsStore, "/child.txt")).toBe("child");
  });
});
