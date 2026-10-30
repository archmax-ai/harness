/**
 * The regular-expression engine behind a signature entry's `pattern` rule.
 *
 * An author writes the pattern, but it runs against text a stranger chose, and
 * JavaScript's backtracking `RegExp` takes exponential time on `(a+)+$` against
 * a long run of `a`s ended by `!`. So an authored pattern is never run through
 * `RegExp`: it is matched by RE2 (`re2js`, pure JavaScript, so the spec subpath
 * stays browser-safe), which is linear in the input whatever the pattern.
 *
 * A pattern must also compile as an ECMA-262 regular expression with the `u`
 * flag — compiled and discarded, never executed — because RE2 accepts syntax
 * (`(?i)`, `\pL`, `\z`, POSIX classes) that a JSON Schema validator reading the
 * same `pattern` would refuse or read differently.
 */
import { RE2JS } from "re2js";

/** The longest pattern an entry may declare, in UTF-16 code units. */
export const PATTERN_MAX_LENGTH = 1000;

/** A pattern ready to match, or why it is not one, worded for a load error. */
export type CompiledPattern = { ok: true; test(value: string): boolean } | { ok: false; error: string };

/** Compiled outcomes, by pattern. Bounded: patterns come from authors, but a host may load many specs. */
const cache = new Map<string, CompiledPattern>();
const CACHE_LIMIT = 1000;

/**
 * A pattern compiled once and cached: RE2 for matching, ECMA-262 (`u`) as a
 * syntax check only. A failure quotes the engine that refused it. `test` is
 * true when the pattern is found anywhere in the value — JSON Schema's
 * semantics, so an author anchors with `^…$`.
 */
export function compilePattern(pattern: string): CompiledPattern {
  const cached = cache.get(pattern);
  if (cached) return cached;
  const compiled = compile(pattern);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(pattern, compiled);
  return compiled;
}

function compile(pattern: string): CompiledPattern {
  if (pattern.length > PATTERN_MAX_LENGTH) {
    return { ok: false, error: `it is ${pattern.length} characters long, over the limit of ${PATTERN_MAX_LENGTH}` };
  }
  let re2: RE2JS;
  try {
    re2 = RE2JS.compile(pattern);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  try {
    // Compiled for its syntax only; the result is never executed.
    new RegExp(pattern, "u");
  } catch (err) {
    return { ok: false, error: `a JSON Schema validator cannot read it: ${(err as Error).message}` };
  }
  return { ok: true, test: (value) => re2.test(value) };
}
