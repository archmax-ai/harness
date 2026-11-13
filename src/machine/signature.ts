/**
 * A trigger's signature, typed: what each `requires`/`returns` entry declares
 * (its type and the rules its value must also meet), the one mapping from a
 * signature to JSON Schema, and the one conformance rule.
 *
 * Pure and browser-safe — it depends on nothing but the spec's types and the
 * linear-time pattern engine — so a host builds an MCP tool schema, a start
 * form or request validation from exactly the mapping and rule the runtime
 * enforces. Every runtime check (the turn boundary, `archmax_set_variables`, the
 * completion check, a delegation and its settle) decides by
 * {@link signatureValueIssues}; nothing else judges a value's type or rules.
 */
import { compilePattern } from "./signature-pattern.js";
import type { MachineSpec, SignatureEntryDeclaration } from "./types.js";

/**
 * The types a signature entry may declare: JSON Schema's own type words, plus its
 * two string formats `date` and `date-time`, promoted because a host renders and
 * validates them differently from free text, and `file`: a workspace path naming
 * a file, which a host renders as a file picker and the runtime copies across a
 * sub-workflow boundary.
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
  "file",
] as const;

/** One of {@link SIGNATURE_TYPES}. */
export type SignatureType = (typeof SIGNATURE_TYPES)[number];

/** The formats a `string` entry's `format` rule names. */
export const SIGNATURE_FORMATS = ["email", "url", "phone"] as const;

/** One of {@link SIGNATURE_FORMATS}. */
export type SignatureFormat = (typeof SIGNATURE_FORMATS)[number];

/**
 * The kinds of text a `string` entry's `content` rule declares. A declaration
 * only: carried and mapped, never checked — what a kind permits is a host's call.
 */
export const SIGNATURE_CONTENTS = ["text", "markdown", "html"] as const;

/** One of {@link SIGNATURE_CONTENTS}. */
export type SignatureContent = (typeof SIGNATURE_CONTENTS)[number];

/**
 * The rules an entry declares on its value beyond its type, each spelled as the
 * JSON Schema keyword it maps to where one exists, and each only on the types
 * {@link RULE_TYPES} allows.
 */
export interface SignatureRules {
  /** `string`: an email address, an http(s) URL, or an E.164 phone number. */
  format?: SignatureFormat;
  /** `string`: a regular expression (RE2 syntax) found anywhere in the value. */
  pattern?: string;
  /** `string`: the fewest code points. */
  minLength?: number;
  /** `string`: the most code points. */
  maxLength?: number;
  /** `string`: the values allowed, compared exactly. */
  enum?: string[];
  /** `string`: what kind of text the value holds. Declared, not checked. */
  content?: SignatureContent;
  /** `integer`/`number`: a number; `date`: `YYYY-MM-DD` or `today`; `date-time`: an RFC 3339 instant or `now`. Inclusive. */
  minimum?: number | string;
  /** As {@link SignatureRules.minimum}, from above. */
  maximum?: number | string;
  /** `array`: the fewest entries. */
  minItems?: number;
  /** `array`: the most entries. */
  maxItems?: number;
  /** `file`: the extensions allowed, each with its leading `.`, compared case-insensitively. */
  accept?: string[];
  /** `file`: the largest file, in bytes. Checked where a `file` value crosses a boundary. */
  maxSize?: number;
}

/** Which rule an issue is about. */
export type SignatureRuleName = keyof SignatureRules;

/** The types each rule applies to. A rule on any other type, or on an untyped entry, is a load error. */
export const RULE_TYPES: Readonly<Record<SignatureRuleName, readonly SignatureType[]>> = {
  format: ["string"],
  pattern: ["string"],
  minLength: ["string"],
  maxLength: ["string"],
  enum: ["string"],
  content: ["string"],
  minimum: ["integer", "number", "date", "date-time"],
  maximum: ["integer", "number", "date", "date-time"],
  minItems: ["array"],
  maxItems: ["array"],
  accept: ["file"],
  maxSize: ["file"],
};

/** Every rule name, in the order an entry's rules are read and listed. */
export const SIGNATURE_RULE_NAMES = Object.keys(RULE_TYPES) as SignatureRuleName[];

/**
 * One signature entry, normalized: the variable's name, and optionally what kind
 * of value it holds, the rules that value must meet, and what it is for. An
 * entry without `type` is untyped — any value satisfies it, `null` included —
 * and declares no rules.
 */
export interface SignatureEntry extends SignatureRules {
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
 * or a value that does not conform to its entry's type or breaks one of its
 * rules (`rule` names which). `found` is the JSON kind of what arrived;
 * `message` is a phrase naming the variable, worded for whoever has to correct
 * it, which each site wraps in its own refusal.
 */
export type SignatureValueIssue =
  | { kind: "missing"; name: string; message: string }
  | {
      kind: "invalid";
      name: string;
      type: SignatureType;
      found: SignatureValueKind;
      rule?: SignatureRuleName;
      message: string;
    };

/** How {@link signatureValueIssues} reads its clock. */
export interface SignatureValueOptions {
  /** The instant `now` is, and whose UTC date `today` is; the current time when omitted. */
  now?: Date;
}

/** The JSON kind of a value, as an issue reports what arrived. */
export type SignatureValueKind = "string" | "number" | "boolean" | "null" | "object" | "array";

// --- Normalizing -----------------------------------------------------------------

/**
 * A `requires`/`returns` list as `{ name, type?, description?, …rules }`
 * entries, in declaration order: a bare name and `{ name }` are the same
 * untyped entry. A rule is carried as written, except `maxSize`, read as bytes;
 * `today` and `now` stay symbolic. Total — a list the schema refused (a scalar,
 * an entry naming nothing, a rule its type does not take) yields what it can
 * read, so `validate` can read a spec whose shape failed.
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
    if (entry.type) Object.assign(entry, readRules(item as Record<string, unknown>, entry.type));
    entries.push(entry);
  }
  return entries;
}

/** Whether a value is one of {@link SIGNATURE_TYPES}. */
export function isSignatureType(value: unknown): value is SignatureType {
  return typeof value === "string" && (SIGNATURE_TYPES as readonly string[]).includes(value);
}

/** The rules of a declaration its type takes, each read only when it is well-shaped. */
function readRules(decl: Record<string, unknown>, type: SignatureType): SignatureRules {
  const rules: Record<string, unknown> = {};
  for (const rule of SIGNATURE_RULE_NAMES) {
    if (!Object.hasOwn(decl, rule) || !RULE_TYPES[rule].includes(type)) continue;
    const value = ruleValue(rule, type, decl[rule]);
    if (value !== undefined) rules[rule] = value;
  }
  return rules as SignatureRules;
}

/** One rule's value as a normalized entry holds it, or `undefined` when it is malformed. */
function ruleValue(rule: SignatureRuleName, type: SignatureType, value: unknown): unknown {
  switch (rule) {
    case "format":
      return (SIGNATURE_FORMATS as readonly unknown[]).includes(value) ? value : undefined;
    case "content":
      return (SIGNATURE_CONTENTS as readonly unknown[]).includes(value) ? value : undefined;
    case "pattern":
      return typeof value === "string" ? value : undefined;
    case "minLength":
    case "maxLength":
    case "minItems":
    case "maxItems":
      return isCount(value) ? value : undefined;
    case "enum":
    case "accept":
      return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")
        ? [...value]
        : undefined;
    case "minimum":
    case "maximum":
      return isBound(type, value) ? value : undefined;
    case "maxSize":
      return parseSize(value);
  }
}

/** A length or count: a non-negative integer. */
export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Whether `value` is a well-formed `minimum`/`maximum` for `type`: a finite
 * number for `integer`/`number`, a real `YYYY-MM-DD` or `today` for `date`, an
 * RFC 3339 date-time or `now` for `date-time`.
 */
export function isBound(type: SignatureType, value: unknown): value is number | string {
  switch (type) {
    case "integer":
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "date":
      return value === "today" || (typeof value === "string" && isFullDate(value));
    case "date-time":
      return value === "now" || (typeof value === "string" && isDateTime(value));
    default:
      return false;
  }
}

/**
 * Whether a `minimum` and a `maximum` for `type` leave room for a value: `true`
 * unless both are literal and the minimum is above the maximum. `today` and
 * `now` move, so a bound naming one is never out of order here.
 */
export function boundsInOrder(type: SignatureType, minimum: unknown, maximum: unknown): boolean {
  if (!isBound(type, minimum) || !isBound(type, maximum)) return true;
  if (typeof minimum === "number" && typeof maximum === "number") return minimum <= maximum;
  if (minimum === "today" || minimum === "now" || maximum === "today" || maximum === "now") return true;
  if (type === "date") return minimum <= maximum;
  return instantOf(minimum as string) <= instantOf(maximum as string);
}

const SIZE = /^(\d{1,15})(KB|MB)$/;

/**
 * A `maxSize` in bytes: a non-negative integer as itself, `<n>KB` as n × 1,000,
 * `<n>MB` as n × 1,000,000; `undefined` for anything else.
 */
export function parseSize(value: unknown): number | undefined {
  if (isCount(value)) return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = SIZE.exec(value);
  if (!match) return undefined;
  const bytes = Number(match[1]) * (match[2] === "KB" ? 1_000 : 1_000_000);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
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

/**
 * One property of {@link signatureJsonSchema}'s output. An untyped entry has no
 * `type`; a rule JSON Schema can express adds its keyword.
 */
export interface SignaturePropertySchema {
  type?: "string" | "integer" | "number" | "boolean" | "object" | "array";
  format?: "date" | "date-time" | "file" | "email" | "uri";
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  contentMediaType?: "text/plain" | "text/markdown" | "text/html";
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
 * `date`/`date-time`/`file` as a string with that `format`, an untyped entry as `{}`,
 * each rule JSON Schema can express as its keyword, and every name `required` —
 * each `requires` entry is mandatory, and the completion check guarantees each
 * `returns` entry is set. The delegation tool's input schema is built by it, so
 * a host building an MCP tool, a form or an API body from the same signature
 * describes what the runtime enforces. Date bounds, `accept` and `maxSize` have
 * no JSON Schema keyword and are left out; the runtime still enforces them.
 */
export function signatureJsonSchema(entries: readonly SignatureEntry[]): SignatureJsonSchema {
  const properties: Record<string, SignaturePropertySchema> = {};
  for (const entry of entries) {
    const property: SignaturePropertySchema =
      entry.type === "date" || entry.type === "date-time" || entry.type === "file"
        ? { type: "string", format: entry.type }
        : entry.type
          ? { type: entry.type }
          : {};
    if (entry.type) Object.assign(property, ruleKeywords(entry, entry.type));
    if (entry.description) property.description = entry.description;
    properties[entry.name] = property;
  }
  return { type: "object", properties, required: entries.map((entry) => entry.name) };
}

/** The E.164 grammar, as the `phone` format's check and its mapped `pattern` both spell it. */
const E164 = "^\\+[1-9][0-9]{1,14}$";

const CONTENT_MEDIA_TYPES: Record<SignatureContent, NonNullable<SignaturePropertySchema["contentMediaType"]>> = {
  text: "text/plain",
  markdown: "text/markdown",
  html: "text/html",
};

/** The JSON Schema keywords an entry's rules map to, for the rules its type takes. */
function ruleKeywords(entry: SignatureEntry, type: SignatureType): SignaturePropertySchema {
  const out: SignaturePropertySchema = {};
  if (type === "string") {
    if (entry.format === "email") out.format = "email";
    if (entry.format === "url") Object.assign(out, { format: "uri", pattern: "^https?://" });
    if (entry.format === "phone") out.pattern = E164;
    if (entry.pattern !== undefined) out.pattern = entry.pattern;
    if (entry.minLength !== undefined) out.minLength = entry.minLength;
    if (entry.maxLength !== undefined) out.maxLength = entry.maxLength;
    if (entry.enum !== undefined) out.enum = [...entry.enum];
    if (entry.content !== undefined) out.contentMediaType = CONTENT_MEDIA_TYPES[entry.content];
  }
  if (type === "integer" || type === "number") {
    if (typeof entry.minimum === "number") out.minimum = entry.minimum;
    if (typeof entry.maximum === "number") out.maximum = entry.maximum;
  }
  if (type === "array") {
    if (entry.minItems !== undefined) out.minItems = entry.minItems;
    if (entry.maxItems !== undefined) out.maxItems = entry.maxItems;
  }
  return out;
}

// --- Conformance --------------------------------------------------------------------

/**
 * The one conformance rule: one issue per entry whose name is not set in
 * `values`, and one per typed entry whose value does not conform to its type
 * or, conforming, breaks one of its rules, in declaration order; an empty list
 * when the map satisfies the signature. A name is set when `values` holds it
 * with any value but `undefined`. An untyped entry takes any value, `null`
 * included; a typed one never takes `null`. Nothing is coerced or trimmed —
 * the string `"4"` is not an `integer`, and `" a@b.co"` is not an email address.
 *
 * Rules are checked only on a value of the right type, and an entry reports
 * only the first rule it breaks, in this order: `format`/`pattern`, `enum`,
 * `minLength`/`maxLength`, `minimum`/`maximum`, `minItems`/`maxItems`,
 * `accept`. `today` and `now` read `options.now`, the current time by default.
 * Every check is synchronous and linear in the value's length; an authored
 * `pattern` runs in RE2, never in `RegExp`. A `file` value is judged by its
 * path alone: whether a file is there, whether the session may read it and
 * how large it is, is the runtime's check where the value crosses a boundary.
 */
export function signatureValueIssues(
  entries: readonly SignatureEntry[],
  values: Readonly<Record<string, unknown>>,
  options?: SignatureValueOptions,
): SignatureValueIssue[] {
  const issues: SignatureValueIssue[] = [];
  const clock = lazyClock(options?.now);
  for (const entry of entries) {
    const value = Object.hasOwn(values, entry.name) ? values[entry.name] : undefined;
    if (value === undefined) {
      issues.push({ kind: "missing", name: entry.name, message: `'${entry.name}' is not set` });
      continue;
    }
    if (!entry.type) continue;
    const found = valueKind(value);
    if (!conforms(entry.type, value)) {
      issues.push({
        kind: "invalid",
        name: entry.name,
        type: entry.type,
        found,
        message: `'${entry.name}' must be ${TYPE_PHRASES[entry.type]}, but ${arrived(found, value)} arrived`,
      });
      continue;
    }
    const broken = brokenRule(entry, entry.type, value, clock);
    if (broken) {
      issues.push({
        kind: "invalid",
        name: entry.name,
        type: entry.type,
        found,
        rule: broken.rule,
        message: `'${entry.name}' must ${broken.must}`,
      });
    }
  }
  return issues;
}

// --- Rules ---------------------------------------------------------------------------

/** A rule an entry's value breaks, and what it must do instead, as a refusal words it after "'name' must ". */
interface BrokenRule {
  rule: SignatureRuleName;
  must: string;
}

/** The check's clock, read at most once and only when a date bound needs it. */
function lazyClock(now: Date | undefined): () => Date {
  let at = now;
  return () => (at ??= new Date());
}

/**
 * The first rule a value of the entry's type breaks, in the documented order,
 * or `undefined` when it breaks none. Only the rules the type takes are read.
 */
function brokenRule(
  entry: SignatureEntry,
  type: SignatureType,
  value: unknown,
  clock: () => Date,
): BrokenRule | undefined {
  const broken = (rule: SignatureRuleName): BrokenRule => ({ rule, must: ruleWording(entry, type, rule)!.must });
  switch (type) {
    case "string": {
      const text = value as string;
      if (entry.format && !FORMAT_CHECKS[entry.format](text)) return broken("format");
      if (entry.pattern !== undefined) {
        const compiled = compilePattern(entry.pattern);
        // A host-built entry can skip the parse; its pattern still fails closed.
        if (!compiled.ok) {
          return { rule: "pattern", must: `match ${entry.pattern}, which does not compile: ${compiled.error}` };
        }
        if (!compiled.test(text)) return broken("pattern");
      }
      if (entry.enum && !entry.enum.includes(text)) return broken("enum");
      if (entry.minLength !== undefined || entry.maxLength !== undefined) {
        const length = codePointsUpTo(text, Math.max(entry.minLength ?? 0, (entry.maxLength ?? -1) + 1));
        if (entry.minLength !== undefined && length < entry.minLength) return broken("minLength");
        if (entry.maxLength !== undefined && length > entry.maxLength) return broken("maxLength");
      }
      return undefined;
    }
    case "integer":
    case "number": {
      const number = value as number;
      if (typeof entry.minimum === "number" && number < entry.minimum) return broken("minimum");
      if (typeof entry.maximum === "number" && number > entry.maximum) return broken("maximum");
      return undefined;
    }
    case "date": {
      const day = value as string;
      const bound = (b: number | string) => (b === "today" ? clock().toISOString().slice(0, 10) : (b as string));
      if (isBound(type, entry.minimum) && day < bound(entry.minimum)) return broken("minimum");
      if (isBound(type, entry.maximum) && day > bound(entry.maximum)) return broken("maximum");
      return undefined;
    }
    case "date-time": {
      const at = instantOf(value as string);
      const bound = (b: number | string) => (b === "now" ? clock().getTime() : instantOf(b as string));
      if (isBound(type, entry.minimum) && at < bound(entry.minimum)) return broken("minimum");
      if (isBound(type, entry.maximum) && at > bound(entry.maximum)) return broken("maximum");
      return undefined;
    }
    case "array": {
      const length = (value as unknown[]).length;
      if (entry.minItems !== undefined && length < entry.minItems) return broken("minItems");
      if (entry.maxItems !== undefined && length > entry.maxItems) return broken("maxItems");
      return undefined;
    }
    case "file": {
      const extension = lastExtension(value as string);
      if (entry.accept && !entry.accept.some((accepted) => accepted.toLowerCase() === extension)) {
        return broken("accept");
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * How one declared rule reads: `must`, what a refusal says the value must do
 * (after "'name' must "), and `phrase`, the same rule as the prompt lists it
 * beside the entry's type. `undefined` when the entry declares no such rule
 * its type takes.
 */
function ruleWording(
  entry: SignatureEntry,
  type: SignatureType,
  rule: SignatureRuleName,
): { must: string; phrase: string } | undefined {
  if (entry[rule] === undefined || !RULE_TYPES[rule].includes(type)) return undefined;
  const be = (phrase: string) => ({ must: `be ${phrase}`, phrase });
  const dated = type === "date" || type === "date-time";
  switch (rule) {
    case "format":
      return be(FORMAT_PHRASES[entry.format!]);
    case "pattern":
      return { must: `match ${entry.pattern}`, phrase: `matching ${entry.pattern}` };
    case "enum":
      return be(`one of ${entry.enum!.join(", ")}`);
    case "minLength":
      return be(`at least ${counted(entry.minLength!, "character", "characters")}`);
    case "maxLength":
      return be(`at most ${counted(entry.maxLength!, "character", "characters")}`);
    case "content":
      return be(CONTENT_PHRASES[entry.content!]);
    case "minimum":
      return dated
        ? { must: `not be before ${entry.minimum}`, phrase: `not before ${entry.minimum}` }
        : be(`at least ${entry.minimum}`);
    case "maximum":
      return dated
        ? { must: `not be after ${entry.maximum}`, phrase: `not after ${entry.maximum}` }
        : be(`at most ${entry.maximum}`);
    case "minItems": {
      const phrase = `at least ${counted(entry.minItems!, "entry", "entries")}`;
      return { must: `hold ${phrase}`, phrase };
    }
    case "maxItems": {
      const phrase = `at most ${counted(entry.maxItems!, "entry", "entries")}`;
      return { must: `hold ${phrase}`, phrase };
    }
    case "accept":
      return be(`a ${oneOf(entry.accept!)} file`);
    case "maxSize":
      return be(`at most ${formatSize(entry.maxSize!)}`);
  }
}

/**
 * The rules an entry declares, as short phrases in declaration-table order
 * (`an email address`, `at most 80 characters`, `not before today`): what the
 * prompt lists beside the entry's type, in the words a refusal of each uses.
 */
export function signatureRulePhrases(entry: SignatureEntry): string[] {
  if (!entry.type) return [];
  const type = entry.type;
  return SIGNATURE_RULE_NAMES.flatMap((rule) => ruleWording(entry, type, rule)?.phrase ?? []);
}

/** What each format means, as a refusal and the prompt state it. */
const FORMAT_PHRASES: Record<SignatureFormat, string> = {
  email: "an email address",
  url: "an http(s) URL",
  phone: "a phone number in international form, such as +4930123456",
};

/** What each declared kind of text reads as in the prompt. */
const CONTENT_PHRASES: Record<SignatureContent, string> = {
  text: "plain text",
  markdown: "Markdown",
  html: "HTML",
};

const FORMAT_CHECKS: Record<SignatureFormat, (value: string) => boolean> = {
  email: isEmailAddress,
  url: isHttpUrl,
  phone: (value) => value.length <= 16 && PHONE.test(value),
};

const PHONE = new RegExp(E164);

/** WHATWG's `atext` and `.`: the characters a local part may hold. */
const LOCAL_PART = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_LABEL = /^[A-Za-z0-9-]{1,63}$/;

/**
 * The WHATWG "valid email address" grammar, the one `<input type=email>` uses,
 * by hand so it is plainly linear: one `@`, a local part of `atext` and `.`, and
 * a domain of labels of 1–63 letters, digits and `-`, none starting or ending
 * with `-` — with at least two labels, so an address with no TLD
 * (`ann@localhost`) is refused. No quoted local part, no address literal.
 */
function isEmailAddress(value: string): boolean {
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  if (!LOCAL_PART.test(value.slice(0, at))) return false;
  const labels = value.slice(at + 1).split(".");
  return (
    labels.length >= 2 &&
    labels.every((label) => DOMAIN_LABEL.test(label) && !label.startsWith("-") && !label.endsWith("-"))
  );
}

/**
 * An absolute http(s) URL with no credentials, written as such: the scheme in
 * lower case followed by `//` (the mapped schema's `^https?://` agrees), and no
 * space or control character anywhere — the WHATWG parser would strip or
 * encode those, and nothing is trimmed here.
 */
function isHttpUrl(value: string): boolean {
  if (!value.startsWith("http://") && !value.startsWith("https://")) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
}

/** The code points in `text`, counted no further than one past `limit`. */
function codePointsUpTo(text: string, limit: number): number {
  let count = 0;
  for (const _ of text) if (++count > limit) break;
  return count;
}

/**
 * A `file` path's last extension, lower-cased with its leading `.`, or `""`
 * when its file name has none (`notes`, `.env`).
 */
export function lastExtension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** A byte count as a refusal states it, 1,000-based: `10 MB`, `512 KB`, `1500 bytes`. */
export function formatSize(bytes: number): string {
  if (bytes >= 1_000_000 && bytes % 1_000_000 === 0) return `${bytes / 1_000_000} MB`;
  if (bytes >= 1_000 && bytes % 1_000 === 0) return `${bytes / 1_000} KB`;
  return counted(bytes, "byte", "bytes");
}

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `.pdf`, `.pdf or .png`, `.pdf, .png or .jpg`. */
function oneOf(items: readonly string[]): string {
  return items.length === 1 ? items[0]! : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
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
    case "file":
      return typeof value === "string" && isFilePath(value);
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
  file: "a path to a file in the workspace (e.g. scratchpad/attachments/invoice.pdf)",
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

// --- File paths ---------------------------------------------------------------------

/**
 * A workspace path from the root, as a `file` value spells it: at most one
 * leading `/`, then one or more segments, none empty, `.` or `..`, with no
 * backslash, no NUL and no trailing `/`. A shape rule only — it names where a
 * file would be, never whether one is there.
 */
export function isFilePath(value: string): boolean {
  const path = value.startsWith("/") ? value.slice(1) : value;
  if (path === "" || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
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

const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

/**
 * An RFC 3339 date-time (one {@link isDateTime} accepts) as epoch milliseconds,
 * its offset applied and its fraction kept — never `Date.parse`.
 */
function instantOf(value: string): number {
  const match = INSTANT.exec(value);
  if (!match) return Number.NaN;
  const at = new Date(0);
  // setUTCFullYear, not Date.UTC, which reads a year below 100 as 19xx.
  at.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  at.setUTCHours(Number(match[4]), Number(match[5]), Number(match[6]), 0);
  const fraction = match[7] ? Number(match[7]) * 1000 : 0;
  const offset = match[8] ? (match[8] === "-" ? -1 : 1) * (Number(match[9]) * 60 + Number(match[10])) * 60_000 : 0;
  return at.getTime() + fraction - offset;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
