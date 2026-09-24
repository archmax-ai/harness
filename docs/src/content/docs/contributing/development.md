---
title: Development setup
description: Clone, build, and test the harness repository.
sidebar:
  order: 1
---

The SDK is a single npm package (Node ≥ 22, ESM only). Clone the repo and
install:

```bash
git clone https://github.com/archmax-ai/harness.git
cd harness
npm install
cp .env.example .env   # fill in an OpenAI-compatible endpoint + key
```

## Everyday commands

```bash
npm run dev          # run the CLI from source via tsx (src/cli.ts)
npm run build        # clean + tsc + copy assets; emits dist/
npm start            # run the compiled CLI (node dist/cli.js)
npm run typecheck    # tsc --noEmit over everything INCLUDING tests
npm test             # vitest run — colocated *.test.ts unit tests
npm run test:watch   # vitest watch
npm run docs:build   # build the docs site
npx openspec validate --specs   # validate the specs under openspec/specs
```

Run the bundled example from source:

```bash
npm run dev -- run order-lookup "Which orders are delayed for Acme?" --root examples/customer-support
npm run dev -- test order-lookup --root examples/customer-support
npm run dev -- validate order-lookup --root examples/customer-support
```

## Unit tests

Unit tests are **colocated** with the code they cover: `src/**/foo.ts` +
`src/**/foo.test.ts`. `src/behaviour/` drives the public barrel end to end with
a scripted fake model:

```bash
npx vitest run src/machine/allow.test.ts    # one file
npx vitest run -t "resolves transition"     # by test-name substring
```

A workflow's [cases](/guides/testing/) are a separate thing:
declarative YAML documents, interpreted host-side by `archmax test`.

## Repository layout

- `src/` is the runtime (library). It holds `assembly/` (`createAgent`),
  `machine/` (the schema and the compiled machine), `validate/`, `workflow/`
  (governance middleware, parks, control tools), `kernel/`, `sandbox/`, `lifecycle/`,
  `rubrics/`, `sessions/`, `testing/` (the case engine), `cli/`, `core/`,
  `public/` (the `sandbox`, `testing` and `cli` subpaths), `behaviour/`,
  `env.ts`, `index.ts`. `core/platform-prompt.md` is the platform prompt,
  the graph-state execution model merged into every governed agent's system
  prompt. `npm run build` generates `core/platform-prompt.generated.ts` from
  it, so it ships inside the code; edit the Markdown and run
  `npm run generate:prompt` (a unit test fails while the two differ).
- `skills/archmax-harness/` is the authoring skill, shipped as `dist/authoring-skill/archmax-harness`.
- `examples/customer-support/` is the reference workspace.
- `docs/` is this documentation site (Astro + Starlight), self-contained with
  its own `package.json`. Build it with `npm run docs:build` from the repo root.
- `openspec/` holds change proposals and specs; see
  [the OpenSpec workflow](/contributing/openspec/).

## Documentation ships with features

User-facing behavior covers the CLI, configuration, the authoring model, the
skills or workflow schema, and the public API. Any change affecting it must
update the relevant pages under `docs/` in the same change. This convention is
encoded in `openspec/config.yaml` and surfaced when authoring proposals and task
lists.

## Releasing

Releases are cut by merging a labelled PR into `main`. The label picks the bump:
`release` for a patch, `release:minor` or `release:major`. On merge,
`.github/workflows/release.yml` re-runs the checks, tags `vX.Y.Z`, creates the
GitHub Release with generated notes, and publishes that version to npm with
provenance. The first release is `v0.1.0`.

The tag is the version. `package.json` on `main` is never bumped; the publish
job stamps the tag's version into it before `npm publish`. A manual dispatch
(Actions → Release) takes a bump and defaults to a dry run that logs the next
version and changes nothing.

npm authenticates the workflow through
[trusted publishing](https://docs.npmjs.com/trusted-publishers): the package's
trusted publisher on npmjs.com names `archmax-ai/harness` and `release.yml`, and
the job's GitHub OIDC token is exchanged for a short-lived publish credential.
There is no npm token to store or rotate. Publishing is switched on by the
`NPM_PUBLISH` repository variable (`true`); until then the workflow tags and
releases but only runs `npm pack`.
