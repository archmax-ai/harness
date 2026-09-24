import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter.js";

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
});
