/**
 * The one partial-match vocabulary for a *declared* value against an *observed*
 * one. Case assertions (`calledTool.input`, `blockedTool.input`, …) and tool
 * mocks (`whenInput`) both read it, so a matcher an author writes means the same
 * thing whichever side of a tool call it sits on:
 *
 * - a mapping matches when every declared key is present and matches — nested
 *   mappings partially, so undeclared keys are ignored at every depth;
 * - an array matches element-wise: same length, each element by these rules;
 * - a string of the form `/pattern/flags` is a regular expression, tested
 *   against the stringified observed value;
 * - every other scalar (and `null`) matches by strict equality.
 *
 * Runtime-owned (`core/`) because the tool-mock gateway is runtime code and the
 * runtime never imports from the testing modules.
 */

/**
 * Compile a `/pattern/flags` string to a regex; `null` when the string is not
 * regex-shaped. Throws on a malformed pattern, so a schema can reject it
 * statically rather than let it match as a literal at run time.
 */
export function regexFromString(raw: string): RegExp | null {
  const match = /^\/(.*)\/([a-z]*)$/s.exec(raw);
  if (!match) return null;
  return new RegExp(match[1] as string, match[2]);
}

/** Structural equality over JSON-shaped values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== typeof b || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  return (
    keysA.length === Object.keys(objB).length && keysA.every((k) => deepEqual(objA[k], objB[k]))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function scalarMatches(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "string") {
    let regex: RegExp | null = null;
    try {
      regex = regexFromString(expected);
    } catch {
      // A malformed pattern is a schema error upstream; here it can only be a literal.
    }
    if (regex) return regex.test(String(actual ?? ""));
  }
  return expected === actual;
}

/** Whether `actual` satisfies the declared `expected` shape (see module docs). */
export function partialMatch(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((v, i) => partialMatch(v, actual[i]))
    );
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.entries(expected).every(([k, v]) => k in actual && partialMatch(v, actual[k]));
  }
  return scalarMatches(expected, actual);
}
