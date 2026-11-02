# DONE evidence — intake 4476bbb9 (DataOps frontend: single escapeHtml that escapes quotes)

The fix was implemented and landed on main by earlier work (ccb94ff0,
2026-10-29, "fix(frontend): one core escapeHtml that escapes quotes"); this
file records the 2026-11-02 re-verification that every acceptance criterion
holds on current origin/main (9dd44ebd) and on the deployed prod head.
No product code changes were needed in this session.

- AC1 single escaper that escapes quotes: `frontend/src/core/html.js` owns the
  one `escapeHtml`; its ESCAPES map covers `& < > " '` (`"` → `&quot;`,
  `'` → `&#39;`), so its output is safe in text and in single- or double-quoted
  attribute values. Every surface uses exactly that function: every escapeHtml
  reference in `frontend/src` either imports it from `src/core/html.js` or
  receives it through the surface context (`frontend/src/runtime/surface-composition.js`
  imports it and puts it into the context). The commit removed the hand-rolled
  copies in inline-markdown, sponsor-contacts, operations-overview, knowledge
  filters, markdown, the selection toolbar, and procedure-markdown's
  escapeHtmlAttr, plus the String fallbacks in the sponsor markup modules.
- AC2 no stray escapers (independent re-scan): over all 205 JS files listed in
  `backend/src/docs/frontend-assets.json`, zero entity-literal escaper maps and
  zero String/identity/typeof/`||`/`??` escapeHtml fallbacks remain outside
  `src/core/html.js`. The only other escaper in the tree is inside the vendored
  pinned upstream bundle `src/dakit/` ("dakit 0.2.0"), whose internal escape()
  has the identical five-character mapping and which the architecture scan
  deliberately excludes as vendor output.
- AC3 regression guard: `frontend/test/frontend-architecture.test.mjs` enforces
  the contract in three tests — "escapes HTML only through core/html.js"
  (entity literals), "never falls back to String or identity for escapeHtml",
  and "uses the core HTML escaper in frontend test and e2e harnesses". All pass.
- AC4 no double-escaping regression: the markdown renderer (same commit)
  unescapes link targets with the paired `unescapeHtml` before resolving them
  and escapes every value exactly once; `frontend/test/html-escape.test.mjs`
  asserts quote escaping plus nullish safety, and
  `frontend/test/document-editor-markdown.test.mjs` covers the markdown paths.
- Tests: `npm run test:frontend:unit` on 9dd44ebd — 921 tests,
  916 pass, 0 fail, 5 skipped (the dakit vendor byte-copy checks, which need a
  `../dakit` checkout beside this repo; environment-gated, unrelated to escaping).
- Deploy: the fix commit ccb94ff0 is an ancestor of deployed head
  1a3eb6df; GitHub Actions "Deploy DataOps V1 Lambda"
  run 41496165944 on that head completed successfully
  2026-11-02T17:58:38Z. The only later commit on main,
  9dd44ebd, adds a DONE evidence markdown file only.
