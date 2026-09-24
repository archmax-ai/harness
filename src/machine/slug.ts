/**
 * The one shape a slug takes, at every level that has one: a **state slug** (a
 * state's key in `states`) and a **workflow slug** (the `workflows/<slug>/`
 * directory name, the CLI argument, a delegation tool's target). Deliberately
 * the same shape, so the pattern lives here alone.
 */

/**
 * **Hyphen-separated kebab-case** — lowercase alphanumeric segments joined by
 * single hyphens. No leading, trailing, or doubled hyphens; no underscores, no
 * uppercase, no spaces.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether a value is a well-formed slug. */
export function isSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG_PATTERN.test(value);
}
