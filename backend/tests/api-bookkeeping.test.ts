import { before, after, describe, it } from 'node:test';
import assert from 'node:assert';
import { handler } from '../src/handler';
import { createTables } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { setBookkeepingArchiveUploaderForTests, setBookkeepingStorageForTests } from '../src/routes/bookkeepingShared';
import { getBookkeepingItem, listBookkeepingItems, listTransactions, putBookkeepingItem, updateBookkeepingTransaction } from '../src/db/bookkeeping';
import { TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createSession } from '../src/db/sessions';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { handleBookkeepingTransactionRoutes } from '../src/routes/bookkeepingTransactions';
import { TABLE_BOOKKEEPING } from '../src/db/tableNames';

const invoke=(method:string,path:string,body?:unknown,headers?:Record<string,string>,query?:Record<string,string>)=>handler({httpMethod:method,path,headers:headers||{},body:body===undefined?null:JSON.stringify(body),queryStringParameters:query||null},{});
const valid={transactionDate:'2026-07-01',counterparty:'Synthetic Vendor',description:'Synthetic service',amount:'10.25',currency:'EUR',sourceType:'manual'};
describe('bookkeeping API',()=>{
  let client:DynamoDBDocumentClient;
  before(async()=>{const port=await startLocal();client=await getClient(port);await createTables(client);}); after(stopLocal);
  it('round-trips decimal strings and dates through CRUD',async()=>{let r=await invoke('POST','/api/bookkeeping/transactions',valid);assert.equal(r.statusCode,201);const created=JSON.parse(r.body);assert.equal(created.amount,'10.25');assert.match(created.id,/./);r=await invoke('GET','/api/bookkeeping/transactions');assert.ok(JSON.parse(r.body).items.some((item:any)=>item.id===created.id));r=await invoke('PUT',`/api/bookkeeping/transactions/${created.id}`,{paidDate:'2026-07-02',category:'software'});assert.equal(JSON.parse(r.body).paidDate,'2026-07-02');});
  it('rejects unaudited hard deletion of ledger rows',async()=>{const created=JSON.parse((await invoke('POST','/api/bookkeeping/transactions',valid)).body);const response=await invoke('DELETE',`/api/bookkeeping/transactions/${created.id}`);assert.equal(response.statusCode,405);assert.ok(JSON.parse(response.body).error.includes('void-ledger'));assert.ok(JSON.parse((await invoke('GET','/api/bookkeeping/transactions')).body).items.some((item:any)=>item.id===created.id));});
  it('persists canonical vendor labels while preserving the raw bank counterparty',async()=>{
    const created=JSON.parse((await invoke('POST','/api/bookkeeping/transactions',{...valid,counterparty:'Aws Emea SARL'})).body);
    assert.equal(created.counterparty,'Aws Emea SARL');assert.equal(created.counterpartyCanonical,'Amazon Web Services');
    const listed=JSON.parse((await invoke('GET','/api/bookkeeping/transactions')).body).items.find((item:any)=>item.id===created.id);
    assert.equal(listed.counterparty,'Aws Emea SARL');assert.equal(listed.counterpartyCanonical,'Amazon Web Services');
    const updated=JSON.parse((await invoke('PUT',`/api/bookkeeping/transactions/${created.id}`,{counterparty:'Google Workspace'})).body);
    assert.equal(updated.counterparty,'Google Workspace');assert.equal(updated.counterpartyCanonical,'Google');
  });
  it('backfills exact confident invoice matches through the protected operation',async()=>{
    const transaction=JSON.parse((await invoke('POST','/api/bookkeeping/transactions',{...valid,transactionDate:'1980-09-12',counterparty:'Go Daddy',amount:'178.49'})).body);
    const document=(await putBookkeepingItem(client,'document',{status:'active',documentType:'invoice',originalFilename:'domain-renewal.pdf',facts:{counterparty:'GoDaddy',amount:'178.49',currency:'EUR',transactionDate:'1980-09-10'}})).item;
    const result=await invoke('POST','/api/bookkeeping/auto-attach',{});
    assert.equal(result.statusCode,200);assert.equal(JSON.parse(result.body).attached,1);
    const links=JSON.parse((await invoke('GET','/api/bookkeeping/links')).body).items;
    assert.ok(links.some((link:any)=>link.transactionId===transaction.id&&link.documentId===document.id&&link.coverageType==='evidence'));
  });
  it('stores a rate source and an audit entry for existing-row corrections',async()=>{
    const created=JSON.parse((await invoke('POST','/api/bookkeeping/transactions',valid)).body);
    const response=await invoke('PUT',`/api/bookkeeping/transactions/${created.id}`,{category:'Work-related',subtype:'Subscription',amountEur:'9.25',rateSource:'ECB 23 Oct 2026'}, {'x-user-id':'synthetic-operator'});
    assert.equal(response.statusCode,200);
    const updated=JSON.parse(response.body);
    assert.equal(updated.category,'Work-related');assert.equal(updated.subtype,'Subscription');
    assert.equal(updated.amountEur,'9.25');assert.equal(updated.rateSource,'ECB 23 Oct 2026');
    assert.deepEqual(updated.audit.at(-1),{action:'updated',actor:'synthetic-operator',at:updated.audit.at(-1).at,changes:{category:{from:null,to:'Work-related'},subtype:{from:null,to:'Subscription'},amountEur:{from:null,to:'9.25'},rateSource:{from:null,to:'ECB 23 Oct 2026'}}});
    assert.ok(Number.isFinite(Date.parse(updated.audit.at(-1).at)));
  });
  it('rejects corrections over the audit byte budget without trimming retained history',async()=>{
    const created=JSON.parse((await invoke('POST','/api/bookkeeping/transactions',valid)).body);
    let updated:any,lastComment:string|undefined,rejected=false;
    for(let index=0;index<100;index++){
      const comment=`${index}: ${'x'.repeat(1950)}`;
      const response=await invoke('PUT',`/api/bookkeeping/transactions/${created.id}`,{comment});
      if(response.statusCode===413){rejected=true;break;}
      assert.equal(response.statusCode,200);
      updated=JSON.parse(response.body);
      lastComment=comment;
    }
    assert.equal(rejected,true);
    assert.ok(Buffer.byteLength(JSON.stringify(updated.audit),'utf8')<=128*1024);
    assert.ok(updated.audit.length<100);
    assert.equal(updated.comment,lastComment);
    const after=await getBookkeepingItem(client,'bookkeeping',created.id);
    assert.deepEqual(after?.audit,updated.audit);
    assert.equal(after?.comment,lastComment);
  });
  it('rejects an audit append over the byte budget without changing the transaction',async()=>{
    const created=JSON.parse((await invoke('POST','/api/bookkeeping/transactions',valid)).body);
    const audit=[{action:'historic',payload:'x'.repeat(128*1024-100)}];
    assert.ok(Buffer.byteLength(JSON.stringify(audit),'utf8')<=128*1024);
    const seeded=await updateBookkeepingTransaction(client,created.id,String(created.updatedAt),{...created,audit});
    const response=await invoke('PUT',`/api/bookkeeping/transactions/${created.id}`,{description:'Must not be stored'});
    assert.equal(response.statusCode,413);
    assert.match(JSON.parse(response.body).error,/no changes were saved/i);
    const after=await getBookkeepingItem(client,'bookkeeping',created.id);
    assert.deepEqual(after?.audit,seeded.audit);
    assert.equal(after?.description,seeded.description);
    assert.equal(after?.updatedAt,seeded.updatedAt);
  });
  it('rejects invalid data without echoing values',async()=>{const r=await invoke('POST','/api/bookkeeping/transactions',{...valid,amount:'NaN',currency:'EURO'});assert.equal(r.statusCode,400);assert.deepEqual(JSON.parse(r.body).fields.sort(),['amount','currency']);assert.ok(!r.body.includes('NaN'));});
  it('requires a real session for route-level CRUD without leaking records',async()=>{process.env.SKIP_AUTH='false';const unauthorized=await invoke('GET','/api/bookkeeping/transactions');assert.equal(unauthorized.statusCode,401);assert.equal(unauthorized.body.includes('Synthetic Vendor'),false);const session=await createSession(client,'synthetic-operator');const auth={Authorization:`Bearer ${session.token}`};const created=await invoke('POST','/api/bookkeeping/transactions',{...valid,description:'Session-authenticated synthetic'},auth);assert.equal(created.statusCode,201);const listed=await invoke('GET','/api/bookkeeping/transactions',undefined,auth);assert.equal(listed.statusCode,200);assert.ok(JSON.parse(listed.body).items.some((i:any)=>i.description==='Session-authenticated synthetic'));process.env.SKIP_AUTH='true';});
  it('validates many-to-many links and creates an immutable monthly snapshot',async()=>{
    const setup=await invoke('POST','/api/bookkeeping/accounts/setup');assert.equal(setup.statusCode,200);assert.equal(JSON.parse(setup.body).accounts.length,2);const setupRetry=await invoke('POST','/api/bookkeeping/accounts/setup');assert.equal(setupRetry.statusCode,200);assert.deepEqual(JSON.parse(setupRetry.body).accounts.map((a:any)=>a.id),JSON.parse(setup.body).accounts.map((a:any)=>a.id));
    const transaction=JSON.parse((await invoke('POST','/api/bookkeeping/transactions',{...valid,transactionDate:'2026-08-10'})).body);
    const accounts:any[]=JSON.parse(setup.body).accounts;
    for(const account of accounts) await putBookkeepingItem(client,'document',{documentType:'bank-statement',status:'active',accountId:account.id,statementMonth:'2026-08',originalFilename:'synthetic.pdf',contentType:'application/pdf',byteSize:9,sha256:createHash('sha256').update(`synthetic-${account.id}`).digest('hex'),s3Key:`documents/${account.id}`});
    const receipt=(await putBookkeepingItem(client,'document',{documentType:'receipt',status:'active',originalFilename:'receipt.pdf',contentType:'application/pdf',byteSize:9,sha256:createHash('sha256').update('synthetic-receipt').digest('hex'),s3Key:'documents/synthetic-receipt'})).item;
    const link=await invoke('POST','/api/bookkeeping/links',{documentId:receipt.id,transactionId:transaction.id,coverageType:'evidence'});assert.equal(link.statusCode,201);
    const duplicate=await invoke('POST','/api/bookkeeping/links',{documentId:receipt.id,transactionId:transaction.id,coverageType:'evidence'});assert.equal(duplicate.statusCode,200);assert.equal(JSON.parse(duplicate.body).id,JSON.parse(link.body).id);
    const snapshot=await invoke('POST','/api/bookkeeping/reports/snapshot',{month:'2026-08'});assert.equal(snapshot.statusCode,201);const report=JSON.parse(snapshot.body).report;assert.deepEqual(report.transactionIds,[transaction.id]);assert.equal(report.documentIds.length,3);
    const retry=await invoke('POST','/api/bookkeeping/reports/snapshot',{month:'2026-08'});assert.equal(retry.statusCode,200);assert.equal(JSON.parse(retry.body).report.id,report.id);
  });
  it('does not require legacy business setup statements for current monthly snapshots',async()=>{
    await invoke('POST','/api/bookkeeping/accounts/setup');
    const currentAccounts=[['synthetic-primary','Synthetic Business Account A'],['synthetic-secondary','Synthetic Business Account B']];
    const statementIds:string[]=[];
    for(const [id,displayName] of currentAccounts){
      await putBookkeepingItem(client,'account',{id,displayName,kind:'business',active:true},`business-account#current#${id}`);
      const statement=(await putBookkeepingItem(client,'document',{documentType:'bank-statement',status:'active',accountId:id,statementMonth:'2026-10',originalFilename:`${id}-october.pdf`,contentType:'application/pdf',byteSize:9,sha256:createHash('sha256').update(`statement-${id}-october`).digest('hex'),s3Key:`documents/${id}-october`})).item;
      statementIds.push(statement.id);
    }
    const listed=JSON.parse((await invoke('GET','/api/bookkeeping/accounts')).body).items;
    assert.deepEqual(listed.filter((account:any)=>String(account.id).startsWith('business-')).map((account:any)=>account.statementRequiredThroughMonth),['2026-09','2026-09']);
    const snapshot=await invoke('POST','/api/bookkeeping/reports/snapshot',{month:'2026-10'});
    assert.equal(snapshot.statusCode,201,snapshot.body);
    const report=JSON.parse(snapshot.body).report;
    assert.equal(report.reconciliation.businessStatementCount,2);
    assert.ok(statementIds.every((id)=>report.documentIds.includes(id)));
  });
  it('records VAT amounts and keeps tax and health-insurance entries out of monthly snapshots',async()=>{
    const bad=await invoke('POST','/api/bookkeeping/transactions',{...valid,description:'bad vat',vatAmount:'-1',vatCurrency:'eur'});assert.equal(bad.statusCode,400);assert.deepEqual(JSON.parse(bad.body).fields.sort(),['vatAmount','vatCurrency']);
    const income=JSON.parse((await invoke('POST','/api/bookkeeping/transactions',{...valid,transactionDate:'2026-09-05',description:'VAT income',entryType:'income',vatAmount:'19.00',vatCurrency:'EUR'})).body);
    await invoke('POST','/api/bookkeeping/transactions',{...valid,transactionDate:'2026-09-06',description:'VAT expense',entryType:'expense',vatAmount:'7.00',vatCurrency:'EUR'});
    await invoke('POST','/api/bookkeeping/transactions',{...valid,transactionDate:'2026-09-07',description:'Income tax payment',category:'Taxes',entryType:'expense',amount:'100.00'});
    await invoke('POST','/api/bookkeeping/transactions',{...valid,transactionDate:'2026-09-08',description:'Health insurance premium',category:'Health Insurance',entryType:'expense'});
    await invoke('POST','/api/bookkeeping/transactions',{...valid,transactionDate:'2026-09-09',counterparty:'Finanzamt',description:'UMS.ST 2026',entryType:'expense',amount:'500.00'});
    await invoke('POST','/api/bookkeeping/transactions',{...valid,transactionDate:'2026-09-10',counterparty:'Techniker Krankenkasse',description:'Monthly contribution',entryType:'expense',amount:'200.00'});
    const ownerDraw=(await putBookkeepingItem(client,'bookkeeping',{transactionDate:'2026-09-11',paidDate:'2026-09-11',counterparty:'Synthetic Owner',description:'Synthetic private withdrawal',amount:'42.00',currency:'EUR',entryType:'expense',category:'Owner pay',ownerPayType:'draw'})).item;
    const ownerEvidence=(await putBookkeepingItem(client,'document',{documentType:'receipt',status:'active',originalFilename:'synthetic-owner-transfer.pdf',contentType:'application/pdf',byteSize:9,sha256:createHash('sha256').update('synthetic-owner-transfer').digest('hex'),s3Key:'documents/synthetic-owner-transfer'})).item;
    const ownerLink=await invoke('POST','/api/bookkeeping/links',{documentId:ownerEvidence.id,transactionId:ownerDraw.id,coverageType:'evidence'});assert.equal(ownerLink.statusCode,201);
    await invoke('POST','/api/bookkeeping/accounts/setup');
    // Earlier tests leave additional active synthetic accounts in the shared Dynalite table.
    const activeBusinessAccounts=JSON.parse((await invoke('GET','/api/bookkeeping/accounts')).body).items.filter((account:any)=>account.kind==='business'&&account.active!==false);
    assert.ok(activeBusinessAccounts.length>=2);
    for(const account of activeBusinessAccounts) await putBookkeepingItem(client,'document',{documentType:'bank-statement',status:'active',accountId:account.id,statementMonth:'2026-09',originalFilename:'synthetic.pdf',contentType:'application/pdf',byteSize:9,sha256:createHash('sha256').update(`synthetic-vat-${account.id}`).digest('hex'),s3Key:`documents/${account.id}`});
    const snapshot=await invoke('POST','/api/bookkeeping/reports/snapshot',{month:'2026-09',privateDocumentIds:[ownerEvidence.id]});assert.equal(snapshot.statusCode,201,snapshot.body);
    const report=JSON.parse(snapshot.body).report;
    assert.equal(report.reconciliation.excludedTransactionCount,5);
    assert.deepEqual(report.transactionIds.length,2);
    assert.ok(!report.transactionIds.includes(ownerDraw.id));
    assert.ok(!report.documentIds.includes(ownerEvidence.id));
    assert.ok(JSON.parse((await invoke('GET','/api/bookkeeping/transactions')).body).items.some((item:any)=>item.id===ownerDraw.id),'the owner draw remains in the internal ledger');
    assert.ok(JSON.parse((await invoke('GET','/api/bookkeeping/documents')).body).items.some((item:any)=>item.id===ownerEvidence.id),'its source document remains stored');
    const vat=await invoke('GET','/api/bookkeeping/reports/vat',undefined,undefined,{year:'2026'});assert.equal(vat.statusCode,200);
    assert.deepEqual(JSON.parse(vat.body).months,[{month:'2026-09',currency:'EUR',outputVat:19,inputVat:7,net:12,transactionCount:2}]);
    const emptyYear=await invoke('GET','/api/bookkeeping/reports/vat',undefined,undefined,{year:'2027'});assert.deepEqual(JSON.parse(emptyYear.body).months,[]);
    assert.equal((await invoke('GET','/api/bookkeeping/reports/vat',undefined,undefined,{year:'20x6'})).statusCode,400);
  });
  it('validates PDF upload content and never returns object keys',async()=>{
    process.env.BOOKKEEPING_DOCUMENTS_BUCKET='synthetic-private-bucket';process.env.BOOKKEEPING_DOCUMENTS_KMS_KEY='synthetic-key';process.env.BOOKKEEPING_UPLOAD_URL_SECONDS='-1';
    const pdf=Buffer.from('%PDF-synthetic');let objectBytes=pdf;
    let archiveBytes:Buffer|undefined;let deletedVersions:string[]=[];const fake:any={send:async(command:any)=>{const name=command.constructor.name;if(name==='HeadObjectCommand')return{ContentLength:objectBytes.length,ContentType:'application/pdf',VersionId:'synthetic-version'};if(name==='GetObjectCommand')return{Body:Readable.from(objectBytes),VersionId:'synthetic-version'};if(name==='DeleteObjectCommand'){deletedVersions.push(command.input.VersionId);return{};}return{};}};
    const signed:any[]=[];setBookkeepingStorageForTests(fake,async(_c:any,command:any)=>{signed.push(command.input);return 'https://synthetic.invalid/short-lived';});
    const successfulUploader=async(params:any)=>{const chunks:Buffer[]=[];for await(const chunk of params.Body)chunks.push(Buffer.from(chunk));archiveBytes=Buffer.concat(chunks);};setBookkeepingArchiveUploaderForTests(successfulUploader);
    assert.equal((await invoke('POST','/api/bookkeeping/documents',{status:'active',s3Key:'documents/other-record',sha256:'forged'})).statusCode,405);
    const hash=createHash('sha256').update(pdf).digest('hex'),ownership={idempotencyKey:'synthetic-idempotency'};
    const prepared=await invoke('POST','/api/bookkeeping/documents/prepare',{sha256:hash,byteSize:pdf.length,documentType:'receipt',...ownership,sourceRef:'synthetic-source'});assert.equal(prepared.statusCode,201);const pending=JSON.parse(prepared.body);assert.equal(pending.document.s3Key,undefined);assert.equal(pending.expiresIn,-1);
    const completed=await invoke('POST',`/api/bookkeeping/documents/${pending.document.id}/complete`,ownership);assert.equal(completed.statusCode,200);assert.equal(JSON.parse(completed.body).document.s3Key,undefined);
    const deleteDocument=await invoke('DELETE',`/api/bookkeeping/documents/${pending.document.id}`);assert.equal(deleteDocument.statusCode,405);assert.deepEqual(JSON.parse(deleteDocument.body),{error:'Bookkeeping documents cannot be deleted through this API'});
    const duplicate=await invoke('POST','/api/bookkeeping/documents/prepare',{sha256:hash,byteSize:pdf.length,documentType:'receipt',idempotencyKey:'duplicate-idempotency',sourceRef:'duplicate-source'});assert.equal(duplicate.statusCode,200);assert.equal(JSON.parse(duplicate.body).outcome,'existing');
    objectBytes=Buffer.from('%PDF-invalid');const invalidHash=createHash('sha256').update(Buffer.from('%PDF-expected')).digest('hex'),invalidOwnership={idempotencyKey:'invalid-idempotency'};const invalidPending=JSON.parse((await invoke('POST','/api/bookkeeping/documents/prepare',{sha256:invalidHash,byteSize:objectBytes.length,documentType:'receipt',...invalidOwnership,sourceRef:'invalid-source'})).body);assert.equal((await invoke('POST',`/api/bookkeeping/documents/${invalidPending.document.id}/complete`,invalidOwnership)).statusCode,400);assert.deepEqual(deletedVersions,['synthetic-version']);objectBytes=pdf;
    const listed=await invoke('GET','/api/bookkeeping/documents');assert.ok(JSON.parse(listed.body).items.every((d:any)=>d.s3Key===undefined));
    const download=await invoke('GET',`/api/bookkeeping/documents/${pending.document.id}/download`);assert.equal(download.statusCode,200);assert.equal(JSON.parse(download.body).expiresIn,300);assert.match(signed.at(-1).ResponseContentDisposition,/^attachment; filename="/);const view=await invoke('GET',`/api/bookkeeping/documents/${pending.document.id}/download`,undefined,undefined,{disposition:'inline'});assert.equal(view.statusCode,200);assert.match(signed.at(-1).ResponseContentDisposition,/^inline; filename="receipt-[^"]+\.pdf"$/);assert.equal(signed.at(-1).ResponseContentType,'application/pdf');
    process.env.SKIP_AUTH='false';assert.equal((await invoke('GET',`/api/bookkeeping/documents/${pending.document.id}/download`)).statusCode,401);process.env.SKIP_AUTH='true';
    const reports=JSON.parse((await invoke('GET','/api/bookkeeping/reports')).body).items;const report=reports.find((r:any)=>r.month==='2026-08');process.env.BOOKKEEPING_ARCHIVE_MAX_BYTES='1';assert.equal((await invoke('POST',`/api/bookkeeping/reports/${report.id}/archive`)).statusCode,413);process.env.BOOKKEEPING_ARCHIVE_MAX_BYTES=String(50*1024*1024);setBookkeepingArchiveUploaderForTests(async()=>{throw new Error('synthetic upload failure')});assert.equal((await invoke('POST',`/api/bookkeeping/reports/${report.id}/archive`)).statusCode,500);setBookkeepingArchiveUploaderForTests(successfulUploader);const archive=await invoke('POST',`/api/bookkeeping/reports/${report.id}/archive`);assert.equal(archive.statusCode,201);assert.equal(JSON.parse(archive.body).expiresIn,300);assert.equal(archiveBytes?.subarray(0,2).toString(),'PK');
    const retry=await invoke('POST',`/api/bookkeeping/reports/${report.id}/archive`);assert.equal(retry.statusCode,200);assert.equal(JSON.parse(retry.body).duplicate,true);
  });

  it('allocates one synthetic 123 EUR payment across three invoice rows with CAS, audit, duplicate/mismatch/rounding rejection, and reversible clear',async()=>{
    const docA=(await putBookkeepingItem(client,'document',{documentType:'invoice',status:'active',originalFilename:'synthetic-invoice-a.pdf',contentType:'application/pdf',byteSize:100,sha256:createHash('sha256').update('synthetic-invoice-a').digest('hex'),s3Key:'documents/synthetic-invoice-a.pdf'})).item;
    const docB=(await putBookkeepingItem(client,'document',{documentType:'invoice',status:'active',originalFilename:'synthetic-invoice-b.pdf',contentType:'application/pdf',byteSize:100,sha256:createHash('sha256').update('synthetic-invoice-b').digest('hex'),s3Key:'documents/synthetic-invoice-b.pdf'})).item;
    const docC=(await putBookkeepingItem(client,'document',{documentType:'invoice',status:'active',originalFilename:'synthetic-invoice-c.pdf',contentType:'application/pdf',byteSize:100,sha256:createHash('sha256').update('synthetic-invoice-c').digest('hex'),s3Key:'documents/synthetic-invoice-c.pdf'})).item;
    const docOther=(await putBookkeepingItem(client,'document',{documentType:'invoice',status:'active',originalFilename:'synthetic-invoice-other.pdf',contentType:'application/pdf',byteSize:100,sha256:createHash('sha256').update('synthetic-invoice-other').digest('hex'),s3Key:'documents/synthetic-invoice-other.pdf'})).item;

    const paymentDate='2025-04-15';
    const payment=JSON.parse((await invoke('POST','/api/bookkeeping/transactions',{...valid,transactionDate:paymentDate,paidDate:paymentDate,counterparty:'Synthetic Bundle Settlement',description:'Combined synthetic payment',amount:'123.00',currency:'EUR',entryType:'expense',category:'Tools'})).body);
    const otherTx=JSON.parse((await invoke('POST','/api/bookkeeping/transactions',{...valid,transactionDate:'2025-04-16',counterparty:'Synthetic Other Vendor',description:'Other synthetic service',amount:'50.00',currency:'EUR',entryType:'expense'})).body);
    await invoke('POST','/api/bookkeeping/links',{documentId:docOther.id,transactionId:otherTx.id,coverageType:'evidence'});
    const manualLink=JSON.parse((await invoke('POST','/api/bookkeeping/links',{documentId:docA.id,transactionId:payment.id,coverageType:'evidence'})).body);

    // Reject sum mismatch
    const mismatchRes=await invoke('PUT',`/api/bookkeeping/transactions/${payment.id}/allocations`,{
      expectedUpdatedAt:payment.updatedAt,
      allocations:[
        {documentId:docA.id,counterparty:'Synthetic Vendor A',description:'Synthetic service A',amount:'100.00'},
        {documentId:docB.id,counterparty:'Synthetic Vendor B',description:'Synthetic service B',amount:'20.00'},
        {documentId:docC.id,counterparty:'Synthetic Vendor C',description:'Synthetic service C',amount:'2.99'},
      ],
    });
    assert.equal(mismatchRes.statusCode,400);
    assert.match(JSON.parse(mismatchRes.body).error,/mismatch/i);

    // Reject rounding ambiguity
    const roundingRes=await invoke('PUT',`/api/bookkeeping/transactions/${payment.id}/allocations`,{
      expectedUpdatedAt:payment.updatedAt,
      allocations:[
        {documentId:docA.id,counterparty:'Synthetic Vendor A',description:'Synthetic service A',amount:'100.00'},
        {documentId:docB.id,counterparty:'Synthetic Vendor B',description:'Synthetic service B',amount:'20.005'},
        {documentId:docC.id,counterparty:'Synthetic Vendor C',description:'Synthetic service C',amount:'2.995'},
      ],
    });
    assert.equal(roundingRes.statusCode,400);
    assert.match(JSON.parse(roundingRes.body).error,/rounding ambiguity/i);

    // Reject duplicate source allocation within same request
    const dupSameRes=await invoke('PUT',`/api/bookkeeping/transactions/${payment.id}/allocations`,{
      expectedUpdatedAt:payment.updatedAt,
      allocations:[
        {documentId:docA.id,counterparty:'Synthetic Vendor A',description:'Synthetic service A',amount:'100.00'},
        {documentId:docA.id,counterparty:'Synthetic Vendor B',description:'Synthetic service B',amount:'23.00'},
      ],
    });
    assert.equal(dupSameRes.statusCode,400);
    assert.match(JSON.parse(dupSameRes.body).error,/duplicate source allocation/i);

    // Reject duplicate source allocation already linked to another transaction
    const dupCrossRes=await invoke('PUT',`/api/bookkeeping/transactions/${payment.id}/allocations`,{
      expectedUpdatedAt:payment.updatedAt,
      allocations:[
        {documentId:docOther.id,counterparty:'Synthetic Vendor A',description:'Synthetic service A',amount:'123.00'},
      ],
    });
    assert.equal(dupCrossRes.statusCode,409);
    assert.match(JSON.parse(dupCrossRes.body).error,/duplicate source allocation/i);

    // Reject CAS mismatch
    const casRes=await invoke('PUT',`/api/bookkeeping/transactions/${payment.id}/allocations`,{
      expectedUpdatedAt:'1999-01-01T00:00:00.000Z',
      allocations:[
        {documentId:docA.id,counterparty:'Synthetic Vendor A',description:'Synthetic service A',amount:'123.00'},
      ],
    });
    assert.equal(casRes.statusCode,409);
    assert.match(JSON.parse(casRes.body).error,/CAS conflict/i);

    // Reject a multi-byte reason beyond the UTF-8 byte limit without partial writes.
    const oversizedReasonRes=await invoke('PUT',`/api/bookkeeping/transactions/${payment.id}/allocations`,{
      expectedUpdatedAt:payment.updatedAt,
      reason:'💶'.repeat(600),
      allocations:[
        {documentId:docA.id,counterparty:'Synthetic Vendor A',description:'Synthetic service A',amount:'100.00'},
        {documentId:docB.id,counterparty:'Synthetic Vendor B',description:'Synthetic service B',amount:'20.00'},
        {documentId:docC.id,counterparty:'Synthetic Vendor C',description:'Synthetic service C',amount:'3.00'},
      ],
    });
    assert.equal(oversizedReasonRes.statusCode,400);
    assert.deepEqual(JSON.parse(oversizedReasonRes.body).fields,['reason']);
    const unchangedPayment=await getBookkeepingItem(client,'bookkeeping',payment.id);
    assert.equal(unchangedPayment?.allocations,undefined);
    assert.deepEqual(unchangedPayment?.audit,payment.audit);
    assert.deepEqual((await listBookkeepingItems(client,'link')).filter((link:any)=>String(link.transactionId)===payment.id).map((link:any)=>link.id),[manualLink.id]);

    // Valid exact allocation: 100.00 + 20.00 + 3.00 = 123.00 EUR
    const validAllocRes=await invoke('PUT',`/api/bookkeeping/transactions/${payment.id}/allocations`,{
      expectedUpdatedAt:payment.updatedAt,
      reason:'Allocate synthetic bundled payment across three invoices',
      allocations:[
        {documentId:docA.id,invoiceNumber:'SYNTH-A',counterparty:'Synthetic Vendor A',description:'Synthetic service A',amount:'100.00'},
        {documentId:docB.id,invoiceNumber:'SYNTH-B',counterparty:'Synthetic Vendor B',description:'Synthetic service B',amount:'20.00'},
        {documentId:docC.id,invoiceNumber:'SYNTH-C',counterparty:'Synthetic Vendor C',description:'Synthetic service C',amount:'3.00'},
      ],
    },{'x-user-id':'synthetic-operator'});
    assert.equal(validAllocRes.statusCode,200,validAllocRes.body);
    const allocatedTx=JSON.parse(validAllocRes.body);
    assert.equal(allocatedTx.amount,'123.00');
    assert.equal(allocatedTx.allocations.length,3);
    assert.equal(allocatedTx.audit.at(-1).action,'allocations-updated');
    assert.equal(allocatedTx.audit.at(-1).actor,'synthetic-operator');
    assert.equal(allocatedTx.audit.at(-1).reason,'Allocate synthetic bundled payment across three invoices');

    // Readback on GET /api/bookkeeping/transactions/:id/allocations and GET /api/bookkeeping/transactions/:id
    const readback=JSON.parse((await invoke('GET',`/api/bookkeeping/transactions/${payment.id}/allocations`)).body);
    assert.equal(readback.amount,'123.00');
    assert.equal(readback.allocations.length,3);
    assert.equal(readback.links.length,3);
    assert.equal(readback.links.find((link:any)=>link.documentId===docA.id).id,manualLink.id,
      'an operator-created evidence link is reused without being marked allocation-managed');
    assert.equal(readback.links.filter((link:any)=>link.allocationManaged===true).length,2);
    for(const document of [docA,docB,docC])
      assert.equal((await getBookkeepingItem(client,'document',document.id))?.linkRefCount,1);

    // Single transaction preserved in ledger list (no duplicate expense rows created)
    const sameDay=JSON.parse((await invoke('GET','/api/bookkeeping/transactions')).body).items.filter((i:any)=>i.transactionDate===paymentDate);
    assert.equal(sameDay.length,1);
    assert.equal(sameDay[0].amount,'123.00');

    // Reversible clear via DELETE /api/bookkeeping/transactions/:id/allocations
    const clearRes=await invoke('DELETE',`/api/bookkeeping/transactions/${payment.id}/allocations`,{
      expectedUpdatedAt:allocatedTx.updatedAt,
      reason:'Revert allocation for test',
    },{'x-user-id':'synthetic-operator'});
    assert.equal(clearRes.statusCode,200,clearRes.body);
    const clearedTx=JSON.parse(clearRes.body);
    assert.equal(clearedTx.allocations,undefined);
    assert.equal(clearedTx.amount,'123.00');
    assert.equal(clearedTx.audit.at(-1).action,'allocations-cleared');
    const clearedReadback=JSON.parse((await invoke('GET',`/api/bookkeeping/transactions/${payment.id}/allocations`)).body);
    assert.deepEqual(clearedReadback.links.map((link:any)=>link.id),[manualLink.id],
      'clearing removes only allocation-managed evidence and preserves operator evidence');
    assert.equal((await getBookkeepingItem(client,'document',docA.id))?.linkRefCount,1);
    for(const document of [docB,docC])
      assert.equal((await getBookkeepingItem(client,'document',document.id))?.linkRefCount,0);
  });

  it('replays atomic allocation transaction creates only for an identical source payload',async()=>{
    const document=(await putBookkeepingItem(client,'document',{documentType:'invoice',status:'active',originalFilename:'synthetic-replay-invoice.pdf',contentType:'application/pdf',byteSize:100,sha256:createHash('sha256').update('synthetic-replay-invoice').digest('hex'),s3Key:'documents/synthetic-replay-invoice.pdf'})).item;
    const request={...valid,sourceKey:'synthetic-allocation-create-replay',amount:'3.00',allocations:[{documentId:document.id,counterparty:'Synthetic Replay Vendor',description:'Synthetic replay service',amount:'3.00'}]};
    const created=await invoke('POST','/api/bookkeeping/transactions',request);
    assert.equal(created.statusCode,201,created.body);
    const replay=await invoke('POST','/api/bookkeeping/transactions',request);
    assert.equal(replay.statusCode,200,replay.body);
    assert.equal(JSON.parse(replay.body).id,JSON.parse(created.body).id);
    const conflicting=await invoke('POST','/api/bookkeeping/transactions',{...request,allocations:[{...request.allocations[0],description:'Different synthetic service'}]});
    assert.equal(conflicting.statusCode,409,conflicting.body);
    assert.equal((await listTransactions(client)).filter((row:any)=>row.sourceKey===request.sourceKey).length,1);
    assert.equal((await getBookkeepingItem(client,'document',document.id))?.linkRefCount,1);
  });

  it('atomically rejects a parent CAS race without leaving allocation links, refcounts, or claims',async()=>{
    const document=(await putBookkeepingItem(client,'document',{documentType:'invoice',status:'active',originalFilename:'cas-race.pdf',contentType:'application/pdf',byteSize:100,sha256:createHash('sha256').update('cas-race-pdf').digest('hex'),s3Key:'documents/cas-race.pdf'})).item;
    const payment=JSON.parse((await invoke('POST','/api/bookkeeping/transactions',{...valid,transactionDate:'2026-10-24',amount:'10.00'})).body);
    let raced=false;
    const racyClient={send:async(command:any)=>{
      if(!raced&&command instanceof TransactWriteCommand&&command.input.TransactItems?.some((item:any)=>item.Update?.Key?.PK===`BOOKKEEPING#${payment.id}`)){
        raced=true;
        await client.send(new UpdateCommand({TableName:TABLE_BOOKKEEPING,Key:{PK:`BOOKKEEPING#${payment.id}`,SK:`BOOKKEEPING#${payment.id}`},UpdateExpression:'SET updatedAt = :now',ExpressionAttributeValues:{':now':new Date(Date.now()+1000).toISOString()}}));
      }
      return client.send(command);
    }} as unknown as DynamoDBDocumentClient;
    const response=await handleBookkeepingTransactionRoutes(`/api/bookkeeping/transactions/${payment.id}/allocations`,'PUT',{headers:{},body:JSON.stringify({expectedUpdatedAt:payment.updatedAt,allocations:[{documentId:document.id,counterparty:'Synthetic Vendor',description:'Synthetic invoice',amount:'10.00'}]})} as any,racyClient);
    assert.ok(response);
    assert.equal(response.statusCode,409);
    assert.equal(raced,true);
    assert.equal((await getBookkeepingItem(client,'bookkeeping',payment.id))?.allocations,undefined);
    assert.equal((await getBookkeepingItem(client,'document',document.id))?.linkRefCount,undefined);
    assert.equal((await listBookkeepingItems(client,'link')).some((link:any)=>link.transactionId===payment.id&&link.documentId===document.id),false);
    assert.equal((await listBookkeepingItems(client,'allocation-source-claim')).some((claim:any)=>claim.transactionId===payment.id),false);
  });

  it('atomically rejects an existing evidence link removed after allocation validation',async()=>{
    const document=(await putBookkeepingItem(client,'document',{documentType:'invoice',status:'active',originalFilename:'existing-link-race.pdf',contentType:'application/pdf',byteSize:100,sha256:createHash('sha256').update('existing-link-race-pdf').digest('hex'),s3Key:'documents/existing-link-race.pdf'})).item;
    const payment=JSON.parse((await invoke('POST','/api/bookkeeping/transactions',{...valid,transactionDate:'2026-10-28',amount:'10.00'})).body);
    const linkResponse=await invoke('POST','/api/bookkeeping/links',{documentId:document.id,transactionId:payment.id,coverageType:'evidence'});
    assert.equal(linkResponse.statusCode,201);
    const link=JSON.parse(linkResponse.body);
    let raced=false;
    let transactionItems:any[]=[];
    const racyClient={send:async(command:any)=>{
      if(!raced&&command instanceof TransactWriteCommand&&command.input.TransactItems?.some((item:any)=>item.Update?.Key?.PK===`BOOKKEEPING#${payment.id}`)){
        raced=true;
        transactionItems=command.input.TransactItems;
        const unlink=await invoke('DELETE',`/api/bookkeeping/links/${link.id}`);
        assert.equal(unlink.statusCode,204,unlink.body);
      }
      return client.send(command);
    }} as unknown as DynamoDBDocumentClient;
    const response=await handleBookkeepingTransactionRoutes(`/api/bookkeeping/transactions/${payment.id}/allocations`,'PUT',{headers:{},body:JSON.stringify({expectedUpdatedAt:payment.updatedAt,allocations:[{documentId:document.id,counterparty:'Synthetic Vendor',description:'Synthetic invoice',amount:'10.00'}]})} as any,racyClient);
    assert.ok(response);
    assert.equal(response.statusCode,409);
    assert.equal(raced,true);
    const linkGuard=transactionItems.find((item:any)=>item.ConditionCheck?.Key?.PK===`LINK#${link.id}`)?.ConditionCheck;
    assert.ok(linkGuard,'the reused evidence link is conditionally checked in the parent allocation transaction');
    assert.equal(linkGuard.ConditionExpression,'documentId = :documentId AND transactionId = :transactionId AND coverageType = :coverage');
    assert.equal((await getBookkeepingItem(client,'bookkeeping',payment.id))?.allocations,undefined);
    assert.equal((await getBookkeepingItem(client,'document',document.id))?.linkRefCount,0);
    assert.equal((await getBookkeepingItem(client,'link',link.id)),undefined);
    assert.equal((await listBookkeepingItems(client,'allocation-source-claim')).some((claim:any)=>claim.transactionId===payment.id),false);
  });

  it('keeps the parent, document links, refcounts, and claims untouched when the atomic write fails',async()=>{
    const document=(await putBookkeepingItem(client,'document',{documentType:'invoice',status:'active',originalFilename:'atomic-failure.pdf',contentType:'application/pdf',byteSize:100,sha256:createHash('sha256').update('atomic-failure-pdf').digest('hex'),s3Key:'documents/atomic-failure.pdf'})).item;
    const payment=JSON.parse((await invoke('POST','/api/bookkeeping/transactions',{...valid,transactionDate:'2026-10-23',amount:'10.00'})).body);
    let transactionItems:any[]=[];
    const rejectingClient={send:async(command:any)=>{
      if(command instanceof TransactWriteCommand&&command.input.TransactItems?.some((item:any)=>item.Update?.Key?.PK===`BOOKKEEPING#${payment.id}`)){
        transactionItems=command.input.TransactItems;
        throw new Error('injected transaction failure');
      }
      return client.send(command);
    }} as unknown as DynamoDBDocumentClient;
    const response=await handleBookkeepingTransactionRoutes(`/api/bookkeeping/transactions/${payment.id}/allocations`,'PUT',{headers:{},body:JSON.stringify({expectedUpdatedAt:payment.updatedAt,allocations:[{documentId:document.id,counterparty:'Synthetic Vendor',description:'Synthetic invoice',amount:'10.00'}]})} as any,rejectingClient);
    assert.ok(response);
    assert.equal(response.statusCode,503);
    assert.ok(transactionItems.some((item:any)=>item.Update?.Key?.PK===`BOOKKEEPING#${payment.id}`),'parent CAS is in the allocation transaction');
    assert.ok(transactionItems.some((item:any)=>item.Put?.Item?.transactionId===payment.id&&item.Put?.Item?.coverageType==='evidence'),'evidence link is in the allocation transaction');
    assert.ok(transactionItems.some((item:any)=>item.Put?.Item?.sourceKind==='document'),'document claim is in the allocation transaction');
    assert.equal((await getBookkeepingItem(client,'bookkeeping',payment.id))?.allocations,undefined);
    assert.equal((await getBookkeepingItem(client,'document',document.id))?.linkRefCount,undefined);
    assert.equal((await listBookkeepingItems(client,'link')).some((link:any)=>link.transactionId===payment.id&&link.documentId===document.id),false);
    assert.equal((await listBookkeepingItems(client,'allocation-source-claim')).some((claim:any)=>claim.transactionId===payment.id),false);
  });

  it('atomically rejects a document becoming inactive after allocation validation',async()=>{
    const document=(await putBookkeepingItem(client,'document',{documentType:'invoice',status:'active',originalFilename:'inactive-race.pdf',contentType:'application/pdf',byteSize:100,sha256:createHash('sha256').update('inactive-race-pdf').digest('hex'),s3Key:'documents/inactive-race.pdf'})).item;
    const payment=JSON.parse((await invoke('POST','/api/bookkeeping/transactions',{...valid,transactionDate:'2026-10-25',amount:'10.00'})).body);
    let raced=false;
    const racyClient={send:async(command:any)=>{
      if(!raced&&command instanceof TransactWriteCommand&&command.input.TransactItems?.some((item:any)=>item.Put?.Item?.sourceKind)){
        raced=true;
        await client.send(new UpdateCommand({TableName:TABLE_BOOKKEEPING,Key:{PK:`DOCUMENT#${document.id}`,SK:`DOCUMENT#${document.id}`},UpdateExpression:'SET #status = :inactive',ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':inactive':'inactive'}}));
      }
      return client.send(command);
    }} as unknown as DynamoDBDocumentClient;
    const response=await handleBookkeepingTransactionRoutes(`/api/bookkeeping/transactions/${payment.id}/allocations`,'PUT',{headers:{},body:JSON.stringify({expectedUpdatedAt:payment.updatedAt,allocations:[{documentId:document.id,counterparty:'Synthetic Vendor',description:'Synthetic invoice',amount:'10.00'}]})} as any,racyClient);
    assert.ok(response);
    assert.equal(response.statusCode,409);
    assert.equal(raced,true);
    assert.equal((await getBookkeepingItem(client,'bookkeeping',payment.id))?.allocations,undefined);
    assert.equal((await getBookkeepingItem(client,'document',document.id))?.linkRefCount,undefined);
    assert.equal((await listBookkeepingItems(client,'link')).some((link:any)=>link.transactionId===payment.id&&link.documentId===document.id),false);
    assert.equal((await listBookkeepingItems(client,'allocation-source-claim')).some((claim:any)=>claim.transactionId===payment.id),false);
  });

  it('uses conditional source claims to serialize simultaneous allocations of the same PDF across payments',async()=>{
    const document=(await putBookkeepingItem(client,'document',{documentType:'invoice',status:'active',originalFilename:'same-source-race.pdf',contentType:'application/pdf',byteSize:100,sha256:createHash('sha256').update('same-source-race-pdf').digest('hex'),s3Key:'documents/same-source-race.pdf'})).item;
    const first=JSON.parse((await invoke('POST','/api/bookkeeping/transactions',{...valid,transactionDate:'2026-10-26',amount:'10.00'})).body);
    const second=JSON.parse((await invoke('POST','/api/bookkeeping/transactions',{...valid,transactionDate:'2026-10-27',amount:'10.00'})).body);
    let arrivals=0;
    let release!:()=>void;
    const bothValidated=new Promise<void>((resolve)=>{release=resolve;});
    const racingClient={send:async(command:any)=>{
      if(command instanceof TransactWriteCommand&&command.input.TransactItems?.some((item:any)=>item.Put?.Item?.sourceKind)){
        arrivals+=1;
        if(arrivals===2) release();
        await bothValidated;
      }
      return client.send(command);
    }} as unknown as DynamoDBDocumentClient;
    const sendAllocation=(payment:any)=>handleBookkeepingTransactionRoutes(`/api/bookkeeping/transactions/${payment.id}/allocations`,'PUT',{headers:{},body:JSON.stringify({expectedUpdatedAt:payment.updatedAt,allocations:[{documentId:document.id,invoiceId:'synthetic-invoice-source',counterparty:'Synthetic Vendor',description:'Synthetic invoice',amount:'10.00'}]})} as any,racingClient);
    const responses=await Promise.all([sendAllocation(first),sendAllocation(second)]);
    assert.equal(arrivals,2,'both requests validated the same unclaimed source before either committed');
    assert.deepEqual(responses.map((response:any)=>response?.statusCode).sort(),[200,409]);
    const transactions=await Promise.all([getBookkeepingItem(client,'bookkeeping',first.id),getBookkeepingItem(client,'bookkeeping',second.id)]);
    assert.equal(transactions.filter((transaction:any)=>Array.isArray(transaction?.allocations)&&transaction.allocations.length===1).length,1);
    assert.equal((await listBookkeepingItems(client,'link')).filter((link:any)=>link.documentId===document.id&&[first.id,second.id].includes(link.transactionId)).length,1);
    assert.equal((await getBookkeepingItem(client,'document',document.id))?.linkRefCount,1);
    assert.equal((await listBookkeepingItems(client,'allocation-source-claim')).filter((claim:any)=>claim.sourceValue===document.id).length,1);
  });
});
