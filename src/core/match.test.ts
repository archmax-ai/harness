import { describe, expect, it } from "vitest";
import { deepEqual, partialMatch, regexFromString } from "./match.js";
import { findMock } from "./tool-mocks.js";

describe("regexFromString", () => {
  it("compiles /pattern/flags and leaves plain strings alone", () => {
    expect(regexFromString("/ord-\\d+/i")?.test("ORD-42")).toBe(true);
    expect(regexFromString("plain")).toBeNull();
    expect(regexFromString("/unterminated")).toBeNull();
  });

  it("throws on a malformed pattern rather than matching it literally", () => {
    expect(() => regexFromString("/(/")).toThrow();
  });
});

describe("partialMatch", () => {
  it("matches mappings on declared keys only, at every depth", () => {
    const actual = { file_path: "scratchpad/report.json", extra: 1, nested: { a: 1, b: 2 } };
    expect(partialMatch({ file_path: "scratchpad/report.json" }, actual)).toBe(true);
    expect(partialMatch({ nested: { a: 1 } }, actual)).toBe(true);
    expect(partialMatch({ nested: { a: 2 } }, actual)).toBe(false);
    expect(partialMatch({ missing: 1 }, actual)).toBe(false);
  });

  it("matches /pattern/flags strings as regexes against the stringified value", () => {
    expect(
      partialMatch(
        { file_path: "/scratchpad\\/report\\.json/" },
        { file_path: "/scratchpad/report.json" },
      ),
    ).toBe(true);
    expect(partialMatch({ n: "/^4\\d$/" }, { n: 42 })).toBe(true);
    expect(partialMatch({ n: "/^4\\d$/" }, { n: 7 })).toBe(false);
    // A missing key never satisfies a regex, even one that matches the empty string.
    expect(partialMatch({ n: "/.*/" }, {})).toBe(false);
  });

  it("matches arrays element-wise with the same rules inside", () => {
    expect(partialMatch([1, "/^b/"], [1, "beta"])).toBe(true);
    expect(partialMatch([1, 2], [1, 2, 3])).toBe(false);
    expect(partialMatch([{ a: 1 }], [{ a: 1, b: 2 }])).toBe(true);
    expect(partialMatch({ tags: ["x"] }, { tags: "x" })).toBe(false);
  });

  it("matches other scalars by strict equality", () => {
    expect(partialMatch(1, 1)).toBe(true);
    expect(partialMatch(1, "1")).toBe(false);
    expect(partialMatch(null, null)).toBe(true);
    expect(partialMatch(null, 0)).toBe(false);
    expect(partialMatch("a", { a: 1 })).toBe(false);
  });
});

describe("deepEqual", () => {
  it("compares JSON-shaped values structurally", () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
  });
});

// Tool mocks and assertions share one matcher, so what `calledTool.input`
// accepts is exactly what `whenInput` intercepts — pinned here for both.
describe("tool mocks use the shared matcher", () => {
  const mocks = [
    { name: "read_file", whenInput: { file_path: "/orders\\.json$/" }, result: "[]" },
    { name: "lookup", whenInput: { query: { customer: "acme" }, ids: [1, 2] }, result: "hit" },
  ];

  it("accepts a regex whenInput like an assertion input", () => {
    expect(
      findMock(mocks, "read_file", { file_path: "skills/order-data/assets/orders.json" })?.result,
    ).toBe("[]");
    expect(findMock(mocks, "read_file", { file_path: "notes.md" })).toBeUndefined();
  });

  it("matches nested mappings partially and arrays element-wise, as assertions do", () => {
    const args = { query: { customer: "acme", region: "eu" }, ids: [1, 2] };
    expect(findMock(mocks, "lookup", args)?.result).toBe("hit");
    expect(partialMatch(mocks[1]!.whenInput, args)).toBe(true);
    expect(findMock(mocks, "lookup", { ...args, ids: [1] })).toBeUndefined();
  });
});
