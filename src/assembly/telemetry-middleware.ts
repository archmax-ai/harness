/**
 * The plain agent's telemetry: with no governance to make its model and tool
 * calls, a plain composition reports them from a middleware of its own, first
 * in its array so each span wraps everything the call passes through. Its
 * spans sit directly under the turn's (a plain agent has no states).
 */
import { context } from "@opentelemetry/api";
import { createMiddleware } from "langchain";
import { modelIdOf } from "../workflow/prompt-cache.js";
import { sessionScopeFrom } from "../sessions/scope.js";
import {
  thrownOutcomeOf,
  toolOutcomeOf,
  type Telemetry,
  type ToolOutcome,
} from "../core/telemetry.js";
import type { PricingTable } from "../core/usage.js";

/**
 * The middleware's name: namespaced, because LangChain refuses two middleware
 * of one name and a host may well have instrumented its agent with its own.
 */
export const TELEMETRY_MIDDLEWARE_NAME = "ArchmaxHarnessTelemetry";

export function createTelemetryMiddleware(opts: { telemetry: Telemetry; pricing?: PricingTable }) {
  const { telemetry, pricing } = opts;
  const sessionIdOf = (runtime: unknown) =>
    sessionScopeFrom(runtime as { configurable?: Record<string, unknown> } | undefined).sessionId;
  return createMiddleware({
    name: TELEMETRY_MIDDLEWARE_NAME,
    wrapModelCall: async (request, handler) => {
      const requestModel = modelIdOf(request.model) || undefined;
      const span = telemetry.modelCall({
        sessionId: sessionIdOf(request.runtime),
        role: "agent",
        model: request.model,
        ...(requestModel ? { requestModel, pricingModel: requestModel } : {}),
        ...(pricing ? { pricing } : {}),
      });
      try {
        const answer = await context.with(span.context, () => handler(request));
        span.settle(answer);
        return answer;
      } catch (err) {
        span.fail(err);
        throw err;
      }
    },
    wrapToolCall: async (request, handler) => {
      // A name no tool has is the model's text: it never names a span, not even while it runs.
      const span = telemetry.toolCall({
        sessionId: sessionIdOf(request.runtime),
        tool: request.tool === undefined ? "unknown" : request.toolCall.name,
        callId: request.toolCall.id ?? "",
        origin: "agent",
      });
      let outcome: ToolOutcome = "error";
      try {
        const result = await context.with(span.context, () => handler(request));
        outcome = request.tool === undefined ? "unknown" : toolOutcomeOf(result);
        return result;
      } catch (err) {
        outcome = thrownOutcomeOf(
          err,
          (request.runtime as { signal?: AbortSignal } | undefined)?.signal,
        );
        throw err;
      } finally {
        span.end(outcome);
      }
    },
  });
}
