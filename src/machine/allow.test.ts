import { describe, expect, it } from "vitest";
import { argsSatisfy, normalizeAllowEntry, valueMatches } from "./allow.js";

describe("valueMatches", () => {
  it("matches globs after normalizing leading slashes", () => {
    expect(valueMatches("/output/case.json", ["output/case.json"])).toBe(true);
    expect(valueMatches("output/case.json", ["output/*.json"])).toBe(true);
    expect(valueMatches("data/x", ["output/**"])).toBe(false);
    expect(valueMatches(undefined, ["**"])).toBe(false);
  });

  it("canonicalizes the value so `./` and `..` prefixes cannot dodge a glob", () => {
    // `forbid_paths` bypass: a `./` prefix must still match (issue #24).
    expect(valueMatches("./secrets/key", ["secrets/**"])).toBe(true);
    expect(valueMatches(".//secrets/key", ["secrets/**"])).toBe(true);
    expect(valueMatches("secrets/../secrets/key", ["secrets/**"])).toBe(true);
  });

  it("matches dot-prefixed segments on both the deny and the allow side", () => {
    // `forbid_paths` bypass: a dotfile must not escape a deny glob (issue #25).
    expect(valueMatches("secrets/.env", ["secrets/**"])).toBe(true);
    expect(valueMatches(".env", ["**"])).toBe(true);
    expect(valueMatches(".github/workflows/ci.yml", ["**/*.yml"])).toBe(true);
    // The allow side reads the same way: a dotfile under an allowed subtree is allowed.
    expect(valueMatches("scratchpad/.cache/x", ["scratchpad/**"])).toBe(true);
    expect(valueMatches("scratchpad/.keep", ["scratchpad/*"])).toBe(true);
    // A dot-prefixed glob still means what it says.
    expect(valueMatches("secrets/plain", ["secrets/.*"])).toBe(false);
  });
});

describe("normalizeAllowEntry", () => {
  it("handles bare strings, args, and the paths shorthand", () => {
    expect(normalizeAllowEntry("ls")).toEqual({ tool: "ls", argMatchers: null });
    expect(normalizeAllowEntry({ tool: "archmax_advance", args: { to: ["done"] } })).toEqual({
      tool: "archmax_advance",
      argMatchers: { to: ["done"] },
    });
    // `paths:` is stored under `file_path` and marked: it guards every path
    // argument the matched tool declares.
    expect(normalizeAllowEntry({ tool: "write_file", paths: "output/x.json" })).toEqual({
      tool: "write_file",
      argMatchers: { file_path: ["output/x.json"] },
      fromPaths: true,
    });
  });

  it("carries a tool name through verbatim", () => {
    expect(normalizeAllowEntry("archmax_run").tool).toBe("archmax_run");
    expect(normalizeAllowEntry({ tool: "archmax_advance", args: { to: ["done"] } })).toEqual({
      tool: "archmax_advance",
      argMatchers: { to: ["done"] },
    });
    // A host tool that merely resembles a control keeps its own name.
    expect(normalizeAllowEntry("advance_state_v2").tool).toBe("advance_state_v2");
  });

  it("normalizes the same shapes used by allow_always entries", () => {
    // `allow_always` reuses AllowEntry, so normalization is identical.
    expect(normalizeAllowEntry("write_file")).toEqual({ tool: "write_file", argMatchers: null });
    expect(normalizeAllowEntry({ tool: "write_file", args: { file_path: ["secrets/**"] } })).toEqual({
      tool: "write_file",
      argMatchers: { file_path: ["secrets/**"] },
    });
  });

  it("ignores `connection` — it selects credentials, not governance", () => {
    expect(
      normalizeAllowEntry({ tool: "microsoft-outlook__reply-email", connection: "outlook-support" }),
    ).toEqual({ tool: "microsoft-outlook__reply-email", argMatchers: null });
    expect(
      normalizeAllowEntry({
        tool: "microsoft-outlook__reply-email",
        connection: "outlook-support",
        args: { to: ["*@example.com"] },
      }),
    ).toEqual({
      tool: "microsoft-outlook__reply-email",
      argMatchers: { to: ["*@example.com"] },
    });
  });
});

describe("argsSatisfy", () => {
  it("requires every matcher to match, and allows null matchers", () => {
    expect(argsSatisfy(null, { anything: 1 })).toBe(true);
    expect(argsSatisfy({ file_path: ["output/*.json"] }, { file_path: "output/a.json" })).toBe(true);
    expect(argsSatisfy({ to: ["done"] }, { to: "orders_question" })).toBe(false);
  });

  it("reads a dotted argument key by own properties only", () => {
    expect(argsSatisfy({ "a.b": ["x"] }, { a: { b: "x" } })).toBe(true);
    expect(argsSatisfy({ "a.x": ["*"] }, { a: 1 })).toBe(false);
    // Prototype members are not the call's data.
    expect(argsSatisfy({ "tags.length": ["*"] }, { tags: ["a"] })).toBe(false);
    expect(argsSatisfy({ "a.constructor": ["*"] }, { a: {} })).toBe(false);
  });
});

describe("an argument matched as text", () => {
  // `file_path` is the only path argument of a tool that declares none.
  const grant = { pathArgs: ["file_path"], side: "grant" } as const;
  const deny = { pathArgs: ["file_path"], side: "deny" } as const;
  const vars = (value: unknown) => ({ p: { value, locked: true } });

  it("admits an empty value against a guard that resolves to it, and nothing else", () => {
    const guard = { address2: ["${{p}}"] };
    expect(argsSatisfy(guard, { address2: "" }, vars(""), undefined, grant)).toBe(true);
    expect(argsSatisfy(guard, { address2: "Suite 4" }, vars(""), undefined, grant)).toBe(false);
    expect(argsSatisfy({ address2: [""] }, { address2: "" }, undefined, undefined, grant)).toBe(true);
  });

  it("matches a URL and a stored value as written", () => {
    expect(
      argsSatisfy({ url: ["https://api.example.com/**"] }, { url: "https://api.example.com/v1/orders" }, undefined, undefined, grant),
    ).toBe(true);
    expect(argsSatisfy({ url: ["https://api.example.com/**"] }, { url: "https://evil.example.com/v1" }, undefined, undefined, grant)).toBe(false);
    expect(argsSatisfy({ url: ["${{p}}"] }, { url: "https://x.com/a?b=1" }, vars("https://x.com/a?b=1"), undefined, grant)).toBe(true);
    expect(argsSatisfy({ line: ["${{p}}"] }, { line: "Unit 4//B" }, vars("Unit 4//B"), undefined, grant)).toBe(true);
    expect(argsSatisfy({ line: ["${{p}}"] }, { line: "Unit 4/B" }, vars("Unit 4//B"), undefined, grant)).toBe(false);
  });

  it("does not admit a different spelling in a grant", () => {
    expect(argsSatisfy({ name: ["abs"] }, { name: "/abs" }, undefined, undefined, grant)).toBe(false);
    expect(argsSatisfy({ name: ["x"] }, { name: "./x" }, undefined, undefined, grant)).toBe(false);
  });

  it("is caught by a denial in either form", () => {
    expect(argsSatisfy({ target: ["secrets/**"] }, { target: "secrets/k" }, undefined, undefined, deny)).toBe(true);
    expect(argsSatisfy({ target: ["secrets/**"] }, { target: "./secrets/k" }, undefined, undefined, deny)).toBe(true);
    expect(argsSatisfy({ target: ["https://evil.com/**"] }, { target: "https://evil.com/x" }, undefined, undefined, deny)).toBe(true);
  });

  it("leaves a path argument canonicalized", () => {
    expect(argsSatisfy({ file_path: ["reports/**"] }, { file_path: "./reports/q3.md" }, undefined, undefined, grant)).toBe(true);
    expect(argsSatisfy({ file_path: ["reports/**"] }, { file_path: "reports/../secrets/k" }, undefined, undefined, grant)).toBe(false);
  });
});
