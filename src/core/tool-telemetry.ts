import { ToolMessage } from "@langchain/core/messages";

/**
 * Shared shaping for tool-call telemetry, so the two places that emit it — the
 * tool-call middleware (agent-initiated calls) and the PTC gateway (calls
 * scripts make through `tools.*`) — produce identically shaped events. A
 * consumer must not be able to tell which path a `tool-result` came from except
 * by its `origin`.
 */

/** Size cap for the `tool-result` output preview; full outputs stay in messages. */
export const TOOL_OUTPUT_PREVIEW_CAP = 4096;

/** Flatten a tool call's settled value to a capped text preview. */
export function toolOutputPreview(value: unknown): { output: string; truncated: boolean } {
  let text: string;
  if (value instanceof ToolMessage) {
    text = typeof value.content === "string" ? value.content : JSON.stringify(value.content) ?? "";
  } else if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  const truncated = text.length > TOOL_OUTPUT_PREVIEW_CAP;
  return { output: truncated ? text.slice(0, TOOL_OUTPUT_PREVIEW_CAP) : text, truncated };
}

/** A concise, single-value hint for a tool call (e.g. its `file_path`), for the CLI. */
export function toolCallDetail(args: Record<string, unknown>): string | undefined {
  for (const key of ["file_path", "path", "to", "pattern", "command", "url"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}
