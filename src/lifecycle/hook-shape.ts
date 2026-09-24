/**
 * Readers for the shape of one authored hook: a tagged object whose single key
 * names its kind (`script`, `rubric`, or a custom kind an executor is
 * registered for), optionally beside the reserved `max_iterations` sidecar.
 */
import type { Hook, HookSpec } from "../machine/types.js";

/** Reserved sidecar keys ignored by hook kind detection. */
export const HOOK_SIDECAR_KEYS: ReadonlySet<string> = new Set(["max_iterations"]);

/** Normalize a `before`/`after` field into an ordered list of tagged hooks. */
export function normalizeHooks(spec: HookSpec | undefined): Hook[] {
  if (spec == null) return [];
  return Array.isArray(spec) ? spec : [spec];
}

/**
 * The kind of a tagged hook — its single key other than the sidecars — or
 * `undefined` for a malformed hook, which callers treat as an error
 * (fail-closed veto / validation error).
 */
export function hookKind(hook: Hook): string | undefined {
  if (!hook || typeof hook !== "object" || Array.isArray(hook)) return undefined;
  const keys = Object.keys(hook).filter((key) => !HOOK_SIDECAR_KEYS.has(key));
  return keys.length === 1 ? keys[0] : undefined;
}

/** The target value of a tagged hook (the script path, rubric name, …). */
export function hookValue(hook: Hook): string | undefined {
  const kind = hookKind(hook);
  return kind ? (hook as Record<string, string>)[kind] : undefined;
}

/**
 * The hook-level `max_iterations` sidecar — the bounded grade-and-retry budget
 * for an `after` hook of any kind — or `undefined` when absent or not a
 * non-negative number. It wins over the named rubric's own `max_iterations`,
 * because the sidecar describes *this* state's retry loop.
 */
export function hookMaxIterations(hook: Hook): number | undefined {
  if (!hook || typeof hook !== "object" || Array.isArray(hook)) return undefined;
  const value = (hook as Record<string, unknown>).max_iterations;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Short, human-readable label for a hook, for operator surfaces (events, the CLI
 * state flow). `{ script }` renders as the bare path; a `{ rubric }` renders as
 * `rubric#<index>`, because an inline grader has no name and its position is
 * what distinguishes it from the next one in the same phase; every other kind
 * renders as `<kind>:<value>`.
 */
export function afterHookLabel(hook: Hook, index = 0): string {
  const kind = hookKind(hook);
  if (kind === undefined) return "hook";
  if (kind === "rubric") return `rubric#${index}`;
  const value = (hook as Record<string, string>)[kind];
  return kind === "script" ? value : `${kind}:${value}`;
}

/**
 * The key one hook's grade-and-retry budget is counted under. Per hook, not per
 * state: `max_iterations` is declared on a hook, so two `after` hooks on one
 * state have independent budgets and neither can reset the other's count.
 *
 * Keyed by **position** rather than by label, so the identity does not move when
 * a script is renamed, and so two inline rubrics — which have no names at all —
 * are always distinguishable. Reordering a phase's hooks re-keys them, which is
 * the same class of edit as any other spec change (it moves the spec hash).
 */
export function iterationKey(state: string, phase: "before" | "after", index: number): string {
  return `${state}::${phase}::${index}`;
}
