import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import { publicInvoice, validateFields } from '../invoices/model';
import { getInvoice, listInvoices, saveInvoice } from '../invoices/store';
import { confirmInvoice, documentUrl, processInvoiceIntake, publishInvoice, readiness } from '../invoices/service';
const json=(statusCode:number,body:unknown):LambdaResponse=>({statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(body)});
export async function handleInvoiceRoutes(path:string,method:string,event:LambdaEvent,client:DynamoDBDocumentClient,authorized:boolean):Promise<LambdaResponse> {
  if(!authorized) return json(401,{error:'Unauthorized'});
  try {
    if(path==='/api/bookkeeping/invoices/readiness' && method==='GET') return json(200,await readiness());
    if(path==='/api/bookkeeping/invoices' && method==='GET') return json(200,{items:(await listInvoices(client)).map(publicInvoice)});
    let body:Record<string,unknown>={};
    if(['POST','PUT'].includes(method)) {try{body=JSON.parse(event.body || '{}');}catch{return json(400,{error:'Invalid JSON'});}if(!body || typeof body!=='object' || Array.isArray(body))return json(400,{error:'Invalid JSON'});}
    if(path==='/api/bookkeeping/invoices/process' && method==='POST') {if(typeof body.intakeItemId!=='string' || body.intakeItemId.length>160)return json(400,{error:'intakeItemId required'});const result=await processInvoiceIntake(client,body.intakeItemId);return json(200,{items:result.items.map(publicInvoice),issues:result.issues});}
    const match=/^\/api\/bookkeeping\/invoices\/([a-f0-9]{64})(?:\/(confirm|reject|retry|document))?$/.exec(path);
    if(!match)return json(404,{error:'Not found'});
    const record=await getInvoice(client,match[1]);if(!record)return json(404,{error:'Not found'});
    if(method==='GET') return match[2]==='document'?json(200,await documentUrl(client,record)):match[2]?json(405,{error:'Method not allowed'}):json(200,publicInvoice(record));
    if(body.revision!==record.revision)return json(409,{error:'Review changed: reload the current revision'});
    const actor=event.headers?.['x-user-id'] || 'authenticated-operator';
    if(method==='PUT' && !match[2]) {if(record.status!=='pending')return json(409,{error:'Only pending drafts can be edited'});const errors=validateFields(body.fields);if(errors.length)return json(400,{error:'Invalid fields',fields:errors});const next=structuredClone(record);next.fields={...next.fields,...body.fields as object};for(const key of ['amount','amountEur','quantity'] as const) if(next.fields[key] === null) delete next.fields[key];next.revision+=1;next.audit.push({action:'corrected',actor,at:new Date().toISOString(),revision:next.revision});return json(200,publicInvoice(await saveInvoice(client,next,record)));}
    if(method==='POST' && match[2]==='confirm') return json(200,publicInvoice(await confirmInvoice(client,record,actor)));
    if(method==='POST' && match[2]==='retry') return json(200,publicInvoice(await publishInvoice(client,record,actor)));
    if(method==='POST' && match[2]==='reject') {if(record.status==='confirmed')return json(409,{error:'Confirmed invoices cannot be rejected'});const next=structuredClone(record);next.status='rejected';next.audit.push({action:'rejected',actor,at:new Date().toISOString(),revision:next.revision});return json(200,publicInvoice(await saveInvoice(client,next,record)));}
    return json(405,{error:'Method not allowed'});
  } catch(error) {
    const name=(error as Error).name;const message=(error as Error).message;
    if(['ConditionalCheckFailedException','TransactionCanceledException'].includes(name))return json(409,{error:'Invoice changed or publication already in progress'});
    return json(/not-found/.test(message)?404:/required|rejected|ambiguous|not-invoice/.test(message)?409:503,{error:/^[a-z-]+$/.test(message)?message:'Invoice operation unavailable'});
  }
}
