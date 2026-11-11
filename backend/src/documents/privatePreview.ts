import type { LambdaResponse } from '../types';
import { noStoreJson as json } from '../http';
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';

export interface PreviewDocument { id: string; title: string; content: string; version: number }
export const privateDocumentHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
export const sourceHash = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex');
const escape = (text: string): string => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
/** Classify presentation only. Every source character remains in the blocks. */
export function documentBlocks(content: string): { text: string; heading: boolean }[] {
  return content.split(/(\r?\n[\t ]*\r?\n)/).map(text => ({
    text,
    heading: /^\d+\. [^\r\n]{1,100}$/.test(text) || (/^[^\r\n]{1,75}$/.test(text) && !/[.!?:]$/.test(text) && !/^[-(]/.test(text)),
  }));
}
const printScript = 'document.getElementById("print").addEventListener("click",()=>window.print());';
export const previewCsp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${createHash('sha256').update(printScript).digest('base64')}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
export function renderPrivateDocumentHtml(doc: PreviewDocument, collection: 'documents' | 'card-documents' = 'card-documents'): string {
  const exportPath = `/api/${collection}/${encodeURIComponent(doc.id)}/export?version=${doc.version}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer"><title>${escape(doc.title)} · Private draft</title><style>
*{box-sizing:border-box}body{margin:0;background:#f1f3f5;color:#202733;font:16px/1.7 system-ui,sans-serif}header{max-width:850px;margin:32px auto 20px;padding:0 24px}header p{margin:8px 0}h1{font-size:clamp(24px,4vw,34px);line-height:1.2;overflow-wrap:anywhere}.state{font-weight:700;color:#755013}.actions{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0}a,button{font:inherit;color:#193f6a}button,.actions a{padding:8px 14px;border:1px solid #687587;border-radius:5px;background:white;text-decoration:none;cursor:pointer}.fingerprint{font:12px/1.6 monospace;overflow-wrap:anywhere;color:#526071}article{max-width:850px;margin:0 auto 48px;padding:48px 64px;background:white;border:1px solid #dce0e5;box-shadow:0 4px 20px #172b4d0a;font:18px/1.7 Georgia,serif}.block{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;orphans:3;widows:3}.heading{font:bold 20px/1.5 system-ui,sans-serif;break-after:avoid-page}.gap{line-height:.6}.print-label{display:none}@media(max-width:600px){header{margin-top:20px;padding:0 20px}article{padding:28px 22px;border-left:0;border-right:0;font-size:17px}.heading{font-size:19px}}@page{size:A4;margin:18mm 18mm 20mm}@media print{body{background:white;color:black}header{margin:0;padding:0}header h1,header p,.actions,.fingerprint{display:none}.print-label{display:block;font:10px system-ui,sans-serif;color:#555;border-bottom:1px solid #aaa;padding-bottom:8px;margin-bottom:16px}article{margin:0;padding:0;max-width:none;border:0;box-shadow:none;font-size:11pt;line-height:1.55}.heading{font-size:13pt}}
</style></head><body><header><p class="state">Private · Draft for review · Staff only</p><h1>${escape(doc.title)}</h1><p>Review only. This view does not send or sign the document.</p><nav class="actions" aria-label="Document actions"><a href="${exportPath}&amp;format=pdf">Download PDF</a><button id="print" type="button">Print / Save as PDF</button><a href="${exportPath}&amp;format=txt">Download source text</a></nav><p class="fingerprint">Saved version ${doc.version} · Source SHA-256: ${sourceHash(doc.content)}</p><div class="print-label">Private · Draft for review · Version ${doc.version}</div></header><article aria-label="Document text" id="document-text">${documentBlocks(doc.content).map(block => /^\s*$/.test(block.text) ? `<span class="block gap">${escape(block.text)}</span>` : `<${block.heading ? 'h2' : 'p'} class="block${block.heading ? ' heading' : ''}">${escape(block.text)}</${block.heading ? 'h2' : 'p'}>`).join('')}</article><script>${printScript}</script></body></html>`;
}
export class DocumentPdfEncodingError extends Error {}

/** Same exact saved source as the HTML. No legal boilerplate, normalization or truncation. */
export async function renderPrivateDocumentPdf(doc: PreviewDocument): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = pdf.embedStandardFont(StandardFonts.TimesRoman);
  const bold = pdf.embedStandardFont(StandardFonts.TimesRomanBold);
  const ui = pdf.embedStandardFont(StandardFonts.Helvetica);
  // Fail explicitly rather than dropping/replacing unsupported source characters.
  try { regular.encodeText(doc.content.replace(/[\r\n\t]/g, ' ')); }
  catch { throw new DocumentPdfEncodingError('PDF cannot encode this document’s characters. Use Print / Save as PDF or download the unchanged source text.'); }
  const width = 470, left = 60, bottom = 65, top = 774;
  let page = pdf.addPage([595.28, 841.89]), y = top;
  const newPage = (): void => { page = pdf.addPage([595.28, 841.89]); y = top; };
  function rows(value: string, font: PDFFont, size: number): string[] {
    const lines: string[] = [];
    for (const sourceLine of value.split(/\r?\n/)) {
      let row = '';
      // Retain whitespace as well as words; split very long words without clipping.
      for (const word of sourceLine.replace(/\t/g, '    ').match(/\s+|\S+/g) || []) {
        if (row && font.widthOfTextAtSize(row + word, size) > width) { lines.push(row); row = ''; }
        for (const char of word) {
          if (font.widthOfTextAtSize(row + char, size) > width) { lines.push(row); row = ''; }
          row += char;
        }
      }
      lines.push(row);
    }
    return lines;
  }
  for (const block of documentBlocks(doc.content)) {
    if (/^\s*$/.test(block.text)) { y -= 12; continue; }
    const size = block.heading ? 13 : 11.5, font = block.heading ? bold : regular, leading = block.heading ? 19 : 17;
    const lines = rows(block.text, font, size);
    // Keep a heading with the next paragraph, and at least two lines at a page boundary.
    if (y - leading * Math.min(lines.length + (block.heading ? 2 : 0), 4) < bottom) newPage();
    for (let index = 0; index < lines.length; index++) {
      if (y < bottom || (lines.length - index === 2 && y - leading < bottom)) newPage();
      page.drawText(lines[index], { x: left, y, font, size }); y -= leading;
    }
  }
  const pages = pdf.getPages();
  pages.forEach((value, index) => {
    value.drawText('PRIVATE / DRAFT FOR REVIEW', { x: left, y: 810, font: ui, size: 8, color: rgb(.35, .35, .35) });
    value.drawText(`Version ${doc.version} | Page ${index + 1} of ${pages.length}`, { x: left, y: 35, font: ui, size: 8 });
  });
  pdf.setTitle('Private document - draft for review');
  pdf.setSubject(`Source SHA-256: ${sourceHash(doc.content)}`);
  // An embedded source provides byte-for-byte provenance alongside the readable pages.
  await pdf.attach(Buffer.from(doc.content, 'utf8'), 'source.txt', { mimeType: 'text/plain', description: 'Exact saved UTF-8 source used for this draft' });
  return pdf.save();
}

/** Only call after the document route has resolved the staff actor and saved document. */
export async function privateDocumentResponse(doc: PreviewDocument, collection: 'documents' | 'card-documents', action: string, format: string, version?: string): Promise<LambdaResponse | null> {
  if (version !== undefined && version !== String(doc.version)) return json(409, { error: 'Document changed; reload the preview before exporting' });
  const headers = { ...privateDocumentHeaders, 'X-Document-Source-SHA256': sourceHash(doc.content), 'X-Document-Version': String(doc.version) };
  if (action === 'preview') return { statusCode: 200, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': previewCsp }, body: renderPrivateDocumentHtml(doc, collection) };
  if (format !== 'pdf') return null;
  try {
    return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="document-draft.pdf"' }, body: Buffer.from(await renderPrivateDocumentPdf(doc)).toString('base64'), isBase64Encoded: true };
  } catch (error) {
    if (error instanceof DocumentPdfEncodingError) return json(422, { error: error.message });
    throw error;
  }
}
