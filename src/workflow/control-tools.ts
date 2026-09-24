/**
 * The control tools: `archmax_advance`, `archmax_wait`, `archmax_reset`,
 * `archmax_get_variables`, `archmax_set_variables`.
 *
 * Each is a declaration whose body never runs in a wired assembly: governance
 * intercepts the call in `wrapToolCall`, where checkpointed state is in hand, and
 * services it with the handler here. A handler returns the tool message the
 * model reads and, when the call changed the run, the `Command` committing it.
 */
import { ToolMessage } from "@langchain/core/messages";
import type { StructuredTool } from "@langchain/core/tools";
import { Command } from "@langchain/langgraph";
import { tool } from "langchain";
import { z } from "zod";
import { spokeSinceLastHumanMessage } from "../core/messages.js";
import { canonicalizeRelPath } from "../core/workspace.js";
import {
  classifyWorkspacePath,
  NO_MOUNTS,
  type MountPrefixes,
  type WorkspaceZone,
} from "../core/zones.js";
import type { LifecycleContext, LifecycleRunner } from "../lifecycle/runner.js";
import type { WorkflowMachine } from "../machine/machine.js";
import {
  ADVANCE_TOOL,
  GET_VARIABLES_TOOL,
  RESET_TOOL,
  SET_VARIABLES_TOOL,
  WAIT_TOOL,
} from "../machine/tool-names.js";
import {
  normalizeTitle,
  resolvePath,
  TITLE_VARIABLE,
  titleWriteError,
  VARIABLE_NAME_PATTERN,
  type UnresolvedGlob,
  type VariableStore,
} from "../machine/variables.js";
import { decisionRecordFor, inputRecordFor } from "./parks.js";
import {
  currentWorkflowState,
  readVariables,
  readWorkflowState,
  WORKFLOW_STATUSES,
  type PendingDecision,
  type PendingInput,
  type TrailStep,
  type WorkflowStateFields,
  type WorkflowUpdate,
} from "./state.js";

export { ADVANCE_TOOL, GET_VARIABLES_TOOL, RESET_TOOL, SET_VARIABLES_TOOL, WAIT_TOOL };

// --- Replies ------------------------------------------------------------------

function toolReply(name: string, toolCallId: string, content: string): ToolMessage {
  return new ToolMessage({ content, tool_call_id: toolCallId, name });
}

/** The one refusal shape: an error-status tool message, so the model self-corrects and a view classifies it. */
export function refusal(name: string, toolCallId: string, text: string): ToolMessage {
  return new ToolMessage({ content: text, tool_call_id: toolCallId, name, status: "error" });
}

function commit(update: WorkflowUpdate): Command {
  return new Command({ update });
}

/** A control tool's declaration: a body that only says it is unwired. */
function declaration(name: string, description: string, schema: z.ZodTypeAny): StructuredTool {
  return tool(async () => `${name} is unavailable: the workflow middleware is not installed.`, {
    name,
    description,
    schema,
  }) as unknown as StructuredTool;
}

function schemaIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; ");
}

// --- Evidence -----------------------------------------------------------------

/** Most paths one advance may attach — a bound on what a person is asked to read. */
export const MAX_ADVANCE_EVIDENCE = 20;

/** Zones an attached path may address: everything the agent itself can read. */
const READABLE_ZONES: ReadonlySet<WorkspaceZone> = new Set<WorkspaceZone>([
  "run-open",
  "run",
  "authored",
  "run-offload",
]);

export type EvidenceValidation = { ok: true; paths: string[] } | { ok: false; reason: string };

/**
 * Validate attached evidence paths (canonical, deduplicated) or give the reason
 * the call is refused. Classified through the kernel's classifier and mount
 * table, so what may be attached cannot drift from what the agent can read.
 */
export function validateAdvanceEvidence(
  paths: readonly string[],
  mounts: MountPrefixes = NO_MOUNTS,
): EvidenceValidation {
  if (paths.length > MAX_ADVANCE_EVIDENCE) {
    return {
      ok: false,
      reason:
        `${paths.length} evidence paths were attached; at most ${MAX_ADVANCE_EVIDENCE} may be. ` +
        `Attach the artifacts the decision actually rests on.`,
    };
  }
  const out: string[] = [];
  for (const entry of paths) {
    const raw = String(entry).trim();
    const { path: rel } = canonicalizeRelPath(raw);
    const zone = classifyWorkspacePath(raw, mounts);
    if (zone === "escapes") {
      return { ok: false, reason: `evidence path '${raw}' points outside the workspace.` };
    }
    if (zone === "root" || rel === "") {
      return { ok: false, reason: `an evidence path is empty — name a file, not the workspace root.` };
    }
    if (!READABLE_ZONES.has(zone)) {
      return {
        ok: false,
        reason:
          `evidence path '${raw}' addresses a runtime-internal area, which is not readable — ` +
          `attach what you wrote under 'scratchpad/'.`,
      };
    }
    if (!out.includes(rel)) out.push(rel);
  }
  return { ok: true, paths: out };
}

// --- Schemas and declarations ---------------------------------------------------

export const advanceSchema = z.object({
  to: z.string().describe("Target state slug, as declared in the current state's transitions."),
  reason: z.string().min(1).describe("One sentence: why advance now."),
  evidence: z
    .array(z.string())
    .optional()
    .describe(
      "Files for the person deciding, when `to` is a human state: workspace-relative paths " +
        "(e.g. ['scratchpad/refund.json']), shown with that state's own. Refused on any other target.",
    ),
});

export const waitSchema = z.object({
  reason: z.string().min(1).describe("One sentence: what the run is waiting for."),
  until: z
    .string()
    .optional()
    .describe(
      "When to be resumed if nothing arrives sooner: a duration ('30m', '1d') or an " +
        "ISO-8601 instant.",
    ),
});

export const resetSchema = z.object({
  reason: z.string().min(1).describe("One sentence: why the run has to start over."),
});

export const getVariablesSchema = z.object({
  name: z.string().optional().describe("Variable to read; omit or leave empty for all."),
  path: z
    .string()
    .optional()
    .describe("Dotted path into the value, e.g. 'items.0.sku' or 'items.-1.sku' (last)."),
});

export const setVariablesSchema = z.object({
  variables: z.record(z.string(), z.unknown()).describe("Values keyed by name; whole values only."),
  lock: z.boolean().optional().describe("Lock them permanently."),
});

/**
 * Every control tool, in registration order. Descriptions are paid for on every
 * model call, so they say only what the model cannot infer; the advance tool
 * does not repeat the transition catalog the prompt's graph section renders.
 */
export function createControlTools(): StructuredTool[] {
  return [
    declaration(
      ADVANCE_TOOL,
      "Advance the workflow to the next state. Pick `to` from the current state's " +
        "transitions in the graph section above (a slug, never a title). The runtime " +
        "validates the edge, runs this state's `after` hook, then unlocks the next " +
        "state's tools.",
      advanceSchema,
    ),
    declaration(
      RESET_TOOL,
      "Start the workflow over from the state the conversation began in, keeping the " +
        "conversation and any work already written. Use it when this state cannot serve " +
        "what was asked: a wrong branch, a path no transition from here reaches, or a " +
        "follow-up arriving in a terminal state, where the run already finished. Call it " +
        "before answering, not after.",
      resetSchema,
    ),
    declaration(
      WAIT_TOOL,
      "Pause the run in this state until an external event arrives (a callback, a webhook, " +
        "a message someone sends in their own time). The run stays open here: when the event " +
        "is delivered you continue in this same state with what it carried. Use it instead of " +
        "ending your turn when the work cannot proceed until something reaches you. Set " +
        "'until' when you are waiting for a time rather than an event; an earlier event still " +
        "resumes you. This does NOT request a human decision, approval or review: those " +
        `belong to a human node, which you reach with ${ADVANCE_TOOL} and which the runtime ` +
        "parks and presents on its own. This tool moves the run nowhere.",
      waitSchema,
    ),
    declaration(
      GET_VARIABLES_TOOL,
      "Read the run's variables. Omit `name` for all of them; pass `path` to drill " +
        "into a structured value instead of pulling it whole into context.",
      getVariablesSchema,
    ),
    declaration(
      SET_VARIABLES_TOOL,
      "Record facts for the rest of the run; values may be structured. Pass " +
        "`lock: true` to make one permanent — required for anything a tool guard " +
        "reads. Writing a locked variable is refused, not ignored. `title` is " +
        "reserved for a short single-line label naming this run's task: set it " +
        "early, update it when the task changes, and never lock it.",
      setVariablesSchema,
    ),
  ];
}

// --- archmax_advance -----------------------------------------------------------

export interface AdvanceRequest {
  /** Tool call id, echoed on the resulting ToolMessage. */
  toolCallId: string;
  /** The id this call is reported under on the event stream (the provider's, else the generated fallback). */
  callId?: string;
  args: Record<string, unknown>;
  /** Checkpointed agent state at the time of the call. */
  state: unknown;
  /** Lifecycle context; its `iterations` are seeded from state and committed back. */
  ctx: LifecycleContext;
}

export interface AdvanceOutcome {
  message: Command | ToolMessage;
  moved?: {
    from: string;
    to: string;
    /** The decision record committed when `to` is a human state. */
    park?: PendingDecision;
  };
}

/**
 * Attempt a transition and commit the outcome: `workflowState` and the `agent`
 * trail step on success, `iterations` always, and — into a human state —
 * the pending-decision record with the park opened in its closing phase.
 */
export async function handleAdvance(
  opts: { machine: WorkflowMachine; lifecycle: LifecycleRunner; mountPrefixes?: MountPrefixes },
  request: AdvanceRequest,
): Promise<AdvanceOutcome> {
  const refuse = (text: string) => ({ message: refusal(ADVANCE_TOOL, request.toolCallId, text) });

  const parsed = advanceSchema.safeParse(request.args);
  if (!parsed.success) {
    return refuse(`${ADVANCE_TOOL} rejected: invalid arguments — ${schemaIssues(parsed.error)}`);
  }

  // Evidence is settled before the transition is attempted, so a refused
  // attachment leaves the run exactly where it was: no hook run, no trail step.
  const attached = parsed.data.evidence ?? [];
  let evidence: string[] = [];
  if (attached.length > 0) {
    if (!opts.machine.isHumanState(parsed.data.to)) {
      return refuse(
        `${ADVANCE_TOOL} rejected: evidence can only be attached when advancing into a human ` +
          `decision state, and '${parsed.data.to}' is not one — nothing would present it. ` +
          `Call again without 'evidence'.`,
      );
    }
    const validated = validateAdvanceEvidence(attached, opts.mountPrefixes);
    if (!validated.ok) return refuse(`${ADVANCE_TOOL} rejected: ${validated.reason}`);
    evidence = validated.paths;
  }

  const from = currentWorkflowState(request.state, opts.machine.entry);
  const result = await opts.lifecycle.attemptTransition(
    from,
    parsed.data.to,
    request.ctx,
    parsed.data.reason,
    request.callId ? { callId: request.callId } : undefined,
  );

  if (!result.ok) {
    // A terminal rejection is committed as `rejected` so the run routes through
    // `on_error`; a recoverable one keeps the agent in place, replying without
    // erroring the message so it retries rather than reading a failed run.
    return {
      message: commit({
        iterations: { ...result.corrections },
        ...(result.terminal ? { rejected: result.reason } : {}),
        messages: [toolReply(ADVANCE_TOOL, request.toolCallId, `${ADVANCE_TOOL} rejected: ${result.reason}`)],
      }),
    };
  }

  const fields = readWorkflowState(request.state);
  const step: TrailStep = { to: result.to, kind: "agent", reason: parsed.data.reason, ts: Date.now() };
  const moved: WorkflowUpdate = {
    workflowState: result.to,
    iterations: { ...result.corrections },
    // The gate ran the target's `before` hook: recorded as done for this visit,
    // so the target's first model call does not run it a second time.
    beforeDone: { ...(fields.beforeDone ?? {}), [result.to]: true },
    // A successful transition clears an earlier rejection marker and starts the target's turn budget afresh.
    rejected: null,
    stateTurns: null,
    auditTrail: [step],
    messages: [
      toolReply(
        ADVANCE_TOOL,
        request.toolCallId,
        `Advanced to state '${result.to}'. You may now use the tools allowed in this state.`,
      ),
    ],
  };

  if (!opts.machine.isHumanState(result.to)) {
    return { message: commit(moved), moved: { from, to: result.to } };
  }

  // Into a human state: the park record is committed with the transition, so a
  // process that dies before the closing turn still sees a parked session.
  const seq = (fields.decisionCount ?? 0) + 1;
  const park = decisionRecordFor(opts.machine, result.to, seq, evidence);
  return {
    message: commit({
      ...moved,
      pendingDecision: park,
      decisionCount: seq,
      status: WORKFLOW_STATUSES.awaitingDecision,
      parkPhase: "closing",
    }),
    moved: { from, to: result.to, park },
  };
}

// --- archmax_wait ----------------------------------------------------------------

/** The relative form of `until`: a positive integer and a unit, e.g. `30m`, `1d`. */
const RELATIVE = /^(\d+)(ms|s|m|h|d)$/;

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** The accepted `until` forms, quoted verbatim in every rejection. */
export const WAIT_UNTIL_FORMS =
  "a relative duration ('30m', '2h', '1d' — integer plus ms|s|m|h|d) or an absolute " +
  "ISO-8601 instant ('2026-08-13T09:00:00Z')";

export type WaitUntilResult =
  | { resumeAt: string; error?: undefined }
  | { resumeAt?: undefined; error: string };

/**
 * Resolve `until` against `now` (epoch ms) to an absolute instant: the
 * checkpoint outlives the process, so "1d" read tomorrow means nothing. Fails
 * closed — an unreadable `until` is refused, because a park that silently loses
 * its schedule is a run nothing ever wakes. An instant in the past means "due now".
 */
export function resolveWaitUntil(until: string, now: number): WaitUntilResult {
  const value = until.trim();
  if (value === "") return { error: "'until' is empty." };
  const relative = RELATIVE.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    if (amount <= 0) return { error: `'until' must be a positive duration; got '${value}'.` };
    return { resumeAt: new Date(now + amount * UNIT_MS[relative[2]!]!).toISOString() };
  }
  // Only ISO-8601-shaped input is tried as an instant: `Date.parse` accepts loose, locale-dependent forms.
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return { resumeAt: new Date(parsed).toISOString() };
  }
  return { error: `'until' value '${value}' is neither a duration nor an instant.` };
}

export interface WaitRequest {
  toolCallId: string;
  args: Record<string, unknown>;
  state: unknown;
}

export interface WaitOutcome {
  message: Command | ToolMessage;
  park?: PendingInput;
  /** Set when the state's `maxParks` refused the park; committed as `rejected`. */
  exhausted?: string;
}

/**
 * Service a wait call: commit the pending-input record and open the park. The
 * phase is `closing` when the model has said nothing since the person's last
 * message (it owes them one), `suspend` when its question already is the
 * message. An exhausted park budget is committed as `rejected`.
 */
export function handleWait(machine: WorkflowMachine, request: WaitRequest): WaitOutcome {
  const refuse = (text: string) => ({ message: refusal(WAIT_TOOL, request.toolCallId, text) });
  const parsed = waitSchema.safeParse(request.args);
  if (!parsed.success) {
    return refuse(
      `${WAIT_TOOL} rejected: a non-empty 'reason' is required — say what the run is waiting for.`,
    );
  }
  const at = Date.now();
  let resumeAt: string | undefined;
  if (parsed.data.until !== undefined) {
    const resolved = resolveWaitUntil(parsed.data.until, at);
    if (resolved.error) {
      return refuse(`${WAIT_TOOL} rejected: ${resolved.error} Expected ${WAIT_UNTIL_FORMS}.`);
    }
    resumeAt = resolved.resumeAt;
  }

  const fields = readWorkflowState(request.state);
  const slug = currentWorkflowState(request.state, machine.entry);
  const counts = fields.parkCounts ?? {};
  const soFar = counts[slug] ?? 0;
  const maxParks = machine.spec.states[slug]?.budget?.maxParks;
  if (maxParks != null && soFar + 1 > maxParks) {
    const reason =
      `state '${slug}' exhausted its park budget (maxParks: ${maxParks}) — it asked to ` +
      `wait again for: ${parsed.data.reason}`;
    return {
      message: commit({
        rejected: reason,
        messages: [refusal(WAIT_TOOL, request.toolCallId, `${WAIT_TOOL} rejected: ${reason}`)],
      }),
      exhausted: reason,
    };
  }

  const park = inputRecordFor(machine, slug, parsed.data.reason, resumeAt);
  const messages: unknown[] = (request.state as { messages?: unknown[] })?.messages ?? [];
  return {
    message: commit({
      pendingInput: park,
      status: WORKFLOW_STATUSES.awaitingInput,
      parkPhase: spokeSinceLastHumanMessage(messages) ? "suspend" : "closing",
      replyOnly: null,
      rejected: null,
      // Counted at the park that happened: a request the budget refused never becomes a park.
      parkCounts: { ...counts, [slug]: soFar + 1 },
      messages: [
        toolReply(
          WAIT_TOOL,
          request.toolCallId,
          `Waiting in state '${slug}'. The run is parked here and will continue in ` +
            `this same state when an event is delivered; stop working now.` +
            (resumeAt
              ? ` Nothing is scheduled by the runtime: ${resumeAt} is recorded for whoever ` +
                `wakes the run, and an earlier event resumes you just the same.`
              : ""),
        ),
      ],
    }),
    park,
  };
}

// --- archmax_reset ---------------------------------------------------------------

/** The state a reset returns to: the recorded entry state, else re-resolved from the trigger (older checkpoints). */
export function entryStateOf(
  state: Pick<WorkflowStateFields, "entryState" | "trigger">,
  machine: WorkflowMachine,
): string {
  if (state.entryState) return state.entryState;
  const triggerId = state.trigger?.id;
  return (triggerId ? machine.startStateForTrigger(triggerId) : undefined) ?? machine.entry;
}

export interface ResetRequest {
  toolCallId: string;
  args: Record<string, unknown>;
  state: unknown;
}

export interface ResetOutcome {
  message: Command | ToolMessage;
  moved?: { from: string; to: string };
}

/**
 * Service a reset: move back to the entry state and clear what gates progress
 * (correction budgets, `beforeDone`). Evidence — messages, files, variables, the
 * trail — is left alone: a reset moves the machine, not the history.
 */
export function handleReset(machine: WorkflowMachine, request: ResetRequest): ResetOutcome {
  const parsed = resetSchema.safeParse(request.args);
  if (!parsed.success) {
    return {
      message: refusal(
        RESET_TOOL,
        request.toolCallId,
        `${RESET_TOOL} rejected: a non-empty 'reason' is required — say why the run has to start over.`,
      ),
    };
  }
  const from = currentWorkflowState(request.state, machine.entry);
  const entry = entryStateOf(readWorkflowState(request.state), machine);
  return {
    message: commit({
      workflowState: entry,
      iterations: {},
      beforeDone: {},
      rejected: null,
      stateTurns: null,
      auditTrail: [{ to: entry, kind: "reset", reason: parsed.data.reason, ts: Date.now() } satisfies TrailStep],
      messages: [
        toolReply(
          RESET_TOOL,
          request.toolCallId,
          `Reset to state '${entry}'. Correction budgets are cleared and its entry gate runs ` +
            `again; earlier work in the conversation and in scratchpad/ is untouched.`,
        ),
      ],
    }),
    moved: { from, to: entry },
  };
}

// --- Variables ------------------------------------------------------------------

/** An optional string argument; `""` or whitespace means "not given", as models often send it. */
function optionalArg(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function known(store: VariableStore): string {
  const names = Object.keys(store).sort();
  return names.length > 0 ? names.join(", ") : "(none set yet)";
}

export interface VariableToolRequest {
  toolCallId: string;
  args: Record<string, unknown>;
  state: unknown;
}

/** Service an `archmax_get_variables` call against the checkpointed store. */
export function handleGetVariables(request: VariableToolRequest): ToolMessage {
  const reply = (content: string) => toolReply(GET_VARIABLES_TOOL, request.toolCallId, content);
  const refuse = (text: string) => refusal(GET_VARIABLES_TOOL, request.toolCallId, text);
  const parsed = getVariablesSchema.safeParse(request.args);
  if (!parsed.success) return refuse(`${GET_VARIABLES_TOOL} rejected: invalid arguments.`);
  const store = readVariables(request.state);
  const name = optionalArg(parsed.data.name);
  const path = optionalArg(parsed.data.path);

  if (name === undefined) {
    const all = Object.fromEntries(
      Object.entries(store).map(([key, entry]) => [key, { value: entry.value, locked: entry.locked }]),
    );
    return reply(JSON.stringify(all, null, 2));
  }
  const entry = store[name];
  if (entry === undefined) return refuse(`Variable '${name}' is not set. Set: ${known(store)}.`);
  if (path === undefined) return reply(JSON.stringify({ value: entry.value, locked: entry.locked }, null, 2));

  const resolved = resolvePath(entry.value, path.split("."));
  // No fallback to the whole value: returning something other than what was asked invites acting on it.
  if (resolved === undefined) return refuse(`Path '${path}' does not resolve against variable '${name}'.`);
  return reply(JSON.stringify({ value: resolved }, null, 2));
}

export interface SetVariablesOutcome {
  message: ToolMessage;
  /** The delta to commit, absent when the call was refused. */
  delta?: VariableStore;
  /** Names written, for the lifecycle event. */
  written?: string[];
  locked?: boolean;
}

/** Service an `archmax_set_variables` call. Atomic: one rejected key refuses the whole call. */
export function handleSetVariables(request: VariableToolRequest): SetVariablesOutcome {
  const refuse = (text: string) => ({ message: refusal(SET_VARIABLES_TOOL, request.toolCallId, text) });
  const parsed = setVariablesSchema.safeParse(request.args);
  if (!parsed.success) {
    return refuse(`${SET_VARIABLES_TOOL} rejected: invalid arguments — ${schemaIssues(parsed.error)}`);
  }
  const store = readVariables(request.state);
  const { variables, lock } = parsed.data;
  const names = Object.keys(variables);
  if (names.length === 0) return refuse(`${SET_VARIABLES_TOOL} rejected: no variables given.`);

  for (const name of names) {
    if (!VARIABLE_NAME_PATTERN.test(name)) {
      const hint = name.includes(".") ? " Variables are written whole — there is no sub-path write." : "";
      return refuse(
        `${SET_VARIABLES_TOOL} rejected: '${name}' is not a valid variable name (lowercase ` +
          `letters, digits and underscores, starting with a letter).${hint} Nothing was written.`,
      );
    }
    if (store[name]?.locked) {
      return refuse(
        `${SET_VARIABLES_TOOL} rejected: '${name}' is locked and cannot be changed ` +
          `(current value: ${JSON.stringify(store[name]?.value)}). Nothing was written.`,
      );
    }
    if (name === TITLE_VARIABLE) {
      // Refused, not silently dropped: an agent that believes it locked the title must not be lied to.
      if (lock === true) {
        return refuse(
          `${SET_VARIABLES_TOOL} rejected: '${TITLE_VARIABLE}' is never locked — it names the ` +
            `task this run is doing, and it has to stay correctable when the task changes. ` +
            `Retry without \`lock\`. Nothing was written.`,
        );
      }
      const problem = titleWriteError(variables[name]);
      if (problem) return refuse(`${SET_VARIABLES_TOOL} rejected: ${problem} Nothing was written.`);
    }
  }

  const locked = lock === true;
  const delta: VariableStore = {};
  for (const [name, value] of Object.entries(variables)) {
    delta[name] =
      name === TITLE_VARIABLE
        ? { value: normalizeTitle(value as string), locked: false }
        : { value, locked };
  }
  return {
    message: toolReply(
      SET_VARIABLES_TOOL,
      request.toolCallId,
      `Set ${names.join(", ")}${locked ? " (locked)" : ""}.`,
    ),
    delta,
    written: names,
    locked,
  };
}

/** Wrap an `archmax_set_variables` outcome as the update that commits its delta. */
export function setVariablesCommand(outcome: SetVariablesOutcome): Command | ToolMessage {
  if (!outcome.delta) return outcome.message;
  return commit({ variables: outcome.delta, messages: [outcome.message] });
}

/** The variables a state still owes before it may be left — its `requires` minus what is set. */
export function unmetRequirements(required: string[], store: VariableStore): string[] {
  return required.filter((name) => store[name] === undefined);
}

/**
 * The wording for a `${{…}}` reference in the agent's own tool arguments that
 * could not be resolved: a correctable refusal carrying the two fixes it might
 * need — discover what is set, or escape a reference meant as literal text.
 */
export function unresolvedArgumentMessage(failure: UnresolvedGlob): string {
  // A function replacer: `$$` in a string replacement is itself an escape for `$`.
  const escaped = failure.reference.replace("${{", () => "$${{");
  return (
    `Call refused before it ran: the argument reference ${failure.reference} could not be ` +
    `resolved — ${failure.detail}. Nothing was called and no partial value was delivered. ` +
    `Check what is set with \`${GET_VARIABLES_TOOL}\`, then retry with a reference that ` +
    `resolves — or, if you meant the literal text, write it as ${escaped}.`
  );
}
