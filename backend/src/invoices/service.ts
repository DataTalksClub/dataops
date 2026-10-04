import { createHash, randomUUID } from 'crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getIntakeItem, updateIntakeItem } from '../db/intake';
import { getArtifact } from '../db/artifacts';
import { putBookkeepingItem, updateBookkeepingTransaction } from '../db/bookkeeping';
import { extractInvoiceText, pdfText, type InvoiceHints } from './extract';
import { missingEvidence, type Invoice, type InvoiceFields } from './model';
import { createInvoice, getInvoice, listInvoices, saveInvoice, claimInvoice, reserveSheetRow, approveInvoice } from './store';
import { officialProviders, publicationConfig, marker, sheetValues, type Providers } from './providers';
let s3 = new S3Client({});
let providerFactory: (()=>Promise<Providers>) | undefined;
let textExtractor = pdfText;
export function setInvoiceServiceForTests(value:{s3?:S3Client; providers?:()=>Promise<Providers>; extract?:typeof pdfText}) {s3=value.s3 || new S3Client({});providerFactory=value.providers;textExtractor=value.extract || pdfText;}
const sha = (bytes:Buffer|string) => createHash('sha256').update(bytes).digest('hex');
async function artifactBytes(artifactId:string,client:DynamoDBDocumentClient):Promise<Buffer> {
  const artifact=await getArtifact(client,artifactId);
  if(!artifact || artifact.metadata?.importState!=='complete' || artifact.contentType!=='application/pdf') throw new Error('source-document-unavailable');
  const match=/^s3:\/\/([^/]+)\/(.+)$/.exec(artifact.storageUri || '');
  if(!match || match[1]!==process.env.EMAIL_DOCUMENTS_BUCKET || !match[2].startsWith((process.env.EMAIL_DOCUMENT_DESTINATION_PREFIX || 'artifacts/').replace(/^\//,''))) throw new Error('source-document-boundary-mismatch');
  const object=await s3.send(new GetObjectCommand({Bucket:match[1],Key:match[2]}));
  if(!object.Body) throw new Error('source-document-unavailable');
  const parts:Buffer[]=[];let size=0;
  for await(const part of object.Body as unknown as AsyncIterable<Uint8Array>) {const bytes=Buffer.from(part);size+=bytes.length;if(size>25*1024*1024 || size>Number(artifact.sizeBytes)) throw new Error('source-document-size-mismatch');parts.push(bytes);}
  const bytes=Buffer.concat(parts);
  if(size!==artifact.sizeBytes || `sha256:${sha(bytes)}`!==artifact.checksum) throw new Error('source-document-checksum-mismatch');
  return bytes;
}
export async function documentUrl(client:DynamoDBDocumentClient,record:Invoice) {
  const artifact=await getArtifact(client,record.source.artifactId);const match=/^s3:\/\/([^/]+)\/(.+)$/.exec(artifact?.storageUri || '');
  if(!match || match[1]!==process.env.EMAIL_DOCUMENTS_BUCKET) throw new Error('source-document-unavailable');
  return {url:await getSignedUrl(s3,new GetObjectCommand({Bucket:match[1],Key:match[2],ResponseContentDisposition:'inline'}),{expiresIn:300}),expiresIn:300};
}
function intakeHints(item:{title?:string; sourceActor?:{email?:string}}|null|undefined):InvoiceHints {
  return { subject:String(item?.title || ''), sender:String(item?.sourceActor?.email || '') };
}
// Untouched drafts (never operator-corrected or re-extracted) may be upgraded
// in place when a duplicate arrives or an operator asks for re-extraction.
// Operator-corrected or published records are never rewritten by parsing.
function draftIsUntouched(record:Invoice):boolean {
  return record.status==='pending' && !record.audit.some(item=>['corrected','re-extracted'].includes(item.action));
}
async function linkedHints(client:DynamoDBDocumentClient,record:Invoice):Promise<InvoiceHints> {
  for(const id of record.source.intakeItemIds) {
    const item=await getIntakeItem(client,id);
    if(item?.title) return intakeHints(item);
  }
  return {};
}
async function upgradeDraft(client:DynamoDBDocumentClient,record:Invoice,hints:InvoiceHints,actor:string):Promise<Invoice> {
  if(!draftIsUntouched(record)) return record;
  let parsed:ReturnType<typeof extractInvoiceText>;
  try { parsed=extractInvoiceText(await textExtractor(await artifactBytes(record.source.artifactId,client)),hints); }
  catch { return record; }
  if(parsed.extraction.method==='manual') return record;
  const found=Object.entries(parsed.fields).filter(([,value])=>value!==undefined) as Array<[keyof InvoiceFields, unknown]>;
  if(!found.some(([key])=>key==='counterparty'||key==='amount')) return record;
  const next=structuredClone(record);
  for(const [key,value] of found) (next.fields as Record<string,unknown>)[key]=value;
  next.extraction=parsed.extraction;
  next.revision+=1;
  next.audit.push({action:'re-extracted',actor,at:new Date().toISOString(),revision:next.revision});
  try { return await saveInvoice(client,next,record); } catch { return (await getInvoice(client,record.id)) || record; }
}
export async function reextractInvoice(client:DynamoDBDocumentClient,record:Invoice,actor:string):Promise<Invoice> {
  if(record.status!=='pending') throw new Error('only-pending-drafts-reextract');
  if(!draftIsUntouched(record)) throw new Error('operator-corrected-draft-edit-fields-manually');
  const upgraded=await upgradeDraft(client,record,await linkedHints(client,record),actor);
  if(upgraded===record) throw new Error('reextract-found-no-new-fields');
  return upgraded;
}
export async function processInvoiceIntake(client:DynamoDBDocumentClient,intakeItemId:string) {
  const intake=await getIntakeItem(client,intakeItemId);
  if(!intake) throw new Error('intake-not-found');
  const route=String(intake.metadata?.recipientRoute || '');
  if(!['invoice','receipts','invoice-attachment','invoice-pdf'].includes(route)) throw new Error('not-invoice-intake');
  const items:Invoice[]=[];const issues:string[]=[];
  for(const ref of intake.artifactRefs || []) {
    const artifact=await getArtifact(client,ref.artifactId);
    if(!artifact || artifact.metadata?.importState!=='complete') {issues.push('Document import incomplete: retry intake import');continue;}
    if(artifact.contentType!=='application/pdf') {issues.push('Unsupported attachment: supply an original PDF');continue;}
    const checksum=String(artifact.checksum);const id=sha(`invoice-document\n${checksum}`);
    let existing=await getInvoice(client,id);
    if(existing) {
      if(!existing.source.intakeItemIds.includes(intake.id)) {
        const next=structuredClone(existing);next.source.intakeItemIds.push(intake.id);
        try {existing=await saveInvoice(client,next,existing);} catch {existing=(await getInvoice(client,id))!;}
      }
      items.push(await upgradeDraft(client,existing,intakeHints(intake),'email-intake'));continue;
    }
    let bytes:Buffer;
    try { bytes=await artifactBytes(artifact.id,client); } catch { issues.push('Source integrity verification failed: reimport the original document'); continue; }
    let parsed:ReturnType<typeof extractInvoiceText>;
    try {parsed=extractInvoiceText(await textExtractor(bytes),intakeHints(intake));}
    catch {parsed={fields:{archiveRequired:true,quantity:1},extraction:{method:'manual',evidence:[],issues:['PDF extraction unavailable: inspect original and complete manually']}};}
    const now=new Date().toISOString();
    const record:Invoice={id,revision:1,status:'pending',...parsed,source:{intakeItemIds:[intake.id],artifactId:artifact.id,checksum},destinations:{dropbox:{state:'pending',operationId:`dropbox-${id}`},sheets:{state:'pending',operationId:`sheets-${id}`}},audit:[{action:'staged',actor:'email-intake',at:now,revision:1}],createdAt:now,updatedAt:now};
    items.push(await createInvoice(client,record));
  }
  if(!items.length && !issues.length) issues.push('No documents: forward an invoice PDF or a rendered receipt');
  await updateIntakeItem(client,intake.id,{metadata:{...intake.metadata,invoiceReviewIds:items.map(item=>item.id),invoiceProcessingIssues:issues}});
  return {items,issues};
}
export async function readiness() {
  const checks=[{name:'source-storage',ready:!!process.env.EMAIL_DOCUMENTS_BUCKET,message:process.env.EMAIL_DOCUMENTS_BUCKET?'Managed source storage configured':'EMAIL_DOCUMENTS_BUCKET is missing'}];
  try {const config=await publicationConfig();if(!config && !providerFactory) checks.push({name:'publication-config',ready:false,message:'INVOICE_PUBLICATION_SECRET_NAME must reference managed broker/destination configuration'});else checks.push(...await (providerFactory?await providerFactory():await officialProviders(config!)).readiness());}
  catch(error) {checks.push({name:'publication-config',ready:false,message:/^[a-zA-Z-]+$/.test((error as Error).message)?(error as Error).message:'publication-configuration-unavailable'});}
  return {ready:checks.every(x=>x.ready),checks};
}
function identity(record:Invoice) {const f=record.fields;return sha(`${f.counterparty?.toLowerCase().trim()}\n${f.accountContext?.toLowerCase().trim()}\n${f.invoiceNumber?.toLowerCase().trim()}`);}
export async function verifyInvoice(client:DynamoDBDocumentClient,record:Invoice,actor:string):Promise<Invoice> {
  if(record.status==='rejected') throw new Error('rejected-invoice');
  if(missingEvidence(record.fields).length) throw new Error('payment-or-invoice-evidence-required');
  // Explicit authenticated verification attests actual reviewed values. PDF
  // extraction alone never supplies this attestation or a bank conversion.
  await artifactBytes(record.source.artifactId,client);
  return confirmInvoice(client,record,actor,true);
}
export async function confirmInvoice(client:DynamoDBDocumentClient,record:Invoice,actor:string,automatically=false):Promise<Invoice> {
  if(record.status==='rejected') throw new Error('rejected-invoice');
  if(record.status==='pending') {
    if(missingEvidence(record.fields).length) throw new Error('payment-or-invoice-evidence-required');
    const duplicates=(await listInvoices(client)).filter(x=>x.id!==record.id && x.status!=='rejected' && identity(x)===identity(record));
    if(duplicates.length) throw new Error('ambiguous-invoice-identity-review-and-reject-duplicate');
    const next=structuredClone(record);const at=new Date().toISOString();next.status='confirmed';next.confirmedRevision=record.revision;next.verification={revision:record.revision,actor,at,method:'operator'};next.audit.push({action:'fields-verified',actor,at,revision:record.revision},{action:automatically?'automatically-confirmed':'confirmed',actor,at,revision:record.revision});
    record=await approveInvoice(client,next,record,identity(record));
  }
  return publishInvoice(client,record,actor);
}
function rowEqual(actual:string[],expected:string[],headers:string[]) {return expected.every((cell,index)=>['Price, $','Price, EUR','Count'].includes(headers[index]) && cell ? actual[index] !== '' && Number(actual[index])===Number(cell) : String(actual[index] || '')===cell) && actual.slice(expected.length).every(x=>!x);}
export async function publishInvoice(client:DynamoDBDocumentClient,record:Invoice,actor:string):Promise<Invoice> {
  if(record.status!=='confirmed' || record.confirmedRevision!==record.revision || missingEvidence(record.fields).length) throw new Error('current-review-confirmation-required');
  const owner=randomUUID();record=await claimInvoice(client,record,owner);
  async function checkpoint(next:Invoice) {record=await saveInvoice(client,next,record,owner);}
  let sourceBytes:Buffer;
  try {sourceBytes=await artifactBytes(record.source.artifactId,client);} catch {const next=structuredClone(record);for(const dest of Object.values(next.destinations)) if(!['verified','skipped'].includes(dest.state)){dest.state='blocked';dest.error='Source integrity verification failed: original PDF required';}delete next.leaseOwner;delete next.leaseUntil;await checkpoint(next);return record;}
  let providers:Providers;
  try {const config=await publicationConfig();if(!config && !providerFactory) throw new Error('publication-config-missing');providers=providerFactory?await providerFactory():await officialProviders(config!);}
  catch {const next=structuredClone(record);for(const dest of Object.values(next.destinations)) if(!['verified','skipped'].includes(dest.state)) {dest.state='blocked';dest.error='Publication configuration unavailable; check readiness';}delete next.leaseOwner;delete next.leaseUntil;await checkpoint(next);return record;}
  if(providers.bindingKey) {
    if(record.publicationBinding && record.publicationBinding!==providers.bindingKey) {const next=structuredClone(record);next.publicationError='Destination configuration changed: restore prior configuration and reconcile existing effects';delete next.leaseOwner;delete next.leaseUntil;await checkpoint(next);return record;}
    const next=structuredClone(record);next.publicationBinding=providers.bindingKey;delete next.publicationError;await checkpoint(next);
  }
  // Each destination checkpoints before sending a write. Retries reconcile provider state first.
  for(const kind of ['dropbox','sheets'] as const) {
    if(['verified','skipped'].includes(record.destinations[kind].state)) continue;
    try {
      if(kind==='dropbox') {
        if(record.fields.archiveRequired===false) {const next=structuredClone(record);next.destinations.dropbox.state='skipped';next.destinations.dropbox.reference=record.fields.archiveExceptionReason;await checkpoint(next);continue;}
        const bytes=sourceBytes;const path=providers.dropboxPath(record);
        const prior=await providers.readDropbox(path);
        if(prior && sha(prior.bytes)!==sha(bytes)) throw new Error('dropbox-file-content-mismatch');
        if(!prior) {const next=structuredClone(record);next.destinations.dropbox.state='unknown';next.destinations.dropbox.reference=path;await checkpoint(next);await providers.writeDropbox(path,bytes);}
        const result=prior || await providers.readDropbox(path);
        if(!result || sha(result.bytes)!==sha(bytes)) throw new Error('dropbox-readback-mismatch');
        const next=structuredClone(record);next.destinations.dropbox={...next.destinations.dropbox,state:'verified',reference:result.reference};delete next.destinations.dropbox.error;await checkpoint(next);
      } else {
        const layout=await providers.sheetLayout();const expected=sheetValues(record,layout.headers);const prior=await providers.findRow(marker(record));
        let row=prior?.row || record.destinations.sheets.reservedRow;
        if(prior && !rowEqual(prior.values,expected,layout.headers)) throw new Error('sheet-existing-row-mismatch');
        if(!prior) {
          if(!row) {row=await reserveSheetRow(client,layout.destinationKey,Math.max(2,layout.rows.length+1));const next=structuredClone(record);next.destinations.sheets.reservedRow=row;await checkpoint(next);}
          const current=await providers.readRow(row);
          if(current.some(Boolean) && !rowEqual(current,expected,layout.headers)) throw new Error('sheet-reserved-row-occupied');
          if(!rowEqual(current,expected,layout.headers)) {const next=structuredClone(record);next.destinations.sheets.state='unknown';await checkpoint(next);await providers.writeRow(row,expected);}
        }
        const readback=await providers.findRow(marker(record));
        if(!readback || !rowEqual(readback.values,expected,layout.headers)) throw new Error('sheet-readback-mismatch');
        const next=structuredClone(record);next.destinations.sheets={...next.destinations.sheets,state:'verified',reference:`row:${readback.row}`,reservedRow:readback.row};delete next.destinations.sheets.error;await checkpoint(next);
      }
    } catch(error) {const next=structuredClone(record);const errorCode=(error as Error).message;next.destinations[kind].error=/^[a-z-]+$/.test(errorCode)?errorCode:'destination-verification-required';if(next.destinations[kind].state!=='unknown')next.destinations[kind].state='blocked';await checkpoint(next);}
  }
  // Only confirmed records enter the existing ledger, including when an external destination needs retry.
  const ledger=await putBookkeepingItem(client,'bookkeeping',{...record.fields,id:record.id,entryType:'expense',sourceType:'invoice',sourceKey:record.id,invoiceId:record.id,documentArtifactId:record.source.artifactId,externalReferences:record.destinations},`invoice#${record.id}`);
  if(ledger.duplicate) await updateBookkeepingTransaction(client,record.id,ledger.item.updatedAt,{externalReferences:record.destinations});
  const next=structuredClone(record);next.audit.push({action:'publication-attempt',actor,at:new Date().toISOString(),revision:record.revision});delete next.leaseOwner;delete next.leaseUntil;delete next.restoredNeedsReconciliation;await checkpoint(next);
  return record;
}
