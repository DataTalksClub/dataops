import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=resolve(process.argv[2]);
const {getDocument}=await import(pathToFileURL(resolve(root,'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
const stream='BT /F1 12 Tf 30 750 Td (Sanitized artifact PDF) Tj ET';
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
let pdf='%PDF-1.4\n';const offsets=[];for(const [i,value]of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${value}\nendobj\n`;}
const xref=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const task=getDocument({data:new Uint8Array(Buffer.from(pdf)),isEvalSupported:false,verbosity:0});
try{const doc=await task.promise;const page=await doc.getPage(1);const content=await page.getTextContent();assert.ok(content.items.some(item=>item.str==='Sanitized artifact PDF'));}finally{await task.destroy();}
console.log('Packaged PDF.js and adjacent worker extracted sanitized PDF text.');
