import { BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredTool } from "@langchain/core/tools";
import { isCommand } from "@langchain/langgraph";
import { SUBAGENT_RESPONSE_FORMAT_CONFIG_KEY } from "deepagents";
import { validateResponseSchema, type SubagentBridgeOptions } from "@langchain/quickjs";
import type { WorkflowEventEmitter } from "../core/events.js";

/** Recover the textual payload from whatever envelope `task()` returns. */
export function unwrapToolEnvelope(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (isCommand(value)) {
    const messages = (value as { update?: { messages?: unknown[] } }).update?.messages;
    if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (BaseMessage.isInstance(message) && message.content != null) {
          return unwrapToolEnvelope(message.content);
        }
      }
    }
    return value;
  }
  if (BaseMessage.isInstance(value)) return unwrapToolEnvelope(value.content);
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      const entry = value[i];
      if (BaseMessage.isInstance(entry)) return unwrapToolEnvelope(entry.content);
      if (isCommand(entry)) {
        const inner = unwrapToolEnvelope(entry);
        if (inner !== entry) return inner;
      }
    }
  }
  return value;
}

/** Ids for bridge dispatches, which have no model-assigned tool-call id. */
let bridgeDispatchSeq = 0;

/**
 * Bridge the QuickJS `task()` global to the Deep Agents `task` tool. When
 * `telemetry` is supplied, each dispatch is bracketed with
 * `rubric-start`/`rubric-result` lifecycle events (this path bypasses the
 * outer agent's tool middleware, so it must emit its own bracketing).
 */
export function createSubagentBridgeDispatch(
  taskTool: StructuredTool,
  config: RunnableConfig,
  telemetry?: { emit: WorkflowEventEmitter; state?: string },
): SubagentBridgeOptions["dispatch"] {
  return async (input) => {
    const hasSchema = input.responseSchema != null;
    if (hasSchema) validateResponseSchema(input.responseSchema!);
    const toolConfig: RunnableConfig = {
      ...config,
      configurable: {
        ...config.configurable,
        ...(hasSchema && { [SUBAGENT_RESPONSE_FORMAT_CONFIG_KEY]: input.responseSchema }),
      },
    };
    const dispatchId = `bridge-${++bridgeDispatchSeq}`;
    const state = telemetry?.state ?? "";
    telemetry?.emit({
      type: "rubric-start",
      state,
      name: input.subagentType,
      dispatchId,
    });
    const startedAt = Date.now();
    const settle = (status: "ok" | "error") =>
      telemetry?.emit({
        type: "rubric-result",
        state,
        name: input.subagentType,
        dispatchId,
        status,
        durationMs: Date.now() - startedAt,
      });
    let raw: unknown;
    try {
      raw = await taskTool.invoke(
        { description: input.description, subagent_type: input.subagentType },
        toolConfig,
      );
    } catch (err) {
      settle("error");
      throw err;
    }
    settle("ok");
    const content = unwrapToolEnvelope(raw);
    if (hasSchema && typeof content === "string") {
      try {
        return JSON.parse(content);
      } catch {
        return content;
      }
    }
    return content;
  };
}
