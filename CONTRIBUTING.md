# Contributing

Thanks for helping build the archmax harness. This page is the short version. The
[development setup](https://harness.archmax.ai/contributing/development/)
page in the docs site has the full detail.

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). Found a way around
the governance layer or out of the sandbox? Report it privately as described in
[SECURITY.md](SECURITY.md), not in a public issue.

## Getting set up

Node 22 or later, ESM only. The SDK is a single npm package.

```bash
git clone https://github.com/archmax-ai/harness.git
cd harness
npm install
cp .env.example .env   # an OpenAI-compatible endpoint + key
```

## The commands you will actually use

```bash
npm run typecheck    # tsc --noEmit over everything, tests included
npm test             # vitest run — colocated *.test.ts plus src/behaviour/
npm run lint         # eslint .
npm run format       # prettier --write .  (format:check to just verify)
npm run build        # clean + emit dist/ + copy assets
npm run docs:build   # build the docs site
npx openspec validate --specs

npx vitest run src/machine/allow.test.ts       # one file
npx vitest run -t "resolves transition"        # by test-name substring
```

Run the bundled example from source:

```bash
npm run dev -- run order-lookup "Which orders are delayed for Acme?" --root examples/customer-support
npm run dev -- test order-lookup --root examples/customer-support
npm run dev -- validate order-lookup --root examples/customer-support
```

## Editor setup

TypeScript and ESLint read the repo's own config files, so any editor with the
standard extensions picks them up. No editor config is required, but two things
are worth knowing:

- **Use the workspace TypeScript version**, not your editor's bundled one. The
  repo pins `typescript` in `devDependencies`, and `npm run typecheck` is the
  authority.
- **Leave format-on-save off**, or scope it to the lines you touch. The tree is
  not Prettier-clean and CI does not check formatting, so a save-time reformat
  would bury your change in hundreds of unrelated lines. Run `npm run format`
  when the repo is normalized deliberately, not per PR.

## Making a change

Branch off `main` as `<type>/<short-slug>`, matching the type to the commit
prefix below (`fix/hitl-bug-sweep`, `feat/title-set-event`). When the work has an
issue, `<type>/<issue>-<short-slug>` is equally welcome and keeps the number in
view while the branch is alive (`fix/8-drop-unused-markitdown-ts`). GitHub's
"Create a branch" button on an issue suggests `<issue>-<issue-title-slug>`.
Rename it to one of those two forms before you start.

Commit subjects are [Conventional Commits](https://www.conventionalcommits.org):
`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, with a `!` for a breaking
change (`refactor!: one graph per workflow`). Write the subject as what the
change does for a reader of the software, not as what you edited.

**Documentation ships with the change.** User-facing behaviour means the CLI,
configuration, the `workflow.yaml` schema, the hook contract, governance, cases,
and the public API. A change to any of those updates `docs/`, `README.md` and
`skills/archmax-harness/` in the same PR. The specs under `openspec/specs/` describe
present behaviour. This is a review gate.

Larger work goes through [OpenSpec](https://harness.archmax.ai/contributing/openspec/):
a proposal and task list under `openspec/changes/` before the code.

## Before you open a PR

`npm run typecheck`, `npm test` and `npm run lint` all pass, and no secrets are
committed (CI runs gitleaks). CI re-runs the same checks on Node 22 and 24, so
running them locally is the fast path.

Fill in the PR template's three fields: the type, the issue, and a summary of
what changed and why in a line or two. Name the issue as `Closes #123` so merging
closes it and the backlog stays current. When the change genuinely has no issue,
write `none` in the field.

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

## Reporting a bug

Open an issue with the
[bug report template](https://github.com/archmax-ai/harness/issues/new/choose).
What makes a report actionable is a reproduction that runs against the real
code. Write a small `.mts` file at the repo root and run it with `npx tsx`. Show
that it prints the wrong result. A `workflow.yaml` snippet plus the command you
ran works too.
