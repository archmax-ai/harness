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
 * surfaced only for the active state, by the caller.
 */

import { afterHookLabel, hookKind, normalizeHooks } from "../lifecycle/hook-shape.js";
import type { WorkflowMachine } from "../machine/machine.js";
import { ADVANCE_TOOL, SET_VARIABLES_TOOL } from "../machine/tool-names.js";
import type { MachineState, MachineTransition } from "../machine/types.js";

/**
 * One outgoing edge: the target's slug (the exact token `archmax_advance` takes),
 * its declared `type`, and the required `description` the agent routes on.
 *
 * The two markers a target may carry are disclosed because each changes what the
 * call must carry or what follows it — `evidence` is accepted only when the
 * target is a human state, and both markers mean *stop* rather than *continue*.
 * They disclose the **consequence of taking the edge**, not the state on the
 * other side of it: nothing of the target's own title, summary, instructions,
 * hooks or transitions is rendered.
 */
function renderTransition(machine: WorkflowMachine, edge: MachineTransition): string {
  const notes: string[] = [];
  if (edge.type && edge.type !== "none") notes.push(edge.type);
  if (machine.isHumanState(edge.to)) notes.push("human decision node");
  if (machine.isTerminal(edge.to)) notes.push("terminal");
  const suffix = notes.length ? ` (${notes.join(", ")})` : "";
  return `- to \`${edge.to}\`${suffix} — ${edge.description.trim()}`;
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
 * The signature of the trigger this run was started by — and only that one. The
 * triggers of states this run did not enter are not disclosed, and the id needs
 * no label: there is one trigger and it is this run's.
 */
function renderSignature(machine: WorkflowMachine, trigger: string | undefined): string[] {
  if (!trigger) return [];
  const lines: string[] = [];
  const requires = machine.requiresForTrigger(trigger) ?? [];
  const returns = machine.returnsForTrigger(trigger) ?? [];
  if (requires.length > 0) {
    lines.push(`This run was started with: ${requires.join(", ")}.`);
  }
  if (returns.length > 0) {
    lines.push(
      `This run must set ${returns.join(", ")} with \`${SET_VARIABLES_TOOL}\` — it does not ` +
        `complete until every one is set.`,
    );
  }
  return lines;
}

/** What {@link renderStateGraph} needs about the run, beyond the state it is in. */
export interface StateGraphContext {
  /** The id of the trigger this session was started by, when one is recorded. */
  trigger?: string;
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
  sections.push(...renderSignature(machine, ctx.trigger));

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
