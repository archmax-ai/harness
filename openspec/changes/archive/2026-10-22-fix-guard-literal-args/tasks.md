## 1. Reproduce

- [x] 1.1 Add unit tests in `src/machine/allow.test.ts` for the probed cases: an empty value against a `${{…}}` guard resolving to `""` (permitted, no throw), a URL against `https://api.example.com/**`, a stored URL and `a//b` against themselves, and `"/abs"` against `["abs"]` for a text argument (blocked). Verify they fail on the current code.

## 2. Matching

- [x] 2.1 Add a helper in `src/machine/tool-paths.ts` naming a tool's path arguments: `pathArgsOf` plus the built-in aliases. Verify with a unit test for `read_file` (`file_path`, `path`), `copy_file`, and an undeclared host tool (`file_path`).
- [x] 2.2 Give `valueMatches` and `argsSatisfy` (`src/machine/allow.ts`) the argument's kind and the grant/denial side, and match empty patterns first, as design.md gives. Verify that the tests from 1.1 pass, along with a path argument still canonicalized (`./reports/q3.md` permitted, `reports/../secrets/k` blocked).
- [x] 2.3 Pass the path arguments and side from `checkAllowed` (`src/machine/machine.ts`) and `denialMatches` (`src/kernel/kernel.ts`). Verify with kernel tests: a URL grant, an empty-value grant, and a denial on an undeclared host tool's `target` catching both `secrets/k` and `./secrets/k`.
- [x] 2.4 Check that guard disclosure in the tool descriptions renders no canonicalized form (`grep -rn "canonicalizeRelPath\|normalizeRelPath" src/workflow src/machine`). Verify by reading what the hits render.
- [x] 2.5 Run `npm test` and `npm run typecheck`. Verify both pass.

## 3. Docs and skill

- [x] 3.1 Update the `args` guard text in `docs/src/content/docs/reference/machine-spec.md`: path arguments are canonicalized, other arguments match as text, a denial catches either form, and an empty pattern matches only an empty value. Verify with `npm run docs:build`.
- [x] 3.2 Add a 0.9.0 changelog entry to `docs/src/content/docs/reference/changelog.md`: URL and empty-value guards work, plus the narrowing for text grants with a migration line (declare a tool's path arguments). Verify with `npm run docs:build`.
- [x] 3.3 Update where `skills/archmax-harness/references/workflow-schema.md` and `references/workflow-yaml.md` describe `args` guards (`grep -n "args" …`). Check README.md with `grep -n -i "glob\|guard" README.md`. Run `npx openspec validate fix-guard-literal-args --strict` and verify it passes.
