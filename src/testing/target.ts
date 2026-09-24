/**
 * Building the agent an offline suite drives.
 *
 * A module of its own, deliberately: `runTests` reaches its target through this
 * builder, and a host replaces it (`createTarget`) to drive a workflow agent it
 * assembled itself. Folded into `runner.ts` the call would be intra-module and
 * therefore unreplaceable — the seam would exist in the type and not in fact.
 */
import type { Agent, WorkflowSurface } from "../agent.js";
import { createAgent } from "../assembly/index.js";
import type { WorkflowEventHandler } from "../core/events.js";
import type { SandboxRuntime } from "../sandbox/runtime.js";
import type { ModelFactory } from "../env.js";
import { createToolMockMiddleware } from "./mock-middleware.js";
import { assertWorkflowGovernedTarget } from "./runner.js";

export interface CaseTargetOptions {
  workflow: string;
  rootDir?: string;
  onEvent?: WorkflowEventHandler;
  /** Script-execution backend forwarded to the agent under test. */
  sandboxRuntime?: SandboxRuntime;
  /** Model factory forwarded to the agent under test. */
  modelFactory?: ModelFactory;
}

/**
 * Build the agent under test for an offline case run. The tool-mock middleware
 * is always wired: a case's declared `mocks:` must intercept the agent's own
 * calls as well as scripts' PTC calls, or interception would be partial.
 */
export async function createCaseTarget(opts: CaseTargetOptions): Promise<Agent & { workflow: WorkflowSurface }> {
  const agent = await createAgent({
    workflow: opts.workflow,
    ...(opts.rootDir !== undefined ? { workspace: { rootDir: opts.rootDir } } : {}),
    middleware: [createToolMockMiddleware()],
    onEvent: opts.onEvent,
    ...(opts.sandboxRuntime ? { sandboxRuntime: opts.sandboxRuntime } : {}),
    ...(opts.modelFactory ? { modelFactory: opts.modelFactory } : {}),
  });
  assertWorkflowGovernedTarget(agent, opts.workflow);
  return agent;
}
