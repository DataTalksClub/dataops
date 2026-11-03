import {test} from 'node:test';
import assert from 'node:assert/strict';
import { extractFinanceText, convertExtractedFinance } from '../src/invoices/financeExtraction';
import type { LlmExtraction } from '../src/invoices/llm';
import {validateFields} from '../src/invoices/model';
const facts:LlmExtraction={docType:'invoice',direction:'expense',counterparty:'Example Tools GmbH',invoiceNumber:'INV-123',date:'2026-10-01',currency:'EUR',net:'100.00',vat:'19.00',gross:'119.00',vatRate:'19',reverseCharge:false,paymentChannel:null,description:'Hosting',confidence:'high',uncertainFields:[]};
const llm=(fields=facts)=>async()=>({fields,model:'recorded',latencyMs:1,usage:{inputTokens:100,outputTokens:50}});
const unknown='Example Tools GmbH\nInvoice number: INV-123\nInvoice date: 2026-10-01\nNet EUR 100.00\nVAT 19% EUR 19.00\nTotal: EUR 119.00';

test('unknown layouts use the reader and preserve net/VAT and indicative EUR amounts',async()=>{
 const r=await convertExtractedFinance(await extractFinanceText(unknown,{llm:llm()}));
 assert.equal(r.fields.netAmount,'100.00');assert.equal(r.fields.vatAmount,'19.00');assert.equal(r.fields.grossAmountEur,'119.00');assert.equal(r.fields.amountEur,undefined);
 assert.equal(r.extraction.needsReview,false);assert.deepEqual(validateFields(r.fields),[]);
});
test('recurring AWS layout validates all amounts and skips the reader',async()=>{
 const text='VAT Invoice\nAmazon Web Services EMEA SARL\nVAT Invoice Number: EUINDE26-123\nVAT Invoice Date: October 1, 2026\nTOTAL AMOUNT USD 119.00\nTOTAL VAT USD 19.00\nNet Charges (After Credits/Discounts, excl. Tax) USD 100.00\nVAT - 19% USD 19.00';
 const r=await extractFinanceText(text,{llm:async()=>{throw new Error('reader must not run');}});
 assert.equal(r.extraction.method,'template:aws');assert.equal(r.fields.netAmount,'100.00');assert.equal(r.extraction.needsReview,false);
 const failed=await extractFinanceText(text.replace('USD 119.00','USD 120.00'),{llm:llm()});
 assert.equal(failed.extraction.method,'openai');assert.ok(failed.extraction.issues.includes('disagreement:gross'));
 const stale=await extractFinanceText(text,{expectedPeriod:'2026-09',llm:llm()});assert.ok(stale.extraction.issues.includes('unexpected:period'));
});
test('Finom recipient and zero VAT use the full layout rather than issuer heuristics',async()=>{
 const text='DataTalks.Club Example Street 1\n10439 Berlin\nExample Customer GmbH\nExample Street 1\nInvoice No. 202610/01\nIssue date: 01.10.2026\nTotal taxable 1.000,00 €\n1.000,00 €\nWorkshop 1 event 1.000,00 € 0 1.000,00 €\nItems Quantity Unit Price (net) VAT (%) Amount excl. VAT\nCreated with Finom.co';
 const r=await extractFinanceText(text,{llm:async()=>{throw Error('no call');}});
 assert.equal(r.extraction.method,'template:finom');assert.equal(r.fields.counterparty,'Example Customer GmbH');assert.equal(r.extraction.direction,'income');assert.equal(r.fields.vatAmount,'0.00');
});
test('reader outage keeps the document reviewable and does not invent VAT',async()=>{
 const r=await extractFinanceText(unknown,{llm:async()=>{throw Error('secret must not leak');}});
 assert.equal(r.extraction.method,'regex-fallback');assert.equal(r.extraction.needsReview,true);assert.ok(!JSON.stringify(r).includes('secret must not leak'));
});
test('arithmetic discrepancies and uncertainty flag review; a refund retains its own full number',async()=>{
 const r=await extractFinanceText(unknown,{llm:llm({...facts,net:'90.00',uncertainFields:['net']})});
 assert.ok(r.extraction.issues.includes('inconsistent:net+vat=gross'));assert.ok(r.extraction.issues.includes('disagreement:net'));
 const refund=await extractFinanceText('Credit note\nRefund EUR 119.00\nAdjusted invoice total EUR 20.00',{llm:llm({...facts,docType:'credit_note',direction:'expense',invoiceNumber:'EXAMPLE-0001-CN-01'})});
 assert.equal(refund.extraction.direction,'expense');
 assert.equal(refund.fields.subtype,'Refund');assert.equal(refund.fields.invoiceNumber,'EXAMPLE-0001-CN-01');assert.equal(refund.fields.amount,'119.00');
});

test('a new upload extracts finance fields before completion returns and a later evidence link populates VAT',async()=>{
 const {PDFDocument,StandardFonts}=await import('pdf-lib');
 const {Readable}=await import('node:stream');
 const {createHash}=await import('node:crypto');
 const {startLocal,stopLocal,createTables}=await import('../scripts/local-dynamodb');
 const {getClient}=await import('../src/db/client');
 const {setBookkeepingStorageForTests}=await import('../src/routes/bookkeepingShared');
 const {handleBookkeepingDocumentRoutes}=await import('../src/routes/bookkeepingDocuments');
 const {handleBookkeepingResourceRoutes}=await import('../src/routes/bookkeepingResources');
 const {putBookkeepingItem,getBookkeepingItem}=await import('../src/db/bookkeeping');
 const pdf=await PDFDocument.create();const page=pdf.addPage();const font=await pdf.embedFont(StandardFonts.Helvetica);
 const lines=['Hetzner Online GmbH','Invoice no.: 123456789','Invoice date: 01/10/2026','Tax code Tax rate','A1 19 %','Total € 100.00 € 19.00 € 119.00'];
 lines.forEach((line,i)=>page.drawText(line,{x:40,y:750-i*22,size:12,font}));
 const bytes=Buffer.from(await pdf.save());
 const saved=process.env.BOOKKEEPING_DOCUMENTS_BUCKET;process.env.BOOKKEEPING_DOCUMENTS_BUCKET='synthetic-versioned-bucket';process.env.BOOKKEEPING_DOCUMENTS_KMS_KEY='synthetic-kms-key';
 const port=await startLocal();const client=await getClient(port);await createTables(client);
 setBookkeepingStorageForTests({send:async(command:any)=>command.constructor.name==='GetObjectCommand'?{Body:Readable.from([bytes]),VersionId:'v1'}:{ContentLength:bytes.length,ContentType:'application/pdf',VersionId:'v1'}} as any,async()=> 'https://upload.invalid/signed');
 const invoke=async(path:string,body:any)=>{
   const event={httpMethod:'POST',path,headers:{},body:JSON.stringify(body)};
   return await handleBookkeepingDocumentRoutes(path,'POST',event,client)||await handleBookkeepingResourceRoutes(path,'POST',event,client);
 };
 try {
   const prepared=await invoke('/api/bookkeeping/documents/prepare',{sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length,documentType:'invoice',idempotencyKey:'finance-arrival-test',sourceRef:'finance-arrival-test'});
   assert.equal(prepared?.statusCode,201);const id=JSON.parse(prepared!.body).document.id;
   const completed=await invoke(`/api/bookkeeping/documents/${id}/complete`,{idempotencyKey:'finance-arrival-test'});
   assert.equal(completed?.statusCode,200);const document=JSON.parse(completed!.body).document;
   assert.equal(document.facts.method,'template:hetzner');assert.equal(document.facts.vatAmount,'19.00');assert.equal(document.facts.extraction.needsReview,false);
   const transaction=(await putBookkeepingItem(client,'bookkeeping',{amount:'119.00',currency:'EUR',counterparty:'Hetzner',transactionDate:'2026-10-01',entryType:'expense'})).item;
   assert.equal((await invoke('/api/bookkeeping/links',{documentId:id,transactionId:transaction.id,coverageType:'evidence'}))?.statusCode,201);
   const row=await getBookkeepingItem(client,'bookkeeping',transaction.id);
   assert.equal(row?.vatAmount,'19.00');assert.equal(row?.netAmount,'100.00');assert.equal(row?.amountEur,undefined);
 } finally {await stopLocal();if(saved===undefined)delete process.env.BOOKKEEPING_DOCUMENTS_BUCKET;else process.env.BOOKKEEPING_DOCUMENTS_BUCKET=saved;}
});

test('date-only template fields are independent of the server timezone and refund boilerplate',async()=>{
 const saved=process.env.TZ;process.env.TZ='Europe/Berlin';
 try {
  const t='Intuit Mailchimp\nMailchimp Receipt MC12345678\nDate Paid: January 20, 2026\nIssued by\nMailchimp c/o The Rocket Science Group, LLC\nPremium plan\n200 contacts\n€100.00\nIf a refund is required, it will be issued.\nTax was not applied to this purchase. The reverse charge mechanism applies.';
  const result=await extractFinanceText(t,{llm:async()=>{throw Error('must skip');}});
  assert.equal(result.extraction.method,'template:mailchimp');assert.equal(result.fields.transactionDate,'2026-01-20');assert.equal(result.extraction.direction,'expense');assert.equal(result.fields.subtype,undefined);
 } finally {if(saved===undefined)delete process.env.TZ;else process.env.TZ=saved;}
});

test('an unlabeled rate remains unknown when explicit subtotal and total establish zero VAT',async()=>{
 const t='Example Tools GmbH\nInvoice number: INV-123\nInvoice date: 2026-10-01\nSubtotal EUR 100.00\nTotal: EUR 100.00';
 const r=await extractFinanceText(t,{llm:llm({...facts,net:null,vat:null,gross:'100.00',vatRate:null})});
 assert.equal(r.fields.netAmount,'100.00');assert.equal(r.fields.vatAmount,'0.00');assert.equal(r.fields.vatRate,undefined);assert.ok(r.extraction.issues.includes('missing:vatRate'));
});

test('the eval CLI checks recorded synthetic documents offline in both modes and fails an amount regression',async()=>{
 const {mkdtemp,writeFile,readFile,mkdir,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join,resolve}=await import('node:path');
 const {createHash}=await import('node:crypto');const {spawnSync}=await import('node:child_process');
 const {EXTRACTION_PROMPT,EXTRACTION_SCHEMA}=await import('../src/invoices/llm');
 const dir=await mkdtemp(join(tmpdir(),'invoice-eval-'));const model='gpt-6-luna';
 try {
  await mkdir(join(dir,'text'));await mkdir(join(dir,'eval-cache'));
  await writeFile(join(dir,'index.json'),JSON.stringify([{id:'synthetic',file:join(dir,'synthetic.pdf'),kind:'synthetic'}]));
  await writeFile(join(dir,'text','synthetic.txt'),unknown);
  await writeFile(join(dir,'gold.json'),JSON.stringify({synthetic:facts}));
  const fingerprint=createHash('sha256').update(EXTRACTION_PROMPT+unknown+model).update('').update(JSON.stringify(EXTRACTION_SCHEMA)).digest('hex');
  const recording=join(dir,'eval-cache',`${fingerprint}.json`);
  const record=(fields:LlmExtraction)=>JSON.stringify({fields,model,latencyMs:12,usage:{inputTokens:100,outputTokens:100}});
  await writeFile(recording,record(facts));
  // Tests run both from repo root and via npm --prefix backend test.
  const script=resolve(__dirname,'../scripts/extract-eval.ts');
  for(const mode of ['full','openai']) {
   const run=spawnSync(process.execPath,['--import','tsx',script,'--corpus',dir,'--gold',join(dir,'gold.json'),'--mode',mode,'--model',model,'--offline','--check'],{encoding:'utf8'});
   assert.equal(run.status,0,run.stderr);
   const report=JSON.parse(await readFile(join(dir,`${mode}-${model}.json`),'utf8'));
   assert.equal(report.documents,1);assert.equal(report.failures,0);assert.equal(report.accuracy.gross.accuracy,1);assert.equal(report.costPerDocumentUsd,0.00006);
  }
  await writeFile(recording,record({...facts,gross:'120.00'}));
  const regression=spawnSync(process.execPath,['--import','tsx',script,'--corpus',dir,'--gold',join(dir,'gold.json'),'--mode','openai','--model',model,'--offline','--check'],{encoding:'utf8'});
  assert.equal(regression.status,1);assert.match(regression.stderr,/Accuracy check failed/);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('a partial refund uses credited subtotal rather than the original invoice subtotal',async()=>{
 const text='Example Tools GmbH\nRefund\nInvoice number: EXAMPLE-123-CN-01\nDate issued: October 1, 2026\nOriginal subtotal $100.00\nSubtotal $100.00\nTotal $100.00\n$25.00 refunded on October 1, 2026\nCredited subtotal - $25.00\nCredited total - $25.00\nAdjusted invoice total $75.00';
 const r=await extractFinanceText(text,{llm:llm({...facts,docType:'credit_note',direction:'income',invoiceNumber:'EXAMPLE-123-CN-01',currency:'USD',gross:'25.00',net:null,vat:null,vatRate:null})});
 assert.equal(r.fields.amount,'25.00');assert.equal(r.fields.netAmount,'25.00');assert.equal(r.fields.vatAmount,'0.00');assert.equal(r.fields.subtype,'Refund');assert.equal(r.extraction.direction,'expense');
});

test('distinguishes DataTalks.Club customer credit notes from supplier refunds and clears ambiguous credit-note amounts',async()=>{
 const finomCn='DataTalks.Club\nMusterstraße 1\n10115 Berlin\nExample Agency\nCredit note No. 202604/24-CN\nCredit note date 24.04.2026\nDescription\nSponsorship adjustment\nVAT (%)\n1 0 -1.550,00 €\nTotal taxable -1.550,00 € -1.550,00 €\nCreated with Finom.co';
 const customer=await extractFinanceText(finomCn);
 assert.equal(customer.extraction.documentType,'credit_note');
 assert.equal(customer.extraction.direction,'income');
 assert.equal(customer.fields.subtype,undefined);
 assert.equal(customer.fields.counterparty,'Example Agency');
 assert.equal(customer.fields.amount,'1550.00');

 const ambiguousText='Credit note\nCredit note number EX-0001-CN-01\nDate issued October 30, 2026\nExample Supplier GmbH\n$120.00 refunded on October 30, 2026\nCredited total $100.00\nAdjusted invoice total $20.00\n';
 const ambiguous=await extractFinanceText(ambiguousText,{llm:llm({...facts,docType:'credit_note',direction:'expense',invoiceNumber:'EX-0001-CN-01',currency:'USD',gross:'100.00',net:'100.00',vat:'0.00',vatRate:'0'})});
 assert.equal(ambiguous.fields.amount,undefined);
 assert.equal(ambiguous.extraction.needsReview,true);
 assert.deepEqual(ambiguous.extraction.candidates?.sort(),['100.00','120.00']);

 const conflictingLlm='Credit note\nCredit note number EX-0002-CN-01\nDate issued October 30, 2026\nExample Supplier GmbH\n$100.00 refunded on October 30, 2026\nAdjusted invoice total $20.00\n';
 const conflict=await extractFinanceText(conflictingLlm,{llm:llm({...facts,docType:'credit_note',direction:'expense',invoiceNumber:'EX-0002-CN-01',currency:'USD',gross:'20.00',net:'20.00',vat:'0.00',vatRate:'0'})});
 assert.equal(conflict.fields.amount,undefined);
 assert.equal(conflict.extraction.needsReview,true);
 assert.deepEqual(conflict.extraction.candidates?.sort(),['100.00','20.00']);
});
