/**
 * Assembling an agent for a CLI command: which workflow (given, or inferred
 * from a single-workflow workspace), the `.env`-backed session header, the
 * event sink behind the state flow and the usage tracker, and the one
 * `withSession` wrapper every session command runs its body inside.
 */
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createAgent } from "../assembly/index.js";
import type { Agent, WorkflowSurface } from "../agent.js";
import { UnknownTriggerError, type TriggerInput } from "../machine/triggers.js";
import { WorkflowDisabledError, WorkflowLoadError } from "../machine/load-spec.js";
import {
  EmptyMessageError,
  InvalidDecisionTargetError,
  MissingDeliveryTriggerError,
  SessionNotAwaitingInputError,
  SessionNotParkedError,
} from "../sessions/resume.js";
import { SessionNotResumableError, UnknownSessionTriggerError } from "../sessions/resolve.js";
import { sessionIdRejection } from "../core/session-store.js";
import { UnsupportedRuntimeContractError } from "../runtime/contract.js";
import { loadDotenv, resolveWorkspaceRoot } from "../env.js";
import { createUsageTracker, type UsageTracker } from "../core/usage.js";
import { originLabel, renderEventLine, type WorkflowLifecycleEvent } from "../core/events.js";
import { createStyle, icons, type Style } from "./style.js";
import { createStateFlowRenderer } from "./state-flow.js";
import { CliError, UsageError, err, type Invocation } from "./command.js";

/**
 * The `<workflow>` slot: given, or inferred when the workspace holds exactly
 * one workflow — the common single-workflow workspace needs no repetition.
 */
export function resolveWorkflow(given: string | undefined, rootDir: string | undefined): string {
  if (given) return given;
  const dir = resolve(resolveWorkspaceRoot(rootDir), "workflows");
  const slugs = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(resolve(dir, e.name, "workflow.yaml")))
        .map((e) => e.name)
    : [];
  if (slugs.length === 1) return slugs[0] as string;
  if (slugs.length === 0)
    throw new UsageError(`a workflow is required and none was found under ${dir}`);
  throw new UsageError(
    `a workflow is required; this workspace has several: ${slugs.sort().join(", ")}`,
  );
}

/** `--variables` must be a JSON object; anything else is an argument error before any assembly. */
export function parseVariablesJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new UsageError("--variables is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError(
      '--variables must encode a JSON object (e.g. \'{"from_email":"a@b.com"}\')',
    );
  }
  return value as Record<string, unknown>;
}

/** The raw event line for `--verbose`, including the two events the default console output skips. */
function rawEventLine(event: WorkflowLifecycleEvent): string {
  switch (event.type) {
    case "agent-text":
      return `[agent:${event.state}] ${event.text}`;
    case "tool-called":
      return (
        `[workflow:${event.state}] tool ${event.tool}${event.detail ? ` ${event.detail}` : ""}` +
        `${event.origin ? ` (from a ${originLabel(event.origin)})` : ""}`
      );
    default:
      return renderEventLine(event) ?? "";
  }
}

/** The one session header every command prints to stderr. Loads `.env` first so the model line is the effective one. */
export function printSessionHeader(
  style: Style,
  workflow: string,
  rootDir: string | undefined,
  showModel = false,
): void {
  loadDotenv(rootDir);
  err(style.cyan(style.bold(`${icons.diamond} ${workflow}`)));
  err(`  ${style.dim("directory")}  ${resolveWorkspaceRoot(rootDir)}`);
  if (showModel)
    err(`  ${style.dim("model")}      ${process.env.ARCHMAX_MODEL ?? "(unset — see .env)"}`);
  err("");
}

/** Wire the state flow (and `--verbose` raw lines) behind a usage tracker whose handler the agent receives. */
export function createEventSink(
  style: Style,
  verbose: boolean,
  view = createStateFlowRenderer(process.stderr, style),
): UsageTracker {
  return createUsageTracker({
    onEvent: (event) => {
      if (verbose) {
        const line = rawEventLine(event);
        if (line) err(line);
      }
      view.onEvent(event);
    },
  });
}

const KNOWN_ERRORS = [
  UnsupportedRuntimeContractError,
  WorkflowLoadError,
  UnknownTriggerError,
  WorkflowDisabledError,
  SessionNotParkedError,
  InvalidDecisionTargetError,
  EmptyMessageError,
  SessionNotAwaitingInputError,
  MissingDeliveryTriggerError,
  SessionNotResumableError,
  UnknownSessionTriggerError,
];
export const isKnown = (e: unknown): e is Error => KNOWN_ERRORS.some((cls) => e instanceof cls);

/** Assemble the governed agent for a CLI command; a known load failure becomes a one-line `CliError`. */
export async function bootstrap(
  workflow: string,
  rootDir: string | undefined,
  usage: UsageTracker,
  extra: { trigger?: TriggerInput; variables?: Record<string, unknown> } = {},
): Promise<Agent & { workflow: WorkflowSurface }> {
  try {
    const agent = await createAgent({
      workflow,
      ...(rootDir !== undefined ? { workspace: { rootDir } } : {}),
      onEvent: usage.handler,
      ...(extra.trigger ? { trigger: extra.trigger } : {}),
      ...(extra.variables ? { variables: extra.variables } : {}),
    });
    if (!agent.workflow) throw new CliError(`workflow '${workflow}' assembled without a machine.`);
    return agent as Agent & { workflow: WorkflowSurface };
  } catch (e) {
    if (isKnown(e)) throw new CliError(e.message);
    throw e;
  }
}

/**
 * Everything a session command shares: the id is validated before anything is
 * assembled, the agent is bootstrapped under the (given or inferred) workflow,
 * the body runs, known runtime refusals become one-line errors, and the
 * session is disposed however the body ended.
 */
export async function withSession(
  inv: Invocation,
  sessionId: string | undefined,
  body: (ctx: { agent: Agent & { workflow: WorkflowSurface }; style: Style; usage: UsageTracker }) => Promise<number>,
): Promise<number> {
  const rejection = sessionId === undefined ? null : sessionIdRejection(sessionId);
  if (rejection)
    throw new UsageError(
      `invalid session id '${sessionId}' - ${rejection}. Use one from 'archmax sessions'.`,
    );
  const workflow = resolveWorkflow(inv.values.workflow as string | undefined, inv.root);
  const style = createStyle();
  printSessionHeader(style, workflow, inv.root);
  const usage = createEventSink(style, inv.values.verbose === true);
  const agent = await bootstrap(workflow, inv.root, usage);
  try {
    return await body({ agent, style, usage });
  } catch (e) {
    if (isKnown(e)) throw new CliError(e.message);
    throw e;
  } finally {
    if (sessionId !== undefined) agent.dispose(sessionId);
  }
}
