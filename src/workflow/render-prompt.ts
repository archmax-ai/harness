/**
 * Deterministic rendering of the two spec-derived prompt sections, both pure
 * functions of the machine, so what the agent reads cannot drift from what the
 * runtime enforces.
 *
 * The graph is disclosed the way the tool surface is — only from where the agent
 * stands — which puts the two halves on opposite sides of the cache boundary:
 *
 *  - {@link renderWorkflowPrompt} is the **cacheable** half: the workflow's
 *    `title` and root `instructions`, and no state of the graph. It is a
 *    function of the header alone, so the prefix does not grow with the state
 *    count. Authored `WORKFLOW.md` prose is appended after it by the caller.
 *  - {@link renderStateGraph} is the **volatile** half, re-rendered per model
 *    call for the state in force: its outgoing edges, its own markers and hooks,
 *    and the run's trigger signature.
 *
 * No other state's slug, `title`, `summary`, hooks, budget or transitions is
 * rendered anywhere, and neither is a count of the states: a state the agent
 * cannot advance to is a state it cannot name. A state's `instructions` body is
 * surfaced for the active state, by the caller, and — quoted, for choosing — for
 * the target of an undescribed edge of the active state, by this renderer.
 */

import { afterHookLabel, hookKind, normalizeHooks } from "../lifecycle/hook-shape.js";
import type { WorkflowMachine } from "../machine/machine.js";
import type { SignatureEntry } from "../machine/signature.js";
import { ADVANCE_TOOL, SET_VARIABLES_TOOL } from "../machine/tool-names.js";
import type { MachineState, MachineTransition } from "../machine/types.js";

/**
 * One outgoing edge: the target's slug (the exact token `archmax_advance` takes),
 * its declared `type`, and the `description` the agent routes on.
 *
 * The two markers a target may carry are disclosed because each changes what the
 * call must carry or what follows it — `evidence` is accepted only when the
 * target is a human state, and both markers mean *stop* rather than *continue*.
 * They disclose the **consequence of taking the edge**, not the state on the
 * other side of it: nothing of the target's own title, summary, hooks or
 * transitions is rendered.
 *
 * An **undescribed** edge (no description, or a blank one) is transparent: the
 * target's `instructions` stand in for the description, quoted under the line
 * and framed as what the agent will do once there — given for choosing the edge,
 * not to be followed now. The author opts in per edge by leaving it undescribed;
 * the schema refuses one whose target has no instructions to show.
 */
function renderTransition(machine: WorkflowMachine, edge: MachineTransition): string {
  const notes: string[] = [];
  if (edge.type && edge.type !== "none") notes.push(edge.type);
  if (machine.isHumanState(edge.to)) notes.push("human decision node");
  if (machine.isTerminal(edge.to)) notes.push("terminal");
  const suffix = notes.length ? ` (${notes.join(", ")})` : "";
  const head = `- to \`${edge.to}\`${suffix}`;
  const description = edge.description?.trim();
  if (description) return `${head} — ${description}`;
  const instructions = machine.spec.states[edge.to]?.instructions?.trim() ?? "";
  const quoted = instructions
    .split("\n")
    .map((line) => (line.trim() ? `  > ${line.trimEnd()}` : "  >"));
  return [
    `${head} — no description; the instructions you will follow once in \`${edge.to}\`, ` +
      `given only for choosing this edge:`,
    ...(instructions ? quoted : []),
  ].join("\n");
}

/**
 * The active state's hooks, by phase. A **rubric** hook renders as its bare kind
 * — never the rubric's name, and never any of its declaration.
 *
 * Presence is disclosed because it is actionable: a graded exit can come back
 * with a correction the agent must act on. Identity is withheld because it is
 * not: no disclosed tool takes a rubric name, and the name is a handle into
 * content the agent may not read. Nothing here can reach the criteria, the
 * budget or the model — they live in a block this renderer never reads.
 */
function renderHooks(state: MachineState): string | null {
  const parts: string[] = [];
  for (const phase of ["before", "after"] as const) {
    const hooks = normalizeHooks(state[phase]);
    if (hooks.length === 0) continue;
    const labels = hooks.map((hook, index) =>
      hookKind(hook) === "rubric" ? "rubric" : afterHookLabel(hook, index),
    );
    parts.push(`${phase}: ${labels.join(", ")}`);
  }
  return parts.length ? parts.join("; ") : null;
}

/**
 * When a return is written. The returns are rendered in every state, so they
 * must not read as "set these now": a value written before the work settles it
 * is a guess, and locked it would be the caller's answer however the run went on.
 */
const RETURNS_TIMING =
  "Set each once its final value is known — moving to another state does not need it — and " +
  "lock one only when it is final: a locked return can no longer change.";

/**
 * The signature of the trigger this run was started by — and only that one. The
 * triggers of states this run did not enter are not disclosed, and the id needs
 * no label: there is one trigger and it is this run's. An untyped signature
 * reads as one sentence of names; once any entry declares a type or a
 * description, each entry gets its own line so both can sit beside the name.
 * The declaration's own `description` is never rendered: it is written for a
 * caller, and this run's brief is its `instructions`.
 */
function renderSignature(machine: WorkflowMachine, trigger: string | undefined, child: boolean): string[] {
  const signature = trigger ? machine.signatureForTrigger(trigger) : undefined;
  if (!signature) return [];
  const lines: string[] = [];
  const { requires, returns } = signature;
  if (requires.length > 0) {
    lines.push(
      isBare(requires)
        ? `This run was started with: ${names(requires)}.`
        : [`This run was started with:`, ...requires.map(renderEntry)].join("\n"),
    );
  }
  if (returns.length > 0) {
    // What the completion check actually does (`returns-check.ts`): a child's
    // caller gets every return, an unset one empty and named in a note; any
    // other run is rejected.
    const how = child
      ? `with \`${SET_VARIABLES_TOOL}\` before it finishes — your caller gets the ones you set, ` +
        `and any you leave unset as empty, with a note naming them`
      : `with \`${SET_VARIABLES_TOOL}\` before it finishes — finishing without every one set ` +
        `ends it rejected`;
    lines.push(
      isBare(returns)
        ? `This run must set ${names(returns)} ${how}. ${RETURNS_TIMING}`
        : [`This run must set these ${how}:`, ...returns.map(renderEntry), RETURNS_TIMING].join("\n"),
    );
  }
  return lines;
}

/** Whether no entry declares more than its name. */
function isBare(entries: SignatureEntry[]): boolean {
  return entries.every((entry) => !entry.type && !entry.description);
}

function names(entries: SignatureEntry[]): string {
  return entries.map((entry) => entry.name).join(", ");
}

/** One entry on its own line: `name (type) — description`, each part only when declared. */
function renderEntry(entry: SignatureEntry): string {
  const type = entry.type ? ` (${entry.type})` : "";
  const description = entry.description ? ` — ${entry.description}` : "";
  return `- ${entry.name}${type}${description}`;
}

/** What {@link renderStateGraph} needs about the run, beyond the state it is in. */
export interface StateGraphContext {
  /** The id of the trigger this session was started by, when one is recorded. */
  trigger?: string;
  /** The session is a sub-workflow child, whose caller reads what it returns. */
  child?: boolean;
}

/**
 * The active state's half of the graph: its hooks, the run's trigger signature,
 * and either its outgoing edges or the statement that it has none.
 *
 * Terminality is stated rather than left to be inferred from an absent list —
 * the old whole-graph section taught "a state listed with no transitions is
 * terminal", and with the listing gone there is nothing to read that from.
 * Returns `null` when the state discloses nothing at all.
 */
export function renderStateGraph(
  machine: WorkflowMachine,
  state: string,
  ctx: StateGraphContext = {},
): string | null {
  const declared = machine.spec.states[state];
  if (!declared) return null;
  const sections: string[] = [];

  const hooks = renderHooks(declared);
  if (hooks) sections.push(`Hooks: ${hooks}`);
  sections.push(...renderSignature(machine, ctx.trigger, ctx.child === true));

  const transitions = declared.transitions ?? [];
  sections.push(
    transitions.length > 0
      ? [
          `Transitions — choose one with \`${ADVANCE_TOOL}\` when this state's work is done:`,
          ...transitions.map((edge) => renderTransition(machine, edge)),
        ].join("\n")
      : `This state is terminal: no transition leads out of it. Finish its work and stop.`,
  );

  return sections.length > 0 ? sections.join("\n\n") : null;
}

/**
 * The cacheable half: the workflow's `title` and its root `instructions`. No
 * state is named — see the module docstring for why, and
 * {@link renderStateGraph} for what the agent is told instead.
 */
export function renderWorkflowPrompt(machine: WorkflowMachine): string {
  const { spec } = machine;
  const lines: string[] = [];
  const title = spec.title?.trim();
  lines.push(`# Workflow${title ? `: ${title}` : ""}`);
  // Standing instructions apply to every turn, so they belong in the static, cacheable prefix.
  if (spec.instructions?.trim()) {
    lines.push("", "## Instructions", "", spec.instructions.trim());
  }
  return lines.join("\n");
}

/** Strip HTML comments from authored prose; the model would be charged for them on every call. */
export function stripHtmlComments(text: string): string {
  if (!text.includes("<!--")) return text;
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
