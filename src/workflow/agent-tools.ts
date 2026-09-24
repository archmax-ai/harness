import type { StructuredTool } from "@langchain/core/tools";
import { tool } from "langchain";

/** One resolved capability tool, keyed by the id `tools.allow` uses (e.g. `<collection>__<action>`). */
export interface AgentToolDescriptor {
  description: string;
  /** JSON Schema describing the tool's inputs (LLM-facing). */
  inputSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

/** Adapt a map of resolved capability tools into bindable `StructuredTool`s; per-state `tools.allow` still gates them. */
export function toolsFromMap(entries: Record<string, AgentToolDescriptor>): StructuredTool[] {
  return Object.entries(entries).map(
    ([id, entry]) =>
      tool(async (input: Record<string, unknown>) => entry.handler(input), {
        name: id,
        description: entry.description,
        schema: entry.inputSchema,
      }) as unknown as StructuredTool,
  );
}
