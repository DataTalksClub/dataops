import { it } from 'node:test';
import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { documentBlocks, renderPrivateDocumentHtml, renderPrivateDocumentPdf, DocumentPdfEncodingError, sourceHash } from '../src/documents/privatePreview';

const doc = { id: 'draft', title: 'Review <draft>', version: 3, content: 'DRAFT FOR REVIEW\n\nSample Agreement\n\n1. Scope\n\nPreserve café — “quoted” terms & <script>alert(1)</script>.\n\n2. Conditions\n\n' + 'A complete paragraph stays readable. '.repeat(350) + '\n\nSignature: ______________________\n' };
it('retains every source character and escapes HTML without interpreting links or markup', () => {
  assert.equal(documentBlocks(doc.content).map(block => block.text).join(''), doc.content);
  const html = renderPrivateDocumentHtml(doc);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(html.includes('version=3&amp;format=pdf'));
  assert.ok(html.includes(sourceHash(doc.content)));
  assert.match(html, /noindex,nofollow,noarchive/);
});
it('exports all clauses across pages and attaches exact UTF-8 source', async () => {
  const bytes = await renderPrivateDocumentPdf(doc);
  const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  assert.ok(pdf.numPages > 1);
  let text = '';
  for (let index = 1; index <= pdf.numPages; index++) {
    const page = await pdf.getPage(index);
    const content = await page.getTextContent();
    const body = content.items.filter((item: any) => item.transform[5] > 60 && item.transform[5] < 800);
    for (const item of body as any[]) {
      assert.ok(item.transform[4] >= 59 && item.transform[4] + item.width <= 536, 'text inside page margins');
      text += item.str;
    }
  }
  assert.equal(text.replace(/\s/g, ''), doc.content.replace(/\s/g, ''));
  const attachments = await pdf.getAttachments();
  assert.equal(Buffer.from(attachments!['source.txt'].content).toString('utf8'), doc.content);
  await pdf.destroy();
});
it('refuses unsupported glyphs explicitly rather than silently changing the source', async () => {
  await assert.rejects(renderPrivateDocumentPdf({ ...doc, content: 'Preserve 日本語' }), DocumentPdfEncodingError);
});
