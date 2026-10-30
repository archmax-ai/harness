## Context

See proposal.md for why. Today a signature entry is `{ name, type?, description? }`, parsed by
the strict `signatureEntryObjectSchema` (`src/machine/spec-schema.ts`) and normalised, mapped and
checked by `src/machine/signature.ts`, which is pure, browser-safe and reached through the
`@archmax-ai/harness/spec` light subpath. Every boundary already decides by
`signatureValueIssues` and filters `kind === "invalid"`:

- the turn boundary and the completion check (`requiresRefusal`, `returnsShortfall` in
  `src/workflow/signature-checks.ts`);
- `archmax_set_variables` on a typed return (`mistypedReturns` in `control-tools.ts`);
- a delegation's arguments, a child's returns and a mock's returns (`invalidOf` in
  `sub-workflow.ts`).

The asynchronous `file` check (`fileValueIssues`) sits beside it and asks a `FileValueCheck`
what a path names and whether the session may read it.

The spec subpath's import graph is pinned by `src/public/light-subpaths.test.ts`: only `zod` and
`picomatch` may be reached, and each allowed library's own files are walked for `node:*`
imports and unguarded `process`/`Buffer` reads.

## Goals / Non-Goals

**Goals:**

- One table says which rule applies to which type. The schema refinement, the normaliser and
  the conformance rule all read it.
- No call site changes to enforce rules. A rule violation is an `invalid` issue.
- No authored pattern ever runs in a backtracking engine.
- Every synchronous check is pure, browser-safe and linear in the value's length.

**Non-Goals:**

- No platform policy: no cap on `maxLength`, no default for text from outside callers.
- No sanitising. `content` is carried and mapped only.
- No item or property schemas for `array`/`object`, and no rules on `boolean` or `object`.
- No date bounds in the JSON Schema (`formatMinimum` is an ajv extension, not JSON Schema).

## Decisions

### One rule table in `signature.ts`

`signature.ts` gains:

- `SIGNATURE_FORMATS` and `SIGNATURE_CONTENTS`;
- the `SignatureRules`, `SignatureRuleName`, `SignatureFormat`, `SignatureContent` and
  `SignatureValueOptions` types;
- `SignatureEntry extends SignatureRules`;
- an internal `RULE_TYPES: Record<SignatureRuleName, readonly SignatureType[]>`.

`spec-schema.ts` already imports `SIGNATURE_TYPES` from `signature.ts`, so it imports the table
from there too. There is no new cycle: `signature.ts` imports only types from `types.ts`.

*Alternative:* a separate `signature-rules.ts`. That would split one concept over two modules,
since the conformance rule and the mapping must read the table anyway.

### The regular-expression engine: `re2js`

`re2js` 2.9.1 was evaluated against the four checks the handover sets:

- **Licence:** MIT. It has no dependencies, is ESM, and declares `sideEffects: false`.
- **Bundle size:** 152 KB minified, about 46 KB gzipped for a browser ESM bundle. Most of
  that is the Unicode tables RE2 needs.
- **Compile-time refusal:** `(?=`, `(?!`, `(?<=`, `(?<!`, `\1` and `\k<n>` each throw
  `RE2JSSyntaxException` at `RE2JS.compile`. So do `[`, `a{2,1}` and `a++`.
- **Linear time:** `(a+)+$` against 8,000 `a`s and `!` returns `false` in about 20 ms with
  `matcher().find()`, and in about 26 ms on a 1 MB input with `.test()`.

Its files reach no `node:*` module and read no `process` or `Buffer`, so it passes the
light-subpath dependency walk, and joins `zod` and `picomatch` on the allowlist. Matching uses
`RE2JS#test(value)`: true when the pattern is found anywhere, the JSON Schema semantics.

The engine is wrapped in a new `src/machine/signature-pattern.ts`. Its one function,
`compilePattern(pattern)`, returns either a compiled pattern or the error to quote. Outcomes are
cached per pattern string in a `Map` capped at 1,000 entries, dropping the oldest. A host may
load many specs, but the patterns come from authors, never from values. Parse compiles a pattern
and caches it. `signatureValueIssues` takes it from the cache, or compiles it for an entry a host
built by hand.

A host-built entry whose pattern does not compile fails closed. The issue reports the value as
not matching, and the message says the pattern does not compile.

*Alternatives:*

- `re2` (native): fails the browser requirement.
- A JavaScript `RegExp` with a timeout: there is no portable timeout, and it is still
  exponential.
- Restricting patterns to a hand-written subset: re-implements RE2 badly.

### A pattern must also compile as ECMA-262 with the `u` flag

RE2 is not a subset of ECMA-262. It accepts `(?i)`, `\pL`, `\p{Greek}`, `\z`, `(?P<n>…)` and
`[[:alpha:]]`, which an MCP client's JSON Schema validator (ajv compiles `new RegExp(p, "u")`)
refuses or reads differently. The handover's intent is that a pattern means the same in both
places, so parse also compiles it with `new RegExp(pattern, "u")` and quotes that error when it
fails. The `RegExp` is compiled and discarded, never executed, so no authored pattern runs in a
backtracking engine.

Within the intersection the two readings differ only at the margins, such as `\s` (ASCII in
RE2) and `.` against `\r`/` `. There, the runtime's RE2 reading decides, and the reference
says so.

### Parse: optional keys, then one refinement

The strict object gains the rule keys, each with its own base shape:

- `format` and `content` are enums;
- `pattern` is a string;
- the lengths and counts are integers;
- `minimum`/`maximum` are a number or a string;
- `enum` and `accept` are string arrays;
- `maxSize` is a non-negative integer or a `<n>KB`/`<n>MB` string.

A `superRefine` then checks, in this order:

1. applicability against `RULE_TYPES` (or "needs a `type`" on an untyped entry);
2. `format` with `pattern`;
3. the pattern: length first, then RE2 compile, then ECMA-262 compile;
4. bound shapes per type: a date, an RFC 3339 instant, `today` or `now`;
5. `min…` ≤ `max…` when both are literal;
6. empty or repeated `enum` or `accept`, and the extension shape.

When the string branch of `signatureEntrySchema`'s union aborts and the object branch does not,
zod 4 returns the object branch's issues unwrapped. So each refinement message carries the
entry label itself, as the unknown-key message already does: "Entry 'quantity' declares
'format', which applies to string entries only." `SIGNATURE_ENTRY_KEYS` grows, so the
unknown-key message lists the rule keys.

`maxSize` strings are 1,000-based (`KB` = 1,000, `MB` = 1,000,000). The normaliser turns them
into bytes, so a host only ever sees a number. `accept` entries are one dot and one or more
characters with no further dot, slash or backslash, since `accept` is decided by the *last*
extension. A two-dot entry such as `.tar.gz` could never match, so parse refuses it.

### Normalising stays total

`normalizeSignature` copies a rule only when its value is well-shaped and its type takes it. A
spec that failed parse still yields what can be read, and a normalised entry never carries a
rule its type ignores. Dates and `today`/`now` are kept as written.

### Conformance: type, then the first broken rule

`signatureValueIssues(entries, values, options?)` keeps its loop. After an entry's value
conforms to its type, a `brokenRule(entry, type, value, clock)` walks the documented order and
returns `{ rule, message }` or nothing. The issue is
`{ kind: "invalid", name, type, found, rule, message }`, where `found` is the JSON kind as
today.

The clock is read once per call: `options.now ?? new Date()`.

- **`today`** is `now.toISOString().slice(0, 10)`.
- **`date` values and bounds** compare as strings, since `YYYY-MM-DD` orders lexically.
- **`date-time` values and bounds** become epoch milliseconds through the existing hand-written
  RFC 3339 match, never `Date.parse`. Offsets are applied, and the fraction is kept as a
  fractional millisecond.

Each check is linear:

- **email:** hand-written, not a regex. There is exactly one `@`. The local part is one or more
  WHATWG `atext`/`.` characters. The domain is two or more labels, each 1–63 characters of
  letters, digits and `-`, not starting or ending with `-`.
- **url:** first refuses any character at or below U+0020 or U+007F, because the WHATWG parser
  would silently strip or encode them, and nothing is trimmed. Then `new URL(value)` must parse,
  with `http:`/`https:` and an empty `username` and `password`.
- **phone:** the fixed regex `^\+[1-9][0-9]{1,14}$`, after a length check.
- **lengths:** count code points with `for…of`, stopping one past the bound.

#### "No TLD"

The handover lists "no TLD" among the email cases to pin. The bare WHATWG grammar accepts
`ann@localhost`. An address with a single-label domain is not one a person can be reached at
from outside, so the domain must have at least two labels. The platform's start form calls the
same function, so the form and the server agree.

### `maxSize` in the file check

`FileValueCheck` gains `size(path): Promise<number | undefined>`.

`fileValueIssues` keeps its order for a `file` entry: denied, then folder or missing, then size.
It reports `'invoice' must be at most 10 MB` when the size is over the limit or `undefined`.
Failing closed matters because the check is the limit's only guard.

It skips an entry whose value already broke a synchronous rule (`accept`). That keeps one issue
per entry, since the sync issue is reported by `signatureValueIssues`.

The size probe is built in two places:

- `workspaceEntrySize(backend, path)` in `file-operations.ts`. It reads the listing's `size`, and
  when a backend's listing omits it, falls back to the length of the file's bytes.
- `SessionFiles.size(sessionId, path)` in `attachments.ts`, for a delegation's caller-side check.

Sizes print 1,000-based: `10 MB`, `512 KB`, or `N bytes`.

### Mapping

`SignaturePropertySchema` gains optional `format` values `email` and `uri`, plus `pattern`,
`minLength`, `maxLength`, `enum`, `minimum`, `maximum`, `minItems`, `maxItems` and
`contentMediaType`, mapped per the spec's table. `format: url` emits both `format: uri` and
`pattern: ^https?://`, so a validator without format support still refuses `ftp:`. `format`
and `pattern` are exclusive at parse, so a property has at most one `pattern`.

### The prompt names the rules

`renderEntry` in `render-prompt.ts` appends each rule's phrase after the type. The phrases come
from `signatureRulePhrases(entry)` in `signature.ts`, the same words the refusals use, minus
"must be". An entry without rules renders byte-for-byte as before, so a rule-free workflow's
cached prompt prefix is unchanged.

### The handover's open questions, answered

- **Engine:** `re2js`. It passes all four checks.
- **One issue per entry:** yes, as proposed.
- **Date bounds in the schema:** left out, as proposed.

## Risks / Trade-offs

- **[Bundle weight]** `re2js` adds about 46 KB gzipped to a browser bundle of the spec subpath.
  → It is the price of linear-time patterns in the browser. The import is static, so a bundler
  that tree-shakes still keeps it, but only the spec subpath and the root reach it.
- **[RE2 and ECMA-262 differ at the margins]** `\s`, `.` and line terminators. → The runtime's
  RE2 reading decides, and the reference documents it. The `u`-mode compile check removes every
  syntax-level divergence.
- **[Size probes cost a read]** On a backend whose listing omits `size`, `maxSize` reads the
  file. → It happens only for entries declaring `maxSize`, at a boundary that already lists the
  parent.
- **[Older SDKs refuse rule keys]** A spec using rules cannot be loaded by 1.0.x. → This is
  documented in the changelog, and the platform pins the SDK version.
- **[Email strictness]** Refusing single-label domains departs from the bare WHATWG grammar.
  → The reference documents it, and a tested `ann@localhost` case pins it.

## Migration Plan

Additive minor release, 1.1.0, via a PR labelled `release:minor`. No spec, session or store
migrates. Rolling back to 1.0.x is safe for every spec that declares no rule. A spec that does
will fail to load there, naming the key.
