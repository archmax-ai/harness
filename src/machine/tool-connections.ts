import { ARCHMAX_TOOL_PREFIX, DEFAULT_TOOLS, RUNTIME_FILE_TOOLS, TASK_TOOL } from "./tool-names.js";
import { BUILT_IN_TOOL_PATHS } from "./tool-paths.js";

/**
 * The host tools that take the connection a call runs through, and the argument each takes it in:
 * `{ rest__request: "connection" }`. For a tool in the table, an allow or forbid entry's
 * `connection` is part of what the entry matches, and a call that leaves the argument out runs
 * through the one connection its state grants the tool through (see `WorkflowMachine`). A tool not
 * in it is governed as though no entry named a connection.
 */
export type ToolConnectionTable = ReadonlyMap<string, string>;

/** The table of a host that declares no connection argument. */
export const NO_TOOL_CONNECTIONS: ToolConnectionTable = new Map();

/** Thrown at assembly for a connection declaration the runtime cannot honour. */
export class ToolConnectionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolConnectionsError";
  }
}

/** The runtime's own tools, none of which takes a host's connection. */
function isRuntimeTool(tool: string): boolean {
  return (
    tool.startsWith(ARCHMAX_TOOL_PREFIX) ||
    tool === TASK_TOOL ||
    DEFAULT_TOOLS.has(tool) ||
    RUNTIME_FILE_TOOLS.has(tool) ||
    Object.hasOwn(BUILT_IN_TOOL_PATHS, tool)
  );
}

/** A host's `toolConnections`, checked, as the table every machine of the assembly governs by. */
export function resolveToolConnections(host: Readonly<Record<string, string>> | undefined): ToolConnectionTable {
  const table = new Map<string, string>();
  for (const [tool, argument] of Object.entries(host ?? {})) {
    if (isRuntimeTool(tool)) {
      throw new ToolConnectionsError(
        `Tool '${tool}' is one of the runtime's own tools; only a host tool takes a connection.`,
      );
    }
    if (typeof argument !== "string" || argument.trim() === "") {
      throw new ToolConnectionsError(
        `Tool '${tool}' declares no argument for its connection; name the argument, or omit the declaration.`,
      );
    }
    table.set(tool, argument);
  }
  return table;
}

/** A call's connection: the declared argument's value, or `undefined` where the call names none. */
export function connectionOf(args: Readonly<Record<string, unknown>>, argument: string): unknown {
  const value = Object.hasOwn(args, argument) ? args[argument] : undefined;
  return value === undefined || value === null || value === "" ? undefined : value;
}
