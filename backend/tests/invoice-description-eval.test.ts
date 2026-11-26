import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {extractFinanceText,extractFinancePdf} from '../src/invoices/financeExtraction';
import {pdfText} from '../src/invoices/extract';
import {cleanDescription} from '../src/invoices/description';
import type {LlmExtraction} from '../src/invoices/llm';

// Description eval: every case runs the production extraction path
// (extractFinanceText: templates, then the reader, then the description
// resolver) with a recorded reader answer standing in for the OpenAI call.
type Case={id:string;note:string;text:string;hints?:{subject?:string;sender?:string};reader:'unused'|Partial<LlmExtraction>;expected:{description:string|null;method?:string;needsReview?:boolean;issues?:string[];descriptionFrom?:string}};
const cases:Case[]=JSON.parse(readFileSync(join(__dirname,'fixtures/extraction-gold/descriptions.json'),'utf8'));
const blank:LlmExtraction={docType:'invoice',direction:'expense',counterparty:null,invoiceNumber:null,date:null,currency:null,net:null,vat:null,gross:null,vatRate:null,reverseCharge:false,paymentChannel:null,description:null,confidence:'high',uncertainFields:[]};
const reader=(c:Case)=>async()=>{
  if(c.reader==='unused') throw new Error('the reader must not run for this layout');
  return {fields:{...blank,...c.reader} as LlmExtraction,model:'recorded',latencyMs:1,usage:{inputTokens:0,outputTokens:0}};
};
// Description issues are advisory: they never block amount auto-attach or reconciliation.
// What the ledger shows when a draft has no description at all.
const FALLBACK_LABELS=/^(?:business expense|business income|expense|invoice|receipt|payment|subscription|services?|sponsor payment)/i;

for(const c of cases) {
  test(`description eval: ${c.id}`,async()=>{
    const r=await extractFinanceText(c.text,{hints:c.hints,llm:reader(c)});
    assert.equal(r.fields.description??null,c.expected.description,c.note);
    if(c.expected.method) assert.equal(r.extraction.method,c.expected.method);
    if(c.expected.needsReview!==undefined) assert.equal(r.extraction.needsReview,c.expected.needsReview);
    for(const issue of c.expected.issues||[]) assert.ok(r.extraction.issues.includes(issue),`missing issue ${issue}: ${r.extraction.issues.join(',')}`);
    if(r.fields.description) {
      assert.ok(!FALLBACK_LABELS.test(r.fields.description),'generic label stored as description');
      assert.notEqual(r.fields.description.toLowerCase(),String(r.fields.counterparty).toLowerCase());
      if(c.expected.descriptionFrom==='document') assert.ok(!c.hints?.subject||!r.fields.description.toLowerCase().includes(c.hints.subject.toLowerCase()));
    } else {
      assert.ok(r.extraction.issues.includes('missing:description'),'an empty description must be flagged for review');
    }
  });
}

test('description eval: a real PDF goes through pdfText and the same production path',async()=>{
  const pdf=await PDFDocument.create();const page=pdf.addPage();const font=await pdf.embedFont(StandardFonts.Helvetica);
  const lines=['Invoice','Invoice number INV-88','Invoice date: 2026-10-03','Example Hosting GmbH','Description Qty Unit price Amount','Dedicated Server EX44, October 2026','1 40.00 40.00','Subtotal 40.00','VAT 0% 0.00','Total 40.00 EUR'];
  lines.forEach((line,i)=>page.drawText(line,{x:40,y:750-i*22,size:12,font}));
  const bytes=Buffer.from(await pdf.save());
  const fields={...blank,counterparty:'Example Hosting GmbH',invoiceNumber:'INV-88',date:'2026-10-03',currency:'EUR',net:'40.00',vat:'0.00',gross:'40.00',vatRate:'0'};
  const r=await extractFinancePdf(bytes,{textReader:pdfText,llm:async()=>({fields,model:'recorded',latencyMs:1,usage:{inputTokens:0,outputTokens:0}})});
  assert.equal(r.fields.description,'Dedicated Server EX44, October 2026');
});

test('cleanDescription rejects generic, vendor-only and number-only values',()=>{
  for(const value of ['Business expense','Invoice','receipt','Payment','Subscription','Invoice INV-123','Receipt from Anthropic','Sponsor payment for deal abc','Rechnung 2026-001','Rechnungsnummer 2026-001','Rechnungsnr. 2026-001','Quittung #12','Zahlung','Facture 2026-001','','--','12345']) assert.equal(cleanDescription(value),undefined,value);
  assert.equal(cleanDescription('Anthropic, PBC',{counterparty:'Anthropic, PBC'}),undefined);
  assert.equal(cleanDescription('Max plan - 20x'),'Max plan - 20x');
  assert.equal(cleanDescription('x'.repeat(300))?.length,120);
});
