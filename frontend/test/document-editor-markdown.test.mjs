import assert from "node:assert/strict";
import { test } from "node:test";

import { createEditorMarkdown } from "../src/surfaces/document-editor/markdown.js";

const docs = { "ops/a&b": { path: "content/ops/a&b.md", title: 'Fish & "Chips"' } };

function render(markdown) {
  const { renderInlineAtom } = createEditorMarkdown({
    documentState: { currentDoc: { path: "content/ops/page.md" } },
    openDocument() {},
    resolveDocReference: (ref) => docs[ref] || null,
    resolveMarkdownDocLink: () => null,
    visibleDocUrl: (path) => `/docs/${path}`,
  });
  return renderInlineAtom(markdown);
}

test("markdown cannot break out of image or link attributes", () => {
  assert.equal(
    render('![x" onerror="alert(1)](a.png)'),
    '<img src="/content/ops/a.png" alt="x&quot; onerror=&quot;alert(1)" loading="lazy">',
  );
  assert.equal(
    render('[go](https://example.test/?a=1&b="2")'),
    '<a href="https://example.test/?a=1&amp;b=&quot;2&quot;" target="_blank" rel="noopener">go</a>',
  );
});

test("markdown wiki links escape each value exactly once", () => {
  assert.equal(
    render("[[ops/a&b]]"),
    '<a href="/docs/content/ops/a&amp;b.md" data-doc-path="content/ops/a&amp;b.md" ' +
      'title="content/ops/a&amp;b.md">Fish &amp; &quot;Chips&quot;</a>',
  );
  assert.equal(
    render('[[missing"x|Tom & Jerry]]'),
    '<span class="broken-doc-link" title="Missing doc: missing&quot;x">Tom &amp; Jerry</span>',
  );
});
