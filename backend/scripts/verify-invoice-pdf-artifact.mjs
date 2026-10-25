import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const root=resolve(process.argv[2]);
const {getDocument}=await import(pathToFileURL(resolve(root,'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
const stream='BT /F1 12 Tf 30 750 Td (Sanitized artifact PDF) Tj ET';
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
let pdf='%PDF-1.4\n';const offsets=[];for(const [i,value]of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${value}\nendobj\n`;}
const xref=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const task=getDocument({data:new Uint8Array(Buffer.from(pdf)),isEvalSupported:false,verbosity:0});
try{const doc=await task.promise;const page=await doc.getPage(1);const content=await page.getTextContent();assert.ok(content.items.some(item=>item.str==='Sanitized artifact PDF'));}finally{await task.destroy();}
console.log('Packaged PDF.js and adjacent worker extracted sanitized PDF text.');
// Resolve the compiled production extractor from the payload, so this cannot
// pass by borrowing workspace dependencies absent from the deployed Lambda.
const requireFromPayload = createRequire(resolve(root, 'package.json'));
const { pdfText, extractInvoiceText } = requireFromPayload('./verify-invoice-extraction.cjs');
const bytes = readFileSync(process.argv[3] || new URL('../tests/fixtures/contabo/outline-invoice.pdf', import.meta.url));
const parsed = extractInvoiceText(await pdfText(bytes));
assert.equal(parsed.extraction.method, 'deterministic-contabo');
assert.equal(parsed.fields.counterparty, 'Contabo');
assert.equal(parsed.fields.amount, '70.44');
assert.equal(parsed.fields.currency, 'EUR');
assert.equal(parsed.fields.transactionDate, '2026-10-21');
assert.equal(parsed.fields.invoiceNumber, '900001000P261021');
assert.equal(parsed.fields.vatId, 'DE123456789');
console.log('Packaged offline OCR rendered and extracted the synthetic outline-only Contabo invoice.');
