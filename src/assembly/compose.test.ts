import { AIMessage } from "@langchain/core/messages";
import type { StructuredTool } from "@langchain/core/tools";
import { tool } from "langchain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { READ_FILE_TEXT_ONLY_LINE } from "../core/binary-read.js";
import type { WorkflowEventInput } from "../core/events.js";
import type { AnyModelCallHandler, AnyModelCallRequest } from "../core/deepagents.js";
import { readFileContractMiddleware } from "./compose.js";

const UPSTREAM =
  "Reads a file.\n\nUsage:\n" +
  "- Images (`.png`, `.jpg`, etc.), audio, video, and PDFs return multimodal content blocks (https://x).\n" +
  "- For images and PDFs, pagination via `offset`/`limit` is text-only - supply `file_path` only.\n" +
  "- Always read a file before editing it.";

const fileTool = (name: string, description: string) =>
  tool(async ({ file_path }: { file_path: string }) => `read ${file_path}`, {
    name,
    description,
    schema: z.object({ file_path: z.string() }),
  }) as unknown as StructuredTool;

/** Run the middleware's model-call hook once and return the tools the model was handed. */
async function handed(
  mw: ReturnType<typeof readFileContractMiddleware>,
  tools: StructuredTool[],
): Promise<StructuredTool[]> {
  let seen: StructuredTool[] = [];
  const handler: AnyModelCallHandler = (request) => {
    seen = request.tools as unknown as StructuredTool[];
    return new AIMessage("ok");
  };
  const wrap = mw.wrapModelCall as unknown as (r: AnyModelCallRequest, h: AnyModelCallHandler) => Promise<unknown>;
  await wrap({ tools } as unknown as AnyModelCallRequest, handler);
  return seen;
}

describe("readFileContractMiddleware", () => {
  it("rewrites the registered read_file in place, once, and leaves other tools alone", async () => {
    const events: WorkflowEventInput[] = [];
    const mw = readFileContractMiddleware((e) => events.push(e));
    const readFile = fileTool("read_file", UPSTREAM);
    const ls = fileTool("ls", "Lists files.");

    // LangChain rejects a swapped instance, so the model is handed the very tool registered.
    const first = await handed(mw, [ls, readFile]);
    expect(first).toEqual([ls, readFile]);
    expect(first[1]).toBe(readFile);
    expect(readFile.description).toContain(READ_FILE_TEXT_ONLY_LINE);
    expect(readFile.description).not.toContain("multimodal content blocks");
    expect(ls.description).toBe("Lists files.");

    const settled = readFile.description;
    await handed(mw, [ls, readFile]);
    expect(readFile.description).toBe(settled);
    await expect(readFile.invoke({ file_path: "a.md" })).resolves.toBe("read a.md");
    expect(events).toEqual([]);
  });

  it("leaves a reworded read_file as it is and warns once", async () => {
    const events: WorkflowEventInput[] = [];
    const mw = readFileContractMiddleware((e) => events.push(e));
    const reworded = "Reads a file. Binary files come back as blocks.";
    const readFile = fileTool("read_file", reworded);

    await handed(mw, [readFile]);
    await handed(mw, [readFile]);
    expect(readFile.description).toBe(reworded);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "warning", message: expect.stringContaining("read_file") });
  });
});
