## Context

The docs are a self-contained Starlight project in `docs/` (`@astrojs/starlight` ^0.42.6,
`astro` ^7.4.1). Only `docs.yml` builds it, and only on a push to `main`. `ci.yml` runs on pull
requests but never touches `docs/`.

## Goals / Non-Goals

**Goals:**
- A dead internal page or anchor link fails the build, both locally and in CI.
- A pull request sees that failure before merge.

**Non-Goals:**
- Checking external links. They are flaky and slow, and a third-party site going down would fail
  our builds.
- Fixing existing links, since a local scan found none dead.

## Decisions

**`starlight-links-validator` rather than a custom script.** The plugin validates links when
Starlight builds, so `npm run docs:build` itself fails and no workflow needs a separate step. It
covers unknown pages, unknown anchors, same-page anchors and relative links, using the same slugs
Starlight generates, so it can't drift from how headings are actually slugged. Version 0.27.0
declares peers `astro >=7.2.10` and `@astrojs/starlight >=0.42.0`, which the docs project
satisfies.

The issue also suggested a script of about 40 lines that walks `docs/dist`. It needs no
dependency, but it means writing and maintaining our own link parser (code fences, relative
links, trailing slashes). The plugin already does that work and is widely used.

**Plugin defaults.** The defaults fail the build on any invalid link and skip external links. No
options are needed, so the config gets just `starlightLinksValidator()`.

**A `docs` job in `ci.yml`, not a `pull_request` trigger on `docs.yml`.** `docs.yml` holds Pages
permissions (`pages: write`, `id-token: write`) and the `pages` concurrency group. Running it on
PRs would give PR code those permissions and cancel in-progress deploys. A plain job in `ci.yml`
fits the existing setup: `contents: read`, the per-ref concurrency group, and one job per check.
It runs `npm ci` and `npm run build` in `docs/`, the same steps `docs.yml` uses.

## Risks / Trade-offs

- [A Starlight or Astro major upgrade outpaces the plugin's peer range] → `npm ci` fails loudly
  on a peer conflict, and the plugin can be removed in one line if it holds up an upgrade.
- [The new job adds about a minute of CI per PR] → It runs in parallel with the other jobs, so
  the total wall-clock time stays about the same.
