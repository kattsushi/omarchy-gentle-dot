# highlight.js 11.12.0 (vendored)

Syntax highlighting for code blocks in the chat. Vendored so the plugin runs straight from a
`git clone` (Omarchy does not run `npm install` for plugins).

- Upstream: https://github.com/highlightjs/highlight.js, npm `highlight.js@11.12.0`
  (integrity `sha512-nbfWpyRMcMrPMmDwJB+dhX/eiaPKtc2RB+0QZskqJ3WjRA/FDS0e9hZrx8EC/lbEv8gXy98FcDbNa/dspAaJMg==`).
- License: BSD-3-Clause, see [LICENSE](LICENSE).
- `core.js` is the package's `lib/core.js`; its CommonJS exports at the end became ES module
  exports. Nothing else was changed.
- `languages/*.js` are the package's `es/languages/*.js`, unchanged: bash, c, cpp, csharp, css,
  diff, dockerfile, go, ini (also TOML), java, javascript, json, kotlin, lua, makefile, markdown,
  php, php-template, plaintext, python, ruby, rust, scss, shell, sql, swift, typescript, xml
  (also HTML and SVG), yaml.
- `bridge/highlighter.mjs` registers them.

To update: copy the same files from the new release, reapply the export change to `core.js`,
and update the version here and in `THIRD_PARTY_NOTICES.md`.
