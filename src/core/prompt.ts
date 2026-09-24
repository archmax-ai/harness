/**
 * The system prompt, layered. Every layer below is either read through the
 * backend or rendered from something the runtime enforces, so what the model is
 * told cannot drift from what the workspace serves or the machine permits.
 *
 * The full order the model sees, first to last:
 *
 *  1. `AGENTS.md` — the workspace's persona, read through the composite.
 *  2. The consumer's `systemPrompt` option — appended after the persona.
 *  3. The platform prompt — how to move and which tools are the runtime's own.
 *     It ships inside the code (`platform-prompt.md`, generated into
 *     `platform-prompt.generated.ts`); a workspace may override it at
 *     `.platform/system/GRAPH_STATE.md`. A plain agent has no machine for it to
 *     explain, so it gets no platform layer.
 *  4. Workspace zones — rendered from the assembly's resolved mount table.
 *  5. The workflow header — the spec's `title` and root `instructions`, and no
 *     state of the graph: the graph is disclosed only from where the agent
 *     stands, so it lives in layer 8 (see `workflow/render-prompt.ts`). This
 *     layer is therefore a function of the header alone and does not grow with
 *     the state count.
 *  6. `WORKFLOW.md` — the optional prose addendum, HTML comments stripped.
 *  7. Deep Agents' tool guidance — the file tools' and `write_todos`' sections,
 *     appended by their middleware.
 *  8. The volatile "Current state" block — the current date and time, then the
 *     active state's instructions, skills, mounts, variables, argument
 *     constraints and its own outgoing transitions, appended per model call by
 *     the workflow middleware and never part of the cacheable prefix. The clock
 *     is here for the same reason everything else in this block is — it does not
 *     hold still — and is rounded to a ten-minute bucket so that it holds still
 *     for the calls of one turn (see `renderNow` in `workflow/governance.ts`).
 *
 * Layers 1–6 are what `resolveSystemPrompt` returns and the assembly hands to
 * Deep Agents as `systemPrompt: { prefix, base: null }`. Deep Agents' own base
 * prompt ("You are a Deep Agent…") is deliberately dropped: it is generic
 * assistant guidance that contradicts layer 3 (it says to ask before acting and
 * to yield only when the task is done; a governed session parks, waits and
 * stops at human states). Layers 7–8 come from middleware.
 */
import { PLATFORM_PROMPT } from "./platform-prompt.generated.js";
import type { Workspace } from "./workspace.js";
import { renderWorkspaceZones } from "./workspace-prompt.js";
import { NO_MOUNTS, type MountPrefixes } from "./zones.js";

export interface ResolveSystemPromptOptions {
  /** Workspace-relative path to AGENTS.md (default: `AGENTS.md`). */
  agentsPath?: string;
  /**
   * Where a workspace may override the platform prompt (normally
   * `PLATFORM_PROMPT_PATH`); the bundled prompt applies when nothing is served
   * there. `null` leaves the platform layer out — a plain agent has no machine
   * for it to explain.
   */
  platformBackendPath: string | null;
  /**
   * Pre-assembled workflow prompt text: the spec-rendered workflow header
   * followed by any `WORKFLOW.md` prose addendum (the caller composes both —
   * see `renderWorkflowPrompt` — because it already holds the loaded spec and
   * body; this module never re-reads the workflow files). Carries no state of
   * the graph; `renderStateGraph` renders that per model call.
   */
  workflowPrompt?: string | null;
  /**
   * The assembly's resolved mount keys. The workspace-zones section is rendered
   * from these, so what the prompt says the agent has cannot drift from what the
   * workspace serves. Omitted: no mounts are described.
   */
  mountPrefixes?: MountPrefixes;
  /** Extra text appended after AGENTS.md. */
  extra?: string;
}

/** The layers `buildSystemPrompt` joins, in the order listed at the top of this module. */
export interface SystemPromptParts {
  agents?: string | null;
  extra?: string;
  platform?: string | null;
  /** The workspace-zones section, rendered from the resolved mount table. */
  workspace?: string | null;
  workflow?: string | null;
}

/** Join the prompt layers, skipping absent ones. */
export function buildSystemPrompt(parts: SystemPromptParts): string {
  return [
    parts.agents?.trim(),
    parts.extra?.trim(),
    parts.platform?.trim(),
    parts.workspace?.trim(),
    parts.workflow?.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The workspace's override when it serves one, else the bundled prompt. */
async function readPlatformPrompt(
  workspace: Workspace,
  backendPath: string | null,
): Promise<string | null> {
  if (backendPath === null) return null;
  return (await workspace.readText(backendPath)) || PLATFORM_PROMPT;
}

/** Load the prompt layers from the backend and merge them. */
export async function resolveSystemPrompt(
  workspace: Workspace,
  opts: ResolveSystemPromptOptions,
): Promise<string> {
  const agentsPath = opts.agentsPath ?? "AGENTS.md";
  const [platform, agents] = await Promise.all([
    readPlatformPrompt(workspace, opts.platformBackendPath),
    workspace.readText(agentsPath),
  ]);

  return buildSystemPrompt({
    agents,
    extra: opts.extra,
    platform,
    workspace: renderWorkspaceZones(opts.mountPrefixes ?? NO_MOUNTS),
    workflow: opts.workflowPrompt ?? null,
  });
}
