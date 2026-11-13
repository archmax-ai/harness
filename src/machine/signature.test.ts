import { describe, expect, it } from "vitest";
import {
  normalizeSignature,
  SIGNATURE_TYPES,
  signatureForTrigger,
  signatureJsonSchema,
  signatureRulePhrases,
  signatureValueIssues,
  type SignatureEntry,
  type SignatureType,
} from "./signature.js";
import type { MachineSpec } from "./types.js";

describe("normalizeSignature", () => {
  it("reads a bare name and { name } as the same untyped entry", () => {
    expect(normalizeSignature(["order_id"])).toEqual([{ name: "order_id" }]);
    expect(normalizeSignature([{ name: "order_id" }])).toEqual([{ name: "order_id" }]);
  });

  it("keeps declaration order across mixed spellings", () => {
    expect(
      normalizeSignature([
        "order_id",
        { name: "due", type: "date", description: "The day the refund is due." },
        "note",
      ]),
    ).toEqual([
      { name: "order_id" },
      { name: "due", type: "date", description: "The day the refund is due." },
      { name: "note" },
    ]);
  });

  it("trims a description, as a block scalar leaves a trailing newline", () => {
    expect(normalizeSignature([{ name: "total", description: "Refunded amount.\n" }])).toEqual([
      { name: "total", description: "Refunded amount." },
    ]);
  });

  // `validate` reads specs whose shape failed, so a refused list reads as what it can.
  it("is total over a list the schema refused", () => {
    expect(normalizeSignature(undefined)).toEqual([]);
    expect(normalizeSignature("order_id" as never)).toEqual([]);
    expect(normalizeSignature([5, null, { type: "string" }, "ok"] as never)).toEqual([{ name: "ok" }]);
  });
});

describe("signatureJsonSchema", () => {
  it("maps every type", () => {
    const entries: SignatureEntry[] = SIGNATURE_TYPES.map((type) => ({
      name: type.replace("-", "_"),
      type,
    }));
    expect(signatureJsonSchema(entries)).toEqual({
      type: "object",
      properties: {
        string: { type: "string" },
        integer: { type: "integer" },
        number: { type: "number" },
        boolean: { type: "boolean" },
        date: { type: "string", format: "date" },
        date_time: { type: "string", format: "date-time" },
        object: { type: "object" },
        array: { type: "array" },
        file: { type: "string", format: "file" },
      },
      required: ["string", "integer", "number", "boolean", "date", "date_time", "object", "array", "file"],
    });
  });

  it("maps an untyped entry to {}, carries descriptions, and requires in declaration order", () => {
    const schema = signatureJsonSchema([
      { name: "order_id", type: "string", description: "The order." },
      { name: "due", type: "date" },
      { name: "note" },
    ]);
    expect(schema).toEqual({
      type: "object",
      properties: {
        order_id: { type: "string", description: "The order." },
        due: { type: "string", format: "date" },
        note: {},
      },
      required: ["order_id", "due", "note"],
    });
    expect(Object.keys(schema.properties)).toEqual(["order_id", "due", "note"]);
  });

  it("is an empty object schema for an empty signature", () => {
    expect(signatureJsonSchema([])).toEqual({ type: "object", properties: {}, required: [] });
  });
});

describe("signatureValueIssues", () => {
  const typed = (type: SignatureEntry["type"]): SignatureEntry[] => [{ name: "v", type }];
  const ok = (type: SignatureEntry["type"], value: unknown) =>
    expect(signatureValueIssues(typed(type), { v: value }), `${type} ← ${JSON.stringify(value)}`).toEqual([]);
  const bad = (type: SignatureEntry["type"], value: unknown) =>
    expect(signatureValueIssues(typed(type), { v: value }), `${type} ← ${JSON.stringify(value)}`).toMatchObject([
      { kind: "invalid", name: "v", type },
    ]);

  it("names every problem: one issue per missing name and per non-conforming value", () => {
    const issues = signatureValueIssues(
      [
        { name: "quantity", type: "integer" },
        { name: "due", type: "date" },
      ],
      { quantity: 2.5 },
    );
    expect(issues).toEqual([
      {
        kind: "invalid",
        name: "quantity",
        type: "integer",
        found: "number",
        message: expect.stringContaining("'quantity' must be an integer"),
      },
      { kind: "missing", name: "due", message: "'due' is not set" },
    ]);
    expect(issues[0]!.message).toContain("2.5");
  });

  it("reports nothing for a conforming map", () => {
    expect(
      signatureValueIssues(
        [{ name: "order_id" }, { name: "quantity", type: "integer" }],
        { order_id: "A-1", quantity: 3, extra: true },
      ),
    ).toEqual([]);
  });

  it("never coerces: a numeric string is not an integer", () => {
    const [issue] = signatureValueIssues(typed("integer"), { v: "4" });
    expect(issue).toMatchObject({ kind: "invalid", type: "integer", found: "string" });
    expect(issue!.message).toContain('a string ("4") arrived');
  });

  it("holds each type to its rule", () => {
    ok("string", "");
    bad("string", 4);
    ok("integer", 3);
    ok("integer", -0);
    bad("integer", 2.5);
    bad("integer", Number.POSITIVE_INFINITY);
    ok("number", 2.5);
    bad("number", Number.NaN);
    bad("number", "2.5");
    ok("boolean", false);
    bad("boolean", "yes");
    bad("boolean", 0);
    ok("object", { a: 1 });
    ok("object", {});
    bad("object", []);
    ok("array", []);
    bad("array", { 0: "a" });
  });

  it("accepts a real calendar day and refuses one that rolls over", () => {
    ok("date", "2026-02-28");
    ok("date", "2024-02-29");
    bad("date", "2026-02-30");
    bad("date", "2025-02-29");
    bad("date", "1900-02-29");
    ok("date", "2000-02-29");
    bad("date", "2026-04-31");
    bad("date", "2026-13-01");
    bad("date", "2026-1-01");
    bad("date", "2026-01-01T00:00:00Z");
    bad("date", 20260101);
  });

  it("requires an offset on a date-time", () => {
    ok("date-time", "2026-03-01T09:30:00Z");
    ok("date-time", "2026-03-01T09:30:00.125+02:00");
    ok("date-time", "2026-03-01t09:30:00z");
    ok("date-time", "2016-12-31T23:59:60Z");
    bad("date-time", "2026-03-01T09:30:00");
    bad("date-time", "2026-03-01 09:30:00Z");
    bad("date-time", "2026-02-30T09:30:00Z");
    bad("date-time", "2026-03-01T24:00:00Z");
    bad("date-time", "2026-03-01T09:30:00+24:00");
    bad("date-time", "2026-03-01");
  });

  it("takes any path from the workspace root as a file, judging its shape only", () => {
    ok("file", "scratchpad/attachments/invoice.pdf");
    ok("file", "/scratchpad/attachments/invoice.pdf");
    ok("file", "skills/billing/assets/template.pdf");
    ok("file", "report");
    ok("file", ".env");
    bad("file", "");
    bad("file", "/");
    bad("file", "scratchpad/");
    bad("file", "scratchpad//invoice.pdf");
    bad("file", "//scratchpad/invoice.pdf");
    bad("file", "scratchpad/../checkpoints/cp-1.json");
    bad("file", "./scratchpad/invoice.pdf");
    bad("file", "scratchpad\\invoice.pdf");
    bad("file", "scratchpad/in\0voice.pdf");
    bad("file", { path: "scratchpad/invoice.pdf" });
    const [issue] = signatureValueIssues(typed("file"), { v: "scratchpad/" });
    expect(issue!.message).toBe(
      "'v' must be a path to a file in the workspace (e.g. scratchpad/attachments/invoice.pdf), " +
        'but a string ("scratchpad/") arrived',
    );
  });

  it("refuses null for a typed entry and takes it for an untyped one", () => {
    expect(signatureValueIssues([{ name: "approved", type: "boolean" }], { approved: null })).toMatchObject([
      { kind: "invalid", name: "approved", found: "null", message: expect.stringContaining("null arrived") },
    ]);
    expect(signatureValueIssues([{ name: "note" }], { note: null })).toEqual([]);
  });

  it("treats an undefined value as not set", () => {
    expect(signatureValueIssues([{ name: "note" }], { note: undefined })).toEqual([
      { kind: "missing", name: "note", message: "'note' is not set" },
    ]);
  });
});

describe("signatureForTrigger", () => {
  const spec: MachineSpec = {
    states: {
      intake: {
        triggers: {
          manual: {
            description: "Refund one order and report what was refunded.",
            requires: ["order_id", { name: "due", type: "date", description: "The day the refund is due." }],
            returns: [{ name: "total", type: "number" }, "approved"],
          },
          bare: null,
        },
      },
    },
  };

  it("reads the description and both lists, normalized, in declaration order", () => {
    expect(signatureForTrigger(spec, "manual")).toEqual({
      description: "Refund one order and report what was refunded.",
      requires: [{ name: "order_id" }, { name: "due", type: "date", description: "The day the refund is due." }],
      returns: [{ name: "total", type: "number" }, { name: "approved" }],
    });
  });

  it("reads an empty signature for a trigger declaring none, and nothing for an unknown id", () => {
    expect(signatureForTrigger(spec, "bare")).toEqual({ requires: [], returns: [] });
    expect(signatureForTrigger(spec, "unknown")).toBeUndefined();
  });
});

describe("normalizeSignature with rules", () => {
  it("carries each rule its type takes, maxSize as bytes and today/now as written", () => {
    expect(
      normalizeSignature([
        { name: "order_id", type: "string", pattern: "^A-[0-9]+$", maxLength: 24, content: "text" },
        { name: "priority", type: "string", enum: ["low", "high"], format: "email" },
        { name: "quantity", type: "integer", minimum: 1, maximum: 100 },
        { name: "due", type: "date", minimum: "today" },
        { name: "starts_at", type: "date-time", maximum: "now" },
        { name: "tags", type: "array", minItems: 1, maxItems: 10 },
        { name: "invoice", type: "file", accept: [".pdf"], maxSize: "10MB" },
      ] as never),
    ).toEqual([
      { name: "order_id", type: "string", pattern: "^A-[0-9]+$", maxLength: 24, content: "text" },
      { name: "priority", type: "string", enum: ["low", "high"], format: "email" },
      { name: "quantity", type: "integer", minimum: 1, maximum: 100 },
      { name: "due", type: "date", minimum: "today" },
      { name: "starts_at", type: "date-time", maximum: "now" },
      { name: "tags", type: "array", minItems: 1, maxItems: 10 },
      { name: "invoice", type: "file", accept: [".pdf"], maxSize: 10_000_000 },
    ]);
  });

  it("reads every spelling of maxSize as bytes", () => {
    const sizes = ["10MB", "512KB", 2048, "0KB"].map(
      (maxSize) => normalizeSignature([{ name: "f", type: "file", maxSize } as never])[0]?.maxSize,
    );
    expect(sizes).toEqual([10_000_000, 512_000, 2048, 0]);
  });

  it("yields no rules for a bare name, an untyped entry, or a rule its type does not take", () => {
    expect(normalizeSignature(["note"])).toEqual([{ name: "note" }]);
    expect(normalizeSignature([{ name: "note", maxLength: 3 } as never])).toEqual([{ name: "note" }]);
    expect(normalizeSignature([{ name: "q", type: "integer", format: "email", enum: ["a"] } as never])).toEqual([
      { name: "q", type: "integer" },
    ]);
  });

  it("stays total over malformed rules, dropping what it cannot read", () => {
    expect(
      normalizeSignature([
        {
          name: "x",
          type: "string",
          format: "fax",
          pattern: 5,
          minLength: -1,
          maxLength: 2.5,
          enum: [],
          content: "rtf",
        },
        { name: "d", type: "date", minimum: "tomorrow", maximum: "2026-02-30" },
        { name: "f", type: "file", accept: "pdf", maxSize: "10 MB" },
      ] as never),
    ).toEqual([
      { name: "x", type: "string" },
      { name: "d", type: "date" },
      { name: "f", type: "file" },
    ]);
  });
});

describe("signatureValueIssues with rules", () => {
  const NOW = new Date("2026-11-01T10:00:00Z");
  /** The issues of one ruled entry against one value, with the clock pinned. */
  const check = (rules: Partial<SignatureEntry> & { type: SignatureType }, value: unknown, now = NOW) =>
    signatureValueIssues([{ name: "v", ...rules }], { v: value }, { now });
  const accepts = (rules: Partial<SignatureEntry> & { type: SignatureType }, ...values: unknown[]) => {
    for (const value of values) expect(check(rules, value), `${JSON.stringify(value)} conforms`).toEqual([]);
  };
  const refuses = (
    rules: Partial<SignatureEntry> & { type: SignatureType },
    rule: string,
    message: string,
    ...values: unknown[]
  ) => {
    for (const value of values) {
      expect(check(rules, value), `${JSON.stringify(value)} breaks ${rule}`).toEqual([
        expect.objectContaining({ kind: "invalid", name: "v", rule, message }),
      ]);
    }
  };

  it("checks format: email by the WHATWG grammar, with a TLD, no quotes and nothing trimmed", () => {
    accepts({ type: "string", format: "email" }, "ann@example.co", "ann+orders@example.co", "a.b-c@mail.example.org");
    refuses(
      { type: "string", format: "email" },
      "format",
      "'v' must be an email address",
      "ann@localhost",
      '"ann"@example.co',
      "annexample.co",
      "ann@@example.co",
      "ann@example..co",
      "ann@-example.co",
      "ann@example-.co",
      " a@b.co",
      "a@b.co ",
      "@example.co",
    );
  });

  it("checks format: url as an absolute http(s) URL without credentials or whitespace", () => {
    accepts({ type: "string", format: "url" }, "https://example.com/a?b=1", "http://example.com:8080/x#y");
    refuses(
      { type: "string", format: "url" },
      "format",
      "'v' must be an http(s) URL",
      "ftp://example.com",
      "javascript:alert(1)",
      "/relative/path",
      "example.com",
      "https://user:pw@example.com",
      "https://user@example.com",
      " https://example.com",
      "https://example.com/a b",
      "https:example.com",
      "HTTPS://example.com",
      "https://",
    );
  });

  it("checks format: phone as E.164", () => {
    accepts({ type: "string", format: "phone" }, "+4930123456", "+12", "+123456789012345");
    refuses(
      { type: "string", format: "phone" },
      "format",
      "'v' must be a phone number in international form, such as +4930123456",
      "030123456",
      "+0301234",
      "+49 30 123456",
      "+1234567890123456",
      "+1",
    );
  });

  it("checks pattern anywhere in the value, as JSON Schema does", () => {
    accepts({ type: "string", pattern: "^A-[0-9]+$" }, "A-1", "A-123456");
    refuses({ type: "string", pattern: "^A-[0-9]+$" }, "pattern", "'v' must match ^A-[0-9]+$", "B-1", "A-1x", "xA-1");
    accepts({ type: "string", pattern: "[0-9]" }, "order 7");
  });

  it("fails a hand-built entry's uncompilable pattern closed", () => {
    expect(check({ type: "string", pattern: "(?=a)" }, "a")).toEqual([
      expect.objectContaining({ rule: "pattern", message: expect.stringContaining("which does not compile") }),
    ]);
  });

  it("checks enum exactly and case-sensitively", () => {
    accepts({ type: "string", enum: ["low", "normal", "high"] }, "low", "high");
    refuses(
      { type: "string", enum: ["low", "normal", "high"] },
      "enum",
      "'v' must be one of low, normal, high",
      "High",
      " low",
      "",
    );
  });

  it("counts lengths in code points, at, just inside and just outside each bound", () => {
    accepts({ type: "string", minLength: 2, maxLength: 3 }, "ab", "abc", "😀😀", "😀😀😀");
    refuses({ type: "string", minLength: 2 }, "minLength", "'v' must be at least 2 characters", "a", "😀", "");
    refuses({ type: "string", maxLength: 3 }, "maxLength", "'v' must be at most 3 characters", "abcd", "😀😀😀😀");
    refuses({ type: "string", maxLength: 1 }, "maxLength", "'v' must be at most 1 character", "ab");
  });

  it("checks numeric bounds inclusively", () => {
    accepts({ type: "integer", minimum: 1, maximum: 100 }, 1, 2, 99, 100);
    refuses({ type: "integer", minimum: 1, maximum: 100 }, "minimum", "'v' must be at least 1", 0, -5);
    refuses({ type: "integer", minimum: 1, maximum: 100 }, "maximum", "'v' must be at most 100", 101);
    accepts({ type: "number", minimum: 0.5 }, 0.5, 0.51);
    refuses({ type: "number", minimum: 0.5 }, "minimum", "'v' must be at least 0.5", 0.49);
  });

  it("checks literal date bounds inclusively", () => {
    accepts({ type: "date", minimum: "2026-11-01", maximum: "2026-11-30" }, "2026-11-01", "2026-11-30");
    refuses({ type: "date", minimum: "2026-11-01" }, "minimum", "'v' must not be before 2026-11-01", "2026-10-31");
    refuses({ type: "date", maximum: "2026-11-30" }, "maximum", "'v' must not be after 2026-11-30", "2026-12-01");
  });

  it("reads today as the clock's UTC date, around a UTC midnight", () => {
    // 00:30 in Berlin on 1 November is still 31 October in UTC.
    const lateEvening = new Date("2026-11-01T00:30:00+02:00");
    expect(check({ type: "date", minimum: "today" }, "2026-10-31", lateEvening)).toEqual([]);
    expect(check({ type: "date", minimum: "today" }, "2026-10-30", lateEvening)).toEqual([
      expect.objectContaining({ rule: "minimum", message: "'v' must not be before today" }),
    ]);
    const justAfterMidnight = new Date("2026-11-01T00:00:00Z");
    expect(check({ type: "date", minimum: "today" }, "2026-10-31", justAfterMidnight)).toMatchObject([
      { rule: "minimum" },
    ]);
    expect(check({ type: "date", maximum: "today" }, "2026-11-02", justAfterMidnight)).toEqual([
      expect.objectContaining({ rule: "maximum", message: "'v' must not be after today" }),
    ]);
  });

  it("reads now as the clock's instant and applies offsets", () => {
    refuses(
      { type: "date-time", minimum: "now" },
      "minimum",
      "'v' must not be before now",
      "2026-11-01T11:30:00+02:00",
      "2026-11-01T09:59:59.999Z",
    );
    accepts({ type: "date-time", minimum: "now" }, "2026-11-01T10:00:00Z", "2026-11-01T12:00:00+02:00");
    refuses(
      { type: "date-time", maximum: "2026-11-01T09:00:00Z" },
      "maximum",
      "'v' must not be after 2026-11-01T09:00:00Z",
      "2026-11-01T10:00:00.5+01:00",
    );
    accepts({ type: "date-time", maximum: "2026-11-01T09:00:00Z" }, "2026-11-01T10:00:00+01:00");
  });

  it("defaults the clock to the current time", () => {
    expect(signatureValueIssues([{ name: "v", type: "date", minimum: "today" }], { v: "2000-01-01" })).toMatchObject([
      { rule: "minimum" },
    ]);
    expect(signatureValueIssues([{ name: "v", type: "date", minimum: "today" }], { v: "9999-12-31" })).toEqual([]);
  });

  it("checks item counts", () => {
    accepts({ type: "array", minItems: 1, maxItems: 2 }, ["a"], ["a", "b"]);
    refuses({ type: "array", minItems: 1 }, "minItems", "'v' must hold at least 1 entry", []);
    refuses({ type: "array", maxItems: 2 }, "maxItems", "'v' must hold at most 2 entries", [1, 2, 3]);
  });

  it("checks accept by the path's last extension, case-insensitively", () => {
    accepts({ type: "file", accept: [".pdf"] }, "scratchpad/attachments/Invoice.PDF", "a/b.c.pdf");
    refuses(
      { type: "file", accept: [".pdf"] },
      "accept",
      "'v' must be a .pdf file",
      "scratchpad/attachments/invoice.png",
      "scratchpad/invoice",
      "scratchpad/.pdf",
      "scratchpad/invoice.pdf.png",
    );
    refuses({ type: "file", accept: [".pdf", ".png", ".jpg"] }, "accept", "'v' must be a .pdf, .png or .jpg file", "a.gif");
  });

  it("reports a mistyped value's type and no rule", () => {
    const [issue, ...rest] = check({ type: "integer", minimum: 1 }, "0");
    expect(rest).toEqual([]);
    expect(issue).not.toHaveProperty("rule");
    expect(issue?.message).toBe(`'v' must be an integer (a number with no fractional part), but a string ("0") arrived`);
  });

  it("reports one issue per entry: the first rule broken, in the documented order", () => {
    // format before enum before length
    expect(check({ type: "string", format: "email", enum: ["x"], maxLength: 1 }, "nope")).toMatchObject([
      { rule: "format" },
    ]);
    // pattern before length
    expect(check({ type: "string", pattern: "^A-[0-9]+$", maxLength: 4 }, "B-12345")).toEqual([
      expect.objectContaining({ rule: "pattern", message: "'v' must match ^A-[0-9]+$" }),
    ]);
    // enum before length
    expect(check({ type: "string", enum: ["abc"], minLength: 5 }, "abd")).toMatchObject([{ rule: "enum" }]);
    // minimum before maximum on one value is moot; minItems before maxItems likewise
    expect(check({ type: "string", minLength: 5, maxLength: 10 }, "abc")).toMatchObject([{ rule: "minLength" }]);
  });

  it("does not check content", () => {
    accepts({ type: "string", content: "markdown" }, "<script>alert(1)</script>");
    accepts({ type: "string", content: "text" }, "**bold**");
  });

  it("keeps the 1.0.0 behaviour and wording for entries without rules", () => {
    const issues = signatureValueIssues(
      [
        { name: "quantity", type: "integer" },
        { name: "due", type: "date" },
        { name: "note" },
      ],
      { quantity: 2.5, note: null },
    );
    expect(issues).toEqual([
      {
        kind: "invalid",
        name: "quantity",
        type: "integer",
        found: "number",
        message: "'quantity' must be an integer (a number with no fractional part), but a number (2.5) arrived",
      },
      { kind: "missing", name: "due", message: "'due' is not set" },
    ]);
  });
});

describe("rule checks run in linear time", () => {
  const MB = 1_000_000;
  const timed = (run: () => unknown) => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };

  it("matches (a+)+$ against a long run of a's ended by ! in milliseconds", () => {
    const value = `${"a".repeat(8000)}!`;
    const elapsed = timed(() =>
      expect(signatureValueIssues([{ name: "v", type: "string", pattern: "(a+)+$" }], { v: value })).toMatchObject([
        { rule: "pattern" },
      ]),
    );
    expect(elapsed).toBeLessThan(1000);
  });

  it("checks a 1 MB value against each string rule in bounded time", () => {
    const big = "a".repeat(MB);
    for (const rules of [
      { format: "email" as const },
      { format: "url" as const },
      { format: "phone" as const },
      { maxLength: 10 },
      { minLength: MB + 1 },
      { pattern: "^(a|aa)+$" },
    ]) {
      const elapsed = timed(() => signatureValueIssues([{ name: "v", type: "string", ...rules }], { v: big }));
      expect(elapsed, JSON.stringify(rules)).toBeLessThan(2000);
    }
    const email = `${"a".repeat(MB)}@${"b.".repeat(MB / 4)}co`;
    expect(timed(() => signatureValueIssues([{ name: "v", type: "string", format: "email" }], { v: email }))).toBeLessThan(
      2000,
    );
  });
});

describe("signatureJsonSchema with rules", () => {
  const property = (entry: Omit<SignatureEntry, "name">) =>
    signatureJsonSchema([{ name: "v", ...entry }]).properties.v;

  it("maps each rule JSON Schema can express", () => {
    expect(property({ type: "string", format: "email" })).toEqual({ type: "string", format: "email" });
    expect(property({ type: "string", format: "url" })).toEqual({
      type: "string",
      format: "uri",
      pattern: "^https?://",
    });
    expect(property({ type: "string", format: "phone" })).toEqual({
      type: "string",
      pattern: "^\\+[1-9][0-9]{1,14}$",
    });
    expect(property({ type: "string", pattern: "^A-[0-9]+$", minLength: 3, maxLength: 24 })).toEqual({
      type: "string",
      pattern: "^A-[0-9]+$",
      minLength: 3,
      maxLength: 24,
    });
    expect(property({ type: "string", enum: ["low", "high"] })).toEqual({ type: "string", enum: ["low", "high"] });
    expect(property({ type: "string", content: "text" })).toEqual({ type: "string", contentMediaType: "text/plain" });
    expect(property({ type: "string", content: "markdown" })).toEqual({
      type: "string",
      contentMediaType: "text/markdown",
    });
    expect(property({ type: "string", content: "html" })).toEqual({ type: "string", contentMediaType: "text/html" });
    expect(property({ type: "integer", minimum: 1, maximum: 100 })).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 100,
    });
    expect(property({ type: "number", minimum: 0.5 })).toEqual({ type: "number", minimum: 0.5 });
    expect(property({ type: "array", minItems: 1, maxItems: 10 })).toEqual({
      type: "array",
      minItems: 1,
      maxItems: 10,
    });
  });

  it("leaves out date bounds, accept and maxSize", () => {
    expect(property({ type: "date", minimum: "today", maximum: "2027-01-01" })).toEqual({
      type: "string",
      format: "date",
    });
    expect(property({ type: "date-time", minimum: "now" })).toEqual({ type: "string", format: "date-time" });
    expect(property({ type: "file", accept: [".pdf"], maxSize: 10_000_000 })).toEqual({
      type: "string",
      format: "file",
    });
  });

  it("keeps the description last and the property otherwise unchanged", () => {
    expect(property({ type: "string", format: "email", description: "Where to write." })).toEqual({
      type: "string",
      format: "email",
      description: "Where to write.",
    });
  });
});

describe("signatureRulePhrases", () => {
  it("phrases each rule as the prompt lists it", () => {
    expect(signatureRulePhrases({ name: "c", type: "string", format: "email", maxLength: 80 })).toEqual([
      "an email address",
      "at most 80 characters",
    ]);
    expect(signatureRulePhrases({ name: "o", type: "string", pattern: "^A-[0-9]+$", enum: ["A-1"] })).toEqual([
      "matching ^A-[0-9]+$",
      "one of A-1",
    ]);
    expect(signatureRulePhrases({ name: "n", type: "string", content: "markdown" })).toEqual(["Markdown"]);
    expect(signatureRulePhrases({ name: "q", type: "integer", minimum: 1, maximum: 100 })).toEqual([
      "at least 1",
      "at most 100",
    ]);
    expect(signatureRulePhrases({ name: "d", type: "date", minimum: "today" })).toEqual(["not before today"]);
    expect(signatureRulePhrases({ name: "t", type: "array", minItems: 1 })).toEqual(["at least 1 entry"]);
    expect(signatureRulePhrases({ name: "f", type: "file", accept: [".pdf"], maxSize: 10_000_000 })).toEqual([
      "a .pdf file",
      "at most 10 MB",
    ]);
  });

  it("is empty for an entry without rules", () => {
    expect(signatureRulePhrases({ name: "d", type: "date" })).toEqual([]);
    expect(signatureRulePhrases({ name: "n" })).toEqual([]);
  });
});
