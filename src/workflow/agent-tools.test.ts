import { describe, expect, it, vi } from "vitest";
import { toolsFromMap } from "./agent-tools.js";

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
    expect(handler).toHaveBeenCalledWith({ body: "Roses are red" });
    expect(result).toEqual({ sent: "Roses are red" });
  });

  it("returns an empty array for an empty map", () => {
    expect(toolsFromMap({})).toEqual([]);
  });
});
