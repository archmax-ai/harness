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
import {
  isFilePath,
  signatureValueIssues,
  type SignatureEntry,
  type SignatureValueIssue,
} from "../machine/signature.js";
import { SET_VARIABLES_TOOL } from "../machine/tool-names.js";
import { storeValues, type VariableStore } from "../machine/variables.js";

// --- File values ------------------------------------------------------------------

/** An `invalid` issue, as the file check reports one. */
export type InvalidValueIssue = Extract<SignatureValueIssue, { kind: "invalid" }>;

/**
 * What the file check asks of the session a `file` value belongs to: what a
 * path names in its workspace, and why it may not read it on runtime authority
 * (the rules that bind runtime authority — the zone rules and every
 * workflow-wide denial, inherited ones included), or `undefined` when it may.
 */
export interface FileValueCheck {
  kind(path: string): Promise<"file" | "directory" | "missing">;
  denied(path: string): string | undefined;
}

/** A `file` value in the canonical form the workspace addresses it by: no leading `/`. */
export function filePathOf(value: string): string {
  return value.startsWith("/") ? value.slice(1) : value;
}

/**
 * The runtime half of the `file` type: one issue per `file` entry whose value
 * has the right shape (the pure rule's business) but names a path this session
 * may not read, a folder, or nothing. Entries of another type, unset values and
 * malformed paths are left to {@link signatureValueIssues}.
 */
export async function fileValueIssues(
  entries: readonly SignatureEntry[],
  values: Readonly<Record<string, unknown>>,
  check: FileValueCheck,
): Promise<InvalidValueIssue[]> {
  const issues: InvalidValueIssue[] = [];
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const value = Object.hasOwn(values, entry.name) ? values[entry.name] : undefined;
    if (typeof value !== "string" || !isFilePath(value)) continue;
    const path = filePathOf(value);
    const issue = (message: string) =>
      issues.push({ kind: "invalid", name: entry.name, type: "file", found: "string", message });
    const denied = check.denied(path);
    if (denied) {
      issue(`'${entry.name}' names '${path}', which this session may not read: ${denied}`);
      continue;
    }
    const kind = await check.kind(path);
    if (kind === "directory") issue(`'${entry.name}' must name a file, but '${path}' is a folder`);
    else if (kind === "missing") issue(`'${entry.name}' must name a file, but nothing is at '${path}'`);
  }
  return issues;
}

/** Whether a signature list declares any `file` entry: only then does a site pay for the file check. */
export function hasFileEntries(entries: readonly SignatureEntry[] | undefined): boolean {
  return (entries ?? []).some((entry) => entry.type === "file");
}

// --- The session boundary -------------------------------------------------------------

/** The file issues of the `file` entries a trigger's `requires` declares, for {@link requiresRefusal}. */
export async function requiresFileIssues(
  machine: WorkflowMachine,
  triggerId: string,
  opening: VariableStore,
  files: FileValueCheck,
): Promise<InvalidValueIssue[]> {
  const entries = machine.signatureForTrigger(triggerId)?.requires ?? [];
  return hasFileEntries(entries) ? fileValueIssues(entries, storeValues(opening), files) : [];
}

/**
 * Why a turn's opening variables do not satisfy its trigger's `requires`, or
 * `undefined` when they do: every missing name in one sentence, then each value
 * that does not conform to its declared type, then each of `fileIssues` (from
 * {@link requiresFileIssues}).
 */
export function requiresRefusal(
  machine: WorkflowMachine,
  triggerId: string,
  opening: VariableStore,
  fileIssues: readonly InvalidValueIssue[] = [],
): string | undefined {
  const entries = machine.signatureForTrigger(triggerId)?.requires ?? [];
  if (entries.length === 0) return undefined;
  const issues: SignatureValueIssue[] = [...signatureValueIssues(entries, storeValues(opening)), ...fileIssues];
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

/** The file issues of the `file` entries a trigger's `returns` declares, for {@link returnsShortfall}. */
export async function returnsFileIssues(
  machine: WorkflowMachine,
  triggerId: string | undefined,
  store: VariableStore,
  files: FileValueCheck,
): Promise<InvalidValueIssue[]> {
  if (!triggerId) return [];
  const entries = machine.signatureForTrigger(triggerId)?.returns ?? [];
  return hasFileEntries(entries) ? fileValueIssues(entries, storeValues(store), files) : [];
}

/**
 * The session's {@link ReturnsShortfall}, or `undefined` when it owes its
 * trigger nothing: its unset and non-conforming returns, plus `fileIssues`
 * (from {@link returnsFileIssues}).
 */
export function returnsShortfall(
  machine: WorkflowMachine,
  triggerId: string | undefined,
  store: VariableStore,
  fileIssues: readonly InvalidValueIssue[] = [],
): ReturnsShortfall | undefined {
  if (!triggerId) return undefined;
  const entries = machine.signatureForTrigger(triggerId)?.returns ?? [];
  if (entries.length === 0) return undefined;
  const issues: SignatureValueIssue[] = [...signatureValueIssues(entries, storeValues(store)), ...fileIssues];
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
  fileIssues: readonly InvalidValueIssue[] = [],
): string | undefined {
  const owed = returnsShortfall(machine, triggerId, store, fileIssues);
  return owed ? returnsRejectionFor(owed, state) : undefined;
}

/**
 * Whether a session's `rejected` reason is a completion check's refusal of its
 * returns — the sentences {@link returnsRejectionFor} writes, and nothing else
 * does. The dispatcher reads a child rejected for its returns as a returns
 * failure (`invalid-return`), any other rejection as `rejected`.
 */
export function isReturnsRejection(reason: string): boolean {
  return /^Completed in state '[^']*' (?:without setting |with returns that do not conform )/.test(reason);
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
