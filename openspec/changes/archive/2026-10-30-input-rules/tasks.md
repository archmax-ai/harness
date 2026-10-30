## 1. The regular-expression engine

- [x] 1.1 Add `re2js` (exact 2.9.x range) to `dependencies` and add `src/machine/signature-pattern.ts`
      with `compilePattern(pattern)`: the 1,000-character limit, the RE2 compile and the
      ECMA-262 `u` compile (never executed), each failure quoting its engine's error, cached
      per pattern in a `Map` capped at 1,000 entries. Verify with `signature-pattern.test.ts`:
      lookarounds, backreferences, `[a-`, `(?i)abc`, `\pL`, 1,001 characters are refused; a
      valid pattern is compiled once; `(a+)+$` against 8,000 `a`s and `!` returns false in
      well under a second.
- [x] 1.2 Admit `re2js` on the spec subpath: add it to `ALLOWED_BARE_SPECIFIERS` in
      `src/public/light-subpaths.test.ts`. Verify the import-graph walk and the dependency scan
      pass for `re2js`.

## 2. Rules in the signature vocabulary and the schema

- [x] 2.1 In `src/machine/signature.ts`, add `SIGNATURE_FORMATS`, `SIGNATURE_CONTENTS`,
      `SignatureFormat`, `SignatureContent`, `SignatureRules`, `SignatureRuleName`,
      `SignatureValueOptions`, `SignatureEntry extends SignatureRules`, the internal rule-to-type
      table, a `parseSize` helper (`10MB` → bytes), and extend `normalizeSignature` to carry
      well-shaped, applicable rules (maxSize as bytes, `today`/`now` symbolic). Verify
      `signature.test.ts` covers a ruled entry, a bare name yielding no rules, an inapplicable
      or malformed rule dropped, and `10MB`/`512KB`/`2048` normalised.
- [x] 2.2 In `src/machine/spec-schema.ts`, add the rule keys to `signatureEntryObjectSchema`
      with their base shapes and one refinement (applicability or a missing `type`,
      `format` with `pattern`, the pattern via `compilePattern`, bound shapes per type,
      `min…` ≤ `max…`, empty or repeated `enum`/`accept`, the extension shape), each message
      naming the entry; grow `SIGNATURE_ENTRY_KEYS`. Verify `spec-schema.test.ts`: every rule on
      every type it takes parses; every rule on another type or an untyped entry fails naming
      entry and key; `format`+`pattern` fails; each bad pattern fails quoting the engine; each
      inconsistent bound fails; `maxLength: 1000000` loads; and `validateSpec` reports the
      identical messages.

## 3. Conformance and mapping

- [x] 3.1 Extend `signatureValueIssues(entries, values, options?)` with the first-broken-rule
      check after the type (format/pattern, enum, lengths, bounds, item counts, accept), an
      optional `rule` on the `invalid` issue, the clock from `options.now`, and the
      hand-written email, URL and phone checks. Verify `signature.test.ts`: each rule at, just
      inside and just outside its bound; one issue per entry in the documented order; a
      mistyped value reports the type and no rule; `today`/`now` pinned around a UTC midnight;
      astral code points; URL credentials, `ftp:`, `javascript:`, relative and space-led forms;
      email `+` tags accepted, `ann@localhost` and a quoted local part refused; entries without
      rules produce the exact 1.0.0 messages.
- [x] 3.2 Pin linear time in `signature.test.ts`: the `(a+)+$` case through
      `signatureValueIssues`, and email, URL, length and pattern checks over a 1 MB string,
      each within a generous bound.
- [x] 3.3 Extend `SignaturePropertySchema` and `signatureJsonSchema` with the mapped keywords
      (email → `format: email`; url → `format: uri` + `pattern: ^https?://`; phone → E.164
      `pattern`; `pattern`, lengths, `enum`, numeric bounds, item counts as themselves;
      `content` → `contentMediaType`; date bounds, `accept`, `maxSize` left out). Verify a
      snapshot test of each rule's property schema in `signature.test.ts`.
- [x] 3.4 Export the new constants and types from `src/public/spec.ts` and `src/index.ts` as
      one binding each; raise the root budget in `src/index.test.ts` with its comment. Verify
      `index.test.ts` and `light-subpaths.test.ts` (including both-direction docs checks, after
      4.x documents them) pass.

## 4. The file size check and the call sites

- [x] 4.1 Add `size(path)` to `FileValueCheck` and to `SessionFiles`; implement
      `workspaceEntrySize` in `src/core/file-operations.ts` (the listing's `size`, else the
      bytes' length, else `undefined`); wire it in `file-values.ts`, `compose.ts`,
      `attachments.ts` and the dispatcher's `callerFiles`. Extend `fileValueIssues` to report
      `'<name>' must be at most <size>` after the existence and permission checks, and to skip
      an entry whose value already broke a synchronous rule. Verify `file-values.test.ts`
      (or a new `signature-checks.test.ts`) covers over, at and under the limit, an unknown
      size refused, and one issue for an entry breaking `accept`.
- [x] 4.2 Verify every call site enforces rules with the rule's message, adding tests where none
      exists: `requiresRefusal` and the turn boundary (a firing breaking `maximum`),
      `returnsShortfall` at completion, `archmax_set_variables` on a typed return breaking
      `format: email` (`control-tools.test.ts`), a delegation argument breaking `enum` and a
      mocked return breaking a rule (`sub-workflow.test.ts`), and an oversized `file` seed at
      the turn boundary.
- [x] 4.3 Render rules in the prompt: add `signatureRulePhrases(entry)` in `signature.ts` and use
      it in `renderEntry` (`render-prompt.ts`). Verify `render-prompt.test.ts`: a ruled return
      renders `- contact (string; an email address; at most 80 characters) — …`, and an entry
      without rules renders byte-for-byte as before.

## 5. Documentation, README and authoring skill

- [x] 5.1 Docs site: in `reference/machine-spec.md` (*The signature: `requires` and
      `returns`*) add the rule table, the parse rules, the regular-expression engine note, the
      `content` note, the prompt rendering, and drop "no enums and no ranges"; in
      `reference/public-api.md` document the new exports, `options.now`, the `rule` on an issue
      and the mapped keywords; in `guides/triggers.md` show a ruled signature; add **Rule** to
      `reference/glossary.md`; add a 1.1.0 section to `reference/changelog.md`. Verify with
      `npm run docs:build` and the public-API both-direction tests.
- [x] 5.2 README.md: mention rules in the signature paragraph and that the JSON Schema carries
      them. Verify by reading the paragraph against the reference.
- [x] 5.3 `skills/archmax-harness/`: update `SKILL.md`, `references/workflow-yaml.md`,
      `references/workflow-schema.md` (rule table, parse rules, rendering) and
      `references/backend-integration.md` (rules in the mapped schema, `rule` on an issue,
      `options.now`, `maxSize` in the file check). Verify that a ruled example in the skill
      validates with `archmax validate` against a scratch workspace.

## 6. Integration

- [x] 6.1 `npm run typecheck`, `npm run lint` and `npm test` all pass.
- [x] 6.2 `npm run build`, `npm run docs:build` and `openspec validate input-rules --strict`
      all pass, and `archmax validate` on `examples/customer-support` still passes.

## Workflow follow-up

- Archive the change with `/opsx:archive`, which syncs the delta specs into `openspec/specs/`,
  then run `openspec validate --specs`.
- Open the PR labelled `release:minor` (1.1.0) and monitor it.
