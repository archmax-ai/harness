import { describe, expect, it } from "vitest";

import { parseCodeDescription } from "./code-description.js";

describe("parseCodeDescription", () => {
  it("extracts the prose of a leading JSDoc block", () => {
    const source = [
      "/**",
      " * Vetoes the run unless the requester email exists in /data/orders.json.",
      " */",
      "const x = 1;",
    ].join("\n");
    expect(parseCodeDescription(source)).toEqual({
      description: "Vetoes the run unless the requester email exists in /data/orders.json.",
    });
  });

  it("strips * gutters and preserves multi-line prose", () => {
    const source = [
      "/**",
      " * First line.",
      " *",
      " * Second paragraph.",
      " */",
      "run();",
    ].join("\n");
    expect(parseCodeDescription(source)?.description).toBe("First line.\n\nSecond paragraph.");
  });

  it("accepts a single-line block and leading whitespace", () => {
    expect(parseCodeDescription("\n\n  /** Checks refund limits. */\ncode();")).toEqual({
      description: "Checks refund limits.",
    });
  });

  it("truncates the description at the first @tag line", () => {
    const source = [
      "/**",
      " * Judges the final reply.",
      " * @param none",
      " * @remarks internal",
      " */",
    ].join("\n");
    expect(parseCodeDescription(source)?.description).toBe("Judges the final reply.");
  });

  it("returns null for a leading // line comment", () => {
    expect(parseCodeDescription("// check-requester — lifecycle hook\ncode();")).toBeNull();
  });

  it("returns null when the file starts with code", () => {
    expect(parseCodeDescription("const a = 1;\n/** Too late. */")).toBeNull();
  });

  it("returns null for a plain (non-JSDoc) block comment", () => {
    expect(parseCodeDescription("/* not jsdoc */\ncode();")).toBeNull();
  });

  it("returns null for an empty or whitespace-only JSDoc block", () => {
    expect(parseCodeDescription("/***/\ncode();")).toBeNull();
    expect(parseCodeDescription("/**/\ncode();")).toBeNull();
    expect(parseCodeDescription("/**\n *\n */\ncode();")).toBeNull();
  });

  it("returns null when the block holds only tags", () => {
    expect(parseCodeDescription("/** @deprecated */\ncode();")).toBeNull();
  });

  it("normalizes BOM and CRLF input", () => {
    const source = "﻿/**\r\n * Handles CRLF sources.\r\n */\r\ncode();\r\n";
    expect(parseCodeDescription(source)?.description).toBe("Handles CRLF sources.");
  });

  it("returns null for empty input", () => {
    expect(parseCodeDescription("")).toBeNull();
  });
});
