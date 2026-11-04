## 1. Link validation in the docs build

- [x] 1.1 Add `starlight-links-validator` as a dependency in `docs/` and verify `npm ci` in `docs/` succeeds with no peer conflict
- [x] 1.2 Add `starlightLinksValidator()` to the Starlight `plugins` in `docs/astro.config.mjs` and verify `npm run docs:build` exits zero on the current pages
- [x] 1.3 Add a temporary probe page linking to `/reference/machine-spec/#this-heading-does-not-exist` and `/reference/no-such-page/`, verify `npm run docs:build` exits non-zero and names both links, then delete the probe

## 2. CI

- [x] 2.1 Add a `docs` job to `.github/workflows/ci.yml` that runs `npm ci` and `npm run build` in `docs/` (Node 22, npm cache keyed on `docs/package-lock.json`) and verify it with `actionlint` or a YAML parse
- [x] 2.2 Verify the `docs` check runs and passes on the pull request once it is opened

## 3. Spec

- [x] 3.1 Verify `npx openspec validate fix-docs-dead-links --strict` passes
