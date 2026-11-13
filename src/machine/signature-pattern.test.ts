import { describe, expect, it } from "vitest";
import { compilePattern, jsonSchemaPatternError, PATTERN_MAX_LENGTH } from "./signature-pattern.js";

function errorOf(pattern: string): string {
  const compiled = compilePattern(pattern);
  if (compiled.ok) throw new Error(`expected ${JSON.stringify(pattern)} to be refused`);
  return compiled.error;
}

describe("compilePattern", () => {
  it("matches anywhere in the value, as JSON Schema does", () => {
    const anchored = compilePattern("^A-[0-9]+$");
    const loose = compilePattern("[0-9]");
    if (!anchored.ok || !loose.ok) throw new Error("expected both to compile");
    expect(anchored.test("A-123")).toBe(true);
    expect(anchored.test("xA-123")).toBe(false);
    expect(loose.test("order 7")).toBe(true);
    expect(loose.test("order")).toBe(false);
  });

  it("refuses lookarounds and backreferences, quoting RE2", () => {
    expect(errorOf("(?=a)b")).toContain("(?=");
    expect(errorOf("(?!a)b")).toContain("(?!");
    expect(errorOf("(?<=a)b")).toMatch(/error parsing regexp/);
    expect(errorOf("(?<!a)b")).toMatch(/error parsing regexp/);
    expect(errorOf("(a)\\1")).toContain("\\1");
    expect(errorOf("(?<n>a)\\k<n>")).toContain("\\k");
  });

  it("refuses a pattern that does not compile", () => {
    expect(errorOf("[a-")).toMatch(/error parsing regexp/);
  });

  it("compiles RE2-only syntax for matching, leaving its portability to the parse", () => {
    for (const pattern of ["(?i)abc", "\\pL+", "\\p{Greek}", "[[:alpha:]]", "\\z"]) {
      expect(compilePattern(pattern).ok, pattern).toBe(true);
    }
  });

  it("refuses a pattern over the length limit, and takes one at it", () => {
    expect(errorOf("a".repeat(PATTERN_MAX_LENGTH + 1))).toContain(
      `over the limit of ${PATTERN_MAX_LENGTH}`,
    );
    expect(compilePattern("a".repeat(PATTERN_MAX_LENGTH)).ok).toBe(true);
  });

  it("compiles a pattern once", () => {
    expect(compilePattern("^cached-[a-z]+$")).toBe(compilePattern("^cached-[a-z]+$"));
  });

  it("matches a catastrophic pattern in linear time", () => {
    const compiled = compilePattern("(a+)+$");
    if (!compiled.ok) throw new Error("expected (a+)+$ to compile");
    const started = performance.now();
    expect(compiled.test(`${"a".repeat(8000)}!`)).toBe(false);
    expect(compiled.test("a".repeat(8000))).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("jsonSchemaPatternError", () => {
  it("refuses RE2-only syntax a JSON Schema validator cannot read", () => {
    for (const pattern of ["(?i)abc", "\\pL+", "\\p{Greek}", "[[:alpha:]]", "\\z"]) {
      expect(jsonSchemaPatternError(pattern), pattern).toContain("a JSON Schema validator cannot read it");
    }
  });

  it("takes a pattern both engines read", () => {
    for (const pattern of ["^A-[0-9]+$", "\\p{L}+", "^[a-z]{2,3}$"]) {
      expect(jsonSchemaPatternError(pattern), pattern).toBeUndefined();
    }
  });
});
