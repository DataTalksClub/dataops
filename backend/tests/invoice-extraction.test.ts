import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractInvoiceText, normalizeSubject, pdfText } from '../src/invoices/extract';
import { missingEvidence, validateFields } from '../src/invoices/model';
import { sheetValues, validateHeaders } from '../src/invoices/providers';
import { restoredRecord } from '../src/export/portableValidate';
import type { Invoice } from '../src/invoices/model';
export const headers=['Date sent','Date paid','Provider','What','Price, $','Price, EUR','Statement','Count','Comment','Entry Type','Type','Period','Category'];
function pdf(text:string) {
  const stream='BT /F1 10 Tf 30 750 Td '+text.split('\n').map((line,i)=>(i?'0 -15 Td ':'')+`(${line.replace(/[()\\]/g,'\\$&')}) Tj`).join('\n')+' ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let out='%PDF-1.4\n';const offsets=[0];for(const [i,obj] of objects.entries()){offsets.push(Buffer.byteLength(out));out+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
  const xref=Buffer.byteLength(out);out+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(x=>`${String(x).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}
const aws='Amazon Web Services\nVAT Invoice Number: EUINDE00-1234567\nAccount ID: 000000000001\nVAT Invoice Date: October 1, 2026\nTOTAL AMOUNT USD 120.50\nbilling period September 1 - September 30, 2026';
test('issuer in a legal footer supplies provider without guessing refund amounts',()=>{
  const parsed=extractInvoiceText('Your plans were canceled.\nUnused amounts are being refunded.\n© 2026 Example Cloud LLC');
  assert.equal(parsed.fields.counterparty,'Example Cloud LLC');
  assert.equal(parsed.fields.amount,undefined);
  assert.equal(parsed.fields.paymentEvidence,undefined);
});
test('German invoice date and legal issuer before a footer address are extracted',()=>{
  const parsed=extractInvoiceText('Rechnung\nRechnungsdatum: 13.10.2026\nExample Handel GmbH & Co. KG - Musterstraße 2 - 12345 Berlin\nSitz: Berlin - Registergericht Berlin');
  assert.equal(parsed.fields.counterparty,'Example Handel GmbH & Co. KG');
  assert.equal(parsed.fields.transactionDate,'2026-10-13');
  assert.equal(extractInvoiceText('Rechnungsdatum: 31.02.2026').fields.transactionDate,undefined);
});
test('Contabo outline PDF uses local OCR for proforma number, date, gross total and customer VAT', async () => {
  const bytes = readFileSync(new URL('./fixtures/contabo/outline-invoice.pdf', import.meta.url));
  const load = new Function('return import("pdfjs-dist/legacy/build/pdf.mjs")') as () => Promise<typeof import('pdfjs-dist')>;
  const task = (await load()).getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    const page = await (await task.promise).getPage(1);
    const content = await page.getTextContent();
    assert.equal(content.items.map(item => 'str' in item ? item.str : '').join('').trim(), 'VAT-ID: DE123456789');
  } finally { await task.destroy(); }
  const parsed = extractInvoiceText(await pdfText(bytes));
  assert.equal(parsed.extraction.method, 'deterministic-contabo');
  assert.equal(parsed.fields.counterparty, 'Contabo');
  assert.equal(parsed.fields.amount, '70.44');
  assert.equal(parsed.fields.currency, 'EUR');
  assert.equal(parsed.fields.transactionDate, '2026-10-21');
  assert.equal(parsed.fields.invoiceNumber, '900001000P261021');
  assert.equal(parsed.fields.vatId, 'DE123456789');
  assert.ok(parsed.extraction.evidence.some(item => item.includes('customer VAT-ID')));
  assert.equal(parsed.fields.amountEur, undefined);
  assert.equal(parsed.fields.paymentEvidence, undefined);
});
test('Contabo gross total wins over net, tax and line amounts; partial anchors stay unfilled', () => {
  const text = 'VAT-ID: DE123456789\nContabo GmbH\nProforma-Rechnung: 900001000P261021\nDatum: 21.10.2026\nZwischensumme 70,44 €\nGesamt netto 59,19 €\n19.0% Umsatzsteuer 11,25 €\nGesamt brutto 70,44 €\nUSt-IdNr: DE267602842';
  const parsed = extractInvoiceText(text);
  assert.equal(parsed.fields.amount, '70.44');
  assert.equal(parsed.fields.vatId, 'DE123456789');
  assert.equal(extractInvoiceText(text.replace('Gesamt brutto 70,44 €', '')).fields.amount, undefined);
  assert.equal(extractInvoiceText(text.replace('Gesamt brutto 70,44 €', 'Gesamt brutto 7044 €')).fields.amount, undefined);
  assert.equal(extractInvoiceText(text.replace('Gesamt brutto 70,44 €', 'Gesamt brutto 1700,44 EUR')).fields.amount, '1700.44');
  assert.equal(extractInvoiceText(text.replace('21.10.2026', '31.02.2026')).fields.transactionDate, undefined);
});
test('body prose and a customer VAT footer do not become company names',()=>{
  const parsed=extractInvoiceText('Thank you for choosing our service\nVAT/GST Number DE000000000\nContact support for help');
  assert.equal(parsed.fields.counterparty,undefined);
  assert.equal(extractInvoiceText('Statement\nBill to\nCustomer Example LLC\nExample Street 1').fields.counterparty,undefined);
});
test('Stripe issuer skips page counters and recipient company-name fields',()=>{
  const parsed=extractInvoiceText('Page 1 of 2\nInvoice\nInvoice number EXAMPLE-0001\nDate of issue October 3, 2026\nDate due October 3, 2026\nVAT/GST Number DE000000000\nCompany name Synthetic Customer\nExample Cloud, Inc. @example\n100 Example Street\nBill to\nCustomer Example LLC\n$5.00 USD due October 3, 2026');
  assert.equal(parsed.fields.counterparty,'Example Cloud, Inc.');
  assert.equal(parsed.fields.transactionDate,'2026-10-03');
});
test('real sanitized PDF text extraction and AWS evidence leave actual EUR absent',async()=>{const parsed=extractInvoiceText(await pdfText(pdf(aws)));assert.equal(parsed.extraction.method,'deterministic-aws');assert.equal(parsed.fields.amount,'120.50');assert.equal(parsed.fields.transactionDate,'2026-10-01');assert.equal(parsed.fields.accountContext,'000000000001');assert.equal(parsed.fields.amountEur,undefined);assert.ok(missingEvidence(parsed.fields).includes('paymentEvidence'));});
test('Stripe receipt never treats EUR tax-display as bank payment',()=>{const p=extractInvoiceText('Receipt\nInvoice number ABCDEF00 \u0000 0001\nDate paid October 1, 2026\nExample Software\n$25.00 paid on October 1, 2026\nBill to\nSynthetic account\nVAT (€4.31)');assert.equal(p.extraction.method,'deterministic-stripe');assert.equal(p.fields.counterparty,'Example Software');assert.equal(p.fields.amountEur,undefined);assert.equal(p.fields.paidDate,'2026-10-01');});
test('issuer lines that are VAT/GST identifiers are skipped for the vendor and the email subject supplies the description',()=>{
  const p=extractInvoiceText('Receipt\nInvoice number ABCDEF10 \u0000 0002\nDate of issue October 14, 2026\nVAT/GST Number DE343190995\nOpenAI\n$25.00 paid on October 14, 2026\nBill to\nSynthetic account\nVAT (€4.31)',{subject:'Fwd: Your ChatGPT Plus subscription receipt',sender:'forwarder@example.net'});
  assert.equal(p.extraction.method,'deterministic-stripe');
  assert.equal(p.fields.counterparty,'OpenAI');
  assert.equal(p.fields.description,'ChatGPT Plus subscription');
  assert.equal(p.fields.invoiceNumber,'ABCDEF10-0002');
  assert.equal(p.fields.transactionDate,'2026-10-14');
  assert.equal(p.fields.amountEur,undefined);
  assert.ok(p.extraction.evidence.some(item=>item.includes('email subject')));
  assert.ok(!p.extraction.issues.some(issue=>issue.includes('email, not the document')));
});
test('generic European invoice: bare invoice number, D Month YYYY date, comma-decimal EUR total',()=>{
  const p=extractInvoiceText('Hetzner Online GmbH\nInvoice 20261-00457\nInvoice date 1 August 2026\nDedicated server CX42\nNet amount: 38.40 €\nTotal: 45,70 €');
  assert.equal(p.extraction.method,'deterministic-text');
  assert.equal(p.fields.counterparty,'Hetzner Online GmbH');
  assert.equal(p.fields.invoiceNumber,'20261-00457');
  assert.equal(p.fields.transactionDate,'2026-08-01');
  assert.equal(p.fields.amount,'45.70');
  assert.equal(p.fields.currency,'EUR');
  assert.equal(p.fields.description,'Dedicated server');
});
test('opaque document with a recognizable forwarded subject still names the provider',()=>{
  const p=extractInvoiceText('Scanned document image\npage 1 of 2',{subject:'Fwd: Amazon Web Services Invoice Available [Account: 1234]',sender:'operator@example.net'});
  assert.equal(p.extraction.method,'email-hints');
  assert.equal(p.fields.counterparty,'Amazon Web Services');
  assert.equal(p.fields.description,'Cloud services');
  assert.ok(p.extraction.issues.some(issue=>issue.includes('email, not the document')));
  assert.ok(missingEvidence(p.fields).includes('amount'));
});
test('labeled ISO date and statement payment evidence stay operator-owned',()=>{
  const p=extractInvoiceText('Synthetic Studio\nDate: 2026-09-02\nTotal due: $18.00\nPaid on 2026-09-03');
  assert.equal(p.fields.transactionDate,'2026-09-02');
  assert.equal(p.fields.paidDate,'2026-09-03');
  assert.equal(p.fields.amount,'18.00');
  assert.equal(p.fields.currency,'USD');
  assert.equal(p.fields.paymentEvidence,undefined);
});
test('subject normalization strips forwards, account brackets and availability suffixes',()=>{
  assert.equal(normalizeSubject('Fwd: FWD: Amazon Web Services Invoice Available [Account: 1234]'),'Amazon Web Services');
  assert.equal(normalizeSubject('Re: Your Receipt from Oct 2, 2026'),'Your Receipt from Oct 2, 2026');
  assert.equal(normalizeSubject(undefined),'');
});
test('unsupported or scanned PDF stays manual; malformed bytes rejected',async()=>{assert.equal(extractInvoiceText('').extraction.method,'manual');await assert.rejects(pdfText(Buffer.from('not pdf')));assert.equal(extractInvoiceText('Totally unrelated prose without anchors').fields.amount,undefined);});
test('review validation supports clearing values but disallows invented currency/date',()=>{assert.deepEqual(validateFields({amount:null,amountEur:null,quantity:null}),[]);assert.deepEqual(validateFields({transactionDate:'2026-02-30',currency:'ABC'}),['transactionDate','currency']);});
test('dynamic 13-column mapping EUR leaves USD blank and negative numbers',()=>{const invoice={id:'a'.repeat(64),fields:{transactionDate:'2026-10-01',paidDate:'2026-10-02',counterparty:'Example',description:'Service',currency:'EUR',amount:'10.25',amountEur:'10.25',paymentEvidence:'Operator actual payment'},source:{artifactId:'source-doc'}} as Invoice;const cells=sheetValues(invoice,headers);assert.equal(cells[4],'');assert.equal(cells[5],'-10.25');assert.equal(cells[9],'expense');assert.ok(cells[6].includes(invoice.id));assert.throws(()=>validateHeaders(['Provider']));});
test('restore clears in-flight lease and requires explicit reconciliation, retaining verified outcomes',()=>{const record={id:'restore',leaseOwner:'stale',leaseUntil:999999,status:'confirmed',destinations:{sheets:{state:'verified'}}};const restored=restoredRecord('invoice_records',record);assert.equal(restored.leaseOwner,undefined);assert.equal(restored.restoredNeedsReconciliation,true);assert.deepEqual(restored.destinations,record.destinations);});

test('EUR invoice and actual payment retain independent values with equivalent decimal formats',()=>{
  const fields={transactionDate:'2026-10-01',paidDate:'2026-10-02',counterparty:'Synthetic issuer',description:'Service',currency:'EUR',amount:'10.00',amountEur:'10',paymentEvidence:'Operator actual bank payment',invoiceNumber:'SYNTHETIC-1',accountContext:'Synthetic account',archiveRequired:true};
  assert.deepEqual(missingEvidence(fields),[]);
  assert.deepEqual(missingEvidence({...fields,amount:'1000000000.01',amountEur:'1000000000.01'}),[]);
  assert.deepEqual(missingEvidence({...fields,amountEur:'11',paymentEvidence:'Operator actual bank value includes separately reviewed fee'}),[]);
  assert.ok(missingEvidence({...fields,amountEur:'11',paymentEvidence:''}).includes('paymentEvidence'));
});
