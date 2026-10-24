/**
 * A code state's run: its `script`, read from the authoring backend, evaluated
 * in the sandbox with its state's input and its state's tools — nothing else.
 *
 * The run decides nothing here: the script moves the session through
 * `tools.archmax_advance` or ends it through `tools.archmax_raise`, which the
 * step recorder holds, and the orchestrator (`automated.ts`) reads the outcome
 * from that record and from whether the script finished cleanly.
 */
import type { StructuredTool } from "@langchain/core/tools";
import type { WorkflowEventEmitter } from "../core/events.js";
import type { ScriptExecutor } from "../sandbox/executor.js";

/** Resolves a code state's declared `script` to its authoring-backend path, or refuses it with a reason. */
export type CodeScriptResolver = (declared: string) => { ok: true; path: string } | { ok: false; reason: string };

export interface CodeStateRun {
  emit: WorkflowEventEmitter;
  /** The executor reading sources from the authoring backend. */
  executor: ScriptExecutor;
  resolveScript: CodeScriptResolver;
  sessionId: string;
  state: string;
  /** The state's declared `script`. */
  script: string;
  /** The script's input: `{ state, trigger?, variables }`. */
  input: Record<string, unknown>;
  /** The code state's tools, governed. */
  tools: StructuredTool[];
  /** The names those tools are listed and reached by. */
  surface: readonly string[];
  signal?: AbortSignal;
}

/**
 * Run a code state's script. Settles with the error that stopped it, if one did
 * — a script that cannot be placed or read, a foreign import, a throw, a
 * timeout, a cancelled turn — and with nothing when it ran to its end. Each
 * console line is reported as it was logged.
 */
export async function runCodeState(run: CodeStateRun): Promise<{ error?: string }> {
  const resolved = run.resolveScript(run.script);
  if (!resolved.ok) return { error: resolved.reason };
  const outcome = await run.executor.runCodeState(resolved.path, {
    sessionId: run.sessionId,
    args: run.input,
    tools: run.tools,
    surface: run.surface,
    ...(run.signal ? { signal: run.signal } : {}),
  });
  for (const line of outcome.logs) {
    if (line.trim()) run.emit({ type: "code-output", state: run.state, line: line.trimEnd() });
  }
  if (outcome.ok) return {};
  return { error: outcome.error?.message ?? "the script failed" };
}
