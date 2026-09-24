import { ToolMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import type { AgentMiddleware } from "langchain";
import type { AnyToolCallHandler, AnyToolCallRequest } from "../core/deepagents.js";
import { isWorkflowToolName } from "../machine/tool-names.js";
import {
  findMock,
  mockPayload,
  readMocks,
  TOOL_MOCK_MIDDLEWARE_NAME,
  type ToolMockSpec,
} from "../core/tool-mocks.js";

export type { ToolMockSpec };

/** Short-circuit governed tool calls with declarative mock results (test cases only). */
export function createToolMockMiddleware(): AgentMiddleware {
  return createMiddleware({
    // The name is the assembly-time detection handle for `capabilities.toolMocks`.
    name: TOOL_MOCK_MIDDLEWARE_NAME,
    wrapToolCall: async (request: AnyToolCallRequest, handler: AnyToolCallHandler) => {
      const toolName: string = request.toolCall?.name ?? "";
      const args = (request.toolCall?.args ?? {}) as Record<string, unknown>;
      const configurable = request.runtime?.configurable ?? request.config?.configurable ?? {};

      // A delegation mock is served by the **dispatcher**, not here. Short-
      // circuiting it at this seam would skip the dispatch entirely — no
      // sub-workflow event, no trail step, no check that the answer matches what
      // the target declares it returns — leaving a case asserting against a
      // delegation the run has no record of making.
      const mock = isWorkflowToolName(toolName)
        ? undefined
        : findMock(readMocks(configurable), toolName, args);
      if (mock) {
        return new ToolMessage({
          content: mockPayload(mock),
          tool_call_id: request.toolCall?.id ?? "",
          name: toolName,
        });
      }

      return handler(request);
    },
  });
}
