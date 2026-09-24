/**
 * Declarative tool-mock matching, shared by the two places a mocked call can be
 * intercepted: the tool-call middleware (agent-initiated calls) and the PTC
 * gateway (calls scripts make through `tools.*`). Both read the same
 * `__toolMocks` entry off the run's `configurable`, so a `mocks:` entry
 * declared by a case means one thing whoever makes the call.
 *
 * Runtime-owned (not `testing/`) precisely because runtime code consumes it:
 * the PTC gateway is runtime, and runtime never imports from testing modules.
 * Input matching is the shared `partialMatch` — the same vocabulary a case's
 * `calledTool.input` uses, so declaring a mock and asserting a call read alike.
 */
import { partialMatch } from "./match.js";

export interface ToolMockSpec {
  name: string;
  whenInput?: Record<string, unknown>;
  result: unknown;
}

/**
 * The middleware name `createToolMockMiddleware()` registers under. Assembly
 * detects the middleware by this name to stamp `capabilities.toolMocks` on the
 * runtime it returns — which is what lets the case engine refuse a
 * mock-declaring case against a target whose agent-initiated calls would not be
 * intercepted.
 */
export const TOOL_MOCK_MIDDLEWARE_NAME = "ToolMockMiddleware";

/** The mocks declared for this run, or none. */
export function readMocks(configurable: Record<string, unknown> | undefined): ToolMockSpec[] {
  const raw = configurable?.__toolMocks;
  return Array.isArray(raw) ? (raw as ToolMockSpec[]) : [];
}

/**
 * The first mock matching this call by name and (optionally) a partial input
 * match, or `undefined` when none does. Declaration order decides, so a test
 * can shadow a broad mock with a narrower one declared earlier.
 */
export function findMock(
  mocks: ToolMockSpec[],
  toolName: string,
  args: Record<string, unknown>,
): ToolMockSpec | undefined {
  return mocks.find(
    (mock) => mock.name === toolName && (!mock.whenInput || partialMatch(mock.whenInput, args)),
  );
}

/** A mock's result as the string payload a tool call settles with. */
export function mockPayload(mock: ToolMockSpec): string {
  return typeof mock.result === "string" ? mock.result : JSON.stringify(mock.result ?? null);
}
