import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolMessage } from "@langchain/core/messages";
import { createFilesystemMiddleware } from "deepagents";
import { decide } from "../kernel/kernel.js";
import { WorkflowMachine } from "../machine/machine.js";
import { createWorkspaceContext } from "./workspace-context.js";

/**
 * Upstream contract: Deep Agents' filesystem middleware evicts an oversized tool
 * result to the fixed root path `/large_tool_results/<tool_call_id>.txt` through
 * whatever backend it was given, and hands the model that path to read back.
 *
 * Because the session store serves the workspace root, that write must land in the
 * executing session's run folder — never in the authored tree, and never shared
 * across sessions. This test drives the real middleware rather than asserting our
 * own routing in isolation, so a change to the upstream path or mechanism fails
 * here instead of silently writing beside the authored files.
 */
describe("context offload through the real filesystem middleware", () => {
  const withTempRoot = async (fn: (root: string) => Promise<void>) => {
    const root = mkdtempSync(join(tmpdir(), "offload-"));
    try {
      await fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("writes an evicted tool result into the bound session's run folder", () =>
    withTempRoot(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });
      const middleware = createFilesystemMiddleware({ backend: ctx.backend });
      // Above the default eviction threshold (20k tokens ≈ 80k chars).
      const huge = "x".repeat(90_000);

      const result = await ctx.sessionZone.sessionScoped("session-a", async () =>
        // `archmax_eval` is not on upstream's eviction-exempt list (unlike the file
        // tools), so its oversized result is the realistic eviction case.
        (middleware.wrapToolCall as unknown as (
          request: unknown,
          handler: (request: unknown) => Promise<ToolMessage>,
        ) => Promise<ToolMessage>)(
          {
            toolCall: { name: "archmax_eval", id: "call_1" },
            runtime: {},
            state: {},
          },
          async () =>
            new ToolMessage({ content: huge, tool_call_id: "call_1", name: "archmax_eval" }),
        ),
      );

      // The model is handed the id-free path…
      expect(String(result.content)).toContain("/large_tool_results/call_1.txt");
      // …and the bytes live in this session's run folder, not the authored tree.
      const stored = join(root, "sessions", "session-a", "large_tool_results", "call_1.txt");
      expect(existsSync(stored)).toBe(true);
      expect(readFileSync(stored, "utf8")).toHaveLength(90_000);
      expect(existsSync(join(root, "large_tool_results"))).toBe(false);

      // And the agent may read exactly that path back, in any state.
      const machine = WorkflowMachine.fromSpec({
        states: {
          s: { triggers: { manual: null }, tools: { allow: [{ tool: "read_file", paths: ["data/**"] }] } },
        },
      });
      const verdict = decide(machine, {
        kind: "tool-call",
        state: "s",
        tool: "read_file",
        args: { file_path: "large_tool_results/call_1.txt" },
      });
      expect(verdict.decision).toBe("allow");
      expect(verdict.ruleId).toBe("tool.offload-read");

      const readBack = await ctx.sessionZone.sessionScoped("session-a", async () =>
        ctx.workspace.readText("large_tool_results/call_1.txt"),
      );
      expect(readBack).toHaveLength(90_000);
    }));

  it("keeps one session's offloaded result invisible to another", () =>
    withTempRoot(async (root) => {
      const ctx = createWorkspaceContext({ rootDir: root });
      const middleware = createFilesystemMiddleware({ backend: ctx.backend });
      const call = (sessionId: string, content: string) =>
        ctx.sessionZone.sessionScoped(sessionId, async () =>
          (middleware.wrapToolCall as unknown as (
            request: unknown,
            handler: (request: unknown) => Promise<ToolMessage>,
          ) => Promise<ToolMessage>)(
            { toolCall: { name: "archmax_eval", id: "call_1" }, runtime: {}, state: {} },
            async () =>
              new ToolMessage({ content, tool_call_id: "call_1", name: "archmax_eval" }),
          ),
        );

      await call("session-a", "a".repeat(90_000));
      await call("session-b", "b".repeat(90_000));

      const a = readFileSync(join(root, "sessions", "session-a", "large_tool_results", "call_1.txt"), "utf8");
      const b = readFileSync(join(root, "sessions", "session-b", "large_tool_results", "call_1.txt"), "utf8");
      expect(a[0]).toBe("a");
      expect(b[0]).toBe("b");
    }));
});
