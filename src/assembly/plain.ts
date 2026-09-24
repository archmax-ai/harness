/**
 * The no-workflow composition: a plain, skills-driven Deep Agent over the same
 * workspace, with no machine, no control tools and no per-state gating.
 */
import { createDeepAgent } from "deepagents";
import { asCompiledAgentGraph, type CompiledAgentGraph } from "../core/deepagents.js";
import { TOOL_MOCK_MIDDLEWARE_NAME } from "../core/tool-mocks.js";
import { frameworkPassthrough, rubricParams, todoMiddleware, type AssemblyContext } from "./compose.js";

/**
 * A skill source as upstream's middleware wants it: a leading-slash,
 * trailing-slash POSIX path. The assembly's own sources are workspace-relative
 * (`skills/`); only the plain composition hands them to upstream, so the
 * conversion lives at that one boundary.
 */
function asSkillSource(source: string): string {
  return `/${source.replace(/^\/+/, "").replace(/\/+$/, "")}/`;
}

/** Compose the plain agent: its graph, and whether the host's tool-mock middleware is among its middleware. */
export function composePlain(
  ctx: AssemblyContext,
  systemPrompt: string,
): { graph: CompiledAgentGraph; toolMocks: boolean } {
  // The host's middleware rides after the runtime's own, as on the governed path.
  const middleware = [todoMiddleware(), ...(ctx.params.middleware ?? [])];
  const deepAgent = createDeepAgent({
    model: ctx.model,
    backend: ctx.backend,
    // No machine, so there are no states to vary disclosure by: upstream's
    // skills middleware discloses every skill of the declared sources, which is
    // exactly right here and exactly wrong under a workflow.
    skills: ctx.skillSources.map(asSkillSource),
    tools: ctx.params.tools ?? [],
    ...rubricParams(ctx),
    middleware,
    systemPrompt: { prefix: systemPrompt, base: null },
    checkpointer: ctx.checkpointer,
    ...frameworkPassthrough(ctx.params),
  });
  return {
    graph: asCompiledAgentGraph(deepAgent.graph),
    toolMocks: middleware.some((m) => m.name === TOOL_MOCK_MIDDLEWARE_NAME),
  };
}
