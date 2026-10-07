/**
 * The session-boundary halves of a trigger's signature, worded: why a turn may
 * not start (`requires`) and why a session may not complete (`returns`). Both
 * decide by `signatureValueIssues`, the one conformance rule; this module only
 * words the refusal for the site that raises it, and the note a child's caller
 * gets when the child left returns unset. Kept apart from the
 * middleware so the sub-workflow dispatcher can recognise a child its own
 * completion check rejected without importing the middleware.
 */
import type { WorkflowMachine } from "../machine/machine.js";
import { signatureValueIssues } from "../machine/signature.js";
import { SET_VARIABLES_TOOL } from "../machine/tool-names.js";
import { storeValues, type VariableStore } from "../machine/variables.js";

/**
 * Why a turn's opening variables do not satisfy its trigger's `requires`, or
 * `undefined` when they do: every missing name in one sentence, then each value
 * that does not conform to its declared type.
 */
export function requiresRefusal(
  machine: WorkflowMachine,
  triggerId: string,
  opening: VariableStore,
): string | undefined {
  const entries = machine.signatureForTrigger(triggerId)?.requires ?? [];
  if (entries.length === 0) return undefined;
  const issues = signatureValueIssues(entries, storeValues(opening));
  if (issues.length === 0) return undefined;
  const missing = issues.filter((issue) => issue.kind === "missing").map((issue) => `'${issue.name}'`);
  const invalid = issues.filter((issue) => issue.kind === "invalid").map((issue) => issue.message);
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`requires ${missing.join(", ")}, which this firing does not supply`);
  if (invalid.length > 0) parts.push(`declares typed inputs this firing does not satisfy: ${invalid.join("; ")}`);
  return `Refusing to start: trigger '${triggerId}' ${parts.join(". It also ")}.`;
}

/**
 * What a finishing session still owes the `returns` of the trigger that started
 * its current turn: the declared names it left unset and the typed values that
 * do not conform.
 */
export interface ReturnsShortfall {
  trigger: string;
  /** The unset names, each quoted for a sentence, in declaration order. */
  unset: string[];
  /** One message per typed return whose value does not conform. */
  invalid: string[];
}

/** The session's {@link ReturnsShortfall}, or `undefined` when it owes its trigger nothing. */
export function returnsShortfall(
  machine: WorkflowMachine,
  triggerId: string | undefined,
  store: VariableStore,
): ReturnsShortfall | undefined {
  if (!triggerId) return undefined;
  const entries = machine.signatureForTrigger(triggerId)?.returns ?? [];
  if (entries.length === 0) return undefined;
  const issues = signatureValueIssues(entries, storeValues(store));
  if (issues.length === 0) return undefined;
  return {
    trigger: triggerId,
    unset: issues.filter((issue) => issue.kind === "missing").map((issue) => `'${issue.name}'`),
    invalid: issues.filter((issue) => issue.kind === "invalid").map((issue) => issue.message),
  };
}

/**
 * Why a session completing in `state` does not satisfy the `returns` of the
 * trigger that started its current turn, or `undefined` when it does: every
 * unset name, then every typed return whose value does not conform.
 */
export function returnsRejection(
  machine: WorkflowMachine,
  triggerId: string | undefined,
  state: string,
  store: VariableStore,
): string | undefined {
  const owed = returnsShortfall(machine, triggerId, store);
  return owed ? returnsRejectionFor(owed, state) : undefined;
}

/** The rejection a {@link ReturnsShortfall} settles as, worded for the state the session finished in. */
export function returnsRejectionFor(owed: ReturnsShortfall, state: string): string {
  const { trigger, unset, invalid } = owed;
  const parts: string[] = [];
  if (unset.length > 0) {
    parts.push(
      `Completed in state '${state}' without setting ${unset.join(", ")}, which trigger ` +
        `'${trigger}' declares in its 'returns'. Set ${unset.length === 1 ? "it" : "them"} with ` +
        `'${SET_VARIABLES_TOOL}' before finishing.`,
    );
  }
  if (invalid.length > 0) {
    parts.push(
      `Completed in state '${state}' with returns that do not conform to the types trigger ` +
        `'${trigger}' declares: ${invalid.join("; ")}. Set a conforming value with ` +
        `'${SET_VARIABLES_TOOL}' before finishing.`,
    );
  }
  return parts.join(" ");
}

/**
 * The return variable a sub-workflow child's caller finds beside the returns
 * the child did set, when it finished without setting them all. Reserved: a
 * trigger's `returns` may not declare it.
 */
export const RETURNS_NOTE_VARIABLE = "note";

/** The {@link RETURNS_NOTE_VARIABLE} value naming the returns a child left unset. */
export function missingReturnsNote(unset: string[]): string {
  const quoted = unset.map((name) => `'${name}'`).join(", ");
  return `Not all return variables were set by the sub-workflow: ${quoted} ${unset.length === 1 ? "was" : "were"} not set.`;
}
