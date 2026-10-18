import { afterEach, describe, expect, it, vi } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";
import { watchReplFrees, watchUnhandledRejections } from "../behaviour/support.js";
import { createQuickJsSandboxRuntime } from "./runtime.js";

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** A host tool whose every call waits until the test settles it. */
function gatedTool(name = "slow_tool") {
  let settle!: (outcome: { value?: string; error?: Error }) => void;
  const gate = new Promise<string>((resolve, reject) => {
    settle = ({ value, error }) => (error ? reject(error) : resolve(value ?? "late"));
  });
  const calls: unknown[] = [];
  const tool = {
    name,
    invoke: async (input: unknown) => {
      calls.push(input);
      return gate;
    },
  } as unknown as StructuredTool;
  return {
    tool,
    calls,
    resolve: () => settle({ value: "late" }),
    reject: () => settle({ error: new Error("late") }),
  };
}

/** A host tool that records its calls and answers at once. */
function countingTool(name: string) {
  const calls: unknown[] = [];
  const tool = {
    name,
    invoke: async (input: unknown) => {
      calls.push(input);
      return "ok";
    },
  } as unknown as StructuredTool;
  return { tool, calls };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.restoreAllMocks();
});

/** Unhandled rejections while the test runs, released after it. */
function watchUnhandled(): unknown[] {
  const watch = watchUnhandledRejections();
  cleanups.push(watch.stop);
  return watch.seen;
}

describe("an eval under a turn's abort signal", () => {
  it("settles with an error as soon as the turn aborts, not at its timeout", async () => {
    const runtime = createQuickJsSandboxRuntime();
    const slow = gatedTool();
    const turn = new AbortController();
    const session = runtime.session("abort-settles:agent", { tools: [slow.tool] });

    const startedAt = Date.now();
    const result = session.eval("await tools.slowTool({})", 30_000, turn.signal);
    await vi.waitFor(() => expect(slow.calls).toHaveLength(1));
    turn.abort();
    const outcome = await result;
    runtime.dispose("abort-settles:agent");

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toEqual({ name: "AbortError", message: "the turn was aborted" });
    expect(outcome.formatted).toBe("AbortError: the turn was aborted");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("abandons the pending call and refuses the next one before it reaches the tool", async () => {
    const runtime = createQuickJsSandboxRuntime();
    const slow = gatedTool();
    const next = countingTool("next_tool");
    const turn = new AbortController();
    const session = runtime.session("abort-refuses:agent", { tools: [slow.tool, next.tool] });

    const code = [
      "try { await tools.slowTool({}); } catch (e) { globalThis.first = e.message; }",
      "try { await tools.nextTool({}); } catch (e) { globalThis.second = e.message; }",
    ].join("\n");
    const result = session.eval(code, 30_000, turn.signal);
    await vi.waitFor(() => expect(slow.calls).toHaveLength(1));
    turn.abort();
    await result;
    // The script resumes on the abandoned call and runs to its end at once.
    await tick();

    const seen = await session.eval("[first, second]", 1_000);
    runtime.dispose("abort-refuses:agent");
    expect(seen.value).toEqual([
      "Tool 'slow_tool' failed: the turn was aborted",
      "Tool 'next_tool' failed: the turn was aborted",
    ]);
    expect(next.calls).toEqual([]);
  });

  it("does not run code whose turn has already aborted", async () => {
    const runtime = createQuickJsSandboxRuntime();
    const session = runtime.session("abort-before:agent", {});
    const turn = new AbortController();
    turn.abort();

    const outcome = await session.eval("globalThis.ran = true", 1_000, turn.signal);
    const ran = await session.eval("typeof ran", 1_000);
    runtime.dispose("abort-before:agent");

    expect(outcome.ok).toBe(false);
    expect(outcome.error?.message).toBe("the turn was aborted");
    expect(ran.value).toBe("undefined");
  });
});

describe("disposing a session while a script's call is pending", () => {
  it.each(["resolve", "reject"] as const)(
    "frees the REPL cleanly when the call goes on to %s after an aborted turn",
    async (settle) => {
      const unhandled = watchUnhandled();
      const frees = watchReplFrees();
      const runtime = createQuickJsSandboxRuntime();
      const slow = gatedTool();
      const namespace = `aborted-${settle}:agent`;
      const turn = new AbortController();

      const result = runtime
        .session(namespace, { tools: [slow.tool] })
        .eval("await tools.slowTool({})", 30_000, turn.signal);
      await vi.waitFor(() => expect(slow.calls).toHaveLength(1));
      turn.abort();
      await result;
      // What the platform does once `send` settles: dispose at once, with the call
      // still pending in the REPL, which then settles.
      runtime.dispose(namespace);
      slow[settle]();

      await vi.waitFor(() => expect(frees.freed(namespace)).toBeDefined());
      await tick();
      expect(frees.freed(namespace)?.assertion).toBeUndefined();
      expect(unhandled).toEqual([]);
      // The process's other sessions still evaluate.
      const other = runtime.session(`after-${settle}:agent`, {});
      expect((await other.eval("1 + 1", 1_000)).value).toBe(2);
      runtime.dispose(`after-${settle}:agent`);
    },
  );

  it("frees the REPL cleanly when the eval timed out with the call pending", async () => {
    const unhandled = watchUnhandled();
    const frees = watchReplFrees();
    const runtime = createQuickJsSandboxRuntime();
    const slow = gatedTool();

    const outcome = await runtime
      .session("timed-out:agent", { tools: [slow.tool] })
      .eval("await tools.slowTool({})", 50);
    expect(outcome.error?.message).toMatch(/timed out/);
    runtime.dispose("timed-out:agent");
    slow.resolve();

    await vi.waitFor(() => expect(frees.freed("timed-out:agent")).toBeDefined());
    await tick();
    expect(frees.freed("timed-out:agent")?.assertion).toBeUndefined();
    expect(unhandled).toEqual([]);
  });

  it("waits for a running eval to return before freeing its REPL", async () => {
    const frees = watchReplFrees();
    const runtime = createQuickJsSandboxRuntime();
    const running = runtime.session("running:agent", {}).eval("await new Promise(() => {})", 200);
    await tick();

    runtime.dispose("running:agent");
    await tick(50);
    expect(frees.freed("running:agent")).toBeUndefined();

    expect((await running).error?.message).toMatch(/timed out/);
    await vi.waitFor(() => expect(frees.freed("running:agent")).toBeDefined());
    expect(frees.freed("running:agent")?.assertion).toBeUndefined();
  });

  it("starts the namespace afresh, and refuses the released session", async () => {
    const runtime = createQuickJsSandboxRuntime();
    const slow = gatedTool();
    const released = runtime.session("afresh:agent", { tools: [slow.tool] });
    // A call left pending past its eval: the REPL is still in use when disposed.
    await released.eval("globalThis.kept = 1; tools.slowTool({}); 'started'", 1_000);
    runtime.dispose("afresh:agent");

    const fresh = runtime.session("afresh:agent", {});
    expect((await fresh.eval("typeof kept", 1_000)).value).toBe("undefined");
    const refused = await released.eval("1", 1_000);
    expect(refused.error?.message).toBe("the sandbox session was disposed");
    runtime.dispose("afresh:agent");
    slow.resolve();
  });
});
