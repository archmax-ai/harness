# archmax harness docs

The documentation site for [@archmax-ai/harness](https://github.com/archmax-ai/harness),
built with [Astro](https://astro.build) + [Starlight](https://starlight.astro.build).
Content lives under `src/content/docs/` as Markdown/MDX; the sidebar is defined
in `astro.config.mjs`.

The look comes from the shared
[`@archmax-ai/starlight-theme`](https://github.com/archmax-ai/starlight-theme)
plugin, installed from a pinned Git tag (it is not on npm). Brand values live in
the theme, never here; `src/styles/custom.css` holds only site-specific rules
and loads after the theme. To pick up a new theme release, bump the tag in
`package.json` and run `npm install`. To iterate on the theme locally, point the
dependency at a sibling checkout with
`npm install ../starlight-theme` and revert to a tag before committing.

```bash
npm install
npm run dev       # local dev server with live reload
npm run build     # static build to ./dist/
npm run preview   # preview the production build
```

From the repo root: `npm run docs:dev` / `npm run docs:build`.

Deployed to GitHub Pages by `.github/workflows/docs.yml` on every push to `main`.
