## Why

A signature entry can say what *type* a value is, but not what a value of that type must look
like: an email address, an http(s) URL, at most 24 characters, one of three values, a number
from 1 to 100, a date no earlier than today. The platform (`archmax-ai/automation`, change
`input-rules`) wants authors to declare exactly that, and it cannot: the object spelling of an
entry is strict (`{ name, type?, description? }`), every boundary decides conformance through
`signatureValueIssues`, and every schema a caller sees comes from `signatureJsonSchema`. All
three belong to the SDK, so the rules have to be declared, enforced and described here, once,
for every boundary at once.

## What Changes

- A `requires`/`returns` object entry MAY declare **rules** beside its `type`, spelled as
  JSON Schema's own keywords wherever one exists: `format` (`email`, `url`, `phone`),
  `pattern`, `minLength`/`maxLength`, `enum`, `content` (`text`, `markdown`, `html`) on
  `string`; `minimum`/`maximum` on `integer`, `number`, `date` (`YYYY-MM-DD` or `today`) and
  `date-time` (an RFC 3339 instant or `now`); `minItems`/`maxItems` on `array`; `accept`
  (extensions) and `maxSize` (bytes, or `<n>KB`/`<n>MB`) on `file`.
- The entry schema stays strict. A rule on a type that does not take it (or on an untyped
  entry), `format` together with `pattern`, a pattern that does not compile, uses a lookaround
  or a backreference, or is over 1,000 characters, and inconsistent bounds (`min…` above
  `max…`, an empty or repeated `enum`, a negative length or count) are load errors naming the
  entry and the key. `archmax validate` reports the same.
- An authored `pattern` is **never run through `RegExp`**. It is compiled and matched by a
  linear-time RE2 engine (`re2js`, pure JavaScript, MIT), compiled at parse and cached per
  pattern, so a stranger's input cannot make a check take exponential time.
- `signatureValueIssues(entries, values, options?)` checks rules after the type: at most one
  issue per entry, the first rule broken in a fixed order, as an `invalid` issue carrying a new
  optional `rule`. Every existing call site (the turn boundary, the completion check,
  `archmax_set_variables` on a typed return, a delegation's arguments and returns, and a
  host's own validation) enforces rules with no change. `options.now` pins the clock `today`
  and `now` are read against. Nothing is coerced or trimmed.
- `maxSize` joins the asynchronous file check: `FileValueCheck` gains `size(path)`, and a
  `file` value naming a file over its `maxSize` is refused beside today's existence and
  permission refusals.
- `signatureJsonSchema` maps each rule JSON Schema can express to its keyword (`format`,
  `pattern`, the length, count and numeric bounds, `enum`, `contentMediaType`), and leaves
  out date bounds, `accept` and `maxSize`, which the runtime still enforces.
- `normalizeSignature` carries the rules through (normalising `maxSize` to bytes, keeping
  `today`/`now` symbolic) and stays total.
- `content` is a declaration only: carried and mapped, never checked or sanitised by the SDK.
- New exports on the root and `@archmax-ai/harness/spec` (one binding each):
  `SIGNATURE_FORMATS`, `SIGNATURE_CONTENTS`, and the types `SignatureFormat`,
  `SignatureContent`, `SignatureRules`, `SignatureRuleName` and `SignatureValueOptions`.
- Additive: an entry without rules parses, normalises, maps and checks exactly as before, with
  the same messages. A spec that uses rules cannot be read by an older SDK (its strict schema
  refuses the keys). Released as a minor version.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-spec`: a signature entry declares rules (parse rules and their refusals), the
  conformance rule checks them (order, messages, the clock), the JSON Schema mapping maps
  them, and a `file` value is held to its `maxSize` where it crosses a boundary.
- `assembly`: the `@archmax-ai/harness/spec` light subpath publishes the rule vocabulary, and
  its browser-safety pin admits `re2js`, walked like `zod` and `picomatch`.
- `documentation`: the glossary gains **rule**.

## Impact

- **Code:** `src/machine/signature.ts` (rule types, constants, normalisation, conformance,
  mapping), a new `src/machine/signature-pattern.ts` (the RE2 wrapper and its cache),
  `src/machine/spec-schema.ts` (`signatureEntryObjectSchema` keys and refinement,
  `SIGNATURE_ENTRY_KEYS`), `src/workflow/signature-checks.ts` (`FileValueCheck.size`,
  `fileValueIssues`), `src/workflow/file-values.ts`, `src/core/file-operations.ts` and
  `src/core/attachments.ts` (a size probe), `src/assembly/compose.ts` and
  `src/workflow/sub-workflow.ts` (wiring the probe), `src/public/spec.ts`, `src/index.ts`.
- **Dependency:** `re2js` (MIT, pure JavaScript, no dependencies; about 46 KB gzipped in a
  browser bundle) joins `zod` and `picomatch` on the spec subpath's allowlist.
- **Public API:** additive types and constants; `signatureValueIssues` gains an optional third
  argument; `SignatureValueIssue`'s `invalid` variant gains an optional `rule`;
  `SignaturePropertySchema` gains optional keywords; `FileValueCheck` (internal) gains `size`.
- **Docs (`docs/`):** the machine-spec reference's *The signature: `requires` and `returns`*
  gains the rule table, the parse rules, the regular-expression engine and the `content` note,
  and drops "no enums and no ranges"; the public API page documents the new exports and the
  `options` argument; the triggers guide shows a ruled signature; the glossary gains **Rule**;
  the changelog gains a 1.1.0 section.
- **README.md:** the signature paragraph mentions rules and that the JSON Schema carries them.
- **Authoring skill (`skills/archmax-harness/`):** `SKILL.md`, `references/workflow-yaml.md`,
  `references/workflow-schema.md` (the rule table and parse rules) and
  `references/backend-integration.md` (rules in the mapped schema, `rule` on an issue,
  `options.now`) are updated in the same change.
- **Release:** semver minor, 1.1.0, via a PR labelled `release:minor`.
