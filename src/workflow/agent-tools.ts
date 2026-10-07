import type { StructuredTool } from "@langchain/core/tools";
import { tool } from "langchain";
import { currentToolContext, type ToolContext } from "../core/tool-context.js";
import type { ToolPaths } from "../machine/tool-paths.js";

/** The tool metadata key a tool's path declaration travels under to assembly. */
export const TOOL_PATHS_METADATA_KEY = "archmax.paths";

/** One resolved capability tool, keyed by the id `tools.allow` uses (e.g. `<collection>__<action>`). */
export interface AgentToolDescriptor {
  description: string;
  /** JSON Schema describing the tool's inputs (LLM-facing). */
  inputSchema: Record<string, unknown>;
  /**
   * The arguments that name workspace paths, and how the call uses each. Every
   * path rule of the kernel then governs them as it governs the built-in file
   * tools' (zones, mounts, skills, `paths:` guards).
   */
  paths?: ToolPaths;
  /**
   * Runs the tool. `context.workspace` is the turn's workspace, bound to the
   * session — the same one `read_file` resolves through.
   */
  handler: (input: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
}

/** Adapt a map of resolved capability tools into bindable `StructuredTool`s; per-state `tools.allow` still gates them. */
export function toolsFromMap(entries: Record<string, AgentToolDescriptor>): StructuredTool[] {
  return Object.entries(entries).map(
    ([id, entry]) =>
      tool(
        async (input: Record<string, unknown>) => entry.handler(input, currentToolContext() ?? outsideTurn(id)),
        {
          name: id,
          description: entry.description,
          schema: entry.inputSchema,
          ...(entry.paths ? { metadata: { [TOOL_PATHS_METADATA_KEY]: entry.paths } } : {}),
        },
      ) as unknown as StructuredTool,
  );
}

/**
 * The context of a call made outside any turn (a host invoking the tool
 * directly): the handler still runs, and only reaching for the workspace — which
 * exists per session, per turn — fails, saying why. The property is
 * non-enumerable, so a deep-equality check or a logger that walks the context
 * skips it instead of throwing; `"workspace" in context` still tells a caller
 * whether one may be read.
 */
function outsideTurn(id: string): ToolContext {
  return Object.defineProperty({}, "workspace", {
    enumerable: false,
    get(): never {
      throw new Error(
        `Tool '${id}' ran outside a session turn; its workspace exists only while an agent turn ` +
          `is running.`,
      );
    },
  }) as ToolContext;
}

/**
 * The path declarations the host's tools carry in their metadata (set by
 * {@link toolsFromMap} from a descriptor's `paths`), by tool name.
 */
export function toolPathsFromMetadata(tools: readonly StructuredTool[] | undefined): Record<string, ToolPaths> {
  const found: Record<string, ToolPaths> = {};
  for (const candidate of tools ?? []) {
    const paths = (candidate.metadata as Record<string, unknown> | undefined)?.[TOOL_PATHS_METADATA_KEY];
    if (paths && typeof paths === "object") found[candidate.name] = paths as ToolPaths;
  }
  return found;
}
