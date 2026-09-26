/**
 * A trigger's signature, typed: what each `requires`/`returns` entry declares,
 * the one mapping from a signature to JSON Schema, and the one conformance rule.
 *
 * Pure and browser-safe — it depends on nothing but the spec's types — so a host
 * builds an MCP tool schema, a start form or request validation from exactly the
 * mapping and rule the runtime enforces. Every runtime check (the turn boundary,
 * `archmax_set_variables`, the completion check, a delegation and its settle)
 * decides by {@link signatureValueIssues}; nothing else judges a value's type.
 */
import type { MachineSpec, SignatureEntryDeclaration } from "./types.js";

/**
 * The types a signature entry may declare: JSON Schema's own type words, plus its
 * two string formats `date` and `date-time`, promoted because a host renders and
 * validates them differently from free text.
 */
export const SIGNATURE_TYPES = [
  "string",
  "integer",
  "number",
  "boolean",
  "date",
  "date-time",
  "object",
  "array",
] as const;

/** One of {@link SIGNATURE_TYPES}. */
export type SignatureType = (typeof SIGNATURE_TYPES)[number];

/**
 * One signature entry, normalized: the variable's name, and optionally what kind
 * of value it holds and what it is for. An entry without `type` is untyped — any
 * value satisfies it, `null` included.
 */
export interface SignatureEntry {
  name: string;
  type?: SignatureType;
  description?: string;
}

/** A trigger's whole signature, normalized: its caller-facing `description` and both lists. */
export interface TriggerSignature {
  /** What calling this entry does, written for a caller; never disclosed to the session's own model. */
  description?: string;
  /** What a firing must supply, in declaration order; empty when undeclared. */
  requires: SignatureEntry[];
  /** What a completed session guarantees is set, in declaration order; empty when undeclared. */
  returns: SignatureEntry[];
}

/**
 * One reason a value map does not satisfy a signature: a name that is not set,
 * or a value that does not conform to its entry's type. `found` is the JSON kind
 * of what arrived; `message` is a phrase naming the variable, worded for whoever
 * has to correct it, which each site wraps in its own refusal.
 */
export type SignatureValueIssue =
  | { kind: "missing"; name: string; message: string }
  | { kind: "invalid"; name: string; type: SignatureType; found: SignatureValueKind; message: string };

/** The JSON kind of a value, as an issue reports what arrived. */
export type SignatureValueKind = "string" | "number" | "boolean" | "null" | "object" | "array";

// --- Normalizing -----------------------------------------------------------------

/**
 * A `requires`/`returns` list as `{ name, type?, description? }` entries, in
 * declaration order: a bare name and `{ name }` are the same untyped entry.
 * Total — a list the schema refused (a scalar, an entry naming nothing) yields
 * what it can read, so `validate` can read a spec whose shape failed.
 */
export function normalizeSignature(
  list: readonly (string | SignatureEntryDeclaration)[] | undefined | null,
): SignatureEntry[] {
  if (!Array.isArray(list)) return [];
  const entries: SignatureEntry[] = [];
  for (const item of list as unknown[]) {
    if (typeof item === "string") {
      entries.push({ name: item });
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const { name, type, description } = item as Record<string, unknown>;
    if (typeof name !== "string") continue;
    const entry: SignatureEntry = { name };
    if (isSignatureType(type)) entry.type = type;
    if (typeof description === "string" && description.trim() !== "") entry.description = description.trim();
    entries.push(entry);
  }
  return entries;
}

/** Whether a value is one of {@link SIGNATURE_TYPES}. */
export function isSignatureType(value: unknown): value is SignatureType {
  return typeof value === "string" && (SIGNATURE_TYPES as readonly string[]).includes(value);
}

/**
 * A trigger's normalized signature read from a parsed spec, or `undefined` when no
 * state declares the id. The same reading `WorkflowMachine.signatureForTrigger`
 * gives, for a host that holds only a spec. Two states declaring one id is a
 * document error; here the later one wins, as in `triggerBindings`.
 */
export function signatureForTrigger(spec: MachineSpec, triggerId: string): TriggerSignature | undefined {
  let found: TriggerSignature | undefined;
  for (const state of Object.values(spec.states ?? {})) {
    const triggers = state?.triggers;
    if (!triggers || !Object.hasOwn(triggers, triggerId)) continue;
    const decl = triggers[triggerId];
    const description = typeof decl?.description === "string" ? decl.description.trim() : "";
    found = {
      ...(description ? { description } : {}),
      requires: normalizeSignature(decl?.requires),
      returns: normalizeSignature(decl?.returns),
    };
  }
  return found;
}

// --- JSON Schema -------------------------------------------------------------------

/** One property of {@link signatureJsonSchema}'s output. An untyped entry has no `type`. */
export interface SignaturePropertySchema {
  type?: "string" | "integer" | "number" | "boolean" | "object" | "array";
  format?: "date" | "date-time";
  description?: string;
}

/** What {@link signatureJsonSchema} yields: a JSON Schema object over the signature's names. */
export interface SignatureJsonSchema {
  type: "object";
  properties: Record<string, SignaturePropertySchema>;
  required: string[];
}

/**
 * The one mapping from signature entries to a JSON Schema object: one property
 * per entry in declaration order, the six JSON Schema type words as themselves,
 * `date`/`date-time` as a string with that `format`, an untyped entry as `{}`,
 * and every name `required` — each `requires` entry is mandatory, and the
 * completion check guarantees each `returns` entry is set. The delegation tool's
 * input schema is built by it, so a host building an MCP tool, a form or an API
 * body from the same signature describes exactly what the runtime enforces.
 */
export function signatureJsonSchema(entries: readonly SignatureEntry[]): SignatureJsonSchema {
  const properties: Record<string, SignaturePropertySchema> = {};
  for (const entry of entries) {
    const property: SignaturePropertySchema =
      entry.type === "date" || entry.type === "date-time"
        ? { type: "string", format: entry.type }
        : entry.type
          ? { type: entry.type }
          : {};
    if (entry.description) property.description = entry.description;
    properties[entry.name] = property;
  }
  return { type: "object", properties, required: entries.map((entry) => entry.name) };
}

// --- Conformance --------------------------------------------------------------------

/**
 * The one conformance rule: one issue per entry whose name is not set in
 * `values`, and one per typed entry whose value does not conform, in declaration
 * order; an empty list when the map satisfies the signature. A name is set when
 * `values` holds it with any value but `undefined`. An untyped entry takes any
 * value, `null` included; a typed one never takes `null`. Nothing is coerced —
 * the string `"4"` is not an `integer`.
 */
export function signatureValueIssues(
  entries: readonly SignatureEntry[],
  values: Readonly<Record<string, unknown>>,
): SignatureValueIssue[] {
  const issues: SignatureValueIssue[] = [];
  for (const entry of entries) {
    const value = Object.hasOwn(values, entry.name) ? values[entry.name] : undefined;
    if (value === undefined) {
      issues.push({ kind: "missing", name: entry.name, message: `'${entry.name}' is not set` });
      continue;
    }
    if (!entry.type || conforms(entry.type, value)) continue;
    const found = valueKind(value);
    issues.push({
      kind: "invalid",
      name: entry.name,
      type: entry.type,
      found,
      message: `'${entry.name}' must be ${TYPE_PHRASES[entry.type]}, but ${arrived(found, value)} arrived`,
    });
  }
  return issues;
}

/** Whether one value conforms to one signature type. */
function conforms(type: SignatureType, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && isFullDate(value);
    case "date-time":
      return typeof value === "string" && isDateTime(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
  }
}

/** What each type means, as a refusal states it. */
const TYPE_PHRASES: Record<SignatureType, string> = {
  string: "a string",
  integer: "an integer (a number with no fractional part)",
  number: "a number",
  boolean: "a boolean (true or false)",
  date: "a date (an RFC 3339 full-date, YYYY-MM-DD, naming a real calendar day)",
  "date-time": "a date-time (an RFC 3339 date-time with an offset, e.g. 2026-03-01T09:30:00Z)",
  object: "an object",
  array: "an array",
};

function valueKind(value: unknown): SignatureValueKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const kind = typeof value;
  return kind === "string" || kind === "number" || kind === "boolean" ? kind : "object";
}

/** The arrival, worded: a short scalar is quoted so a malformed date or a fraction is visible. */
function arrived(found: SignatureValueKind, value: unknown): string {
  if (found === "null") return "null";
  const article = found === "array" || found === "object" ? "an" : "a";
  if (found === "string" && (value as string).length <= 40) return `${article} string (${JSON.stringify(value)})`;
  if (found === "number") return `${article} number (${String(value)})`;
  return `${article} ${found}`;
}

// --- RFC 3339 -----------------------------------------------------------------------
//
// Hand-written rather than `Date.parse`, which accepts implementation-specific
// strings and rolls `2026-02-30` over into March.

const FULL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

/** An RFC 3339 `full-date` naming a real calendar day. */
function isFullDate(value: string): boolean {
  const match = FULL_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** An RFC 3339 `date-time`: a real day, a valid time, and a mandatory offset. */
function isDateTime(value: string): boolean {
  const match = DATE_TIME.exec(value);
  if (!match || !isFullDate(match[1]!)) return false;
  const [hour, minute, second] = [match[2], match[3], match[4]].map(Number) as [number, number, number];
  // 60 admits a leap second, as RFC 3339 does.
  if (hour > 23 || minute > 59 || second > 60) return false;
  if (match[5] !== undefined && (Number(match[5]) > 23 || Number(match[6]) > 59)) return false;
  return true;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
