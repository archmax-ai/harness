import { describe, expect, it, vi } from "vitest";
import { runWithToolContext } from "../core/tool-context.js";
import { toolPathsFromMetadata, toolsFromMap } from "./agent-tools.js";

describe("toolsFromMap", () => {
  it("builds one StructuredTool per entry, named by map key", async () => {
    const handler = vi.fn(async (input: Record<string, unknown>) => ({ sent: input.body }));
    const tools = toolsFromMap({
      "microsoft-outlook__reply-email": {
        description: "Reply to the triggering email.",
        inputSchema: {
          type: "object",
          properties: { body: { type: "string" } },
          required: ["body"],
        },
        handler,
      },
    });

    expect(tools).toHaveLength(1);
    const [replyTool] = tools;
    expect(replyTool.name).toBe("microsoft-outlook__reply-email");
    expect(replyTool.description).toBe("Reply to the triggering email.");

    const result = await replyTool.invoke({ body: "Roses are red" });
    expect(handler.mock.calls[0]?.[0]).toEqual({ body: "Roses are red" });
    expect(result).toEqual({ sent: "Roses are red" });
  });

  it("hands the handler a context whose workspace exists only inside a turn", async () => {
    let reached: unknown;
    const [readTool] = toolsFromMap({
      reader: {
        description: "Reads.",
        inputSchema: { type: "object", properties: {} },
        handler: async (_input, context) => {
          try {
            return context.workspace;
          } catch (err) {
            reached = (err as Error).message;
            return "no workspace";
          }
        },
      },
    });
    expect(await readTool!.invoke({})).toBe("no workspace");
    expect(reached).toMatch(/ran outside a session turn/);
    const workspace = { marker: true };
    expect(await runWithToolContext({ workspace: workspace as never }, () => readTool!.invoke({}))).toBe(workspace);
  });

  it("carries a descriptor's path declaration to assembly", () => {
    const tools = toolsFromMap({
      get_markdown: {
        description: "Reads Markdown.",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        paths: { path: "read" },
        handler: async () => "",
      },
      plain: { description: "No paths.", inputSchema: { type: "object", properties: {} }, handler: async () => "" },
    });
    expect(toolPathsFromMetadata(tools)).toEqual({ get_markdown: { path: "read" } });
  });

  it("returns an empty array for an empty map", () => {
    expect(toolsFromMap({})).toEqual([]);
  });
});
