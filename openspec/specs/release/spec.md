# release Specification

## Purpose

Define how `@archmax-ai/harness` is versioned and published to npm: a labelled pull request merged
into `main` cuts the release, the git tag is the version, and one workflow tags, releases and
publishes, gated on the same checks CI runs.

## Requirements

### Requirement: A labelled merge cuts the release

The repository SHALL include a GitHub Actions workflow (`.github/workflows/release.yml`) that
releases when a pull request merged into `main` carries the label `release` (patch bump),
`release:minor` or `release:major`, and on manual dispatch with a chosen bump. When several
labels are present the largest bump SHALL win. A merge without any of these labels SHALL release
nothing. A manual dispatch SHALL default to a dry run that logs the next version and creates no
tag, release or package. Releases SHALL run under one `release` concurrency group without
cancelling a run in progress.

#### Scenario: A PR labelled release:minor merges

- **WHEN** a pull request labelled `release:minor` is merged into `main` and the latest tag is
  `v0.3.1`
- **THEN** the workflow tags `v0.4.0`, creates a GitHub Release with generated notes, and
  publishes `@archmax-ai/harness@0.4.0`

#### Scenario: An unlabelled PR merges

- **WHEN** a pull request without a release label is merged into `main`
- **THEN** no tag, release or package is created

#### Scenario: The first release

- **WHEN** the repository has no `v*` tag and a labelled pull request merges
- **THEN** the release is `v0.1.0`

### Requirement: The release is gated on the CI checks

Before any tag is created, the workflow SHALL run `npm run typecheck`, `npm test` and
`npm run build` on Node 22, and SHALL create no tag or release when any of them fails.

#### Scenario: A failing test blocks the release

- **WHEN** a labelled pull request merges and `npm test` fails in the release job
- **THEN** no tag, GitHub Release or npm package is created

### Requirement: The tag is the version

The `vX.Y.Z` tag SHALL be the source of truth for the version; `package.json` on `main` SHALL NOT be
bumped by a release. The publish job SHALL check out the tag, stamp its version into
`package.json` without committing, and publish that version, so the published package's version
always equals its tag.

#### Scenario: package.json on main lags the tag

- **WHEN** `package.json` on `main` says `0.1.0` and the release tags `v0.2.0`
- **THEN** the package published to npm is version `0.2.0` and `main` is unchanged

### Requirement: Publishing is one workflow, authenticated by trusted publishing

Tagging and publishing SHALL run as two jobs of the same workflow, so publishing never depends on
a release event created with `GITHUB_TOKEN` (which triggers no other workflow). The tagging job
SHALL hold only `contents: write`; the publish job only `contents: read` and `id-token: write`.
The publish job SHALL authenticate to npm through trusted publishing — the job's GitHub OIDC token,
matched against the package's trusted publisher (`archmax-ai/harness`, `release.yml`) — and SHALL
use no long-lived npm token. It SHALL run npm 11.5.1 or later and publish with
`npm publish --provenance --access public`, only when the `NPM_PUBLISH` repository variable is
`true`; otherwise it SHALL build and `npm pack` instead, and the tag and GitHub Release SHALL still
be created. The `prepack` guard SHALL refuse a `dist/` containing an `.env` file.

#### Scenario: Publishing not enabled

- **WHEN** a labelled pull request merges and `NPM_PUBLISH` is not `true`
- **THEN** the tag and GitHub Release are created, the package is packed, and nothing is published
  to npm

#### Scenario: Publishing enabled

- **WHEN** a labelled pull request merges and `NPM_PUBLISH` is `true`
- **THEN** the package is published with a provenance attestation, and no npm secret is read

#### Scenario: A GitHub Release is published by hand

- **WHEN** someone publishes a GitHub Release from the UI
- **THEN** nothing is published to npm
