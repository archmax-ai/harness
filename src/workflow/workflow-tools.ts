/**
 * Delegation tools: one per sibling workflow a machine is permitted to call. A
 * workflow's declared signature is its call signature: the `manual` trigger's
 * `requires:` becomes the tool's typed parameters and `returns:` the shape of
 * the result, so delegating is an ordinary governed tool call.
 *
 * Unlike the other `archmax_*` tools, the body is real: a delegation tool is the
 * only runtime tool a script may call through the PTC gateway (which runs the
 * kernel verdict by name before the body). One call starts one sub-run; fan-out
 * is parallel tool calls or a script's `Promise.all`, bounded by the dispatcher.
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredTool } from "@langchain/core/tools";
import { tool } from "langchain";
import { signatureJsonSchema, type SignatureEntry } from "../machine/signature.js";
import { workflowToolName } from "../machine/tool-names.js";
import { callingStateFrom } from "../sessions/scope.js";
import type { SubWorkflowDispatcher, SubWorkflowResult } from "./sub-workflow.js";

/** What a target declares about itself, as the tool needs to render and enforce it. */
export interface DelegationTarget {
  /** The `workflows/<slug>/` directory name — the tool's identity. */
  workflow: string;
  /** The target's human label; prose for the description only. */
  title?: string;
  /** What calling the target does, for its caller — its `manual` trigger's `description`. */
  description?: string;
  /** Run variables a dispatch must supply, typed where the target types them. */
  requires?: SignatureEntry[];
  /** Run variables the target guarantees on completion. */
  returns?: SignatureEntry[];
}

/**
 * The model-facing description, built from the target's own spec: what the
 * runtime enforces and no more, led by what the target says calling it does.
 * The target's `instructions` are absent — that is the child's brief, and the
 * caller's agent must not act on it.
 */
export function delegationToolDescription(target: DelegationTarget): string {
  const parts: string[] = [];
  const description = target.description?.trim();
  if (description) parts.push(/[.!?]$/.test(description) ? description : `${description}.`);
  const label = target.title?.trim();
  const requires = (target.requires ?? []).map((entry) => entry.name);
  const returns = (target.returns ?? []).map((entry) => entry.name);
  parts.push(
    `Run the '${target.workflow}' workflow${label ? ` (${label})` : ""} to completion and ` +
      `return its result. It runs as its own governed machine with its own states and tools; ` +
      `your run stays where it is and continues when the call answers.`,
  );
  if (requires.length) {
    parts.push(`It requires ${quoteList(requires)}, which the call must supply.`);
  }
  parts.push(
    returns.length
      ? `The result carries ${quoteList(returns)} under 'returns', alongside the ` +
          `workflow's closing message under 'message'.`
      : `The result is the workflow's closing message.`,
  );
  parts.push(`One call runs it once; call it again (in the same turn) to run several at once.`);
  return parts.join(" ");
}

/**
 * The JSON Schema for a call: the target's `requires`, and nothing else named —
 * built by the one signature mapping, so each parameter carries the type the
 * dispatch enforces, and described as the locked variable it is seeded as.
 */
export function delegationToolSchema(target: DelegationTarget): Record<string, unknown> {
  const requires = target.requires ?? [];
  const schema = signatureJsonSchema(requires);
  for (const entry of requires) {
    const declared = entry.description?.trim();
    schema.properties[entry.name]!.description = declared
      ? `${/[.!?]$/.test(declared) ? declared : `${declared}.`} Seeded as a locked run variable.`
      : `Required input '${entry.name}', seeded as a locked run variable.`;
  }
  return {
    ...schema,
    // Open: `requires` states only what is mandatory, and nothing declares the full accepted set.
    additionalProperties: true,
  };
}

/**
 * How a completed sub-run is handed to its caller: the declared returns and the
 * closing message as two channels (values read by name, prose read by the
 * model), or the message alone for an unsigned target.
 */
export function delegationCallResult(
  result: SubWorkflowResult,
): string | { message: string; returns: Record<string, unknown> } {
  return result.returns ? { message: result.result, returns: result.returns } : result.result;
}

/**
 * Build the callable tool for one target. A call's arguments are values the
 * caller already produced, so nothing is resolved against the run's variables.
 */
export function createDelegationTool(
  target: DelegationTarget,
  dispatcher: SubWorkflowDispatcher,
  entryState: string,
): StructuredTool {
  return tool(
    async (input: Record<string, unknown>, runtimeConfig) => {
      const result = await dispatcher.dispatch({
        workflow: target.workflow,
        ...(Object.keys(input ?? {}).length ? { params: input } : {}),
        variables: {},
        config: runtimeConfig as RunnableConfig,
        state: callingStateFrom(runtimeConfig) ?? entryState,
        ...(callIdOf(runtimeConfig) ? { toolCallId: callIdOf(runtimeConfig)! } : {}),
      });
      return delegationCallResult(result);
    },
    {
      name: workflowToolName(target.workflow),
      description: delegationToolDescription(target),
      schema: delegationToolSchema(target),
    },
  ) as unknown as StructuredTool;
}

/** The id of the tool call being serviced; absent when a script invokes the tool through the PTC bridge. */
function callIdOf(runtime: unknown): string | undefined {
  const id = (runtime as { toolCallId?: unknown } | undefined)?.toolCallId;
  return typeof id === "string" && id ? id : undefined;
}

function quoteList(names: string[]): string {
  const quoted = names.map((n) => `'${n}'`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}
