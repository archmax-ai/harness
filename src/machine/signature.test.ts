import { describe, expect, it } from "vitest";
import {
  normalizeSignature,
  SIGNATURE_TYPES,
  signatureForTrigger,
  signatureJsonSchema,
  signatureValueIssues,
  type SignatureEntry,
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
      },
      required: ["string", "integer", "number", "boolean", "date", "date_time", "object", "array"],
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
