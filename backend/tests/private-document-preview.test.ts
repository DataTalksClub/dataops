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

const formatted = { id: 'formatted', title: 'Formatted', version: 1, content: 'Event Sponsorship Agreement\n\n1. Purpose\n\nThis summary is a working draft for discussion between both parties and need not be signed before the event takes place, because the final terms follow later.\n\n2. Deliverables\n\nThe sponsor receives:\n- one dedicated newsletter mention in the issue before the event, including a link chosen by the sponsor and a short description\n- a logo on the event page\n  - placed in the sponsor section\n\n3. Payment\n\nIt is a pre-agreed flat fee. It is a pre-agreed amount that covers everything listed above, invoiced once after the event has taken place.\n' };
async function textItems(bytes: Uint8Array): Promise<any[]> {
  const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  const items: any[] = [];
  for (let index = 1; index <= pdf.numPages; index++) {
    const content = await (await pdf.getPage(index)).getTextContent();
    items.push(...content.items.filter((item: any) => item.str && item.transform[5] > 60 && item.transform[5] < 800));
  }
  await pdf.destroy();
  return items;
}
it('renders bullet lists with a hanging indent, no leading space on wrapped rows, and a larger title', async () => {
  const items = await textItems(await renderPrivateDocumentPdf(formatted));
  assert.equal(items.map(item => item.str).join('').replace(/\s/g, ''), formatted.content.replace(/\s/g, ''));
  for (const item of items.filter(entry => entry.str.trim())) assert.ok(!/^\s/.test(item.str), `row starts with whitespace: ${JSON.stringify(item.str)}`);
  const size = (text: string): number => items.find(item => item.str.startsWith(text))!.transform[0];
  assert.ok(size('Event Sponsorship Agreement') > size('1. Purpose') + 4, 'title larger than section headings');
  assert.ok(size('1. Purpose') > size('This summary'));
  const x = (text: string): number => items.find(item => item.str.startsWith(text))!.transform[4];
  const item = items.findIndex(entry => entry.str.startsWith('one dedicated'));
  assert.equal(items.slice(0, item).filter(entry => entry.str.trim()).at(-1).str, '-', 'source marker kept in the text layer');
  assert.ok(x('one dedicated') - x('The sponsor') >= 16, 'list text hangs past the bullet');
  assert.equal(items[item + 1].transform[4], items[item].transform[4], 'wrapped item rows align with the item text');
  assert.ok(x('placed in') > x('a logo'), 'nested item indented further');
});
it('embeds Unicode TrueType fonts instead of standard Type1 fonts', async () => {
  const { PDFDocument, PDFDict, PDFName, PDFArray } = await import('pdf-lib');
  const pdf = await PDFDocument.load(await renderPrivateDocumentPdf({ ...doc, content: 'Привет — café “ok” Ελληνικά' }));
  const fonts = pdf.context.enumerateIndirectObjects().map(([, object]) => object).filter((object): object is InstanceType<typeof PDFDict> => object instanceof PDFDict && object.get(PDFName.of('Type')) === PDFName.of('Font') && object.has(PDFName.of('Encoding')));
  assert.ok(fonts.length >= 2);
  for (const font of fonts) {
    assert.equal(font.get(PDFName.of('Subtype')), PDFName.of('Type0'));
    assert.equal(font.get(PDFName.of('Encoding')), PDFName.of('Identity-H'));
    assert.ok(font.has(PDFName.of('ToUnicode')));
    const descendant = pdf.context.lookup((font.lookup(PDFName.of('DescendantFonts'), PDFArray)).get(0), PDFDict);
    assert.ok(descendant.lookup(PDFName.of('FontDescriptor'), PDFDict).has(PDFName.of('FontFile2')), 'font program embedded');
  }
});
