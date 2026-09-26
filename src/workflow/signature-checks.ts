/**
 * The session-boundary halves of a trigger's signature, worded: why a turn may
 * not start (`requires`) and why a session may not complete (`returns`). Both
 * decide by `signatureValueIssues`, the one conformance rule; this module only
 * words the refusal for the site that raises it. Kept apart from the
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
  const entries = triggerId ? (machine.signatureForTrigger(triggerId)?.returns ?? []) : [];
  if (entries.length === 0) return undefined;
  const issues = signatureValueIssues(entries, storeValues(store));
  if (issues.length === 0) return undefined;
  const unset = issues.filter((issue) => issue.kind === "missing").map((issue) => `'${issue.name}'`);
  const invalid = issues.filter((issue) => issue.kind === "invalid").map((issue) => issue.message);
  const parts: string[] = [];
  if (unset.length > 0) {
    parts.push(
      `Completed in state '${state}' without setting ${unset.join(", ")}, which trigger ` +
        `'${triggerId}' declares in its 'returns'. Set ${unset.length === 1 ? "it" : "them"} with ` +
        `'${SET_VARIABLES_TOOL}' before finishing.`,
    );
  }
  if (invalid.length > 0) {
    parts.push(
      `Completed in state '${state}' with returns that do not conform to the types trigger ` +
        `'${triggerId}' declares: ${invalid.join("; ")}. Set a conforming value with ` +
        `'${SET_VARIABLES_TOOL}' before finishing.`,
    );
  }
  return parts.join(" ");
}
