import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import { ENGINES, parseFrontmatter } from "./frontmatter.js";

describe("parseFrontmatter", () => {
  it("returns null when the input has no frontmatter delimiters", () => {
    expect(parseFrontmatter("# Just markdown\nno frontmatter here\n")).toBeNull();
    expect(parseFrontmatter("")).toBeNull();
  });

  it("returns null instead of throwing on malformed YAML", () => {
    const raw = "---\nfoo: [unclosed\n---\nbody\n";
    expect(parseFrontmatter(raw)).toBeNull();
  });

  it("returns the parsed data and the body after the closing delimiter", () => {
    const parsed = parseFrontmatter("---\nname: test\ncount: 2\n---\nBody text\n");
    expect(parsed).not.toBeNull();
    expect(parsed?.data).toEqual({ name: "test", count: 2 });
    expect(parsed?.body).toBe("Body text\n");
  });

  it("preserves a leading blank line in the body", () => {
    const parsed = parseFrontmatter("---\nname: test\n---\n\nBody after blank\n");
    expect(parsed?.body).toBe("\nBody after blank\n");
  });

  it("parses CRLF input without leaking \\r into string values", () => {
    const parsed = parseFrontmatter("---\r\nname: test\r\nentry: start\r\n---\r\nBody line\r\n");
    expect(parsed).not.toBeNull();
    expect(parsed?.body).toBe("Body line\r\n");
    expect(parsed?.data).toEqual({ name: "test", entry: "start" });
  });

  it("uses YAML 1.2 semantics: yes/no/on parse as strings, not booleans", () => {
    const parsed = parseFrontmatter("---\nanswer: no\nother: yes\nswitch: on\n---\nbody\n");
    expect(parsed?.data).toEqual({ answer: "no", other: "yes", switch: "on" });
  });

  it("refuses a language-tagged fence and never evaluates its block", () => {
    const g = globalThis as Record<string, unknown>;
    for (const tag of ["js", "javascript", " js", "JS", "coffee", "toml"]) {
      delete g.__frontmatterEvaluated;
      const raw = `---${tag}\n{ x: ((globalThis.__frontmatterEvaluated = true), 1) }\n---\nbody\n`;
      expect(parseFrontmatter(raw)).toBeNull();
      expect(g.__frontmatterEvaluated).toBeUndefined();
    }
  });

  it("refuses a language-tagged fence spelled with CRLF or extra dashes", () => {
    const g = globalThis as Record<string, unknown>;
    for (const raw of [
      `---js\r\n{ x: ((globalThis.__frontmatterEvaluated = true), 1) }\r\n---\r\nbody\r\n`,
      `----js\n{ x: ((globalThis.__frontmatterEvaluated = true), 1) }\n----\nbody\n`,
    ]) {
      delete g.__frontmatterEvaluated;
      expect(parseFrontmatter(raw)).toBeNull();
      expect(g.__frontmatterEvaluated).toBeUndefined();
    }
  });

  it("rejects a BOM-prefixed fence before any engine runs", () => {
    // A leading BOM fails matter.test, so the input is refused up front.
    const g = globalThis as Record<string, unknown>;
    delete g.__frontmatterEvaluated;
    const raw = `\uFEFF---js\n{ x: ((globalThis.__frontmatterEvaluated = true), 1) }\n---\nbody\n`;
    expect(parseFrontmatter(raw)).toBeNull();
    expect(g.__frontmatterEvaluated).toBeUndefined();
  });

  it("still parses a plain fence that has trailing whitespace", () => {
    const parsed = parseFrontmatter("--- \nname: test\n---\nbody\n");
    expect(parsed?.data).toEqual({ name: "test" });
  });
});

describe("gray-matter engine backstop", () => {
  it("throws rather than evaluates if a js tag reaches gray-matter directly", () => {
    // parseFrontmatter rejects a tagged fence before this point; this guards the
    // engine override on its own, so a future change to the guard cannot eval.
    const g = globalThis as Record<string, unknown>;
    delete g.__frontmatterEvaluated;
    const raw = `---js\n{ x: ((globalThis.__frontmatterEvaluated = true), 1) }\n---\nbody\n`;
    expect(() => matter(raw, { engines: ENGINES })).toThrow();
    expect(g.__frontmatterEvaluated).toBeUndefined();
  });
});
