# Markdown browser dependency

`markdown-it.js` is the browser ESM bundle (only its source-map comment is removed) from `markdown-it@15.0.1`,
`dist/browser/markdown-it.esm.min.mjs`, served locally with the Web UI. Its MIT
license is included in `markdown-it.LICENSE`. No runtime CDN or npm install is
needed to display messages.

Source: https://registry.npmjs.org/markdown-it/-/markdown-it-15.0.1.tgz

Bundle SHA-256: `d7955f06b3d812594a52947e24c0ba1b96e506d85f02b86f57210f395754b2e2`.

To update, pack an explicitly selected version with `npm pack --ignore-scripts`,
extract its browser ESM bundle and license, update the version and hash here,
and run the Web UI Markdown tests and browser checks. Do not hand-edit or
format this generated third-party bundle.
