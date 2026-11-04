## ADDED Requirements

### Requirement: The docs build fails on a dead internal link

`npm run docs:build` SHALL exit non-zero when a page links to an internal page that does not
exist, or to an anchor that the target page (or the same page) does not define. The failure SHALL
name each dead link and the page that contains it. The `ci.yml` workflow SHALL run the docs build
on every pull request, so a dead link fails a PR check before it can merge.

#### Scenario: A link to an unknown anchor fails the build

- **WHEN** a page links to `/reference/machine-spec/#this-heading-does-not-exist`
- **THEN** `npm run docs:build` exits non-zero
- **AND** its output names that link and the page it appears on

#### Scenario: A link to an unknown page fails the build

- **WHEN** a page links to `/reference/no-such-page/`
- **THEN** `npm run docs:build` exits non-zero
- **AND** its output names that link and the page it appears on

#### Scenario: A pull request with a dead link fails CI

- **WHEN** a pull request adds a dead internal link to a page under `docs/`
- **THEN** the `docs` check in `ci.yml` fails on that pull request

#### Scenario: Valid links build clean

- **WHEN** every internal link resolves to an existing page and anchor
- **THEN** `npm run docs:build` exits zero
