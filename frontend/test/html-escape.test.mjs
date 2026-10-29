import assert from "node:assert/strict";
import { test } from "node:test";

import { escapeHtml, unescapeHtml } from "../src/core/html.js";

test("escapeHtml escapes every character that can end text or an attribute", () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`),
    "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(0), "0");
});

test("unescapeHtml reverses escapeHtml and nothing else", () => {
  const raw = `a&b <c> "d" 'e' &amp; &nbsp;`;
  assert.equal(unescapeHtml(escapeHtml(raw)), raw);
  assert.equal(unescapeHtml("&nbsp;&#40;"), "&nbsp;&#40;");
});
