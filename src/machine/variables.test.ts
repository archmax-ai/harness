import { describe, expect, it } from "vitest";
import picomatch from "picomatch";
import {
  buildSeededVariables,
  describeGlob,
  escapeGlobLiteral,
  hasVariableReference,
  parseReferences,
  resolveArguments,
  resolveGlob,
  resolvePath,
  resolveText,
  InvalidTitleError,
  TITLE_MAX_LENGTH,
  TITLE_VARIABLE,
  titleWriteError,
  type VariableStore,
} from "./variables.js";

const store = (values: Record<string, unknown>): VariableStore =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v, locked: false }]));

/** Resolve then match, the way the kernel does, so escaping is tested end to end. */
function matches(glob: string, vars: VariableStore, candidate: string): boolean {
  const result = resolveGlob(glob, vars);
  if (!result.ok) return false;
  return picomatch.isMatch(candidate, result.pattern);
}

describe("parseReferences", () => {
  it("finds a whole-variable reference", () => {
    expect(parseReferences("${{from_email}}")).toEqual([
      { raw: "${{from_email}}", name: "from_email", path: [], index: 0 },
    ]);
  });

  it("finds a dotted path reference", () => {
    const [ref] = parseReferences("${{order.items.0.sku}}");
    expect(ref).toMatchObject({ name: "order", path: ["items", "0", "sku"] });
  });

  it("finds several references in one glob", () => {
    const refs = parseReferences("data/${{tenant}}/${{case_id}}/**");
    expect(refs.map((r) => r.name)).toEqual(["tenant", "case_id"]);
  });

  it("reports a glob with no references", () => {
    expect(hasVariableReference("output/**")).toBe(false);
    expect(parseReferences("output/**")).toEqual([]);
  });
});

describe("resolvePath", () => {
  const value = {
    customer: { id: "C-1" },
    items: [{ sku: "A-1" }, { sku: "B-2" }],
    tags: ["x", "y"],
  };

  it("descends into objects", () => {
    expect(resolvePath(value, ["customer", "id"])).toBe("C-1");
  });

  it("indexes arrays", () => {
    expect(resolvePath(value, ["items", "1", "sku"])).toBe("B-2");
    expect(resolvePath(value, ["tags", "0"])).toBe("x");
  });

  it("addresses arrays from the end", () => {
    expect(resolvePath(value, ["items", "-1", "sku"])).toBe("B-2");
    expect(resolvePath(value, ["items", "-2", "sku"])).toBe("A-1");
    expect(resolvePath(value, ["tags", "-1"])).toBe("y");
  });

  it("returns undefined for an out-of-range index in either direction", () => {
    expect(resolvePath(value, ["items", "5", "sku"])).toBeUndefined();
    expect(resolvePath(value, ["items", "-3", "sku"])).toBeUndefined();
  });

  it("treats non-canonical negative forms as ordinary keys", () => {
    expect(resolvePath(value, ["tags", "-0"])).toBeUndefined();
    expect(resolvePath(value, ["tags", "-01"])).toBeUndefined();
  });

  it("reads a literal negative key on an object as a key", () => {
    expect(resolvePath({ "-1": "kept" }, ["-1"])).toBe("kept");
  });

  it("never reaches inherited or built-in properties", () => {
    expect(resolvePath(value, ["tags", "length"])).toBeUndefined();
    expect(resolvePath(value, ["tags", "constructor"])).toBeUndefined();
    expect(resolvePath(value, ["customer", "toString"])).toBeUndefined();
    expect(resolvePath(value, ["customer", "__proto__"])).toBeUndefined();
    expect(resolvePath(value, ["items", "0", "hasOwnProperty"])).toBeUndefined();
  });

  it("returns the whole value for an empty path", () => {
    expect(resolvePath(value, [])).toBe(value);
  });
});

describe("resolveGlob", () => {
  it("substitutes a scalar", () => {
    const result = resolveGlob("${{folder_id}}", store({ folder_id: "F-123" }));
    expect(result).toEqual({ ok: true, pattern: "F-123" });
  });

  it("substitutes positionally inside a larger glob", () => {
    const result = resolveGlob("output/${{case_id}}/**", store({ case_id: "K-9" }));
    expect(result).toEqual({ ok: true, pattern: "output/K-9/**" });
  });

  it("substitutes several references in one glob", () => {
    const result = resolveGlob(
      "data/${{tenant}}/${{case_id}}.json",
      store({ tenant: "acme", case_id: "K-9" }),
    );
    expect(result).toEqual({ ok: true, pattern: "data/acme/K-9.json" });
  });

  it("substitutes through a dotted path and an array index", () => {
    const vars = store({ order: { items: [{ sku: "A-1" }, { sku: "B-2" }] } });
    expect(resolveGlob("${{order.items.0.sku}}", vars)).toEqual({ ok: true, pattern: "A-1" });
    expect(resolveGlob("${{order.items.-1.sku}}", vars)).toEqual({ ok: true, pattern: "B-2" });
  });

  it("stringifies non-string scalars", () => {
    expect(resolveGlob("${{n}}", store({ n: 42 }))).toEqual({ ok: true, pattern: "42" });
    expect(resolveGlob("${{b}}", store({ b: false }))).toEqual({ ok: true, pattern: "false" });
  });

  it("leaves a glob without references untouched", () => {
    expect(resolveGlob("output/**", store({}))).toEqual({ ok: true, pattern: "output/**" });
  });

  describe("fails closed", () => {
    it("on an unset variable", () => {
      const result = resolveGlob("${{folder_id}}", store({}));
      expect(result).toMatchObject({ ok: false, reason: "unset", reference: "${{folder_id}}" });
    });

    it("on a missing path", () => {
      const result = resolveGlob("${{order.nope}}", store({ order: { id: 1 } }));
      expect(result).toMatchObject({ ok: false, reason: "path-missing" });
    });

    it("on a non-scalar result", () => {
      const result = resolveGlob("${{order}}", store({ order: { id: 1 } }));
      expect(result).toMatchObject({ ok: false, reason: "non-scalar" });
      expect((result as { detail: string }).detail).toMatch(/non-scalar/);
    });

    it("on an array result", () => {
      expect(resolveGlob("${{tags}}", store({ tags: ["a"] }))).toMatchObject({
        ok: false,
        reason: "non-scalar",
      });
    });

    it("on a malformed reference", () => {
      expect(resolveGlob("${{}}", store({}))).toMatchObject({ ok: false, reason: "malformed" });
      expect(resolveGlob("${{ .id }}", store({}))).toMatchObject({
        ok: false,
        reason: "malformed",
      });
      expect(resolveGlob("${{a..b}}", store({ a: {} }))).toMatchObject({
        ok: false,
        reason: "malformed",
      });
    });

    it("on an invalid variable name", () => {
      expect(resolveGlob("${{From-Email}}", store({}))).toMatchObject({
        ok: false,
        reason: "invalid-name",
      });
    });

    it("on a prototype-reaching path", () => {
      expect(resolveGlob("${{tags.length}}", store({ tags: ["a", "b"] }))).toMatchObject({
        ok: false,
        reason: "path-missing",
      });
      expect(resolveGlob("${{o.constructor}}", store({ o: { a: 1 } }))).toMatchObject({
        ok: false,
        reason: "path-missing",
      });
    });

    it("never matches anything, including the literal placeholder", () => {
      const vars = store({});
      expect(matches("${{folder_id}}", vars, "${{folder_id}}")).toBe(false);
      expect(matches("${{folder_id}}", vars, "anything")).toBe(false);
      expect(matches("${{folder_id}}", vars, "")).toBe(false);
    });
  });
});

describe("substituted values are matched literally", () => {
  it("a wildcard value does not widen the guard", () => {
    const vars = store({ folder_id: "*" });
    expect(matches("${{folder_id}}", vars, "*")).toBe(true);
    expect(matches("${{folder_id}}", vars, "F-999")).toBe(false);
  });

  it("a globstar value does not widen the guard", () => {
    const vars = store({ v: "**" });
    expect(matches("output/${{v}}", vars, "output/**")).toBe(true);
    expect(matches("output/${{v}}", vars, "output/x/y")).toBe(false);
  });

  it("a brace-expansion value does not widen the guard", () => {
    const vars = store({ v: "{a,b}" });
    expect(matches("${{v}}", vars, "{a,b}")).toBe(true);
    expect(matches("${{v}}", vars, "a")).toBe(false);
    expect(matches("${{v}}", vars, "b")).toBe(false);
  });

  it("a question-mark value does not widen the guard", () => {
    const vars = store({ v: "a?c" });
    expect(matches("${{v}}", vars, "a?c")).toBe(true);
    expect(matches("${{v}}", vars, "abc")).toBe(false);
  });

  it("a character-class value does not widen the guard", () => {
    const vars = store({ v: "[abc]" });
    expect(matches("${{v}}", vars, "[abc]")).toBe(true);
    expect(matches("${{v}}", vars, "a")).toBe(false);
  });

  it("an extglob value does not widen the guard", () => {
    const vars = store({ v: "!(x)" });
    expect(matches("${{v}}", vars, "!(x)")).toBe(true);
    expect(matches("${{v}}", vars, "y")).toBe(false);
  });

  it("a traversal-shaped value only matches itself", () => {
    const vars = store({ v: "../../etc" });
    expect(matches("${{v}}", vars, "../../etc")).toBe(true);
    expect(matches("${{v}}", vars, "etc")).toBe(false);
  });

  it("matches an email value after escaping", () => {
    const vars = store({ sender: { email: "a+tag@b.co" } });
    expect(matches("${{sender.email}}", vars, "a+tag@b.co")).toBe(true);
    expect(matches("${{sender.email}}", vars, "other@b.co")).toBe(false);
  });

  it("keeps the surrounding glob's wildcards working", () => {
    const vars = store({ case_id: "K-9" });
    expect(matches("output/${{case_id}}/**", vars, "output/K-9/report.md")).toBe(true);
    expect(matches("output/${{case_id}}/**", vars, "output/K-9/a/b.md")).toBe(true);
    expect(matches("output/${{case_id}}/**", vars, "output/K-1/report.md")).toBe(false);
  });

  it("escapes each metacharacter", () => {
    expect(escapeGlobLiteral("a*b?c[d]e{f}g(h)i!j+k@l|m^n$o")).toBe(
      "a\\*b\\?c\\[d\\]e\\{f\\}g\\(h\\)i\\!j\\+k\\@l\\|m\\^n\\$o",
    );
  });
});

describe("describeGlob", () => {
  it("renders the resolved value for the model", () => {
    expect(describeGlob("${{folder_id}}", store({ folder_id: "F-123" }))).toBe("F-123");
  });

  it("renders a path reference resolved", () => {
    expect(describeGlob("${{sender.email}}", store({ sender: { email: "a@b.c" } }))).toBe("a@b.c");
  });

  it("marks an unresolved reference rather than showing a bare placeholder", () => {
    const rendered = describeGlob("${{folder_id}}", store({}));
    expect(rendered).toContain("unresolved");
    expect(rendered).toContain("folder_id");
  });
});

describe("the $${{…}} literal escape", () => {
  it("writes the braces as text without resolving", () => {
    const result = resolveText("use $${{from_email}} in a guard", store({ from_email: "a@b.c" }));
    expect(result).toEqual({ ok: true, pattern: "use ${{from_email}} in a guard" });
  });

  it("does not need the named variable to exist", () => {
    expect(resolveText("$${{never_set}}", store({}))).toEqual({
      ok: true,
      pattern: "${{never_set}}",
    });
  });

  it("coexists with a real reference in one string", () => {
    expect(resolveText("$${{x}} is ${{x}}", store({ x: 1 }))).toEqual({
      ok: true,
      pattern: "${{x}} is 1",
    });
  });

  it("is not reported as a reference", () => {
    expect(parseReferences("$${{x}}")).toEqual([]);
    expect(parseReferences("$${{x}} and ${{y}}").map((r) => r.name)).toEqual(["y"]);
  });

  it("still needs the unescaping pass, so the syntax check sees it", () => {
    expect(hasVariableReference("$${{x}}")).toBe(true);
    expect(hasVariableReference("no references here")).toBe(false);
  });

  it("leaves a lone extra dollar in front of the escape alone", () => {
    expect(resolveText("$$${{x}}", store({ x: 1 }))).toEqual({ ok: true, pattern: "$${{x}}" });
  });

  it("never re-scans a substituted value", () => {
    // A variable whose *value* looks like a reference is data, not a template.
    expect(resolveText("${{v}}", store({ v: "${{y}}" }))).toEqual({
      ok: true,
      pattern: "${{y}}",
    });
  });
});

describe("resolveArguments", () => {
  it("substitutes a whole-value reference", () => {
    expect(resolveArguments({ body: "${{order_id}}" }, store({ order_id: "ORD-1003" }))).toEqual({
      ok: true,
      args: { body: "ORD-1003" },
    });
  });

  it("substitutes a reference embedded in surrounding text, newlines intact", () => {
    const vars = store({ triggers: [{ text: "my order is late" }] });
    const result = resolveArguments(
      { body: "Refunded.\n\n--- Original email ---\n\n${{triggers.-1.text}}" },
      vars,
    );
    expect(result).toEqual({
      ok: true,
      args: { body: "Refunded.\n\n--- Original email ---\n\nmy order is late" },
    });
  });

  it("substitutes several references in one string", () => {
    const vars = store({ first_name: "Ada", order_id: "ORD-1003" });
    expect(
      resolveArguments({ body: "Hi ${{first_name}}, order ${{order_id}} is on its way." }, vars),
    ).toEqual({ ok: true, args: { body: "Hi Ada, order ORD-1003 is on its way." } });
  });

  it("substitutes inside a path argument", () => {
    expect(
      resolveArguments({ file_path: "scratchpad/${{case_id}}/answer.json" }, store({ case_id: "K-9" })),
    ).toEqual({ ok: true, args: { file_path: "scratchpad/K-9/answer.json" } });
  });

  it("renders verbatim — a value is not glob-escaped", () => {
    expect(resolveArguments({ body: "${{v}}" }, store({ v: "a+b (final)*" }))).toEqual({
      ok: true,
      args: { body: "a+b (final)*" },
    });
  });

  it("walks strings nested in arrays of objects", () => {
    expect(
      resolveArguments({ messages: [{ text: "quote: ${{note}}" }] }, store({ note: "hi" })),
    ).toEqual({ ok: true, args: { messages: [{ text: "quote: hi" }] } });
  });

  it("leaves non-string leaves as the same JSON types", () => {
    const args = { limit: 10, dry_run: false, tag: null, tags: ["a", "b"] };
    expect(resolveArguments(args, store({}))).toEqual({ ok: true, args });
  });

  it("passes a reference-free argument through byte-identically", () => {
    const args = { file_path: "scratchpad/n.md", content: "hello" };
    expect(resolveArguments(args, store({}))).toEqual({ ok: true, args });
  });

  it("preserves key order", () => {
    const result = resolveArguments({ b: "${{v}}", a: "x" }, store({ v: "1" }));
    expect(result.ok && Object.keys(result.args)).toEqual(["b", "a"]);
  });

  it("honours the escape", () => {
    expect(resolveArguments({ content: "$${{from_email}}" }, store({ from_email: "a@b.c" }))).toEqual(
      { ok: true, args: { content: "${{from_email}}" } },
    );
  });

  it("does not let a __proto__ key reach Object.prototype", () => {
    const args = JSON.parse('{"__proto__":{"polluted":true},"body":"${{v}}"}');
    const result = resolveArguments(args, store({ v: "ok" }));
    expect(result.ok).toBe(true);
    expect(result.ok && Object.hasOwn(result.args, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result.ok ? result.args : {})).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  describe("fails closed, and names what failed", () => {
    it("rejects an unset variable", () => {
      expect(resolveArguments({ body: "${{missing_var}}" }, store({}))).toMatchObject({
        ok: false,
        reason: "unset",
        reference: "${{missing_var}}",
      });
    });

    it("rejects a missing path", () => {
      expect(resolveArguments({ body: "${{order.nope}}" }, store({ order: { id: 1 } }))).toMatchObject(
        { ok: false, reason: "path-missing" },
      );
    });

    it("rejects a non-scalar result rather than interpolating [object Object]", () => {
      const result = resolveArguments({ body: "${{order}}" }, store({ order: { id: 1 } }));
      expect(result).toMatchObject({ ok: false, reason: "non-scalar" });
      expect(result.ok === false && result.detail).toContain("non-scalar");
    });

    it("rejects a malformed reference", () => {
      expect(resolveArguments({ body: "${{}}" }, store({}))).toMatchObject({
        ok: false,
        reason: "malformed",
      });
      expect(resolveArguments({ body: "${{a..b}}" }, store({}))).toMatchObject({
        ok: false,
        reason: "malformed",
      });
    });

    it("rejects an invalid variable name", () => {
      expect(resolveArguments({ body: "${{Customer}}" }, store({}))).toMatchObject({
        ok: false,
        reason: "invalid-name",
      });
    });

    it("reports the first failure and delivers nothing partial", () => {
      const result = resolveArguments(
        { body: "${{known}} then ${{unknown}}", other: "${{known}}" },
        store({ known: "k" }),
      );
      expect(result).toMatchObject({ ok: false, reference: "${{unknown}}" });
      expect(result.ok).toBe(false);
    });

    it("reports a failure found deep in the structure", () => {
      expect(
        resolveArguments({ messages: [{ text: "ok" }, { text: "${{nope}}" }] }, store({})),
      ).toMatchObject({ ok: false, reason: "unset", reference: "${{nope}}" });
    });
  });
});

describe("the reserved title variable", () => {
  describe("titleWriteError", () => {
    it("accepts a short single-line string", () => {
      expect(titleWriteError("Refund for order A-1042")).toBeUndefined();
      expect(titleWriteError("  padded  ")).toBeUndefined();
    });

    it("names the shape for a non-string", () => {
      for (const value of [42, true, null, { text: "Refund" }, ["Refund"]]) {
        const problem = titleWriteError(value);
        expect(problem, JSON.stringify(value)).toContain(TITLE_VARIABLE);
        expect(problem).toContain("single-line string");
      }
    });

    it("refuses an empty or whitespace-only value", () => {
      expect(titleWriteError("")).toContain("empty");
      expect(titleWriteError("   ")).toContain("empty");
    });

    it("refuses a value spanning more than one line", () => {
      expect(titleWriteError("Refund\nfor A-1042")).toContain("more than one line");
      expect(titleWriteError("Refund\rfor A-1042")).toContain("more than one line");
    });

    it("refuses a value over the length bound, naming the length", () => {
      const long = "x".repeat(TITLE_MAX_LENGTH + 1);
      expect(titleWriteError(long)).toContain(String(TITLE_MAX_LENGTH + 1));
      // The bound itself passes: it is a limit, not an exclusive one.
      expect(titleWriteError("x".repeat(TITLE_MAX_LENGTH))).toBeUndefined();
    });
  });

  describe("seeding", () => {
    it("stores a seeded title unlocked", () => {
      const seeded = buildSeededVariables({ title: "Inbound refund request" });
      expect(seeded.title).toEqual({ value: "Inbound refund request", locked: false });
    });

    it("still locks every other seed", () => {
      const seeded = buildSeededVariables({ title: "Inbound refund", from_email: "a@b.c" });
      expect(seeded.from_email).toEqual({ value: "a@b.c", locked: true });
      expect(seeded.title?.locked).toBe(false);
    });

    it("stores the trimmed string", () => {
      expect(buildSeededVariables({ title: "  Refund for A-1042  " }).title?.value).toBe(
        "Refund for A-1042",
      );
    });

    it("throws on an invalid seed, so a host defect fails assembly", () => {
      for (const value of [42, "", "   ", "two\nlines", "x".repeat(TITLE_MAX_LENGTH + 1)]) {
        expect(() => buildSeededVariables({ title: value }), JSON.stringify(value)).toThrow(
          InvalidTitleError,
        );
      }
      expect(() => buildSeededVariables({ title: 42 })).toThrow(/title/);
    });

    it("names where an invalid seed came from", () => {
      expect(() => buildSeededVariables({ title: 42 }, "supplied to a sub-workflow")).toThrow(
        /supplied to a sub-workflow/,
      );
    });
  });
});
