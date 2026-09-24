/**
 * Grading rubrics: the standards a state's exit is measured against, declared
 * inline on the hook that applies them and dispatched by the runtime alone.
 *
 * This module is only the *vocabulary* — the verdict contract, the payload a
 * grader receives, the rejection wording, and the projection from a loaded spec
 * into a registry. There is deliberately no loader, no file format and no merge
 * path: a rubric is spec content, so the spec's own schema is the one thing that
 * has to accept it, and nothing outside assembly builds a registry.
 *
 * A rubric has no author-given name. Its identity is its **position** — the
 * state, the phase, and its index in that phase's hook list — which is also how
 * its retry budget is keyed, so two graders on one state can never share a
 * budget or be confused for one another in an event.
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { CreateDeepAgentParams } from "deepagents";
import type { MachineSpec, RubricDeclaration } from "../machine/types.js";
import { normalizeHooks } from "../lifecycle/hook-shape.js";
import { ADVANCE_TOOL } from "../machine/tool-names.js";

/** A grader in the Deep Agents shape, registered for the runtime's own `task` dispatch. */
export type LoadedRubric = NonNullable<CreateDeepAgentParams["subagents"]>[number];

/** The verdict vocabulary. `correct` asks for another iteration; `veto` blocks outright. */
export type RubricVerdict = "ok" | "correct" | "veto";

export interface RubricVerdictResult {
  verdict: RubricVerdict;
  reason: string;
  /** The rubric that produced this verdict; absent for a script hook's own verdict. */
  rubric?: string;
}

/**
 * The structured output a rubric with an iteration budget must return. Applied
 * automatically, so a grader's output is a contract rather than a prompt
 * convention.
 */
export const RUBRIC_VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["ok", "correct", "veto"] },
    reason: { type: "string" },
  },
  required: ["verdict", "reason"],
} as const;

/**
 * One registry entry: the declaration plus the positional id the runtime
 * dispatches it under. The id is internal — it appears in operator-facing events
 * and never in a prompt — so it is built for uniqueness, not for authoring.
 */
export interface Rubric extends RubricDeclaration {
  id: string;
  state: string;
  phase: "before" | "after";
  index: number;
}

/**
 * The id one inline rubric is registered and dispatched under. Positional
 * because an inline rubric has no name: reordering a phase's hooks re-keys them,
 * which is the same class of change as editing the spec at all (it moves the
 * spec hash).
 */
export function rubricId(state: string, phase: "before" | "after", index: number): string {
  return `${state}--${phase}--${index}`;
}

/** Whether a value is a usable verdict. Anything else has graded nothing. */
export function isRubricVerdict(value: unknown): value is RubricVerdictResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.verdict === "ok" || v.verdict === "correct" || v.verdict === "veto";
}

/**
 * The structured-output schema every dispatch requests: the verdict schema,
 * unconditionally.
 *
 * Not conditional on `max_iterations`, as it was when a grader was a subagent
 * that might also be a general-purpose helper. A rubric only ever grades, so a
 * grader that needs no retries still has to answer in the verdict vocabulary —
 * and without the schema its answer arrives as prose, parses to no verdict, and
 * fails closed on a transition the author expected it to wave through.
 */
export function resolveRubricResponseFormat(
  _rubric: RubricDeclaration,
): Record<string, unknown> | undefined {
  return RUBRIC_VERDICT_SCHEMA as unknown as Record<string, unknown>;
}

/** The compact task payload a grader is handed: the request, the transcript, and where it happened. */
export function buildRubricTaskDescription(args: Record<string, unknown>): string {
  return JSON.stringify(
    {
      userRequest: args.userRequest ?? null,
      history: args.history ?? [],
      state: args.state ?? null,
      phase: args.phase ?? null,
    },
    null,
    2,
  );
}

/**
 * What an `after`-hook verdict does to an `archmax_advance` attempt.
 *
 * `reason` is `null` when the transition may proceed. The other two are decided
 * here, together, because they are mutually exclusive and were not: a `correct`
 * whose budget is already spent is `budgetExhausted` and bills nothing, while
 * only a `correct` that actually got its retry is `consumesIteration`. Billing
 * an attempt that was never granted costs the state its budget for good on
 * re-entry (issue #62).
 */
export interface RubricTransitionOutcome {
  reason: string | null;
  /** A `correct` refused because the hook's `max_iterations` are already spent. */
  budgetExhausted: boolean;
  /** This block granted a retry, so it spends one of the hook's iterations. */
  consumesIteration: boolean;
}

/**
 * Map an `after`-hook verdict to an `archmax_advance` rejection outcome. One
 * implementation for every hook kind: the retry flow (bounded iterations with
 * remaining-attempt guidance) is identical whether the verdict came from a
 * rubric or a script — only the label differs (`rubric` vs `hook`).
 */
export function rubricTransitionOutcome(
  verdict: RubricVerdictResult,
  opts: { maxIterations: number; iterationsUsed: number; to?: string },
): RubricTransitionOutcome {
  const label = verdict.rubric ? "rubric" : "hook";
  if (verdict.verdict === "ok") {
    return { reason: null, budgetExhausted: false, consumesIteration: false };
  }
  if (verdict.verdict === "veto") {
    // A deliberate veto charges nothing: no retry was offered to bill for.
    return {
      reason: `${label} veto: ${verdict.reason}`,
      budgetExhausted: false,
      consumesIteration: false,
    };
  }

  const max = Math.max(0, opts.maxIterations);
  if (opts.iterationsUsed >= max) {
    return {
      reason: `${label} veto: reply still incomplete after ${max} attempt(s) — ${verdict.reason}`,
      budgetExhausted: true,
      consumesIteration: false,
    };
  }
  const remaining = max - opts.iterationsUsed;
  const target = opts.to ? `${ADVANCE_TOOL}({ to: "${opts.to}" })` : ADVANCE_TOOL;
  return {
    reason:
      `${label}: reply incomplete — ${verdict.reason}. ` +
      `Update your answer and call ${target} again. (${remaining} attempt(s) remaining)`,
    budgetExhausted: false,
    consumesIteration: true,
  };
}

/**
 * The rejection reason alone, for callers that do not decide the retry budget.
 */
export function rubricTransitionReason(
  verdict: RubricVerdictResult,
  opts: { maxIterations: number; iterationsUsed: number; to?: string },
): string | null {
  return rubricTransitionOutcome(verdict, opts).reason;
}

/**
 * The rubric registry for one machine: every inline rubric its states declare,
 * keyed by {@link rubricId}. Walks the spec rather than reading a root block,
 * because a grader lives on the hook that applies it.
 *
 * Scoped to this spec, so a delegated child is graded by its own standards; two
 * states declaring the same criteria produce two entries, which is the accepted
 * cost of a state being legible on its own.
 */
export function rubricsFromSpec(spec: Pick<MachineSpec, "states">): Map<string, Rubric> {
  const registry = new Map<string, Rubric>();
  for (const [state, declared] of Object.entries(spec.states ?? {})) {
    for (const phase of ["before", "after"] as const) {
      normalizeHooks(declared?.[phase]).forEach((hook, index) => {
        const declaration = (hook as { rubric?: RubricDeclaration }).rubric;
        if (declaration === undefined || typeof declaration !== "object") return;
        const id = rubricId(state, phase, index);
        registry.set(id, { ...declaration, id, state, phase, index });
      });
    }
  }
  return registry;
}

/**
 * Project the registry into the Deep Agents subagent shape so the framework
 * registers the `task` tool the runtime dispatches through. These are never
 * disclosed to the agent: `task` is withheld in every state and grantable by
 * nothing, so registering a grader here gives the graded agent no reach.
 *
 * `model` resolves the grader's own model when it declared one, else the
 * assembly's `rubric`-role model.
 */
export function rubricsAsSubagents(
  registry: Map<string, Rubric>,
  modelFor?: (rubric: Rubric) => BaseChatModel | undefined,
): LoadedRubric[] {
  return [...registry.values()].map((rubric) => {
    const responseFormat = resolveRubricResponseFormat(rubric);
    const model = modelFor?.(rubric);
    return {
      name: rubric.id,
      // A grader is dispatched by the runtime under its positional id, never
      // chosen from a menu by the agent, so the description exists only for the
      // framework's own tool schema — which no state is ever shown.
      description: `Grading rubric on '${rubric.state}' (${rubric.phase}).`,
      systemPrompt: rubric.instructions,
      ...(responseFormat !== undefined ? { responseFormat } : {}),
      ...(model !== undefined ? { model } : {}),
    } as LoadedRubric;
  });
}
