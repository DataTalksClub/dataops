import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'stream';
import { createHash } from 'crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { createTables } from '../scripts/local-dynamodb';
import { TABLE_ARTIFACTS, TABLE_INTAKE, TABLE_BOOKKEEPING } from '../src/db/tableNames';
import { processInvoiceIntake, setInvoiceServiceForTests, confirmInvoice, publishInvoice } from '../src/invoices/service';
import { createInvoice, getInvoice, approveInvoice, saveInvoice } from '../src/invoices/store';
import { publicInvoice, type Invoice } from '../src/invoices/model';
import { handleInvoiceRoutes } from '../src/routes/invoices';
import type { Providers } from '../src/invoices/providers';
const headers=['Date sent','Date paid','Provider','What','Price, $','Price, EUR','Statement','Count','Comment','Entry Type','Type','Period','Category'];
let client:DynamoDBDocumentClient;
let objects=new Map<string,Buffer>();
let files=new Map<string,Buffer>();let rows=new Map<number,string[]>();let failSheet=false;let failDropbox=false;let lostSheet=false;let lostDropbox=false;let sheetMismatch=false;let writes=0;
const provider:Providers={readiness:async()=>[],sheetLayout:async()=>({headers,rows:[headers,...Array.from({length:Math.max(1,...rows.keys())-1},(_,i)=>rows.get(i+2)||[])],destinationKey:'synthetic-sheet'}),readRow:async row=>rows.get(row)||[],writeRow:async(row,values)=>{writes++;if(failSheet)throw new Error('sheet-outage');rows.set(row,values);if(lostSheet){lostSheet=false;throw new Error('provider-response-unknown');}},findRow:async marker=>{for(const [row,values]of rows)if(values.some(x=>x.includes(marker)))return {row,values:sheetMismatch?['wrong']:values};return null;},readDropbox:async path=>files.has(path)?{bytes:files.get(path)!,reference:path}:null,writeDropbox:async(path,bytes)=>{writes++;if(failDropbox)throw new Error('dropbox-outage');files.set(path,bytes);if(lostDropbox){lostDropbox=false;throw new Error('provider-response-unknown');}},dropboxPath:invoice=>`/synthetic/${invoice.id}.pdf`};
before(async()=>{assert.ok(process.env.DYNAMODB_ENDPOINT);client=await getClient();await createTables(client);process.env.EMAIL_DOCUMENTS_BUCKET='synthetic-documents';setInvoiceServiceForTests({providers:async()=>provider,extract:async()=>'',s3:{send:async(command:{input:{Key:string}})=>({Body:Readable.from([objects.get(command.input.Key) || Buffer.from('missing')])})} as unknown as S3Client});});
after(()=>{client.destroy();});
async function stage(label:string,variant='') {
  const bytes=Buffer.from(`%PDF-synthetic-${label}${variant}`);const checksum='sha256:'+createHash('sha256').update(bytes).digest('hex');const artifactId=`artifact-${label}${variant}`;const intakeId=`intake-${label}${variant}`;objects.set(`artifacts/${artifactId}`,bytes);
  await client.send(new PutCommand({TableName:TABLE_ARTIFACTS,Item:{PK:`ARTIFACT#${artifactId}`,SK:`ARTIFACT#${artifactId}`,id:artifactId,metadata:{importState:'complete'},contentType:'application/pdf',storageUri:`s3://synthetic-documents/artifacts/${artifactId}`,checksum,sizeBytes:bytes.length}}));
  await client.send(new PutCommand({TableName:TABLE_INTAKE,Item:{PK:`INTAKE#${intakeId}`,SK:`INTAKE#${intakeId}`,id:intakeId,status:'new',metadata:{recipientRoute:'invoice'},artifactRefs:[{artifactId}],history:[],source:'email',createdAt:'2026-01-01T00:00:00.000Z'}}));
  const result=await processInvoiceIntake(client,intakeId);assert.equal(result.items.length,1);let record=result.items[0];const next=structuredClone(record);next.fields={transactionDate:'2026-10-01',paidDate:'2026-10-02',counterparty:'Example Vendor',description:'Synthetic service',amount:'10.25',currency:'EUR',amountEur:'10.25',paymentEvidence:'Explicit operator supplied bank amount',invoiceNumber:label,accountContext:'Synthetic account',archiveRequired:true};record=await saveInvoice(client,next,record);return {record,intakeId,artifactId};
}
test('pending, stale revision and unauthorized requests never write',async()=>{const {record}=await stage('gates');const beforeWrites=writes;assert.equal((await handleInvoiceRoutes('/api/bookkeeping/invoices','GET',{headers:{}},client,false)).statusCode,401);assert.equal((await handleInvoiceRoutes(`/api/bookkeeping/invoices/${record.id}/confirm`,'POST',{headers:{},body:JSON.stringify({revision:0})},client,true)).statusCode,409);assert.equal((await handleInvoiceRoutes(`/api/bookkeeping/invoices/${record.id}/retry`,'POST',{headers:{},body:JSON.stringify({revision:record.revision})},client,true)).statusCode,409);assert.equal(writes,beforeWrites);});
test('partial success retry reconciles lost response without duplicate row/file, updates ledger reference',async()=>{const {record,intakeId}=await stage('retry');failSheet=true;lostDropbox=true;const first=await confirmInvoice(client,record,'operator');assert.equal(first.destinations.dropbox.state,'unknown');assert.equal(first.destinations.sheets.state,'unknown');assert.equal(publicInvoice(first).publicationStatus,'incomplete');failSheet=false;const result=await publishInvoice(client,first,'operator');assert.equal(publicInvoice(result).publicationStatus,'complete');const count=writes;await publishInvoice(client,result,'operator');assert.equal(writes,count);assert.equal((await processInvoiceIntake(client,intakeId)).items[0].id,record.id);const ledger=await client.send(new GetCommand({TableName:TABLE_BOOKKEEPING,Key:{PK:`BOOKKEEPING#${record.id}`,SK:`BOOKKEEPING#${record.id}`}}));assert.equal(ledger.Item!.externalReferences.sheets.state,'verified');});
test('simultaneous confirmation claims only one execution for same document',async()=>{const {record}=await stage('parallel');const beforeWrites=writes;const result=await Promise.allSettled([confirmInvoice(client,record,'one'),confirmInvoice(client,record,'two')]);assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(writes-beforeWrites,2);});
test('atomic invoice identity claim prohibits same invoice across distinct PDFs',async()=>{const {record:a}=await stage('identity','-a');const {record:b}=await stage('identity','-b');const approved=(r:Invoice)=>({...r,status:'confirmed' as const,confirmedRevision:r.revision});const result=await Promise.allSettled([approveInvoice(client,approved(a),a,'shared-identity'),approveInvoice(client,approved(b),b,'shared-identity')]);assert.equal(result.filter(x=>x.status==='fulfilled').length,1);});
test('source checksum tampering blocks both destinations even with archive exception',async()=>{const {record,artifactId}=await stage('integrity');objects.set(`artifacts/${artifactId}`,Buffer.from('corrupt'));record.fields.archiveRequired=false;record.fields.archiveExceptionReason='Reviewed recurring archive exception';const existing=(await getInvoice(client,record.id))!;await saveInvoice(client,record,existing);const beforeWrites=writes;const result=await confirmInvoice(client,(await getInvoice(client,record.id))!,'operator');assert.equal(writes,beforeWrites);assert.equal(result.destinations.sheets.state,'blocked');assert.equal(result.destinations.dropbox.state,'blocked');});
test('readback mismatch is incomplete and retry refuses a conflicting row',async()=>{const {record}=await stage('mismatch');sheetMismatch=true;const first=await confirmInvoice(client,record,'operator');assert.equal(first.destinations.sheets.state,'unknown');assert.equal(first.destinations.dropbox.state,'verified');sheetMismatch=false;const row=first.destinations.sheets.reservedRow!;rows.set(row,['another invoice']);const next=await publishInvoice(client,first,'operator');assert.match(next.destinations.sheets.error!,/occupied/);assert.deepEqual(rows.get(row),['another invoice']);});

test('Dropbox failure and lost sheet response reconcile independent effects',async()=>{
  const {record}=await stage('inverse');failDropbox=true;lostSheet=true;
  const first=await confirmInvoice(client,record,'operator');assert.equal(first.destinations.dropbox.state,'unknown');assert.equal(first.destinations.dropbox.error,'dropbox-outage');assert.equal(first.destinations.sheets.state,'unknown');
  const rowsBefore=rows.size;failDropbox=false;const next=await publishInvoice(client,first,'operator');assert.equal(publicInvoice(next).publicationStatus,'complete');assert.equal(rows.size,rowsBefore);
});
test('missing actual EUR evidence and rejected drafts create no provider or ledger effects',async()=>{
  const {record}=await stage('missing-eur');const next=structuredClone(record);delete next.fields.amountEur;const pending=await saveInvoice(client,next,record);const count=writes;
  await assert.rejects(confirmInvoice(client,pending,'operator'),/evidence-required/);
  const rejected=await handleInvoiceRoutes(`/api/bookkeeping/invoices/${record.id}/reject`,'POST',{headers:{},body:JSON.stringify({revision:record.revision})},client,true);assert.equal(rejected.statusCode,200);
  await assert.rejects(confirmInvoice(client,(await getInvoice(client,record.id))!,'operator'),/rejected/);assert.equal(writes,count);
  const ledger=await client.send(new GetCommand({TableName:TABLE_BOOKKEEPING,Key:{PK:`BOOKKEEPING#${record.id}`,SK:`BOOKKEEPING#${record.id}`}}));assert.equal(ledger.Item,undefined);
});

test('EUR equivalent decimal formats and evidenced distinct actual bank payment publish accurately',async()=>{
  const {record}=await stage('eur-equivalent');const equivalent=structuredClone(record);equivalent.fields.amount='10.00';equivalent.fields.amountEur='10';
  const pending=await saveInvoice(client,equivalent,record);const published=await confirmInvoice(client,pending,'operator');assert.equal(publicInvoice(published).publicationStatus,'complete');
  const {record:other}=await stage('eur-mismatch');const mismatch=structuredClone(other);mismatch.fields.amount='10.00';mismatch.fields.amountEur='11';mismatch.fields.paymentEvidence='Explicit actual bank debit includes reviewed fee';const pendingActual=await saveInvoice(client,mismatch,other);const distinct=await confirmInvoice(client,pendingActual,'operator');assert.equal(publicInvoice(distinct).publicationStatus,'complete');assert.equal(distinct.fields.amount,'10.00');assert.equal(distinct.fields.amountEur,'11');assert.equal(rows.get(distinct.destinations.sheets.reservedRow!)![5],'-11');
});
test('complete but unverified drafts stay pending, explicit verification automatically publishes current revision',async()=>{
  const {record,intakeId}=await stage('auto-verified');const count=writes;
  const importedAgain=await processInvoiceIntake(client,intakeId);assert.equal(importedAgain.items[0].status,'pending');assert.equal(writes,count);
  const response=await handleInvoiceRoutes(`/api/bookkeeping/invoices/${record.id}/verify`,'POST',{headers:{'x-user-id':'verified-operator'},body:JSON.stringify({revision:record.revision})},client,true);
  assert.equal(response.statusCode,200);const result=JSON.parse(response.body);assert.equal(result.publicationPolicy,'automatic-when-verified');assert.equal(result.publicationStatus,'complete');assert.equal(result.verifiedRevision,record.revision);assert.equal(result.verification.actor,'verified-operator');assert.ok(result.audit.some((event:{action:string})=>event.action==='automatically-confirmed'));
  const repeated=await handleInvoiceRoutes(`/api/bookkeeping/invoices/${record.id}/verify`,'POST',{headers:{'x-user-id':'verified-operator'},body:JSON.stringify({revision:record.revision})},client,true);assert.equal(repeated.statusCode,200);assert.equal(writes,count+2);
});
test('verified edit publishes the resulting revision; ordinary corrections never attest verification',async()=>{
  const {record}=await stage('auto-edit');const count=writes;
  const edited=await handleInvoiceRoutes(`/api/bookkeeping/invoices/${record.id}`,'PUT',{headers:{'x-user-id':'editor'},body:JSON.stringify({revision:record.revision,fields:{description:'Reviewed corrected service'}})},client,true);
  const pending=JSON.parse(edited.body);assert.equal(pending.status,'pending');assert.equal(pending.verification,undefined);assert.equal(writes,count);
  const stale=await handleInvoiceRoutes(`/api/bookkeeping/invoices/${record.id}/verify`,'POST',{headers:{},body:JSON.stringify({revision:record.revision})},client,true);assert.equal(stale.statusCode,409);assert.equal(writes,count);
  const verified=await handleInvoiceRoutes(`/api/bookkeeping/invoices/${record.id}`,'PUT',{headers:{'x-user-id':'editor'},body:JSON.stringify({revision:pending.revision,fields:{comment:'Actual values checked'},verified:true})},client,true);
  assert.equal(verified.statusCode,200);const result=JSON.parse(verified.body);assert.equal(result.publicationStatus,'complete');assert.equal(result.verification.revision,result.revision);assert.equal(result.revision,pending.revision+1);assert.equal(result.fields.description,'Reviewed corrected service');
});
test('verification cannot bypass missing payment evidence, source integrity or authentication',async()=>{
  const {record,artifactId}=await stage('auto-integrity');const count=writes;
  const unauthorized=await handleInvoiceRoutes(`/api/bookkeeping/invoices/${record.id}/verify`,'POST',{headers:{},body:JSON.stringify({revision:record.revision})},client,false);assert.equal(unauthorized.statusCode,401);
  const missing=await handleInvoiceRoutes(`/api/bookkeeping/invoices/${record.id}`,'PUT',{headers:{},body:JSON.stringify({revision:record.revision,fields:{amountEur:null},verified:true})},client,true);assert.equal(missing.statusCode,409);
  objects.set(`artifacts/${artifactId}`,Buffer.from('corrupt'));
  const tampered=await handleInvoiceRoutes(`/api/bookkeeping/invoices/${record.id}/verify`,'POST',{headers:{},body:JSON.stringify({revision:record.revision})},client,true);assert.equal(tampered.statusCode,503);assert.equal(writes,count);assert.equal((await getInvoice(client,record.id))!.status,'pending');
});
test('simultaneous verified requests use the atomic revision and identity claim',async()=>{
  const {record}=await stage('auto-concurrent');const count=writes;const event={headers:{'x-user-id':'operator'},body:JSON.stringify({revision:record.revision})};
  const responses=await Promise.all([handleInvoiceRoutes(`/api/bookkeeping/invoices/${record.id}/verify`,'POST',event,client,true),handleInvoiceRoutes(`/api/bookkeeping/invoices/${record.id}/verify`,'POST',event,client,true)]);
  assert.equal(responses.filter(result=>result.statusCode===200).length,1);assert.equal(responses.filter(result=>result.statusCode===409).length,1);assert.equal(writes,count+2);
});
