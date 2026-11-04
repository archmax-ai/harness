## Why

`npm run docs:build` exits zero even when a page links to a page or an anchor that does not exist,
so dead internal links ship silently and readers find them (issue #7). Hand-written slugs such as
`#mountsallowalways-…` look right but miss the `--` and `_` that `github-slugger` keeps. Eight of
these got past a green build in `10fec8f`. And no PR check builds the docs at all: `docs.yml` runs
only after a merge to `main`.

## What Changes

- The docs build fails on an internal link to an unknown page or an unknown anchor, including
  same-page `#anchor` links. The error names each dead link and the page it is on.
- CI builds the docs on every pull request, so a dead link shows up as a red check before merge.
  `docs.yml` keeps building and deploying on `main`, and the same failure skips the deploy.
- New dependency in `docs/`: `starlight-links-validator`.

## Capabilities

### New Capabilities

### Modified Capabilities

- `documentation`: the site's build validates every internal link, and CI builds the site on pull
  requests.

## Impact

- `docs/astro.config.mjs` (one plugin entry), `docs/package.json` and `docs/package-lock.json`.
- `.github/workflows/ci.yml`: one new `docs` job.
- The current pages build clean, so turning the check on needs no page fixes. A local scan of the
  built site found no dead root-relative links. The validator's first run confirms that, and it
  also covers relative and same-page links.
- No change to the package, its public API, `README.md` or `skills/archmax-harness/`. The
  `docs/` pages are unchanged. The changelog records releases, and this changes no shipped package.
